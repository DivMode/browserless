/**
 * Types and detection scripts for Cloudflare challenge solving.
 * JS constants are injected into pages via CDP Runtime.evaluate.
 */

export type ChallengeType = 'interstitial' | 'embedded' | 'invisible' | 'managed' | 'block' | 'widget';

export interface ChallengeInfo {
  type: ChallengeType;
  url: string;
  iframeUrl?: string;
  cType?: string;
  cRay?: string;
  detectionMethod: string;
}

export interface SolverConfig {
  /** Max attempts per challenge (default: 3) */
  maxAttempts?: number;
  /** Timeout per attempt in ms (default: 30000) */
  attemptTimeout?: number;
  /** Enable recording markers (default: true) */
  recordingMarkers?: boolean;
}

export interface SolveResult {
  solved: boolean;
  type: ChallengeType;
  method: string;
  token?: string;
  duration_ms: number;
  attempts: number;
  auto_resolved?: boolean;
  signal?: string;
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
 * JS detection script for Cloudflare challenge pages.
 * Checks _cf_chl_opt, #challenge-form, title, body text.
 *
 * Source: pydoll-scraper/src/evasion/cloudflare.py lines 37-111
 */
export const CF_CHALLENGE_DETECTION_JS = `JSON.stringify((() => {
    if (typeof window._cf_chl_opt !== 'undefined') {
        return {
            detected: true,
            method: 'cf_chl_opt',
            cType: window._cf_chl_opt.cType || 'unknown',
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
 * Detect challenge type from CDP data + page evaluation results.
 */
export function detectChallengeType(
  _pageUrl: string,
  detectionResult: { detected: boolean; method?: string; cType?: string },
  hasTurnstileIframe: boolean,
): ChallengeType | null {
  if (!detectionResult.detected) return null;

  // cf_chl_opt.cType maps directly to challenge types
  const cType = detectionResult.cType;
  if (cType === 'managed' || cType === 'interactive') return 'managed';

  // Interstitial: "Just a moment..." pages (detected by title)
  if (detectionResult.method === 'title_interstitial') return 'interstitial';

  // Block page: CF error pages (1006, 1015, etc.)
  if (detectionResult.method === 'cf_error_page') return 'block';

  // If Turnstile iframe is visible, it's embedded; otherwise invisible
  if (hasTurnstileIframe) return 'embedded';

  // Challenge page without visible Turnstile → interstitial (managed or invisible)
  if (detectionResult.method === 'body_text_challenge') return 'interstitial';

  return 'interstitial'; // Default fallback
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
  var hit = function(r, m) { return { x: r.x + 30, y: r.y + r.height / 2, m: m }; };
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

  return null;
})())`;

/**
 * JS to detect Turnstile widget error states.
 * Checks container text for error indicators and turnstile.isExpired().
 * Returns error type string or null.
 */
export const TURNSTILE_ERROR_CHECK_JS = `(function() {
  var containers = document.querySelectorAll(
    '[class*="cf-turnstile"], [id^="cf-chl-widget"], [data-sitekey]'
  );
  for (var i = 0; i < containers.length; i++) {
    var text = (containers[i].textContent || '').toLowerCase();
    if (text.includes('error') || text.includes('failed') || text.includes('try again'))
      return 'error_text';
  }
  if (typeof turnstile !== 'undefined' && turnstile.isExpired) {
    try {
      var ws = document.querySelectorAll('[id^="cf-chl-widget"]');
      for (var i = 0; i < ws.length; i++) {
        if (turnstile.isExpired(ws[i].id)) return 'expired';
      }
    } catch(e) {}
  }
  return null;
})()`;
