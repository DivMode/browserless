/**
 * Types and detection scripts for Cloudflare challenge solving.
 * JS constants are injected into pages via CDP Runtime.evaluate.
 */

export type ChallengeType = 'interstitial' | 'embedded' | 'invisible' | 'managed' | 'block';

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
