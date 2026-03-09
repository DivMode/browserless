/**
 * Server-side antibot detection handler.
 *
 * Receives browser-side antibot_report events and merges with server-side
 * URL/header observations from CDP Network events.
 *
 * Emits a unified report as a custom CDP event and replay marker.
 */
import { Logger } from '@browserless.io/browserless';

/** Browser-side evidence from antibot-detect.ts */
interface BrowserEvidence {
  method: string;
  detail: string;
  confidence: number;
}

interface BrowserDetection {
  id: string;
  name: string;
  category: string;
  confidence: number;
  evidence: BrowserEvidence[];
}

/** The browser-side report pushed via __rrwebPush. */
export interface AntibotBrowserReport {
  type: 'antibot_report';
  detections: BrowserDetection[];
  hookCounts: Record<string, number>;
  timing: { hooksInstalledMs: number; analysisMs: number; totalMs: number };
}

/** Server-side evidence from Network.* CDP events. */
interface ServerEvidence {
  method: 'url' | 'header';
  detail: string;
  confidence: number;
}

/** URL pattern rules for server-side matching. */
const URL_RULES: Array<{ detectorId: string; patterns: Array<{ pattern: string; confidence: number }> }> = [
  {
    detectorId: 'detect-akamai',
    patterns: [
      { pattern: '/akam/', confidence: 100 },
      { pattern: '/.well-known/sbsd/', confidence: 100 },
      { pattern: '_sec/sbsd/', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-cloudflare',
    patterns: [
      { pattern: 'cdn-cgi/challenge-platform', confidence: 90 },
      { pattern: 'challenges.cloudflare.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-aws-waf',
    patterns: [
      { pattern: '/challenge.js', confidence: 100 },
      { pattern: 'awswaf', confidence: 85 },
    ],
  },
  {
    detectorId: 'detect-datadome',
    patterns: [
      { pattern: 'datadome.co', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-incapsula',
    patterns: [
      { pattern: 'incapsula.com', confidence: 100 },
      { pattern: '/_Incapsula_Resource', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-perimeterx',
    patterns: [
      { pattern: 'perimeterx.net', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-kasada',
    patterns: [
      { pattern: 'ips.js', confidence: 95 },
    ],
  },
  {
    detectorId: 'detect-recaptcha',
    patterns: [
      { pattern: 'recaptcha/api', confidence: 100 },
      { pattern: 'gstatic.com/recaptcha', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-hcaptcha',
    patterns: [
      { pattern: 'hcaptcha.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-funcaptcha',
    patterns: [
      { pattern: 'client-api.arkoselabs.com', confidence: 100 },
      { pattern: 'api.funcaptcha.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-geetest',
    patterns: [
      { pattern: 'api.geetest.com', confidence: 100 },
      { pattern: 'static.geetest.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-meetrics',
    patterns: [
      { pattern: 'mxcdn.net/bb-mx/serve/mtrcs', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-cheq',
    patterns: [
      { pattern: 'clicktrue_invocation.js', confidence: 100 },
      { pattern: 'cheqzone.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-friendlycaptcha',
    patterns: [
      { pattern: 'friendlycaptcha.com', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-captchaeu',
    patterns: [
      { pattern: 'captcha.eu', confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-threatmetrix',
    patterns: [
      { pattern: 'fp/check.js', confidence: 95 },
    ],
  },
];

/** Header pattern rules for server-side matching. */
const HEADER_RULES: Array<{ detectorId: string; patterns: Array<{ pattern: RegExp; confidence: number }> }> = [
  {
    detectorId: 'detect-datadome',
    patterns: [
      { pattern: /^x-datadome-cid$/i, confidence: 100 },
    ],
  },
  {
    detectorId: 'detect-shapesecurity',
    patterns: [
      { pattern: /^x-[a-z0-9]{8}-[a-z]$/i, confidence: 100 },
    ],
  },
];

/** Detector metadata for creating new detections from server-side evidence. */
const DETECTOR_META: Record<string, { name: string; category: string }> = {
  'detect-akamai': { name: 'Akamai Bot Manager', category: 'antibot' },
  'detect-cloudflare': { name: 'Cloudflare Bot Management', category: 'antibot' },
  'detect-aws-waf': { name: 'AWS WAF', category: 'antibot' },
  'detect-datadome': { name: 'DataDome', category: 'antibot' },
  'detect-incapsula': { name: 'Incapsula/Imperva', category: 'antibot' },
  'detect-perimeterx': { name: 'PerimeterX', category: 'antibot' },
  'detect-shapesecurity': { name: 'Shape Security', category: 'antibot' },
  'detect-kasada': { name: 'Kasada', category: 'antibot' },
  'detect-recaptcha': { name: 'Google reCAPTCHA', category: 'captcha' },
  'detect-hcaptcha': { name: 'hCaptcha', category: 'captcha' },
  'detect-funcaptcha': { name: 'FunCaptcha/Arkose Labs', category: 'captcha' },
  'detect-geetest': { name: 'GeeTest', category: 'captcha' },
  'detect-meetrics': { name: 'Meetrics', category: 'antibot' },
  'detect-cheq': { name: 'Cheq', category: 'antibot' },
  'detect-friendlycaptcha': { name: 'Friendly Captcha', category: 'captcha' },
  'detect-captchaeu': { name: 'Captcha.eu', category: 'captcha' },
  'detect-threatmetrix': { name: 'ThreatMetrix', category: 'antibot' },
};

/** Final unified detection result. */
export interface AntibotDetection {
  id: string;
  name: string;
  category: string;
  confidence: number;
  evidence: Array<{ method: string; detail: string; confidence: number }>;
}

export interface AntibotResult {
  detections: AntibotDetection[];
  hookCounts: Record<string, number>;
  timing: { hooksInstalledMs: number; analysisMs: number; totalMs: number };
}

export class AntibotHandler {
  private log = new Logger('antibot');
  private observedUrls = new Set<string>();
  private observedHeaders = new Map<string, string[]>(); // url → header names
  private result: AntibotResult | null = null;

  /** Called from CDP Network.requestWillBeSent. */
  onRequest(url: string): void {
    this.observedUrls.add(url);
  }

  /** Called from CDP Network.responseReceived. */
  onResponse(url: string, headers: Record<string, string>): void {
    this.observedUrls.add(url);
    const headerNames = Object.keys(headers);
    if (headerNames.length > 0) {
      const existing = this.observedHeaders.get(url) ?? [];
      this.observedHeaders.set(url, [...existing, ...headerNames]);
    }
  }

  /** Process browser-side report and merge with server-side observations. */
  processReport(report: AntibotBrowserReport): AntibotResult {
    // Start with browser-side detections
    const detectionsMap = new Map<string, AntibotDetection>();
    for (const d of report.detections) {
      detectionsMap.set(d.id, {
        id: d.id,
        name: d.name,
        category: d.category,
        confidence: d.confidence,
        evidence: [...d.evidence],
      });
    }

    // Server-side URL matching
    const serverUrlEvidence = this.matchUrls();
    for (const [detectorId, evidence] of serverUrlEvidence) {
      const existing = detectionsMap.get(detectorId);
      if (existing) {
        existing.evidence.push(...evidence);
        existing.confidence = Math.max(existing.confidence, ...evidence.map(e => e.confidence));
      } else {
        const meta = DETECTOR_META[detectorId];
        if (meta) {
          detectionsMap.set(detectorId, {
            id: detectorId,
            name: meta.name,
            category: meta.category,
            confidence: Math.max(...evidence.map(e => e.confidence)),
            evidence,
          });
        }
      }
    }

    // Server-side header matching
    const serverHeaderEvidence = this.matchHeaders();
    for (const [detectorId, evidence] of serverHeaderEvidence) {
      const existing = detectionsMap.get(detectorId);
      if (existing) {
        existing.evidence.push(...evidence);
        existing.confidence = Math.max(existing.confidence, ...evidence.map(e => e.confidence));
      } else {
        const meta = DETECTOR_META[detectorId];
        if (meta) {
          detectionsMap.set(detectorId, {
            id: detectorId,
            name: meta.name,
            category: meta.category,
            confidence: Math.max(...evidence.map(e => e.confidence)),
            evidence,
          });
        }
      }
    }

    // Filter out fingerprinting detections with only weak evidence.
    // "Weak" = only window property checks (browser-native APIs that exist in every Chrome)
    // or only JS hook calls below the browser's noise floor.
    // Window properties like navigator.maxTouchPoints, CSS.supports, speechSynthesis are
    // always present — they indicate API existence, not actual fingerprinting activity.
    // Vendor-specific window properties (e.g. bmak for Akamai, _cf_chl_opt for Cloudflare)
    // ARE strong evidence because they prove the vendor's code is loaded.
    //
    // Chrome calls certain APIs internally on every page load. Calls at or below these
    // thresholds are noise from the browser itself, not from page scripts fingerprinting.
    const HOOK_NOISE_FLOOR: Record<string, number> = {
      'Performance.prototype.now': 5,
      'Performance.prototype.getEntriesByType': 25,
      'Performance.prototype.memory': 1,
      'Document.prototype.fonts': 2,
    };

    for (const [id, det] of detectionsMap) {
      if (det.category !== 'fingerprint') continue;

      const hasStrongEvidence = det.evidence.some(e => {
        if (e.method === 'window') return false; // always-present browser APIs
        if (e.method === 'js_hook') {
          const match = e.detail.match(/^(.+?)\s+\((\d+)\s+calls?\)$/);
          if (match) {
            const target = match[1];
            const count = parseInt(match[2], 10);
            const floor = HOOK_NOISE_FLOOR[target];
            return floor == null || count > floor; // no floor = always strong
          }
        }
        return true; // cookie, url, content, dom — always strong
      });

      if (!hasStrongEvidence) detectionsMap.delete(id);
    }

    // Sort: antibot first, then captcha, then fingerprint. Within each: highest confidence first.
    const categoryOrder = { antibot: 0, captcha: 1, fingerprint: 2 } as const;
    const detections = [...detectionsMap.values()].sort((a, b) => {
      const catA = categoryOrder[a.category as keyof typeof categoryOrder] ?? 3;
      const catB = categoryOrder[b.category as keyof typeof categoryOrder] ?? 3;
      if (catA !== catB) return catA - catB;
      return b.confidence - a.confidence;
    });

    this.result = {
      detections,
      hookCounts: report.hookCounts,
      timing: report.timing,
    };

    this.log.info(
      `Antibot report: ${detections.length} detections ` +
      `(${detections.filter(d => d.category === 'antibot').length} antibot, ` +
      `${detections.filter(d => d.category === 'captcha').length} captcha, ` +
      `${detections.filter(d => d.category === 'fingerprint').length} fingerprint) ` +
      `hooks=${Object.keys(report.hookCounts).length} ` +
      `timing=${report.timing.totalMs.toFixed(0)}ms`,
    );

    return this.result;
  }

  getResult(): AntibotResult | null {
    return this.result;
  }

  private matchUrls(): Map<string, ServerEvidence[]> {
    const matches = new Map<string, ServerEvidence[]>();
    for (const url of this.observedUrls) {
      for (const rule of URL_RULES) {
        for (const p of rule.patterns) {
          if (url.toLowerCase().includes(p.pattern.toLowerCase())) {
            const existing = matches.get(rule.detectorId) ?? [];
            existing.push({
              method: 'url',
              detail: `[server] ${p.pattern} → ${url.slice(0, 120)}`,
              confidence: p.confidence,
            });
            matches.set(rule.detectorId, existing);
            break; // one match per pattern is enough
          }
        }
      }
    }
    return matches;
  }

  private matchHeaders(): Map<string, ServerEvidence[]> {
    const matches = new Map<string, ServerEvidence[]>();
    for (const [url, headerNames] of this.observedHeaders) {
      for (const rule of HEADER_RULES) {
        for (const p of rule.patterns) {
          for (const name of headerNames) {
            if (p.pattern.test(name)) {
              const existing = matches.get(rule.detectorId) ?? [];
              existing.push({
                method: 'header',
                detail: `[server] ${name} on ${url.slice(0, 80)}`,
                confidence: p.confidence,
              });
              matches.set(rule.detectorId, existing);
            }
          }
        }
      }
    }
    return matches;
  }
}
