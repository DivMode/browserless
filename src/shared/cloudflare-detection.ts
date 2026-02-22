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

/** Accumulated state for one CF solve phase, included in solved/failed events.
 *  Generated from cloudflare-snapshot.schema.json — do not edit by hand. */
export type { CloudflareSnapshot } from './cloudflare-snapshot.generated.js';

/**
 * Comprehensive CDP mouse event patch — injected via CDP into OOPIFs where Chrome
 * extensions can't load content scripts (cross-origin iframes run in separate renderer
 * processes, so all_frames:true does NOT reach them).
 *
 * Patches all known CDP Input.dispatchMouseEvent detection vectors:
 *
 * 1. screenX/screenY (Chrome bug 40280325): CDP sets screenX=clientX, screenY=clientY.
 *    Real events: screenX = clientX + window.screenX, screenY = clientY + window.screenY + chromeHeight.
 *
 * 2. sourceCapabilities: CDP events have null sourceCapabilities.
 *    Real mouse events: InputDeviceCapabilities({firesTouchEvents: false}).
 *
 * 3. PointerEvent.pressure: CDP sends 0. Real mouse pointerdown has 0.5 (spec default
 *    for active button press). pointerup/pointermove should be 0.
 *
 * 4. PointerEvent.width/height: CDP may send 0. Real mouse pointer events have 1x1.
 */
export const SCREENXY_PATCH_JS = `(function() {
  // Guard: check if screenX getter already returns our patched value (clientX + screenX offset).
  // Avoids re-patching without exposing any detectable property on window.
  try {
    var desc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
    if (desc && desc.get) return; // already patched — native has no getter on screenX
  } catch(e) {}
  var chromeHeight = 85;

  // 1. screenX/screenY — same as extensions/screenxy-patch/patch.js
  Object.defineProperty(MouseEvent.prototype, 'screenX', {
    get: function() { return this.clientX + (window.screenX || 0); },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(MouseEvent.prototype, 'screenY', {
    get: function() { return this.clientY + (window.screenY || 0) + chromeHeight; },
    configurable: true, enumerable: true,
  });

  // 2. sourceCapabilities — CDP events have null, real mouse events have InputDeviceCapabilities
  if (typeof InputDeviceCapabilities !== 'undefined') {
    var mouseCaps = new InputDeviceCapabilities({firesTouchEvents: false});
    Object.defineProperty(UIEvent.prototype, 'sourceCapabilities', {
      get: function() { return mouseCaps; },
      configurable: true, enumerable: true,
    });
  }

  // 3. PointerEvent.pressure — CDP sends 0, real pointerdown has 0.5
  if (typeof PointerEvent !== 'undefined') {
    Object.defineProperty(PointerEvent.prototype, 'pressure', {
      get: function() { return (this.buttons > 0) ? 0.5 : 0; },
      configurable: true, enumerable: true,
    });
    // 4. PointerEvent.width/height — CDP may send 0, real mouse events have 1
    Object.defineProperty(PointerEvent.prototype, 'width', {
      get: function() { return 1; },
      configurable: true, enumerable: true,
    });
    Object.defineProperty(PointerEvent.prototype, 'height', {
      get: function() { return 1; },
      configurable: true, enumerable: true,
    });
  }
})()`;

/**
 * Fix navigator.languages + crossOriginIsolated to match a real Chrome browser.
 *
 * Two problems solved:
 * 1. Chrome with --lang=en-US sets navigator.languages to ["en-US"] but a real
 *    user's browser has ["en-US", "en"]. CF's fingerprint checks this value.
 * 2. crossOriginIsolated=true in some contexts when CF expects false.
 *
 * Critical: CF's fingerprint audit creates a hidden same-origin iframe and reads
 * iframe.contentWindow.navigator.languages SYNCHRONOUSLY. Each iframe gets its own
 * Navigator.prototype, so patching the parent's prototype doesn't help. And
 * addScriptToEvaluateOnNewDocument doesn't fire on synchronously-created iframes
 * (their initial about:blank document exists before any document load event).
 *
 * Solution: Intercept HTMLIFrameElement.prototype.contentWindow to auto-patch
 * the navigator in each new iframe context the moment it's first accessed.
 */
