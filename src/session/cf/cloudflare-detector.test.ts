/**
 * Unit tests for:
 * - filterOwnedTargets — cross-tab OOPIF ownership filter
 * - classifyOOPIFDetection — OOPIF classification
 * - classifyNavigationOutcome — page navigation classification (tagged enum)
 * - classifyBridgeDetected — bridge 'detected' event classification (tagged enum)
 */
import { describe, expect, it } from 'vitest';
import { describe as effectDescribe, it as effectIt } from '@effect/vitest';
import { Effect, Latch } from 'effect';
import { TargetId, CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { CloudflareInfo, InterstitialCFType } from '../../shared/cloudflare-detection.js';
import { filterOwnedTargets, classifyOOPIFDetection, classifyNavigationOutcome, NavigationOutcome, classifyBridgeDetected, BridgeDetectedOutcome } from './cloudflare-detector.js';
import type { CFTargetMatch, CFDetected } from './cloudflare-solve-strategies.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { Resolution } from './cf-resolution.js';
import { MAX_RECHALLENGES } from './cf-schedules.js';

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

const makeTarget = (id: string): CFTargetMatch => ({
  targetId: id,
  url: `https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/${id}`,
  type: 'iframe',
  meta: { sitekey: null, action: null, mode: null, retry_count: 0 },
});

const pageA = TargetId.makeUnsafe('AAAA-page-target');
const pageB = TargetId.makeUnsafe('BBBB-page-target');

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('filterOwnedTargets', () => {
  it('keeps targets owned by the current page', () => {
    const oopif = makeTarget('oopif-1');
    const map = new Map<TargetId, TargetId>([
      [TargetId.makeUnsafe('oopif-1'), pageA],
    ]);

    const result = filterOwnedTargets([oopif], pageA, map);
    expect(result).toEqual([oopif]);
  });

  it('filters targets owned by a different page', () => {
    const oopif = makeTarget('oopif-1');
    const map = new Map<TargetId, TargetId>([
      [TargetId.makeUnsafe('oopif-1'), pageB],
    ]);

    const result = filterOwnedTargets([oopif], pageA, map);
    expect(result).toEqual([]);
  });

  it('keeps targets not yet registered (undefined owner)', () => {
    const oopif = makeTarget('oopif-1');
    const map = new Map<TargetId, TargetId>(); // empty — no ownership recorded yet

    const result = filterOwnedTargets([oopif], pageA, map);
    expect(result).toEqual([oopif]);
  });

  it('filters cross-tab phantoms while keeping own + unregistered', () => {
    const own = makeTarget('own-oopif');
    const crossTab = makeTarget('other-oopif');
    const unregistered = makeTarget('new-oopif');

    const map = new Map<TargetId, TargetId>([
      [TargetId.makeUnsafe('own-oopif'), pageA],
      [TargetId.makeUnsafe('other-oopif'), pageB],
      // 'new-oopif' deliberately absent — simulates race where iframe attached but not yet tracked
    ]);

    const result = filterOwnedTargets([own, crossTab, unregistered], pageA, map);
    expect(result).toEqual([own, unregistered]);
  });

  it('returns empty array when all targets belong to other pages', () => {
    const t1 = makeTarget('oopif-1');
    const t2 = makeTarget('oopif-2');

    const map = new Map<TargetId, TargetId>([
      [TargetId.makeUnsafe('oopif-1'), pageB],
      [TargetId.makeUnsafe('oopif-2'), pageB],
    ]);

    const result = filterOwnedTargets([t1, t2], pageA, map);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// classifyOOPIFDetection
// ═══════════════════════════════════════════════════════════════════════

describe('classifyOOPIFDetection', () => {
  const makeDetection = (): CFDetected => ({
    _tag: 'detected',
    targets: [{
      targetId: 'oopif-1',
      url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0xTestKey',
      type: 'iframe',
      meta: { sitekey: '0xTestKey', mode: 'normal', theme: null, appearance: null },
    }],
  });

  it('returns EmbeddedTurnstile when pageInfo is null (cache miss)', () => {
    const result = classifyOOPIFDetection(makeDetection(), null);
    expect(result._tag).toBe('EmbeddedTurnstile');
  });

  it('returns EmbeddedTurnstile when page title is normal', () => {
    const result = classifyOOPIFDetection(makeDetection(), {
      title: 'Ahrefs - SEO Tools', url: 'https://ahrefs.com',
    });
    expect(result._tag).toBe('EmbeddedTurnstile');
  });

  it('returns InlineInterstitial for "Just a moment..." title', () => {
    const result = classifyOOPIFDetection(makeDetection(), {
      title: 'Just a moment...', url: 'https://oyvana.com/',
    });
    expect(result._tag).toBe('InlineInterstitial');
    if (result._tag === 'InlineInterstitial') {
      expect(result.pageUrl).toBe('https://oyvana.com/');
      expect(result.pageTitle).toBe('Just a moment...');
    }
  });

  it('returns InlineInterstitial for "Attention Required" title', () => {
    const result = classifyOOPIFDetection(makeDetection(), {
      title: 'Attention Required! | Cloudflare', url: 'https://example.com',
    });
    expect(result._tag).toBe('InlineInterstitial');
  });

  it('returns EmbeddedTurnstile for "Verifying" (Ahrefs loading state)', () => {
    const result = classifyOOPIFDetection(makeDetection(), {
      title: 'Verifying', url: 'https://oyvana.com/',
    });
    expect(result._tag).toBe('EmbeddedTurnstile');
  });

  it('preserves detection object in EmbeddedTurnstile variant', () => {
    const detection = makeDetection();
    const result = classifyOOPIFDetection(detection, { title: 'Normal', url: 'https://x.com' });
    if (result._tag === 'EmbeddedTurnstile') {
      expect(result.detection).toBe(detection);
      expect(result.meta?.sitekey).toBe('0xTestKey');
    }
  });

  it('preserves OOPIF metadata in InlineInterstitial variant', () => {
    const result = classifyOOPIFDetection(makeDetection(), {
      title: 'Just a moment...', url: 'https://x.com',
    });
    if (result._tag === 'InlineInterstitial') {
      expect(result.meta?.sitekey).toBe('0xTestKey');
      expect(result.oopifUrl).toContain('challenges.cloudflare.com');
    }
  });

  it('returns EmbeddedTurnstile for empty page title', () => {
    const result = classifyOOPIFDetection(makeDetection(), { title: '', url: 'https://x.com' });
    expect(result._tag).toBe('EmbeddedTurnstile');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// classifyNavigationOutcome
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a minimal ActiveDetection for testing classifyNavigationOutcome.
 * Only the fields read by the classifier are populated.
 */
function makeActive(overrides: {
  type?: CloudflareInfo['type'];
  url?: string;
  clickDelivered?: boolean;
  clickDeliveredAt?: number;
  rechallengeCount?: number;
  cosmeticNavSeen?: boolean;
  startTime?: number;
}): ActiveDetection {
  const type = overrides.type ?? 'interstitial';
  const info: CloudflareInfo = {
    type, url: overrides.url ?? 'https://example.com', detectionMethod: 'url_pattern',
  };
  return {
    info,
    pageCdpSessionId: CdpSessionId.makeUnsafe('sess-1'),
    pageTargetId: TargetId.makeUnsafe('target-1'),
    startTime: overrides.startTime ?? Date.now() - 5000,
    attempt: 1,
    aborted: false,
    tracker: new CloudflareTracker(info),
    clickDelivered: overrides.clickDelivered,
    clickDeliveredAt: overrides.clickDeliveredAt,
    rechallengeCount: overrides.rechallengeCount,
    cosmeticNavSeen: overrides.cosmeticNavSeen,
    abortLatch: Latch.makeUnsafe(false),
    resolution: Resolution.makeUnsafe(),
  };
}

/** Stub that detects CF URLs by checking for __cf_chl_rt_tk or challenges.cloudflare.com */
const detectCF = (url: string): InterstitialCFType | null => {
  if (url.includes('__cf_chl_rt_tk=') || url.includes('challenges.cloudflare.com')) return 'interstitial';
  return null;
};

/** Always returns null — destination is never CF */
const noCF = (_url: string): InterstitialCFType | null => null;

effectDescribe('classifyNavigationOutcome', () => {
  effectIt.effect('NonInteractiveFailed — non-click type navigates', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'non_interactive' });
      const outcome = yield* classifyNavigationOutcome(active, 'https://example.com', 'Example', noCF);
      expect(outcome._tag).toBe('NonInteractiveFailed');
      if (outcome._tag === 'NonInteractiveFailed') {
        expect(outcome.duration).toBeGreaterThanOrEqual(0);
      }
    }),
  );

  effectIt.effect('TurnstileToCF — turnstile host page navigates to CF URL', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'turnstile' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://challenges.cloudflare.com/something', '', detectCF,
      );
      expect(outcome._tag).toBe('TurnstileToCF');
    }),
  );

  effectIt.effect('TurnstileSolved — turnstile host page navigates to clean URL', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'turnstile', clickDelivered: true, clickDeliveredAt: Date.now() - 2000 });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/dashboard', 'Dashboard', noCF,
      );
      expect(outcome._tag).toBe('TurnstileSolved');
      if (outcome._tag === 'TurnstileSolved') {
        expect(outcome.clickDelivered).toBe(true);
        expect(outcome.clickDeliveredAt).toBeDefined();
      }
    }),
  );

  effectIt.effect('TurnstileSolved — auto-solved (no click)', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'turnstile' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/dashboard', 'Dashboard', noCF,
      );
      expect(outcome._tag).toBe('TurnstileSolved');
      if (outcome._tag === 'TurnstileSolved') {
        expect(outcome.clickDelivered).toBe(false);
      }
    }),
  );

  // Interstitial path tests use it.live because classifyNavigationOutcome
  // calls Effect.sleep(RECHALLENGE_DELAY_MS) for rechallenge detection.
  // TestClock (used by it.effect) doesn't auto-advance, causing timeouts.

  effectIt.live('Rechallenge — interstitial navigates to another CF URL', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'interstitial', clickDelivered: true, rechallengeCount: 0 });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com?__cf_chl_rt_tk=abc', '', detectCF,
      );
      expect(outcome._tag).toBe('Rechallenge');
      if (outcome._tag === 'Rechallenge') {
        expect(outcome.rechallengeCount).toBe(1);
        expect(outcome.clickDelivered).toBe(true);
      }
    }),
  );

  effectIt.live('RechallengeLimitReached — too many rechallenges', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'interstitial', clickDelivered: true, rechallengeCount: MAX_RECHALLENGES - 1 });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com?__cf_chl_rt_tk=abc', '', detectCF,
      );
      expect(outcome._tag).toBe('RechallengeLimitReached');
      if (outcome._tag === 'RechallengeLimitReached') {
        expect(outcome.rechallengeCount).toBe(MAX_RECHALLENGES);
        expect(outcome.clickDelivered).toBe(true);
      }
    }),
  );

  effectIt.live('InterstitialSolved — interstitial navigates to clean URL with changed title', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'interstitial', clickDelivered: true, clickDeliveredAt: Date.now() - 2000 });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/real-page', 'My Real Page', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
      if (outcome._tag === 'InterstitialSolved') {
        expect(outcome.clickDelivered).toBe(true);
        expect(outcome.emitType).toBe('interstitial');
      }
    }),
  );

  effectIt.live('InterstitialSolved — managed type preserves emitType', () =>
    Effect.gen(function*() {
      const active = makeActive({ type: 'managed', clickDelivered: false });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/real-page', 'My Real Page', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
      if (outcome._tag === 'InterstitialSolved') {
        expect(outcome.emitType).toBe('managed');
        expect(outcome.clickDelivered).toBe(false);
      }
    }),
  );

  // ── THE CORE BUG FIX ────────────────────────────────────────────────
  // This is the regression test for the 67040.info scenario:
  // CF strips __cf_chl_rt_tk from URL via history.replaceState, making
  // the URL look clean, but the page title stays "Just a moment..."
  // The old code would abort+resolve here, killing the solver fiber.
  // The fix: classify as CosmeticUrlChange → don't touch detection state.

  effectIt.live('CosmeticUrlChange — same origin+path, only query params stripped (the 67040.info bug)', () =>
    Effect.gen(function*() {
      // Detection URL had __cf_chl_rt_tk query param; CF stripped it via history.replaceState.
      // Same origin + same path → cosmetic (replaceState can only modify within same origin+path).
      const active = makeActive({
        type: 'interstitial', clickDelivered: false,
        url: 'https://67040.info/?__cf_chl_rt_tk=abc123',
      });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://67040.info/', 'Just a moment...', noCF,
      );
      expect(outcome._tag).toBe('CosmeticUrlChange');
      if (outcome._tag === 'CosmeticUrlChange') {
        expect(outcome.title).toBe('Just a moment...');
        expect(outcome.url).toBe('https://67040.info/');
      }
    }),
  );

  effectIt.live('InterstitialSolved — same-origin same-path after cosmeticNavSeen (the 2captcha-cf fix)', () =>
    Effect.gen(function*() {
      // Simulates: first targetInfoChanged was classified as CosmeticUrlChange (set flag),
      // then Chrome fires a second targetInfoChanged with same URL. The one-shot guard
      // ensures this falls through to InterstitialSolved instead of being swallowed again.
      const active = makeActive({
        type: 'interstitial', clickDelivered: true, cosmeticNavSeen: true,
        url: 'https://67040.info/?__cf_chl_rt_tk=abc',
      });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://67040.info/', 'Just a moment...', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
      if (outcome._tag === 'InterstitialSolved') {
        expect(outcome.clickDelivered).toBe(true);
        expect(outcome.emitType).toBe('interstitial');
      }
    }),
  );

  effectIt.live('CosmeticUrlChange — same-origin same-path with CF title is cosmetic', () =>
    Effect.gen(function*() {
      // Same origin + same path + title still a CF challenge title → cosmetic (replaceState).
      // history.replaceState strips __cf_chl_rt_tk but cannot change document.title.
      const active = makeActive({ type: 'interstitial', url: 'https://example.com/?__cf_chl_rt_tk=x' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/', 'Just a moment...', noCF,
      );
      expect(outcome._tag).toBe('CosmeticUrlChange');
    }),
  );

  effectIt.live('InterstitialSolved — same-origin same-path with non-CF title is a real solve (2captcha-cf)', () =>
    Effect.gen(function*() {
      // Same origin+path BUT title changed from CF challenge to real content.
      // history.replaceState CANNOT change document.title — title change proves
      // cross-document navigation. This is a real auto-solve, not cosmetic.
      // Catches the 2captcha-cf bug: managed challenge auto-solves to same URL,
      // title changes from "Just a moment..." to the site's real title.
      const active = makeActive({ type: 'interstitial', url: 'https://2captcha.com/demo/cloudflare-turnstile-challenge?__cf_chl_rt_tk=abc' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://2captcha.com/demo/cloudflare-turnstile-challenge', '2captcha Turnstile Challenge Demo', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
    }),
  );

  effectIt.live('InterstitialSolved — different path is NOT cosmetic (real navigation)', () =>
    Effect.gen(function*() {
      // CF interstitial at /challenge redirects to /dashboard after solve.
      // Different pathname → replaceState impossible → real navigation → solved.
      const active = makeActive({ type: 'interstitial', clickDelivered: true, url: 'https://example.com/challenge' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/dashboard', 'Dashboard', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
    }),
  );

  effectIt.live('InterstitialSolved — different origin is NOT cosmetic (cross-origin redirect)', () =>
    Effect.gen(function*() {
      // Detection on CF domain, navigation lands on the actual site.
      // Different origin → replaceState impossible → real navigation → solved.
      const active = makeActive({ type: 'interstitial', clickDelivered: true, url: 'https://challenges.cloudflare.com/page' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com/', 'Example', noCF,
      );
      expect(outcome._tag).toBe('InterstitialSolved');
    }),
  );

  effectIt.live('CosmeticUrlChange is NOT triggered when URL is also CF', () =>
    Effect.gen(function*() {
      // If the URL itself contains CF tokens, it's a rechallenge — not cosmetic
      const active = makeActive({ type: 'interstitial' });
      const outcome = yield* classifyNavigationOutcome(
        active, 'https://example.com?__cf_chl_rt_tk=abc', 'Just a moment...', detectCF,
      );
      expect(outcome._tag).toBe('Rechallenge');
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════════
// classifyBridgeDetected
// ═══════════════════════════════════════════════════════════════════════

describe('classifyBridgeDetected', () => {
  it('InterstitialPostSolveErrorPage — cf_error_page on active interstitial', () => {
    const active = makeActive({ type: 'interstitial', clickDelivered: true });
    const outcome = classifyBridgeDetected(active, 'cf_error_page');
    expect(outcome._tag).toBe('InterstitialPostSolveErrorPage');
    if (outcome._tag === 'InterstitialPostSolveErrorPage') {
      expect(outcome.clickDelivered).toBe(true);
      expect(outcome.type).toBe('interstitial');
      expect(outcome.duration).toBeGreaterThanOrEqual(0);
      expect(outcome.attempts).toBe(1);
    }
  });

  it('InterstitialPostSolveErrorPage — managed type is also interstitial', () => {
    const active = makeActive({ type: 'managed', clickDelivered: false });
    const outcome = classifyBridgeDetected(active, 'cf_error_page');
    expect(outcome._tag).toBe('InterstitialPostSolveErrorPage');
    if (outcome._tag === 'InterstitialPostSolveErrorPage') {
      expect(outcome.clickDelivered).toBe(false);
      expect(outcome.type).toBe('managed');
    }
  });

  it('EmbeddedErrorPage — cf_error_page on active turnstile', () => {
    const active = makeActive({ type: 'turnstile' });
    const outcome = classifyBridgeDetected(active, 'cf_error_page');
    expect(outcome._tag).toBe('EmbeddedErrorPage');
    if (outcome._tag === 'EmbeddedErrorPage') {
      expect(outcome.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('Informational — non-cf_error_page method', () => {
    const active = makeActive({ type: 'interstitial' });
    const outcome = classifyBridgeDetected(active, 'title_match');
    expect(outcome._tag).toBe('Informational');
    if (outcome._tag === 'Informational') {
      expect(outcome.method).toBe('title_match');
    }
  });

  it('NoActiveDetection — no active detection (undefined)', () => {
    const outcome = classifyBridgeDetected(undefined, 'cf_error_page');
    expect(outcome._tag).toBe('NoActiveDetection');
  });

  it('NoActiveDetection — aborted detection', () => {
    const active = makeActive({ type: 'interstitial' });
    (active as any).aborted = true;
    const outcome = classifyBridgeDetected(active, 'cf_error_page');
    expect(outcome._tag).toBe('NoActiveDetection');
  });
});
