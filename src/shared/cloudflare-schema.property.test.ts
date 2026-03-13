/**
 * Property-based tests for CF Schema structs.
 *
 * Uses Schema.toArbitrary to generate random valid instances,
 * then verifies encode/decode round-trips, JSON Schema conformance,
 * and structural invariants.
 */
import { describe, it } from '@effect/vitest';
import { Schema } from 'effect';
import fc from 'fast-check';
import { CloudflareInfo, CloudflareResult, CloudflareSnapshot } from './cloudflare-detection.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Assert encode → decode round-trip produces identical JSON. */
function assertRoundTrip<A, I>(schema: Schema.Schema<A, I>) {
  const arb = Schema.toArbitrary(schema);
  const encode = Schema.encodeUnknownSync(schema);
  const decode = Schema.decodeUnknownSync(schema);

  fc.assert(
    fc.property(arb, (value) => {
      const encoded = encode(value);
      const decoded = decode(encoded);
      const reEncoded = encode(decoded);
      return JSON.stringify(encoded) === JSON.stringify(reEncoded);
    }),
    { numRuns: 200 },
  );
}

// ── CloudflareInfo ───────────────────────────────────────────────────

describe('CloudflareInfo property tests', () => {
  it('round-trips through encode/decode', () => {
    assertRoundTrip(CloudflareInfo);
  });

  it('type is always a valid CloudflareType variant', () => {
    const arb = Schema.toArbitrary(CloudflareInfo);
    const validTypes = ['managed', 'non_interactive', 'invisible', 'interstitial', 'turnstile', 'block'] as const;

    fc.assert(
      fc.property(arb, (info) => {
        return (validTypes as readonly string[]).includes(info.type);
      }),
      { numRuns: 200 },
    );
  });

  it('always has required fields', () => {
    const arb = Schema.toArbitrary(CloudflareInfo);

    fc.assert(
      fc.property(arb, (info) => {
        return typeof info.type === 'string'
          && typeof info.url === 'string'
          && typeof info.detectionMethod === 'string';
      }),
      { numRuns: 200 },
    );
  });
});

// ── CloudflareResult ─────────────────────────────────────────────────

describe('CloudflareResult property tests', () => {
  it('round-trips through encode/decode', () => {
    assertRoundTrip(CloudflareResult);
  });

  it('duration_ms is always finite', () => {
    const arb = Schema.toArbitrary(CloudflareResult);

    fc.assert(
      fc.property(arb, (result) => {
        return Number.isFinite(result.duration_ms);
      }),
      { numRuns: 200 },
    );
  });

  it('attempts is always an integer', () => {
    const arb = Schema.toArbitrary(CloudflareResult);

    fc.assert(
      fc.property(arb, (result) => {
        return Number.isInteger(result.attempts);
      }),
      { numRuns: 200 },
    );
  });

  it('token_length is integer when present', () => {
    const arb = Schema.toArbitrary(CloudflareResult);

    fc.assert(
      fc.property(arb, (result) => {
        return result.token_length === undefined || Number.isInteger(result.token_length);
      }),
      { numRuns: 200 },
    );
  });
});

// ── CloudflareSnapshot ───────────────────────────────────────────────

describe('CloudflareSnapshot property tests', () => {
  it('round-trips through encode/decode', () => {
    assertRoundTrip(CloudflareSnapshot);
  });

  it('integer fields are always integers when present', () => {
    const arb = Schema.toArbitrary(CloudflareSnapshot);
    const intFields = [
      'detection_poll_count', 'click_count', 'checkbox_to_click_ms',
      'phase4_duration_ms', 'presence_duration_ms', 'presence_phases',
      'approach_phases', 'activity_poll_count', 'false_positive_count',
      'widget_error_count',
    ] as const;

    fc.assert(
      fc.property(arb, (snap) => {
        for (const field of intFields) {
          const val = snap[field];
          if (val !== undefined && val !== null) {
            if (!Number.isInteger(val)) return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('array fields are always arrays when present', () => {
    const arb = Schema.toArbitrary(CloudflareSnapshot);

    fc.assert(
      fc.property(arb, (snap) => {
        if (snap.widget_find_methods !== undefined && !Array.isArray(snap.widget_find_methods)) return false;
        if (snap.iframe_states !== undefined && !Array.isArray(snap.iframe_states)) return false;
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('coordinate fields are finite when present', () => {
    const arb = Schema.toArbitrary(CloudflareSnapshot);

    fc.assert(
      fc.property(arb, (snap) => {
        for (const field of ['widget_x', 'widget_y', 'click_x', 'click_y'] as const) {
          const val = snap[field];
          if (val !== undefined && val !== null && !Number.isFinite(val)) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('survives JSON.stringify → JSON.parse → decode', () => {
    const arb = Schema.toArbitrary(CloudflareSnapshot);
    const encode = Schema.encodeUnknownSync(CloudflareSnapshot);
    const decode = Schema.decodeUnknownSync(CloudflareSnapshot);

    fc.assert(
      fc.property(arb, (snap) => {
        const json = JSON.stringify(encode(snap));
        const parsed = JSON.parse(json);
        const decoded = decode(parsed);
        const reJson = JSON.stringify(encode(decoded));
        return json === reJson;
      }),
      { numRuns: 200 },
    );
  });
});
