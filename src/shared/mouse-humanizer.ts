/**
 * Human-like mouse movement simulation via CDP.
 *
 * Uses ghost-cursor (Fitts' Law + arc-length sampling) for path geometry
 * and custom smoothstep timing for CDP event pacing.
 */
import { path as ghostPath } from 'ghost-cursor';

type Point = [number, number];
type Vector = { x: number; y: number };
type SendCommand = (method: string, params?: object, cdpSessionId?: string) => Promise<any>;

/**
 * Generate a human-like curved path using ghost-cursor.
 * Applies micro-jitter to all points except the final one (exact target).
 */
export function generatePath(
  startX: number, startY: number,
  endX: number, endY: number,
  options?: { spreadOverride?: number; moveSpeed?: number },
): Point[] {
  const vectors = ghostPath(
    { x: startX, y: startY },
    { x: endX, y: endY },
    options,
  ) as Vector[];

  return vectors.map((v, i) => {
    if (i < vectors.length - 1) {
      return [v.x + (Math.random() * 2 - 1) * 0.5, v.y + (Math.random() * 2 - 1) * 0.5] as Point;
    }
    return [endX, endY] as Point;
  });
}

// Helper: sleep with ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Helper: random float in range
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// Helper: random int in range (inclusive)
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

/**
 * Execute mouse movement along a path with eased timing.
 * Optionally decelerates the final 25% of points.
 */
export async function executePathSegment(
  sendCommand: SendCommand,
  cdpSessionId: string,
  path: Point[],
  totalDuration: number,
  decelerateFinal: boolean = false,
): Promise<void> {
  const decelThreshold = decelerateFinal ? Math.floor(path.length * 0.75) : path.length;
  const decelFactor = rand(1.8, 2.5);

  const ease = (v: number) => v * v * (3 - 2 * v);

  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const t = i / (path.length - 1);
      const prevT = (i - 1) / (path.length - 1);
      let segDuration = (ease(t) - ease(prevT)) * totalDuration;
      segDuration *= rand(0.8, 1.2); // +-20% variation
      if (decelerateFinal && i >= decelThreshold) segDuration *= decelFactor;
      await sleep(Math.max(5, segDuration * 1000));
    }

    await sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(path[i][0]),
      y: Math.round(path[i][1]),
      button: 'none',
    }, cdpSessionId);
  }
}

/**
 * Execute active overshoot: move past target, pause, correct back.
 */
async function executeOvershootCorrection(
  sendCommand: SendCommand,
  cdpSessionId: string,
  targetX: number, targetY: number,
  approachDx: number, approachDy: number,
): Promise<void> {
  const overshootDist = rand(8, 15);
  const overshootX = targetX + approachDx * overshootDist;
  const overshootY = targetY + approachDy * overshootDist;

  // Move to overshoot point (quick)
  const overshootPath = generatePath(targetX, targetY, overshootX, overshootY, { moveSpeed: 3.0 });
  await executePathSegment(sendCommand, cdpSessionId, overshootPath, rand(0.05, 0.1));

  await sleep(rand(80, 150)); // "Oops" pause

  // Correct back to target with deceleration
  const correctionPath = generatePath(overshootX, overshootY, targetX, targetY, { moveSpeed: 3.0 });
  await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.08, 0.15), true);
}

/**
 * Simulate idle human presence with random mouse drift and optional scroll.
 * Returns final cursor position.
 */
export async function simulateHumanPresence(
  sendCommand: SendCommand,
  cdpSessionId: string,
  duration: number = 2.0,
): Promise<Point> {
  const numWaypoints = randInt(1, 3);
  let currentX = rand(200, 1200);
  let currentY = rand(150, 700);
  const timePerWaypoint = duration / numWaypoints;

  for (let wp = 0; wp < numWaypoints; wp++) {
    const targetX = rand(100, 1400);
    const targetY = rand(100, 800);

    const driftPath = generatePath(currentX, currentY, targetX, targetY, { moveSpeed: 0.5 });

    const ease = (v: number) => v * v * (3 - 2 * v);
    const segTotal = timePerWaypoint * rand(0.4, 0.7);
    for (let i = 0; i < driftPath.length; i++) {
      if (i > 0) {
        const t = i / (driftPath.length - 1);
        const prevT = (i - 1) / (driftPath.length - 1);
        let segDur = (ease(t) - ease(prevT)) * segTotal;
        segDur *= rand(0.7, 1.3);
        await sleep(Math.max(8, segDur * 1000));
      }
      await sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(driftPath[i][0]),
        y: Math.round(driftPath[i][1]),
        button: 'none',
      }, cdpSessionId);
    }

    currentX = targetX;
    currentY = targetY;

    // 30% chance of scroll
    if (Math.random() < 0.3) {
      await sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(currentX),
        y: Math.round(currentY),
        deltaX: 0,
        deltaY: randInt(-80, 80),
        button: 'none',
      }, cdpSessionId);
    }

    // 40% chance of idle keypress
    if (Math.random() < 0.4) {
      const keys = [
        { key: 'Tab', code: 'Tab', keyCode: 9 },
        { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ];
      const chosen = keys[Math.floor(Math.random() * keys.length)];
      await sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: chosen.key, code: chosen.code,
        windowsVirtualKeyCode: chosen.keyCode,
      }, cdpSessionId).catch(() => {});
      await sleep(rand(50, 120));
      await sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: chosen.key, code: chosen.code,
      }, cdpSessionId).catch(() => {});
    }

    // Pause between waypoints
    if (wp < numWaypoints - 1) {
      const remaining = timePerWaypoint - segTotal;
      if (remaining > 0) await sleep(remaining * rand(0.5, 1.0) * 1000);
    }
  }

  return [currentX, currentY];
}

