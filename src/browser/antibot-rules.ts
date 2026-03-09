/**
 * Antibot detection rules — typed constants derived from Scrapfly Antibot Detector.
 * 45 detectors across 3 categories: antibot, captcha, fingerprint.
 *
 * Each rule specifies detection methods: cookies, URLs, window properties,
 * DOM selectors, content patterns, and JS hook targets.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type DetectionMethod =
  | 'cookie'
  | 'url'
  | 'window'
  | 'dom'
  | 'content'
  | 'js_hook'
  | 'header';

export type DetectorCategory = 'antibot' | 'captcha' | 'fingerprint';

export interface CookieRule {
  pattern: string;
  isRegex?: boolean;
  confidence: number;
}

export interface UrlRule {
  pattern: string;
  isRegex?: boolean;
  confidence: number;
}

export interface WindowRule {
  path: string;
  expectedType?: string;
  confidence: number;
}

export interface DomRule {
  selector: string;
  confidence: number;
}

export interface ContentRule {
  pattern: string;
  confidence: number;
}

export interface HeaderRule {
  pattern: string;
  isRegex?: boolean;
  confidence: number;
}

export interface JsHookRule {
  target: string;       // e.g. "HTMLCanvasElement.prototype.toDataURL"
  confidence: number;
  enabled: boolean;
}

export interface DetectorRule {
  id: string;
  name: string;
  category: DetectorCategory;
  cookies?: CookieRule[];
  urls?: UrlRule[];
  windows?: WindowRule[];
  dom?: DomRule[];
  content?: ContentRule[];
  headers?: HeaderRule[];
  jsHooks?: JsHookRule[];
}

// ─── Antibot Detectors ─────────────────────────────────────────────────────

const detectAkamai: DetectorRule = {
  id: 'detect-akamai',
  name: 'Akamai Bot Manager',
  category: 'antibot',
  cookies: [
    { pattern: '_abck', confidence: 100 },
    { pattern: 'ak_bmsc', confidence: 60 },
    { pattern: 'sbsd', confidence: 100 },
    { pattern: 'sbsd_o', confidence: 100 },
    { pattern: 'bm_sz', confidence: 60 },
    { pattern: 'bm_sv', confidence: 60 },
    { pattern: 'bm_mi', confidence: 60 },
  ],
  urls: [
    { pattern: '/akam/', confidence: 100 },
    { pattern: '/.well-known/sbsd/', confidence: 100 },
    { pattern: '_sec/sbsd/', confidence: 100 },
  ],
  windows: [
    { path: 'bmak', expectedType: 'object', confidence: 95 },
  ],
};

const detectCloudflare: DetectorRule = {
  id: 'detect-cloudflare',
  name: 'Cloudflare Bot Management',
  category: 'antibot',
  cookies: [
    { pattern: '__cf_bm', confidence: 50 },
    { pattern: 'cf_clearance', confidence: 100 },
  ],
  urls: [
    { pattern: 'cdn-cgi/challenge-platform', confidence: 90 },
    { pattern: 'challenges.cloudflare.com', confidence: 100 },
  ],
  windows: [
    { path: '_cf_chl_opt', expectedType: 'object', confidence: 95 },
    { path: 'turnstile', expectedType: 'object', confidence: 95 },
  ],
};

const detectAwsWaf: DetectorRule = {
  id: 'detect-aws-waf',
  name: 'AWS WAF',
  category: 'antibot',
  cookies: [
    { pattern: 'aws-waf-token', confidence: 100 },
    { pattern: '^awswaf', isRegex: true, confidence: 100 },
  ],
  urls: [
    { pattern: '/challenge.js', confidence: 100 },
    { pattern: 'awswaf', confidence: 85 },
    { pattern: '/inputs?client=browser', confidence: 90 },
  ],
};

const detectDataDome: DetectorRule = {
  id: 'detect-datadome',
  name: 'DataDome',
  category: 'antibot',
  cookies: [
    { pattern: '^datadome$', isRegex: true, confidence: 100 },
  ],
  headers: [
    { pattern: '^x-datadome-cid$', isRegex: true, confidence: 100 },
  ],
};

const detectF5: DetectorRule = {
  id: 'detect-f5',
  name: 'F5 BIG-IP ASM',
  category: 'antibot',
  cookies: [
    { pattern: '^TS[a-zA-Z0-9]+$', isRegex: true, confidence: 100 },
    { pattern: '^BIGipServer', isRegex: true, confidence: 60 },
  ],
};

const detectIncapsula: DetectorRule = {
  id: 'detect-incapsula',
  name: 'Incapsula/Imperva',
  category: 'antibot',
  cookies: [
    { pattern: 'incap_ses_', confidence: 100 },
    { pattern: 'visid_incap_', confidence: 95 },
    { pattern: 'nlbi_', confidence: 90 },
    { pattern: 'reese84', confidence: 100 },
    { pattern: 'utmvc', confidence: 100 },
  ],
  urls: [
    { pattern: 'incapsula.com', confidence: 100 },
    { pattern: '/_Incapsula_Resource', confidence: 100 },
  ],
  content: [
    { pattern: '_Incapsula', confidence: 50 },
    { pattern: 'incapsula', confidence: 50 },
  ],
  windows: [
    { path: '_Incapsula', expectedType: 'object', confidence: 100 },
  ],
};

const detectPerimeterX: DetectorRule = {
  id: 'detect-perimeterx',
  name: 'PerimeterX',
  category: 'antibot',
  cookies: [
    { pattern: '_px2', confidence: 100 },
    { pattern: '_px3', confidence: 100 },
    { pattern: '_pxhd', confidence: 100 },
    { pattern: '_pxvid', confidence: 100 },
  ],
  urls: [
    { pattern: 'perimeterx.net', confidence: 100 },
  ],
  content: [
    { pattern: '_pxAppId', confidence: 50 },
    { pattern: 'pxInit', confidence: 50 },
  ],
  windows: [
    { path: '_pxAppId', expectedType: 'string', confidence: 100 },
    { path: 'pxInit', expectedType: 'function', confidence: 95 },
    { path: '_pxAction', expectedType: 'string', confidence: 90 },
  ],
};

const detectShapeSecurity: DetectorRule = {
  id: 'detect-shapesecurity',
  name: 'Shape Security',
  category: 'antibot',
  headers: [
    { pattern: '^x-[a-z0-9]{8}-a$', isRegex: true, confidence: 100 },
    { pattern: '^x-[a-z0-9]{8}-b$', isRegex: true, confidence: 100 },
    { pattern: '^x-[a-z0-9]{8}-z$', isRegex: true, confidence: 100 },
  ],
  urls: [
    { pattern: '\\?seed=[A-Za-z0-9_\\-]+', isRegex: true, confidence: 100 },
  ],
  content: [
    { pattern: 'shapesecurity', confidence: 50 },
  ],
  windows: [
    { path: '__xr_bmobdb', expectedType: 'function', confidence: 100 },
  ],
};

const detectKasada: DetectorRule = {
  id: 'detect-kasada',
  name: 'Kasada',
  category: 'antibot',
  urls: [
    { pattern: 'ips.js', confidence: 95 },
  ],
  content: [
    { pattern: 'kasada', confidence: 50 },
  ],
};

const detectReblaze: DetectorRule = {
  id: 'detect-reblaze',
  name: 'Reblaze',
  category: 'antibot',
  cookies: [
    { pattern: 'rbzid', confidence: 100 },
    { pattern: 'rbzsessionid', confidence: 100 },
  ],
  content: [
    { pattern: 'rbzid', confidence: 50 },
    { pattern: 'reblaze', confidence: 50 },
  ],
};

const detectSucuri: DetectorRule = {
  id: 'detect-sucuri',
  name: 'Sucuri WAF',
  category: 'antibot',
  content: [
    { pattern: 'sucuri', confidence: 50 },
  ],
};

const detectThreatMetrix: DetectorRule = {
  id: 'detect-threatmetrix',
  name: 'ThreatMetrix',
  category: 'antibot',
  urls: [
    { pattern: 'fp/check.js', confidence: 95 },
  ],
  content: [
    { pattern: 'ThreatMetrix', confidence: 50 },
  ],
  windows: [
    { path: 'BNQL', expectedType: 'object', confidence: 90 },
  ],
};

const detectMeetrics: DetectorRule = {
  id: 'detect-meetrics',
  name: 'Meetrics',
  category: 'antibot',
  urls: [
    { pattern: 'mxcdn.net/bb-mx/serve/mtrcs', confidence: 100 },
  ],
  content: [
    { pattern: 'meetricsGlobal', confidence: 50 },
    { pattern: 'meetrics', confidence: 50 },
  ],
  windows: [
    { path: 'meetricsGlobal', expectedType: 'object', confidence: 100 },
  ],
};

const detectOcule: DetectorRule = {
  id: 'detect-ocule',
  name: 'Ocule',
  category: 'antibot',
  urls: [
    { pattern: 'proxy.ocule.co.uk/script.js', confidence: 100 },
    { pattern: 'ocule.co.uk', confidence: 95 },
  ],
};

const detectCheq: DetectorRule = {
  id: 'detect-cheq',
  name: 'Cheq',
  category: 'antibot',
  urls: [
    { pattern: 'clicktrue_invocation.js', confidence: 100 },
    { pattern: 'cheqzone.com', confidence: 100 },
    { pattern: 'cheq.ai', confidence: 95 },
  ],
  content: [
    { pattern: 'CheqSdk', confidence: 50 },
    { pattern: 'cheq_invalidUsers', confidence: 50 },
  ],
  windows: [
    { path: 'CheqSdk', expectedType: 'object', confidence: 100 },
    { path: 'cheq_invalidUsers', expectedType: 'function', confidence: 95 },
  ],
};

const detectBotGuard: DetectorRule = {
  id: 'detect-botguard',
  name: 'Google BotGuard',
  category: 'antibot',
};

// ─── CAPTCHA Detectors ─────────────────────────────────────────────────────

const detectRecaptcha: DetectorRule = {
  id: 'detect-recaptcha',
  name: 'Google reCAPTCHA',
  category: 'captcha',
  urls: [
    { pattern: 'recaptcha/api', confidence: 100 },
    { pattern: 'gstatic.com/recaptcha', confidence: 100 },
    { pattern: 'google.com/recaptcha', confidence: 100 },
    { pattern: 'recaptcha.net', confidence: 100 },
  ],
  content: [
    { pattern: 'grecaptcha', confidence: 50 },
    { pattern: 'g-recaptcha', confidence: 50 },
  ],
  dom: [
    { selector: '.g-recaptcha', confidence: 100 },
    { selector: '[data-sitekey]', confidence: 50 },
    { selector: "iframe[src*='recaptcha']", confidence: 100 },
  ],
  windows: [
    { path: 'grecaptcha', expectedType: 'object', confidence: 100 },
    { path: '___grecaptcha_cfg', expectedType: 'object', confidence: 100 },
  ],
};

const detectHcaptcha: DetectorRule = {
  id: 'detect-hcaptcha',
  name: 'hCaptcha',
  category: 'captcha',
  urls: [
    { pattern: 'hcaptcha.com', confidence: 100 },
  ],
  content: [
    { pattern: 'hcaptcha', confidence: 50 },
    { pattern: 'h-captcha', confidence: 50 },
  ],
  dom: [
    { selector: '.h-captcha', confidence: 100 },
    { selector: '[data-hcaptcha-sitekey]', confidence: 100 },
    { selector: "iframe[src*='hcaptcha.com']", confidence: 100 },
  ],
  windows: [
    { path: 'hcaptcha', expectedType: 'object', confidence: 100 },
  ],
};

const detectFuncaptcha: DetectorRule = {
  id: 'detect-funcaptcha',
  name: 'FunCaptcha/Arkose Labs',
  category: 'captcha',
  urls: [
    { pattern: 'client-api.arkoselabs.com', confidence: 100 },
    { pattern: 'api.funcaptcha.com', confidence: 100 },
  ],
  content: [
    { pattern: 'ArkoseEnforce', confidence: 50 },
    { pattern: 'funcaptcha', confidence: 50 },
  ],
  dom: [
    { selector: '[data-arkose]', confidence: 100 },
    { selector: '.arkose-labs', confidence: 95 },
    { selector: '#FunCaptcha', confidence: 90 },
  ],
  windows: [
    { path: 'ArkoseEnforce', expectedType: 'object', confidence: 100 },
    { path: 'arkoseCallback', expectedType: 'function', confidence: 95 },
  ],
};

const detectGeetest: DetectorRule = {
  id: 'detect-geetest',
  name: 'GeeTest',
  category: 'captcha',
  urls: [
    { pattern: 'api.geetest.com', confidence: 100 },
    { pattern: 'static.geetest.com', confidence: 100 },
  ],
  content: [
    { pattern: 'initGeetest', confidence: 50 },
    { pattern: 'geetest', confidence: 50 },
  ],
};

const detectQcloud: DetectorRule = {
  id: 'detect-qcloud',
  name: 'QCloud/Tencent Captcha',
  category: 'captcha',
  urls: [
    { pattern: 'turing.captcha.qcloud.com', confidence: 100 },
    { pattern: 'turing.captcha.gtimg.com', confidence: 100 },
  ],
  content: [
    { pattern: 'TencentCaptcha', confidence: 50 },
  ],
  dom: [
    { selector: '#tencent_captcha', confidence: 95 },
    { selector: "iframe[src*='turing.captcha.qcloud.com']", confidence: 100 },
  ],
  windows: [
    { path: 'TencentCaptcha', expectedType: 'function', confidence: 100 },
  ],
};

const detectAliexpress: DetectorRule = {
  id: 'detect-aliexpress',
  name: 'AliExpress CAPTCHA',
  category: 'captcha',
  urls: [
    { pattern: 'punish?x5secdata', confidence: 100 },
  ],
  content: [
    { pattern: 'x5secdata', confidence: 50 },
  ],
};

const detectFriendlyCaptcha: DetectorRule = {
  id: 'detect-friendlycaptcha',
  name: 'Friendly Captcha',
  category: 'captcha',
  urls: [
    { pattern: 'friendlycaptcha.com', confidence: 100 },
  ],
  content: [
    { pattern: 'frc-captcha', confidence: 50 },
    { pattern: 'friendlyChallenge', confidence: 50 },
  ],
  dom: [
    { selector: '.frc-captcha', confidence: 100 },
    { selector: "iframe[src*='friendlycaptcha.com']", confidence: 95 },
  ],
  windows: [
    { path: 'friendlyChallenge', expectedType: 'object', confidence: 95 },
  ],
};

const detectCaptchaEu: DetectorRule = {
  id: 'detect-captchaeu',
  name: 'Captcha.eu',
  category: 'captcha',
  urls: [
    { pattern: 'captcha.eu', confidence: 100 },
  ],
  content: [
    { pattern: 'CaptchaEU', confidence: 50 },
    { pattern: 'captchaeu', confidence: 50 },
  ],
  dom: [
    { selector: '.captchaeu-widget', confidence: 100 },
    { selector: "iframe[src*='captcha.eu']", confidence: 100 },
    { selector: 'div[data-captchaeu-sitekey]', confidence: 100 },
  ],
  windows: [
    { path: 'CaptchaEU', expectedType: 'object', confidence: 100 },
  ],
};

// ─── Fingerprint Detectors ─────────────────────────────────────────────────

const detectCanvasFingerprint: DetectorRule = {
  id: 'detect-canvas-fingerprint',
  name: 'Canvas Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'HTMLCanvasElement.prototype.toDataURL', confidence: 100, enabled: true },
    { target: 'CanvasRenderingContext2D.prototype.getImageData', confidence: 100, enabled: true },
    { target: 'HTMLCanvasElement.prototype.toBlob', confidence: 85, enabled: true },
    { target: 'CanvasRenderingContext2D.prototype.measureText', confidence: 85, enabled: true },
    { target: 'OffscreenCanvas.prototype.getContext', confidence: 100, enabled: true },
  ],
};

const detectWebglFingerprint: DetectorRule = {
  id: 'detect-webgl-fingerprint',
  name: 'WebGL Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'WebGLRenderingContext.prototype.getParameter', confidence: 100, enabled: true },
    { target: 'WebGLRenderingContext.prototype.getSupportedExtensions', confidence: 100, enabled: true },
    { target: 'WebGLRenderingContext.prototype.getExtension', confidence: 85, enabled: true },
    { target: 'WebGL2RenderingContext.prototype.getParameter', confidence: 100, enabled: true },
    { target: 'WebGL2RenderingContext.prototype.readPixels', confidence: 100, enabled: true },
  ],
};

const detectAudioFingerprint: DetectorRule = {
  id: 'detect-audio-fingerprint',
  name: 'Audio Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'AudioBuffer.prototype.getChannelData', confidence: 100, enabled: true },
    { target: 'AnalyserNode.prototype.getFloatFrequencyData', confidence: 100, enabled: true },
    { target: 'BaseAudioContext.prototype.createOscillator', confidence: 85, enabled: true },
  ],
};

const detectWebrtcFingerprint: DetectorRule = {
  id: 'detect-webrtc-fingerprint',
  name: 'WebRTC Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'RTCPeerConnection.prototype.createDataChannel', confidence: 100, enabled: true },
    { target: 'MediaDevices.prototype.enumerateDevices', confidence: 100, enabled: true },
    { target: 'RTCPeerConnection.prototype.createOffer', confidence: 100, enabled: true },
    { target: 'RTCIceCandidate.prototype.address', confidence: 100, enabled: true },
  ],
};

const detectNavigatorFingerprint: DetectorRule = {
  id: 'detect-navigator-fingerprint',
  name: 'Navigator Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Navigator.prototype.userAgent', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.platform', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.webdriver', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.languages', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.hardwareConcurrency', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.deviceMemory', confidence: 80, enabled: true },
    { target: 'NavigatorUAData.prototype.getHighEntropyValues', confidence: 80, enabled: true },
  ],
};

const detectPerformanceFingerprint: DetectorRule = {
  id: 'detect-performance-fingerprint',
  name: 'Performance API Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Performance.prototype.now', confidence: 80, enabled: true },
    { target: 'Performance.prototype.memory', confidence: 80, enabled: true },
    { target: 'Performance.prototype.getEntriesByType', confidence: 80, enabled: true },
  ],
};

const detectStorageFingerprint: DetectorRule = {
  id: 'detect-storage-fingerprint',
  name: 'Storage Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Storage.prototype.setItem', confidence: 80, enabled: true },
    { target: 'Storage.prototype.getItem', confidence: 80, enabled: true },
    { target: 'Storage.prototype.clear', confidence: 80, enabled: true },
  ],
};

const detectScreenFingerprint: DetectorRule = {
  id: 'detect-screen-fingerprint',
  name: 'Screen Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Screen.prototype.width', confidence: 80, enabled: true },
    { target: 'Screen.prototype.height', confidence: 80, enabled: true },
    { target: 'Screen.prototype.availHeight', confidence: 80, enabled: true },
    { target: 'Screen.prototype.colorDepth', confidence: 80, enabled: true },
    { target: 'window.devicePixelRatio', confidence: 80, enabled: true },
  ],
};

const detectFontFingerprint: DetectorRule = {
  id: 'detect-font-fingerprint',
  name: 'Font Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'CanvasRenderingContext2D.prototype.measureText', confidence: 100, enabled: true },
    { target: 'Document.prototype.fonts', confidence: 85, enabled: true },
    { target: 'TextMetrics.prototype.width', confidence: 85, enabled: true },
  ],
};

const detectGeolocationFingerprint: DetectorRule = {
  id: 'detect-geolocation-fingerprint',
  name: 'Geolocation Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Geolocation.prototype.getCurrentPosition', confidence: 65, enabled: true },
    { target: 'Geolocation.prototype.watchPosition', confidence: 65, enabled: true },
  ],
};

const detectTimezoneFingerprint: DetectorRule = {
  id: 'detect-timezone-fingerprint',
  name: 'Timezone/Intl Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Intl.DateTimeFormat.prototype.resolvedOptions', confidence: 65, enabled: true },
    { target: 'Intl.Collator.prototype.compare', confidence: 65, enabled: true },
  ],
};

const detectHardwareFingerprint: DetectorRule = {
  id: 'detect-hardware-fingerprint',
  name: 'Hardware Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Navigator.prototype.hardwareConcurrency', confidence: 80, enabled: true },
    { target: 'Navigator.prototype.deviceMemory', confidence: 80, enabled: true },
  ],
  windows: [
    { path: 'navigator.maxTouchPoints', expectedType: 'number', confidence: 80 },
  ],
};

const detectClipboardFingerprint: DetectorRule = {
  id: 'detect-clipboard-fingerprint',
  name: 'Clipboard Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Clipboard.prototype.read', confidence: 65, enabled: true },
    { target: 'Clipboard.prototype.readText', confidence: 65, enabled: true },
    { target: 'Clipboard.prototype.write', confidence: 65, enabled: true },
  ],
};

const detectBatteryFingerprint: DetectorRule = {
  id: 'detect-battery-fingerprint',
  name: 'Battery API Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Navigator.prototype.getBattery', confidence: 65, enabled: true },
  ],
};

const detectMediaFingerprint: DetectorRule = {
  id: 'detect-media-fingerprint',
  name: 'Media Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'HTMLMediaElement.prototype.canPlayType', confidence: 80, enabled: true },
  ],
  windows: [
    { path: 'speechSynthesis', expectedType: 'object', confidence: 80 },
  ],
};

const detectGamepadsFingerprint: DetectorRule = {
  id: 'detect-gamepads-fingerprint',
  name: 'Gamepads Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Navigator.prototype.getGamepads', confidence: 80, enabled: true },
  ],
};

const detectUsbFingerprint: DetectorRule = {
  id: 'detect-usb-fingerprint',
  name: 'USB API Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'USB.prototype.getDevices', confidence: 80, enabled: true },
    { target: 'USB.prototype.requestDevice', confidence: 80, enabled: true },
  ],
};

const detectIndexedDbFingerprint: DetectorRule = {
  id: 'detect-indexeddb-fingerprint',
  name: 'IndexedDB Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'IDBFactory.prototype.open', confidence: 80, enabled: true },
    { target: 'IDBFactory.prototype.databases', confidence: 80, enabled: true },
    { target: 'IDBDatabase.prototype.transaction', confidence: 80, enabled: true },
  ],
};

const detectCryptoFingerprint: DetectorRule = {
  id: 'detect-crypto-fingerprint',
  name: 'Crypto Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'Crypto.prototype.getRandomValues', confidence: 80, enabled: true },
    { target: 'SubtleCrypto.prototype.digest', confidence: 80, enabled: true },
  ],
};

const detectOrientationFingerprint: DetectorRule = {
  id: 'detect-orientation-fingerprint',
  name: 'Orientation Fingerprinting',
  category: 'fingerprint',
  windows: [
    { path: 'DeviceOrientationEvent', expectedType: 'function', confidence: 65 },
    { path: 'DeviceMotionEvent', expectedType: 'function', confidence: 65 },
  ],
};

const detectCssFingerprint: DetectorRule = {
  id: 'detect-css-fingerprint',
  name: 'CSS Fingerprinting',
  category: 'fingerprint',
  jsHooks: [
    { target: 'CSSStyleDeclaration.prototype.getPropertyValue', confidence: 80, enabled: true },
  ],
  windows: [
    { path: 'CSS.supports', expectedType: 'function', confidence: 80 },
  ],
};

// ─── Exports ───────────────────────────────────────────────────────────────

/** All 45 detector rules. */
export const ALL_RULES: readonly DetectorRule[] = [
  // Antibot (16)
  detectAkamai,
  detectCloudflare,
  detectAwsWaf,
  detectDataDome,
  detectF5,
  detectIncapsula,
  detectPerimeterX,
  detectShapeSecurity,
  detectKasada,
  detectReblaze,
  detectSucuri,
  detectThreatMetrix,
  detectMeetrics,
  detectOcule,
  detectCheq,
  detectBotGuard,
  // CAPTCHA (8)
  detectRecaptcha,
  detectHcaptcha,
  detectFuncaptcha,
  detectGeetest,
  detectQcloud,
  detectAliexpress,
  detectFriendlyCaptcha,
  detectCaptchaEu,
  // Fingerprint (21)
  detectCanvasFingerprint,
  detectWebglFingerprint,
  detectAudioFingerprint,
  detectWebrtcFingerprint,
  detectNavigatorFingerprint,
  detectPerformanceFingerprint,
  detectStorageFingerprint,
  detectScreenFingerprint,
  detectFontFingerprint,
  detectGeolocationFingerprint,
  detectTimezoneFingerprint,
  detectHardwareFingerprint,
  detectClipboardFingerprint,
  detectBatteryFingerprint,
  detectMediaFingerprint,
  detectGamepadsFingerprint,
  detectUsbFingerprint,
  detectIndexedDbFingerprint,
  detectCryptoFingerprint,
  detectOrientationFingerprint,
  detectCssFingerprint,
];

/** All enabled JS hook targets across all detectors (deduplicated). */
export const ALL_HOOK_TARGETS: readonly JsHookRule[] = (() => {
  const seen = new Set<string>();
  const hooks: JsHookRule[] = [];
  for (const rule of ALL_RULES) {
    if (!rule.jsHooks) continue;
    for (const hook of rule.jsHooks) {
      if (!hook.enabled || seen.has(hook.target)) continue;
      seen.add(hook.target);
      hooks.push(hook);
    }
  }
  return hooks;
})();
