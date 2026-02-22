/**
 * Human-like mouse movement simulation via CDP.
 *
 * Generates gentle arcs using cubic Bezier curves with path-aligned knots.
 * Knots are placed along the movement direction with a perpendicular offset
 * to one side — matching how a real wrist/elbow pivot creates a smooth arc.
 * Resampled with easeOutQuad and power-scale point count from Camoufox.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { calculatePointsInCurve } from './human-cursor/bezier-calculator.js';

const execAsync = promisify(exec);

/**
 * Chrome toolbar height in headed mode (tab strip + URL bar).
 * In Xvfb without a window manager, the X11 window starts at the top of Chrome's
 * tab strip. The viewport content area starts ~85px below that.
 * xdotool --window coordinates are relative to the X11 window top, so viewport
 * coordinates from getBoundingClientRect() need this offset added to Y.
 */
const CHROME_TOOLBAR_OFFSET = 85;

type Point = [number, number];
type Vector = { x: number; y: number };
type SendCommand = (method: string, params?: object, cdpSessionId?: string) => Promise<any>;

/** Box-Muller normal distribution */
function randomNormal(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * stdDev + mean;
}

/** easeOutQuad: fast start, gentle decel */
function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/**
 * Generate a human-like curved path.
 *
 * Places 2 asymmetric knots (20-35% and 60-80%) along the path, offset
 * perpendicular to the SAME side (arc, not S-curve). Arc amount is 12-30%
 * of distance. Gaussian distortion on both axes adds micro-noise.
 * Point count uses Camoufox's power-scale formula: arcLength^0.25 * 8.
 */
export function generatePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  options?: { moveSpeed?: number },
): Point[] {
  const distance = Math.hypot(endX - startX, endY - startY);
  if (distance < 1) return [[startX, startY], [endX, endY]];

  // Unit direction and perpendicular vectors
  const ux = (endX - startX) / distance;
  const uy = (endY - startY) / distance;
  const px = -uy; // perpendicular
  const py = ux;

  // Gentle arc: 12-30% of distance, always to the same side
  const arcAmount = distance * (0.12 + Math.random() * 0.18);
  const arcSign = Math.random() < 0.5 ? 1 : -1;

  // Randomize knot positions — not fixed 1/3, 2/3
  const t1 = 0.2 + Math.random() * 0.15;  // 20-35% along path
  const t2 = 0.6 + Math.random() * 0.2;   // 60-80% along path

  // Front knot arcs more (0.8-1.2x), back knot flattens (0.4-0.7x)
  const knot1: Vector = {
    x: startX + ux * distance * t1 + px * arcAmount * arcSign * (0.8 + Math.random() * 0.4),
    y: startY + uy * distance * t1 + py * arcAmount * arcSign * (0.8 + Math.random() * 0.4),
  };
  const knot2: Vector = {
    x: startX + ux * distance * t2 + px * arcAmount * arcSign * (0.4 + Math.random() * 0.3),
    y: startY + uy * distance * t2 + py * arcAmount * arcSign * (0.4 + Math.random() * 0.3),
  };

  // Raw cubic Bezier (4 control points)
  const numRaw = Math.max(30, Math.min(200, Math.floor(distance * 0.5)));
  const controlPoints: Vector[] = [
    { x: startX, y: startY },
    knot1,
    knot2,
    { x: endX, y: endY },
  ];
  const rawPoints = calculatePointsInCurve(numRaw, controlPoints);

  // Gaussian distortion on both axes (60% of interior points, stddev=1.5px)
  const distorted = rawPoints.map((p, i) => {
    if (i === 0 || i === rawPoints.length - 1) return p;
    const dx = Math.random() < 0.6 ? randomNormal(0, 1.5) : 0;
    const dy = Math.random() < 0.6 ? randomNormal(0, 1.5) : 0;
    return { x: p.x + dx, y: p.y + dy };
  });

  // Arc length for power-scale point count
  let arcLength = 0;
  for (let i = 1; i < distorted.length; i++) {
    arcLength += Math.hypot(
      distorted[i].x - distorted[i - 1].x,
      distorted[i].y - distorted[i - 1].y,
    );
  }

  // Camoufox formula: arcLength^0.25 * 8, clamped [2, 60], scaled by speed
  const speed = options?.moveSpeed ?? 1.0;
  const n = Math.min(
    60,
    Math.max(2, Math.round(Math.pow(arcLength, 0.25) * 8 / speed)),
  );

  // Resample with easeOutQuad — pick existing points at eased indices
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const easedT = easeOutQuad(t);
    const index = Math.min(
      Math.floor(easedT * (distorted.length - 1)),
      distorted.length - 1,
    );
    result.push([distorted[index].x, distorted[index].y]);
  }

  // Force exact endpoint
  result[result.length - 1] = [endX, endY];

  return result;
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
      await sleep(Math.max(18, segDuration * 1000));
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
  const numWaypoints = duration < 0.8 ? 1 : randInt(1, 2);
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
        await sleep(Math.max(20, segDur * 1000));
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
    const dist = rand(80, 200);
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
    const offsetDist = rand(25, 45);
    const lateralOffset = rand(-12, 12);
    const midX = targetX - normDx * offsetDist + (-normDy) * lateralOffset;
    const midY = targetY - normDy * offsetDist + normDx * lateralOffset;

    // Phase 1: ballistic sweep
    const ballisticPath = generatePath(startX, startY, midX, midY);
    await executePathSegment(sendCommand, cdpSessionId, ballisticPath, rand(0.30, 0.55));

    // Mid-path micro-pause
    await sleep(rand(30, 100));

    // 15% chance of overshoot
    if (Math.random() < 0.15) {
      await executeOvershootCorrection(sendCommand, cdpSessionId, targetX, targetY, normDx, normDy);
    } else {
      // Phase 2: correction
      const correctionPath = generatePath(midX, midY, targetX, targetY, { moveSpeed: 1.5 });
      await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.20, 0.45), true);
    }
  } else {
    // Already close — single short correction
    const correctionPath = generatePath(startX, startY, targetX, targetY, { moveSpeed: 1.5 });
    await executePathSegment(sendCommand, cdpSessionId, correctionPath, rand(0.20, 0.45), true);
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
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  }, cdpSessionId);

  await sleep(rand(80, 150));

  await sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
  }, cdpSessionId);
}

