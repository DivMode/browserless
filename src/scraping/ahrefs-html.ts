/**
 * Minimal HTML templates injected via Fetch.fulfillRequest.
 *
 * The turnstile widget renders, calls onToken() when solved,
 * which fires the Ahrefs API calls and sets window.__ahrefsResult.
 *
 * Shared browser JS (mark, showError, fetchJSON, setApiStatus) is
 * defined ONCE in sharedBrowserJs(). Each scrape type only provides
 * its onToken() implementation.
 */

interface HtmlParams {
  readonly domain: string;
  readonly sitekey: string;
  readonly action: string;
  readonly sessionId: string;
  readonly targetId: string;
}

// ── Shared browser JS (single source of truth) ─────────────────────

const sharedBrowserJs = (p: HtmlParams): string => `
window.__ahrefsResult = null;
window.__turnstileToken = null;
window.__apiCallStatus = 'not_called';
window.__apiErrors = [];

function mark(tag, payload) {
  var event = {type: 5, timestamp: Date.now(), data: {tag: tag, payload: payload || {}}};
  if (window.__rrwebPush) { try { window.__rrwebPush(JSON.stringify([event])); return; } catch(e) {} }
  var r = window.__browserlessRecording;
  if (r && r.events) r.events.push(event);
}

function showError(type, msg) {
  var el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = '\\u274C ' + type + '\\n' + msg;
  document.getElementById('status').textContent = 'FAILED: ' + type;
  document.title = 'FAIL: ' + type;
}

function setApiStatus(status) {
  window.__apiCallStatus = 'responded_' + status;
}

function fetchJSON(endpoint, url, options) {
  return fetch(url, options).then(function(resp) {
    return resp.text().then(function(body) {
      if (!resp.ok) {
        var isCf = body.indexOf('Just a moment') !== -1;
        mark('ahrefs.api_error', {endpoint: endpoint, status: resp.status, is_cf: isCf, body: body.substring(0, 200)});
        var err = new Error(endpoint + '_http_' + resp.status);
        err.apiError = {endpoint: endpoint, status: resp.status, is_cf: isCf};
        throw err;
      }
      try {
        return JSON.parse(body);
      } catch(e) {
        mark('ahrefs.api_error', {endpoint: endpoint, status: resp.status, parse_error: true});
        var err2 = new Error(endpoint + '_parse_' + resp.status);
        err2.apiError = {endpoint: endpoint, status: resp.status, is_cf: false, parse_error: true};
        throw err2;
      }
    });
  });
}

function recordApiError(e) {
  if (e.apiError) window.__apiErrors.push(Object.assign({retried: false}, e.apiError));
}

function completeSuccess(result) {
  if (window.__apiErrors.length) result.apiErrors = window.__apiErrors;
  window.__ahrefsResult = JSON.stringify(result);
  window.__apiCallStatus = 'responded_ok';
  mark('ahrefs.complete', {success: true});
  document.getElementById('status').style.color = '#16a34a';
  document.getElementById('status').textContent = '\\u2705 Complete';
  document.title = 'OK';
}

function completeError(message, result) {
  var lastErr = window.__apiErrors.length ? window.__apiErrors[window.__apiErrors.length - 1] : null;
  window.__apiCallStatus = lastErr ? 'responded_' + lastErr.status : 'responded_error';
  window.__ahrefsResult = JSON.stringify(Object.assign({
    apiErrors: window.__apiErrors.length ? window.__apiErrors : undefined
  }, result || {error: 'api_error', message: message}));
  mark('ahrefs.error', {message: message});
  showError('api_error', message);
}

function notifyServer() {
  try {
    navigator.sendBeacon('http://127.0.0.1:3000/internal/cf-solved',
      JSON.stringify({s:'${p.sessionId}',t:'${p.targetId}',l:window.__turnstileToken.length}));
  } catch(e) {}
}

mark('turnstile.solving', {});
`;

// ── HTML shell ──────────────────────────────────────────────────────

