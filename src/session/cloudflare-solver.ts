import type { CloudflareConfig } from '../shared/cloudflare-detection.js';
import { CloudflareDetector } from './cf/cloudflare-detector.js';
import { CloudflareSolveStrategies } from './cf/cloudflare-solve-strategies.js';
import { CloudflareStateTracker } from './cf/cloudflare-state-tracker.js';
import { CloudflareEventEmitter } from './cf/cloudflare-event-emitter.js';
import type { EmitClientEvent, InjectMarker } from './cf/cloudflare-event-emitter.js';
import type { SendCommand } from './cf/cloudflare-state-tracker.js';

/**
 * Cloudflare detection and solving for a single browser session.
 *
 * Thin delegator — preserves the identical public interface that ReplaySession,
 * ReplayCoordinator, and BrowsersCDP depend on. All logic lives in:
 *   - CloudflareDetector: detection lifecycle
 *   - CloudflareSolveStrategies: solve execution
 *   - CloudflareStateTracker: active detection state + background loops
 *   - CloudflareEventEmitter: CDP event emission + recording markers
 */
export class CloudflareSolver {
  private detector: CloudflareDetector;
  private strategies: CloudflareSolveStrategies;
  private stateTracker: CloudflareStateTracker;
  private events: CloudflareEventEmitter;

  constructor(sendCommand: SendCommand, injectMarker: InjectMarker) {
    this.events = new CloudflareEventEmitter(injectMarker);
    this.stateTracker = new CloudflareStateTracker(sendCommand, this.events);
    this.strategies = new CloudflareSolveStrategies(sendCommand, this.events, this.stateTracker);
    this.detector = new CloudflareDetector(sendCommand, this.events, this.stateTracker, this.strategies);

    // Wire retry callback: when state tracker detects a retry-worthy failure,
    // it calls back into strategies.solveDetection
    this.stateTracker.onRetryCallback = (active) => {
      this.strategies.solveDetection(active).catch(() => {});
    };
  }

  setEmitClientEvent(fn: EmitClientEvent): void {
    this.events.setEmitClientEvent(fn);
  }

  enable(config?: CloudflareConfig): void {
    this.detector.enable(config);
  }

  isEnabled(): boolean {
    return this.detector.isEnabled();
  }

  async onPageAttached(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    return this.detector.onPageAttached(targetId, cdpSessionId, url);
  }

  async onPageNavigated(targetId: string, cdpSessionId: string, url: string): Promise<void> {
    return this.detector.onPageNavigated(targetId, cdpSessionId, url);
  }

  async onIframeAttached(
    iframeTargetId: string, iframeCdpSessionId: string,
    url: string, parentCdpSessionId: string,
  ): Promise<void> {
    return this.detector.onIframeAttached(iframeTargetId, iframeCdpSessionId, url, parentCdpSessionId);
  }

  async onIframeNavigated(
    iframeTargetId: string, iframeCdpSessionId: string, url: string,
  ): Promise<void> {
    return this.detector.onIframeNavigated(iframeTargetId, iframeCdpSessionId, url);
  }

  async onTurnstileStateChange(state: string, iframeCdpSessionId: string): Promise<void> {
    return this.stateTracker.onTurnstileStateChange(state, iframeCdpSessionId);
  }

  async onAutoSolveBinding(cdpSessionId: string): Promise<void> {
    return this.stateTracker.onAutoSolveBinding(cdpSessionId);
  }

  onBeaconSolved(targetId: string, tokenLength: number): void {
    return this.stateTracker.onBeaconSolved(targetId, tokenLength);
  }

  async onTurnstileTargetFound(cdpSessionId: string, payload: string): Promise<void> {
    return this.stateTracker.onTurnstileTargetFound(cdpSessionId, payload);
  }

  emitUnresolvedDetections(): void {
    return this.stateTracker.emitUnresolvedDetections();
  }

  destroy(): void {
    this.stateTracker.destroy();
  }
}
