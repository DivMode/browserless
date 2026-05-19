import { describe, expect, it } from "vitest";
import { freshSessionId, injectSessionId } from "./session-id.js";

describe("freshSessionId", () => {
  it("returns a UUIDv4 string", () => {
    const id = freshSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
