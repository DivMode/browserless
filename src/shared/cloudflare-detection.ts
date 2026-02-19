/**
 * Types and detection scripts for Cloudflare monitoring.
 * JS constants are injected into pages via CDP Runtime.evaluate.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Cloudflare Turnstile — Official Widget Modes
 * https://developers.cloudflare.com/turnstile/concepts/widget/
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. MANAGED (recommended by CF)
 *    Automatically chooses between showing a checkbox or auto-passing
 *    based on visitor risk level. Only prompts interaction when CF
 *    thinks it's necessary.
 *
 * 2. NON-INTERACTIVE
 *    Displays a visible widget with a loading spinner. Runs challenges
 *    in the browser without ever requiring the visitor to click anything.
 *
 * 3. INVISIBLE
 *    Completely hidden. No widget, no spinner, no visual element.
 *    Challenges run entirely in the background.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Our Internal Types
 * ═══════════════════════════════════════════════════════════════════════
 *
 * CloudflareType        │ Official Mode    │ Source                     │ Needs Click?
 * ──────────────────────┼──────────────────┼────────────────────────────┼─────────────
 * 'managed'             │ Managed          │ _cf_chl_opt.cType          │ Usually yes
 * 'non_interactive'     │ Non-Interactive   │ _cf_chl_opt.cType          │ No (auto-solves)
 * 'invisible'           │ Invisible         │ _cf_chl_opt.cType          │ No (auto-solves)
 * 'interstitial'        │ (any — unknown)   │ Title/DOM/body heuristics  │ Yes (challenge page)
 * 'turnstile'           │ (any — unknown)   │ Iframe/runtime poll        │ Try click, may auto-solve
 * 'block'               │ N/A              │ CF error page DOM          │ Not solvable
 *
 * cType is available in most cases (CF interstitial pages always have _cf_chl_opt).
 * 'turnstile' is the fallback for third-party pages where Turnstile is embedded
 * but _cf_chl_opt is not exposed — we know a widget exists but not its mode.
 */
export type CloudflareType =
  | 'managed'          // Official: Managed — may need click, may auto-pass
  | 'non_interactive'  // Official: Non-Interactive — auto-solves, spinner visible
  | 'invisible'        // Official: Invisible — auto-solves, nothing visible
  | 'interstitial'     // CF challenge page (mode unknown, no cType available)
  | 'turnstile'        // Turnstile iframe found but no cType (third-party embed, mode unknown)
  | 'block';           // CF error page — not solvable

export interface CloudflareInfo {
  type: CloudflareType;
  url: string;
  iframeUrl?: string;
  cType?: string;
  cRay?: string;
  detectionMethod: string;
  pollCount?: number;
}

export interface CloudflareConfig {
  /** Max attempts per CF detection (default: 3) */
  maxAttempts?: number;
  /** Timeout per attempt in ms (default: 30000) */
  attemptTimeout?: number;
  /** Enable recording markers (default: true) */
  recordingMarkers?: boolean;
}

export interface CloudflareResult {
  solved: boolean;
  type: CloudflareType;
  method: string;
  token?: string;
  token_length?: number;
  duration_ms: number;
  attempts: number;
  auto_resolved?: boolean;
  signal?: string;
}

/** Accumulated state for one CF solve phase, included in solved/failed events. */
export interface CloudflareSnapshot {
  detection_method: string | null;
  cf_cray: string | null;
  detection_poll_count: number;
  widget_found: boolean;
  widget_find_method: string | null;
  widget_find_methods: string[];
  widget_x: number | null;
  widget_y: number | null;
  clicked: boolean;
  click_count: number;
  click_x: number | null;
  click_y: number | null;
  presence_duration_ms: number;
  presence_phases: number;
  approach_phases: number;
  activity_poll_count: number;
  false_positive_count: number;
  widget_error_count: number;
  iframe_states: string[];
  widget_find_debug: Record<string, unknown> | null;
  widget_error_type: string | null;
}

