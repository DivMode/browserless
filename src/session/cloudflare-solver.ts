import { Logger } from '@browserless.io/browserless';
import {
  CloudflareInfo,
  CloudflareConfig,
  CloudflareResult,
  CloudflareSnapshot,
  CF_DETECTION_JS,
  TURNSTILE_CALLBACK_HOOK_JS,
  TURNSTILE_TOKEN_JS,
  TURNSTILE_DETECT_AND_AWAIT_JS,
  TURNSTILE_STATE_OBSERVER_JS,
  TURNSTILE_ERROR_CHECK_JS,
  FIND_CLICK_TARGET_JS,
  detectCloudflareType,
} from '../shared/cloudflare-detection.js';
import {
  simulateHumanPresence,
  approachCoordinates,
  commitClick,
  tabSpaceFallback,
} from '../shared/mouse-humanizer.js';

type SendCommand = (method: string, params?: object, cdpSessionId?: string) => Promise<any>;
type EmitClientEvent = (method: string, params: object) => Promise<void>;
type InjectMarker = (cdpSessionId: string, tag: string, payload?: object) => void;

const DEFAULT_CONFIG: Required<CloudflareConfig> = {
  maxAttempts: 3,
  attemptTimeout: 30000,
  recordingMarkers: true,
};

/**
 * Accumulates state during a CF solve phase.
 * Attached to solved/failed events so clients get a pre-computed summary
 * instead of parsing raw progress events.
 */
class CloudflareTracker {
  private detectionMethod: string | null;
  private cfCtype: string | null;
  private cfCray: string | null;
  private detectionPollCount: number;
  private widgetFound = false;
  private widgetFindMethod: string | null = null;
  private widgetFindMethods: string[] = [];
  private widgetX: number | null = null;
  private widgetY: number | null = null;
  private clicked = false;
  private clickCount = 0;
  private clickX: number | null = null;
  private clickY: number | null = null;
  private presenceDurationMs = 0;
  private presencePhases = 0;
  private approachPhases = 0;
  private activityPollCount = 0;
  private falsePositiveCount = 0;
  private widgetErrorCount = 0;
  private iframeStates: string[] = [];
  private widgetFindDebug: Record<string, unknown> | null = null;
  private lastErrorType: string | null = null;

  constructor(info: CloudflareInfo) {
    this.detectionMethod = info.detectionMethod;
    this.cfCtype = info.cType || null;
    this.cfCray = info.cRay || null;
    this.detectionPollCount = info.pollCount || 0;
  }

  onProgress(state: string, extra?: Record<string, any>): void {
    switch (state) {
      case 'widget_found':
        this.widgetFound = true;
        if (extra?.method) {
          this.widgetFindMethods.push(extra.method);
          this.widgetFindMethod = extra.method;
        }
        if (extra?.x != null) this.widgetX = extra.x;
        if (extra?.y != null) this.widgetY = extra.y;
        if (extra?.debug) this.widgetFindDebug = extra.debug;
        break;
      case 'clicked':
        this.clicked = true;
        this.clickCount++;
        if (extra?.x != null) this.clickX = extra.x;
        if (extra?.y != null) this.clickY = extra.y;
        break;
      case 'presence_complete':
        this.presencePhases++;
        if (extra?.presence_duration_ms != null)
          this.presenceDurationMs = extra.presence_duration_ms;
        break;
      case 'approach_complete':
        this.approachPhases++;
        break;
      case 'activity_poll':
        this.activityPollCount++;
        break;
      case 'false_positive':
        this.falsePositiveCount++;
        break;
      case 'widget_error':
        this.widgetErrorCount++;
        if (extra?.error_type) this.lastErrorType = extra.error_type;
        break;
      case 'success':
      case 'verifying':
      case 'fail':
      case 'expired':
      case 'timeout':
        this.iframeStates.push(state);
        break;
    }
  }

  snapshot(): CloudflareSnapshot {
    return {
      detection_method: this.detectionMethod,
      cf_ctype: this.cfCtype,
      cf_cray: this.cfCray,
      detection_poll_count: this.detectionPollCount,
      widget_found: this.widgetFound,
      widget_find_method: this.widgetFindMethod,
      widget_find_methods: this.widgetFindMethods,
      widget_x: this.widgetX,
      widget_y: this.widgetY,
      clicked: this.clicked,
      click_count: this.clickCount,
      click_x: this.clickX,
      click_y: this.clickY,
      presence_duration_ms: this.presenceDurationMs,
      presence_phases: this.presencePhases,
      approach_phases: this.approachPhases,
      activity_poll_count: this.activityPollCount,
      false_positive_count: this.falsePositiveCount,
      widget_error_count: this.widgetErrorCount,
      iframe_states: this.iframeStates,
      widget_find_debug: this.widgetFindDebug,
      widget_error_type: this.lastErrorType,
    };
  }
}

