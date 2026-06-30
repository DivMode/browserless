/**
 * Contract test for the ahrefs success ALLOWLIST.
 *
 * Pins the invariant that replaced the historical denylist:
 *
 *     parseResult returns success:true  ⇔  the overview is a well-formed
 *     ["Ok", { data: <full numeric block> }] envelope
 *
 * i.e. NO unanticipated 200 body (InvalidCaptcha, missing/undefined overview,
 * an ["Ok",…] shell with an incomplete data block, a future ahrefs shape) may
 * ever be recorded as a successful scrape. This is the property that, when
 * violated historically, produced the "99% healthy while domains got nothing"
 * false-success class.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseResult } from "./ahrefs-service.js";
import {
  checkBacklinksOverview,
  checkTrafficOverview,
  checkOverviewContract,
} from "./ahrefs-contract.js";
import type { ScrapeType } from "./ahrefs-types.js";

const timings = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

/** Run parseResult and report whether it SUCCEEDED (true) or FAILED (false). */
const didSucceed = (apiResult: Record<string, unknown>, scrapeType: ScrapeType): boolean =>
  Effect.runSync(
    parseResult(apiResult, "test.com", scrapeType, timings, "responded_ok").pipe(
      Effect.match({ onFailure: () => false, onSuccess: (r) => r.success === true }),
    ),
  );

const VALID_BACKLINKS_DATA = {
  domainRating: 50,
  backlinks: 100,
  refdomains: 20,
  dofollowBacklinks: 80,
  dofollowRefdomains: 15,
};

const VALID_TRAFFIC_PAYLOAD = {
  traffic: { trafficMonthlyAvg: 1234, costMontlyAvg: 50 },
  traffic_history: [{ date: "2026-01", organic: 1000 }],
};

// Shapes that historically slipped through the denylist as "success".
// Every one MUST be rejected by the allowlist.
const REJECTED_BACKLINKS: Array<[string, unknown]> = [
  ["undefined overview", undefined],
  ["null overview", null],
  ["empty array", []],
  ["error envelope InvalidCaptcha", ["Error", ["InvalidCaptcha"]]],
  ["a non-Ok status string", ["Pending", {}]],
  ["Ok but no payload object", ["Ok", null]],
  ["Ok but data is not an object", ["Ok", { data: 42, signedInput: {} }]],
  ["Ok but data is missing entirely", ["Ok", { signedInput: {} }]],
  [
    "Ok but missing dofollowBacklinks",
    ["Ok", { data: { domainRating: 1, backlinks: 1, refdomains: 1, dofollowRefdomains: 1 } }],
  ],
  [
    "Ok but a field is non-numeric",
    ["Ok", { data: { ...VALID_BACKLINKS_DATA, domainRating: "50" } }],
  ],
  ["Ok but a field is NaN", ["Ok", { data: { ...VALID_BACKLINKS_DATA, backlinks: NaN } }]],
  ["plain error object", { error: "boom" }],
  ["a bare object, not a tuple", { data: VALID_BACKLINKS_DATA }],
];

const REJECTED_TRAFFIC: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["error envelope InvalidCaptcha", ["Error", ["InvalidCaptcha"]]],
  ["Ok but no traffic block", ["Ok", { traffic_history: [] }]],
  ["Ok but trafficMonthlyAvg missing", ["Ok", { traffic: {}, traffic_history: [] }]],
  [
    "Ok but traffic_history is not an array",
    ["Ok", { traffic: { trafficMonthlyAvg: 1 }, traffic_history: {} }],
  ],
];

describe("ahrefs success contract — validator (allowlist)", () => {
  it("accepts a complete Ok backlinks overview", () => {
    expect(checkBacklinksOverview(["Ok", { data: VALID_BACKLINKS_DATA, signedInput: {} }])).toEqual(
      {
        ok: true,
      },
    );
  });

  it("accepts a complete Ok traffic overview", () => {
    expect(checkTrafficOverview(["Ok", VALID_TRAFFIC_PAYLOAD])).toEqual({ ok: true });
  });

  it("rejects the InvalidCaptcha error envelope with the precise reason", () => {
    expect(checkBacklinksOverview(["Error", ["InvalidCaptcha"]])).toEqual({
      ok: false,
      reason: "InvalidCaptcha",
    });
    expect(checkTrafficOverview(["Error", ["InvalidCaptcha"]])).toEqual({
      ok: false,
      reason: "InvalidCaptcha",
    });
  });

  it.each(REJECTED_BACKLINKS)("rejects backlinks overview: %s", (_label, overview) => {
    expect(checkBacklinksOverview(overview).ok).toBe(false);
  });

  it.each(REJECTED_TRAFFIC)("rejects traffic overview: %s", (_label, overview) => {
    expect(checkTrafficOverview(overview).ok).toBe(false);
  });

  it("dispatches by scrape type", () => {
    expect(checkOverviewContract("backlinks", ["Ok", { data: VALID_BACKLINKS_DATA }]).ok).toBe(
      true,
    );
    expect(checkOverviewContract("traffic", ["Ok", VALID_TRAFFIC_PAYLOAD]).ok).toBe(true);
  });
});

describe("ahrefs success contract — parseResult enforces the allowlist", () => {
  it("backlinks: a complete Ok overview succeeds", () => {
    expect(
      didSucceed(
        { overview: ["Ok", { data: VALID_BACKLINKS_DATA, signedInput: {} }], backlinks: null },
        "backlinks",
      ),
    ).toBe(true);
  });

  it("traffic: a complete Ok overview succeeds", () => {
    expect(didSucceed({ overview: ["Ok", VALID_TRAFFIC_PAYLOAD] }, "traffic")).toBe(true);
  });

  // The core property: NO non-Ok / incomplete overview may EVER read as success.
  it.each(REJECTED_BACKLINKS)("backlinks: no false-success for %s", (_label, overview) => {
    expect(didSucceed({ overview, backlinks: null }, "backlinks")).toBe(false);
  });

  it.each(REJECTED_TRAFFIC)("traffic: no false-success for %s", (_label, overview) => {
    expect(didSucceed({ overview }, "traffic")).toBe(false);
  });
});
