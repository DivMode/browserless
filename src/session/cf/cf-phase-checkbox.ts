/**
 * Phase 3: Checkbox Finding — locate the Turnstile checkbox in the OOPIF.
 *
 * Extracted from cloudflare-solve-strategies.ts for maintainability.
 * Three strategies tried in order:
 *   1. Isolated world (Page.createIsolatedWorld + Runtime.evaluate in isolated context)
 *   2. Runtime.callFunctionOn (DOM.getDocument → resolveNode → callFunctionOn)
 *   3. DOM tree walk (DOM.getDocument depth=-1 pierce=true → recursive walk)
 */
import { Effect } from 'effect';
import type { CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { SolverEvents } from './cf-services.js';
import { CDP_CALL_TIMEOUT_MS, MAX_CHECKBOX_POLLS, CHECKBOX_POLL_INTERVAL_MS } from './cf-schedules.js';

/** Effect-returning CDP sender — eliminates the Promise bridge. */
type EffectSend = (
  method: string,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;

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

/** Wrap an Effect-returning CDP call with a timeout to prevent hangs when OOPIF navigates away. */
const cdpCall = <T>(effect: Effect.Effect<T>) =>
  effect.pipe(
    Effect.timeout(`${CDP_CALL_TIMEOUT_MS} millis`),
    Effect.orElseSucceed(() => null as T | null),
  );

// ── Checkbox finding strategies ──────────────────────────────────────

/**
 * Find checkbox using an isolated JS world — matches pydoll's exact approach.
 *
 * CF's WASM in the main world cannot observe execution in isolated worlds.
 */
export function findCheckboxViaIsolatedWorld(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
  contextId: number,
): Effect.Effect<{ objectId: string; backendNodeId: number } | null> {
  return Effect.fn('cf.findCheckboxViaIsolatedWorld')(function*() {
    yield* Effect.annotateCurrentSpan({ 'cf.target_id': oopifSessionId, 'cf.via': 'isolated_world' });
    // Get document root in the isolated world
    const docResult = yield* cdpCall(send('Runtime.evaluate', {
      expression: 'document.documentElement',
      contextId,
      returnByValue: false,
    }, oopifSessionId));
    if (!docResult?.result?.objectId) return null;

    // Find body
    const bodyResult = yield* cdpCall(send('Runtime.callFunctionOn', {
      objectId: docResult.result.objectId,
      functionDeclaration: `function() { return this.querySelector('body'); }`,
      returnByValue: false,
    }, oopifSessionId));
    if (!bodyResult?.result?.objectId) return null;

    // Describe body with pierce to get shadow roots
    const bodyDesc = yield* cdpCall(send('DOM.describeNode', {
      objectId: bodyResult.result.objectId,
      pierce: true,
      depth: 1,
    }, oopifSessionId));

    const shadowRoots = bodyDesc?.node?.shadowRoots;
    if (shadowRoots?.length) {
      for (const sr of shadowRoots) {
        const found = yield* queryCheckboxInShadow(send, oopifSessionId, sr.backendNodeId);
        if (found) return found;
      }
    }

    // Search children for shadow hosts (one level deeper)
    const children = bodyDesc?.node?.children;
    if (children?.length) {
      for (const child of children) {
        const childDesc = yield* cdpCall(send('DOM.describeNode', {
          backendNodeId: child.backendNodeId,
          pierce: true,
          depth: 1,
        }, oopifSessionId));
        if (childDesc?.node?.shadowRoots?.length) {
          for (const sr of childDesc.node.shadowRoots) {
            const found = yield* queryCheckboxInShadow(send, oopifSessionId, sr.backendNodeId);
            if (found) return found;
          }
        }
      }
    }

    return null;
  })().pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
}

/**
 * Find the Turnstile checkbox using Runtime.callFunctionOn.
 * Routes ALL commands through the same WS connection.
 */
export function findCheckboxViaRuntime(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
): Effect.Effect<{ objectId: string; backendNodeId: number } | null> {
  return Effect.fn('cf.findCheckboxViaRuntime')(function*() {
    yield* Effect.annotateCurrentSpan({ 'cf.target_id': oopifSessionId, 'cf.via': 'runtime' });
    // Step 1: Get document node
    const doc = yield* cdpCall(send('DOM.getDocument', {
      depth: 0,
    }, oopifSessionId));
    if (!doc?.root) return null;

    // Step 2: Resolve document to get its objectId
    const resolved = yield* cdpCall(send('DOM.resolveNode', {
      nodeId: doc.root.nodeId,
    }, oopifSessionId));
    if (!resolved?.object?.objectId) return null;

    // Step 3: Find body element via Runtime.callFunctionOn
    const bodyResult = yield* cdpCall(send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: `function() { return this.querySelector('body'); }`,
      returnByValue: false,
    }, oopifSessionId));
    if (!bodyResult?.result?.objectId) return null;

    // Step 4: Describe body node with pierce=true to get shadow root
    const bodyDesc = yield* cdpCall(send('DOM.describeNode', {
      objectId: bodyResult.result.objectId,
      pierce: true,
      depth: 1,
    }, oopifSessionId));

    const shadowRoots = bodyDesc?.node?.shadowRoots;

    if (shadowRoots?.length) {
      for (const sr of shadowRoots) {
        const found = yield* queryCheckboxInShadow(send, oopifSessionId, sr.backendNodeId);
        if (found) return found;
      }
    }

    // If no shadow roots on body, search children for shadow hosts
    const children = bodyDesc?.node?.children;
    if (children?.length) {
      for (const child of children) {
        const childDesc = yield* cdpCall(send('DOM.describeNode', {
          backendNodeId: child.backendNodeId,
          pierce: true,
          depth: 1,
        }, oopifSessionId));
        if (childDesc?.node?.shadowRoots?.length) {
          for (const sr of childDesc.node.shadowRoots) {
            const found = yield* queryCheckboxInShadow(send, oopifSessionId, sr.backendNodeId);
            if (found) return found;
          }
        }
      }
    }

    return null;
  })().pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
}