/**
 * JS hook that wraps turnstile.render() to detect auto-solves.
 * Sets window.__turnstileSolved = true when callback fires.
 * Polls for late-arriving turnstile object (up to 30s).
 *
 * Source: pydoll-scraper/src/evasion/turnstile.py lines 76-133
 */
export const TURNSTILE_CALLBACK_HOOK_JS = `(function() {
    window.__turnstileSolved = false;
    window.__turnstileRenderParams = null;
    window.__turnstileRenderTime = null;
    window.__turnstileTokenLength = null;
    window.__turnstileWidgetId = null;

    function wrapRender(ts) {
        if (!ts || !ts.render || ts.__cbHooked) return;
        var orig = ts.render;
        ts.render = function(container, params) {
            params = params || {};
            window.__turnstileRenderTime = Date.now();
            window.__turnstileRenderParams = {
                sitekey: (params.sitekey || '').substring(0, 20),
                action: params.action || null,
                size: params.size || 'normal',
                appearance: params.appearance || null,
                theme: params.theme || 'auto'
            };

            if (typeof params.callback === 'function') {
                var origCb = params.callback;
                params.callback = function(token) {
                    window.__turnstileSolved = true;
                    window.__turnstileTokenLength = token ? token.length : 0;
                    if (typeof window.__turnstileSolvedBinding === 'function') {
                        try { window.__turnstileSolvedBinding('solved'); } catch(e) {}
                    }
                    return origCb.apply(this, arguments);
                };
            } else {
                params.callback = function(token) {
                    window.__turnstileSolved = true;
                    window.__turnstileTokenLength = token ? token.length : 0;
                    if (typeof window.__turnstileSolvedBinding === 'function') {
                        try { window.__turnstileSolvedBinding('solved'); } catch(e) {}
                    }
                };
            }

            var widgetId = orig.apply(this, arguments);
            window.__turnstileWidgetId = widgetId || null;
            return widgetId;
        };
        ts.__cbHooked = true;
    }

    if (window.turnstile) wrapRender(window.turnstile);
    var _pollId = setInterval(function() {
        if (window.turnstile && !window.turnstile.__cbHooked) {
            wrapRender(window.turnstile);
            clearInterval(_pollId);
        }
    }, 20);
    setTimeout(function() { clearInterval(_pollId); }, 30000);
})();`;

/**
 * JS detection script for Cloudflare-protected pages.
 * Checks _cf_chl_opt, #challenge-form (CF DOM element), title, body text.
 *
 * Source: pydoll-scraper/src/evasion/cloudflare.py lines 37-111
 */
export const CF_DETECTION_JS = `JSON.stringify((() => {
    if (typeof window._cf_chl_opt !== 'undefined') {
        return {
            detected: true,
            method: 'cf_chl_opt',
            cType: window._cf_chl_opt.cType || null,
            cRay: window._cf_chl_opt.cRay || null
        };
    }
    var challengeEl = document.querySelector('#challenge-form, #challenge-stage, #challenge-running');
    if (challengeEl) return { detected: true, method: 'challenge_element' };
    if (document.documentElement.classList.contains('challenge-running'))
        return { detected: true, method: 'challenge_running_class' };
    var title = (document.title || '').toLowerCase();
    if (title.includes('just a moment') || title.includes('momento') ||
        title.includes('un moment') || title.includes('einen moment'))
        return { detected: true, method: 'title_interstitial' };
    var bodyText = (document.body?.innerText || '').toLowerCase();
    if (bodyText.includes('verify you are human') ||
        bodyText.includes('checking your browser') ||
        bodyText.includes('needs to review the security'))
        return { detected: true, method: 'body_text_challenge' };
    if (document.querySelector('.cf-error-details, #cf-error-details'))
        return { detected: true, method: 'cf_error_page' };
    var footer = (document.querySelector('footer') || {}).innerText || '';
    var footerLower = footer.toLowerCase();
    if (footerLower.includes('ray id') && footerLower.includes('cloudflare'))
        return { detected: true, method: 'ray_id_footer' };
    return { detected: false };
})())`;

