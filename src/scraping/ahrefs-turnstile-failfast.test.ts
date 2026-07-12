/**
 * Unit tests for the ahrefs Turnstile fail-fast:
 *   (A) the tightened embedded resolution budget (cf-schedules.ts), and
 *   (B) aborting the ahrefs result-wait on a DEFINITIVE CF solver terminal
 *       failure instead of idling to the in-page 90s ceiling.
 *
 * The SAFETY-CRITICAL property under test: the abort fires ONLY when the solver
 * has definitively given up (a small allowlist of terminal reasons) — NEVER on a
 * recoverable widget_reload/rechallenge or a verified solve — so a legit-but-slow
 * solve is never killed. A false abort (killing a real solve) is worse than
 * wasting the slot, so the discrimination is allowlist-based and fail-safe.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { EMBEDDED_RESOLUTION_TIMEOUT } from "../session/cf/cf-schedules.js";
import {
  isTerminalEmbeddedCfFailure,
  makeCfTerminalFailureSignal,
  TERMINAL_EMBEDDED_CF_FAIL_REASONS,
  type CfFailedParams,
} from "./ahrefs-cf-listener.js";
import { raceResultAgainstTerminalFailure } from "./ahrefs-cdp.js";

const TAB = "TARGET_ABC";
const RESULT = { overview: ["Ok", { data: { domain_rating: 1 } }] };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolve to "resolved" if `p` settles within `ms`, else "pending". */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<"resolved" | "pending"> {
  return Promise.race([
    p.then(() => "resolved" as const),
    sleep(ms).then(() => "pending" as const),
  ]);
}

// ── (A) Budget ───────────────────────────────────────────────────────

describe("(A) EMBEDDED_RESOLUTION_TIMEOUT budget", () => {
  it("is 40 seconds — cut from 60s, floored at the highest internal-phase budget", () => {
    // NOTE: 40s, NOT 30s. The embedded budget must stay AT/ABOVE every internal
    // phase a genuine solve depends on: PHASE3_TIMEOUT_MS=30s, the 40s
    // REJECTION_MONITOR_MAX_MS window, and the pinned VERIFICATION_STUCK_TIMEOUT_MS
    // =30s which MUST stay strictly below this timeout to fire (verification-stuck
    // .test.ts). 30s would sit below the 40s rejection-monitor floor and collide
    // with the 30s stuck-timer, defeating that reload recovery + breaking its test.
    expect(EMBEDDED_RESOLUTION_TIMEOUT).toBe("40 seconds");
  });
});

// ── (B) Terminal-vs-recoverable discrimination ───────────────────────

describe("(B) isTerminalEmbeddedCfFailure — terminal vs recoverable", () => {
  const embedded = (reason: string, extra: Partial<CfFailedParams> = {}): CfFailedParams => ({
    targetId: TAB,
    reason,
    phase_role: "embedded",
    ...extra,
  });

  it("ABORTS on the allowlisted terminal reasons (solver gave up, no token coming)", () => {
    for (const reason of ["resolution_timeout", "widget_not_found", "oopif_empty"]) {
      expect(isTerminalEmbeddedCfFailure(embedded(reason), TAB)).toBe(true);
    }
  });

  it("the terminal allowlist is EXACTLY those three reasons", () => {
    expect([...TERMINAL_EMBEDDED_CF_FAIL_REASONS].sort()).toEqual([
      "oopif_empty",
      "resolution_timeout",
      "widget_not_found",
    ]);
  });

  it("does NOT abort on widget_reload (solver reloads + re-detects — token can still come)", () => {
    expect(isTerminalEmbeddedCfFailure(embedded("widget_reload"), TAB)).toBe(false);
  });

  it("does NOT abort on rechallenge (solver re-detects a fresh challenge)", () => {
    expect(isTerminalEmbeddedCfFailure(embedded("rechallenge"), TAB)).toBe(false);
  });

  it("does NOT abort on a verified solve (cf_verified beats even an allowlisted reason)", () => {
    expect(
      isTerminalEmbeddedCfFailure(embedded("verified_session_close", { cf_verified: true }), TAB),
    ).toBe(false);
    expect(
      isTerminalEmbeddedCfFailure(embedded("resolution_timeout", { cf_verified: true }), TAB),
    ).toBe(false);
  });

  it("does NOT abort on an interstitial-phase failure (ahrefs is embedded-only)", () => {
    expect(
      isTerminalEmbeddedCfFailure(
        embedded("resolution_timeout", { phase_role: "interstitial" }),
        TAB,
      ),
    ).toBe(false);
  });

  it("does NOT abort on a DIFFERENT tab's failure (cross-tab event-bleed guard)", () => {
    expect(
      isTerminalEmbeddedCfFailure(embedded("resolution_timeout", { targetId: "OTHER_TAB" }), TAB),
    ).toBe(false);
    // Missing targetId is never our tab.
    expect(
      isTerminalEmbeddedCfFailure({ reason: "resolution_timeout", phase_role: "embedded" }, TAB),
    ).toBe(false);
  });

  it("does NOT abort on an unknown/new reason (allowlist ⇒ fail-safe to the 90s ceiling)", () => {
    // solver_exit / rechallenge_limit / session_gone are real reasons that are
    // NOT unambiguously terminal for an embedded ahrefs solve, so they are
    // deliberately excluded — a false abort is worse than one slow doomed scrape.
    for (const reason of [
      "solver_exit",
      "rechallenge_limit",
      "session_gone",
      "",
      "future_reason",
    ]) {
      expect(isTerminalEmbeddedCfFailure(embedded(reason), TAB)).toBe(false);
    }
  });

  it("allows phase_role to be absent (defensive — absence must not block a terminal reason)", () => {
    expect(isTerminalEmbeddedCfFailure({ targetId: TAB, reason: "resolution_timeout" }, TAB)).toBe(
      true,
    );
  });
});