/** Query checkbox inside a resolved shadow root. */
function queryCheckboxInShadow(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
  shadowBackendNodeId: number,
): Effect.Effect<{ objectId: string; backendNodeId: number } | null> {
  return Effect.fn('cf.queryCheckboxInShadow')(function*() {
    yield* Effect.annotateCurrentSpan({ 'cf.target_id': oopifSessionId });
    // Resolve shadow root to objectId
    const shadowResolved = yield* cdpCall(send('DOM.resolveNode', {
      backendNodeId: shadowBackendNodeId,
    }, oopifSessionId));
    if (!shadowResolved?.object?.objectId) return null;

    // Try span.cb-i first (Turnstile's primary checkbox indicator)
    const cbResult = yield* cdpCall(send('Runtime.callFunctionOn', {
      objectId: shadowResolved.object.objectId,
      functionDeclaration: `function() { return this.querySelector('span.cb-i') || this.querySelector('input[type="checkbox"]'); }`,
      returnByValue: false,
    }, oopifSessionId));

    if (!cbResult?.result?.objectId || cbResult.result.subtype === 'null') return null;

    // Get the backendNodeId for the checkbox (needed for getBoxModel)
    const cbDesc = yield* cdpCall(send('DOM.describeNode', {
      objectId: cbResult.result.objectId,
    }, oopifSessionId));

    if (!cbDesc?.node?.backendNodeId) return null;

    return {
      objectId: cbResult.result.objectId,
      backendNodeId: cbDesc.node.backendNodeId,
    };
  })();
}

// ── Phase 3: Checkbox find orchestrator ──────────────────────────────

/**
 * Phase 3: Find the Turnstile checkbox in the OOPIF.
 *
 * Polls up to MAX_CHECKBOX_POLLS times with CHECKBOX_POLL_INTERVAL_MS gaps,
 * matching pydoll's querySelector polling behavior. CF's WASM needs time to
 * render the widget after the OOPIF loads.
 */
