/**
 * Turnstile script capture — extracts all resources loaded by the CF OOPIF.
 *
 * Uses two CDP strategies:
 *   1. Page.getResourceTree + Page.getResourceContent (preferred — returns all frames + resources)
 *   2. Runtime.evaluate fallback — fetches scripts in-page via Performance API + fetch()
 *
 * Captured artifacts are written to /tmp/turnstile-capture/{timestamp}/ for
 * offline analysis by the Rust deobfuscator (packages/turnstile-solver/).
 *
 * Gated by TURNSTILE_CAPTURE=1 env var. Does NOT interfere with the solve flow.
 */
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { CdpSessionId } from "../../shared/cloudflare-detection.js";

const CAPTURE_DIR = "/tmp/turnstile-capture";

/** Whether capture is enabled (env var gate). */
export function isCaptureEnabled(): boolean {
  return process.env.TURNSTILE_CAPTURE === "1";
}

/** Effect-returning CDP sender — same signature used throughout the CF solver. */
type EffectSend = (
  method: string,
  params?: object,
  sessionId?: CdpSessionId,
  timeoutMs?: number,
) => Effect.Effect<any>;

/** Capture manifest written alongside resources. */
interface CaptureManifest {
  timestamp: string;
  oopifSessionId: string;
  frameUrl: string | null;
  resources: Array<{
    url: string;
    mimeType: string;
    type: string;
    size: number;
    hash: string | null;
    filename: string;
  }>;
  errors: string[];
}

/**
 * Capture all resources from the CF Turnstile OOPIF and write to disk.
 *
 * Called after a successful solve — the OOPIF is still alive and all
 * challenge scripts + WASM have been loaded and executed.
 */