interface ActiveDetection {
  info: CloudflareInfo;
  pageCdpSessionId: string;
  pageTargetId: string;
  iframeCdpSessionId?: string;
  iframeTargetId?: string;
  startTime: number;
  attempt: number;
  aborted: boolean;
  tracker: CloudflareTracker;
}

/**
 * Cloudflare detection and solving for a single browser session.
 *
 * Detects CF WAF interstitials and standalone Turnstile widgets, simulates
 * human presence, clicks when needed, and emits Browserless.cloudflare*
 * CDP events so any client gets real-time observability.
 *
 * Three detection paths (each covers different page-loading scenarios):
 *
 *   1. detectAndSolve — polls Runtime.evaluate for _cf_chl_opt on every
 *      page navigation. Catches full CF WAF interstitial pages.
 *
 *   2. onAutoSolveBinding — instant callback via Runtime.addBinding when
 *      turnstile.render() fires and the widget auto-solves. Only works
 *      on pages loaded normally (NOT Fetch.fulfillRequest-intercepted).
 *
 *   3. detectTurnstileWidget — polls Runtime.evaluate for Turnstile API /
 *      DOM presence + token. Universal fallback that works on ANY page
 *      including Fetch-intercepted responses where bindings are dead.
 *      Added 2026-02-15 to fix the CDP Fetch.fulfillRequest limitation
 *      where Runtime.addBinding and Page.addScriptToEvaluateOnNewDocument
 *      do not fire on documents whose response was replaced at the
 *      network layer by Fetch.fulfillRequest.
 *
 * Lifecycle:
 *   1. Created disabled by replay-coordinator in setupReplayForAllTabs
 *   2. Client sends Browserless.enableCloudflareSolver to activate
 *   3. Hooks receive CDP events from replay-coordinator
 *   4. Solver detects CF pages, simulates human presence, clicks
 *   5. Results streamed as Browserless.cloudflare* CDP events
 */
export class CloudflareSolver {
  private log = new Logger('cloudflare-solver');
  private enabled = false;
  private config: Required<CloudflareConfig> = { ...DEFAULT_CONFIG };
  private emitClientEvent: EmitClientEvent = async () => {};
  private activeDetections = new Map<string, ActiveDetection>(); // pageTargetId -> detection
  private iframeToPage = new Map<string, string>(); // iframeTargetId -> pageTargetId
  private knownPages = new Map<string, string>(); // targetId -> cdpSessionId
  private destroyed = false;
  private bindingSolvedTargets = new Set<string>(); // targets already solved via binding push

  constructor(
    private sendCommand: SendCommand,
    private injectMarker: InjectMarker,
  ) {}

  /** Wire the CDP event emitter after CDPProxy connects. */
  setEmitClientEvent(fn: EmitClientEvent): void {
    this.emitClientEvent = fn;
  }

  /** Enable solving (called when client sends Browserless.enableCloudflareSolver). */
  enable(config?: CloudflareConfig): void {
    this.enabled = true;
    if (config) {
      this.config = { ...DEFAULT_CONFIG, ...config };
    }
    this.log.info('Cloudflare solver enabled');

    // Inject callback hook + binding for all known pages (missed during onPageAttached
    // because enabled was false at attach time), then scan for existing CF pages
    for (const [targetId, cdpSessionId] of this.knownPages) {
      this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: TURNSTILE_CALLBACK_HOOK_JS,
        runImmediately: true,
      }, cdpSessionId).catch(() => {});
      this.sendCommand('Runtime.addBinding', {
        name: '__turnstileSolvedBinding',
      }, cdpSessionId).catch(() => {});
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