export function phase3CheckboxFind(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
  active: ActiveDetection,
  via: string,
  solveStart: number,
): Effect.Effect<{ checkbox: { objectId: string; backendNodeId: number }; method: string; checkboxFoundAt: number } | null, never, typeof SolverEvents.Identifier> {
  const pageTargetId = active.pageTargetId;
  return Effect.fn('cf.phase3CheckboxFind')(function*() {
    yield* Effect.annotateCurrentSpan({
      'cf.type': active.info.type,
      'cf.target_id': pageTargetId,
      'cf.via': via,
    });
    const events = yield* SolverEvents;

    const phase3Start = Date.now();
    yield* events.marker(pageTargetId, 'cf.phase3_start', {
      via, oopif_session: oopifSessionId.substring(0, 20),
    });

    // Create isolated world
    let isolatedContextId: number | null = null;
    let oopifFrameId: string | null = null;
    const frameTreeResult = yield* send('Page.getFrameTree', {}, oopifSessionId);
    oopifFrameId = frameTreeResult?.frameTree?.frame?.id ?? null;

    if (oopifFrameId) {
      const isolatedWorld = yield* send('Page.createIsolatedWorld', {
        frameId: oopifFrameId,
        worldName: `browserless::cf::${oopifFrameId}`,
      }, oopifSessionId);
      isolatedContextId = isolatedWorld?.executionContextId ?? null;
    }

    yield* events.marker(pageTargetId, 'cf.cdp_dom_session', {
      using_iframe: true, type: active.info.type, via,
      isolated_world: !!isolatedContextId,
      oopif_frame_id: oopifFrameId ?? 'none',
    });

    // Find checkbox with polling
    let checkbox: { objectId: string; backendNodeId: number } | null = null;
    let method = 'none';
    let pollCount = 0;

    const maxPolls = MAX_CHECKBOX_POLLS;
    const pollInterval = CHECKBOX_POLL_INTERVAL_MS;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (active.aborted) return null;
      pollCount = poll + 1;

      // Strategy 3 FIRST — single CDP call, most resilient under concurrent load
      const s3Start = Date.now();
      const doc = yield* cdpCall(send('DOM.getDocument', {
        depth: -1, pierce: true,
      }, oopifSessionId));
      if (doc?.root) {
        const node = findCheckboxInTree(doc.root);
        if (node) {
          checkbox = { objectId: '', backendNodeId: node.backendNodeId };
          method = 'dom_tree_walk';
          yield* events.marker(pageTargetId, 'cf.phase3_strategy', {
            strategy: 'dom_tree_walk', poll, elapsed_ms: Date.now() - s3Start,
            found: true, doc_root: true,
          });
          break;
        }
      }
      yield* events.marker(pageTargetId, 'cf.phase3_strategy', {
        strategy: 'dom_tree_walk', poll, elapsed_ms: Date.now() - s3Start,
        found: false, doc_root: !!doc?.root,
      });

      // Strategy 1 fallback — isolated world (only if tree walk found nothing)
      if (isolatedContextId) {
        const s1Start = Date.now();
        checkbox = yield* findCheckboxViaIsolatedWorld(send, oopifSessionId, isolatedContextId);
        yield* events.marker(pageTargetId, 'cf.phase3_strategy', {
          strategy: 'isolated_world', poll, elapsed_ms: Date.now() - s1Start,
          found: !!checkbox,
        });
        if (checkbox) { method = 'isolated_world'; break; }
      }

      // Strategy 2 fallback — runtime query
      const s2Start = Date.now();
      checkbox = yield* findCheckboxViaRuntime(send, oopifSessionId);
      yield* events.marker(pageTargetId, 'cf.phase3_strategy', {
        strategy: 'runtime_query', poll, elapsed_ms: Date.now() - s2Start,
        found: !!checkbox,
      });
      if (checkbox) { method = 'runtime_query'; break; }

      // Checkbox not found yet — wait and retry (matching pydoll's polling)
      yield* Effect.sleep(`${pollInterval} millis`);
    }

    if (!checkbox) {
      yield* Effect.annotateCurrentSpan({ 'cf.checkbox_found': false, 'cf.poll_count': pollCount });
      // Snapshot shadow DOM state for diagnostics
      const diag = yield* diagnoseShadowDOM(send, oopifSessionId, isolatedContextId);
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox', { via, polls: pollCount, diag });
      yield* events.emitProgress(active, 'widget_error', {
        error_type: 'no_checkbox',
        diag_alive: diag.alive,
        diag_body_len: diag.bodyLen,
        diag_shadow: diag.shadow,
        diag_cbI: diag.cbI,
        diag_inp: diag.inp,
      });
      yield* events.marker(pageTargetId, 'cf.phase3_end', { found: false, elapsed_ms: Date.now() - phase3Start });
      return null;
    }

    yield* Effect.annotateCurrentSpan({ 'cf.checkbox_found': true, 'cf.poll_count': pollCount, 'cf.checkbox_method': method });
    const checkboxFoundAt = Date.now();
    yield* events.marker(pageTargetId, 'cf.cdp_checkbox_found', {
      method, backendNodeId: checkbox.backendNodeId,
      has_objectId: !!checkbox.objectId, via, polls: pollCount,
      checkbox_found_ms: checkboxFoundAt - solveStart,
    });
    yield* events.emitProgress(active, 'widget_found', { method, x: 0, y: 0 });
    yield* events.marker(pageTargetId, 'cf.phase3_end', { found: true, elapsed_ms: Date.now() - phase3Start });

    return { checkbox, method, checkboxFoundAt };
  })();
}

