/**
 * Phase 2: OOPIF Resolution — attach to the CF Turnstile OOPIF target.
 *
 * Matching priority (tried on each poll):
 * 1. frameId match — Phase 1's DOM.describeNode gave us the iframe's frameId
 * 2. parentFrameId match — page's frame tree root matches OOPIF's parent
 *
 * NEVER falls back to unfiltered candidates. A wrong-OOPIF click is worse
 * than no click — ghost clicks waste 60s resolution timeout and produce
 * false-positive click verification (mousedown fires on the wrong widget).
 */
import { Effect } from "effect";
import type { CdpSessionId, TargetId } from "../../shared/cloudflare-detection.js";
import { SolverEvents } from "./cf-services.js";
import { MAX_OOPIF_POLLS, OOPIF_POLL_DELAY, OOPIF_PROBE_TIMEOUT } from "./cf-schedules.js";

/** Effect-returning CDP sender — eliminates the Promise bridge. */
type EffectSend = (
  method: string,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;

/** Filtered candidate from Target.getTargets. */
interface OOPIFCandidate {
  readonly targetId: string;
  readonly type: string;
  readonly url?: string;
  readonly parentFrameId?: string;
}

/** Successful OOPIF match result. */
interface OOPIFMatch {
  readonly sessionId: CdpSessionId;
  readonly target: OOPIFCandidate;
  readonly method: "frameId_match" | "parentFrameId";
}

/**
 * Cloudflare's well-known test sitekey prefixes.
 * These appear in the OOPIF URL path and always auto-pass/block — skip them.
 */
const CF_TEST_SITEKEY_PREFIXES = ["1x00000000", "2x00000000", "3x00000000"];

function isCFTestWidget(url: string | undefined): boolean {
  if (!url) return false;
  return CF_TEST_SITEKEY_PREFIXES.some((prefix) => url.includes(prefix));
}

function isCFCandidate(t: { type: string; url?: string }): boolean {
  return (
    (t.type === "iframe" || t.type === "page") &&
    !!t.url?.includes("challenges.cloudflare.com") &&
    !isCFTestWidget(t.url)
  );
}

/**
 * Phase 2: Discover and attach to the CF Turnstile OOPIF.
 *
 * Polls Target.getTargets up to MAX_OOPIF_POLLS times. On each poll:
 * 1. frameId match: attach each candidate → Page.getFrameTree → compare
 *    frame tree root ID against Phase 1's iframeFrameId
 * 2. parentFrameId match: filter candidates by parentFrameId === page's
 *    root frameId → attach first match → cross-validate if iframeFrameId
 *    is available
 *
 * Returns null when no positive match is found — caller retries on next
 * detection cycle rather than clicking the wrong OOPIF.
 */
export function phase2OOPIFResolution(
  send: EffectSend,
  pageSend: EffectSend,
  pageCdpSessionId: CdpSessionId,
  pageTargetId: TargetId,
  iframeFrameId: string | null,
  via: string,
): Effect.Effect<CdpSessionId | null, never, typeof SolverEvents.Identifier> {
  return Effect.fn("cf.phase2OOPIFResolution")(function* () {
    yield* Effect.annotateCurrentSpan({
      "cf.target_id": pageTargetId,
      "cf.via": via,
      "cf.has_iframe_frame_id": !!iframeFrameId,
    });
    const events = yield* SolverEvents;
    const phase2Start = Date.now();

    // ── Resolve page's own frameId upfront (stable across polls) ────
    const pageFrameId: string | null = yield* pageSend(
      "Page.getFrameTree",
      {},
      pageCdpSessionId,
    ).pipe(
      Effect.map((r: any) => (r?.frameTree?.frame?.id as string) ?? null),
      Effect.orElseSucceed(() => null as string | null),
    );

    yield* Effect.annotateCurrentSpan({
      "cf.phase2.page_frame_id": pageFrameId?.substring(0, 16) ?? "null",
    });
    yield* events.marker(pageTargetId, "cf.phase2_start", {
      has_iframe_frame_id: !!iframeFrameId,
      page_frame_id: pageFrameId?.substring(0, 16) ?? null,
      via,
    });

    // ── Closured CDP helpers ────────────────────────────────────────

    /** Fetch CF OOPIF candidates (re-executed each poll — Effect is lazy). */
    const fetchCandidates = send("Target.getTargets").pipe(
      Effect.orElseSucceed(() => ({ targetInfos: [] as any[] })),
      Effect.map((r: any) => ((r?.targetInfos ?? []) as OOPIFCandidate[]).filter(isCFCandidate)),
    );

    /** Attach to a target, emit diagnostic marker, return sessionId or null. */
    const attachToTarget = (target: OOPIFCandidate, strategy: string, poll: number) =>
      Effect.fn("cf.phase2.attach")(function* () {
        const start = Date.now();
        const sessionId: CdpSessionId | null = yield* send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        }).pipe(
          Effect.map((r: any) => (r?.sessionId as CdpSessionId) ?? null),
          Effect.orElseSucceed(() => null as CdpSessionId | null),
        );
        yield* events.marker(pageTargetId, "cf.phase2_attach", {
          targetId: target.targetId.substring(0, 20),
          success: !!sessionId,
          elapsed_ms: Date.now() - start,
          poll,
          strategy,
        });
        return sessionId;
      })();

    /** Get the frame tree root frameId for an attached OOPIF session. */
    const getFrameTreeId = (sessionId: CdpSessionId): Effect.Effect<string | null> =>
      send("Page.getFrameTree", {}, sessionId).pipe(
        Effect.map((r: any) => (r?.frameTree?.frame?.id as string) ?? null),
        Effect.orElseSucceed(() => null as string | null),
      );

    // ── Matching strategies ─────────────────────────────────────────

    /**
     * Try frameId match: Phase 1 gave us the iframe's frameId — race all
     * candidates concurrently. First match wins, losers interrupted.
     *
     * Pre-filters by parentFrameId to skip OOPIFs from sibling tabs.
     * Per-probe timeout prevents stale targets from blocking (30s CDP default).
     */
    const tryFrameIdMatch = (
      candidates: readonly OOPIFCandidate[],
      poll: number,
    ): Effect.Effect<OOPIFMatch | null> => {
      if (!iframeFrameId) return Effect.succeed(null);
      // Pre-filter: only scan OOPIFs parented to OUR page
      const ours = pageFrameId
        ? candidates.filter((t) => t.parentFrameId === pageFrameId)
        : candidates;
      if (ours.length === 0) return Effect.succeed(null);
      return Effect.fn("cf.phase2.frameIdScan")(function* () {
        // Race all candidates — first frameId match wins, losers interrupted
        return yield* Effect.raceAll(
          ours.map((target) =>
            Effect.fn("cf.phase2.probe")(function* () {
              const sid = yield* attachToTarget(target, "frameId", poll);
              if (!sid) return yield* Effect.fail("no-session" as const);
              const fid = yield* getFrameTreeId(sid);
              if (!fid || (fid !== iframeFrameId && target.targetId !== iframeFrameId)) {
                return yield* Effect.fail("no-match" as const);
              }
              yield* events.marker(pageTargetId, "cf.oopif_discovered", {
                method: "active",
                via,
                filter: "frameId_match",
                targetId: target.targetId,
                url: target.url?.substring(0, 100),
                total_candidates: ours.length,
                poll,
              });
              return {
                sessionId: sid,
                target,
                method: "frameId_match" as const,
              } satisfies OOPIFMatch;
            })().pipe(Effect.timeout(OOPIF_PROBE_TIMEOUT)),
          ),
        ).pipe(Effect.orElseSucceed(() => null as OOPIFMatch | null));
      })();
    };

    /**
     * Try parentFrameId match: filter candidates whose parentFrameId matches
     * the page's root frameId, race concurrently, cross-validate against
     * iframeFrameId when available.
     */
    const tryParentMatch = (
      candidates: readonly OOPIFCandidate[],
      poll: number,
    ): Effect.Effect<OOPIFMatch | null> => {
      if (!pageFrameId) return Effect.succeed(null);
      const filtered = candidates.filter((t) => t.parentFrameId === pageFrameId);
      if (filtered.length === 0) return Effect.succeed(null);
      return Effect.fn("cf.phase2.parentScan")(function* () {
        return yield* Effect.raceAll(
          filtered.map((target) =>
            Effect.fn("cf.phase2.probe")(function* () {
              const sid = yield* attachToTarget(target, "parentFrameId", poll);
              if (!sid) return yield* Effect.fail("no-session" as const);
              // Cross-validate against Phase 1 frameId when available
              if (iframeFrameId) {
                const fid = yield* getFrameTreeId(sid);
                if (fid && fid !== iframeFrameId && target.targetId !== iframeFrameId) {
                  yield* events.marker(pageTargetId, "cf.oopif_stale", {
                    via,
                    targetId: target.targetId,
                    expected_frame_id: (iframeFrameId as string).substring(0, 20),
                    actual_frame_id: fid.substring(0, 20),
                    poll,
                  });
                  return yield* Effect.fail("stale" as const);
                }
              }
              yield* events.marker(pageTargetId, "cf.oopif_discovered", {
                method: "active",
                via,
                filter: "parentFrameId",
                targetId: target.targetId,
                url: target.url?.substring(0, 100),
                total_candidates: filtered.length,
                poll,
              });
              return {
                sessionId: sid,
                target,
                method: "parentFrameId" as const,
              } satisfies OOPIFMatch;
            })().pipe(Effect.timeout(OOPIF_PROBE_TIMEOUT)),
          ),
        ).pipe(Effect.orElseSucceed(() => null as OOPIFMatch | null));
      })();
    };

    // ── Poll loop ────────────────────────────────────────────────────
    // Object wrapper: TS control flow analysis doesn't narrow properties,
    // so mutations inside Effect.fn callbacks are tracked correctly.
    const result: { match: OOPIFMatch | null; pollsUsed: number } = {
      match: null,
      pollsUsed: 0,
    };

    for (let poll = 0; poll < MAX_OOPIF_POLLS && !result.match; poll++) {
      result.pollsUsed = poll + 1;
      yield* Effect.fn("cf.phase2.poll")(function* () {
        yield* Effect.annotateCurrentSpan({ "cf.phase2.poll": poll });
        if (poll > 0) yield* Effect.sleep(OOPIF_POLL_DELAY);

        const candidates = yield* fetchCandidates;

        yield* Effect.annotateCurrentSpan({
          "cf.phase2.cf_candidates": candidates.length,
          "cf.phase2.candidate_ids": candidates.map((t) => t.targetId?.substring(0, 16)).join(","),
          "cf.phase2.candidate_urls": candidates
            .map((t) => (t.url || "").substring(0, 80))
            .join(" | "),
          "cf.phase2.candidate_parents": candidates
            .map((t) => (t.parentFrameId || "none").substring(0, 16))
            .join(","),
        });

        if (candidates.length === 0) return;

        // Priority 1: frameId match (Phase 1 anchor)
        const frameMatch = yield* tryFrameIdMatch(candidates, poll);
        if (frameMatch) {
          result.match = frameMatch;
          return;
        }

        // Priority 2: parentFrameId match (page frameId anchor)
        const parentMatch = yield* tryParentMatch(candidates, poll);
        if (parentMatch) {
          result.match = parentMatch;
          return;
        }

        // No match this poll
        yield* events.marker(pageTargetId, "cf.phase2_no_match", {
          poll,
          candidates: candidates.length,
          has_iframe_frame_id: !!iframeFrameId,
          has_page_frame_id: !!pageFrameId,
        });
      })();
    }

    // ── Final annotations ────────────────────────────────────────────
    const { match, pollsUsed } = result;

    yield* Effect.annotateCurrentSpan({
      "cf.oopif_found": !!match,
      "cf.phase2.polls_used": pollsUsed,
      "cf.phase2.selected_target_id": match?.target.targetId?.substring(0, 16) ?? "none",
      "cf.phase2.selected_url": match?.target.url?.substring(0, 80) ?? "none",
      "cf.phase2.selected_parent_frame": match?.target.parentFrameId?.substring(0, 16) ?? "none",
      "cf.phase2.match_method": match?.method ?? "none",
    });
    yield* events.marker(pageTargetId, "cf.phase2_end", {
      found: !!match,
      elapsed_ms: Date.now() - phase2Start,
      polls_used: pollsUsed,
      method: match?.method ?? "none",
    });

    return match?.sessionId ?? null;
  })();
}