// ── (B) One-shot signal ──────────────────────────────────────────────

describe("(B) makeCfTerminalFailureSignal — one-shot terminal signal", () => {
  it("resolves the promise + records the reason on the first terminal failure", async () => {
    const sig = makeCfTerminalFailureSignal(TAB);
    expect(sig.reason()).toBeNull();
    sig.offer({ targetId: TAB, reason: "resolution_timeout", phase_role: "embedded" });
    await sig.promise; // would hang the test if it never resolved
    expect(sig.reason()).toBe("resolution_timeout");
  });

  it("first terminal failure wins — later offers never overwrite the reason", async () => {
    const sig = makeCfTerminalFailureSignal(TAB);
    sig.offer({ targetId: TAB, reason: "widget_not_found", phase_role: "embedded" });
    sig.offer({ targetId: TAB, reason: "oopif_empty", phase_role: "embedded" });
    await sig.promise;
    expect(sig.reason()).toBe("widget_not_found");
  });

  it("stays PENDING (reason null) across recoverable failures — never fires the abort", async () => {
    const sig = makeCfTerminalFailureSignal(TAB);
    sig.offer({ targetId: TAB, reason: "widget_reload", phase_role: "embedded" });
    sig.offer({ targetId: TAB, reason: "rechallenge", phase_role: "embedded" });
    sig.offer({ targetId: TAB, reason: "resolution_timeout", phase_role: "interstitial" });
    sig.offer({ targetId: "OTHER", reason: "resolution_timeout", phase_role: "embedded" });
    expect(sig.reason()).toBeNull();
    expect(await settledWithin(sig.promise, 30)).toBe("pending");
  });
});

// ── (B) The race — abort vs complete ─────────────────────────────────

describe("(B) raceResultAgainstTerminalFailure", () => {
  it("(ii) a DEFINITIVE terminal failure aborts the wait early → undefined (no 90s idle)", async () => {
    // Effect.never simulates the doomed in-page poll that would otherwise idle to
    // its 90s wall. The terminal failure fires AFTER the wait has started.
    const sig = makeCfTerminalFailureSignal(TAB);
    const raced = Effect.runPromise(
      raceResultAgainstTerminalFailure<typeof RESULT>(Effect.never, sig.promise),
    );
    setTimeout(
      () => sig.offer({ targetId: TAB, reason: "resolution_timeout", phase_role: "embedded" }),
      10,
    );
    const result = await raced;
    expect(result).toBeUndefined();
    expect(sig.reason()).toBe("resolution_timeout");
  });

  it("(iii) a slow-but-successful solve is NOT aborted — result wins even amid widget_reloads", async () => {
    // The solver emits ONLY recoverable widget_reload events while a legit solve
    // is still in flight; the result arrives ~40ms later. The signal never fires,
    // so the result wins — a false abort here would kill a real solve.
    const sig = makeCfTerminalFailureSignal(TAB);
    const slowResult = Effect.promise(() => sleep(40).then(() => RESULT));
    const raced = Effect.runPromise(raceResultAgainstTerminalFailure(slowResult, sig.promise));
    sig.offer({ targetId: TAB, reason: "widget_reload", phase_role: "embedded" });
    setTimeout(
      () => sig.offer({ targetId: TAB, reason: "widget_reload", phase_role: "embedded" }),
      15,
    );
    const result = await raced;
    expect(result).toEqual(RESULT);
    expect(sig.reason()).toBeNull();
  });

  it("a result already available wins immediately over a never-firing signal", async () => {
    const sig = makeCfTerminalFailureSignal(TAB);
    const result = await Effect.runPromise(
      raceResultAgainstTerminalFailure(Effect.succeed(RESULT), sig.promise),
    );
    expect(result).toEqual(RESULT);
  });
});
