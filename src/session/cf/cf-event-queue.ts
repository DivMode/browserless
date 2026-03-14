/**
 * CF Event Queue — Queue.unbounded pipeline for CF event processing.
 *
 * Replaces createCFEvents frozen closure. Single FIFO consumer handles
 * tracker mutation, CDP event emission, and replay marker injection.
 *
 * Queue.offerUnsafe is synchronous — safe from Resolution callbacks,
 * scope finalizers, and fiber crash handlers.
 */
import { Effect, Latch, Match, Queue, Stream } from 'effect';

import { runForkInServer } from '../../otel-runtime.js';
import { CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { TargetId, CloudflareResult } from '../../shared/cloudflare-detection.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection, EmitClientEvent, InjectMarker } from './cloudflare-event-emitter.js';
import { Resolution } from './cf-resolution.js';
import type { CFEvent } from './cf-event-types.js';

export interface CFEventPipelineDeps {
  readonly injectMarker: InjectMarker;
  readonly emitClientEvent: () => EmitClientEvent;
  readonly sessionId: string;
  readonly shouldRecordMarkers: () => boolean;
}

export interface CFEventPipeline {
  readonly queue: Queue.Queue<CFEvent>;
  /** Fork this as a detached fiber — it drains the queue until shutdown. */
  readonly consumer: Effect.Effect<void>;
}

/**
 * Create a CF event pipeline with a Queue and Stream-based consumer.
 *
 * The consumer reproduces exact behavior of the old createCFEvents methods:
 *   - Progress: tracker.onProgress + emitClientEvent + marker
 *   - Solved: tracker.snapshot + log + emitClientEvent + marker
 *   - Failed: tracker.snapshot + log + emitClientEvent + marker
 *   - Detected: emitClientEvent
 *   - Marker: injectMarker (if shouldRecordMarkers)
 *   - StandaloneAutoSolved: construct synthetic active + Detected + Solved
 */
export function makeCFEventPipeline(deps: CFEventPipelineDeps): CFEventPipeline {
  const queue = Effect.runSync(Queue.unbounded<CFEvent>());

  const marker = (targetId: TargetId, tag: string, payload?: object): void => {
    if (deps.shouldRecordMarkers()) {
      deps.injectMarker(targetId, tag, payload);
    }
  };

  const handleEvent = (event: CFEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      Match.value(event).pipe(
        Match.tag('Detected', ({ active }) => {
          deps.emitClientEvent()('Browserless.cloudflareDetected', {
            type: active.info.type,
            url: active.info.url,
            iframeUrl: active.info.iframeUrl,
            cRay: active.info.cRay,
            detectionMethod: active.info.detectionMethod,
            pollCount: active.info.pollCount || 1,
            targetId: active.pageTargetId,
          }).catch((e) => runForkInServer(Effect.logDebug(`emitDetected failed: ${e instanceof Error ? e.message : String(e)}`)));
        }),

        Match.tag('Progress', ({ active, state, extra }) => {
          active.tracker.onProgress(state, extra);
          deps.emitClientEvent()('Browserless.cloudflareProgress', {
            state,
            elapsed_ms: Date.now() - active.startTime,
            attempt: active.attempt,
            targetId: active.pageTargetId,
            ...extra,
          }).catch((e) => runForkInServer(Effect.logDebug(`emitProgress failed: ${e instanceof Error ? e.message : String(e)}`)));
          marker(active.pageTargetId, 'cf.state_change', { state, ...extra });
        }),

        Match.tag('Solved', ({ active, result, cf_summary_label, skipMarker }) => {
          const snap = active.tracker.snapshot();
          const timingStr = snap.checkbox_to_click_ms != null
            ? ` checkbox_to_click_ms=${snap.checkbox_to_click_ms} phase4_ms=${snap.phase4_duration_ms}`
            : '';
          runForkInServer(Effect.logInfo(`CF solved: session=${deps.sessionId.slice(0, 8)} type=${result.type} method=${result.method} duration=${result.duration_ms}ms${timingStr}`));
          deps.emitClientEvent()('Browserless.cloudflareSolved', {
            ...result,
            token_length: result.token_length ?? result.token?.length ?? 0,
            targetId: active.pageTargetId,
            summary: active.tracker.snapshot(),
            cf_summary_label: cf_summary_label ?? '',
          }).catch((e) => runForkInServer(Effect.logDebug(`emitSolved failed: ${e instanceof Error ? e.message : String(e)}`)));
          if (!skipMarker) {
            marker(active.pageTargetId, 'cf.solved', {
              type: result.type, method: result.method, duration_ms: result.duration_ms,
              phase_label: result.phase_label, signal: result.signal,
            });
          }
        }),

        Match.tag('Failed', ({ active, reason, duration, phaseLabel, cf_summary_label, skipMarker, cf_verified }) => {
          const phase_label = phaseLabel ?? `✗ ${reason}`;
          const cfVerified = cf_verified ?? false;
          const snap = active.tracker.snapshot();
          const isRechallenge = (active.rechallengeCount ?? 0) > 0;
          const diag = snap.widget_diag;
          const diagStr = diag ? ` diag_alive=${diag.alive} diag_cbI=${diag.cbI} diag_inp=${diag.inp} diag_shadow=${diag.shadow} diag_bodyLen=${diag.bodyLen}` : '' ;
          const timingStr = snap.checkbox_to_click_ms != null
            ? ` checkbox_to_click_ms=${snap.checkbox_to_click_ms} phase4_ms=${snap.phase4_duration_ms}`
            : '';
          runForkInServer(Effect.logWarning(`CF failed: session=${deps.sessionId.slice(0, 8)} reason=${reason} type=${active.info.type} method=${active.info.detectionMethod} target=${active.pageTargetId.slice(0, 8)} duration=${duration}ms attempts=${active.attempt} oopif_url=${active.info.url || 'none'} rechallenge=${isRechallenge} cf_verified=${cfVerified} widget_error_count=${snap.widget_error_count} widget_error_type=${snap.widget_error_type ?? 'none'} click_count=${snap.click_count} false_positives=${snap.false_positive_count}${diagStr}${timingStr}`));
          deps.emitClientEvent()('Browserless.cloudflareFailed', {
            reason, type: active.info.type, duration_ms: duration, attempts: active.attempt,
            targetId: active.pageTargetId,
            oopif_url: active.info.url,
            summary: snap,
            phase_label,
            cf_summary_label,
            cf_verified: cfVerified,
          }).catch((e) => runForkInServer(Effect.logDebug(`emitFailed failed: ${e instanceof Error ? e.message : String(e)}`)));
          if (!skipMarker) {
            marker(active.pageTargetId, 'cf.failed', { reason, duration_ms: duration, phase_label, oopif_url: active.info.url, rechallenge: isRechallenge, cf_verified: cfVerified });
          }
        }),

        Match.tag('Marker', ({ targetId, tag, payload }) => {
          marker(targetId, tag, payload);
        }),

        Match.tag('StandaloneAutoSolved', ({ targetId, signal, tokenLength, cdpSessionId }) => {
          const info = {
            type: 'turnstile' as const, url: '', detectionMethod: signal,
          };
          const abortLatch = Latch.makeUnsafe(false);
          abortLatch.openUnsafe();
          const active: ActiveDetection = {
            info, pageCdpSessionId: cdpSessionId || CdpSessionId.makeUnsafe(''), pageTargetId: targetId,
            startTime: Date.now(), attempt: 0, aborted: true,
            tracker: new CloudflareTracker(info),
            abortLatch,
            resolution: Resolution.makeUnsafe(),
          };

          // Emit detected
          deps.emitClientEvent()('Browserless.cloudflareDetected', {
            type: active.info.type, url: active.info.url, iframeUrl: active.info.iframeUrl,
            cRay: active.info.cRay, detectionMethod: active.info.detectionMethod,
            pollCount: active.info.pollCount || 1, targetId: active.pageTargetId,
          }).catch((e) => runForkInServer(Effect.logDebug(`emitDetected failed: ${e instanceof Error ? e.message : String(e)}`)));
          if (targetId) {
            marker(targetId, 'cf.detected', { type: 'turnstile' });
          }

          // Emit solved
          const result: CloudflareResult = {
            solved: true, type: 'turnstile', method: 'auto_solve',
            duration_ms: 0, attempts: 0, auto_resolved: true,
            signal, token_length: tokenLength, phase_label: '→',
          };
          runForkInServer(Effect.logInfo(`CF solved: session=${deps.sessionId.slice(0, 8)} type=turnstile method=auto_solve duration=0ms`));
          deps.emitClientEvent()('Browserless.cloudflareSolved', {
            ...result,
            token_length: tokenLength,
            targetId: active.pageTargetId,
            summary: active.tracker.snapshot(),
            cf_summary_label: 'Emb→',
          }).catch((e) => runForkInServer(Effect.logDebug(`emitSolved failed: ${e instanceof Error ? e.message : String(e)}`)));
          marker(active.pageTargetId, 'cf.solved', {
            type: 'turnstile', method: 'auto_solve', duration_ms: 0,
            phase_label: '→', signal,
          });
        }),

        Match.exhaustive,
      );
    });

  const consumer = Stream.fromQueue(queue).pipe(
    Stream.runForEach(handleEvent),
    Effect.catchCause((cause) =>
      Effect.logError('CF event queue consumer crashed').pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
  );

  return { queue, consumer };
}
