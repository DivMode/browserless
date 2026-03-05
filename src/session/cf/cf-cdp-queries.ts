/**
 * CDP query functions for Cloudflare state checks.
 *
 * Extracted from CloudflareStateTracker for reusability.
 * Each function wraps a single Runtime.evaluate call with typed Effect errors.
 * These don't use tracker state — just sendCommand + cdpSessionId.
 */
import { Effect } from 'effect';
import type { CdpSessionId } from '../../shared/cloudflare-detection.js';
import {
  TURNSTILE_ERROR_CHECK_JS,
  CF_DETECTION_JS,
} from '../../shared/cloudflare-detection.js';
import { CdpSessionGone } from './cf-errors.js';

/** CDP send command — returns any because CDP response shapes vary per method. */
export type SendCommand = (method: string, params?: object, cdpSessionId?: CdpSessionId, timeoutMs?: number) => Promise<any>;

/**
 * Check if the Turnstile widget is solved via Runtime.evaluate on the page session.
 * Safe for embedded types (page is the embedding site, not CF).
 * UNSAFE for interstitials (page IS the CF challenge — triggers WASM detection).
 */
export function isSolvedEffect(sendCommand: SendCommand, cdpSessionId: CdpSessionId): Effect.Effect<boolean, CdpSessionGone> {
  return Effect.tryPromise({
    try: () => sendCommand('Runtime.evaluate', {
      expression: `(function() {
        if (window.__turnstileSolved === true) return true;
        try { if (typeof turnstile !== 'undefined' && turnstile.getResponse && turnstile.getResponse()) return true; } catch(e) {}
        var el = document.querySelector('[name="cf-turnstile-response"]');
        return !!(el && el.value && el.value.length > 0);
      })()`,
      returnByValue: true,
    }, cdpSessionId),
    catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isSolved' }),
  }).pipe(
    Effect.map((result) => result?.result?.value === true),
  );
}

/**
 * Get the Turnstile token via Runtime.evaluate.
 * Checks turnstile.getResponse() and cf-turnstile-response input value.
 */
export function getTokenEffect(sendCommand: SendCommand, cdpSessionId: CdpSessionId): Effect.Effect<string | null, CdpSessionGone> {
  return Effect.tryPromise({
    try: () => sendCommand('Runtime.evaluate', {
      expression: `(() => {
        if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
          try { var t = turnstile.getResponse(); if (t && t.length > 0) return t; } catch(e){}
        }
        var el = document.querySelector('[name="cf-turnstile-response"]');
        if (el && el.value && el.value.length > 0) return el.value;
        return null;
      })()`,
      returnByValue: true,
    }, cdpSessionId),
    catch: (e) => {
      console.error(JSON.stringify({
        message: 'cf.getToken.error',
        session_id: cdpSessionId.slice(0, 8),
        error: e instanceof Error ? e.message : String(e),
      }));
      return new CdpSessionGone({ sessionId: cdpSessionId, method: 'getToken' });
    },
  }).pipe(
    Effect.map((result) => {
      const val = result?.result?.value;
      return typeof val === 'string' && val.length > 0 ? val : null;
    }),
  );
}

/** Check if the Turnstile widget is in an error/expired state. */
export function isWidgetErrorEffect(sendCommand: SendCommand, cdpSessionId: CdpSessionId): Effect.Effect<{ type: string; has_token: boolean } | null, CdpSessionGone> {
  return Effect.tryPromise({
    try: () => sendCommand('Runtime.evaluate', {
      expression: TURNSTILE_ERROR_CHECK_JS,
      returnByValue: true,
    }, cdpSessionId),
    catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isWidgetError' }),
  }).pipe(
    Effect.map((result) => {
      const raw = result?.result?.value;
      if (!raw) return null;
      try { return JSON.parse(raw) || null; } catch { return null; }
    }),
  );
}

/** Re-run CF detection to verify a solve isn't a false positive. */
export function isStillDetectedEffect(sendCommand: SendCommand, cdpSessionId: CdpSessionId): Effect.Effect<boolean, CdpSessionGone> {
  return Effect.tryPromise({
    try: () => sendCommand('Runtime.evaluate', {
      expression: CF_DETECTION_JS,
      returnByValue: true,
    }, cdpSessionId),
    catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isStillDetected' }),
  }).pipe(
    Effect.map((result) => {
      const raw = result?.result?.value;
      if (!raw) return false;
      try { return JSON.parse(raw).detected === true; } catch { return false; }
    }),
  );
}
