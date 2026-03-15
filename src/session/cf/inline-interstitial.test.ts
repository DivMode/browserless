/**
 * Unit tests for isCFInterstitialTitle — the zero-injection inline interstitial detector.
 *
 * When CF serves an interstitial at the site's own URL (no __cf_chl_* tokens),
 * the page title is the only signal to distinguish it from an embedded Turnstile.
 * Misclassification → Runtime.evaluate on CF challenge page → session poisoned → no_resolution.
 */
import { describe, expect, it } from "vitest";
import { isCFInterstitialTitle } from "../../shared/cloudflare-detection.js";

describe("isCFInterstitialTitle", () => {
  it.each([
    "Just a moment...",
    "Just a moment",
    "Attention Required! | Cloudflare",
    "Attention Required",
    "Checking your browser before accessing example.com",
    "Checking your browser",
    "One more step",
    "One more step | example.com",
  ])("detects CF title: %s", (title) => {
    expect(isCFInterstitialTitle(title)).toBe(true);
  });

  it.each([
    "Example Page",
    "Just kidding",
    "Checkout",
    "",
    "oyvana.com",
    "Verifying", // Ahrefs loading state — NOT CF
    "Dashboard - Admin",
    "Google",
  ])("rejects non-CF title: %s", (title) => {
    expect(isCFInterstitialTitle(title)).toBe(false);
  });
});