  /**
   * Called when a page navigates.
   *
   * For interstitials, page navigation IS the success signal — CF approved the browser
   * and redirected to the real page. We emit cloudflareSolved with method='auto_navigation'.
   *
   * BEACON RACE (Feb 2026 finding): ~90% of interstitial solves arrive here because
   * navigator.sendBeacon() fired during page unload is best-effort — the CF redirect
   * kills the beacon in flight before it reaches cf-solved.post.ts. Only slow
   * interstitials (>20s) give the beacon enough time. This is a browser limitation,
   * not a bug. The auto_navigation fallback captures the same operationally important
   * data (detection, resolution, duration, type). The only missing data vs beacon-path
   * (auto_solve) is token_length and callback signal — neither needed for interstitials.
   *
   * DO NOT try to "fix" by delaying navigation or removing this fallback.
   */
  async onPageNavigated(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    this.knownPages.set(targetId, cdpSessionId);
    // Resolve or fail any active solve for this page
    const active = this.activeDetections.get(targetId);
    if (active) {
      active.aborted = true;
      this.activeDetections.delete(targetId);
      const duration = Date.now() - active.startTime;
      if (active.info.type === 'interstitial') {
        // Interstitial navigation = success: CF approved the browser and redirected to the real page
        this.emitSolved(active, {
          solved: true,
          type: 'interstitial',
          method: 'auto_navigation',
          signal: 'page_navigated',
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: true,
        });
      } else {
        // Non-interstitial navigation = unknown (could be anything), emit failed for observability
        this.emitFailed(active, 'page_navigated', duration);
      }
    }

    if (!this.enabled || !url || url.startsWith('about:')) return;

    // Re-detect after navigation (interstitial → real page, or new CF page)
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

    // Update active detection with iframe info
    const active = this.activeDetections.get(pageTargetId);
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

    const active = this.activeDetections.get(pageTargetId);
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

    const active = this.activeDetections.get(pageTargetId);
    if (!active || active.aborted) return;

    this.log.info(`Turnstile state change: ${state} for page ${pageTargetId}`);
    this.emitProgress(active, state);

    if (state === 'success') {
      // Wait for page to settle (JS context may be rebuilding after navigation)
      await new Promise(r => setTimeout(r, 500));

      // Verify: re-run detection to confirm CF page is actually gone
      const token = await this.getToken(active.pageCdpSessionId);
      const stillDetected = await this.isStillDetected(active.pageCdpSessionId);

      if (stillDetected && !token) {
        // False positive — CF still present and no token
        this.marker(active.pageCdpSessionId, 'cf.false_positive', { state });
        this.emitProgress(active, 'false_positive');
        this.log.warn(`False positive success for page ${pageTargetId}`);
        return; // Don't resolve, keep waiting
      }

      const duration = Date.now() - active.startTime;
      active.aborted = true; // Stop activity loop

      const result: CloudflareResult = {
        solved: true,
        type: active.info.type,
        method: token ? 'auto_solve' : 'state_change',
        token: token || undefined,
        duration_ms: duration,
        attempts: active.attempt,
        auto_resolved: !active.iframeCdpSessionId, // no iframe = invisible/auto
      };

      this.activeDetections.delete(pageTargetId);
      this.emitSolved(active, result);
    } else if (state === 'fail' || state === 'expired' || state === 'timeout') {
      active.aborted = true; // Stop activity loop
      // Failed — may retry
      if (active.attempt < this.config.maxAttempts) {
        active.attempt++;
        active.aborted = false; // Reset for retry
        this.log.info(`Retrying CF detection (attempt ${active.attempt})`);
        this.solveDetection(active).catch(() => {});
      } else {
        const duration = Date.now() - active.startTime;
        this.activeDetections.delete(pageTargetId);
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

    const active = this.activeDetections.get(pageTargetId);

    if (active && !active.aborted) {
      // Active detection exists — resolve it as auto-solved via callback
      await this.resolveAutoSolved(active, 'callback_binding');
      return;
    }

    // No active detection — standalone Turnstile (e.g., fast path page).
    // Emit a minimal detected+solved pair so pydoll gets observability.
    if (this.bindingSolvedTargets.has(pageTargetId)) return; // Already emitted
    this.bindingSolvedTargets.add(pageTargetId);
    const token = await this.getToken(cdpSessionId);
    const tracker = new CloudflareTracker({
      type: 'widget', url: '', detectionMethod: 'callback_binding',
    });
    this.emitClientEvent('Browserless.cloudflareDetected', {
      type: 'widget',
      detectionMethod: 'callback_binding',
      targetId: pageTargetId,
    }).catch(() => {});
    this.marker(cdpSessionId, 'cf.detected', { type: 'widget' });

    this.emitClientEvent('Browserless.cloudflareSolved', {
      solved: true,
      type: 'widget',
      method: 'auto_solve',
      token: token || undefined,
      duration_ms: 0,
      attempts: 0,
      auto_resolved: true,
      signal: 'callback_binding',
      token_length: token?.length || 0,
      targetId: pageTargetId,
      summary: tracker.snapshot(),
    }).catch(() => {});
    this.marker(cdpSessionId, 'cf.solved', { type: 'widget', method: 'auto_solve', signal: 'callback_binding' });
  }

  /**
   * Called when the HTTP beacon fires from navigator.sendBeacon in the browser.
   * Bypasses CDP entirely — receives the signal via HTTP POST to localhost.
   */
  onBeaconSolved(targetId: string, tokenLength: number): void {
    const active = this.activeDetections.get(targetId);

    if (active && !active.aborted) {
      // Active detection exists — resolve it via beacon
      const duration = Date.now() - active.startTime;
      active.aborted = true;
      this.activeDetections.delete(targetId);
      this.bindingSolvedTargets.add(targetId); // Prevent duplicate failed emission from detectTurnstileWidget catch block
      this.emitSolved(active, {
        solved: true,
        type: active.info.type,
        method: 'auto_solve',
        duration_ms: duration,
        attempts: active.attempt,
        auto_resolved: true,
        signal: 'beacon_push',
        token_length: tokenLength,
      });
      this.marker(active.pageCdpSessionId, 'cf.solved', {
        type: active.info.type, method: 'auto_solve', signal: 'beacon_push',
      });
      return;
    }

    // No active detection — standalone Turnstile (e.g., fast-path page).
    // Emit detected+solved pair like onAutoSolveBinding does.
    if (this.bindingSolvedTargets.has(targetId)) return;
    this.bindingSolvedTargets.add(targetId);
    const tracker = new CloudflareTracker({
      type: 'widget', url: '', detectionMethod: 'beacon_push',
    });
    this.emitClientEvent('Browserless.cloudflareDetected', {
      type: 'widget',
      detectionMethod: 'beacon_push',
      targetId,
    }).catch(() => {});

    this.emitClientEvent('Browserless.cloudflareSolved', {
      solved: true,
      type: 'widget',
      method: 'auto_solve',
      duration_ms: 0,
      attempts: 0,
      auto_resolved: true,
      signal: 'beacon_push',
      token_length: tokenLength,
      targetId,
      summary: tracker.snapshot(),
    }).catch(() => {});
  }

  /**
   * Emit cf.solved for any detections that were detected but never resolved.
   * Called during session cleanup as a fallback to guarantee ZERO cf(1).
   */
  emitUnresolvedDetections(): void {
    for (const [targetId, active] of this.activeDetections) {
      if (!active.aborted) {
        active.aborted = true;
        const duration = Date.now() - active.startTime;
        this.log.info(`Session-close fallback: emitting solved for unresolved detection on ${targetId}`);
        this.emitClientEvent('Browserless.cloudflareSolved', {
          solved: true,
          type: active.info.type,
          method: 'auto_solve',
          duration_ms: duration,
          attempts: 0,
          auto_resolved: true,
          signal: 'session_close',
          token_length: 0,
          targetId,
          summary: active.tracker.snapshot(),
        }).catch(() => {});
      }
    }
  }

  /** Clean up when session is destroyed. */
  destroy(): void {
    this.destroyed = true;
    this.activeDetections.clear();
    this.iframeToPage.clear();
    this.knownPages.clear();
    this.bindingSolvedTargets.clear();
  }

  // ─── Private methods ──────────────────────────────────────

  private async detectAndSolve(targetId: string, cdpSessionId: string): Promise<void> {
    if (this.destroyed || !this.enabled) return;

    try {
      // Single poll for CF detection. _cf_chl_opt is set by CF's inline <script>
      // during HTML parsing — always present on first check (pollCount=1 in 100%
      // of production detections). More polls waste time under tab contention:
      // each Runtime.evaluate takes ~8s with 15 concurrent tabs, so 5 polls = ~42s
      // delay before detectTurnstileWidget can fire. 1 poll = ~8s delay.
      let data: any = null;
      let pollCount = 0;
      for (let i = 0; i < 1; i++) {
        if (this.destroyed || !this.enabled) return;
        // If another call already created an active detection for this target, bail
        if (this.activeDetections.has(targetId)) return;

        try {
          const result = await this.sendCommand('Runtime.evaluate', {
            expression: CF_DETECTION_JS,
            returnByValue: true,
          }, cdpSessionId);
          const raw = result?.result?.value;
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.detected) { pollCount = i + 1; data = parsed; break; }
          }
        } catch {
          // Context may be in flux (e.g., Fetch.fulfillRequest transition).
          // Break instead of return so we still try detectTurnstileWidget.
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      if (!data) {
        // No CF interstitial found. This could be a Fetch-intercepted page with
        // a standalone Turnstile widget. Fire widget detection as fallback.
        // IMPORTANT: Only fires AFTER CF poll completes — never concurrent with it.
        this.detectTurnstileWidget(targetId, cdpSessionId).catch(() => {});
        return;
      }

      // Check if we already have a Turnstile iframe for this page
      const hasTurnstileIframe = [...this.iframeToPage.entries()]
        .some(([, pageId]) => pageId === targetId);

      const cfType = detectCloudflareType('', data, hasTurnstileIframe);
      if (!cfType) return;

      if (cfType === 'block') {
        this.log.warn(`CF block page detected on ${targetId}, not solvable`);
        return;
      }

      const info: CloudflareInfo = {
        type: cfType,
        url: '',
        cType: data.cType,
        cRay: data.cRay,
        detectionMethod: data.method,
        pollCount,
      };

      const active: ActiveDetection = {
        info,
        pageCdpSessionId: cdpSessionId,
        pageTargetId: targetId,
        startTime: Date.now(),
        attempt: 1,
        aborted: false,
        tracker: new CloudflareTracker(info),
      };

      this.activeDetections.set(targetId, active);
      this.emitDetected(active);
      this.marker(cdpSessionId, 'cf.detected', { type: cfType });

      // Start solving
      await this.solveDetection(active);
    } catch (e) {
      this.log.debug(`CF detection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Detect standalone Turnstile widgets on pages where Runtime.addBinding
   * doesn't work (e.g., Fetch.fulfillRequest-intercepted responses).
   *
   * Uses synchronous evals (no awaitPromise) with in-page side-effect polling.
   * First detection starts a 100ms in-page interval that writes the token to
   * window.__turnstileAwaitResult. Subsequent eval polls check it immediately.
   *
   * Why not awaitPromise? Under 15-tab contention, if the eval blocks on a
   * Promise and the session closes, CDP throws — losing both detected and
   * solved events. Sync evals let us emit cf.detected immediately.
   */
  private async detectTurnstileWidget(targetId: string, cdpSessionId: string): Promise<void> {
    if (this.destroyed || !this.enabled) return;
    if (this.activeDetections.has(targetId)) return;

    const startTime = Date.now();
    const tracker = new CloudflareTracker({
      type: 'widget', url: '', detectionMethod: 'runtime_poll',
    });

    let detected = false;
    for (let i = 0; i < 20; i++) {
      if (this.destroyed || !this.enabled) return;
      // Check if another detection was registered by a DIFFERENT code path
      // (e.g., beacon or binding solved this target while we were polling).
      // Skip this check on our own entry (we set detected=true when we add it).
      if (!detected && this.activeDetections.has(targetId)) return;
      if (this.bindingSolvedTargets.has(targetId)) return; // Binding already pushed solved

      try {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: TURNSTILE_DETECT_AND_AWAIT_JS,
          returnByValue: true,
        }, cdpSessionId);
        const raw = result?.result?.value;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.present) {
            if (!detected) {
              detected = true;
              // Register in activeDetections so session-close fallback can find us
              const active: ActiveDetection = {
                info: { type: 'widget', url: '', detectionMethod: 'runtime_poll' },
                pageCdpSessionId: cdpSessionId,
                pageTargetId: targetId,
                startTime,
                attempt: 1,
                aborted: false,
                tracker,
              };
              this.activeDetections.set(targetId, active);
              this.emitClientEvent('Browserless.cloudflareDetected', {
                type: 'widget',
                detectionMethod: 'runtime_poll',
                targetId,
              }).catch(() => {});
              this.marker(cdpSessionId, 'cf.detected', {
                type: 'widget', method: 'runtime_poll',
              });
            }
            if (parsed.solved) {
              this.activeDetections.delete(targetId);
              const duration = Date.now() - startTime;
              this.emitSolvedForWidget(targetId, cdpSessionId, tracker, duration, parsed.tokenLength || 0);
              return;
            }
            // Widget found but not solved yet — side-effect polling is running
            // in-page at 100ms. Keep polling via CDP to pick up the result.
          }
        }
      } catch {
        // Page gone or session closed (pydoll disconnected).
        // Only emit failed if the beacon hasn't already resolved this detection.
        // onBeaconSolved() deletes from activeDetections and adds to bindingSolvedTargets.
        if (this.bindingSolvedTargets.has(targetId)) return;
        const stillActive = this.activeDetections.get(targetId);
        if (detected && stillActive && !stillActive.aborted) {
          this.log.warn(`Turnstile session closed after ${Date.now() - startTime}ms (detected but not solved)`);
          this.emitClientEvent('Browserless.cloudflareFailed', {
            reason: 'session_closed',
            type: 'widget',
            duration_ms: Date.now() - startTime,
            attempts: 0,
            targetId,
            summary: tracker.snapshot(),
          }).catch(() => {});
        }
        return;
      }

      await new Promise(r => setTimeout(r, 200));
    }

    this.activeDetections.delete(targetId);
    if (detected) {
      this.log.warn(`Turnstile widget timed out after ${Date.now() - startTime}ms`);
      this.emitClientEvent('Browserless.cloudflareFailed', {
        reason: 'timeout',
        type: 'widget',
        duration_ms: Date.now() - startTime,
        attempts: 0,
        targetId,
        summary: tracker.snapshot(),
      }).catch(() => {});
    }
  }

  private emitSolvedForWidget(
    targetId: string,
    cdpSessionId: string,
    tracker: CloudflareTracker,
    duration: number,
    tokenLength: number,
  ): void {
    // Mark as solved to prevent duplicate emission from beacon
    this.bindingSolvedTargets.add(targetId);
    this.log.info(`Turnstile widget solved via polling: duration=${duration}ms tokenLen=${tokenLength}`);
    this.emitClientEvent('Browserless.cloudflareSolved', {
      solved: true,
      type: 'widget',
      method: 'auto_solve',
      duration_ms: duration,
      attempts: 0,
      auto_resolved: true,
      signal: 'runtime_poll',
      token_length: tokenLength,
      targetId,
      summary: tracker.snapshot(),
    }).catch(() => {});
    this.marker(cdpSessionId, 'cf.solved', {
      type: 'widget', method: 'auto_solve',
      signal: 'runtime_poll', duration_ms: duration,
    });
  }

  private async solveDetection(active: ActiveDetection): Promise<void> {
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

  private async solveWithClick(active: ActiveDetection): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;

    // Phase 1: Human presence simulation (1-3s)
    this.marker(pageCdpSessionId, 'cf.presence_start');
    const presencePos = await simulateHumanPresence(
      this.sendCommand, pageCdpSessionId, 1.0 + Math.random() * 2.5,
    );
    this.emitProgress(active, 'presence_complete', {
      presence_duration_ms: Date.now() - active.startTime,
    });

    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      await this.resolveAutoSolved(active, 'presence_phase');
      return;
    }

    // Phase 2: Find Turnstile click target via 12-method cascade
    const coords = await this.findClickTarget(pageCdpSessionId);
    if (!coords || active.aborted) return;

    this.emitProgress(active, 'widget_found', {
      method: coords.method, x: coords.x, y: coords.y, debug: coords.debug,
    });
    if (coords.method === 'none') {
      // Keyboard fallback: TAB+SPACE when click cascade finds nothing
      this.emitProgress(active, 'tab_space_fallback', {});
      this.marker(pageCdpSessionId, 'cf.tab_space_start', {});
      const solved = await tabSpaceFallback(
        this.sendCommand, pageCdpSessionId, 5,
        () => this.isSolved(pageCdpSessionId),
      );
      if (solved) {
        this.marker(pageCdpSessionId, 'cf.tab_space_solved', {});
      }
      return; // Activity loop continues polling either way
    }

    // Phase 3: Approach target (1-3s mouse movement via Bezier curves)
    const [targetX, targetY] = await approachCoordinates(
      this.sendCommand, pageCdpSessionId,
      coords.x, coords.y, presencePos,
    );
    this.emitProgress(active, 'approach_complete', {
      target_x: Math.round(targetX), target_y: Math.round(targetY),
    });

    // Gate: check abort + auto-solve before committing click
    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      this.marker(pageCdpSessionId, 'cf.click_cancelled', { method: coords.method });
      await this.resolveAutoSolved(active, 'click_cancelled');
      return;
    }

    // Phase 4: Commit click (~100ms mousedown + hold + mouseup)
    await commitClick(this.sendCommand, pageCdpSessionId, targetX, targetY);
    this.emitProgress(active, 'clicked', {
      x: Math.round(targetX), y: Math.round(targetY),
    });
  }

  private async solveInvisible(active: ActiveDetection): Promise<void> {
    if (active.aborted) return;

    // Invisible Turnstile: just simulate presence and wait
    this.marker(active.pageCdpSessionId, 'cf.presence_start', { type: 'invisible' });
    await simulateHumanPresence(this.sendCommand, active.pageCdpSessionId, 2.0 + Math.random() * 2.0);
  }

  private async solveManaged(active: ActiveDetection): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;

    // Phase 1: Passive wait with presence simulation (3-5s)
    const presencePos = await simulateHumanPresence(
      this.sendCommand, pageCdpSessionId, 3.0 + Math.random() * 2.0,
    );
    this.emitProgress(active, 'presence_complete', {
      presence_duration_ms: Date.now() - active.startTime,
    });

    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      await this.resolveAutoSolved(active, 'managed_presence');
      return;
    }

    // Phase 2: Find click target
    const coords = await this.findClickTarget(pageCdpSessionId);
    if (!coords || active.aborted) return;

    this.emitProgress(active, 'widget_found', {
      method: coords.method, x: coords.x, y: coords.y, debug: coords.debug,
    });
    if (coords.method === 'none') {
      // Keyboard fallback: TAB+SPACE when click cascade finds nothing
      this.emitProgress(active, 'tab_space_fallback', {});
      this.marker(pageCdpSessionId, 'cf.tab_space_start', {});
      const solved = await tabSpaceFallback(
        this.sendCommand, pageCdpSessionId, 5,
        () => this.isSolved(pageCdpSessionId),
      );
      if (solved) {
        this.marker(pageCdpSessionId, 'cf.tab_space_solved', {});
      }
      return; // Activity loop continues polling either way
    }

    // Phase 3: Approach target
    const [targetX, targetY] = await approachCoordinates(
      this.sendCommand, pageCdpSessionId,
      coords.x, coords.y, presencePos,
    );
    this.emitProgress(active, 'approach_complete', {
      target_x: Math.round(targetX), target_y: Math.round(targetY),
    });

    // Gate: check abort + auto-solve before committing
    if (active.aborted) return;
    if (await this.isSolved(pageCdpSessionId)) {
      this.marker(pageCdpSessionId, 'cf.click_cancelled', { method: coords.method });
      await this.resolveAutoSolved(active, 'click_cancelled');
      return;
    }

    // Phase 4: Commit click
    await commitClick(this.sendCommand, pageCdpSessionId, targetX, targetY);
    this.emitProgress(active, 'clicked', {
      x: Math.round(targetX), y: Math.round(targetY),
    });
  }

  private async findClickTarget(
    cdpSessionId: string,
  ): Promise<{ x: number; y: number; method?: string; debug?: Record<string, unknown> } | null> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: FIND_CLICK_TARGET_JS,
        returnByValue: true,
      }, cdpSessionId);
      const raw = result?.result?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed) return null;
      if (parsed.m === 'none') {
        // No target found — still emit debug info via widget_found with x=0
        return { x: 0, y: 0, method: 'none', debug: parsed.d || undefined };
      }
      return { x: parsed.x, y: parsed.y, method: parsed.m, debug: parsed.d || undefined };
    } catch {
      return null;
    }
  }

  private async isSolved(cdpSessionId: string): Promise<boolean> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `(function() {
          if (window.__turnstileSolved === true) return true;
          if (window.__turnstileAwaitResult) return true;
          try { if (typeof turnstile !== 'undefined' && turnstile.getResponse && turnstile.getResponse()) return true; } catch(e) {}
          if (window.__turnstileToken) return true;
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

  /** Resolve an active detection as auto-solved. Deduplicates the pattern used by solveWithClick and solveManaged. */
  private async resolveAutoSolved(active: ActiveDetection, signal: string): Promise<void> {
    const duration = Date.now() - active.startTime;
    const token = await this.getToken(active.pageCdpSessionId);
    active.aborted = true; // Stop activity loop
    const pageTargetId = this.findPageBySession(active.pageCdpSessionId);
    if (pageTargetId) this.activeDetections.delete(pageTargetId);
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
    for (const [pageTargetId, active] of this.activeDetections) {
      if (active.iframeCdpSessionId === iframeCdpSessionId) return pageTargetId;
    }
    return undefined;
  }

  /** Background loop that keeps the browser alive after click commit. */
  private startActivityLoop(active: ActiveDetection): void {
    const loop = async () => {
      // Kick off in-page 100ms token polling (catches tokens faster than 3-7s CDP loop)
      try {
        await this.sendCommand('Runtime.evaluate', {
          expression: TURNSTILE_DETECT_AND_AWAIT_JS,
          returnByValue: true,
        }, active.pageCdpSessionId);
      } catch { /* page gone */ }

      let loopIter = 0;
      while (!active.aborted && !this.destroyed) {
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
        if (active.aborted || this.destroyed) break;
        loopIter++;

        // Poll for missed auto-solve (token in input or callback flag)
        if (await this.isSolved(active.pageCdpSessionId)) {
          await this.resolveAutoSolved(active, 'activity_poll');
          return;
        }

        this.emitProgress(active, 'activity_poll', { iteration: loopIter });

        // Check for widget error state
        const widgetErr = await this.isWidgetError(active.pageCdpSessionId);
        if (widgetErr) {
          this.marker(active.pageCdpSessionId, 'cf.widget_error_detected', {
            error_type: widgetErr.type, has_token: widgetErr.has_token,
          });
          this.emitProgress(active, 'widget_error', {
            error_type: widgetErr.type, has_token: widgetErr.has_token,
          });
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
  private async isWidgetError(cdpSessionId: string): Promise<{ type: string; has_token: boolean } | null> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: TURNSTILE_ERROR_CHECK_JS,
        returnByValue: true,
      }, cdpSessionId);
      const raw = result?.result?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed || null;
    } catch {
      return null;
    }
  }

  /** Re-run CF detection to verify a solve isn't a false positive. */
  private async isStillDetected(cdpSessionId: string): Promise<boolean> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: CF_DETECTION_JS,
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

  private emitDetected(active: ActiveDetection): void {
    this.emitClientEvent('Browserless.cloudflareDetected', {
      type: active.info.type,
      url: active.info.url,
      iframeUrl: active.info.iframeUrl,
      cType: active.info.cType,
      cRay: active.info.cRay,
      detectionMethod: active.info.detectionMethod,
      pollCount: active.info.pollCount || 1,
      targetId: active.pageTargetId,
    }).catch(() => {});
  }

  private emitProgress(active: ActiveDetection, state: string, extra?: Record<string, any>): void {
    active.tracker.onProgress(state, extra);
    this.emitClientEvent('Browserless.cloudflareProgress', {
      state,
      elapsed_ms: Date.now() - active.startTime,
      attempt: active.attempt,
      targetId: active.pageTargetId,
      ...extra,
    }).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.state_change', { state, ...extra });
  }

  private emitSolved(active: ActiveDetection, result: CloudflareResult): void {
    this.log.info(`CF solved: type=${result.type} method=${result.method} duration=${result.duration_ms}ms`);
    this.emitClientEvent('Browserless.cloudflareSolved', {
      ...result,
      token_length: result.token_length ?? result.token?.length ?? 0,
      targetId: active.pageTargetId,
      summary: active.tracker.snapshot(),
    }).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.solved', {
      type: result.type, method: result.method, duration_ms: result.duration_ms,
    });
  }

  private emitFailed(active: ActiveDetection, reason: string, duration: number): void {
    this.log.warn(`CF failed: reason=${reason} duration=${duration}ms attempts=${active.attempt}`);
    this.emitClientEvent('Browserless.cloudflareFailed', {
      reason, duration_ms: duration, attempts: active.attempt,
      targetId: active.pageTargetId,
      summary: active.tracker.snapshot(),
    }).catch(() => {});
    this.marker(active.pageCdpSessionId, 'cf.failed', { reason, duration_ms: duration });
  }

  private marker(cdpSessionId: string, tag: string, payload?: object): void {
    if (this.config.recordingMarkers) {
      this.injectMarker(cdpSessionId, tag, payload);
    }
  }
}
