import { describe, expect, it } from "vitest";
import { freshSessionId, injectSessionId } from "./session-id.js";

describe("freshSessionId", () => {
  it("returns a 32-char hyphen-free lowercase-hex token", () => {
    // Hyphen-free is the contract: the relay's RouteParams parser splits the
    // username on `-` and would truncate a UUIDv4 at its first hyphen. The
    // token must contain only [0-9a-f] so the full 128 bits survive.
    const id = freshSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain("-");
  });

  it("returns a different value on each call", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(freshSessionId());
    expect(ids.size).toBe(100);
  });
});

describe("injectSessionId", () => {
  it("appends -session-<uuid> to the existing username", () => {
    const out = injectSessionId("https://baseuser:secret@proxy.oeili.com:8443", "abc-123");
    const parsed = new URL(out);
    expect(decodeURIComponent(parsed.username)).toBe("baseuser-session-abc-123");
    expect(decodeURIComponent(parsed.password)).toBe("secret");
    expect(parsed.host).toBe("proxy.oeili.com:8443");
  });

  it("returns the URL unchanged when it has no username", () => {
    const url = "https://proxy.oeili.com:8443";
    expect(injectSessionId(url, "abc-123")).toBe(url);
  });

  it("returns the input unchanged when empty", () => {
    expect(injectSessionId("", "abc-123")).toBe("");
  });

  it("returns the input unchanged when not a valid URL", () => {
    expect(injectSessionId("not a url", "abc-123")).toBe("not a url");
  });

  it("preserves the port when injecting", () => {
    const out = injectSessionId("http://u:p@host:9999", "session-x");
    expect(new URL(out).port).toBe("9999");
  });

  it("URL-encodes special characters in the resulting username", () => {
    // If the base username already contains a hyphen this is fine; the
    // session_id is UUIDv4 (alphanumeric + hyphens) so no other special
    // chars need escaping. This test confirms the encoding round-trips.
    const out = injectSessionId(
      "https://my-user:p@host:443",
      "11111111-2222-3333-4444-555555555555",
    );
    const parsed = new URL(out);
    expect(decodeURIComponent(parsed.username)).toBe(
      "my-user-session-11111111-2222-3333-4444-555555555555",
    );
  });
});
