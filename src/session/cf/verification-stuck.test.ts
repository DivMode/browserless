/**
 * Tests for verification stuck detection.
 *
 * When the CF solver detects a rendered widget (shadow >= 1) but no checkbox,
 * it must NOT wait the full 60s EMBEDDED_RESOLUTION_TIMEOUT. Instead it must
 * trigger a widget_reload after VERIFICATION_STUCK_TIMEOUT_MS (~20s).
 *
 * These tests verify:
 * 1. VERIFICATION_STUCK_TIMEOUT_MS exists and is correctly bounded
 * 2. The timeout is shorter than the full resolution timeout
 * 3. The timeout is long enough for legitimate non-interactive verification
 */
import { describe, expect, it } from "vitest";
import { VERIFICATION_STUCK_TIMEOUT_MS, EMBEDDED_RESOLUTION_TIMEOUT } from "./cf-schedules.js";

/** Parse Effect Duration.Input string to milliseconds. */
function parseDurationToMs(d: string): number {
  const match = d.match(/^(\d+)\s*(seconds?|millis?)$/);
  if (!match) throw new Error(`Cannot parse duration: ${d}`);
  const [, num, unit] = match;
  return unit.startsWith("second") ? +num * 1000 : +num;
}

describe("VERIFICATION_STUCK_TIMEOUT_MS", () => {
  it("is shorter than EMBEDDED_RESOLUTION_TIMEOUT", () => {
    // If stuck timeout >= resolution timeout, the feature does nothing —
    // stuck verification waits the full 60s, defeating the purpose.
    const embeddedMs = parseDurationToMs(EMBEDDED_RESOLUTION_TIMEOUT);
    expect(VERIFICATION_STUCK_TIMEOUT_MS).toBeLessThan(embeddedMs);
  });

  it("is long enough for legitimate non-interactive verification (>= 15s)", () => {
    // CF non-interactive verification takes 5-15s. Below 15s risks
    // false positive reloads on legitimate verification.
    expect(VERIFICATION_STUCK_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("is 20 seconds", () => {
    // Pinned value — changing this affects solve rate.
    // 20s = enough for CF verification (5-15s) with margin, but catches
    // stuck spinners 40s before the 60s resolution timeout would.
    expect(VERIFICATION_STUCK_TIMEOUT_MS).toBe(20_000);
  });
});
