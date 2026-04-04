/**
 * CF detection logic — runs in the browser.
 * Replaces CF_DETECTION_JS template literal from cloudflare-detection.ts.
 */

interface DetectionResult {
  detected: boolean;
  method?: string;
  cType?: string;
  cRay?: string;
}

export function detectCF(): DetectionResult {
  // 1. _cf_chl_opt — CF's challenge options object (strongest signal)
  if (typeof window._cf_chl_opt !== "undefined") {
    return {
      detected: true,
      method: "cf_chl_opt",
      cType: window._cf_chl_opt.cType || undefined,
      cRay: window._cf_chl_opt.cRay || undefined,
    };
  }

  // 2. CF interstitial DOM — verified from production rrweb snapshots.
  //    These elements exist ONLY on CF interstitial pages, never on embedded turnstile pages.
  if (
    document.querySelector("#challenge-success-text") ||
    document.querySelector(".ch-title") ||
    document.querySelector("script[data-cf-beacon]")
  )
    return { detected: true, method: "interstitial_dom" };

  // 3. Challenge-running class on <html>
  if (document.documentElement.classList.contains("challenge-running"))
    return { detected: true, method: "challenge_running_class" };

  // 4. Title-based (localized CF interstitial titles)
  const title = (document.title || "").toLowerCase();
  if (
    title.includes("just a moment") ||
    title.includes("momento") ||
    title.includes("un moment") ||
    title.includes("einen moment")
  )
    return { detected: true, method: "title_interstitial" };

  // 5. Body text challenge indicators
  const bodyText = (document.body?.innerText || "").toLowerCase();
  if (
    bodyText.includes("verify you are human") ||
    bodyText.includes("checking your browser") ||
    bodyText.includes("needs to review the security")
  )
    return { detected: true, method: "body_text_challenge" };

  // 6. CF error page — ONLY when interstitial markers are absent.
  //    CF interstitial pages contain .cf-error-details as standard markup.
  if (document.querySelector(".cf-error-details, #cf-error-details")) {
    if (!document.querySelector("#challenge-success-text, .ch-title, .main-wrapper"))
      return { detected: true, method: "cf_error_page" };
  }

  // 7. challenges.cloudflare.com in HTML
  const html = document.documentElement.innerHTML || "";
  if (html.includes("challenges.cloudf")) return { detected: true, method: "challenges_domain" };

  // 8. CF challenge form actions
  const cfForm = document.querySelector(
    'form[action*="__cf_chl_f_tk"], form[action*="__cf_chl_jschl"]',
  );
  if (cfForm) return { detected: true, method: "cf_form_action" };

  // 9. Turnstile script tag
  const tsScript = document.querySelector('script[src*="/turnstile/"]');
  if (tsScript) return { detected: true, method: "turnstile_script" };

  // 10. CF footer with Ray ID
  const footer = (document.querySelector("footer") as HTMLElement)?.innerText || "";
  const footerLower = footer.toLowerCase();
  if (footerLower.includes("ray id") && footerLower.includes("cloudflare"))
    return { detected: true, method: "ray_id_footer" };

  return { detected: false };
}
