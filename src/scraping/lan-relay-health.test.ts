import { describe, expect, it } from "vitest";
import { _internal, decideRelayPath, rosterIsHealthy } from "./lan-relay-health.js";

describe("rosterIsHealthy", () => {
  it("returns true for a non-empty roster with at least one fresh phone", () => {
    expect(rosterIsHealthy([{ last_announce_seconds_ago: 5 }])).toBe(true);
  });

  it("returns true when ONE of several phones is fresh (others stale)", () => {
    expect(
      rosterIsHealthy([
        { last_announce_seconds_ago: 500 },
        { last_announce_seconds_ago: 10 },
        { last_announce_seconds_ago: 9999 },
      ]),
    ).toBe(true);
  });

  it("treats a phone exactly at the freshness boundary as STALE (strict <)", () => {
    expect(
      rosterIsHealthy([{ last_announce_seconds_ago: _internal.FRESH_ANNOUNCE_MAX_SECONDS }]),
    ).toBe(false);
    expect(
      rosterIsHealthy([{ last_announce_seconds_ago: _internal.FRESH_ANNOUNCE_MAX_SECONDS - 1 }]),
    ).toBe(true);
  });

  it("returns false for an empty array (roster = 0 phones — the dead-relay case)", () => {
    expect(rosterIsHealthy([])).toBe(false);
  });

  it("returns false when every phone is stale", () => {
    expect(
      rosterIsHealthy([{ last_announce_seconds_ago: 200 }, { last_announce_seconds_ago: 9999 }]),
    ).toBe(false);
  });

  it("returns false for non-array bodies", () => {
    expect(rosterIsHealthy(null)).toBe(false);
    expect(rosterIsHealthy(undefined)).toBe(false);
    expect(rosterIsHealthy({})).toBe(false);
    expect(rosterIsHealthy("not-an-array")).toBe(false);
    expect(rosterIsHealthy(42)).toBe(false);
    expect(rosterIsHealthy({ last_announce_seconds_ago: 1 })).toBe(false);
  });

  it("ignores roster entries missing or with non-numeric last_announce_seconds_ago", () => {
    expect(rosterIsHealthy([{ phone_id: "abc" }])).toBe(false);
    expect(rosterIsHealthy([{ last_announce_seconds_ago: "5" }])).toBe(false);
    expect(rosterIsHealthy([null])).toBe(false);
    // A malformed entry alongside a fresh one still counts as healthy.
    expect(rosterIsHealthy([{ phone_id: "abc" }, { last_announce_seconds_ago: 3 }])).toBe(true);
  });
});

describe("decideRelayPath", () => {
  // Exhaustive over hasLocal × hasHetzner × lanHealthy.

  it("lan + hetzner + healthy → lan (LAN preferred when healthy)", () => {
    expect(decideRelayPath({ hasLocal: true, hasHetzner: true, lanHealthy: true })).toBe("lan");
  });

  it("lan + hetzner + UNhealthy → hetzner (the failover case)", () => {
    expect(decideRelayPath({ hasLocal: true, hasHetzner: true, lanHealthy: false })).toBe(
      "hetzner",
    );
  });

  it("lan + no hetzner + healthy → lan", () => {
    expect(decideRelayPath({ hasLocal: true, hasHetzner: false, lanHealthy: true })).toBe("lan");
  });

  it("lan + no hetzner + UNhealthy → lan (no fallback; dead LAN beats no proxy)", () => {
    expect(decideRelayPath({ hasLocal: true, hasHetzner: false, lanHealthy: false })).toBe("lan");
  });

  it("no lan + hetzner + healthy → hetzner (Hetzner-only config)", () => {
    expect(decideRelayPath({ hasLocal: false, hasHetzner: true, lanHealthy: true })).toBe(
      "hetzner",
    );
  });

  it("no lan + hetzner + UNhealthy → hetzner (lanHealthy irrelevant without LOCAL)", () => {
    expect(decideRelayPath({ hasLocal: false, hasHetzner: true, lanHealthy: false })).toBe(
      "hetzner",
    );
  });

  it("no lan + no hetzner + healthy → undefined", () => {
    expect(decideRelayPath({ hasLocal: false, hasHetzner: false, lanHealthy: true })).toBe(
      undefined,
    );
  });

  it("no lan + no hetzner + UNhealthy → undefined", () => {
    expect(decideRelayPath({ hasLocal: false, hasHetzner: false, lanHealthy: false })).toBe(
      undefined,
    );
  });
});

describe("rosterUrlFromProxy", () => {
  it("derives http://<host>:8081/v1/phones from a proxy URL with creds", () => {
    expect(_internal.rosterUrlFromProxy("http://oeili-admin:secret@192.168.4.200:8082")).toBe(
      `http://192.168.4.200:${_internal.ROSTER_PORT}/v1/phones`,
    );
  });

  it("strips credentials and rewrites the port", () => {
    expect(_internal.rosterUrlFromProxy("https://user:pass@relay.example.com:8443")).toBe(
      `http://relay.example.com:${_internal.ROSTER_PORT}/v1/phones`,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(_internal.rosterUrlFromProxy("  http://192.168.4.200:8082  ")).toBe(
      `http://192.168.4.200:${_internal.ROSTER_PORT}/v1/phones`,
    );
  });

  it("returns null for unset / empty / whitespace-only / malformed proxy URLs", () => {
    expect(_internal.rosterUrlFromProxy(undefined)).toBeNull();
    expect(_internal.rosterUrlFromProxy("")).toBeNull();
    expect(_internal.rosterUrlFromProxy("   ")).toBeNull();
    expect(_internal.rosterUrlFromProxy("not-a-url")).toBeNull();
  });
});

describe("getLanRelayHealthy default", () => {
  it("defaults to true after reset (never fails over before the first probe)", () => {
    _internal.resetHealth();
    // Imported lazily to avoid coupling the assertion to a stale module binding.
    return import("./lan-relay-health.js").then(({ getLanRelayHealthy }) => {
      expect(getLanRelayHealthy()).toBe(true);
    });
  });
});
