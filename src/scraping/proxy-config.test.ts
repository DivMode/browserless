import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireProxyUrl } from "./proxy-config.js";

describe("requireProxyUrl", () => {
  const original = process.env.OEILI_PROXY_URL;

  beforeEach(() => {
    delete process.env.OEILI_PROXY_URL;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OEILI_PROXY_URL;
    } else {
      process.env.OEILI_PROXY_URL = original;
    }
  });

  it("throws when OEILI_PROXY_URL is unset — prevents silent unproxied egress", () => {
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_URL is required/);
  });

  it("throws when OEILI_PROXY_URL is empty string", () => {
    process.env.OEILI_PROXY_URL = "";
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_URL is required/);
  });

  it("throws when OEILI_PROXY_URL is whitespace-only", () => {
    process.env.OEILI_PROXY_URL = "   ";
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_URL is required/);
  });

  it("throws when OEILI_PROXY_URL is not a valid URL", () => {
    process.env.OEILI_PROXY_URL = "not-a-url";
    expect(() => requireProxyUrl()).toThrow(/not a valid URL/);
  });

  it("returns the URL when set to a valid value", () => {
    process.env.OEILI_PROXY_URL = "https://user:pass@proxy.oeili.com:8443";
    expect(requireProxyUrl()).toBe("https://user:pass@proxy.oeili.com:8443");
  });

  it("trims surrounding whitespace", () => {
    process.env.OEILI_PROXY_URL = "  https://proxy.oeili.com:8443  ";
    expect(requireProxyUrl()).toBe("https://proxy.oeili.com:8443");
  });
});
