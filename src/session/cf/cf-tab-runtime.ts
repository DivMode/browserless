/**
 * Per-tab runtime state container.
 *
 * Each tab gets its own TabRuntime containing TabSolverState with scalar
 * fields (not Maps). Cross-tab contamination is structurally impossible
 * because there are no targetId keys to mix up.
 *
 * State is GC'd when the TabRuntime entry is deleted from the map —
 * no manual per-field cleanup needed.
 */
import type { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import { TabSolverState } from './cf-tab-state.js';

/** Per-tab state container. */
export interface TabRuntime {
  readonly state: TabSolverState;
  readonly targetId: TargetId;
  readonly cdpSessionId: CdpSessionId;
  /** Resolved by detectTurnstileWidgetEffect at detection start. */
  pageFrameId: string | null;
}

/** Create a per-tab state container. */
export function makeTabRuntime(opts: {
  targetId: TargetId;
  cdpSessionId: CdpSessionId;
  pageFrameId: string | null;
}): TabRuntime {
  return {
    state: new TabSolverState(),
    targetId: opts.targetId,
    cdpSessionId: opts.cdpSessionId,
    pageFrameId: opts.pageFrameId,
  };
}