/**
 * JS to extract Turnstile token via turnstile.getResponse().
 *
 * Source: pydoll-scraper/src/evasion/turnstile.py lines 136-141
 */
export const TURNSTILE_TOKEN_JS = `(() => {
    if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
        try { var t = turnstile.getResponse(); if (t && t.length > 0) return t; } catch(e){}
    }
    return null;
})()`;

/**
 * Map detection results to CloudflareType.
 *
 * CF_DETECTION_JS (lines 136-164) returns one of these detection methods:
 *
 *   DETECTION METHOD          │ WHAT IT CHECKS                                      │ HAS cType?
 *   ──────────────────────────┼─────────────────────────────────────────────────────┼───────────
 *   cf_chl_opt                │ window._cf_chl_opt exists                           │ YES
 *   challenge_element         │ #challenge-form, #challenge-stage, #challenge-running│ No
 *   challenge_running_class   │ html.challenge-running CSS class                     │ No
 *   title_interstitial        │ Title: "just a moment", "momento", etc.              │ No
 *   body_text_challenge       │ Body: "verify you are human", etc.                   │ No
 *   cf_error_page             │ .cf-error-details, #cf-error-details                 │ No
 *   ray_id_footer             │ Footer contains "ray id" + "cloudflare"              │ No
 *
 * Additional sources (not from CF_DETECTION_JS):
 *   runtime_poll              │ JS poll finds turnstile on page (set in solver)       │ No
 *   hasTurnstileIframe        │ challenges.cloudflare.com iframe present (separate)   │ No
 */
export function detectCloudflareType(
  _pageUrl: string,
  detectionResult: { detected: boolean; method?: string; cType?: string },
  hasTurnstileIframe: boolean,
): CloudflareType | null {
  if (!detectionResult.detected) return null;
  const cType = detectionResult.cType;

  // ── _cf_chl_opt exists → use CF's own mode classification ──
  if (cType === 'managed' || cType === 'interactive') return 'managed';
  if (cType === 'non-interactive') return 'non_interactive';
  if (cType === 'invisible') return 'invisible';

  // ── No _cf_chl_opt → classify by detection method ──

  // CF challenge pages (full-page "Just a moment..." interstitials)
  if (detectionResult.method === 'title_interstitial') return 'interstitial';
  if (detectionResult.method === 'body_text_challenge') return 'interstitial';
  if (detectionResult.method === 'challenge_element') return 'interstitial';
  if (detectionResult.method === 'challenge_running_class') return 'interstitial';

  // CF error pages (1006, 1015, etc.) — not solvable
  if (detectionResult.method === 'cf_error_page') return 'block';

  // Soft CF indicator with visible Turnstile → standalone widget
  // Without Turnstile → interstitial (CF page without standard markers)
  if (detectionResult.method === 'ray_id_footer') {
    return hasTurnstileIframe ? 'turnstile' : 'interstitial';
  }

  // Turnstile iframe on non-CF page → standalone widget (mode unknown)
  if (hasTurnstileIframe) return 'turnstile';

  // Fallback: detected but no specific method matched
  return 'interstitial';
}

/**
 * MutationObserver script for Turnstile iframe state tracking.
 * Watches #success, #verifying, #fail visibility changes.
 * Relays state via __turnstileStateBinding CDP binding.
 *
 * Extracted from replay-coordinator.ts inline stateScript.
 */
export const TURNSTILE_STATE_OBSERVER_JS = `(function(){
  if (window.__turnstileStateObserved) return;
  window.__turnstileStateObserved = true;
  var states = ['success','verifying','fail','expired','timeout'];
  function check() {
    for (var i=0; i<states.length; i++) {
      var el = document.getElementById(states[i]);
      if (el && getComputedStyle(el).display !== 'none') return states[i];
    }
    return 'idle';
  }
  var last = '';
  var observer = new MutationObserver(function() {
    var current = check();
    if (current !== last) {
      last = current;
      try { window.__turnstileStateBinding(current); } catch(e) {}
    }
  });
  var attempts = 0;
  function start() {
    var root = document.getElementById('content') || (attempts >= 5 ? document.body : null);
    if (root) {
      observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['style'] });
      var s = check();
      if (s !== last) { last = s; try { window.__turnstileStateBinding(s); } catch(e) {} }
    } else {
      attempts++;
      if (attempts < 20) setTimeout(start, 100);
    }
  }
  start();
})()`;

