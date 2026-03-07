/**
 * Service definitions for the CF solver Effect layer.
 *
 * Replaces constructor callback injection with typed services
 * that are provided via Layer at construction time.
 *
 * TokenChecker was removed — replaced by CF bridge push events.
 * The bridge pushes solved/error/detected events multiplexed through __rrwebPush,
 * eliminating all Runtime.evaluate polling.
 */
import type { Effect } from 'effect';
import { ServiceMap } from 'effect';
import type { CdpSessionId, TargetId, CloudflareResult, CloudflareConfig } from '../../shared/cloudflare-detection.js';
import type { CdpSessionGone, CdpTimeout } from './cf-errors.js';
import type { ActiveDetection, ReadonlyActiveDetection, ReadonlyEmbeddedDetection, ReadonlyInterstitialDetection } from './cloudflare-event-emitter.js';
import type { ClickResult } from './cloudflare-solve-strategies.js';
import type { SolveDetectionResult } from './cloudflare-solver.effect.js';

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

  /** Route through CDPProxy browser WS — pre-warmed compositor for Input events. */
  readonly sendViaBrowser: (
    method: string,
    params?: object,
    sessionId?: CdpSessionId,
    timeoutMs?: number,
  ) => Effect.Effect<any, CdpSessionGone | CdpTimeout>;
}>('CdpSender');

// ═══════════════════════════════════════════════════════════════════════
// SolverEvents — emit detection/solve/fail events + recording markers
// ═══════════════════════════════════════════════════════════════════════

export const SolverEvents = ServiceMap.Service<{
  readonly emitDetected: (active: ReadonlyActiveDetection) => Effect.Effect<void>;
  readonly emitProgress: (active: ReadonlyActiveDetection, state: string, extra?: Record<string, any>) => Effect.Effect<void>;
  readonly emitSolved: (active: ReadonlyActiveDetection, result: CloudflareResult) => Effect.Effect<void>;
  readonly emitFailed: (active: ReadonlyActiveDetection, reason: string, duration: number, phaseLabel?: string) => Effect.Effect<void>;
  readonly marker: (targetId: TargetId, tag: string, payload?: object) => Effect.Effect<void>;
}>('SolverEvents');

// ═══════════════════════════════════════════════════════════════════════
// SolveDeps — strategies + state tracker dependencies for solve functions
//
// Replaces the plain SolveDeps interface that was threaded as a parameter
// to every solve function. Now provided via Layer — yield* in generators.
// ═══════════════════════════════════════════════════════════════════════

export const SolveDeps = ServiceMap.Service<{
  readonly findAndClickViaCDP: (active: ReadonlyActiveDetection, attempt: number) => Effect.Effect<ClickResult>;
  readonly simulatePresence: (active: ReadonlyActiveDetection) => Effect.Effect<void>;
  /** Activity loop for embedded types (turnstile/non_interactive/invisible). Runtime.evaluate is safe. */
  readonly startActivityLoopEmbedded: (active: ReadonlyEmbeddedDetection) => Effect.Effect<void>;
  /** Activity loop for interstitial/managed types. Runtime.evaluate is FORBIDDEN. */
  readonly startActivityLoopInterstitial: (active: ReadonlyInterstitialDetection) => Effect.Effect<void>;
}>('SolveDeps');

// ═══════════════════════════════════════════════════════════════════════
// SolveDispatcher — dispatches solve attempts through the Effect runtime
//
// Replaces the (active) => Promise<SolveOutcome> callback that was
// injected into CloudflareDetector via constructor.
// ═══════════════════════════════════════════════════════════════════════

export const SolveDispatcher = ServiceMap.Service<{
  readonly dispatch: (active: ActiveDetection) => Effect.Effect<SolveDetectionResult>;
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
