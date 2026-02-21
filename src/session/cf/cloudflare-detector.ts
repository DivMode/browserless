import { Logger } from '@browserless.io/browserless';
import type { CloudflareConfig, CloudflareInfo } from '../../shared/cloudflare-detection.js';
import {
  CF_DETECTION_JS,
  TURNSTILE_CALLBACK_HOOK_JS,
  TURNSTILE_STATE_OBSERVER_JS,
  TURNSTILE_DETECT_AND_AWAIT_JS,
  detectCloudflareType,
} from '../../shared/cloudflare-detection.js';
import { TURNSTILE_TARGET_OBSERVER_JS } from '../../generated/cf-scripts.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection, CloudflareEventEmitter } from './cloudflare-event-emitter.js';
import type { CloudflareStateTracker, SendCommand } from './cloudflare-state-tracker.js';
import type { CloudflareSolveStrategies } from './cloudflare-solve-strategies.js';

/**
 * Detection lifecycle for Cloudflare challenges.
 *
 * Three detection paths:
 *   1. detectAndSolve — polls for _cf_chl_opt on every page navigation
 *   2. onAutoSolveBinding — instant callback via Runtime.addBinding (handled by state tracker)
 *   3. detectTurnstileWidget — polls for Turnstile API / DOM presence + token
 */
export class CloudflareDetector {
  private log = new Logger('cf-detect');
  private enabled = false;

  constructor(
    private sendCommand: SendCommand,
    private events: CloudflareEventEmitter,
    private state: CloudflareStateTracker,
    private strategies: CloudflareSolveStrategies,
  ) {}

