import { describe, expect, it } from "vitest";
import {
  ApiError,
  CdpSessionError,
  NavigationError,
  TurnstileTimeoutError,
} from "./ahrefs-errors.js";
import { SessionTokenHolder } from "./session-token-holder.js";

// Deterministic generator so rotation is observable without relying on
// randomness: each call returns the next hyphen-free token in the list.
function sequence(...tokens: string[]): () => string {
  let i = 0;
  return () => {
    const t = tokens[i] ?? tokens[tokens.length - 1] ?? "";
    i++;
    return t;
  };
}

const cfBlock = () =>
  new ApiError({ domain: "x.com", message: "blocked", apiErrors: [], cfBlocked: true });
const turnstilePending = () =>
  new TurnstileTimeoutError({ domain: "x.com", scrapeType: "backlinks", apiCallStatus: "pending" });
const nonBlockApi = () =>
  new ApiError({ domain: "x.com", message: "other", apiErrors: [], cfBlocked: false });

describe("SessionTokenHolder", () => {
  it("returns a stable token across calls", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222"));
    const first = holder.current();
    expect(holder.current()).toBe(first);
    expect(holder.current()).toBe(first);
  });

  it("mints a hyphen-free token by default", () => {
    const holder = new SessionTokenHolder();
    expect(holder.current()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rotates to a new token when fed a block-trigger error", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222"));
    const before = holder.current();
    expect(before).toBe("aaaa1111");

    expect(holder.observe(cfBlock())).toBe(true);
    expect(holder.current()).toBe("bbbb2222");
    expect(holder.current()).not.toBe(before);
  });

  it("rotates on a pending-turnstile block too", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222"));
    expect(holder.observe(turnstilePending())).toBe(true);
    expect(holder.current()).toBe("bbbb2222");
  });

  it("does NOT rotate on a non-block error", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222"));
    const before = holder.current();
    expect(holder.observe(nonBlockApi())).toBe(false);
    expect(holder.observe(new NavigationError({ url: "https://x.com", cause: "timeout" }))).toBe(
      false,
    );
    expect(holder.observe(new CdpSessionError({ cause: "disconnected" }))).toBe(false);
    expect(holder.current()).toBe(before);
  });

  it("does NOT rotate on success (undefined error)", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222"));
    const before = holder.current();
    expect(holder.observe(undefined)).toBe(false);
    expect(holder.current()).toBe(before);
  });

  it("rotates again on a second block (each block advances the token)", () => {
    const holder = new SessionTokenHolder(sequence("aaaa1111", "bbbb2222", "cccc3333"));
    holder.observe(cfBlock());
    expect(holder.current()).toBe("bbbb2222");
    holder.observe(cfBlock());
    expect(holder.current()).toBe("cccc3333");
  });
});