/**
 * Tab+Space keyboard fallback for Turnstile when click target not found.
 *
 * FlareSolverr technique: keyboard focus naturally crosses iframe/shadow DOM
 * boundaries invisible to mouse clicks. Injects a hidden reset button, focuses it,
 * then TABs 1-5 times, pressing SPACE after each to activate the focused element.
 *
 * Returns true if token appeared after any TAB+SPACE attempt.
 */
export async function tabSpaceFallback(
  sendCommand: SendCommand,
  cdpSessionId: string,
  maxTabs: number = 5,
  isSolved: () => Promise<boolean>,
): Promise<boolean> {
  // Inject hidden button at top-left to reset focus position
  try {
    await sendCommand('Runtime.evaluate', {
      expression: `(function() {
        var btn = document.getElementById('__tabSpaceReset');
        if (!btn) {
          btn = document.createElement('button');
          btn.id = '__tabSpaceReset';
          btn.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
          document.body.appendChild(btn);
        }
        btn.focus();
      })()`,
    }, cdpSessionId);
  } catch {
    return false; // Page gone
  }

  for (let tabCount = 1; tabCount <= maxTabs; tabCount++) {
    // TAB key
    await sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9,
    }, cdpSessionId).catch(() => {});
    await sleep(rand(30, 60));
    await sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab',
    }, cdpSessionId).catch(() => {});

    await sleep(rand(80, 120));

    // SPACE key (activate focused element)
    await sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32,
    }, cdpSessionId).catch(() => {});
    await sleep(rand(50, 100));
    await sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space',
    }, cdpSessionId).catch(() => {});

    // Wait for Turnstile to process
    await sleep(rand(800, 1200));

    // Check if solved
    if (await isSolved()) return true;

    // Re-focus reset button for next attempt
    try {
      await sendCommand('Runtime.evaluate', {
        expression: `(function() { var btn = document.getElementById('__tabSpaceReset'); if (btn) btn.focus(); })()`,
      }, cdpSessionId);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Two-phase Bezier approach to coordinates without clicking.
 * Phase 1 (ballistic): 15-25 pts @ 350-650ms to ~20px from target
 * Phase 2 (correction): 8-15 pts @ 150-350ms with deceleration
 * 15% chance of active overshoot between phases.
 * Returns final (targetX, targetY) for commitClick.
 */
export async function approachCoordinates(
  sendCommand: SendCommand,
  cdpSessionId: string,
  x: number, y: number,
  startFrom?: Point,
): Promise<Point> {
  const targetX = Math.round(x) + randInt(-3, 3);
  const targetY = Math.round(y) + randInt(-2, 2);

  // Starting position
  let startX: number, startY: number;
  if (startFrom) {
    [startX, startY] = startFrom;
  } else {
    const angle = rand(0, 2 * Math.PI);
    const dist = rand(150, 500);
    startX = Math.max(10, Math.min(1900, targetX + Math.cos(angle) * dist));
    startY = Math.max(10, Math.min(1060, targetY + Math.sin(angle) * dist));
  }

  const dxApproach = targetX - startX;
  const dyApproach = targetY - startY;
  const approachDist = Math.sqrt(dxApproach * dxApproach + dyApproach * dyApproach);

  if (approachDist > 30) {
    const normDx = dxApproach / approachDist;
    const normDy = dyApproach / approachDist;

    // Intermediate point ~15-25px from target
    const offsetDist = rand(15, 25);
    const lateralOffset = rand(-8, 8);
    const midX = targetX - normDx * offsetDist + (-normDy) * lateralOffset;
    const midY = targetY - normDy * offsetDist + normDx * lateralOffset;

    // Phase 1: ballistic sweep
    const ballisticPath = generatePath(startX, startY, midX, midY);
    await executePathSegment(sendCommand, cdpSessionId, ballisticPath, rand(0.35, 0.65));

    // Mid-path micro-pause
    await sleep(rand(30, 100));

    // 15% chance of overshoot
    if (Math.random() < 0.15) {
      await executeOvershootCorrection(sendCommand, cdpSessionId, targetX, targetY, normDx, normDy);
    } else {
      // Phase 2: correction
      const correctionPath = generatePath(midX, midY, targetX, targetY, { moveSpeed: 1.5 });
      await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.15, 0.35), true);
    }
  } else {
    // Already close — single short correction
    const correctionPath = generatePath(startX, startY, targetX, targetY, { moveSpeed: 1.5 });
    await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.15, 0.35), true);
  }

  // Decision pause (150-400ms)
  await sleep(rand(150, 400));

  return [targetX, targetY];
}

/**
 * Dispatch mousedown + hold + mouseup at coordinates.
 * Hold duration: 80-150ms.
 */
export async function commitClick(
  sendCommand: SendCommand,
  cdpSessionId: string,
  x: number, y: number,
): Promise<void> {
  await sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  }, cdpSessionId);

  await sleep(rand(80, 150));

  await sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  }, cdpSessionId);
}

/**
 * Full click: approach + commit.
 */
export async function clickAtCoordinates(
  sendCommand: SendCommand,
  cdpSessionId: string,
  x: number, y: number,
  startFrom?: Point,
): Promise<void> {
  const [targetX, targetY] = await approachCoordinates(sendCommand, cdpSessionId, x, y, startFrom);
  await commitClick(sendCommand, cdpSessionId, targetX, targetY);
}