export function captureTurnstileResources(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
): Effect.Effect<string | null> {
  return Effect.fn("cf.capture.turnstileResources")(function* () {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const captureDir = path.join(CAPTURE_DIR, ts);
    const scriptsDir = path.join(captureDir, "scripts");
    const wasmDir = path.join(captureDir, "wasm");
    const errors: string[] = [];

    // Try Page.getResourceTree first (gives complete resource inventory)
    const resourceTree = yield* send("Page.getResourceTree", {}, oopifSessionId, 10_000).pipe(
      Effect.orElseSucceed(() => null),
    );

    if (!resourceTree?.frameTree) {
      // Fallback: use Runtime.evaluate to enumerate and fetch scripts
      yield* Effect.logWarning("cf.capture: Page.getResourceTree unavailable, using fallback");
      const fallbackDir = yield* captureFallback(send, oopifSessionId, captureDir);
      return fallbackDir;
    }

    // Create output directories
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(wasmDir, { recursive: true });

    const frame = resourceTree.frameTree.frame;
    const allResources: any[] = resourceTree.frameTree.resources || [];

    // Also collect resources from child frames
    const childFrames: any[] = resourceTree.frameTree.childFrames || [];
    for (const child of childFrames) {
      if (child.resources) allResources.push(...child.resources);
    }

    yield* Effect.logInfo("cf.capture: resource tree retrieved").pipe(
      Effect.annotateLogs({
        frame_url: frame?.url?.substring(0, 100),
        resource_count: allResources.length,
        child_frames: childFrames.length,
      }),
    );

    const manifest: CaptureManifest = {
      timestamp: ts,
      oopifSessionId: oopifSessionId as string,
      frameUrl: frame?.url ?? null,
      resources: [],
      errors,
    };

    // Retrieve content for each resource
    for (const res of allResources) {
      const url: string = res.url || "";
      const mimeType: string = res.mimeType || "";
      const type: string = res.type || "";

      // Skip data: URLs and empty URLs
      if (!url || url.startsWith("data:")) continue;

      const contentResult = yield* send(
        "Page.getResourceContent",
        { frameId: frame.id, url },
        oopifSessionId,
        10_000,
      ).pipe(Effect.orElseSucceed(() => null));

      if (!contentResult) {
        errors.push(`Failed to get content for ${url}`);
        continue;
      }

      const content: string = contentResult.content || "";
      const base64Encoded: boolean = contentResult.base64Encoded || false;
      const hash = content
        ? crypto.createHash("sha256").update(content).digest("hex").substring(0, 16)
        : null;

      // Determine filename and output directory
      const urlPath = safeFilename(url);
      const isWasm = mimeType === "application/wasm" || url.endsWith(".wasm") || type === "Wasm";
      const isScript =
        mimeType.includes("javascript") ||
        mimeType.includes("ecmascript") ||
        type === "Script" ||
        url.endsWith(".js");

      let filename: string;
      let outDir: string;

      if (isWasm) {
        filename = `${urlPath}-${hash || "unknown"}.wasm`;
        outDir = wasmDir;
      } else if (isScript) {
        filename = `${urlPath}-${hash || "unknown"}.js`;
        outDir = scriptsDir;
      } else {
        // Other resources (HTML, CSS, images) — save in scripts dir
        const ext = mimeType.includes("html")
          ? ".html"
          : mimeType.includes("css")
            ? ".css"
            : ".bin";
        filename = `${urlPath}-${hash || "unknown"}${ext}`;
        outDir = scriptsDir;
      }

      // Write content
      if (base64Encoded) {
        fs.writeFileSync(path.join(outDir, filename), Buffer.from(content, "base64"));
      } else {
        fs.writeFileSync(path.join(outDir, filename), content, "utf-8");
      }

      manifest.resources.push({
        url,
        mimeType,
        type,
        size: content.length,
        hash,
        filename: path.relative(captureDir, path.join(outDir, filename)),
      });
    }

    // Also capture the frame's HTML content
    const frameHtml = yield* send(
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      },
      oopifSessionId,
      5_000,
    ).pipe(Effect.orElseSucceed(() => null));

    if (frameHtml?.result?.value) {
      const htmlFile = "frame.html";
      fs.writeFileSync(path.join(captureDir, htmlFile), frameHtml.result.value, "utf-8");
      manifest.resources.push({
        url: frame?.url || "about:blank",
        mimeType: "text/html",
        type: "Document",
        size: frameHtml.result.value.length,
        hash: crypto
          .createHash("sha256")
          .update(frameHtml.result.value)
          .digest("hex")
          .substring(0, 16),
        filename: htmlFile,
      });
    }

    // Write manifest
    fs.writeFileSync(
      path.join(captureDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    yield* Effect.logInfo("cf.capture: turnstile resources captured").pipe(
      Effect.annotateLogs({
        capture_dir: captureDir,
        total_resources: manifest.resources.length,
        errors: errors.length,
        scripts: manifest.resources.filter((r) => r.filename.startsWith("scripts/")).length,
        wasm: manifest.resources.filter((r) => r.filename.startsWith("wasm/")).length,
      }),
    );

    return captureDir;
  })();
}

/**
 * Fallback capture: use Runtime.evaluate in the OOPIF to enumerate and re-fetch scripts.
 *
 * This works when Page.getResourceTree is unavailable (some Chrome versions
 * don't support it on OOPIF sessions).
 */
function captureFallback(
  send: EffectSend,
  oopifSessionId: CdpSessionId,
  captureDir: string,
): Effect.Effect<string | null> {
  return Effect.fn("cf.capture.fallback")(function* () {
    const scriptsDir = path.join(captureDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Step 1: Enumerate loaded resources via Performance API
    const perfResult = yield* send(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify({
          resources: performance.getEntriesByType('resource').map(e => ({
            name: e.name,
            type: e.initiatorType,
            size: e.transferSize,
            duration: Math.round(e.duration)
          })),
          scripts: Array.from(document.querySelectorAll('script')).map(s => ({
            src: s.src || null,
            inline: !s.src ? s.textContent : null,
            type: s.type || 'text/javascript'
          })),
          location: location.href
        })`,
        returnByValue: true,
      },
      oopifSessionId,
      10_000,
    ).pipe(Effect.orElseSucceed(() => null));

    if (!perfResult?.result?.value) {
      yield* Effect.logWarning("cf.capture.fallback: Runtime.evaluate failed");
      return null;
    }

    const data = JSON.parse(perfResult.result.value) as {
      resources: Array<{ name: string; type: string; size: number; duration: number }>;
      scripts: Array<{ src: string | null; inline: string | null; type: string }>;
      location: string;
    };

    const errors: string[] = [];
    const manifest: CaptureManifest = {
      timestamp: path.basename(captureDir),
      oopifSessionId: oopifSessionId as string,
      frameUrl: data.location,
      resources: [],
      errors,
    };

    // Step 2: Save inline scripts
    let inlineIdx = 0;
    for (const script of data.scripts) {
      if (script.inline && script.inline.length > 10) {
        const hash = crypto
          .createHash("sha256")
          .update(script.inline)
          .digest("hex")
          .substring(0, 16);
        const filename = `inline-${inlineIdx++}-${hash}.js`;
        fs.writeFileSync(path.join(scriptsDir, filename), script.inline, "utf-8");
        manifest.resources.push({
          url: `inline:${inlineIdx - 1}`,
          mimeType: script.type || "text/javascript",
          type: "Script",
          size: script.inline.length,
          hash,
          filename: `scripts/${filename}`,
        });
      }
    }

    // Step 3: Re-fetch external scripts from within the OOPIF context (same-origin)
    const scriptUrls = data.resources
      .filter((r) => r.type === "script" || r.name.endsWith(".js"))
      .map((r) => r.name);

    // Also add script[src] URLs not in Performance API
    for (const script of data.scripts) {
      if (script.src && !scriptUrls.includes(script.src)) {
        scriptUrls.push(script.src);
      }
    }

    for (const url of scriptUrls) {
      const fetchResult = yield* send(
        "Runtime.evaluate",
        {
          expression: `fetch(${JSON.stringify(url)}).then(r => r.text()).then(t => JSON.stringify({ok: true, content: t, size: t.length})).catch(e => JSON.stringify({ok: false, error: e.message}))`,
          returnByValue: true,
          awaitPromise: true,
        },
        oopifSessionId,
        15_000,
      ).pipe(Effect.orElseSucceed(() => null));

      if (!fetchResult?.result?.value) {
        errors.push(`Failed to fetch ${url}`);
        continue;
      }

      const fetched = JSON.parse(fetchResult.result.value) as
        | { ok: true; content: string; size: number }
        | { ok: false; error: string };

      if (!fetched.ok) {
        errors.push(`Fetch error for ${url}: ${(fetched as any).error}`);
        continue;
      }

      const content = (fetched as { ok: true; content: string }).content;
      const hash = crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
      const filename = `${safeFilename(url)}-${hash}.js`;
      fs.writeFileSync(path.join(scriptsDir, filename), content, "utf-8");
      manifest.resources.push({
        url,
        mimeType: "application/javascript",
        type: "Script",
        size: content.length,
        hash,
        filename: `scripts/${filename}`,
      });
    }

    // Step 4: Capture frame HTML
    const frameHtml = yield* send(
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      },
      oopifSessionId,
      5_000,
    ).pipe(Effect.orElseSucceed(() => null));

    if (frameHtml?.result?.value) {
      fs.writeFileSync(path.join(captureDir, "frame.html"), frameHtml.result.value, "utf-8");
    }

    // Step 5: Capture resource timing for protocol analysis
    const timingFile = "resource-timing.json";
    fs.writeFileSync(
      path.join(captureDir, timingFile),
      JSON.stringify(data.resources, null, 2),
      "utf-8",
    );

    // Write manifest
    fs.writeFileSync(
      path.join(captureDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    yield* Effect.logInfo("cf.capture.fallback: scripts captured").pipe(
      Effect.annotateLogs({
        capture_dir: captureDir,
        total_resources: manifest.resources.length,
        inline_scripts: inlineIdx,
        external_scripts: scriptUrls.length,
        errors: errors.length,
      }),
    );

    return captureDir;
  })();
}

/** Convert a URL to a safe filename (strip protocol, replace special chars). */
function safeFilename(url: string): string {
  try {
    const u = new URL(url);
    const name = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 80);
  } catch {
    return url.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 80);
  }
}