  enable(config?: CloudflareConfig): void {
    this.enabled = true;
    if (config) {
      this.state.config = { ...this.state.config, ...config };
      this.events.recordingMarkers = this.state.config.recordingMarkers;
    }
    this.log.info('Cloudflare solver enabled');

    // Inject callback hook + binding for all known pages, then scan for existing CF pages
    for (const [targetId, cdpSessionId] of this.state.knownPages) {
      this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: TURNSTILE_CALLBACK_HOOK_JS,
        runImmediately: true,
      }, cdpSessionId).catch(() => {});
      this.sendCommand('Runtime.addBinding', {
        name: '__turnstileSolvedBinding',
      }, cdpSessionId).catch(() => {});
      this.sendCommand('Runtime.addBinding', {
        name: '__turnstileTargetBinding',
      }, cdpSessionId).catch(() => {});
      this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: TURNSTILE_TARGET_OBSERVER_JS,
        runImmediately: true,
      }, cdpSessionId).catch(() => {});
      this.detectAndSolve(targetId, cdpSessionId).catch(() => {});
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called when a new page target is attached. */
  async onPageAttached(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    this.state.knownPages.set(targetId, cdpSessionId);
    if (!this.enabled || !url || url.startsWith('about:')) return;

    this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: TURNSTILE_CALLBACK_HOOK_JS,
      runImmediately: true,
    }, cdpSessionId).catch(() => {});
    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileSolvedBinding',
    }, cdpSessionId).catch(() => {});
    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileTargetBinding',
    }, cdpSessionId).catch(() => {});
    this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: TURNSTILE_TARGET_OBSERVER_JS,
      runImmediately: true,
    }, cdpSessionId).catch(() => {});

    await this.detectAndSolve(targetId, cdpSessionId);
  }

  /** Called when a page navigates. */
  async onPageNavigated(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    this.state.knownPages.set(targetId, cdpSessionId);

    const active = this.state.activeDetections.get(targetId);
    if (active) {
      active.aborted = true;
      this.state.activeDetections.delete(targetId);
      const duration = Date.now() - active.startTime;
      if (active.info.type === 'interstitial') {
        // Don't emit cf.solved yet — verify the destination isn't another challenge.
        // Wait for new page to settle, then check.
        await new Promise((r) => setTimeout(r, 500));
        let destinationIsCF = false;
        try {
          const result = await this.sendCommand('Runtime.evaluate', {
            expression: CF_DETECTION_JS,
            returnByValue: true,
          }, cdpSessionId);
          const raw = result?.result?.value;
          if (raw) {
            const parsed = JSON.parse(raw);
            destinationIsCF = !!parsed.detected;
          }
        } catch {
          // CDP error (context destroyed, etc.) — assume not CF, emit solved
        }

        if (destinationIsCF) {
          this.log.info(`Navigation from interstitial landed on another CF challenge — suppressing cf.solved`);
          this.events.marker(cdpSessionId, 'cf.rechallenge', {
            type: 'interstitial', duration_ms: duration,
          });
          // Let detectAndSolve below handle the new challenge page
        } else {
          this.events.emitSolved(active, {
            solved: true,
            type: 'interstitial',
            method: 'auto_navigation',
            signal: 'page_navigated',
            duration_ms: duration,
            attempts: active.attempt,
            auto_resolved: true,
          });
        }
      } else {
        this.events.emitFailed(active, 'page_navigated', duration);
      }
    }

    if (!this.enabled || !url || url.startsWith('about:')) return;

    // If we already waited 500ms for interstitial verification above, skip the delay
    if (!active || active.info.type !== 'interstitial') {
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.detectAndSolve(targetId, cdpSessionId);
  }

  /** Called when a cross-origin iframe is attached. */
  async onIframeAttached(
    iframeTargetId: string, iframeCdpSessionId: string,
    url: string, parentCdpSessionId: string,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!url?.includes('challenges.cloudflare.com')) return;

    const pageTargetId = this.state.findPageBySession(parentCdpSessionId);
    if (!pageTargetId) return;

    this.state.iframeToPage.set(iframeTargetId, pageTargetId);

    const active = this.state.activeDetections.get(pageTargetId);
    if (active) {
      active.iframeCdpSessionId = iframeCdpSessionId;
      active.iframeTargetId = iframeTargetId;
    } else {
      this.state.pendingIframes.set(pageTargetId, { iframeCdpSessionId, iframeTargetId });
      const pageCdpSessionId = this.state.knownPages.get(pageTargetId);
      if (pageCdpSessionId) {
        this.detectTurnstileWidget(pageTargetId, pageCdpSessionId).catch(() => {});
      }
    }

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

  /** Called when an iframe navigates (Target.targetInfoChanged for type=iframe). */
  async onIframeNavigated(
    iframeTargetId: string, iframeCdpSessionId: string, url: string,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!url?.includes('challenges.cloudflare.com')) return;

    const pageTargetId = this.state.iframeToPage.get(iframeTargetId);
    if (!pageTargetId) return;

    const active = this.state.activeDetections.get(pageTargetId);
    if (active && !active.iframeCdpSessionId) {
      active.iframeCdpSessionId = iframeCdpSessionId;
      active.iframeTargetId = iframeTargetId;
    } else if (!active) {
      const pageCdpSessionId = this.state.knownPages.get(pageTargetId);
      if (pageCdpSessionId) {
        this.detectTurnstileWidget(pageTargetId, pageCdpSessionId).catch(() => {});
      }
    }

    this.sendCommand('Runtime.addBinding', {
      name: '__turnstileStateBinding',
    }, iframeCdpSessionId).catch(() => {});
    this.sendCommand('Runtime.evaluate', {
      expression: TURNSTILE_STATE_OBSERVER_JS,
    }, iframeCdpSessionId).catch(() => {});
  }

  // ─── Private detection methods ──────────────────────────────────────

  private async detectAndSolve(targetId: string, cdpSessionId: string): Promise<void> {
    if (this.state.destroyed || !this.enabled) return;

    try {
      let data: any = null;
      let pollCount = 0;
      for (let i = 0; i < 1; i++) {
        if (this.state.destroyed || !this.enabled) return;
        if (this.state.activeDetections.has(targetId)) return;

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
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      if (!data) {
        this.detectTurnstileWidget(targetId, cdpSessionId).catch(() => {});
        return;
      }

      const hasTurnstileIframe = [...this.state.iframeToPage.entries()]
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

      this.state.activeDetections.set(targetId, active);
      const pending = this.state.pendingIframes.get(targetId);
      if (pending) {
        active.iframeCdpSessionId = pending.iframeCdpSessionId;
        active.iframeTargetId = pending.iframeTargetId;
        this.state.pendingIframes.delete(targetId);
      }
      this.events.emitDetected(active);
      this.events.marker(cdpSessionId, 'cf.detected', { type: cfType });

      await this.strategies.solveDetection(active);
    } catch (e) {
      this.log.debug(`CF detection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Detect standalone Turnstile widgets on pages where Runtime.addBinding
   * doesn't work (e.g., Fetch.fulfillRequest-intercepted responses).
   */
  private async detectTurnstileWidget(targetId: string, cdpSessionId: string): Promise<void> {
    if (this.state.destroyed || !this.enabled) return;
    if (this.state.activeDetections.has(targetId)) return;

    const startTime = Date.now();

    for (let i = 0; i < 20; i++) {
      if (this.state.destroyed || !this.enabled) return;
      if (this.state.activeDetections.has(targetId)) return;
      if (this.state.bindingSolvedTargets.has(targetId)) return;

      try {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: TURNSTILE_DETECT_AND_AWAIT_JS,
          returnByValue: true,
        }, cdpSessionId);
        const raw = result?.result?.value;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.present) {
            const info: CloudflareInfo = {
              type: 'turnstile', url: '', detectionMethod: 'runtime_poll',
            };
            const active: ActiveDetection = {
              info, pageCdpSessionId: cdpSessionId, pageTargetId: targetId,
              startTime, attempt: 1, aborted: false,
              tracker: new CloudflareTracker(info),
            };

            if (parsed.solved && !this.state.bindingSolvedTargets.has(targetId)) {
              active.aborted = true;
              this.state.bindingSolvedTargets.add(targetId);
              this.events.emitDetected(active);
              this.events.marker(cdpSessionId, 'cf.detected', { type: 'turnstile', method: 'runtime_poll' });
              this.events.emitSolved(active, {
                solved: true, type: 'turnstile', method: 'auto_solve',
                duration_ms: Date.now() - startTime, attempts: 1,
                auto_resolved: true, signal: 'runtime_poll',
                token_length: parsed.tokenLength || 0,
              });
              return;
            }

            this.state.activeDetections.set(targetId, active);
            const pending = this.state.pendingIframes.get(targetId);
            if (pending) {
              active.iframeCdpSessionId = pending.iframeCdpSessionId;
              active.iframeTargetId = pending.iframeTargetId;
              this.state.pendingIframes.delete(targetId);
            }
            this.events.emitDetected(active);
            this.events.marker(cdpSessionId, 'cf.detected', { type: 'turnstile', method: 'runtime_poll' });
            await this.strategies.solveDetection(active);
            return;
          }
        }
      } catch {
        // Transient CDP error (context destroyed, timeout, etc.) — keep polling.
        // Previously this was `return`, which silently abandoned detection on
        // any single CDP failure, causing BLIND_PIPELINE (cf_events=0).
      }

      await new Promise(r => setTimeout(r, 200));
    }
  }
}