export const NAVIGATOR_LANGUAGES_PATCH_JS = `(function() {
  var langs = Object.freeze(['en-US', 'en']);

  // Guard: check if Navigator.prototype.languages already returns our frozen array.
  // This avoids re-patching without exposing any detectable property on window.
  try {
    var cur = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
    if (cur && cur.get && cur.get() === langs) return;
  } catch(e) {}

  // Closure-scoped tracking — invisible to any external code.
  // WeakSet allows GC of detached iframe windows.
  var patched = new WeakSet();

  function patchNavigator(nav, proto) {
    try { Object.defineProperty(proto, 'languages', {
      get: function() { return langs; },
      configurable: true, enumerable: true,
    }); } catch(e) {}
    try { Object.defineProperty(nav, 'languages', {
      get: function() { return langs; },
      configurable: true, enumerable: true,
    }); } catch(e) {}
    try { Object.defineProperty(proto, 'language', {
      get: function() { return 'en-US'; },
      configurable: true, enumerable: true,
    }); } catch(e) {}
  }

  function patchWindow(w) {
    if (!w || patched.has(w)) return;
    patched.add(w);
    try {
      var np = w.Navigator && w.Navigator.prototype;
      if (np) patchNavigator(w.navigator, np);
      // crossOriginIsolated is an own property per-window — must patch each instance
      Object.defineProperty(w, 'crossOriginIsolated', {
        get: function() { return false; },
        configurable: true, enumerable: true,
      });
    } catch(e) {} // cross-origin — ignore
  }

  // Patch current frame
  patchWindow(window);

  // Watch for new iframes via MutationObserver — less detectable than
  // overriding contentWindow getter. Patches same-origin iframes on insert.
  try {
    new MutationObserver(function(mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var nodes = mutations[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          var node = nodes[n];
          if (node.tagName === 'IFRAME') {
            try { patchWindow(node.contentWindow); } catch(e) {}
          }
          // Also check children of added nodes
          if (node.querySelectorAll) {
            var iframes = node.querySelectorAll('iframe');
            for (var f = 0; f < iframes.length; f++) {
              try { patchWindow(iframes[f].contentWindow); } catch(e) {}
            }
          }
        }
      }
    }).observe(document.documentElement || document, {childList: true, subtree: true});
  } catch(e) {}
})()`;

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
    var html = document.documentElement.innerHTML || '';
    if (html.includes('challenges.cloudf'))
        return { detected: true, method: 'challenges_domain' };
    var cfForm = document.querySelector('form[action*="__cf_chl_f_tk"], form[action*="__cf_chl_jschl"]');
    if (cfForm) return { detected: true, method: 'cf_form_action' };
    var tsScript = document.querySelector('script[src*="/turnstile/"]');
    if (tsScript) return { detected: true, method: 'turnstile_script' };
    if (document.querySelector('#challenge-success-text'))
        return { detected: true, method: 'challenge_success' };
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
    if (!document.querySelector('.cf-turnstile, [data-sitekey], [name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]'))
      return null;
  }
  var _k = Symbol.for('_ts');
  function getToken() {
    var t = null;
    if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
      try { t = turnstile.getResponse() || null; } catch(e) {}
    }
    if (!t) { var inp = document.querySelector('input[name="cf-turnstile-response"]'); if (inp) t = inp.value || null; }
    return t;
  }
  var token = getToken();
  if (token) return { present: true, solved: true, tokenLength: token.length };
  var st = window[_k];
  if (!st) {
    st = { started: true, result: null };
    Object.defineProperty(window, _k, { value: st, configurable: false, enumerable: false });
    var iv = setInterval(function() {
      var t = getToken();
      if (t) {
        clearInterval(iv);
        st.result = { solved: true, tokenLength: t.length };
      }
    }, 100);
    setTimeout(function() { clearInterval(iv); }, 30000);
  }
  if (st.result) return { present: true, solved: true, tokenLength: st.result.tokenLength };
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

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CF Fingerprint Audit — diagnostic injection
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Ported from cloudflare-jsd/get_fingerprint.js
 *
 * Creates a hidden iframe (same technique CF uses internally) and
 * enumerates all properties on window, navigator, and document.
 * Classifies each property by CF's type encoding (o, N, F, T, etc.)
 * and compares against the expected fingerprint from fp.go.
 *
 * Returns JSON with:
 *   - mismatches: properties where our browser differs from expected
 *   - critical: high-priority mismatches (webdriver, native functions, etc.)
 *   - sample: first 30 captured property classifications
 *   - counts: total properties per type
 */
