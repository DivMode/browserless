/**
 * Turnstile render/getResponse proxy — runs in the browser.
 * Replaces TURNSTILE_CALLBACK_HOOK_JS template literal.
 *
 * Wraps turnstile.render() callback and turnstile.getResponse() to push
 * 'solved' events to the server via the bridge binding.
 *
 * IMPORTANT: Do NOT use Object.defineProperty to trap window.turnstile —
 * CF's api.js detects getter/setter on the property and refuses to render.
 * Use polling to catch turnstile creation + getResponse() check for tokens
 * from widgets solved before hooks were installed.
 */
import type { Emit } from './types';

let tokenReported = false;

function reportSolved(emit: Emit, token: string): void {
  if (tokenReported) return;
  tokenReported = true;
  window.__turnstileSolved = true;
  window.__turnstileTokenLength = token.length;
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

export function setupTurnstileHooks(emit: Emit): void {
  // If turnstile already exists (unlikely but possible), hook immediately
  if (window.turnstile) {
    hookAndCheck(window.turnstile, emit);
  }

  // Poll for turnstile creation — CF's api.js loads async and creates
  // window.turnstile. Fast poll (20ms) to hook render() before first call.
  const pollId = setInterval(() => {
    if (window.turnstile) {
      hookAndCheck(window.turnstile, emit);
      if (window.turnstile.__cbHooked && window.turnstile.__grHooked) clearInterval(pollId);
    }
  }, 20);
  setTimeout(() => clearInterval(pollId), 30000);

  // Token recovery poll — catches tokens from widgets solved via the
  // original callback (before our hooks were installed).
  const tokenPollId = setInterval(() => {
    if (tokenReported) { clearInterval(tokenPollId); return; }
    if (!window.turnstile?.getResponse) return;
    try {
      const token = window.turnstile.getResponse();
      if (token) reportSolved(emit, token);
    } catch (_) {}
  }, 200);
  setTimeout(() => clearInterval(tokenPollId), 30000);
}
