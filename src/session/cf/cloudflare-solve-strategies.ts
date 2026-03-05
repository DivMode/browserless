import { Data, Effect } from 'effect';
import { CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';

/** Effect-returning CDP sender — eliminates the Promise bridge. */
type EffectSend = (
  method: string,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;

/**
 * Click-phase CDP sender — compile-time blocks Runtime.evaluate on OOPIF.
 *
 * CF's WASM monitors V8 evaluation events in the challenge iframe's MAIN world.
 * Runtime.evaluate without an isolated world contextId runs in the main world
 * → triggers CF detection → rechallenge. This type makes that a compile error.
 *
 * Runtime.callFunctionOn with an objectId is allowed — it operates on a specific
 * JS object (e.g., the checkbox element) without creating a new evaluation context
 * in the main world. This is already used safely for visibility checks and bounds.
 *
 * Phases 2-3 (checkbox finding) use EffectSend because they need Runtime.evaluate
 * in ISOLATED worlds (via Page.createIsolatedWorld + contextId) which CF can't observe.
 * Phase 4 (click dispatch) uses this restricted type — no Runtime.evaluate allowed.
 */
type ClickPhaseSend = <M extends string>(
  method: M extends 'Runtime.evaluate' ? never : M,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;
import { CdpSender, SolverEvents } from './cf-services.js';
import { TARGET_GET_TIMEOUT_MS } from './cf-schedules.js';

// Extracted modules
import { phase2OOPIFResolution } from './cf-phase-oopif.js';
import { phase3CheckboxFind, getAttr } from './cf-phase-checkbox.js';
import { getIframePageCoords, openCleanPageWsScoped } from './cf-coords.js';

/** Parsed metadata from a CF Turnstile OOPIF URL. */
export interface TurnstileOOPIFMeta {
  readonly sitekey: string | null;
  readonly mode: string | null;       // 'normal', 'compact', etc.
  readonly theme: string | null;      // 'light', 'dark', 'auto'
  readonly appearance: string | null; // 'always', 'execute', 'interaction-only'
}

/** Extract Turnstile metadata from an OOPIF URL path. */
export function parseTurnstileOOPIFUrl(url: string): TurnstileOOPIFMeta {
  let sitekey: string | null = null;
  let mode: string | null = null;
  let theme: string | null = null;
  let appearance: string | null = null;
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // Find sitekey: starts with 0x and 20+ alphanumeric chars (NOT hex — sitekeys use base62)
    sitekey = segments.find(s => /^0x[0-9a-zA-Z-]{20,}$/.test(s)) ?? null;
    // Mode is typically the last non-query segment
    const modeIdx = segments.length - 1;
    if (modeIdx > 0) mode = segments[modeIdx] ?? null;
    // Theme: 'light', 'dark', 'auto'
    theme = segments.find(s => ['light', 'dark', 'auto'].includes(s)) ?? null;
    // Appearance: 'always', 'execute', 'interaction-only'
    appearance = segments.find(s => ['always', 'execute', 'interaction-only'].includes(s)) ?? null;
  } catch { /* malformed URL — return defaults */ }
  return { sitekey, mode, theme, appearance };
}

/** Individual CF OOPIF target found by Target.getTargets. */
export interface CFTargetMatch {
  readonly targetId: string;
  readonly url: string;
  readonly type: 'iframe' | 'page';
  readonly meta: TurnstileOOPIFMeta;
}

/** No CF OOPIF found (or all were filtered as stale). */
export interface CFNotDetected {
  readonly _tag: 'not_detected';
}

/** Fresh CF OOPIF(s) found — not in solvedCFTargetIds. */
export interface CFDetected {
  readonly _tag: 'detected';
  readonly targets: readonly CFTargetMatch[];
}

/** Discriminated union for CF detection — forces callers to pattern match on _tag. */
export type CFDetectionResult = CFNotDetected | CFDetected;

export type SolveOutcome =
  | 'click_dispatched'
  | 'click_no_token'
  | 'no_click'
  | 'auto_handled'
  | 'aborted';

/**
 * Structured result from findAndClickViaCDP — replaces boolean return.
 *
 * Lets callers distinguish "no checkbox found" (retryable) from "OOPIF died
 * during verify" (fatal — don't waste 23s polling a dead iframe).
 */
export type ClickResult = Data.TaggedEnum<{
  Verified: {}
  NotVerified: { readonly reason: string }
  NoCheckbox: {}
  ClickFailed: {}
}>;
export const ClickResult = Data.taggedEnum<ClickResult>();

/**
 * Cloudflare's well-known test sitekey prefixes.
 * These appear in the OOPIF URL path and always auto-pass/block — skip them.
 *   1x00... = always passes (visible)
 *   2x00... = always blocks (visible)
 *   3x00... = always passes (invisible/managed)
 * Ref: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const CF_TEST_SITEKEY_PREFIXES = ['1x00000000', '2x00000000', '3x00000000'];

/** Returns true if the OOPIF URL contains a CF test sitekey. */
function isCFTestWidget(url: string | undefined): boolean {
  if (!url) return false;
  return CF_TEST_SITEKEY_PREFIXES.some((prefix) => url.includes(prefix));
}

/** CDP DOM node shape (subset of fields we use). */
interface CDPNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  children?: CDPNode[];
  shadowRoots?: CDPNode[];
  attributes?: string[];
  contentDocument?: CDPNode;
  frameId?: string;
}

/**
 * Solve execution strategies for Cloudflare challenges.
 *
 * Uses pure CDP commands for shadow DOM traversal and trusted OOPIF clicks:
 * - DOM.getDocument(depth=-1, pierce=true) for shadow DOM discovery
 * - Input.dispatchMouseEvent through iframeCdpSessionId for isTrusted:true clicks
 *
 * All methods return Effect — callers use yield* from Effect.gen contexts.
 *
 * Pydoll's exact flow replicated:
 *   Phase 1: Page-side DOM traversal (PAGE session via this.sendCommand)
 *   Phase 2: OOPIF resolution (CDPProxy browser WS via send)
 *   Phase 3: Isolated world + checkbox (OOPIF session via send)
 *   Phase 4: Click (OOPIF session via send)
 */
/** R channel for methods that need CDP + Events services. */
export type StrategiesR = typeof CdpSender.Identifier | typeof SolverEvents.Identifier;

export class CloudflareSolveStrategies {
  /** Shared Target.getTargets cache — reduces 15×5/sec → ~5/sec. Single-threaded Node.js = no races. */
  private targetCache: { targets: any[]; timestamp: number } | null = null;
  private static readonly TARGET_CACHE_TTL_MS = 200;

  constructor(private chromePort?: string) {}

  // ── CDP-based Shadow DOM Discovery + Trusted Click ──────────────────

  /**
   * Find Turnstile checkbox and click it using active OOPIF discovery
   * and Runtime.callFunctionOn — matching pydoll's exact approach.
   *
   * Flow:
   * 1. Active OOPIF discovery via Target.getTargets + attachToTarget
   * 2. Find checkbox via Runtime.callFunctionOn(querySelector) in OOPIF
   * 3. Fallback: DOM.getDocument tree walk (backward compat)
   * 4. DOM.getBoxModel for coordinates
   * 5. Input.dispatchMouseEvent via OOPIF session
   *
   * Public entry point — returns Effect.
   * Called by the Effect solver directly (no more bridge).
   */
  findAndClickViaCDP(
    active: ActiveDetection,
    attempt = 0,
  ): Effect.Effect<ClickResult, never, StrategiesR> {
    return this._findAndClickViaCDP(active, attempt);
  }

  private _findAndClickViaCDP(
    active: ActiveDetection,
    attempt = 0,
  ): Effect.Effect<ClickResult, never, StrategiesR> {
    const strategies = this;
    return Effect.fn('cf.findAndClickViaCDP')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.type': active.info.type,
        'cf.target_id': active.pageTargetId,
        'cf.attempt': attempt,
      });
      const cdp = yield* CdpSender;
      const events = yield* SolverEvents;
      const { pageCdpSessionId, pageTargetId } = active;

      // Route OOPIF commands through CDPProxy's browser WS — matching pydoll's
      // actual routing through Browserless. Pydoll's OOPIF patch stores
      // chrome._connection_handler (= CDPProxy browser WS) as _browser_handler,
      // and all OOPIF commands (Target.getTargets, attachToTarget, DOM queries,
      // Input.dispatchMouseEvent) route through it via _execute_command → _resolve_routing.
      //
      // We previously used a fresh isolated WS (createIsolatedConnection), thinking
      // zero CDP state would be cleaner. But pydoll succeeds through CDPProxy and
      // we failed through isolated WS — the isolated WS is not the advantage.

      // Materialize CdpSender into EffectSend closures for inner methods.
      // Returns Effect directly — no Promise bridge, fully interruptible.
      const debugEnabled = !!process.env.BROWSERLESS_CDP_DEBUG;
      const solveStart = Date.now();
      let cmdSeq = 0;

      const send: EffectSend = (method, params, sessionId, timeoutMs) => {
        const seq = cmdSeq++;
        const t0 = Date.now() - solveStart;
        if (debugEnabled) {
          const sid = sessionId ? `[sid=${sessionId.substring(0, 16)}]` : '[no-sid]';
          const p = params ? JSON.stringify(params).substring(0, 150) : '{}';
          console.log(`  [SOLVE #${seq}] +${t0}ms ${method} ${sid} ${p}`);
        }
        return cdp.sendViaProxy(method, params, sessionId, timeoutMs).pipe(
          Effect.orElseSucceed(() => null),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (debugEnabled) {
                const t1 = Date.now() - solveStart;
                const summary = result ? JSON.stringify(result).substring(0, 120) : 'null';
                console.log(`  [SOLVE #${seq}] +${t1}ms → ${summary}`);
              }
            }),
          ),
        );
      };
      const via = 'proxy_ws';

      // Wrap page-session commands with debug logging too
      const pageSend: EffectSend = (method, params, sessionId, timeoutMs) => {
        const seq = cmdSeq++;
        const t0 = Date.now() - solveStart;
        if (debugEnabled) {
          const p = params ? JSON.stringify(params).substring(0, 150) : '{}';
          console.log(`  [PAGE  #${seq}] +${t0}ms ${method} [page-session] ${p}`);
        }
        return cdp.send(method, params, sessionId, timeoutMs).pipe(
          Effect.orElseSucceed(() => null),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (debugEnabled) {
                const t1 = Date.now() - solveStart;
                const summary = result ? JSON.stringify(result).substring(0, 120) : 'null';
                console.log(`  [PAGE  #${seq}] +${t1}ms → ${summary}`);
              }
            }),
          ),
        );
      };

      // ──────────────────────────────────────────────────────────────────
      // Pydoll's exact flow replicated:
      //   Phase 1: Page-side DOM traversal (PAGE session via this.sendCommand)
      //   Phase 2: OOPIF resolution (CDPProxy browser WS via send)
      //   Phase 3: Isolated world + checkbox (OOPIF session via send)
      //   Phase 4: Click (OOPIF session via send)
      // ──────────────────────────────────────────────────────────────────

      // ── Phase 1: Page-side DOM traversal (CLEAN page WS) ──────────────
      //
      // WHY A CLEAN WS IS CRITICAL:
      // CdpSession's WS has accumulated V8 state from recording setup:
      //   - Page.addScriptToEvaluateOnNewDocument (rrweb injection)
      //   - Runtime.addBinding (__csrfp, __perf)
      // When ANY command — even safe ones like Runtime.callFunctionOn —
      // executes through this tainted WS, CF's WASM detects the accumulated
      // V8 modifications and permanently poisons the session. All subsequent
      // clicks get rejected, no matter how they're delivered.
      //
      // Pydoll succeeds with the SAME commands because its page-level WS
      // (/devtools/page/{targetId}) is a fresh connection with zero V8 state.
      // We match that by opening our own clean page WS per solve attempt.
      //
      // See CLOUDFLARE_SOLVER.md "Rule 2" for the full investigation.
      //
      let iframeBackendNodeId: number | null = null;
      let iframeFrameId: string | null = null;
      let phase1Ms = 0;

      if (strategies.chromePort && active.pageTargetId) {
        const phase1Start = Date.now();
        const phase1Result = yield* strategies.phase1PageDomTraversal(active.pageTargetId);
        iframeBackendNodeId = phase1Result.backendNodeId;
        iframeFrameId = phase1Result.frameId;
        phase1Ms = Date.now() - phase1Start;
      }

      yield* events.marker(pageTargetId, 'cf.page_traversal', {
        iframe_backend_node_id: iframeBackendNodeId,
        iframe_frame_id: iframeFrameId ? (iframeFrameId as string).substring(0, 20) : null,
        via, attempt,
        skipped_phase1: !iframeFrameId && !iframeBackendNodeId,
        phase1_ms: phase1Ms,
      });

      // ── Phase 2: OOPIF resolution (isolated WS) ─────────────────────
      const oopifSessionId = yield* phase2OOPIFResolution(
        send, pageSend, pageCdpSessionId, pageTargetId, iframeFrameId, via,
      );

      if (!oopifSessionId) {
        const targetInfos = yield* send('Target.getTargets').pipe(
          Effect.map((r: any) => r?.targetInfos),
          Effect.orElseSucceed(() => []),
        );
        yield* events.marker(pageTargetId, 'cf.cdp_no_oopif', {
          type: active.info.type, via,
          had_iframe_backend_id: !!iframeBackendNodeId,
          total_targets: targetInfos?.length ?? 0,
          elapsed_ms: Date.now() - solveStart,
        });
        return ClickResult.NoCheckbox();
      }

      // ── Phase 3: Isolated world + checkbox find (OOPIF session) ──────
      const checkboxResult = yield* phase3CheckboxFind(
        send, oopifSessionId, active, via, solveStart,
      );
      if (!checkboxResult) return ClickResult.NoCheckbox();

      const { checkbox, method: cbMethod, checkboxFoundAt } = checkboxResult;

      // ── Phase 4: Visibility check, scroll, bounds, click ─────────────
      // No delay — pydoll clicks immediately after finding the checkbox.
      // Humanized timing comes from mouse movement in Phase 4.
      // Input events stay on isolated WS (same as DOM/Runtime) — the CDPProxy
      // browser WS has worse contention under production load (4-5s stalls
      // vs 1s on isolated WS). The Effect bridge elimination in sendViaProxy
      // is the real improvement here.
      return yield* strategies.phase4Click(
        send, send, send, oopifSessionId, active,
        checkbox, cbMethod, iframeBackendNodeId, via, attempt, solveStart, checkboxFoundAt,
      );
    })().pipe(
      Effect.catch((err: unknown) =>
        Effect.gen(function*() {
          const events = yield* SolverEvents;
          yield* events.marker(active.pageTargetId, 'cf.cdp_error', {
            error: err instanceof Error ? err.message : 'unknown',
            via: 'proxy_ws', attempt,
          });
          return ClickResult.ClickFailed();
        }),
      ),
    );
  }

  // ── Phase 1: Page-side shadow root traversal (PAGE session) ──────
  // Pydoll calls find_shadow_roots(deep=False) → DOM.getDocument(depth=-1, pierce=true)
  // then checks each shadow root's inner_html for challenges.cloudflare.com,
  // then querySelector('iframe[src*="challenges.cloudflare.com"]') on the shadow root,
  // then DOM.describeNode on the iframe element to get frameId + backendNodeId.

  private phase1PageDomTraversal(
    pageTargetId: TargetId,
  ): Effect.Effect<{ backendNodeId: number | null; frameId: string | null }> {
    const strategies = this;
    return Effect.fn('cf.phase1PageDomTraversal')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': pageTargetId });
      let backendNodeId: number | null = null;
      let frameId: string | null = null;

      // acquireRelease guarantees WS cleanup even on fiber interruption
      const conn = yield* openCleanPageWsScoped(pageTargetId, strategies.chromePort!).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      if (!conn) return { backendNodeId, frameId };

      // DOM.getDocument(depth:-1, pierce:true) — C++ layer, finds shadow roots
      const doc = yield* conn.send('DOM.getDocument', { depth: -1, pierce: true }).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (doc?.root) {
        // Walk tree for iframe[src*="challenges.cloudflare.com"]
        const iframe = strategies.findCFIframeInTree(doc.root);
        if (iframe) {
          backendNodeId = iframe.backendNodeId;
          frameId = iframe.frameId ?? null;
        }
      }

      // Phase 1 failure is non-fatal — Phase 2 fallback handles it.
      // acquireRelease guarantees WS cleanup even on fiber interruption.
      return { backendNodeId, frameId };
    })().pipe(Effect.scoped);
  }



  // ── Phase 4: Click dispatch ───────────────────────────────────────

  private phase4Click(
    send: ClickPhaseSend,
    verifySend: EffectSend,
    inputSend: ClickPhaseSend,
    oopifSessionId: CdpSessionId,
    active: ActiveDetection,
    checkbox: { objectId: string; backendNodeId: number },
    method: string,
    iframeBackendNodeId: number | null,
    via: string,
    attempt: number,
    solveStart: number,
    checkboxFoundAt: number,
  ): Effect.Effect<ClickResult, never, typeof SolverEvents.Identifier> {
    const strategies = this;
    const pageTargetId = active.pageTargetId;
    return Effect.fn('cf.phase4Click')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.type': active.info.type,
        'cf.target_id': pageTargetId,
        'cf.via': via,
        'cf.attempt': attempt,
        'cf.checkbox_method': method,
      });
      const events = yield* SolverEvents;
      const phase4Start = Date.now();

      yield* events.marker(pageTargetId, 'cf.phase4_start', { via, attempt });

      // ── Sub-span: Visibility + scroll + box model ──
      const coordsResult = yield* Effect.fn('cf.phase4_coords')(function*() {
        yield* Effect.annotateCurrentSpan({ 'cf.has_object_id': !!checkbox.objectId });

        if (checkbox.objectId) {
          const visible = yield* send('Runtime.callFunctionOn', {
            objectId: checkbox.objectId,
            functionDeclaration: `function() {
              const rect = this.getBoundingClientRect();
              return (rect.width > 0 && rect.height > 0
                && getComputedStyle(this).visibility !== 'hidden'
                && getComputedStyle(this).display !== 'none');
            }`,
            returnByValue: true,
          }, oopifSessionId);

          if (visible?.result?.value === false) {
            yield* Effect.annotateCurrentSpan({ 'cf.visible': false });
            return { _tag: 'not_visible' as const };
          }
        }

        const scrollParams = checkbox.objectId
          ? { objectId: checkbox.objectId }
          : { backendNodeId: checkbox.backendNodeId };
        yield* send('DOM.scrollIntoViewIfNeeded', scrollParams, oopifSessionId);

        const boxParams = checkbox.objectId
          ? { objectId: checkbox.objectId }
          : { backendNodeId: checkbox.backendNodeId };
        const box = yield* send('DOM.getBoxModel', boxParams, oopifSessionId);

        let x: number, y: number;
        let coordSource = 'getBoxModel';

        if (box?.model?.content) {
          const quad = box.model.content;
          x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        } else if (checkbox.objectId) {
          const boundsResult = yield* send('Runtime.callFunctionOn', {
            objectId: checkbox.objectId,
            functionDeclaration: `function() {
              const r = this.getBoundingClientRect();
              return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
            }`,
            returnByValue: true,
          }, oopifSessionId);
          const bounds = JSON.parse(boundsResult?.result?.value || '{}');
          if (!bounds.width) {
            yield* Effect.annotateCurrentSpan({ 'cf.coord_source': 'failed' });
            return { _tag: 'no_box_model' as const };
          }
          x = bounds.x + bounds.width / 2;
          y = bounds.y + bounds.height / 2;
          coordSource = 'getBoundingClientRect';
        } else {
          yield* Effect.annotateCurrentSpan({ 'cf.coord_source': 'failed' });
          return { _tag: 'no_box_model' as const };
        }

        yield* Effect.annotateCurrentSpan({ 'cf.coord_source': coordSource });
        return { _tag: 'ok' as const, x, y, coordSource };
      })();

      if (coordsResult._tag === 'not_visible') {
        yield* events.marker(pageTargetId, 'cf.checkbox_not_visible', { via, polls: 0 });
        return ClickResult.NoCheckbox();
      }
      if (coordsResult._tag === 'no_box_model') {
        yield* events.marker(pageTargetId, 'cf.cdp_no_box_model', { method, via });
        return ClickResult.ClickFailed();
      }
      const { x, y, coordSource } = coordsResult;

      // ── Phase 4a: Get iframe page-space position for debugging ────────
      // Translate iframe-relative click coords → page-absolute coords
      // so the replay shows WHERE on the page the click should appear.
      // Non-fatal — page coords just won't be available if this fails.
      let iframePageX: number | null = null;
      let iframePageY: number | null = null;
      if (iframeBackendNodeId && strategies.chromePort && active.pageTargetId) {
        const iframeCoords = yield* getIframePageCoords(active.pageTargetId, iframeBackendNodeId, strategies.chromePort!);
        iframePageX = iframeCoords.x;
        iframePageY = iframeCoords.y;
      }

      const clickX = Math.round(x);
      const clickY = Math.round(y);

      // Page-absolute coordinates (iframe origin + click offset within iframe)
      const pageAbsX = iframePageX != null ? Math.round(iframePageX + clickX) : null;
      const pageAbsY = iframePageY != null ? Math.round(iframePageY + clickY) : null;

      yield* events.marker(pageTargetId, 'cf.cdp_click_target', {
        x: clickX, y: clickY,
        method, via, coordSource,
        page_x: pageAbsX,
        page_y: pageAbsY,
        iframe_origin_x: iframePageX != null ? Math.round(iframePageX) : null,
        iframe_origin_y: iframePageY != null ? Math.round(iframePageY) : null,
        had_phase1_iframe: !!iframeBackendNodeId,
      });

      // ── Sub-span: Click dispatch (listener + mouse events) ──
      // Input events route through CDPProxy browser WS (inputSend) — pre-warmed
      // compositor avoids 283-1162ms stall on first mouseMoved via isolated WS.
      const { pressResponse, releaseResponse, holdMs } = yield* Effect.fn('cf.phase4_dispatch')(function*() {
        // Install click verification listener (OOPIF session — safe, separate V8 isolate)
        yield* verifySend('Runtime.evaluate', {
          expression: `window.__bClkV=false;document.addEventListener('mousedown',function(){window.__bClkV=true},{once:true,capture:true});true`,
          returnByValue: true,
        }, oopifSessionId).pipe(Effect.orElseSucceed(() => null));

        // mouseMoved before press/release — routes compositor + shows in rrweb
        yield* inputSend('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: clickX, y: clickY,
          button: 'none',
        }, oopifSessionId);

        const preMoveMs = 20 + Math.random() * 30;
        yield* Effect.sleep(`${preMoveMs} millis`);

        const pressResponse = yield* inputSend('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: clickX, y: clickY,
          button: 'left', clickCount: 1,
        }, oopifSessionId);

        const holdMs = 50 + Math.random() * 100;
        yield* Effect.sleep(`${holdMs} millis`);

        const releaseResponse = yield* inputSend('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: clickX, y: clickY,
          button: 'left', clickCount: 1,
        }, oopifSessionId);

        yield* Effect.annotateCurrentSpan({
          'cf.hold_ms': Math.round(holdMs),
          'cf.press_ok': !!pressResponse,
          'cf.release_ok': !!releaseResponse,
        });

        return { pressResponse, releaseResponse, holdMs };
      })();

      // Validate click delivery — if press/release returned null, CDP call failed
      if (!pressResponse || !releaseResponse) {
        yield* events.marker(pageTargetId, 'cf.click_failed', {
          press_null: !pressResponse,
          release_null: !releaseResponse,
          via, attempt,
          oopif_session_id: oopifSessionId.substring(0, 16),
        });
        return ClickResult.ClickFailed();
      }

      // ── Sub-span: Verify click landed ──
      const { clickVerified, verifyError } = yield* Effect.fn('cf.phase4_verify')(function*() {
        yield* Effect.sleep('100 millis');
        let clickVerified = false;
        let verifyError: string | null = null;

        const verifyResult: true | string = yield* verifySend('Runtime.evaluate', {
          expression: 'window.__bClkV',
          returnByValue: true,
        }, oopifSessionId).pipe(
          Effect.map((r: any) => (r?.result?.value === true ? true as const : 'not_confirmed')),
          Effect.catch(() => Effect.succeed('oopif_gone' as const)),
        );

        if (verifyResult === true) {
          clickVerified = true;
        } else if (typeof verifyResult === 'string') {
          verifyError = verifyResult;
        }

        yield* Effect.annotateCurrentSpan({ 'cf.click_verified': clickVerified });
        return { clickVerified, verifyError };
      })();

      if (clickVerified) {
        active.clickDelivered = true;
        active.clickDeliveredAt = Date.now();
      }
      yield* Effect.annotateCurrentSpan({ 'cf.click_delivered': active.clickDelivered ?? false });

      const clickNow = Date.now();
      const checkbox_to_click_ms = clickNow - checkboxFoundAt;
      const phase4_duration_ms = clickNow - phase4Start;
      const total_solve_ms = clickNow - solveStart;

      yield* events.emitProgress(active, 'clicked', {
        x: clickX, y: clickY,
        checkbox_to_click_ms,
        phase4_duration_ms,
      });

      yield* events.marker(pageTargetId, 'cf.oopif_click', {
        ok: clickVerified,
        click_verified: clickVerified,
        verify_error: verifyError,
        cdp_accepted: !!pressResponse && !!releaseResponse,
        method: 'cdp_oopif_session', via, attempt,
        x: clickX, y: clickY,
        page_x: pageAbsX,
        page_y: pageAbsY,
        hold_ms: Math.round(holdMs),
        press_response: pressResponse ? JSON.stringify(pressResponse).substring(0, 100) : 'empty',
        release_response: releaseResponse ? JSON.stringify(releaseResponse).substring(0, 100) : 'empty',
        oopif_session_id: oopifSessionId.substring(0, 16),
        elapsed_since_solve_start_ms: total_solve_ms,
        checkbox_to_click_ms,
        phase4_duration_ms,
      });

      yield* events.marker(pageTargetId, 'cf.click_latency', {
        checkbox_to_click_ms,
        phase4_duration_ms,
        total_solve_ms,
      });
      if (clickVerified) return ClickResult.Verified();
      if (verifyError) return ClickResult.NotVerified({ reason: verifyError });
      return ClickResult.ClickFailed();
    })().pipe(
      Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
    );
  }





  /**
   * Walk CDP DOM tree to find the CF challenge iframe node.
   * Returns the IFRAME node with backendNodeId and frameId for Phase 2 matching.
   */
  private findCFIframeInTree(node: CDPNode): CDPNode | null {
    if (node.nodeName === 'IFRAME') {
      const attrs = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'src' && attrs[i + 1]?.includes('challenges.cloudflare.com')) {
          return node;
        }
      }
    }
    for (const child of node.children ?? []) {
      const found = this.findCFIframeInTree(child);
      if (found) return found;
    }
    for (const shadow of node.shadowRoots ?? []) {
      const found = this.findCFIframeInTree(shadow);
      if (found) return found;
    }
    if (node.contentDocument) {
      const found = this.findCFIframeInTree(node.contentDocument);
      if (found) return found;
    }
    return null;
  }

  // ── CDP-based Detection (zero JS injection) ────────────────────────

  /**
   * Detect Turnstile widget via Target.getTargets (browser-level).
   * Zero page interaction — no DOM walk, no Runtime.evaluate.
   * Returns Effect.
   *
   * WARNING: Do NOT upgrade this to use DOM.getDocument or Runtime.evaluate —
   * even on a fresh clean-page WS connection. The detection polling loop runs
   * 20 polls x 200ms, and repeated page-level CDP calls during that window
   * trigger CF's WASM fingerprint checks, causing rechallenges on every click.
   * Proven 2026-02-24: Target.getTargets = 5/5 pass, DOM.getDocument = timeout,
   * Runtime.evaluate = rechallenge. Target.getTargets is browser-level and
   * completely invisible to the page.
   */
  detectTurnstileViaCDP(_pageCdpSessionId: CdpSessionId, solvedCFTargetIds?: ReadonlySet<string>): Effect.Effect<CFDetectionResult, never, typeof CdpSender.Identifier> {
    const strategies = this;
    return Effect.fn('cf.detectTurnstileViaCDP')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': _pageCdpSessionId });

      // Cache Target.getTargets — 15 tabs polling at 5/sec = 75 CDP calls/sec without this.
      // Single-threaded Node.js means no race conditions on the cache.
      const now = Date.now();
      let targetInfos: any[];
      if (strategies.targetCache && (now - strategies.targetCache.timestamp) < CloudflareSolveStrategies.TARGET_CACHE_TTL_MS) {
        targetInfos = strategies.targetCache.targets;
      } else {
        const cdp = yield* CdpSender;
        const result = yield* cdp.sendViaProxy('Target.getTargets', {}, undefined, TARGET_GET_TIMEOUT_MS).pipe(
          Effect.orElseSucceed(() => null),
        );
        targetInfos = result?.targetInfos ?? [];
        strategies.targetCache = { targets: targetInfos, timestamp: now };
      }
      if (!targetInfos.length) return { _tag: 'not_detected' as const };

      // Count CF-matching targets BEFORE filtering by solvedCFTargetIds
      const cfTargets = targetInfos.filter(
        (t: { type: string; url?: string }) =>
          (t.type === 'iframe' || t.type === 'page')
          && t.url?.includes('challenges.cloudflare.com')
          && !isCFTestWidget(t.url!),
      );
      const filteredOut = cfTargets.filter(
        (t: { targetId?: string }) => t.targetId && solvedCFTargetIds?.has(t.targetId),
      );
      const matched = cfTargets.filter(
        (t: { targetId?: string }) => !(t.targetId && solvedCFTargetIds?.has(t.targetId)),
      );

      if (matched.length > 0 || filteredOut.length > 0) {
        yield* Effect.annotateCurrentSpan({
          'cf.detect.total_targets': targetInfos.length,
          'cf.detect.cf_targets': cfTargets.length,
          'cf.detect.filtered_stale': filteredOut.length,
          'cf.detect.fresh': matched.length,
          'cf.detect.solved_set_size': solvedCFTargetIds?.size ?? 0,
          'cf.detect.matched_urls': matched.map((t: { url?: string; targetId?: string }) => `${t.targetId?.slice(0, 8)}=${t.url}`).join(' | '),
          'cf.detect.filtered_ids': filteredOut.map((t: { targetId?: string }) => t.targetId?.slice(0, 8)).join(','),
        });
      }

      if (matched.length === 0) return { _tag: 'not_detected' as const };

      return {
        _tag: 'detected' as const,
        targets: matched.map((t: { type: string; url?: string; targetId?: string }) => ({
          targetId: t.targetId!,
          url: t.url ?? '',
          type: t.type as 'iframe' | 'page',
          meta: parseTurnstileOOPIFUrl(t.url ?? ''),
        })),
      };
    })();
  }

  /**
   * Check Turnstile OOPIF state via CDP DOM walk.
   * Replaces the MutationObserver + __turnstileStateBinding injection.
   * Returns Effect.
   *
   * Inspects the OOPIF's DOM tree for state indicator elements:
   * - #success (display !== none) → 'success'
   * - #fail → 'fail'
   * - #expired → 'expired'
   * - #timeout → 'timeout'
   * - #verifying → 'verifying' (mapped to 'pending')
   * - none visible → 'pending'
   */
  checkOOPIFStateViaCDP(iframeCdpSessionId: CdpSessionId): Effect.Effect<
    'success' | 'fail' | 'expired' | 'timeout' | 'pending' | null,
    never,
    typeof CdpSender.Identifier
  > {
    const strategies = this;
    return Effect.fn('cf.checkOOPIFStateViaCDP')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': iframeCdpSessionId });
      const cdp = yield* CdpSender;
      const doc = yield* cdp.send('DOM.getDocument', { depth: -1, pierce: true }, iframeCdpSessionId).pipe(
        Effect.orElseSucceed(() => null),
      );

      if (!doc?.root) return null;

      return strategies.findStateInOOPIFTree(doc.root);
    })();
  }





  /**
   * Walk the OOPIF DOM tree to find Turnstile state indicator elements.
   *
   * Turnstile OOPIF has elements with IDs: success, verifying, fail, expired, timeout.
   * The visible one (computed style display !== 'none') indicates current state.
   *
   * Since we can't check computed styles via DOM.getDocument, we look for element
   * presence and rely on Turnstile's pattern of only having the active state element
   * with visible styles. We check via DOM.resolveNode + Runtime.callFunctionOn
   * to get computed display for each candidate.
   *
   * Simplified approach: just check if state elements exist in the tree.
   * The activity loop calls this frequently, so we detect state transitions
   * by comparing with previous state.
   */
  private findStateInOOPIFTree(node: CDPNode): 'success' | 'fail' | 'expired' | 'timeout' | 'pending' {
    const stateIds = ['success', 'fail', 'expired', 'timeout'];
    const found = new Set<string>();
    this.collectElementsById(node, stateIds, found);

    // If #success element exists in the tree, Turnstile typically only renders
    // it when the challenge is solved. But we need visibility checks.
    // For now, check presence — the activity loop also checks isSolved() which
    // validates via turnstile.getResponse() / input value.
    // The actual visibility check requires Runtime.evaluate on the OOPIF session,
    // which we'll do as a focused check when we find state elements.
    if (found.has('success')) return 'success';
    if (found.has('fail')) return 'fail';
    if (found.has('expired')) return 'expired';
    if (found.has('timeout')) return 'timeout';

    return 'pending';
  }

  /** Collect elements by ID from the DOM tree. */
  private collectElementsById(node: CDPNode, ids: string[], found: Set<string>): void {
    const nodeId = getAttr(node, 'id');
    if (nodeId && ids.includes(nodeId)) {
      found.add(nodeId);
    }
    if (node.shadowRoots) {
      for (const shadow of node.shadowRoots) {
        this.collectElementsById(shadow, ids, found);
      }
    }
    if (node.contentDocument) {
      this.collectElementsById(node.contentDocument, ids, found);
    }
    if (node.children) {
      for (const child of node.children) {
        this.collectElementsById(child, ids, found);
      }
    }
  }
}
