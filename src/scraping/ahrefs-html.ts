/**
 * Minimal HTML templates injected via Fetch.fulfillRequest.
 *
 * Ported verbatim from packages/pydoll-scraper/src/ahrefs_fast.py.
 * These are pure HTML/JS — no Python logic. Template substitution
 * uses tagged template literals instead of Python f-strings.
 *
 * The turnstile widget renders, calls onToken() when solved,
 * which fires the Ahrefs API calls and sets window.__ahrefsResult.
 */

interface HtmlParams {
  readonly domain: string;
  readonly sitekey: string;
  readonly action: string;
  readonly sessionId: string;
  readonly targetId: string;
}

/**
 * Minimal turnstile page for backlinks scraping.
 * Renders turnstile, calls overview + backlinks APIs on solve.
 */
export const minimalTurnstileHtml = (p: HtmlParams): string => `<!DOCTYPE html>
<html>
<head><title>Verifying</title></head>
<body>
<div id="ts"></div>
<div id="status" style="font-family:monospace;font-size:16px;padding:8px;">Solving Turnstile challenge...</div>
<div id="err" style="display:none;background:#dc2626;color:#fff;font-family:monospace;font-size:18px;font-weight:bold;padding:14px 16px;margin:8px 0;border-radius:4px;white-space:pre-wrap;"></div>
<script>
window.__ahrefsResult = null;
window.__turnstileToken = null;
window.__apiCallStatus = 'not_called';


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

mark('turnstile.solving', {});

async function fetchJSON(endpoint, url, options) {
  var resp = await fetch(url, options);
  var body = await resp.text();
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
}

async function onToken(token) {
  window.__turnstileToken = token;
  window.__turnstileSolved = true;
  window.__blockNavigation = true;
  mark('turnstile.token_received', {});
  try {
    navigator.sendBeacon('http://127.0.0.1:3000/internal/cf-solved',
      JSON.stringify({s:'${p.sessionId}',t:'${p.targetId}',l:token.length}));
  } catch(e) {}

  document.getElementById('status').textContent = 'Token received, calling API...';
  window.__apiCallStatus = 'pending';
  var apiErrors = [];
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
        if (e.apiError) apiErrors.push(Object.assign({retried: false}, e.apiError));
        bl = {error: 'backlinks_fetch_failed', message: e.message};
        showError('backlinks_fetch_failed', e.message);
      }
    }

    window.__ahrefsResult = JSON.stringify({
      success: true,
      overview: ov,
      backlinks: bl,
      apiErrors: apiErrors.length ? apiErrors : undefined
    });
    mark('ahrefs.complete', {success: true});
    window.__apiCallStatus = bl && bl.error ? 'responded_error' : 'responded_ok';
    if (!bl || !bl.error) {
      document.getElementById('status').style.color = '#16a34a';
      document.getElementById('status').textContent = '\\u2705 Complete';
      document.title = 'OK';
    }
  } catch(e) {
    if (e.apiError) apiErrors.push(Object.assign({retried: false}, e.apiError));
    window.__apiCallStatus = e.apiError ? 'responded_' + e.apiError.status : 'responded_error';
    window.__ahrefsResult = JSON.stringify({
      error: 'api_error',
      message: e.message,
      apiErrors: apiErrors.length ? apiErrors : undefined
    });
    mark('ahrefs.error', {message: e.message});
    showError('api_error', e.message);
  }
}
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  async onload="turnstile.render('#ts',{sitekey:'${p.sitekey}',action:'${p.action}',callback:onToken,theme:'light'})">
</script>
</body>
</html>`;

/**
 * Minimal turnstile page for traffic scraping.
 * Renders turnstile, calls traffic overview API on solve.
 */
export const minimalTrafficHtml = (p: HtmlParams): string => `<!DOCTYPE html>
<html>
<head><title>Verifying</title></head>
<body>
<div id="ts"></div>
<div id="status" style="font-family:monospace;font-size:16px;padding:8px;">Solving Turnstile challenge...</div>
<div id="err" style="display:none;background:#dc2626;color:#fff;font-family:monospace;font-size:18px;font-weight:bold;padding:14px 16px;margin:8px 0;border-radius:4px;white-space:pre-wrap;"></div>
<script>
window.__ahrefsResult = null;
window.__turnstileToken = null;
window.__apiCallStatus = 'not_called';


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

mark('turnstile.solving', {});

async function fetchJSON(endpoint, url, options) {
  var resp = await fetch(url, options);
  var body = await resp.text();
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
}

async function onToken(token) {
  window.__turnstileToken = token;
  window.__turnstileSolved = true;
  window.__blockNavigation = true;
  mark('turnstile.token_received', {});
  try {
    navigator.sendBeacon('http://127.0.0.1:3000/internal/cf-solved',
      JSON.stringify({s:'${p.sessionId}',t:'${p.targetId}',l:token.length}));
  } catch(e) {}

  document.getElementById('status').textContent = 'Token received, calling API...';
  window.__apiCallStatus = 'pending';
  var apiErrors = [];
  try {
    var ov = await fetchJSON('traffic', '/v4/stGetFreeTrafficOverview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json; charset=utf-8'},
      body: JSON.stringify({captcha: token, url: '${p.domain}', mode: 'subdomains', country: null, protocol: null})
    });
    mark('ahrefs.traffic', {});
    window.__ahrefsResult = JSON.stringify({
      success: true,
      overview: ov,
      apiErrors: apiErrors.length ? apiErrors : undefined
    });
    mark('ahrefs.complete', {success: true});
    window.__apiCallStatus = 'responded_ok';
    document.getElementById('status').style.color = '#16a34a';
    document.getElementById('status').textContent = '\\u2705 Complete';
    document.title = 'OK';
  } catch(e) {
    if (e.apiError) apiErrors.push(Object.assign({retried: false}, e.apiError));
    window.__apiCallStatus = e.apiError ? 'responded_' + e.apiError.status : 'responded_error';
    window.__ahrefsResult = JSON.stringify({
      error: 'api_error',
      message: e.message,
      apiErrors: apiErrors.length ? apiErrors : undefined
    });
    mark('ahrefs.error', {message: e.message});
    showError('api_error', e.message);
  }
}
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  async onload="turnstile.render('#ts',{sitekey:'${p.sitekey}',action:'${p.action}',callback:onToken,theme:'light'})">
</script>
</body>
</html>`;
