/**
 * Antibot Detection — browser-side IIFE injected via Page.addScriptToEvaluateOnNewDocument.
 *
 * Two-part detection:
 * Part A: JS Hook installation (runs BEFORE page scripts — catches fingerprinting)
 * Part B: Post-load analysis (runs after DOMContentLoaded + settle — cookies, DOM, window, content)
 *
 * Results pushed via __rrwebPush binding (multiplexed with rrweb events).
 * Server distinguishes antibot events from rrweb batches by the object type field.
 */
import { ALL_RULES, ALL_HOOK_TARGETS, type DetectorRule, type JsHookRule } from './antibot-rules';

// ─── Types ─────────────────────────────────────────────────────────────────

interface Evidence {
  method: string;
  detail: string;
  confidence: number;
}

interface Detection {
  id: string;
  name: string;
  category: string;
  confidence: number;
  evidence: Evidence[];
}

interface AntibotReport {
  type: 'antibot_report';
  detections: Detection[];
  hookCounts: Record<string, number>;
  timing: { hooksInstalledMs: number; analysisMs: number; totalMs: number };
}

// ─── Hook counters ─────────────────────────────────────────────────────────
// Maps hook target → call count. Written by Part A wrappers, read by Part B analysis.

const hookCounts: Record<string, number> = {};
const t0 = performance.now();

// ═══════════════════════════════════════════════════════════════════════════
// Part A: Install JS Hooks (synchronous, runs before page scripts)
// ═══════════════════════════════════════════════════════════════════════════

function installHook(hook: JsHookRule): boolean {
  const parts = hook.target.split('.');
  // Resolve the object path: e.g. "HTMLCanvasElement.prototype" → window.HTMLCanvasElement.prototype
  // Special case: "window.devicePixelRatio" → window
  let obj: any = window;
  const propName = parts[parts.length - 1];

  // Navigate to parent object
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === 'window') continue; // skip "window" prefix
    obj = obj[part];
    if (obj == null) return false; // API not available in this browser
  }

  // Get original descriptor
  const desc = Object.getOwnPropertyDescriptor(obj, propName);
  if (!desc) return false;

  const target = hook.target;
  hookCounts[target] = 0;

  if (desc.get) {
    // Property getter — wrap with transparent getter
    const originalGet = desc.get;
    Object.defineProperty(obj, propName, {
      ...desc,
      get() {
        hookCounts[target]++;
        return originalGet.call(this);
      },
    });
  } else if (typeof desc.value === 'function') {
    // Method — wrap with transparent function
    const original = desc.value;
    const wrapper = function(this: any, ...args: any[]) {
      hookCounts[target]++;
      return original.apply(this, args);
    };
    // Stealth: match original function signature
    Object.defineProperty(wrapper, 'name', { value: original.name });
    Object.defineProperty(wrapper, 'length', { value: original.length });
    Object.defineProperty(wrapper, 'toString', {
      value: () => Function.prototype.toString.call(original),
    });
    if (original.prototype) {
      wrapper.prototype = original.prototype;
    }
    Object.defineProperty(obj, propName, { ...desc, value: wrapper });
  } else {
    // Non-function value (e.g. window.devicePixelRatio) — wrap with getter
    let currentValue = desc.value;
    Object.defineProperty(obj, propName, {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      get() {
        hookCounts[target]++;
        return currentValue;
      },
      set(v) {
        currentValue = v;
      },
    });
  }
  return true;
}

// Install all enabled hooks
let hooksInstalled = 0;
for (const hook of ALL_HOOK_TARGETS) {
  try {
    if (installHook(hook)) hooksInstalled++;
  } catch (_) {
    // Graceful — some APIs may not exist
  }
}
const hooksInstalledMs = performance.now() - t0;

// ═══════════════════════════════════════════════════════════════════════════
// Part B: Post-load Analysis (after DOMContentLoaded + 2s settle)
// ═══════════════════════════════════════════════════════════════════════════

function emit(report: AntibotReport): void {
  if (typeof (window as any).__rrwebPush === 'function') {
    try {
      (window as any).__rrwebPush(JSON.stringify(report));
    } catch (_) {}
  }
}

function matchesPattern(value: string, pattern: string, isRegex?: boolean): boolean {
  if (isRegex) {
    try {
      return new RegExp(pattern, 'i').test(value);
    } catch (_) {
      return false;
    }
  }
  return value.toLowerCase().includes(pattern.toLowerCase());
}

function checkCookies(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.cookies?.length) return evidence;

  const cookieStr = document.cookie;
  const cookies = cookieStr.split(';').map(c => c.trim().split('=')[0]);

  for (const cr of rule.cookies) {
    for (const name of cookies) {
      if (matchesPattern(name, cr.pattern, cr.isRegex)) {
        evidence.push({ method: 'cookie', detail: name, confidence: cr.confidence });
        break; // one match per rule is enough
      }
    }
  }
  return evidence;
}

