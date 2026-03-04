/**
 * vitest globalSetup: auto-build and start browserless for integration tests.
 *
 * Local mode (default): builds via tsc, kills any stale process on :3000,
 * then spawns a fresh server using env-cmd + node.
 *
 * Remote mode (TEST_ENV=prod): skips build/spawn, health-checks the remote
 * endpoint from BROWSERLESS_ENDPOINT env var.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';

// Load .env.{TEST_ENV} into process.env — globalSetup doesn't receive vitest's test.env
const testEnvMode = process.env.TEST_ENV || 'dev';
const envVars = loadEnv(testEnvMode, process.cwd(), '');
Object.assign(process.env, envVars);

async function killPort(port: number): Promise<void> {
  try {
    const stdout = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    const pids = stdout.trim().split('\n').filter(Boolean);
    if (pids.length === 0) return;
    console.log(`[globalSetup] Killing stale process(es) on port ${port}: ${pids.join(', ')}`);
    for (const pid of pids) {
      process.kill(Number(pid), 'SIGTERM');
    }
    // Wait briefly for process to exit
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // No process on port — nothing to kill
  }
}

const PORT = 3000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/json/version`;
const BROWSERLESS_HTTP = `http://127.0.0.1:${PORT}`;
const REPLAY_HTTP = process.env.REPLAY_INGEST_URL;
if (!REPLAY_HTTP) {
  throw new Error('REPLAY_INGEST_URL env var required — set in .env.dev or .env.prod');
}
const BROWSERLESS_DIR = path.resolve(import.meta.dirname);
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
  throw new Error(`Browserless did not start within ${timeoutMs}ms`);
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

  // Always build — ensures build/ reflects latest source edits even if server is already running
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

  // Kill any stale process on port 3000 so we always spawn a fresh server with correct env
  await killPort(PORT);

  console.log('[globalSetup] Starting browserless...');

  // Same as `just dev` but without --watch (no file watching needed for tests)
  // Uses env-cmd to load .env.dev, MUST use node (not bun — bun breaks WS proxying)
  serverProcess = spawn(
    'npx',
    ['env-cmd', '-f', '.env.dev', 'node', 'build/index.js'],
    {
      cwd: BROWSERLESS_DIR,
      env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Redirect server output to log file — keeps test output clean.
  // Server logs are only useful when debugging startup failures.
  const logPath = path.join(BROWSERLESS_DIR, 'test-server.log');
  const logStream = createWriteStream(logPath);
  serverProcess.stdout?.pipe(logStream);
  serverProcess.stderr?.pipe(logStream);
  console.log(`[globalSetup] Server logs: ${logPath}`);

  serverProcess.on('error', (err) => {
    throw new Error(`Failed to spawn browserless: ${err.message}`);
  });

  serverProcess.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[globalSetup] Browserless exited with code ${code}`);
    }
  });

  await waitForReady(MAX_WAIT_MS);
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
