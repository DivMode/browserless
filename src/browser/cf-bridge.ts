/**
 * CF Bridge — entry point for browser-side Cloudflare monitoring.
 * Compiled by esbuild into an IIFE, pre-injected via
 * Page.addScriptToEvaluateOnNewDocument at session start.
 *
 * Safe on CF challenge pages — isChallengeUrl guard exits immediately
 * with zero DOM/timer side effects (defense-in-depth).
 *
 * Push-based: monitors turnstile state and pushes events to server
 * multiplexed through the existing __rrwebPush binding.
 */
import { detectCF } from './cf-detection';
import { setupTurnstileHooks } from './turnstile-hooks';
import { setupErrorMonitor } from './turnstile-error';
import type { BridgeEvent } from './types';

// ── Buffered emit ─────────────────────────────────────────────────────
// Runtime.addBinding is async — on navigation, the bridge script fires BEFORE
// Chrome registers __rrwebPush in the new execution context. Without buffering,
// solved events are silently dropped (tokenReported=true prevents retry),
// causing 50-60s ghost traces while awaitResolutionRace waits for a signal
// that was lost. Buffer events and flush when the binding appears.
const pendingEvents: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function flushPending(): void {
  while (pendingEvents.length > 0) {
    try { window.__rrwebPush!(pendingEvents.shift()!); } catch (_) {}
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

function emit(event: BridgeEvent): void {
  const payload = JSON.stringify(event);
  if (typeof window.__rrwebPush === 'function') {
    if (pendingEvents.length > 0) flushPending();
    try { window.__rrwebPush(payload); } catch (_) {}
  } else {
    pendingEvents.push(payload);
    if (!flushTimer) {
      flushTimer = setInterval(() => {
        if (typeof window.__rrwebPush === 'function') flushPending();
      }, 50);
      // Stop after 10s — binding should appear within milliseconds
      setTimeout(() => {
        if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      }, 10000);
    }
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

// Two-phase guard for CF challenge pages (interstitials).
//
// Phase 1 (INSTANT): URL pattern check — catches pages with __cf_chl params
// or challenges.cloudflare.com hostname. Zero activity on these pages.
//
// Phase 2 (DEFERRED): _cf_chl_opt check — catches CF challenge pages served
// at the original URL (e.g., 2captcha.com/demo/cloudflare-turnstile-challenge).
// CF sets _cf_chl_opt via inline <script> before DOMContentLoaded. The polling
// loops in setupTurnstileHooks also check _cf_chl_opt and self-abort.
//
// On challenge pages: no hooks, no intervals, no MutationObservers.
// On embedding pages: full bridge (turnstile hooks, detection, error monitor).
const isChallengeUrl = location.href.includes('__cf_chl') ||
  location.hostname === 'challenges.cloudflare.com';

if (!isChallengeUrl) {
  // Start turnstile polling IMMEDIATELY — before DOMContentLoaded.
  // CF's api.js loads async; the 20ms poll catches window.turnstile creation
  // and hooks render()/getResponse() before the page calls render().
  // Polling loops self-abort if _cf_chl_opt is detected (CF challenge page).
  setupTurnstileHooks(emit);

  // Detection + error monitor need DOM — run when ready.
  // Deferred _cf_chl_opt check: CF sets it via inline script before
  // DOMContentLoaded, so by the time this fires, we can detect challenge pages
  // that slipped past the URL guard.
  function initIfSafe(): void {
    if (typeof window._cf_chl_opt !== 'undefined') return;
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfSafe, { once: true });
  } else {
    initIfSafe();
  }
}