export const CF_FINGERPRINT_AUDIT_JS = `JSON.stringify((function() {
  try {
    var S = document;
    var n = {object:'o',string:'s',undefined:'u',symbol:'z',number:'n',bigint:'I',boolean:'b'};

    function isNative(E, fn) {
      try {
        return fn instanceof E.Function &&
          E.Function.prototype.toString.call(fn).indexOf('[native code]') > -1;
      } catch(e) { return false; }
    }

    function classifyProp(E, obj, key) {
      try {
        var val = obj[key];
        if (val && typeof val.catch === 'function') return 'p';
      } catch(e) {}
      try {
        if (obj[key] == null) return obj[key] === undefined ? 'u' : 'x';
      } catch(e) { return 'i'; }
      var val = obj[key];
      if (E.Array.isArray(val)) return 'a';
      if (val === E.Array) return 'q0';
      if (val === true) return 'T';
      if (val === false) return 'F';
      var t = typeof val;
      if (t === 'function') return isNative(E, val) ? 'N' : 'f';
      return n[t] || '?';
    }

    function getAllKeys(obj) {
      var keys = [];
      var cur = obj;
      while (cur !== null) {
        keys = keys.concat(Object.keys(cur));
        try { cur = Object.getPrototypeOf(cur); } catch(e) { break; }
      }
      if (typeof Object.getOwnPropertyNames === 'function') {
        try { keys = keys.concat(Object.getOwnPropertyNames(obj)); } catch(e) {}
      }
      // Deduplicate
      var seen = {};
      var unique = [];
      for (var i = 0; i < keys.length; i++) {
        if (!seen[keys[i]]) { seen[keys[i]] = true; unique.push(keys[i]); }
      }
      return unique;
    }

    function enumerate(E, obj, prefix, result) {
      if (obj == null) return result;
      var keys = getAllKeys(obj);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var cls = classifyProp(E, obj, key);
        var fullKey = prefix + key;
        if (!result[cls]) result[cls] = [];
        result[cls].push(fullKey);
      }
      return result;
    }

    // Create hidden iframe — same as CF's technique
    // Wait for body to be available (CF interstitial pages load body async)
    if (!S.body) return {error: 'no_body', readyState: S.readyState};
    var iframe = S.createElement('iframe');
    iframe.style.display = 'none';
    iframe.tabIndex = -1;
    S.body.appendChild(iframe);
    var W = iframe.contentWindow;
    var D = iframe.contentDocument;
    if (!W || !D) { try { S.body.removeChild(iframe); } catch(e){} return {error: 'no_iframe_window'}; }

    var fp = {};
    fp = enumerate(W, W, '', fp);
    fp = enumerate(W, W.clientInformation || W.navigator, 'n.', fp);
    fp = enumerate(W, D, 'd.', fp);
    S.body.removeChild(iframe);

    // Expected values from cloudflare-jsd/fp.go
    var expected = {
      'F': ['closed','crossOriginIsolated','credentialless','n.webdriver',
            'n.deprecatedRunAdAuctionEnforcesKAnonymity','d.xmlStandalone','d.hidden',
            'd.wasDiscarded','d.prerendering','d.webkitHidden','d.fullscreen','d.webkitIsFullScreen'],
      'T': ['isSecureContext','originAgentCluster','offscreenBuffering',
            'n.pdfViewerEnabled','n.cookieEnabled','n.onLine',
            'd.fullscreenEnabled','d.webkitFullscreenEnabled','d.pictureInPictureEnabled','d.isConnected'],
      'N_sample': ['alert','atob','blur','btoa','fetch','Object','Function','Number','Boolean',
                   'String','Date','Promise','Map','Set','eval','isNaN','WebSocket',
                   'd.getElementById','d.querySelector','d.createElement'],
      // Note: 'Array' intentionally excluded — CF's classifier returns 'q0' for it
      // (val === E.Array check runs before the typeof==='function' check)
      'o_sample': ['window','self','document','navigator','screen','crypto','console','JSON','Math',
                   'n.geolocation','n.plugins','n.clipboard','n.mediaDevices','n.userAgentData'],
    };

    // Check critical mismatches
    var mismatches = [];
    var critical = [];

    // Check booleans that should be False
    var fpF = fp['F'] || [];
    for (var i = 0; i < expected['F'].length; i++) {
      var prop = expected['F'][i];
      if (fpF.indexOf(prop) === -1) {
        // Find what type it actually is
        var actual = '?';
        for (var t in fp) {
          if (fp[t].indexOf(prop) !== -1) { actual = t; break; }
        }
        var entry = {prop: prop, expected: 'F', actual: actual};
        mismatches.push(entry);
        if (prop === 'n.webdriver') critical.push(entry);
      }
    }

    // Check booleans that should be True
    var fpT = fp['T'] || [];
    for (var i = 0; i < expected['T'].length; i++) {
      var prop = expected['T'][i];
      if (fpT.indexOf(prop) === -1) {
        var actual = '?';
        for (var t in fp) {
          if (fp[t].indexOf(prop) !== -1) { actual = t; break; }
        }
        mismatches.push({prop: prop, expected: 'T', actual: actual});
      }
    }

    // Check native functions (should be 'N', not 'f' or missing)
    var fpN = fp['N'] || [];
    for (var i = 0; i < expected['N_sample'].length; i++) {
      var prop = expected['N_sample'][i];
      if (fpN.indexOf(prop) === -1) {
        var actual = '?';
        for (var t in fp) {
          if (fp[t].indexOf(prop) !== -1) { actual = t; break; }
        }
        if (actual !== 'N') {
          var entry = {prop: prop, expected: 'N', actual: actual};
          mismatches.push(entry);
          // Functions that should be native but aren't = puppeteer-stealth patches leaked
          if (actual === 'f') critical.push(entry);
        }
      }
    }

    // Check objects
    var fpO = fp['o'] || [];
    for (var i = 0; i < expected['o_sample'].length; i++) {
      var prop = expected['o_sample'][i];
      if (fpO.indexOf(prop) === -1) {
        var actual = '?';
        for (var t in fp) {
          if (fp[t].indexOf(prop) !== -1) { actual = t; break; }
        }
        if (actual !== 'o') mismatches.push({prop: prop, expected: 'o', actual: actual});
      }
    }

    // Also check specific string values that CF validates
    var strChecks = [];
    try { strChecks.push({prop:'n.vendor', val: (W || window).navigator?.vendor, expected: 'Google Inc.'}); } catch(e){}
    try { strChecks.push({prop:'n.platform', val: navigator.platform, expected: 'Linux x86_64'}); } catch(e){}
    try { strChecks.push({prop:'n.webdriver', val: navigator.webdriver, expected: false}); } catch(e){}
    try { strChecks.push({prop:'n.languages', val: JSON.stringify(navigator.languages), expected: '["en-US","en"]'}); } catch(e){}
    try { strChecks.push({prop:'n.hardwareConcurrency', val: navigator.hardwareConcurrency}); } catch(e){}
    try { strChecks.push({prop:'n.deviceMemory', val: navigator.deviceMemory}); } catch(e){}
    try { strChecks.push({prop:'n.maxTouchPoints', val: navigator.maxTouchPoints, expected: 0}); } catch(e){}
    try { strChecks.push({prop:'n.pdfViewerEnabled', val: navigator.pdfViewerEnabled, expected: true}); } catch(e){}
    try { strChecks.push({prop:'n.cookieEnabled', val: navigator.cookieEnabled, expected: true}); } catch(e){}

    // Puppeteer/automation specific checks
    try { strChecks.push({prop:'window.chrome', val: typeof window.chrome, expected: 'object'}); } catch(e){}
    try { strChecks.push({prop:'window.chrome.runtime', val: typeof window.chrome?.runtime}); } catch(e){}
    try { strChecks.push({prop:'Notification.permission', val: typeof Notification !== 'undefined' ? Notification.permission : 'N/A'}); } catch(e){}
    try { strChecks.push({prop:'navigator.permissions.query', val: typeof navigator.permissions?.query, expected: 'function'}); } catch(e){}

    // Count properties per type
    var counts = {};
    for (var t in fp) { counts[t] = fp[t].length; }

    // List ALL non-native functions (f) — these are automation artifacts CF can detect
    var nonNativeFns = (fp['f'] || []).slice(0, 20);

    // Check for Runtime.addBinding globals (CDP bindings are visible on window)
    var bindingCheck = [];
    var bindingNames = ['__csrfp','__perf','__turnstileSolvedBinding','__turnstileTargetBinding',
                        '__turnstileStateBinding','__cfEventSpy',
                        '__turnstileAwaitStarted','__turnstileAwaitResult','__turnstileSolved'];
    for (var bi = 0; bi < bindingNames.length; bi++) {
      var bname = bindingNames[bi];
      try {
        if (typeof window[bname] !== 'undefined') {
          bindingCheck.push({name: bname, type: typeof window[bname]});
        }
      } catch(e) {}
    }

    return {
      mismatches: mismatches.slice(0, 30),
      critical: critical,
      string_checks: strChecks,
      counts: counts,
      total_props: Object.values(fp).reduce(function(a,b){return a+b.length;}, 0),
      webdriver_raw: navigator.webdriver,
      non_native_fns: nonNativeFns,
      visible_bindings: bindingCheck,
    };
  } catch(e) {
    return {error: e.message || String(e)};
  }
})())`;
