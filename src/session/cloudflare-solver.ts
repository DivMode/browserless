import { Logger } from '@browserless.io/browserless';
import {
  ChallengeInfo,
  SolverConfig,
  SolveResult,
  CF_CHALLENGE_DETECTION_JS,
  TURNSTILE_CALLBACK_HOOK_JS,
  TURNSTILE_TOKEN_JS,
  TURNSTILE_STATE_OBSERVER_JS,
  TURNSTILE_ERROR_CHECK_JS,
  FIND_CLICK_TARGET_JS,
  detectChallengeType,
} from '../shared/challenge-detector.js';
import {
  simulateHumanPresence,
  approachCoordinates,
  commitClick,
} from '../shared/mouse-humanizer.js';

type SendCommand = (method: string, params?: object, cdpSessionId?: string) => Promise<any>;
type EmitClientEvent = (method: string, params: object) => Promise<void>;
type InjectMarker = (cdpSessionId: string, tag: string, payload?: object) => void;

const DEFAULT_CONFIG: Required<SolverConfig> = {
  maxAttempts: 3,
  attemptTimeout: 30000,
  recordingMarkers: true,
};

interface ActiveChallenge {
  info: ChallengeInfo;
  pageCdpSessionId: string;
  iframeCdpSessionId?: string;
  iframeTargetId?: string;
  startTime: number;
  attempt: number;
  aborted: boolean;
}

/**
 * Cloudflare challenge solver for a single browser session.
 *
 * Lifecycle:
 * 1. Created disabled by replay-coordinator in setupReplayForAllTabs
 * 2. Client sends Browserless.enableChallengeSolver to activate
 * 3. Hooks receive CDP events from replay-coordinator
 * 4. Solver detects challenges, simulates human presence, clicks
 * 5. Results streamed as Browserless.challenge* CDP events
 */
export class CloudflareSolver {
  private log = new Logger('cloudflare-solver');
  private enabled = false;
  private config: Required<SolverConfig> = { ...DEFAULT_CONFIG };
  private emitClientEvent: EmitClientEvent = async () => {};
  private activeChallenges = new Map<string, ActiveChallenge>(); // pageTargetId -> challenge
  private iframeToPage = new Map<string, string>(); // iframeTargetId -> pageTargetId
  private knownPages = new Map<string, string>(); // targetId -> cdpSessionId
  private destroyed = false;

  constructor(
    private sendCommand: SendCommand,
    private injectMarker: InjectMarker,
  ) {}

  /** Wire the CDP event emitter after CDPProxy connects. */
  setEmitClientEvent(fn: EmitClientEvent): void {
    this.emitClientEvent = fn;
  }

