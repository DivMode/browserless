/**
 * Property-based tests for CF detection schemas.
 *
 * Uses Schema.toArbitrary to generate random valid instances
 * and verifies round-trip encode/decode, required field presence,
 * and constraint satisfaction (finite, integer, etc.).
 */
import { describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import * as fc from 'fast-check';
import { CloudflareInfo, CloudflareResult, CloudflareSnapshot } from './cloudflare-detection.js';

// ═══════════════════════════════════════════════════════════════════════
// CloudflareInfo
// ═══════════════════════════════════════════════════════════════════════

describe('CloudflareInfo (property)', () => {
  const arb = Schema.toArbitrary(CloudflareInfo);

  it('round-trips through JSON encode → decode', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (info) => {
        const encoded = Schema.encodeSync(CloudflareInfo)(info);
        const decoded = Schema.decodeSync(CloudflareInfo)(encoded);
        expect(decoded.type).toBe(info.type);
        expect(decoded.url).toBe(info.url);
        expect(decoded.detectionMethod).toBe(info.detectionMethod);
      }));
    }),
  );

  it('type is always a valid CloudflareType variant', () =>
    Effect.sync(() => {
      const validTypes = ['managed', 'non_interactive', 'invisible', 'interstitial', 'turnstile', 'block'];
      fc.assert(fc.property(arb, (info) => {
        expect(validTypes).toContain(info.type);
      }));
    }),
  );

  it('required fields are always present', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (info) => {
        expect(typeof info.type).toBe('string');
        expect(typeof info.url).toBe('string');
        expect(typeof info.detectionMethod).toBe('string');
      }));
    }),
  );

  it('pollCount is integer when present', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (info) => {
        if (info.pollCount !== undefined) {
          expect(Number.isInteger(info.pollCount)).toBe(true);
          expect(Number.isFinite(info.pollCount)).toBe(true);
        }
      }));
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════════
// CloudflareResult
// ═══════════════════════════════════════════════════════════════════════

describe('CloudflareResult (property)', () => {
  const arb = Schema.toArbitrary(CloudflareResult);

  it('round-trips through JSON encode → decode', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (result) => {
        const encoded = Schema.encodeSync(CloudflareResult)(result);
        const decoded = Schema.decodeSync(CloudflareResult)(encoded);
        expect(decoded.solved).toBe(result.solved);
        expect(decoded.type).toBe(result.type);
        expect(decoded.method).toBe(result.method);
        expect(decoded.duration_ms).toBe(result.duration_ms);
        expect(decoded.attempts).toBe(result.attempts);
      }));
    }),
  );

  it('duration_ms is always finite', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (result) => {
        expect(Number.isFinite(result.duration_ms)).toBe(true);
      }));
    }),
  );

  it('attempts is always a finite integer', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (result) => {
        expect(Number.isInteger(result.attempts)).toBe(true);
        expect(Number.isFinite(result.attempts)).toBe(true);
      }));
    }),
  );

  it('token_length is integer when present', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (result) => {
        if (result.token_length !== undefined) {
          expect(Number.isInteger(result.token_length)).toBe(true);
        }
      }));
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════════
// CloudflareSnapshot
// ═══════════════════════════════════════════════════════════════════════

describe('CloudflareSnapshot (property)', () => {
  const arb = Schema.toArbitrary(CloudflareSnapshot);

  it('round-trips through JSON serialize → parse → decode', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (snapshot) => {
        const json = JSON.stringify(Schema.encodeSync(CloudflareSnapshot)(snapshot));
        const decoded = Schema.decodeSync(CloudflareSnapshot)(JSON.parse(json));
        expect(decoded.widget_found).toBe(snapshot.widget_found);
        expect(decoded.clicked).toBe(snapshot.clicked);
        expect(decoded.click_count).toBe(snapshot.click_count);
      }));
    }),
  );

  it('integer fields are integers when present', () =>
    Effect.sync(() => {
      const intFields = [
        'detection_poll_count', 'click_count', 'checkbox_to_click_ms',
        'phase4_duration_ms', 'presence_duration_ms', 'presence_phases',
        'approach_phases', 'activity_poll_count', 'false_positive_count',
        'widget_error_count',
      ] as const;
      fc.assert(fc.property(arb, (snapshot) => {
        for (const field of intFields) {
          const val = snapshot[field];
          if (val !== undefined && val !== null) {
            expect(Number.isInteger(val)).toBe(true);
          }
        }
      }));
    }),
  );

  it('array fields are arrays when present', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (snapshot) => {
        if (snapshot.widget_find_methods !== undefined) {
          expect(Array.isArray(snapshot.widget_find_methods)).toBe(true);
        }
        if (snapshot.iframe_states !== undefined) {
          expect(Array.isArray(snapshot.iframe_states)).toBe(true);
        }
      }));
    }),
  );

  it('coordinate fields are finite when present', () =>
    Effect.sync(() => {
      fc.assert(fc.property(arb, (snapshot) => {
        for (const field of ['widget_x', 'widget_y', 'click_x', 'click_y'] as const) {
          const val = snapshot[field];
          if (val !== undefined && val !== null) {
            expect(Number.isFinite(val)).toBe(true);
          }
        }
      }));
    }),
  );
});
