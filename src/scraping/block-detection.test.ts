import { describe, expect, it } from "vitest";
import { isBlockTrigger } from "./block-detection.js";
import {
  ApiError,
  BacklinksFetchFailed,
  CdpSessionError,
  InterceptionTimeoutError,
  NavigationError,
  ProxyEgressDeadError,
  RateLimitedError,
  ResultTimeoutError,
  TurnstileTimeoutError,
} from "./ahrefs-errors.js";

describe("isBlockTrigger", () => {
  it("returns false for undefined", () => {
    expect(isBlockTrigger(undefined)).toBe(false);
  });

  describe("ApiError", () => {
    it("triggers on InvalidCaptcha even when cfBlocked is false (rotate on token reject)", () => {
      const e = new ApiError({
        domain: "x.com",
        message: "ahrefs_backlinks_api_error:InvalidCaptcha",
        apiErrors: [],
        cfBlocked: false,
      });
      expect(isBlockTrigger(e)).toBe(true);
    });

    it("triggers when cfBlocked is true", () => {
      const e = new ApiError({
        domain: "x.com",
        message: "blocked",
        apiErrors: [],
        cfBlocked: true,
      });
      expect(isBlockTrigger(e)).toBe(true);
    });

    it("does NOT trigger when cfBlocked is false", () => {
      const e = new ApiError({
        domain: "x.com",
        message: "other api error",
        apiErrors: [],
        cfBlocked: false,
      });
      expect(isBlockTrigger(e)).toBe(false);
    });
  });

  describe("BacklinksFetchFailed", () => {
    it("triggers when any apiError has isCf=true", () => {
      const e = new BacklinksFetchFailed({
        domain: "x.com",
        message: "list failed",
        apiErrors: [{ endpoint: "backlinks_list", status: 403, isCf: true }],
        overviewData: { backlinks: 5 },
      });
      expect(isBlockTrigger(e)).toBe(true);
    });

    it("does NOT trigger when no apiError has isCf=true", () => {
      const e = new BacklinksFetchFailed({
        domain: "x.com",
        message: "list failed",
        apiErrors: [{ endpoint: "backlinks_list", status: 500, isCf: false }],
        overviewData: {},
      });
      expect(isBlockTrigger(e)).toBe(false);
    });

    it("does NOT trigger with empty apiErrors", () => {
      const e = new BacklinksFetchFailed({
        domain: "x.com",
        message: "list failed",
        apiErrors: [],
        overviewData: {},
      });
      expect(isBlockTrigger(e)).toBe(false);
    });
  });

  describe("TurnstileTimeoutError", () => {
    it("triggers when apiCallStatus is 'pending' (turnstile solved, fetch hung)", () => {
      const e = new TurnstileTimeoutError({
        domain: "x.com",
        scrapeType: "backlinks",
        apiCallStatus: "pending",
      });
      expect(isBlockTrigger(e)).toBe(true);
    });

    it("does NOT trigger when apiCallStatus is 'not_called' (solver-side miss)", () => {
      const e = new TurnstileTimeoutError({
        domain: "x.com",
        scrapeType: "backlinks",
        apiCallStatus: "not_called",
      });
      expect(isBlockTrigger(e)).toBe(false);
    });

    it("does NOT trigger when apiCallStatus is 'responded_200'", () => {
      const e = new TurnstileTimeoutError({
        domain: "x.com",
        scrapeType: "backlinks",
        apiCallStatus: "responded_200",
      });
      expect(isBlockTrigger(e)).toBe(false);
    });
  });

  describe("RateLimitedError", () => {
    it("triggers for a 429 (upstream IP rate-limit → rotate egress IP)", () => {
      const e = new RateLimitedError({ domain: "x.com", status: 429 });
      expect(isBlockTrigger(e)).toBe(true);
    });

    it("triggers for a 403 (upstream IP block → rotate egress IP)", () => {
      const e = new RateLimitedError({ domain: "x.com", status: 403 });
      expect(isBlockTrigger(e)).toBe(true);
    });
  });

  describe("ProxyEgressDeadError", () => {
    it("triggers (dead phone egress → rotate session to pool-walk to a healthy phone)", () => {
      const e = new ProxyEgressDeadError({ domain: "x.com" });
      expect(isBlockTrigger(e)).toBe(true);
    });
  });

  describe("non-block error types", () => {
    it("returns false for InterceptionTimeoutError", () => {
      const e = new InterceptionTimeoutError({
        domain: "x.com",
        requestCount: 0,
        responseCount: 0,
        docResponseCount: 0,
      });
      expect(isBlockTrigger(e)).toBe(false);
    });

    it("returns false for NavigationError", () => {
      const e = new NavigationError({ url: "https://x.com", cause: "timeout" });
      expect(isBlockTrigger(e)).toBe(false);
    });

    it("returns false for CdpSessionError", () => {
      const e = new CdpSessionError({ cause: "disconnected" });
      expect(isBlockTrigger(e)).toBe(false);
    });

    it("returns false for ResultTimeoutError", () => {
      const e = new ResultTimeoutError({ domain: "x.com" });
      expect(isBlockTrigger(e)).toBe(false);
    });
  });
});
