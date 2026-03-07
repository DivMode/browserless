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
  if (typeof window._cf_chl_opt !== 'undefined') {
    return {
      detected: true,
      method: 'cf_chl_opt',
      cType: window._cf_chl_opt.cType || undefined,
      cRay: window._cf_chl_opt.cRay || undefined,
    };
  }

  const challengeEl = document.querySelector(
    '#challenge-form, #challenge-stage, #challenge-running',
  );
  if (challengeEl) return { detected: true, method: 'challenge_element' };

  if (document.documentElement.classList.contains('challenge-running'))
    return { detected: true, method: 'challenge_running_class' };

  const title = (document.title || '').toLowerCase();
  if (
    title.includes('just a moment') ||
    title.includes('momento') ||
    title.includes('un moment') ||
    title.includes('einen moment')
  )
    return { detected: true, method: 'title_interstitial' };

  const bodyText = (document.body?.innerText || '').toLowerCase();
  if (
    bodyText.includes('verify you are human') ||
    bodyText.includes('checking your browser') ||
    bodyText.includes('needs to review the security')
  )
    return { detected: true, method: 'body_text_challenge' };

  if (document.querySelector('.cf-error-details, #cf-error-details'))
    return { detected: true, method: 'cf_error_page' };

  const html = document.documentElement.innerHTML || '';
  if (html.includes('challenges.cloudf'))
    return { detected: true, method: 'challenges_domain' };

  const cfForm = document.querySelector(
    'form[action*="__cf_chl_f_tk"], form[action*="__cf_chl_jschl"]',
  );
  if (cfForm) return { detected: true, method: 'cf_form_action' };

  const tsScript = document.querySelector('script[src*="/turnstile/"]');
  if (tsScript) return { detected: true, method: 'turnstile_script' };

  if (document.querySelector('#challenge-success-text'))
    return { detected: true, method: 'challenge_success' };

  const footer = (document.querySelector('footer') as HTMLElement)?.innerText || '';
  const footerLower = footer.toLowerCase();
  if (footerLower.includes('ray id') && footerLower.includes('cloudflare'))
    return { detected: true, method: 'ray_id_footer' };

  return { detected: false };
}
