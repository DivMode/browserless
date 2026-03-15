/**
 * Per-tab mutable state. Scalar fields, NOT Maps.
 * Created per tab, GC'd with tab runtime disposal.
 *
 * By using scalar fields instead of Map<TargetId, X> entries,
 * cross-tab contamination is structurally impossible — there's no
 * targetId key to mix up.
 */
import type { CdpSessionId, TargetId } from "../../shared/cloudflare-detection.js";

export class TabSolverState {
  /** Whether the CF bridge push has already fired a solved event for this tab. */
  bindingSolved = false;
  /** Pending OOPIF that arrived before detection registered (race condition). */
  pendingIframe: { iframeCdpSessionId: CdpSessionId; iframeTargetId: TargetId } | null = null;
  /** Number of CF rechallenges on this tab so far. */
  rechallengeCount = 0;
  /** Per-tab reload count for widget-not-rendered recovery. Reset on solve. */
  widgetReloadCount = 0;
  /** Per-tab accumulator of solved/failed phases for compound summary labels. */
  summaryPhases: { type: string; label: string }[] = [];
}