/**
 * Unified 12-method priority cascade for finding Turnstile click targets.
 * Returns JSON string: {x, y, m} where m = detection method name, or null.
 *
 * Methods 0-5 run on all pages (safe for embedded + interstitial).
 * Methods 6-9 gated behind _cf_chl_opt (interstitial-only, more aggressive).
 *
 * Source: pydoll-scraper/src/evasion/turnstile_scripts.py
 */
export const FIND_CLICK_TARGET_JS = `JSON.stringify((() => {
  var vis = function(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    void el.offsetHeight;
    return el.getBoundingClientRect();
  };
  var debug = function() {
    var ifs = document.querySelectorAll('iframe');
    var ifl = [];
    for (var k = 0; k < ifs.length && k < 10; k++) {
      var r = ifs[k].getBoundingClientRect();
      ifl.push({ w: Math.round(r.width), h: Math.round(r.height), src: (ifs[k].src || '').substring(0, 40) });
    }
    return {
      iframes: ifl,
      ts_els: document.querySelectorAll('[class*="cf-turnstile"], [data-sitekey], [name="cf-turnstile-response"], [id^="cf-chl-widget"]').length,
      forms: document.querySelectorAll('form').length,
      shadow_hosts: document.querySelectorAll('div:not(:has(*))').length,
      is_interstitial: typeof window._cf_chl_opt !== 'undefined',
      title: (document.title || '').substring(0, 50)
    };
  };
  var hit = function(r, m) { return { x: r.x + 30, y: r.y + r.height / 2, m: m, d: debug() }; };
  var iframes = document.querySelectorAll('iframe');
  var i, rect, src, name, el, style;

  // --- Method 0: iframe by src ---
  for (i = 0; i < iframes.length; i++) {
    src = iframes[i].src || '';
    if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) {
      rect = vis(iframes[i]);
      if (rect.width > 0 && rect.height > 0) return hit(rect, 'iframe-src');
    }
  }

  // --- Method 0b: iframe by name ---
  for (i = 0; i < iframes.length; i++) {
    name = iframes[i].name || '';
    if (name.indexOf('cf-chl-widget') === 0) {
      rect = vis(iframes[i]);
      if (rect.width > 0 && rect.height > 0) return hit(rect, 'iframe-name');
    }
  }

  // --- Method 0c: iframes/bordered boxes inside challenge containers ---
  var containers = document.querySelectorAll(
    '#challenge-stage, #challenge-running, #challenge-form, [id*="challenge"], .challenge-running'
  );
  for (i = 0; i < containers.length; i++) {
    var cIframes = containers[i].querySelectorAll('iframe');
    for (var j = 0; j < cIframes.length; j++) {
      rect = vis(cIframes[j]);
      if (rect.width > 50 && rect.height > 50 && rect.x > 0 && rect.y > 0)
        return hit(rect, 'challenge-container-iframe');
    }
    var cDivs = containers[i].querySelectorAll('div');
    for (var j = 0; j < cDivs.length; j++) {
      rect = cDivs[j].getBoundingClientRect();
      style = window.getComputedStyle(cDivs[j]);
      if (rect.width >= 280 && rect.width <= 450 &&
          rect.height >= 50 && rect.height <= 100 &&
          rect.x > 0 && rect.y > 0 &&
          (style.borderWidth !== '0px' || style.boxShadow !== 'none')) {
        rect = vis(cDivs[j]);
        return hit(rect, 'challenge-bordered-box');
      }
    }
  }

  // --- Method 1: cf-turnstile-response input parent (strict dimensions) ---
  var inputs = document.querySelectorAll('[name="cf-turnstile-response"]');
  for (i = 0; i < inputs.length; i++) {
    el = inputs[i].parentElement;
    for (var d = 0; d < 10 && el; d++) {
      rect = el.getBoundingClientRect();
      if (rect.width > 290 && rect.width <= 310 &&
          rect.height > 55 && rect.height <= 85 &&
          rect.x > 0 && rect.y > 0) {
        rect = vis(el);
        return hit(rect, 'response-input-parent');
      }
      el = el.parentElement;
    }
  }

  // --- Method 1b: cf-turnstile-response input ancestor (relaxed) ---
  for (i = 0; i < inputs.length; i++) {
    el = inputs[i].parentElement;
    for (var d = 0; d < 10 && el && el !== document.body; d++) {
      rect = el.getBoundingClientRect();
      if (rect.width >= 200 && rect.height >= 40 && rect.x >= 0 && rect.y >= 0) {
        rect = vis(el);
        return hit(rect, 'response-input-ancestor');
      }
      el = el.parentElement;
    }
  }

  // --- Method 2: iframe with Turnstile dimensions ---
  for (i = 0; i < iframes.length; i++) {
    rect = iframes[i].getBoundingClientRect();
    if (rect.width > 290 && rect.width <= 310 &&
        rect.height > 55 && rect.height <= 85 &&
        rect.x > 0 && rect.y > 0) {
      rect = vis(iframes[i]);
      return hit(rect, 'iframe-dimensions');
    }
  }

  // --- Method 2b: .cf-turnstile-wrapper ---
  var wrappers = document.querySelectorAll('.cf-turnstile-wrapper, [class*="cf-turnstile"]');
  for (i = 0; i < wrappers.length; i++) {
    wrappers[i].style.width = '300px';
    rect = vis(wrappers[i]);
    if (rect.width > 50 && rect.height > 50 && rect.x > 0 && rect.y > 0)
      return hit(rect, 'cf-turnstile-wrapper');
  }

  // --- Shadow host helpers ---
  var findShadowHosts = function(container, method) {
    var results = [];
    var divs = container.querySelectorAll('div');
    for (var k = 0; k < divs.length; k++) {
      var r = divs[k].getBoundingClientRect();
      var isNormal = r.width >= 290 && r.width <= 310 && r.height >= 50 && r.height <= 80;
      var isCompact = r.width >= 140 && r.width <= 160 && r.height >= 130 && r.height <= 150;
      var isWide = r.width >= 250 && r.width <= 400 && r.height >= 50 && r.height <= 200;
      if ((isNormal || isCompact || isWide) && !divs[k].querySelector('*') && r.x > 0 && r.y > 0) {
        var s = window.getComputedStyle(divs[k]);
        results.push({ div: divs[k], rect: r, method: method, clean: s.margin === '0px' && s.padding === '0px' });
      }
    }
    return results;
  };
  var pickBest = function(hosts) {
    if (hosts.length === 0) return null;
    var clean = hosts.filter(function(h) { return h.clean; });
    var cands = clean.length > 0 ? clean : hosts;
    if (cands.length === 1) {
      var r = vis(cands[0].div);
      return hit(r, cands[0].method + (clean.length > 0 ? '-clean' : ''));
    }
    for (var k = 0; k < cands.length; k++) {
      var p = cands[k].div.parentElement;
      if (p) {
        var pr = p.getBoundingClientRect();
        if (pr.width >= cands[k].rect.width && pr.width <= cands[k].rect.width + 50) {
          var r = vis(cands[k].div);
          return hit(r, cands[k].method + '-parent-match');
        }
      }
    }
    var r = vis(cands[cands.length - 1].div);
    return hit(r, cands[cands.length - 1].method + '-last');
  };

  // --- Method 3: .cf-turnstile[data-sitekey] shadow host ---
  var cfTs = document.querySelector('.cf-turnstile[data-sitekey]');
  if (cfTs) {
    cfTs.style.width = '300px';
    var best = pickBest(findShadowHosts(cfTs, 'cf-turnstile-sitekey'));
    if (best) return best;
  }

  // --- Method 4: any [data-sitekey] shadow host ---
  var sitekeys = document.querySelectorAll('[data-sitekey]');
  for (i = 0; i < sitekeys.length; i++) {
    var best = pickBest(findShadowHosts(sitekeys[i], 'data-sitekey'));
    if (best) return best;
  }

  // --- Method 5: shadow host inside <form> (critical for Ahrefs embedded) ---
  var forms = document.querySelectorAll('form');
  for (i = 0; i < forms.length; i++) {
    var best = pickBest(findShadowHosts(forms[i], 'form-shadow-host'));
    if (best) return best;
  }

  // --- Methods 6-9: Interstitial-only (gated behind _cf_chl_opt) ---
  if (typeof window._cf_chl_opt !== 'undefined') {

    // --- Method 6: any shadow host on body ---
    var bodyBest = pickBest(findShadowHosts(document.body, 'body-shadow-host'));
    if (bodyBest) return bodyBest;

    // --- Method 7: any div with .shadowRoot ---
    var allDivs = document.querySelectorAll('div');
    for (i = 0; i < allDivs.length; i++) {
      try {
        if (allDivs[i].shadowRoot) {
          rect = allDivs[i].getBoundingClientRect();
          if (rect.width >= 250 && rect.width <= 450 &&
              rect.height >= 40 && rect.height <= 200 &&
              rect.x > 0 && rect.y > 0) {
            rect = vis(allDivs[i]);
            return hit(rect, 'shadow-root-div');
          }
        }
      } catch (e) {}
    }

    // --- Method 8: bordered/shadowed box ---
    for (i = 0; i < allDivs.length; i++) {
      try {
        rect = allDivs[i].getBoundingClientRect();
        style = window.getComputedStyle(allDivs[i]);
        if ((style.borderStyle !== 'none' && style.borderWidth !== '0px' || style.boxShadow !== 'none') &&
            rect.width >= 280 && rect.width <= 500 &&
            rect.height >= 50 && rect.height <= 120 &&
            rect.x > 0 && rect.y > 0) {
          rect = vis(allDivs[i]);
          return hit(rect, 'interstitial-bordered-box');
        }
      } catch (e) {}
    }

    // --- Method 9: ANY visible iframe ---
    for (i = 0; i < iframes.length; i++) {
      rect = iframes[i].getBoundingClientRect();
      if (rect.width > 100 && rect.height > 40 && rect.x > 0 && rect.y > 0) {
        rect = vis(iframes[i]);
        return hit(rect, 'interstitial-any-iframe');
      }
    }
  }

  return { x: 0, y: 0, m: 'none', d: debug() };
})())`;