// ── Shadow DOM diagnostics ───────────────────────────────────────────

/**
 * Snapshot the OOPIF shadow DOM structure for diagnostics when checkbox isn't found.
 * Uses DOM.getDocument(pierce:true) + tree walk — pierces shadow DOM properly,
 * unlike querySelector which cannot cross shadow boundaries.
 */
function diagnoseShadowDOM(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
  _isolatedContextId: number | null,
): Effect.Effect<Record<string, unknown>> {
  return Effect.fn('cf.diagnoseShadowDOM')(function*() {
    yield* Effect.annotateCurrentSpan({ 'cf.target_id': oopifSessionId });
    const result: Record<string, unknown> = { alive: false, cbI: false, inp: false, shadow: 0, bodyLen: 0 };

    const doc = yield* cdpCall(send('DOM.getDocument', {
      depth: -1, pierce: true,
    }, oopifSessionId));

    if (!doc?.root) return result;
    result.alive = true;

    // Check for checkbox in full tree (pierces shadow DOM)
    const cbNode = findCheckboxInTree(doc.root);
    result.cbI = !!cbNode;

    // Walk tree for shadow root count + inp check + estimate body size
    let shadowCount = 0;
    let hasInput = false;
    let nodeCount = 0;
    function walk(n: CDPNode): void {
      nodeCount++;
      if (n.shadowRoots) {
        shadowCount += n.shadowRoots.length;
        n.shadowRoots.forEach(walk);
      }
      if (n.localName === 'input' && getAttr(n, 'type') === 'checkbox') {
        hasInput = true;
      }
      n.children?.forEach(walk);
      if (n.contentDocument) walk(n.contentDocument);
    }
    walk(doc.root);
    result.shadow = shadowCount;
    result.inp = hasInput;
    result.bodyLen = nodeCount;

    return result;
  })().pipe(Effect.orElseSucceed(() => ({ error: 'diag_failed' } as Record<string, unknown>)));
}

// ── DOM tree walking ─────────────────────────────────────────────────

/**
 * Walk the CDP DOM tree to find the Turnstile checkbox element.
 * Searches for span.cb-i and input[type=checkbox].
 */
export function findCheckboxInTree(node: CDPNode): CDPNode | null {
  if (isCheckboxTarget(node)) return node;

  if (node.shadowRoots) {
    for (const shadow of node.shadowRoots) {
      const found = findCheckboxInTree(shadow);
      if (found) return found;
    }
  }

  if (node.contentDocument) {
    const found = findCheckboxInTree(node.contentDocument);
    if (found) return found;
  }

  if (node.children) {
    for (const child of node.children) {
      const found = findCheckboxInTree(child);
      if (found) return found;
    }
  }

  return null;
}

/** Check if a DOM node is the Turnstile checkbox target. */
function isCheckboxTarget(node: CDPNode): boolean {
  const name = node.localName || node.nodeName?.toLowerCase();
  if (!name) return false;

  if (name === 'span' && hasClass(node, 'cb-i')) return true;
  if (name === 'input' && getAttr(node, 'type') === 'checkbox') return true;

  return false;
}

/** Check if node has a specific CSS class. */
function hasClass(node: CDPNode, className: string): boolean {
  const classAttr = getAttr(node, 'class');
  if (!classAttr) return false;
  return classAttr.split(/\s+/).includes(className);
}

/** Get attribute value from CDP node attributes array. */
export function getAttr(node: CDPNode, name: string): string | null {
  if (!node.attributes) return null;
  for (let i = 0; i < node.attributes.length - 1; i += 2) {
    if (node.attributes[i] === name) return node.attributes[i + 1];
  }
  return null;
}
