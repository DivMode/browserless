import {
  FIND_CLICK_TARGET_JS,
} from '../../shared/cloudflare-detection.js';
import { FIND_TURNSTILE_TARGET_JS } from '../../generated/cf-scripts.js';
import {
  simulateHumanPresence,
  approachCoordinates,
  commitClick,
  quickApproach,
  postClickDwell,
  tabSpaceFallback,
} from '../../shared/mouse-humanizer.js';
import type { ActiveDetection, CloudflareEventEmitter } from './cloudflare-event-emitter.js';
import type { CloudflareStateTracker, SendCommand } from './cloudflare-state-tracker.js';

function assertNever(x: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${x}`);
}

/**
 * Solve execution strategies for Cloudflare challenges.
 *
 * Contains: solveDetection, solveByClicking, solveTurnstile, solveAutomatic,
 *           performClick, findClickTarget, findTurnstileTarget,
 *           waitForTurnstileTarget, tryTabSpaceFallback
 */
export class CloudflareSolveStrategies {
  constructor(
    private sendCommand: SendCommand,
    private events: CloudflareEventEmitter,
    private state: CloudflareStateTracker,
  ) {}

  async solveDetection(active: ActiveDetection): Promise<void> {
    if (active.aborted || this.state.destroyed) return;

    // Start activity loop BEFORE solve — runs concurrently with solve attempt.
    if (!active.activityLoopStarted) {
      active.activityLoopStarted = true;
      this.state.startActivityLoop(active);
    }

    switch (active.info.type) {
      case 'managed':
        await this.solveByClicking(active, 0.5 + Math.random() * 1.0);
        break;
      case 'interstitial':
        await this.solveByClicking(active, 0.3 + Math.random() * 0.7);
        break;
      case 'turnstile':
        await this.solveTurnstile(active);
        break;
      case 'non_interactive':
      case 'invisible':
        await this.solveAutomatic(active);
        break;
      case 'block':
        throw new Error('block type should not reach solveDetection');
      default:
        assertNever(active.info.type, 'CloudflareType in solveDetection');
    }
  }

  /**
   * Shared click pipeline — single source of truth for all click-based solves.
   */
  private async performClick(
    active: ActiveDetection,
    x: number, y: number,
    options: {
      presencePos?: [number, number];
      lightweight?: boolean;
      deadline?: number;
      method?: string;
    },
  ): Promise<void> {
    const { pageCdpSessionId } = active;
    const deadline = options.deadline ?? Infinity;

    let targetX: number, targetY: number;
    if (options.lightweight) {
      [targetX, targetY] = await quickApproach(
        this.sendCommand, pageCdpSessionId, x + 15, y,
      );
    } else {
      [targetX, targetY] = await approachCoordinates(
        this.sendCommand, pageCdpSessionId,
        x, y, options.presencePos,
      );
    }
    this.events.emitProgress(active, 'approach_complete', {
      target_x: Math.round(targetX), target_y: Math.round(targetY),
    });

    if (active.aborted || Date.now() > deadline) return;
    if (await this.state.isSolved(pageCdpSessionId)) {
      this.events.marker(pageCdpSessionId, 'cf.click_cancelled', { method: options.method });
      await this.state.resolveAutoSolved(active, 'click_cancelled');
      return;
    }

    await commitClick(this.sendCommand, pageCdpSessionId, targetX, targetY);
    this.events.emitProgress(active, 'clicked', {
      x: Math.round(targetX), y: Math.round(targetY),
    });

    try {
      await postClickDwell(this.sendCommand, pageCdpSessionId, targetX, targetY);
    } catch { /* page navigated after solve — expected */ }
  }

  /**
   * Click-based solve for managed and interstitial types.
   */
  private async solveByClicking(active: ActiveDetection, presenceDuration: number): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;

    this.events.marker(pageCdpSessionId, 'cf.presence_start');
    const presencePos = await simulateHumanPresence(
      this.sendCommand, pageCdpSessionId, presenceDuration,
    );
    this.events.emitProgress(active, 'presence_complete', {
      presence_duration_ms: Date.now() - active.startTime,
    });

    if (active.aborted) return;
    if (await this.state.isSolved(pageCdpSessionId)) {
      await this.state.resolveAutoSolved(active, 'presence_phase');
      return;
    }

    const coords = await this.findClickTarget(pageCdpSessionId);
    if (!coords || active.aborted) return;

    this.events.emitProgress(active, 'widget_found', {
      method: coords.method, x: coords.x, y: coords.y, debug: coords.debug,
    });
    if (coords.method === 'none') {
      await this.tryTabSpaceFallback(active);
      return;
    }

    await this.performClick(active, coords.x, coords.y, {
      presencePos, method: coords.method,
    });
  }

  /**
   * Solve standalone Turnstile widgets on third-party pages.
   */
  private async solveTurnstile(active: ActiveDetection): Promise<void> {
    if (active.aborted) return;
    const { pageCdpSessionId } = active;
    const deadline = Date.now() + 30_000;

    if (await this.state.isSolved(pageCdpSessionId)) {
      await this.state.resolveAutoSolved(active, 'turnstile_pre_click');
      return;
    }
    if (active.aborted || Date.now() > deadline) return;

    // Wait for Turnstile iframe to appear
    if (!active.iframeCdpSessionId) {
      for (let i = 0; i < 25; i++) {
        if (active.aborted || Date.now() > deadline) return;
        if (active.iframeCdpSessionId) break;
        if (i % 5 === 4 && await this.state.isSolved(pageCdpSessionId)) {
          await this.state.resolveAutoSolved(active, 'iframe_wait_solved');
          return;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      this.events.emitProgress(active, 'iframe_wait_complete', {
        iframe_found: !!active.iframeCdpSessionId,
      });
    }
    if (active.aborted || Date.now() > deadline) return;

    // Try binding-driven target first (10s timeout)
    let coords = await this.waitForTurnstileTarget(active.pageTargetId, pageCdpSessionId, 10_000);
    if (active.aborted || Date.now() > deadline) return;

    // Fallback: Runtime.evaluate for Fetch-intercepted pages
    if (!coords) {
      coords = await this.findTurnstileTarget(pageCdpSessionId);
      if (active.aborted || Date.now() > deadline) return;
    }

    if (!coords) {
      this.events.emitProgress(active, 'find_target_failed', { attempts: 1 });
      this.events.marker(pageCdpSessionId, 'cf.find_failed', { attempts: 1 });
      await this.tryTabSpaceFallback(active, 2);
      return;
    }

    this.events.emitProgress(active, 'widget_found', {
      method: coords.method, x: coords.x, y: coords.y, debug: coords.debug,
    });
    if (coords.method === 'none') {
      await this.tryTabSpaceFallback(active, 2);
      return;
    }

    await this.performClick(active, coords.x, coords.y, {
      lightweight: true, deadline, method: coords.method,
    });
  }

  private async tryTabSpaceFallback(active: ActiveDetection, maxTabs = 5): Promise<void> {
    this.events.emitProgress(active, 'tab_space_fallback', {});
    this.events.marker(active.pageCdpSessionId, 'cf.tab_space_start', {});
    const solved = await tabSpaceFallback(
      this.sendCommand, active.pageCdpSessionId, maxTabs,
      () => this.state.isSolved(active.pageCdpSessionId),
    );
    if (solved) {
      this.events.marker(active.pageCdpSessionId, 'cf.tab_space_solved', {});
    }
  }

  /**
   * Auto-solve for non_interactive and invisible types.
   */
  private async solveAutomatic(active: ActiveDetection): Promise<void> {
    if (active.aborted) return;
    this.events.marker(active.pageCdpSessionId, 'cf.presence_start', { type: active.info.type });
    await simulateHumanPresence(this.sendCommand, active.pageCdpSessionId, 2.0 + Math.random() * 2.0);
  }

  /**
   * Wait for the MutationObserver-based target finder to deliver coordinates.
   */
  async waitForTurnstileTarget(
    pageTargetId: string, _cdpSessionId: string, timeoutMs: number,
  ): Promise<{ x: number; y: number; method: string; debug?: Record<string, unknown> } | null> {
    const pending = this.state.pendingTargetCoords.get(pageTargetId);
    if (pending) {
      this.state.pendingTargetCoords.delete(pageTargetId);
      return pending;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.state.targetCoordResolvers.delete(pageTargetId);
        resolve(null);
      }, timeoutMs);

      this.state.targetCoordResolvers.set(pageTargetId, (coords) => {
        clearTimeout(timer);
        resolve(coords);
      });
    });
  }

  async findClickTarget(
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
        return { x: 0, y: 0, method: 'none', debug: parsed.d || undefined };
      }
      return { x: parsed.x, y: parsed.y, method: parsed.m, debug: parsed.d || undefined };
    } catch (err) {
      console.warn('[CF] findClickTarget failed:', (err as Error)?.message || err);
      return null;
    }
  }

  /**
   * Find Turnstile widget click target using the dedicated widget finder.
   */
  async findTurnstileTarget(
    cdpSessionId: string,
  ): Promise<{ x: number; y: number; method: string; debug?: Record<string, unknown> } | null> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: FIND_TURNSTILE_TARGET_JS,
        returnByValue: true,
      }, cdpSessionId);
      const raw = result?.result?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed) return null;
      if (parsed.m === 'none') {
        return { x: 0, y: 0, method: 'none', debug: parsed.d || undefined };
      }
      return { x: parsed.x, y: parsed.y, method: parsed.m, debug: parsed.d || undefined };
    } catch (err) {
      console.warn('[CF] findTurnstileTarget failed:', (err as Error)?.message || err);
      return null;
    }
  }
}
