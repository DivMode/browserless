/**
 * Unit tests for filterOwnedTargets — the cross-tab OOPIF ownership filter.
 *
 * Verifies that detectTurnstileWidgetEffect only processes CF OOPIFs
 * belonging to the querying page, filtering out phantoms from other tabs.
 */
import { describe, expect, it } from 'vitest';
import { TargetId } from '../../shared/cloudflare-detection.js';
import { filterOwnedTargets } from './cloudflare-detector.js';
import type { CFTargetMatch } from './cloudflare-solve-strategies.js';

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
