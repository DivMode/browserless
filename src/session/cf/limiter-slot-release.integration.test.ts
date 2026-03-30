/**
 * Limiter slot release test.
 *
 * CRITICAL PROPERTY: When a client disconnects, the limiter slot MUST be
 * freed within 2 seconds. If ANY code blocks handleClose → onClose,
 * the slot is held and 429s follow.
 *
 * Incident 2026-03-29: onBeforeClose (75s replay flush) was added before
 * onClose in handleClose. With 15 slots, production hit 429s in minutes.
 *
 * This test catches that class of bug: connect, disconnect, verify the
 * running count drops back within 2 seconds.
 */
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { BROWSERLESS_HTTP } from "./integration-helpers";

/** Fetch pressure endpoint and return running count. */
async function getRunning(): Promise<number> {
  const res = await fetch(`${BROWSERLESS_HTTP}/pressure`);
  const body = (await res.json()) as { pressure: { running: number } };
  return body.pressure.running;
}

/** Poll until condition is true, or timeout. */
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe("Limiter Slot Release", () => {
  it("frees limiter slot within 2s of client disconnect", async () => {
    const beforeRunning = await getRunning();

    // Connect a browser session (takes a limiter slot)
    const httpUrl = new URL(BROWSERLESS_HTTP);
    const wsUrl = `ws://${httpUrl.host}/chromium?headless=true&timeout=60000`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    });

    // Verify slot was taken
    const duringRunning = await getRunning();
    expect(duringRunning, "Connecting a session should increase running count").toBeGreaterThan(
      beforeRunning,
    );

    // Disconnect — close the WebSocket
    ws.close();

    // CRITICAL ASSERTION: limiter slot must free within 2 seconds.
    // If handleClose blocks on replay flush or any other work before
    // calling onClose, this test fails.
    const freed = await pollUntil(async () => (await getRunning()) < duringRunning, 2000);

    expect(
      freed,
      `Limiter slot NOT freed within 2s of disconnect. ` +
        `During: ${duringRunning}, After: ${await getRunning()}. ` +
        `Something is blocking handleClose → onClose (check CDPProxy.handleClose).`,
    ).toBe(true);
  }, 15_000);
});