function checkWindow(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.windows?.length) return evidence;

  for (const wr of rule.windows) {
    try {
      const parts = wr.path.split('.');
      let obj: any = window;
      for (const part of parts) {
        if (part === 'window') continue;
        obj = obj[part];
        if (obj == null) break;
      }
      if (obj != null) {
        const actualType = typeof obj;
        if (!wr.expectedType || actualType === wr.expectedType) {
          evidence.push({ method: 'window', detail: wr.path, confidence: wr.confidence });
        }
      }
    } catch (_) {}
  }
  return evidence;
}

function checkDom(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.dom?.length) return evidence;

  for (const dr of rule.dom) {
    try {
      if (document.querySelector(dr.selector)) {
        evidence.push({ method: 'dom', detail: dr.selector, confidence: dr.confidence });
      }
    } catch (_) {}
  }
  return evidence;
}

function checkContent(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.content?.length) return evidence;

  // Sample page content (first 500KB to avoid OOM on huge pages)
  const html = document.documentElement.outerHTML.slice(0, 500_000);

  for (const cr of rule.content) {
    if (html.toLowerCase().includes(cr.pattern.toLowerCase())) {
      evidence.push({ method: 'content', detail: cr.pattern, confidence: cr.confidence });
    }
  }
  return evidence;
}

function checkUrls(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.urls?.length) return evidence;

  // Collect all script src URLs + performance resource entries
  const urls = new Set<string>();

  // Script tags
  const scripts = document.querySelectorAll('script[src]');
  scripts.forEach(s => {
    const src = s.getAttribute('src');
    if (src) urls.add(src);
  });

  // Performance API — catches dynamically loaded resources
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const entry of entries) {
      urls.add(entry.name);
    }
  } catch (_) {}

  // Current page URL
  urls.add(location.href);

  // Link tags (stylesheets, preloads)
  const links = document.querySelectorAll('link[href]');
  links.forEach(l => {
    const href = l.getAttribute('href');
    if (href) urls.add(href);
  });

  // Iframe sources
  const iframes = document.querySelectorAll('iframe[src]');
  iframes.forEach(f => {
    const src = f.getAttribute('src');
    if (src) urls.add(src);
  });

  for (const ur of rule.urls) {
    for (const url of urls) {
      if (matchesPattern(url, ur.pattern, ur.isRegex)) {
        evidence.push({ method: 'url', detail: `${ur.pattern} → ${url.slice(0, 120)}`, confidence: ur.confidence });
        break;
      }
    }
  }
  return evidence;
}

function checkHooks(rule: DetectorRule): Evidence[] {
  const evidence: Evidence[] = [];
  if (!rule.jsHooks?.length) return evidence;

  for (const hook of rule.jsHooks) {
    if (!hook.enabled) continue;
    const count = hookCounts[hook.target] ?? 0;
    if (count > 0) {
      evidence.push({
        method: 'js_hook',
        detail: `${hook.target} (${count} calls)`,
        confidence: hook.confidence,
      });
    }
  }
  return evidence;
}

function runAnalysis(): void {
  const analysisStart = performance.now();
  const detections: Detection[] = [];

  for (const rule of ALL_RULES) {
    const evidence: Evidence[] = [
      ...checkCookies(rule),
      ...checkWindow(rule),
      ...checkDom(rule),
      ...checkContent(rule),
      ...checkUrls(rule),
      ...checkHooks(rule),
    ];

    if (evidence.length > 0) {
      const confidence = Math.max(...evidence.map(e => e.confidence));
      detections.push({
        id: rule.id,
        name: rule.name,
        category: rule.category,
        confidence,
        evidence,
      });
    }
  }

  const analysisMs = performance.now() - analysisStart;
  const totalMs = performance.now() - t0;

  // Only the hook counts for hooks that were actually called
  const activeHookCounts: Record<string, number> = {};
  for (const [target, count] of Object.entries(hookCounts)) {
    if (count > 0) activeHookCounts[target] = count;
  }

  emit({
    type: 'antibot_report',
    detections,
    hookCounts: activeHookCounts,
    timing: {
      hooksInstalledMs: Math.round(hooksInstalledMs * 100) / 100,
      analysisMs: Math.round(analysisMs * 100) / 100,
      totalMs: Math.round(totalMs * 100) / 100,
    },
  });
}

// ─── Scheduling ────────────────────────────────────────────────────────────
// Wait for DOMContentLoaded + 2s settle (matches Scrapfly's inactivity timeout)
// then run analysis. Max wait: 8s after DOMContentLoaded.

const SETTLE_MS = 2000;
const MAX_WAIT_MS = 8000;

function scheduleAnalysis(): void {
  // DOMContentLoaded already fired or fires now
  let settled = false;

  const run = () => {
    if (settled) return;
    settled = true;
    runAnalysis();
  };

  // 2s after DOMContentLoaded for scripts to load + fingerprint
  setTimeout(run, SETTLE_MS);

  // Hard deadline
  setTimeout(run, MAX_WAIT_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleAnalysis, { once: true });
} else {
  scheduleAnalysis();
}