const htmlShell = (p: HtmlParams, onTokenJs: string): string => `<!DOCTYPE html>
<html>
<head><title>Verifying</title></head>
<body>
<div id="ts"></div>
<div id="status" style="font-family:monospace;font-size:16px;padding:8px;">Solving Turnstile challenge...</div>
<div id="err" style="display:none;background:#dc2626;color:#fff;font-family:monospace;font-size:18px;font-weight:bold;padding:14px 16px;margin:8px 0;border-radius:4px;white-space:pre-wrap;"></div>
<script>${sharedBrowserJs(p)}
${onTokenJs}</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  async onload="turnstile.render('#ts',{sitekey:'${p.sitekey}',action:'${p.action}',callback:onToken,theme:'light'})">
</script>
</body>
</html>`;

// ── Backlinks onToken ───────────────────────────────────────────────

const backlinksOnToken = (p: HtmlParams): string => `
async function onToken(token) {
  window.__turnstileToken = token;
  window.__turnstileSolved = true;
  mark('turnstile.token_received', {});
  notifyServer();

  document.getElementById('status').textContent = 'Token received, calling API...';
  window.__apiCallStatus = 'pending';
  try {
    var ov = await fetchJSON('overview', '/v4/stGetFreeBacklinksOverview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json; charset=utf-8'},
      body: JSON.stringify({captcha: token, url: '${p.domain}', mode: 'subdomains'})
    });
    mark('ahrefs.overview', {backlinks: ov[1] && ov[1].data ? ov[1].data.backlinks || 0 : 0});
    document.getElementById('status').textContent = 'Fetching backlinks...';

    var bl = null;
    if (Array.isArray(ov) && ov[0] === 'Ok' && ov[1] && ov[1].signedInput &&
        ov[1].data && ov[1].data.backlinks > 0) {
      try {
        bl = await fetchJSON('backlinks_list', '/v4/stGetFreeBacklinksList', {
          method: 'POST',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify({signedInput: ov[1].signedInput, reportType: ['TopBacklinks']})
        });
        mark('ahrefs.backlinks', {});
      } catch(e) {
        recordApiError(e);
        bl = {error: e.message, message: e.message};
        showError(e.message, e.message);
        await new Promise(function(r) { setTimeout(r, 600); });
      }
    }

    var hasBlError = bl && bl.error;
    if (hasBlError) {
      completeError(bl.message || 'backlinks_fetch_failed', {
        error: bl.message || 'backlinks_fetch_failed',
        success: false,
        overview: ov,
        backlinks: bl
      });
    } else {
      completeSuccess({success: true, overview: ov, backlinks: bl});
    }
  } catch(e) {
    recordApiError(e);
    completeError(e.message);
    await new Promise(function(r) { setTimeout(r, 600); });
  }
}`;

// ── Traffic onToken ─────────────────────────────────────────────────

const trafficOnToken = (p: HtmlParams): string => `
async function onToken(token) {
  window.__turnstileToken = token;
  window.__turnstileSolved = true;
  mark('turnstile.token_received', {});
  notifyServer();

  document.getElementById('status').textContent = 'Token received, calling API...';
  window.__apiCallStatus = 'pending';
  try {
    var ov = await fetchJSON('traffic', '/v4/stGetFreeTrafficOverview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json; charset=utf-8'},
      body: JSON.stringify({captcha: token, url: '${p.domain}', mode: 'subdomains', country: null, protocol: null})
    });
    mark('ahrefs.traffic', {});
    completeSuccess({success: true, overview: ov});
  } catch(e) {
    recordApiError(e);
    completeError(e.message);
    await new Promise(function(r) { setTimeout(r, 600); });
  }
}`;

// ── Exports ─────────────────────────────────────────────────────────

export const minimalTurnstileHtml = (p: HtmlParams): string => htmlShell(p, backlinksOnToken(p));

export const minimalTrafficHtml = (p: HtmlParams): string => htmlShell(p, trafficOnToken(p));