/**
 * JS detection for standalone Turnstile widgets on pages where
 * Runtime.addBinding doesn't work (e.g., Fetch.fulfillRequest-intercepted).
 *
 * Returns JSON: null (no widget) or {present, solved, tokenLength}.
 * Three-layer token extraction: API → hidden input → window flag.
 */
/**
 * Detect Turnstile widget + start in-page token polling as a side effect.
 * Returns synchronously (never a Promise) so the CDP call is fast.
 *
 * On first detection: starts a 100ms in-page interval that writes the
 * token to window.__turnstileAwaitResult when found. Subsequent calls
 * check this variable first (fast path).
 *
 * Why not awaitPromise? Under 15-tab contention, if the eval blocks on
 * a Promise and the session closes, CDP throws — the catch block fires
 * with ZERO events emitted (no detected, no solved). By returning sync,
 * the caller can emit cf.detected immediately, then check for the token
 * on the next poll.
 */
export const TURNSTILE_DETECT_AND_AWAIT_JS = `JSON.stringify((function() {
  if (typeof window.turnstile === 'undefined') {
    if (!document.querySelector('.cf-turnstile, [data-sitekey], #cf-turnstile-response'))
      return null;
  }
  function getToken() {
    var t = null;
    if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
      try { t = turnstile.getResponse() || null; } catch(e) {}
    }
    if (!t) { var inp = document.querySelector('input[name="cf-turnstile-response"]'); if (inp) t = inp.value || null; }
    if (!t && window.__turnstileToken) t = window.__turnstileToken;
    return t;
  }
  var token = getToken();
  if (token) return { present: true, solved: true, tokenLength: token.length };
  if (!window.__turnstileAwaitStarted) {
    window.__turnstileAwaitStarted = true;
    var iv = setInterval(function() {
      var t = getToken();
      if (t) {
        clearInterval(iv);
        window.__turnstileAwaitResult = { solved: true, tokenLength: t.length };
        if (typeof window.__turnstileSolvedBinding === 'function') {
          try { window.__turnstileSolvedBinding(t); } catch(e) {}
        }
      }
    }, 100);
    setTimeout(function() { clearInterval(iv); }, 30000);
  }
  if (window.__turnstileAwaitResult) return { present: true, solved: true, tokenLength: window.__turnstileAwaitResult.tokenLength };
  return { present: true, solved: false };
})())`;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Cloudflare Turnstile — Official Widget Error States
 * https://developers.cloudflare.com/turnstile/concepts/widget/
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. UNKNOWN ERROR         — error during challenge, widget shows error message
 * 2. INTERACTION TIMED OUT — checkbox shown but visitor didn't click in time
 * 3. CHALLENGE TIMED OUT   — token expired, visitor didn't submit form in time
 * 4. UNSUPPORTED BROWSER   — outdated/unsupported browser (N/A for us — we control Chrome)
 *
 * Our detection:
 *   TURNSTILE_STATE_OBSERVER_JS  │ MutationObserver on #success, #verifying, #fail, #expired, #timeout
 *     'fail'                     │ → maps to CF "Unknown error"
 *     'timeout'                  │ → maps to CF "Interaction timed out"
 *     'expired'                  │ → maps to CF "Challenge timed out"
 *
 *   TURNSTILE_ERROR_CHECK_JS     │ Polling check (activity loop)
 *     'confirmed_error'          │ → error/failed text in widget, no token
 *     'error_text'               │ → error/failed text in widget, has token
 *     'iframe_error'             │ → error/failed text in iframe content
 *     'expired'                  │ → turnstile.isExpired() returned true
 */