/**
 * Lightweight approach for contended sessions (~6-8 CDP calls).
 * Single Bezier arc from a nearby random position. Skips the two-phase
 * ballistic+correction split of approachCoordinates to minimise CDP overhead
 * while still producing a curved, human-looking trajectory.
 */
export async function quickApproach(
  sendCommand: SendCommand,
  cdpSessionId: string,
  targetX: number, targetY: number,
): Promise<Point> {
  const finalX = Math.round(targetX) + randInt(-2, 2);
  const finalY = Math.round(targetY) + randInt(-1, 1);

  // Start 50-80px away in a random direction
  const angle = rand(0, 2 * Math.PI);
  const dist = rand(50, 80);
  const startX = Math.max(10, Math.min(1900, finalX + Math.cos(angle) * dist));
  const startY = Math.max(10, Math.min(1060, finalY + Math.sin(angle) * dist));

  // moveSpeed 3.0 → ~6-8 points instead of ~20
  const path = generatePath(startX, startY, finalX, finalY, { moveSpeed: 3.0 });
  await executePathSegment(sendCommand, cdpSessionId, path, rand(0.15, 0.35), true);

  // Brief decision pause before click
  await sleep(rand(100, 250));

  return [finalX, finalY];
}

/**
 * Post-click dwell: keeps cursor near click position with tiny micro-movements,
 * then slowly drifts away. Prevents the suspicious "click-and-teleport" pattern
 * that Turnstile uses as a bot signal.
 *
 * ~6-10 CDP calls total (2-4 micro-moves + 4-6 drift points).
 */
export async function postClickDwell(
  sendCommand: SendCommand,
  cdpSessionId: string,
  clickX: number, clickY: number,
): Promise<void> {
  // Phase 1: Micro-drift near click position (300-600ms)
  const dwellTime = rand(300, 600);
  const microMoves = randInt(2, 4);
  const microDelay = dwellTime / microMoves;

  let curX = clickX;
  let curY = clickY;
  for (let i = 0; i < microMoves; i++) {
    await sleep(microDelay);
    curX += rand(-3, 3);
    curY += rand(-2, 2);
    await sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(curX),
      y: Math.round(curY),
      button: 'none',
    }, cdpSessionId);
  }

  // Phase 2: Slow drift away (200-400ms, 30-60px)
  const driftAngle = rand(0, 2 * Math.PI);
  const driftDist = rand(30, 60);
  const driftX = curX + Math.cos(driftAngle) * driftDist;
  const driftY = curY + Math.sin(driftAngle) * driftDist;

  const driftPath = generatePath(curX, curY, driftX, driftY, { moveSpeed: 3.0 });
  await executePathSegment(sendCommand, cdpSessionId, driftPath, rand(0.2, 0.4));
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

