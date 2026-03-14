/**
 * vitest globalSetup: auto-build and start browserless for integration tests.
 *
 * Local mode (default): kills ALL stale node build/index processes, builds via
 * tsc, spawns a fresh server with env vars loaded via Vite loadEnv, and verifies
 * OUR spawned PID owns port 3000 before tests run.
 *
 * Remote mode (TEST_ENV=prod): skips build/spawn, health-checks the remote
 * endpoint from BROWSERLESS_ENDPOINT env var.
 *
 * IMPORTANT: env-cmd is NOT used — it silently fails on .env.dev files (treats
 * .dev extension as a JSON RC file). All env vars come from Vite loadEnv.
 *
 * IMPORTANT: `node --watch` dev servers race with our spawned server. After tsc
 * rebuilds `build/index.js`, any running `--watch` process auto-restarts and
 * grabs port 3000 before our spawn. killByName() kills ALL matching processes
 * regardless of port binding state. See: 2026-03-04 zombie process incident.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';

// Load .env.{TEST_ENV} into process.env — globalSetup doesn't receive vitest's test.env
// MUST use import.meta.dirname (not process.cwd()) — cwd may differ from project root
const testEnvMode = process.env.TEST_ENV || 'dev';
const envVars = loadEnv(testEnvMode, import.meta.dirname, '');
Object.assign(process.env, envVars);

console.log(`[globalSetup] Loaded ${Object.keys(envVars).length} env vars from .env.${testEnvMode}`);

async function killPort(port: number): Promise<void> {
  try {
    const stdout = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    const pids = stdout.trim().split('\n').filter(Boolean);
    if (pids.length === 0) return;
    console.log(`[globalSetup] Killing stale process(es) on port ${port}: ${pids.join(', ')}`);
    for (const pid of pids) {
      process.kill(Number(pid), 'SIGTERM');
    }
    // Wait for graceful shutdown, then SIGKILL survivors
    await new Promise((r) => setTimeout(r, 1000));
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch {
    // No process on port — nothing to kill
  }
}

/**
 * Kill ALL node processes matching `build/index.js` — regardless of port state.
 *
 * killPort() only finds processes already LISTENING on :3000. A `node --watch`
 * process that just restarted (after tsc rebuilt build/index.js) may not have
 * bound the port yet — it races with our spawn. This function catches those
 * in-flight zombies by matching the process command line.
 *
 * Skips our own PID to avoid self-termination.
 */
async function killByName(): Promise<void> {
  try {
    const stdout = execFileSync(
      'pgrep', ['-f', 'node.*build/index\\.js'],
      { encoding: 'utf-8' },
    );
    const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
    const ownPid = process.pid;
    const toKill = pids.filter((pid) => pid !== ownPid);
    if (toKill.length === 0) return;
    console.log(`[globalSetup] Killing stale node build/index processes: ${toKill.join(', ')}`);
    for (const pid of toKill) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // Wait for graceful shutdown, then SIGKILL survivors
    await new Promise((r) => setTimeout(r, 1000));
    for (const pid of toKill) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch {
    // pgrep returns exit code 1 when no processes match — expected
  }
}

const PORT = 3000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/json/version`;
const BROWSERLESS_HTTP = `http://127.0.0.1:${PORT}`;
const REPLAY_HTTP = process.env.REPLAY_INGEST_URL;
if (!REPLAY_HTTP) {
  throw new Error('REPLAY_INGEST_URL env var required — set in .env.dev or .env.prod');
}
// Worktree-aware: if real npm dependencies don't exist here (git worktree),
// resolve to the main repo root. Check for a real package (effect) instead of
// just node_modules/ — vitest creates node_modules/.vite cache in the CWD,
// which would fool a bare existsSync('node_modules') check.
function resolveBrowserlessDir(): string {
  const dir = path.resolve(import.meta.dirname);
  if (existsSync(path.join(dir, 'node_modules', 'effect'))) return dir;
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: dir, encoding: 'utf8' });
    const match = output.match(/^worktree (.+)$/m);
    if (match && existsSync(path.join(match[1], 'node_modules', 'effect'))) {
      console.log(`[globalSetup] Worktree detected — using main repo: ${match[1]}`);
      return match[1];
    }
  } catch { /* not a git repo */ }
  return dir;
}
const BROWSERLESS_DIR = resolveBrowserlessDir();
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const RESULTS_FILE = path.join(tmpdir(), 'cf-integration-results.jsonl');