/**
 * JS to detect Turnstile widget error states.
 * Checks container text for error indicators and turnstile.isExpired().
 * Returns error type string or null.
 */
export const TURNSTILE_ERROR_CHECK_JS = `JSON.stringify((function() {
  var hasToken = false;
  try {
    if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
      var t = turnstile.getResponse();
      if (t && t.length > 0) hasToken = true;
    }
  } catch(e) {}
  if (!hasToken) {
    var inp = document.querySelector('[name="cf-turnstile-response"]');
    if (inp && inp.value && inp.value.length > 0) hasToken = true;
  }

  var containers = document.querySelectorAll(
    '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]'
  );
  for (var i = 0; i < containers.length; i++) {
    var text = (containers[i].textContent || '').toLowerCase();
    if (text.includes('error') || text.includes('failed') || text.includes('try again'))
      return { type: hasToken ? 'error_text' : 'confirmed_error', has_token: hasToken };
  }

  var cfIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[name^="cf-chl-widget"]');
  for (var i = 0; i < cfIframes.length; i++) {
    try {
      var doc = cfIframes[i].contentDocument;
      if (doc && doc.body) {
        var iText = (doc.body.textContent || '').toLowerCase();
        if (iText.includes('error') || iText.includes('failed') || iText.includes('try again'))
          return { type: hasToken ? 'iframe_error' : 'confirmed_error', has_token: hasToken };
      }
    } catch(e) {}
  }

  if (typeof turnstile !== 'undefined' && turnstile.isExpired) {
    try {
      var ws = document.querySelectorAll('[id^="cf-chl-widget"]');
      for (var i = 0; i < ws.length; i++) {
        if (turnstile.isExpired(ws[i].id))
          return { type: 'expired', has_token: hasToken };
      }
    } catch(e) {}
  }
  return null;
})()`;
