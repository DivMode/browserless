/**
 * Turnstile error state monitoring — runs in the browser.
 * Replaces TURNSTILE_ERROR_CHECK_JS template literal.
 *
 * Uses MutationObserver to detect error states in real-time instead of polling.
 */
import type { Emit } from "./types";

function hasToken(): boolean {
  try {
    if (typeof window.turnstile !== "undefined" && window.turnstile?.getResponse) {
      const t = window.turnstile.getResponse();
      if (t && t.length > 0) return true;
    }
  } catch (_) {}
  const inp = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]');
  return !!(inp && inp.value && inp.value.length > 0);
}

function checkErrorState(): { errorType: string; hasToken: boolean } | null {
  const tokenPresent = hasToken();

  // Check container text for error indicators
  const containers = document.querySelectorAll(
    '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]',
  );
  for (const container of containers) {
    const text = (container.textContent || "").toLowerCase();
    if (text.includes("error") || text.includes("failed") || text.includes("try again"))
      return { errorType: tokenPresent ? "error_text" : "confirmed_error", hasToken: tokenPresent };
  }

  // Check iframe content for error indicators
  const cfIframes = document.querySelectorAll<HTMLIFrameElement>(
    'iframe[src*="challenges.cloudflare.com"], iframe[name^="cf-chl-widget"]',
  );
  for (const iframe of cfIframes) {
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body) {
        const iText = (doc.body.textContent || "").toLowerCase();
        if (iText.includes("error") || iText.includes("failed") || iText.includes("try again"))
          return {
            errorType: tokenPresent ? "iframe_error" : "confirmed_error",
            hasToken: tokenPresent,
          };
      }
    } catch (_) {}
  }

  // Check turnstile.isExpired()
  if (typeof window.turnstile !== "undefined" && window.turnstile?.isExpired) {
    try {
      const widgets = document.querySelectorAll('[id^="cf-chl-widget"]');
      for (const w of widgets) {
        if (window.turnstile.isExpired(w.id))
          return { errorType: "expired", hasToken: tokenPresent };
      }
    } catch (_) {}
  }

  return null;
}

export function setupErrorMonitor(emit: Emit): void {
  // Initial check
  const initial = checkErrorState();
  if (initial) emit({ type: "error", ...initial });

  // MutationObserver for real-time error detection
  const targets = document.querySelectorAll(
    '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]',
  );
  if (targets.length === 0) return;

  let lastError: string | null = null;
  const observer = new MutationObserver(() => {
    const err = checkErrorState();
    if (err && err.errorType !== lastError) {
      lastError = err.errorType;
      emit({ type: "error", ...err });
    }
  });

  for (const target of targets) {
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // Also observe for dynamically added turnstile containers
  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const isTurnstile = node.matches?.(
          '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]',
        );
        if (isTurnstile) {
          observer.observe(node, { childList: true, subtree: true, characterData: true });
        }
        const nested = node.querySelectorAll?.(
          '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]',
        );
        if (nested) {
          for (const n of nested) {
            observer.observe(n, { childList: true, subtree: true, characterData: true });
          }
        }
      }
    }
  });
  bodyObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}
