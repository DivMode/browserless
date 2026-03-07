/**
 * CF Bridge — entry point for browser-side Cloudflare monitoring.
 * Compiled by esbuild into an IIFE, injected via Runtime.evaluate on
 * EMBEDDING pages only (after detector confirms embedded turnstile type).
 *
 * NEVER runs on CF challenge pages — injection is server-controlled.
 * The URL guard below is defense-in-depth only.
 *
 * Push-based: monitors turnstile state and pushes events to server
 * multiplexed through the existing __rrwebPush binding.
 */
import { detectCF } from './cf-detection';
import { setupTurnstileHooks } from './turnstile-hooks';
import { setupErrorMonitor } from './turnstile-error';
import type { BridgeEvent } from './types';

function emit(event: BridgeEvent): void {
  // Multiplex through rrweb binding — avoids adding a new detectable binding.
  // Server distinguishes bridge events (object with type) from rrweb batches (array).
  if (typeof window.__rrwebPush === 'function') {
    try {
      window.__rrwebPush(JSON.stringify(event));
    } catch (_) {}
  }
}

/** DOM-dependent init: detection + error monitor. Runs once on DOMContentLoaded. */
function init(): void {
  const detection = detectCF();
  if (detection.detected) {
    emit({
      type: 'detected',
      method: detection.method!,
      cType: detection.cType,
      cRay: detection.cRay,
    });
  }
  setupErrorMonitor(emit);
}

// Zero-activity guard for CF challenge pages (interstitials).
// URL check is INSTANT — no timing dependency on _cf_chl_opt.
// CF challenge URLs contain '__cf_chl' (e.g., __cf_chl_rt_tk=...).
// On challenge pages: no intervals, no listeners, no bridge activity.
// On embedding pages: full bridge (turnstile hooks, detection, error monitor).
const isChallengeUrl = location.href.includes('__cf_chl') ||
  location.hostname === 'challenges.cloudflare.com';

if (!isChallengeUrl) {
  // Start turnstile polling IMMEDIATELY — before DOMContentLoaded.
  // CF's api.js loads async; the 20ms poll catches window.turnstile creation
  // and hooks render()/getResponse() before the page calls render().
  setupTurnstileHooks(emit);

  // Detection + error monitor need DOM — run when ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
