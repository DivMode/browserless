import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentRelayPath, requireProxyUrl } from "./proxy-config.js";

describe("requireProxyUrl", () => {
  const originalLocal = process.env.OEILI_PROXY_LOCAL;
  const originalHetzner = process.env.OEILI_PROXY_URL;

  beforeEach(() => {
    delete process.env.OEILI_PROXY_LOCAL;
    delete process.env.OEILI_PROXY_URL;
  });

  afterEach(() => {
    if (originalLocal === undefined) {
      delete process.env.OEILI_PROXY_LOCAL;
    } else {
      process.env.OEILI_PROXY_LOCAL = originalLocal;
    }
    if (originalHetzner === undefined) {
      delete process.env.OEILI_PROXY_URL;
    } else {
      process.env.OEILI_PROXY_URL = originalHetzner;
    }
  });

  it("throws when neither env var is set — prevents silent unproxied egress", () => {
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_LOCAL or OEILI_PROXY_URL is required/);
  });

  it("throws when both env vars are empty strings", () => {
    process.env.OEILI_PROXY_LOCAL = "";
    process.env.OEILI_PROXY_URL = "";
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_LOCAL or OEILI_PROXY_URL is required/);
  });

  it("throws when LOCAL is whitespace-only and HETZNER is unset", () => {
    process.env.OEILI_PROXY_LOCAL = "   ";
    expect(() => requireProxyUrl()).toThrow(/OEILI_PROXY_LOCAL or OEILI_PROXY_URL is required/);
  });

  it("throws when resolved URL is malformed", () => {
    process.env.OEILI_PROXY_LOCAL = "not-a-url";
    expect(() => requireProxyUrl()).toThrow(/malformed/);
  });

  it("returns OEILI_PROXY_LOCAL when set", () => {
    process.env.OEILI_PROXY_LOCAL = "http://user:pass@192.168.4.200:8080";
    expect(requireProxyUrl()).toBe("http://user:pass@192.168.4.200:8080");
  });

  it("falls back to OEILI_PROXY_URL when only HETZNER is set", () => {
    process.env.OEILI_PROXY_URL = "https://user:pass@proxy.oeili.com:8443";
    expect(requireProxyUrl()).toBe("https://user:pass@proxy.oeili.com:8443");
  });

  it("prefers LOCAL over HETZNER when both are set", () => {
    process.env.OEILI_PROXY_LOCAL = "http://user:pass@192.168.4.200:8080";
    process.env.OEILI_PROXY_URL = "https://user:pass@proxy.oeili.com:8443";
    expect(requireProxyUrl()).toBe("http://user:pass@192.168.4.200:8080");
  });

  it("trims surrounding whitespace", () => {
    process.env.OEILI_PROXY_LOCAL = "  http://192.168.4.200:8080  ";
    expect(requireProxyUrl()).toBe("http://192.168.4.200:8080");
  });
});

describe("currentRelayPath", () => {
  const originalLocal = process.env.OEILI_PROXY_LOCAL;
  const originalHetzner = process.env.OEILI_PROXY_URL;

  beforeEach(() => {
    delete process.env.OEILI_PROXY_LOCAL;
    delete process.env.OEILI_PROXY_URL;
  });

  afterEach(() => {
    if (originalLocal === undefined) {
      delete process.env.OEILI_PROXY_LOCAL;
    } else {
      process.env.OEILI_PROXY_LOCAL = originalLocal;
    }
    if (originalHetzner === undefined) {
      delete process.env.OEILI_PROXY_URL;
    } else {
      process.env.OEILI_PROXY_URL = originalHetzner;
    }
  });

  it("returns 'lan' when LOCAL is set", () => {
    process.env.OEILI_PROXY_LOCAL = "http://192.168.4.200:8080";
    expect(currentRelayPath()).toBe("lan");
  });

  it("returns 'hetzner' when only HETZNER is set", () => {
    process.env.OEILI_PROXY_URL = "https://proxy.oeili.com:8443";
    expect(currentRelayPath()).toBe("hetzner");
  });

  it("returns 'hetzner' (conservative default) when neither is set", () => {
    expect(currentRelayPath()).toBe("hetzner");
  });
});
