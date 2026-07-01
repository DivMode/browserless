import { describe, expect, it } from "vitest";
import { _internal, parseWhoami } from "./relay-whoami.js";

describe("whoamiUrlFromProxy", () => {
  const { whoamiUrlFromProxy, WHOAMI_PORT } = _internal;

  it("derives http://<host>:8081/v1/whoami from the LAN-relay proxy URL", () => {
    expect(whoamiUrlFromProxy("http://oeili-admin:pass@192.168.4.200:8082")).toBe(
      `http://192.168.4.200:${WHOAMI_PORT}/v1/whoami`,
    );
  });

  it("strips credentials and swaps to the admin port", () => {
    const url = whoamiUrlFromProxy("http://user:secret@relay.example.com:8082");
    expect(url).toBe(`http://relay.example.com:${WHOAMI_PORT}/v1/whoami`);
    expect(url).not.toContain("secret");
    expect(url).not.toContain("user");
  });

  it("returns null for unset / empty / whitespace proxy URLs", () => {
    expect(whoamiUrlFromProxy(undefined)).toBeNull();
    expect(whoamiUrlFromProxy("")).toBeNull();
    expect(whoamiUrlFromProxy("   ")).toBeNull();
  });

  it("returns null for an unparseable proxy URL", () => {
    expect(whoamiUrlFromProxy("not a url")).toBeNull();
  });
});

describe("parseWhoami", () => {
  it("parses a full whoami body", () => {
    expect(
      parseWhoami({ phone_id: "pixel-7", carrier: "T-Mobile", cellular_ip: "172.59.57.25" }),
    ).toEqual({ phone_id: "pixel-7", carrier: "T-Mobile", cellular_ip: "172.59.57.25" });
  });

  it("coalesces null carrier / cellular_ip to empty strings (phone hasn't reported yet)", () => {
    expect(parseWhoami({ phone_id: "pixel-10", carrier: null, cellular_ip: null })).toEqual({
      phone_id: "pixel-10",
      carrier: "",
      cellular_ip: "",
    });
  });

  it("coalesces missing carrier / cellular_ip fields to empty strings", () => {
    expect(parseWhoami({ phone_id: "pixel-10" })).toEqual({
      phone_id: "pixel-10",
      carrier: "",
      cellular_ip: "",
    });
  });

  it("returns null when phone_id is missing (no live pin)", () => {
    expect(parseWhoami({ carrier: "T-Mobile", cellular_ip: "172.59.57.25" })).toBeNull();
  });

  it("returns null when phone_id is empty or non-string", () => {
    expect(parseWhoami({ phone_id: "" })).toBeNull();
    expect(parseWhoami({ phone_id: 123 })).toBeNull();
  });

  it("returns null for non-object bodies", () => {
    expect(parseWhoami(null)).toBeNull();
    expect(parseWhoami(undefined)).toBeNull();
    expect(parseWhoami("no live pin for session")).toBeNull();
    expect(parseWhoami([])).toBeNull();
  });
});
