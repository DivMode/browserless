import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetS3ClientForTest,
  r2ClientActive,
  r2Required,
  validateR2Config,
} from "./r2-writer.js";

// Fail-closed config tests (ADR-0093 charter rider). validateR2Config() is the
// startup gate wired into src/index.ts: when R2 is REQUIRED (R2_REQUIRED=1, the
// prod ahrefs path) and any credential var is empty, it MUST throw and name the
// offender — instead of silently nulling the S3 client and dropping every
// scrape result. When R2 is not required (local dev / non-ahrefs / tests), it
// must be a no-op so `just dev` keeps working with zero R2 config.
const R2_ENV_KEYS = [
  "R2_REQUIRED",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

describe("validateR2Config (R2 fail-closed)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of R2_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of R2_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is a no-op when R2 is not required (local dev / non-ahrefs) — returns false", () => {
    // No R2_REQUIRED, no creds — the dev path. Must NOT throw.
    expect(() => validateR2Config()).not.toThrow();
    expect(validateR2Config()).toBe(false);
    expect(r2Required()).toBe(false);
  });

  it("is a no-op when R2_REQUIRED is explicitly '0' even with creds absent", () => {
    process.env.R2_REQUIRED = "0";
    expect(() => validateR2Config()).not.toThrow();
    expect(validateR2Config()).toBe(false);
  });

  it("THROWS (fail-closed) when required but all three creds are missing", () => {
    process.env.R2_REQUIRED = "1";
    expect(() => validateR2Config()).toThrow(/R2 is REQUIRED/);
    // Names every missing var so an operator knows exactly what to set.
    expect(() => validateR2Config()).toThrow(/R2_ACCOUNT_ID/);
    expect(() => validateR2Config()).toThrow(/R2_ACCESS_KEY_ID/);
    expect(() => validateR2Config()).toThrow(/R2_SECRET_ACCESS_KEY/);
    // States the consequence so the failure is self-explanatory.
    expect(() => validateR2Config()).toThrow(/SILENTLY DROPPED/);
  });

  it("THROWS naming ONLY the missing var when creds are partially set", () => {
    process.env.R2_REQUIRED = "1";
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "access-123";
    // R2_SECRET_ACCESS_KEY still missing.
    expect(() => validateR2Config()).toThrow(/R2_SECRET_ACCESS_KEY/);
    expect(() => validateR2Config()).not.toThrow(/R2_ACCOUNT_ID/);
    expect(() => validateR2Config()).not.toThrow(/R2_ACCESS_KEY_ID/);
  });

  it("THROWS when a required cred is present but only whitespace (empty after trim)", () => {
    process.env.R2_REQUIRED = "1";
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "access-123";
    process.env.R2_SECRET_ACCESS_KEY = "   ";
    expect(() => validateR2Config()).toThrow(/R2_SECRET_ACCESS_KEY/);
  });

  it("PASSES (returns true) when required and all three creds are present — normal prod path", () => {
    process.env.R2_REQUIRED = "1";
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "access-123";
    process.env.R2_SECRET_ACCESS_KEY = "secret-123";
    expect(() => validateR2Config()).not.toThrow();
    expect(validateR2Config()).toBe(true);
    expect(r2Required()).toBe(true);
  });
});

describe("r2ClientActive (S3 writer construction)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of R2_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    __resetS3ClientForTest();
  });

  afterEach(() => {
    for (const key of R2_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    __resetS3ClientForTest();
  });

  it("constructs the S3 client (writer live) when all three creds are present", () => {
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "access-123";
    process.env.R2_SECRET_ACCESS_KEY = "secret-123";
    expect(r2ClientActive()).toBe(true);
  });

  it("does NOT construct the client (no-op writer) when creds are absent", () => {
    expect(r2ClientActive()).toBe(false);
  });

  it("does NOT construct the client when a single cred is missing", () => {
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "access-123";
    // R2_SECRET_ACCESS_KEY missing
    expect(r2ClientActive()).toBe(false);
  });
});
