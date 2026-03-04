/**
 * vitest globalSetup: auto-build and start browserless for integration tests.
 *
 * If browserless is already running (e.g., `just dev` in another terminal),
 * skips both build and spawn — assumes the developer is managing it.
 *
 * Otherwise: runs `npx tsc` to compile latest source, then spawns the server
 * using the same startup as `just dev` (minus --watch).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3000;
const HEALTH_URL = `http://localhost:${PORT}/json/version`;
const BROWSERLESS_HTTP = `http://localhost:${PORT}`;
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

  // Skip build+spawn if already running (e.g., `just dev` + `just watch` in other terminals)
  if (await isRunning()) {
    console.log('[globalSetup] Browserless already running at :3000 — skipping build');
    return;
  }

  // Build: compile TS → JS so build/ reflects latest source edits
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

  console.log('[globalSetup] Starting browserless...');

  // Same as `just dev` but without --watch (no file watching needed for tests)
  // Uses env-cmd to load .env.dev, MUST use node (not bun — bun breaks WS proxying)
  serverProcess = spawn(
    'npx',
    ['env-cmd', '-f', '.env.dev', 'node', 'build/index.js'],
    {
      cwd: BROWSERLESS_DIR,
      env: { ...process.env, PORT: String(PORT) },
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

  if (!serverProcess) return; // didn't spawn (was already running)

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

    // Color the summary label
    let label: string;
    if (rawLabel.includes('✓') || rawLabel.includes('→')) {
      label = green(rawLabel.padEnd(7));
    } else if (rawLabel === 'SKIP') {
      label = dim(rawLabel.padEnd(7));
    } else {
      label = red(rawLabel.padEnd(7));
    }

    // Replay column — clickable OSC 8 link
    let replayCell: string;
    if (r.replayId) {
      const replayUrl = `${BROWSERLESS_HTTP}/replay/${r.replayId}`;
      replayCell = link(replayUrl, 'replay');
    } else {
      replayCell = dim('  --  ');
    }

    out.write(
      `║ ${r.name.padEnd(14)} │ ${label} │ ${type.padEnd(12)} │ ${method.padEnd(15)} │ ${signal.padEnd(14)} │ ${dur.padEnd(8)} │ ${replayCell} ║\n`,
    );
  }

  out.write('╚════════════════╧═════════╧══════════════╧═════════════════╧════════════════╧══════════╧════════╝\n');

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