async function isRunning(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning()) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ── Diagnostic dump on startup failure ─────────────────────────────
  // Collect everything needed to diagnose WHY the server didn't start.
  // Without this, vitest shows "No test files found" — zero signal.
  const diagnostics: string[] = [`Browserless did not start within ${timeoutMs}ms`];

  // Server process state
  if (serverProcess) {
    diagnostics.push(`  PID: ${serverProcess.pid ?? 'unknown'}`);
    diagnostics.push(`  exitCode: ${serverProcess.exitCode}`);
    diagnostics.push(`  killed: ${serverProcess.killed}`);
    diagnostics.push(`  signalCode: ${serverProcess.signalCode}`);
  }

  // Port ownership
  try {
    const lsofOut = execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf-8' });
    diagnostics.push(`  Port ${PORT} owners: ${lsofOut.trim().replace(/\n/g, ', ')}`);
  } catch {
    diagnostics.push(`  Port ${PORT}: no process listening`);
  }

  // Server log tail — last 20 lines
  const logPath = path.join(BROWSERLESS_DIR, 'test-server.log');
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf-8');
    const lines = log.trim().split('\n');
    const tail = lines.slice(-20).join('\n');
    diagnostics.push(`  Server log (last ${Math.min(20, lines.length)} lines):\n${tail}`);
  } else {
    diagnostics.push('  Server log: file not found');
  }

  const message = diagnostics.join('\n');
  // Print to stderr so it's visible even if vitest swallows the error
  console.error(`\n[globalSetup] STARTUP FAILURE DIAGNOSTICS:\n${message}\n`);
  throw new Error(message);
}

let serverProcess: ChildProcess | null = null;

export async function setup() {
  // Clear results file from previous run
  writeFileSync(RESULTS_FILE, '');

  // Check proxy — fail fast before any build/spawn work
  if (!process.env.LOCAL_MOBILE_PROXY) {
    throw new Error(
      'LOCAL_MOBILE_PROXY env var required. Run with:\n' +
        '  LOCAL_MOBILE_PROXY=$(op read "op://Catchseo.com/Proxies/local_mobile_proxy") npx vitest run --config vitest.integration.config.ts',
    );
  }

  // Remote mode — skip build + spawn, just verify reachability
  const isRemote = !!process.env.BROWSERLESS_ENDPOINT;
  if (isRemote) {
    const endpoint = process.env.BROWSERLESS_ENDPOINT!;
    console.log(`[globalSetup] Using remote browserless: ${endpoint}`);
    const healthUrl = `${endpoint}/json/version`;
    const res = await fetch(healthUrl).catch(() => null);
    if (!res?.ok) throw new Error(`Remote browserless not reachable at ${healthUrl}`);
    console.log('[globalSetup] Remote browserless is healthy');
    return;
  }

  // ── Kill ALL stale browserless processes ────────────────────────────
  // Two strategies: by port (catches anything listening on :3000) AND by
  // process name (catches `node --watch` zombies that haven't bound yet).
  // Both run before AND after tsc — tsc rebuilds trigger --watch restarts.
  await killPort(PORT);
  await killByName();

  // Always build — ensures build/ reflects latest source edits
  console.log('[globalSetup] Building browserless (tsc)...');
  const buildStart = Date.now();
  execFileSync('npx', ['tsc'], { cwd: BROWSERLESS_DIR, stdio: 'inherit' });
  console.log(`[globalSetup] Build done (${Date.now() - buildStart}ms)`);

  // Build rrweb Chrome extension if missing (needed for replay player debugging)
  const extensionPath = path.join(BROWSERLESS_DIR, 'extensions/replay/rrweb-recorder.js');
  if (!existsSync(extensionPath)) {
    console.log('[globalSetup] Building rrweb extension...');
    execFileSync('bun', ['extensions/replay/build.js'], { cwd: BROWSERLESS_DIR, stdio: 'inherit' });
  }

  // Kill AGAIN after build — tsc file changes trigger `node --watch` restarts
  await killPort(PORT);
  await killByName();

  console.log('[globalSetup] Starting browserless...');

  // MUST use node (not bun — bun breaks WS proxying).
  // Env vars come from Vite loadEnv (line 19), NOT env-cmd.
  serverProcess = spawn(
    'node',
    ['build/index.js'],
    {
      cwd: BROWSERLESS_DIR,
      env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', TEST_TRACE_COLLECT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const spawnedPid = serverProcess.pid;
  console.log(`[globalSetup] Spawned server PID: ${spawnedPid}`);

  // Redirect server output to log file — keeps test output clean
  const logPath = path.join(BROWSERLESS_DIR, 'test-server.log');
  const logStream = createWriteStream(logPath);
  serverProcess.stdout?.pipe(logStream);
  serverProcess.stderr?.pipe(logStream);
  console.log(`[globalSetup] Server logs: ${logPath}`);
  serverProcess.on('error', (err) => {
    throw new Error(`Failed to spawn browserless: ${err.message}`);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code && code !== 0) {
      // Dump server log on crash — visible to any agent reading stdout
      const logPath = path.join(BROWSERLESS_DIR, 'test-server.log');
      let logTail = '';
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
        logTail = lines.slice(-10).join('\n');
      }
      console.error(
        `[globalSetup] Browserless crashed!\n` +
        `  exit code: ${code}, signal: ${signal}\n` +
        `  Server log (last 10 lines):\n${logTail}`,
      );
    }
  });

  await waitForReady(MAX_WAIT_MS);

  // ── PID ownership verification ─────────────────────────────────────
  // After the port is ready, verify OUR spawned PID owns it — not a zombie.
  // This catches the exact scenario from 2026-03-04: a stale `node --watch`
  // process grabs port 3000, our server fails to bind (but doesn't crash),
  // and all connections go to the wrong process.
  if (spawnedPid) {
    try {
      const lsofOut = execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf-8' });
      const portPids = lsofOut.trim().split('\n').filter(Boolean).map(Number);
      if (!portPids.includes(spawnedPid)) {
        // Our PID is NOT on the port — a zombie stole it
        const portOwners = portPids.join(', ');
        throw new Error(
          `Port ${PORT} owned by PID(s) ${portOwners}, but we spawned PID ${spawnedPid}. ` +
          `A stale process is intercepting connections. ` +
          `Kill all: pkill -f "node.*build/index"`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('owned by PID')) throw err;
      // lsof failed — non-fatal, server is responding to health check
    }
  }

  console.log('[globalSetup] Browserless ready');
}

export async function teardown() {
  // ── Print summary table ──────────────────────────────────────────
  // Runs in the main vitest process → process.stdout.write goes
  // directly to the terminal, no worker interception, no escape stripping.
  printSummaryTable();

  if (!serverProcess) return; // didn't spawn (remote mode)

  serverProcess.kill('SIGTERM');

  // Wait up to 5s for graceful shutdown, then SIGKILL
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      serverProcess?.kill('SIGKILL');
      resolve();
    }, 5000);
    serverProcess!.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Belt-and-suspenders: kill anything still on the port (child processes, etc.)
  await killPort(PORT);
}