  /** Enable the solver (called when client sends enableChallengeSolver). */
  enable(config?: SolverConfig): void {
    this.enabled = true;
    if (config) {
      this.config = { ...DEFAULT_CONFIG, ...config };
    }
    this.log.info('Cloudflare solver enabled');

    // Scan all known pages for existing challenges
    for (const [targetId, cdpSessionId] of this.knownPages) {
      this.detectAndSolve(targetId, cdpSessionId).catch(() => {});
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called when a new page target is attached. */
  async onPageAttached(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    this.knownPages.set(targetId, cdpSessionId);
    if (!this.enabled || !url || url.startsWith('about:')) return;

    // Inject callback hook so we detect auto-solves
    this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: TURNSTILE_CALLBACK_HOOK_JS,
      runImmediately: true,
    }, cdpSessionId).catch(() => {});

    // Register solved binding
    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileSolvedBinding',
    }, cdpSessionId).catch(() => {});

    await this.detectAndSolve(targetId, cdpSessionId);
  }

  /** Called when a page navigates. */
  async onPageNavigated(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    this.knownPages.set(targetId, cdpSessionId);
    // Cancel any active solve for this page
    const active = this.activeChallenges.get(targetId);
    if (active) {
      active.aborted = true;
      this.activeChallenges.delete(targetId);
    }

    if (!this.enabled || !url || url.startsWith('about:')) return;

    // Re-detect after navigation (interstitial → real page, or new challenge)
    // Small delay for page JS to initialize
    await new Promise((r) => setTimeout(r, 500));
    await this.detectAndSolve(targetId, cdpSessionId);
  }

  /** Called when a cross-origin iframe is attached. */
  async onIframeAttached(
    iframeTargetId: string, iframeCdpSessionId: string,
    url: string, parentCdpSessionId: string,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!url?.includes('challenges.cloudflare.com')) return;

    // Find parent page
    const pageTargetId = this.findPageBySession(parentCdpSessionId);
    if (!pageTargetId) return;

    this.iframeToPage.set(iframeTargetId, pageTargetId);

    // Update active challenge with iframe info
    const active = this.activeChallenges.get(pageTargetId);
    if (active) {
      active.iframeCdpSessionId = iframeCdpSessionId;
      active.iframeTargetId = iframeTargetId;
    }

    // Inject state observer into Turnstile iframe
    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileStateBinding',
    }, iframeCdpSessionId).catch(() => {});
    this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: TURNSTILE_STATE_OBSERVER_JS,
      runImmediately: true,
    }, iframeCdpSessionId).catch(() => {});
    setTimeout(() => {
      this.sendCommand('Runtime.evaluate', {
        expression: TURNSTILE_STATE_OBSERVER_JS,
      }, iframeCdpSessionId).catch(() => {});
    }, 100);
  }

  /**
   * Called when an iframe navigates (Target.targetInfoChanged for type=iframe).
   * Handles the late-navigating iframe timing bug: iframes that start with
   * about:blank then navigate to challenges.cloudflare.com.
   */
  async onIframeNavigated(
    iframeTargetId: string, iframeCdpSessionId: string, url: string,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!url?.includes('challenges.cloudflare.com')) return;

    // Same handling as onIframeAttached — inject state observer
    const pageTargetId = this.iframeToPage.get(iframeTargetId);
    if (!pageTargetId) return;

    const active = this.activeChallenges.get(pageTargetId);
    if (active && !active.iframeCdpSessionId) {
      active.iframeCdpSessionId = iframeCdpSessionId;
      active.iframeTargetId = iframeTargetId;
    }

    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileStateBinding',
    }, iframeCdpSessionId).catch(() => {});
    this.sendCommand('Runtime.evaluate', {
      expression: TURNSTILE_STATE_OBSERVER_JS,
    }, iframeCdpSessionId).catch(() => {});
  }

  /** Called when Turnstile iframe state changes (via __turnstileStateBinding). */
  async onTurnstileStateChange(state: string, iframeCdpSessionId: string): Promise<void> {
    if (!this.enabled) return;

    // Find the page this iframe belongs to
    const pageTargetId = this.findPageByIframeSession(iframeCdpSessionId);
    if (!pageTargetId) return;

    const active = this.activeChallenges.get(pageTargetId);
    if (!active || active.aborted) return;

    this.log.info(`Turnstile state change: ${state} for page ${pageTargetId}`);
    this.emitProgress(active, state);

    if (state === 'success') {
      // Wait for page to settle (JS context may be rebuilding after navigation)
      await new Promise(r => setTimeout(r, 500));

      // Verify: re-run detection to confirm challenge is actually gone
      const token = await this.getToken(active.pageCdpSessionId);
      const stillDetected = await this.isStillChallenge(active.pageCdpSessionId);

      if (stillDetected && !token) {
        // False positive — challenge still present and no token
        this.marker(active.pageCdpSessionId, 'cf.false_positive', { state });
        this.emitProgress(active, 'false_positive');
        this.log.warn(`False positive success for page ${pageTargetId}`);
        return; // Don't resolve, keep waiting
      }

      const duration = Date.now() - active.startTime;
      active.aborted = true; // Stop activity loop

      const result: SolveResult = {
        solved: true,
        type: active.info.type,
        method: token ? 'auto_solve' : 'state_change',
        token: token || undefined,
        duration_ms: duration,
        attempts: active.attempt,
        auto_resolved: !active.iframeCdpSessionId, // no iframe = invisible/auto
      };

      this.activeChallenges.delete(pageTargetId);
      this.emitSolved(active, result);
    } else if (state === 'fail' || state === 'expired' || state === 'timeout') {
      active.aborted = true; // Stop activity loop
      // Challenge failed — may retry
      if (active.attempt < this.config.maxAttempts) {
        active.attempt++;
        active.aborted = false; // Reset for retry
        this.log.info(`Retrying challenge (attempt ${active.attempt})`);
        this.solveChallenge(active).catch(() => {});
      } else {
        const duration = Date.now() - active.startTime;
        this.activeChallenges.delete(pageTargetId);
        this.emitFailed(active, state, duration);
      }
    }
  }

  /** Called when TURNSTILE_CALLBACK_HOOK_JS detects an auto-solve on any page. */
  async onAutoSolveBinding(cdpSessionId: string): Promise<void> {
    if (!this.enabled) return;

    // Find the page this binding fired on
    const pageTargetId = this.findPageBySession(cdpSessionId);
    if (!pageTargetId) return;

    const active = this.activeChallenges.get(pageTargetId);

    if (active && !active.aborted) {
      // Active challenge exists — resolve it as auto-solved via callback
      await this.resolveAutoSolved(active, 'callback_binding');
      return;
    }

    // No active challenge — standalone Turnstile (e.g., fast path page).
    // Emit a minimal detected+solved pair so pydoll gets observability.
    const token = await this.getToken(cdpSessionId);
    this.emitClientEvent('Browserless.challengeDetected', {
      type: 'widget',
      detectionMethod: 'callback_binding',
    }).catch(() => {});
    this.marker(cdpSessionId, 'cf.challenge_detected', { type: 'widget' });

    this.emitClientEvent('Browserless.challengeSolved', {
      solved: true,
      type: 'widget',
      method: 'auto_solve',
      token: token || undefined,
      duration_ms: 0,
      attempts: 0,
      auto_resolved: true,
      signal: 'callback_binding',
    }).catch(() => {});
    this.marker(cdpSessionId, 'cf.solved', { type: 'widget', method: 'auto_solve', signal: 'callback_binding' });
  }

  /** Clean up when session is destroyed. */
  destroy(): void {
    this.destroyed = true;
    this.activeChallenges.clear();
    this.iframeToPage.clear();
    this.knownPages.clear();
  }

  // ─── Private methods ──────────────────────────────────────

  private async detectAndSolve(targetId: string, cdpSessionId: string): Promise<void> {
    if (this.destroyed || !this.enabled) return;

    try {
      // Poll for challenge detection — CF page JS needs time to load _cf_chl_opt
      let data: any = null;
      for (let i = 0; i < 20; i++) {
        if (this.destroyed || !this.enabled) return;
        // If another call already created an active challenge for this target, bail
        if (this.activeChallenges.has(targetId)) return;

        try {
          const result = await this.sendCommand('Runtime.evaluate', {
            expression: CF_CHALLENGE_DETECTION_JS,
            returnByValue: true,
          }, cdpSessionId);
          const raw = result?.result?.value;
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.detected) { data = parsed; break; }
          }
        } catch {
          return; // Page gone or session invalid
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      if (!data) return;

      // Check if we already have a Turnstile iframe for this page
      const hasTurnstileIframe = [...this.iframeToPage.entries()]
        .some(([, pageId]) => pageId === targetId);

      const challengeType = detectChallengeType('', data, hasTurnstileIframe);
      if (!challengeType) return;

      if (challengeType === 'block') {
        this.log.warn(`CF block page detected on ${targetId}, not solvable`);
        return;
      }

      const info: ChallengeInfo = {
        type: challengeType,
        url: '',
        cType: data.cType,
        cRay: data.cRay,
        detectionMethod: data.method,
      };

      const active: ActiveChallenge = {
        info,
        pageCdpSessionId: cdpSessionId,
        startTime: Date.now(),
        attempt: 1,
        aborted: false,
      };

      this.activeChallenges.set(targetId, active);
      this.emitDetected(info);
      this.marker(cdpSessionId, 'cf.challenge_detected', { type: challengeType });

      // Start solving
      await this.solveChallenge(active);
    } catch (e) {
      this.log.debug(`Challenge detection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async solveChallenge(active: ActiveChallenge): Promise<void> {
    if (active.aborted || this.destroyed) return;

    switch (active.info.type) {
      case 'interstitial':
      case 'embedded':
        await this.solveWithClick(active);
        break;
      case 'invisible':
        await this.solveInvisible(active);
        break;
      case 'managed':
        await this.solveManaged(active);
        break;
    }

    // Keep browser alive while waiting for iframe state change
    if (!active.aborted && !this.destroyed) {
      this.startActivityLoop(active);
    }
  }

  private async solveWithClick(active: ActiveChallenge): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;

    // Phase 1: Human presence simulation (1-3s)
    this.marker(pageCdpSessionId, 'cf.presence_start');
    const presencePos = await simulateHumanPresence(
      this.sendCommand, pageCdpSessionId, 1.0 + Math.random() * 2.5,
    );

    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      await this.resolveAutoSolved(active, 'presence_phase');
      return;
    }

    // Phase 2: Find Turnstile click target via 12-method cascade
    const coords = await this.findClickTarget(pageCdpSessionId);
    if (!coords || active.aborted) return;

    this.emitProgress(active, 'widget_found', { method: coords.method, x: coords.x, y: coords.y });

    // Phase 3: Approach target (1-3s mouse movement via Bezier curves)
    const [targetX, targetY] = await approachCoordinates(
      this.sendCommand, pageCdpSessionId,
      coords.x, coords.y, presencePos,
    );

    // Gate: check abort + auto-solve before committing click
    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      this.marker(pageCdpSessionId, 'cf.click_cancelled', { method: coords.method });
      await this.resolveAutoSolved(active, 'click_cancelled');
      return;
    }

    // Phase 4: Commit click (~100ms mousedown + hold + mouseup)
    await commitClick(this.sendCommand, pageCdpSessionId, targetX, targetY);
    this.emitProgress(active, 'clicked');
  }

  private async solveInvisible(active: ActiveChallenge): Promise<void> {
    if (active.aborted) return;

    // Invisible Turnstile: just simulate presence and wait
    this.marker(active.pageCdpSessionId, 'cf.presence_start', { type: 'invisible' });
    await simulateHumanPresence(this.sendCommand, active.pageCdpSessionId, 2.0 + Math.random() * 2.0);
  }

  private async solveManaged(active: ActiveChallenge): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;

    // Phase 1: Passive wait with presence simulation (3-5s)
    const presencePos = await simulateHumanPresence(
      this.sendCommand, pageCdpSessionId, 3.0 + Math.random() * 2.0,
    );

    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      await this.resolveAutoSolved(active, 'managed_presence');
      return;
    }

    // Phase 2: Find click target
    const coords = await this.findClickTarget(pageCdpSessionId);
    if (!coords || active.aborted) return;

    this.emitProgress(active, 'widget_found', { method: coords.method, x: coords.x, y: coords.y });

    // Phase 3: Approach target
    const [targetX, targetY] = await approachCoordinates(
      this.sendCommand, pageCdpSessionId,
      coords.x, coords.y, presencePos,
    );

    // Gate: check abort + auto-solve before committing
    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      this.marker(pageCdpSessionId, 'cf.click_cancelled', { method: coords.method });
      await this.resolveAutoSolved(active, 'click_cancelled');
      return;
    }

    // Phase 4: Commit click
    await commitClick(this.sendCommand, pageCdpSessionId, targetX, targetY);
    this.emitProgress(active, 'clicked');
  }

  private async findClickTarget(
    cdpSessionId: string,
  ): Promise<{ x: number; y: number; method?: string } | null> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: FIND_CLICK_TARGET_JS,
        returnByValue: true,
      }, cdpSessionId);
      const raw = result?.result?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed ? { x: parsed.x, y: parsed.y, method: parsed.m } : null;
    } catch {
      return null;
    }
  }

  private async isSolved(cdpSessionId: string): Promise<boolean> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `window.__turnstileSolved === true || (function() {
          var el = document.querySelector('[name="cf-turnstile-response"]');
          return !!(el && el.value && el.value.length > 0);
        })()`,
        returnByValue: true,
      }, cdpSessionId);
      return result?.result?.value === true;
    } catch {
      return false;
    }
  }

  /** Resolve an active challenge as auto-solved. Deduplicates the pattern used by solveWithClick and solveManaged. */
  private async resolveAutoSolved(active: ActiveChallenge, signal: string): Promise<void> {
    const duration = Date.now() - active.startTime;
    const token = await this.getToken(active.pageCdpSessionId);
    active.aborted = true; // Stop activity loop
    const pageTargetId = this.findPageBySession(active.pageCdpSessionId);
    if (pageTargetId) this.activeChallenges.delete(pageTargetId);
    this.emitSolved(active, {
      solved: true, type: active.info.type, method: 'auto_solve',
      token: token || undefined, duration_ms: duration,
      attempts: active.attempt, auto_resolved: true, signal,
    });
    this.marker(active.pageCdpSessionId, 'cf.auto_solved', { signal });
  }

  private async getToken(cdpSessionId: string): Promise<string | null> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: TURNSTILE_TOKEN_JS,
        returnByValue: true,
      }, cdpSessionId);
      const val = result?.result?.value;
      return typeof val === 'string' && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  private findPageBySession(cdpSessionId: string): string | undefined {
    for (const [targetId, sid] of this.knownPages) {
      if (sid === cdpSessionId) return targetId;
    }
    return undefined;
  }

  private findPageByIframeSession(iframeCdpSessionId: string): string | undefined {
    for (const [pageTargetId, active] of this.activeChallenges) {
      if (active.iframeCdpSessionId === iframeCdpSessionId) return pageTargetId;
    }
    return undefined;
  }

  /** Background loop that keeps the browser alive after click commit. */
  private startActivityLoop(active: ActiveChallenge): void {
    const loop = async () => {
      while (!active.aborted && !this.destroyed) {
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
        if (active.aborted || this.destroyed) break;

        // Poll for missed auto-solve (token in input or callback flag)
        if (await this.isSolved(active.pageCdpSessionId)) {
          await this.resolveAutoSolved(active, 'activity_poll');
          return;
        }

        // Check for widget error state
        if (await this.isWidgetError(active.pageCdpSessionId)) {
          this.marker(active.pageCdpSessionId, 'cf.widget_error_detected');
          this.emitProgress(active, 'widget_error');
          break; // Let iframe observer or retry logic handle the failure
        }

        // Micro presence: short drift + occasional scroll/keypress
        try {
          await simulateHumanPresence(this.sendCommand, active.pageCdpSessionId, 0.5 + Math.random() * 1.0);
        } catch { break; } // CDP session gone
      }
    };
    loop().catch(() => {});
  }

  /** Check if the Turnstile widget is in an error/expired state. */
  private async isWidgetError(cdpSessionId: string): Promise<boolean> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: TURNSTILE_ERROR_CHECK_JS,
        returnByValue: true,
      }, cdpSessionId);
      return result?.result?.value != null;
    } catch {
      return false;
    }
  }

  /** Re-run challenge detection to verify a solve isn't a false positive. */
  private async isStillChallenge(cdpSessionId: string): Promise<boolean> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: CF_CHALLENGE_DETECTION_JS,
        returnByValue: true,
      }, cdpSessionId);
      const raw = result?.result?.value;
      if (!raw) return false;
      return JSON.parse(raw).detected === true;
    } catch {
      return false; // Can't reach page = probably navigated away = good
    }
  }

  // ─── Event emission helpers ───────────────────────────────

  private emitDetected(info: ChallengeInfo): void {
    this.emitClientEvent('Browserless.challengeDetected', {
      type: info.type,
      url: info.url,
      iframeUrl: info.iframeUrl,
      cType: info.cType,
      cRay: info.cRay,
      detectionMethod: info.detectionMethod,
    }).catch(() => {});
  }

  private emitProgress(active: ActiveChallenge, state: string, extra?: object): void {
    this.emitClientEvent('Browserless.challengeProgress', {
      state,
      elapsed_ms: Date.now() - active.startTime,
      attempt: active.attempt,
      ...extra,
    }).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.state_change', { state, ...extra });
  }

  private emitSolved(active: ActiveChallenge, result: SolveResult): void {
    this.log.info(`Challenge solved: type=${result.type} method=${result.method} duration=${result.duration_ms}ms`);
    this.emitClientEvent('Browserless.challengeSolved', result).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.solved', {
      type: result.type, method: result.method, duration_ms: result.duration_ms,
    });
  }

  private emitFailed(active: ActiveChallenge, reason: string, duration: number): void {
    this.log.warn(`Challenge failed: reason=${reason} duration=${duration}ms attempts=${active.attempt}`);
    this.emitClientEvent('Browserless.challengeFailed', {
      reason, duration_ms: duration, attempts: active.attempt,
    }).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.failed', { reason, duration_ms: duration });
  }

  private marker(cdpSessionId: string, tag: string, payload?: object): void {
    if (this.config.recordingMarkers) {
      this.injectMarker(cdpSessionId, tag, payload);
    }
  }
}
