/**
 * Human-like mouse movement simulation via CDP.
 *
 * Ported from pydoll-scraper/src/evasion/mouse.py.
 * Pure math functions + CDP execution functions.
 */

type Point = [number, number];
type SendCommand = (method: string, params?: object, cdpSessionId?: string) => Promise<any>;

/**
 * Calculate a point on a cubic Bezier curve.
 * Formula: (1-t)^3*p0 + 3*(1-t)^2*t*p1 + 3*(1-t)*t^2*p2 + t^3*p3
 */
export function bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return (
    (1 - t) ** 3 * p0 +
    3 * (1 - t) ** 2 * t * p1 +
    3 * (1 - t) * t ** 2 * p2 +
    t ** 3 * p3
  );
}

/**
 * Smoothstep ease-in-out: slow start, fast middle, slow end.
 * t * t * (3 - 2 * t)
 */
export function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Generate a curved mouse path using cubic Bezier curves.
 * Control points deviate perpendicular to the movement vector.
 * 20% chance of near-straight path for short distances (<50px).
 */
export function generateBezierPath(
  startX: number, startY: number,
  endX: number, endY: number,
  numPoints: number = 30,
): Point[] {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Perpendicular vector for curve deviation
  const perpX = distance > 0 ? -dy / distance : 0;
  const perpY = distance > 0 ? dx / distance : 1;

  // 20% chance of near-straight path for short corrections
  if (distance < 50 && Math.random() < 0.2) {
    const path: Point[] = [];
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      path.push([
        startX + dx * t + (Math.random() - 0.5),
        startY + dy * t + (Math.random() - 0.5),
      ]);
    }
    path[path.length - 1] = [endX, endY];
    return path;
  }

  // Asymmetric control point deviation: 15-45% of distance
  const cp1Scale = distance * (0.15 + Math.random() * 0.30);
  const cp2Scale = distance * (0.15 + Math.random() * 0.30);

  const cp1T = 0.20 + Math.random() * 0.20;
  const cp1Dev = (Math.random() * 2 - 1) * cp1Scale;
  const cp1X = startX + dx * cp1T + perpX * cp1Dev;
  const cp1Y = startY + dy * cp1T + perpY * cp1Dev;

  const cp2T = 0.55 + Math.random() * 0.25;
  const cp2Dev = (Math.random() * 2 - 1) * cp2Scale;
  const cp2X = startX + dx * cp2T + perpX * cp2Dev;
  const cp2Y = startY + dy * cp2T + perpY * cp2Dev;

  const path: Point[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    path.push([
      bezierPoint(t, startX, cp1X, cp2X, endX),
      bezierPoint(t, startY, cp1Y, cp2Y, endY),
    ]);
  }
  return path;
}

/**
 * Add random micro-jitter to simulate hand tremor.
 * Last point is never jittered (preserve exact target).
 */
export function addMicroJitter(path: Point[], jitterPx: number = 1.0): Point[] {
  return path.map((p, i) => {
    if (i < path.length - 1) {
      return [
        p[0] + (Math.random() * 2 - 1) * jitterPx,
        p[1] + (Math.random() * 2 - 1) * jitterPx,
      ] as Point;
    }
    return p;
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

  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const t = i / (path.length - 1);
      const prevT = (i - 1) / (path.length - 1);
      let segDuration = (easeInOut(t) - easeInOut(prevT)) * totalDuration;
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

  // Move to overshoot point (3-5 quick steps)
  let overshootPath = generateBezierPath(targetX, targetY, overshootX, overshootY, randInt(3, 5));
  overshootPath = addMicroJitter(overshootPath, 0.5);
  await executePathSegment(sendCommand, cdpSessionId, overshootPath, rand(0.05, 0.1));

  await sleep(rand(80, 150)); // "Oops" pause

  // Correct back to target (4-6 steps with deceleration)
  let correctionPath = generateBezierPath(overshootX, overshootY, targetX, targetY, randInt(4, 6));
  correctionPath = addMicroJitter(correctionPath, 0.3);
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
    const numPts = randInt(10, 20);

    let path = generateBezierPath(currentX, currentY, targetX, targetY, numPts);
    path = addMicroJitter(path, 0.8);

    const segTotal = timePerWaypoint * rand(0.4, 0.7);
    for (let i = 0; i < path.length; i++) {
      if (i > 0) {
        const t = i / (path.length - 1);
        const prevT = (i - 1) / (path.length - 1);
        let segDur = (easeInOut(t) - easeInOut(prevT)) * segTotal;
        segDur *= rand(0.7, 1.3);
        await sleep(Math.max(8, segDur * 1000));
      }
      await sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(path[i][0]),
        y: Math.round(path[i][1]),
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
    let ballisticPath = generateBezierPath(startX, startY, midX, midY, randInt(15, 25));
    ballisticPath = addMicroJitter(ballisticPath, 1.5);
    await executePathSegment(sendCommand, cdpSessionId, ballisticPath, rand(0.35, 0.65));

    // Mid-path micro-pause
    await sleep(rand(30, 100));

    // 15% chance of overshoot
    if (Math.random() < 0.15) {
      await executeOvershootCorrection(sendCommand, cdpSessionId, targetX, targetY, normDx, normDy);
    } else {
      // Phase 2: correction
      let correctionPath = generateBezierPath(midX, midY, targetX, targetY, randInt(8, 15));
      correctionPath = addMicroJitter(correctionPath, 0.5);
      await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.15, 0.35), true);
    }
  } else {
    // Already close — single short correction
    let correctionPath = generateBezierPath(startX, startY, targetX, targetY, randInt(8, 15));
    correctionPath = addMicroJitter(correctionPath, 0.5);
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