// ── Summary table (printed from main process) ──────────────────────

interface SiteResult {
  name: string;
  summary: { label: string; type: string; method: string; signal?: string; durationMs?: number } | null;
  replayId: string | null;
  durationMs: number;
  status: 'PASS' | 'FAIL' | 'SKIP';
  error?: string;
}

function printSummaryTable() {
  if (!existsSync(RESULTS_FILE)) return;

  const raw = readFileSync(RESULTS_FILE, 'utf-8').trim();
  if (!raw) return;

  const results: SiteResult[] = raw.split('\n').map((line) => JSON.parse(line));
  if (results.length === 0) return;

  const out = process.stdout;

  // OSC 8 terminal hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
  const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

  // Colors
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  out.write('\n');
  out.write('╔════════════════╤═════════╤══════════════╤═════════════════╤════════════════╤══════════╤════════╗\n');
  out.write('║ Site           │ Summary │ Type         │ Method          │ Signal         │ Duration │ Replay ║\n');
  out.write('╠════════════════╪═════════╪══════════════╪═════════════════╪════════════════╪══════════╪════════╣\n');

  for (const r of results) {
    const s = r.summary;
    const rawLabel = s?.label ?? (r.status === 'SKIP' ? 'SKIP' : 'FAIL');
    const type = s?.type ?? '';
    const method = s?.method ?? '';
    const signal = s?.signal ?? '';
    const dur = s?.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '';

    // Color the summary label — red for failures even if solver produced a label
    let label: string;
    if (r.status === 'FAIL') {
      label = red(rawLabel.padEnd(7));
    } else if (rawLabel.includes('✓') || rawLabel.includes('→')) {
      label = green(rawLabel.padEnd(7));
    } else if (rawLabel === 'SKIP') {
      label = dim(rawLabel.padEnd(7));
    } else {
      label = red(rawLabel.padEnd(7));
    }

    // Replay column — clickable OSC 8 link
    let replayCell: string;
    if (r.replayId) {
      const replayUrl = `${REPLAY_HTTP}/replay/${r.replayId}`;
      replayCell = link(replayUrl, 'replay');
    } else {
      replayCell = dim('  --  ');
    }

    out.write(
      `║ ${r.name.padEnd(14)} │ ${label} │ ${type.padEnd(12)} │ ${method.padEnd(15)} │ ${signal.padEnd(14)} │ ${dur.padEnd(8)} │ ${replayCell} ║\n`,
    );
  }

  out.write('╚════════════════╧═════════╧══════════════╧═════════════════╧════════════════╧══════════╧════════╝\n');

  // Print failure reasons
  const failures = results.filter((r) => r.status === 'FAIL' && r.error);
  if (failures.length > 0) {
    out.write('\n');
    for (const f of failures) {
      out.write(`  ${red('✗')} ${f.name}: ${f.error}\n`);
    }
  }

  // Pass/fail counts
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  const parts: string[] = [];
  if (passed > 0) parts.push(green(`${passed} passed`));
  if (failed > 0) parts.push(red(`${failed} failed`));
  if (skipped > 0) parts.push(dim(`${skipped} skipped`));
  out.write(`\n${parts.join(', ')} out of ${results.length} sites\n\n`);
}
