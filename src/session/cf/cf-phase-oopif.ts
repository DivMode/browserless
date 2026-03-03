/**
 * Phase 2: OOPIF Resolution — attach to the CF Turnstile OOPIF target.
 *
 * Extracted from cloudflare-solve-strategies.ts for maintainability.
 * Pydoll creates a new ConnectionHandler, calls Target.getTargets,
 * then for each target: attachToTarget → Page.getFrameTree → DOM.getFrameOwner
 * → match backendNodeId from Phase 1.
 */
import { Effect } from 'effect';
import type { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import { SolverEvents } from './cf-services.js';
import { MAX_OOPIF_POLLS } from './cf-schedules.js';

/** Effect-returning CDP sender — eliminates the Promise bridge. */
type EffectSend = (
  method: string,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;

/**
 * Cloudflare's well-known test sitekey prefixes.
 * These appear in the OOPIF URL path and always auto-pass/block — skip them.
 */
const CF_TEST_SITEKEY_PREFIXES = ['1x00000000', '2x00000000', '3x00000000'];

/** Returns true if the OOPIF URL contains a CF test sitekey. */
function isCFTestWidget(url: string | undefined): boolean {
  if (!url) return false;
  return CF_TEST_SITEKEY_PREFIXES.some((prefix) => url.includes(prefix));
}

/**
 * Phase 2: Discover and attach to the CF Turnstile OOPIF.
 *
 * 1. Target.getTargets → filter by challenges.cloudflare.com
 * 2. Primary: match by frameId from Phase 1's DOM.describeNode
 * 3. Fallback: parentFrameId filter + polling for late-appearing OOPIFs
 */
export function phase2OOPIFResolution(
  send: EffectSend,
  pageSend: EffectSend,
  pageCdpSessionId: CdpSessionId,
  pageTargetId: TargetId,
  iframeFrameId: string | null,
  via: string,
): Effect.Effect<CdpSessionId | null, never, typeof SolverEvents.Identifier> {
  return Effect.fn('cf.phase2OOPIFResolution')(function*() {
    yield* Effect.annotateCurrentSpan({
      'cf.target_id': pageTargetId,
      'cf.via': via,
      'cf.has_iframe_frame_id': !!iframeFrameId,
    });
    const events = yield* SolverEvents;
    const targetsResult = yield* send('Target.getTargets').pipe(
      Effect.orElseSucceed(() => ({ targetInfos: [] as any[] })),
    );
    const targetInfos = targetsResult?.targetInfos;
    if (!targetInfos?.length) return null;

    // Filter out test widgets
    const candidates = targetInfos.filter(
      (t: { type: string; url?: string }) =>
        (t.type === 'iframe' || t.type === 'page')
        && t.url?.includes('challenges.cloudflare.com')
        && !isCFTestWidget(t.url),
    );

    let oopifSessionId: CdpSessionId | null = null;

    // ── Instrumentation: Phase 2 timing ─────────────────────────────
    const phase2Start = Date.now();
    yield* events.marker(pageTargetId, 'cf.phase2_start', {
      candidate_count: candidates.length,
      has_iframe_frame_id: !!iframeFrameId,
      via,
    });

    // Primary: match by frameId from page-side DOM.describeNode
    // The iframe element's frameId (from page session) matches the target's
    // frame tree root frame ID. frameId is a global Chrome identifier (unlike
    // backendNodeId which is per-connection).
    if (iframeFrameId && candidates.length > 0) {
      for (const target of candidates) {
        const attachStart = Date.now();
        const trySessionId = yield* send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        }).pipe(Effect.map((r: any) => r?.sessionId ?? null));

        yield* events.marker(pageTargetId, 'cf.phase2_attach', {
          targetId: target.targetId.substring(0, 20),
          success: !!trySessionId,
          elapsed_ms: Date.now() - attachStart,
          loop: 'primary',
        });

        if (!trySessionId) continue; // This target didn't match — try next

        const ft = yield* send('Page.getFrameTree', {}, trySessionId);
        const frameId = ft?.frameTree?.frame?.id;
        if (!frameId) continue; // This target didn't match — try next

        if (frameId === iframeFrameId || target.targetId === iframeFrameId) {
          oopifSessionId = trySessionId;
          yield* events.marker(pageTargetId, 'cf.oopif_discovered', {
            method: 'active', via,
            filter: 'frameId_match',
            targetId: target.targetId,
            url: target.url?.substring(0, 100),
            total_candidates: candidates.length,
          });
          break;
        }
      }
    }

    // Fallback: parentFrameId filter (if page-side traversal failed)
    // When iframeFrameId is set but frameId_match failed, the correct OOPIF
    // likely hasn't appeared in Target.getTargets yet (Chrome registers OOPIFs
    // asynchronously after the iframe element appears in the DOM). Poll for it.
    if (!oopifSessionId) {
      const maxOopifPolls = iframeFrameId ? MAX_OOPIF_POLLS : 1; // 6 × 500ms = 3s max wait
      for (let oopifPoll = 0; oopifPoll < maxOopifPolls; oopifPoll++) {
        if (oopifPoll > 0) {
          yield* Effect.sleep('500 millis');
          // Re-fetch targets — the correct OOPIF may have appeared
          const refreshed = yield* send('Target.getTargets').pipe(
            Effect.orElseSucceed(() => ({ targetInfos: [] as any[] })),
          );
          const refreshedCandidates = (refreshed.targetInfos ?? []).filter(
            (t: { type: string; url?: string }) =>
              (t.type === 'iframe' || t.type === 'page')
              && t.url?.includes('challenges.cloudflare.com')
              && !isCFTestWidget(t.url),
          );
          // Try frameId_match on refreshed targets
          for (const target of refreshedCandidates) {
            const attachStart = Date.now();
            const trySessionId = yield* send('Target.attachToTarget', {
              targetId: target.targetId,
              flatten: true,
            }).pipe(Effect.map((r: any) => r?.sessionId ?? null));

            yield* events.marker(pageTargetId, 'cf.phase2_attach', {
              targetId: target.targetId.substring(0, 20),
              success: !!trySessionId,
              elapsed_ms: Date.now() - attachStart,
              loop: 'fallback_retry',
              poll: oopifPoll,
            });

            if (!trySessionId) continue;
            const ft = yield* send('Page.getFrameTree', {}, trySessionId);
            const frameId = ft?.frameTree?.frame?.id;
            if (frameId && (frameId === iframeFrameId || target.targetId === iframeFrameId)) {
              oopifSessionId = trySessionId;
              yield* events.marker(pageTargetId, 'cf.oopif_discovered', {
                method: 'active', via,
                filter: 'frameId_match_retry',
                targetId: target.targetId,
                url: target.url?.substring(0, 100),
                total_candidates: refreshedCandidates.length,
                poll: oopifPoll,
              });
              break;
            }
          }
          if (oopifSessionId) break;
          continue;
        }

        // First poll (oopifPoll === 0): use parentFrameId filter on existing candidates
        let pageFrameId: string | null = null;
        const frameTree = yield* pageSend('Page.getFrameTree', {}, pageCdpSessionId);
        pageFrameId = frameTree?.frameTree?.frame?.id ?? null;

        let cfTargets = pageFrameId
          ? candidates.filter(
              (t: { parentFrameId?: string }) => t.parentFrameId === pageFrameId,
            )
          : [];

        if (cfTargets.length === 0) cfTargets = candidates;

        if (cfTargets.length > 0) {
          const target = cfTargets[0];
          const attachStart = Date.now();
          const sessionId = yield* send('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          }).pipe(Effect.map((r: any) => r?.sessionId ?? null));

          yield* events.marker(pageTargetId, 'cf.phase2_attach', {
            targetId: target.targetId.substring(0, 20),
            success: !!sessionId,
            elapsed_ms: Date.now() - attachStart,
            loop: 'fallback_first',
          });

          if (sessionId) {
            // If we have iframeFrameId, verify this OOPIF matches before committing
            if (iframeFrameId) {
              const ft = yield* send('Page.getFrameTree', {}, sessionId);
              const frameId = ft?.frameTree?.frame?.id;
              if (frameId && frameId !== iframeFrameId && target.targetId !== iframeFrameId) {
                // Stale OOPIF — doesn't match our Phase 1 iframe. Keep polling.
                yield* events.marker(pageTargetId, 'cf.oopif_stale', {
                  via, targetId: target.targetId,
                  expected_frame_id: (iframeFrameId as string).substring(0, 20),
                  actual_frame_id: frameId?.substring(0, 20),
                  poll: oopifPoll,
                });
                continue;
              }
            }
            oopifSessionId = sessionId;
            yield* events.marker(pageTargetId, 'cf.oopif_discovered', {
              method: 'active', via,
              filter: pageFrameId ? 'parentFrameId' : 'url',
              targetId: target.targetId,
              url: target.url?.substring(0, 100),
              total_candidates: cfTargets.length,
            });
            break;
          }
        }
      }
    }

    yield* Effect.annotateCurrentSpan({ 'cf.oopif_found': !!oopifSessionId });
    yield* events.marker(pageTargetId, 'cf.phase2_end', {
      found: !!oopifSessionId,
      elapsed_ms: Date.now() - phase2Start,
      candidates_tried: candidates.length,
    });
    return oopifSessionId;
  })();
}
