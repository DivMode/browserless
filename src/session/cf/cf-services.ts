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
  /** Controlled mutations — solver calls these instead of direct property assignment. */
  readonly setClickDelivered: (clickDeliveredAt: number) => Effect.Effect<void>;
  readonly markActivityLoopStarted: () => Effect.Effect<void>;
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

// ═══════════════════════════════════════════════════════════════════════
// SessionSolverContext — session-level shared state (provided once)
//
// Exposes the session-level Maps/Sets that detectors need for cross-tab
// guards, OOPIF ownership tracking, and compound label accumulation.
// ═══════════════════════════════════════════════════════════════════════

export const SessionSolverContext = ServiceMap.Service<{
  readonly iframeToPage: ReadonlyMap<TargetId, TargetId>;
  readonly solvedCFTargetIds: ReadonlySet<string>;
  readonly solvedPages: ReadonlySet<TargetId>;
  readonly knownPages: ReadonlyMap<TargetId, CdpSessionId>;
  readonly config: Required<CloudflareConfig>;
  readonly destroyed: boolean;
  readonly registerPage: (targetId: TargetId, cdpSessionId: CdpSessionId) => void;
  readonly addSolvedCFTarget: (oopifId: string, pageTargetId: TargetId) => Effect.Effect<void>;
  readonly addSolvedCFTargetSync: (oopifId: string, pageTargetId: TargetId) => void;
  readonly pushPhase: (targetId: TargetId, type: string, label: string) => void;
  readonly buildCompoundLabel: (targetId: TargetId) => string;
}>('SessionSolverContext');

// ═══════════════════════════════════════════════════════════════════════
// TabSolverContext — per-tab isolated state (provided per tab runtime)
//
// Scalar fields, NOT Maps. Cross-tab contamination is structurally
// impossible because there are no targetId keys to mix up.
// ═══════════════════════════════════════════════════════════════════════

import type { TabSolverState } from './cf-tab-state.js';

export const TabSolverContext = ServiceMap.Service<{
  readonly targetId: TargetId;
  readonly cdpSessionId: CdpSessionId;
  readonly state: TabSolverState;
  /** Set the resolved pageFrameId — called once at detection start. */
  readonly setPageFrameId: (id: string | null) => void;
}>('TabSolverContext');

// ═══════════════════════════════════════════════════════════════════════
// TabDetector — per-tab filtered detection (structural cross-tab guard)
//
// The filtering is baked into the service implementation — impossible to
// bypass. Replaces the 3-step manual filter chain:
//   1. detectTurnstileViaCDP(cdpSessionId, solvedCFTargetIds)
//   2. filterOwnedTargets(detection.targets, targetId, iframeToPage)
//   3. pageFrameId ? filter by parentFrameId : keep all
// with a single yield* call.
// ═══════════════════════════════════════════════════════════════════════

import type { CFDetected } from './cloudflare-solve-strategies.js';

export const TabDetector = ServiceMap.Service<{
  /** Returns ONLY OOPIFs belonging to this tab. Cross-tab OOPIFs are filtered by construction. */
  readonly detect: (excludeTargetIds?: ReadonlySet<string>) => Effect.Effect<
    CFDetected | { _tag: 'not_detected' }
  >;
}>('TabDetector');
