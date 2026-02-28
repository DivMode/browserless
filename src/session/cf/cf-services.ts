/**
 * Service definitions for the CF solver Effect layer.
 *
 * Replaces constructor callback injection with typed services
 * that are provided via Layer at construction time.
 *
 * Service scope restriction enforces safety rules at compile time:
 *   - firstClickAttempt only has CdpSender (no TokenChecker → no Runtime.evaluate)
 *   - retryClickAttempt has CdpSender + TokenChecker (safe after first click)
 */
import type { Effect } from 'effect';
import { ServiceMap } from 'effect';
import type { CdpSessionId, TargetId, CloudflareResult, CloudflareConfig } from '../../shared/cloudflare-detection.js';
import type { CdpSessionGone, CdpTimeout } from './cf-errors.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import type { SolveOutcome } from './cloudflare-solve-strategies.js';

// ═══════════════════════════════════════════════════════════════════════
// CdpSender — send CDP commands to browser/page/OOPIF sessions
// ═══════════════════════════════════════════════════════════════════════

export const CdpSender = ServiceMap.Service<{
  /** Send a CDP command via the direct (page-level) WS. */
  readonly send: (
    method: string,
    params?: object,
    sessionId?: CdpSessionId,
    timeoutMs?: number,
  ) => Effect.Effect<any, CdpSessionGone | CdpTimeout>;

  /** Send via proxy WS (CDPProxy's browser WS). Falls back to direct send. */
  readonly sendViaProxy: (
    method: string,
    params?: object,
    sessionId?: CdpSessionId,
    timeoutMs?: number,
  ) => Effect.Effect<any, CdpSessionGone | CdpTimeout>;
}>('CdpSender');

// ═══════════════════════════════════════════════════════════════════════
// TokenChecker — getToken/isSolved via Runtime.evaluate
//
// NOT available in firstClickAttempt's R channel.
// Available in retryClickAttempt (safe after first click).
// ═══════════════════════════════════════════════════════════════════════

export const TokenChecker = ServiceMap.Service<{
  /** Get Turnstile token from page. Uses Runtime.evaluate — NEVER call before first click. */
  readonly getToken: (sessionId: CdpSessionId) => Effect.Effect<string | null, CdpSessionGone>;
  /** Check if Turnstile is solved. Uses Runtime.evaluate — NEVER call before first click. */
  readonly isSolved: (sessionId: CdpSessionId) => Effect.Effect<boolean, CdpSessionGone>;
  /** Check widget error state. */
  readonly isWidgetError: (sessionId: CdpSessionId) => Effect.Effect<{ type: string; has_token: boolean } | null, CdpSessionGone>;
  /** Re-run CF detection to check for false positives. */
  readonly isStillDetected: (sessionId: CdpSessionId) => Effect.Effect<boolean, CdpSessionGone>;
}>('TokenChecker');

// ═══════════════════════════════════════════════════════════════════════
// SolverEvents — emit detection/solve/fail events + recording markers
// ═══════════════════════════════════════════════════════════════════════

export const SolverEvents = ServiceMap.Service<{
  readonly emitDetected: (active: ActiveDetection) => Effect.Effect<void>;
  readonly emitProgress: (active: ActiveDetection, state: string, extra?: Record<string, any>) => Effect.Effect<void>;
  readonly emitSolved: (active: ActiveDetection, result: CloudflareResult) => Effect.Effect<void>;
  readonly emitFailed: (active: ActiveDetection, reason: string, duration: number, phaseLabel?: string) => Effect.Effect<void>;
  readonly marker: (targetId: TargetId, tag: string, payload?: object) => Effect.Effect<void>;
}>('SolverEvents');

// ═══════════════════════════════════════════════════════════════════════
// SolveDeps — strategies + state tracker dependencies for solve functions
//
// Replaces the plain SolveDeps interface that was threaded as a parameter
// to every solve function. Now provided via Layer — yield* in generators.
// ═══════════════════════════════════════════════════════════════════════

export const SolveDeps = ServiceMap.Service<{
  readonly findAndClickViaCDP: (active: ActiveDetection, attempt: number) => Effect.Effect<boolean>;
  readonly resolveAutoSolved: (active: ActiveDetection, signal: string) => Effect.Effect<void>;
  readonly simulatePresence: (active: ActiveDetection) => Effect.Effect<void>;
  /** Activity loop for embedded types (turnstile/non_interactive/invisible). Runtime.evaluate is safe. */
  readonly startActivityLoopEmbedded: (active: ActiveDetection) => Effect.Effect<void>;
  /** Activity loop for interstitial/managed types. Runtime.evaluate is FORBIDDEN. */
  readonly startActivityLoopInterstitial: (active: ActiveDetection) => Effect.Effect<void>;
}>('SolveDeps');

// ═══════════════════════════════════════════════════════════════════════
// SolveDispatcher — dispatches solve attempts through the Effect runtime
//
// Replaces the (active) => Promise<SolveOutcome> callback that was
// injected into CloudflareDetector via constructor.
// ═══════════════════════════════════════════════════════════════════════

export const SolveDispatcher = ServiceMap.Service<{
  readonly dispatch: (active: ActiveDetection) => Effect.Effect<SolveOutcome>;
}>('SolveDispatcher');

// ═══════════════════════════════════════════════════════════════════════
// DetectionLoopStarter — starts a fiber-based Turnstile detection loop
//
// Replaces the (targetId, cdpSessionId) => void callback that was
// injected into CloudflareDetector via constructor.
// ═══════════════════════════════════════════════════════════════════════

export const DetectionLoopStarter = ServiceMap.Service<{
  readonly start: (targetId: TargetId, cdpSessionId: CdpSessionId) => Effect.Effect<void>;
}>('DetectionLoopStarter');

// ═══════════════════════════════════════════════════════════════════════
// OOPIFChecker — check OOPIF iframe widget state via CDP DOM walk
//
// Replaces the checkOOPIFStateEffect callback that was injected into
// CloudflareStateTracker via constructor. Wired to
// strategies.checkOOPIFStateViaCDP at the bridge layer.
// ═══════════════════════════════════════════════════════════════════════

export const OOPIFChecker = ServiceMap.Service<{
  readonly check: (iframeCdpSessionId: CdpSessionId) => Effect.Effect<
    'success' | 'fail' | 'expired' | 'timeout' | 'pending' | null
  >;
}>('OOPIFChecker');

// ═══════════════════════════════════════════════════════════════════════
// SolverConfig — solver configuration with defaults
//
// Provided via Layer.succeed in the bridge. Consumer yields the config
// instead of reading a mutable field on the state tracker.
// ═══════════════════════════════════════════════════════════════════════

export const SolverConfig = ServiceMap.Service<Required<CloudflareConfig>>('SolverConfig');
