/**
 * Turnstile render/getResponse proxy — runs in the browser.
 * Replaces TURNSTILE_CALLBACK_HOOK_JS template literal.
 *
 * Wraps turnstile.render() callback and turnstile.getResponse() to push
 * 'solved' events to the server via the bridge binding.
 *
 * IMPORTANT: Do NOT use Object.defineProperty to trap window.turnstile —
 * CF's api.js detects getter/setter on the property and refuses to render.
 *
 * Hook strategy: capture-phase load listener fires BEFORE script onload,
 * ensuring render() is wrapped before the first call. 20ms poll is the
 * fallback for edge cases (turnstile created without a script load event).
 */
import type { Emit } from './types';

let tokenReported = false;
let apiLoadedReported = false;

function reportSolved(emit: Emit, token: string): void {
  if (tokenReported) return;
  tokenReported = true;
  window.__turnstileSolved = true;
  window.__turnstileTokenLength = token.length;
  emit({ type: 'timing', event: 'token_received', ts: Date.now() });
  emit({ type: 'solved', token, tokenLength: token.length });
}

function proxyGetResponse(ts: NonNullable<Window['turnstile']>, emit: Emit): void {
  if (!ts.getResponse || ts.__grHooked) return;
  const origGR = ts.getResponse.bind(ts);
  ts.getResponse = function (widgetId?: string): string | null {
    const token = origGR(widgetId);
    if (token) reportSolved(emit, token);
    return token;
  };
  ts.__grHooked = true;
}

function wrapRender(ts: NonNullable<Window['turnstile']>, emit: Emit): void {
  if (!ts.render || ts.__cbHooked) return;
  const orig = ts.render;
  ts.render = function (_container: any, params: any): string {
    params = params || {};
    window.__turnstileRenderTime = Date.now();
    emit({ type: 'timing', event: 'render_called', ts: Date.now() });
    window.__turnstileRenderParams = {
      sitekey: (params.sitekey || '').substring(0, 20),
      action: params.action || null,
      size: params.size || 'normal',
      appearance: params.appearance || null,
      theme: params.theme || 'auto',
    };

    const origCb = typeof params.callback === 'function' ? params.callback : null;
    params.callback = function (token: string) {
      reportSolved(emit, token);
      if (origCb) return origCb.apply(this, arguments);
    };

    const widgetId = orig.apply(this, arguments as any);
    window.__turnstileWidgetId = widgetId || null;
    return widgetId;
  };
  ts.__cbHooked = true;
  proxyGetResponse(ts, emit);
}

/** Hook an existing turnstile object + check for already-solved tokens. */
function hookAndCheck(ts: NonNullable<Window['turnstile']>, emit: Emit): void {
  if (!ts.__cbHooked) wrapRender(ts, emit);
  if (!ts.__grHooked) proxyGetResponse(ts, emit);
  // Check for tokens from widgets solved before hooks were installed
  if (!tokenReported) {
    try {
      const existing = ts.getResponse?.();
      if (existing) reportSolved(emit, existing);
    } catch (_) {}
  }
}

/**
 * Check if this is a CF challenge page by detecting _cf_chl_opt.
 * CF sets this via an inline <script> tag, which runs synchronously
 * BEFORE window.turnstile is created by api.js (async). This means
 * the polling loops will detect _cf_chl_opt and abort before ever
 * hooking turnstile on a challenge page.
 */
function isCFChallengePage(): boolean {
  return typeof window._cf_chl_opt !== 'undefined';
}

export function setupTurnstileHooks(emit: Emit): void {
  // If turnstile already exists (unlikely but possible), hook immediately
  // Guard: skip if this is a CF challenge page (deferred detection)
  if (window.turnstile && !isCFChallengePage()) {
    hookAndCheck(window.turnstile, emit);
  }

  // Capture-phase load listener: hooks turnstile BEFORE script's onload fires.
  // HTML spec guarantees: script execution (creates window.turnstile) completes,
  // then load event dispatches capture→target. We hook in capture phase,
  // onload calls render() in target phase — render() is already wrapped.
  function captureLoadHandler(): void {
    if (isCFChallengePage()) return;
    if (window.turnstile) {
      if (!apiLoadedReported) {
        apiLoadedReported = true;
        emit({ type: 'timing', event: 'api_loaded', ts: Date.now() });
      }
      hookAndCheck(window.turnstile, emit);
      if (window.turnstile.__cbHooked && window.turnstile.__grHooked) {
        document.removeEventListener('load', captureLoadHandler, true);
      }
    }
  }
  document.addEventListener('load', captureLoadHandler, true);

  // Poll for turnstile creation — CF's api.js loads async and creates
  // window.turnstile. Fast poll (20ms) to hook render() before first call.
  // Abort immediately if _cf_chl_opt detected (CF challenge page).
  let hooksInstalled = false;
  const pollId = setInterval(() => {
    if (isCFChallengePage()) { clearInterval(pollId); return; }
    if (window.turnstile) {
      if (!apiLoadedReported) {
        apiLoadedReported = true;
        emit({ type: 'timing', event: 'api_loaded', ts: Date.now() });
      }
      hookAndCheck(window.turnstile, emit);
      if (window.turnstile.__cbHooked && window.turnstile.__grHooked) {
        hooksInstalled = true;
        clearInterval(pollId);
      }
    }
  }, 20);
  setTimeout(() => {
    clearInterval(pollId);
    document.removeEventListener('load', captureLoadHandler, true);
  }, 30000);

  // Slow fallback poll — catches tokens from managed/invisible widgets that
  // auto-solve AFTER the fast poll stops. The render() callback wrapper handles
  // most cases, but managed widgets can solve after 30-60s. Without this poll,
  // the token is only detected when the page navigates (auto_navigation),
  // causing 50-60s ghost traces in cf.resolutionRace.
  const tokenPollId = setInterval(() => {
    if (tokenReported || isCFChallengePage()) { clearInterval(tokenPollId); return; }
    if (!hooksInstalled) return; // wait for hooks first
    try {
      const token = window.turnstile?.getResponse?.();
      if (token) reportSolved(emit, token);
    } catch (_) {}
  }, 1000);
  setTimeout(() => clearInterval(tokenPollId), 90000);
}