/**
 * Simulate idle human presence via xdotool (OS-level X11 events).
 * Generates random mouse drifts across the page before clicking.
 * This ensures CF's WASM verifier sees real (non-kFromDebugger) mousemove
 * history on the page before the click attempt.
 */
export async function xdotoolPresence(
  durationMs: number = 2000,
  chromePid?: number,
): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return false;

  try {
    const windowId = await findChromeWindow(chromePid);
    if (!windowId) return false;

    // Raise window to top of Z-order and set input focus.
    // On Xvfb without a WM, multiple Chrome windows overlap at the same position.
    // X11 events go to the topmost window, so we must raise ours before sending events.
    await execAsync(`xdotool windowraise ${windowId}`).catch(() => {});
    await execAsync(`xdotool windowfocus --sync ${windowId}`).catch(() => {});

    const startTime = Date.now();
    // Presence coordinates are in X11 window space (add toolbar offset to stay in viewport)
    let curX = 200 + Math.random() * 800;
    let curY = CHROME_TOOLBAR_OFFSET + 150 + Math.random() * 500;

    // Move to initial position
    await execAsync(`xdotool mousemove --window ${windowId} ${Math.round(curX)} ${Math.round(curY)}`);

    // Random drifts until duration elapsed
    while (Date.now() - startTime < durationMs) {
      const destX = 100 + Math.random() * 1400;
      const destY = CHROME_TOOLBAR_OFFSET + 100 + Math.random() * 700;
      const path = generatePath(curX, curY, destX, destY, { moveSpeed: 0.5 });

      // Subsample — send ~6-10 points per drift
      const step = Math.max(1, Math.floor(path.length / (6 + Math.floor(Math.random() * 5))));
      for (let i = 0; i < path.length && Date.now() - startTime < durationMs; i += step) {
        const px = Math.round(path[i][0]);
        const py = Math.round(path[i][1]);
        await execAsync(`xdotool mousemove --window ${windowId} ${px} ${py}`);
        await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
      }

      curX = destX;
      curY = destY;

      // Pause between drifts
      await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Find Chrome's main X11 window ID.
 *
 * When chromePid is given, searches by PID first — this is critical for
 * multi-session environments where multiple Chrome instances share the same
 * Xvfb display and have identically-sized windows stacked at the same position.
 *
 * Falls back to selecting the largest window by area (filters out Chrome's
 * tiny 10x10 "Chromium clipboard" helper windows).
 */
async function findChromeWindow(chromePid?: number): Promise<string> {
  try {
    let ids: string[] = [];

    // Strategy 1: search by PID (precise — finds the exact Chrome instance)
    if (chromePid) {
      const { stdout } = await execAsync(
        `xdotool search --pid ${chromePid} --name "" 2>/dev/null`,
      ).catch(() => ({ stdout: '' }));
      ids = stdout.trim().split('\n').filter(Boolean);
    }

    // Strategy 2: search by name (fallback — matches any Chrome)
    if (ids.length === 0) {
      const { stdout } = await execAsync(
        `xdotool search --name "Chrom" 2>/dev/null`,
      );
      ids = stdout.trim().split('\n').filter(Boolean);
    }

    if (ids.length === 0) return '';
    if (ids.length === 1) return ids[0];

    // Find the largest window (actual browser, not clipboard helper)
    let bestId = '';
    let bestArea = 0;
    for (const id of ids) {
      try {
        const { stdout: geo } = await execAsync(
          `xdotool getwindowgeometry --shell ${id} 2>/dev/null`,
        );
        const w = parseInt(geo.match(/WIDTH=(\d+)/)?.[1] || '0');
        const h = parseInt(geo.match(/HEIGHT=(\d+)/)?.[1] || '0');
        const area = w * h;
        if (area > bestArea) {
          bestArea = area;
          bestId = id;
        }
      } catch {
        // Skip windows that can't be queried
      }
    }
    return bestId;
  } catch {
    return '';
  }
}

/**
 * Click via xdotool (OS-level X11 event). Bypasses CDP's kFromDebugger flag.
 *
 * xdotool sends real X11 MotionNotify + ButtonPress/Release events through
 * X11 → Chrome's PlatformEventSource → RenderWidgetHost → compositor.
 * These events have NO kFromDebugger modifier — identical to a physical mouse.
 *
 * Includes a full Bezier cursor approach path (not just a single move+click)
 * because CF validates mousemove history before accepting a click.
 *
 * Only works on Linux with Xvfb + DISPLAY set. Returns false on macOS/unsupported.
 */
export async function xdotoolClick(
  viewportX: number,
  viewportY: number,
  toolbarOffset?: number,
  chromePid?: number,
): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return false;

  try {
    const windowId = await findChromeWindow(chromePid);
    if (!windowId) return false;

    // Raise window to top of Z-order and set input focus.
    // On Xvfb without a WM, multiple Chrome windows overlap at the same position.
    // windowraise puts our window on top so XTEST events reach it.
    // windowfocus sets X11 keyboard/pointer focus to this window.
    await execAsync(`xdotool windowraise ${windowId}`).catch(() => {});
    await execAsync(`xdotool windowfocus --sync ${windowId}`).catch(() => {});

    // Convert viewport coordinates (from getBoundingClientRect) to X11 window coordinates.
    // Chrome's toolbar (tab strip + URL bar) occupies the top of the X11 window.
    // Use dynamic measurement when available, fallback to hardcoded constant.
    const offset = toolbarOffset ?? CHROME_TOOLBAR_OFFSET;
    const targetX = Math.round(viewportX);
    const targetY = Math.round(viewportY + offset);

    // Start from a random position 80-200px away (simulates cursor entering area)
    const angle = Math.random() * 2 * Math.PI;
    const dist = 80 + Math.random() * 120;
    const startX = Math.max(10, Math.min(1900, targetX + Math.cos(angle) * dist));
    const startY = Math.max(CHROME_TOOLBAR_OFFSET + 10, Math.min(1060, targetY + Math.sin(angle) * dist));

    // Generate a human-like Bezier path from start to target
    const path = generatePath(startX, startY, targetX, targetY);

    // Resample to ~12-18 points for xdotool (too many = slow, too few = robotic)
    const step = Math.max(1, Math.floor(path.length / (12 + Math.floor(Math.random() * 7))));
    const sampled: Point[] = [];
    for (let i = 0; i < path.length; i += step) sampled.push(path[i]);
    // Ensure final point is the target
    sampled[sampled.length - 1] = [targetX, targetY];

    // Execute cursor approach via xdotool (real X11 MotionNotify events)
    for (let i = 0; i < sampled.length; i++) {
      const px = Math.round(sampled[i][0]);
      const py = Math.round(sampled[i][1]);
      await execAsync(`xdotool mousemove --window ${windowId} ${px} ${py}`);
      // Human-like timing: 15-40ms between moves, slower near target
      const delay = i >= sampled.length - 3
        ? 30 + Math.random() * 50  // decelerate near target
        : 15 + Math.random() * 25;
      await new Promise(r => setTimeout(r, delay));
    }

    // Decision pause before click (humans pause 100-300ms before clicking)
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

    // Click WITHOUT --window flag. This is critical:
    // - `xdotool click --window WINID` checks XGetInputFocus to decide method.
    //   On bare Xvfb (no WM), XGetInputFocus returns window 1, not Chrome's WINID.
    //   When focus check fails, xdotool falls back to XSendEvent which sets
    //   send_event=true — Chrome SILENTLY IGNORES these events.
    // - `xdotool click` (no --window) always uses XTestFakeButtonEvent (XTEST extension).
    //   XTEST events are injected at the X server input queue level with send_event=false.
    //   Chrome processes them identically to real hardware mouse input.
    // The cursor is already at the target position from the preceding mousemove calls.
    await execAsync(`xdotool click 1`);

    // Post-click dwell: tiny micro-movements then drift away
    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
    const driftX = Math.round(targetX + (Math.random() * 30 - 15));
    const driftY = Math.round(targetY + (Math.random() * 20 - 10));
    await execAsync(`xdotool mousemove --window ${windowId} ${driftX} ${driftY}`);

    return true;
  } catch {
    return false;
  }
}
