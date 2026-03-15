/**
 * Coordinate utilities for CF solver click dispatch.
 *
 * Extracted from cloudflare-solve-strategies.ts for maintainability.
 * Handles iframe-to-page coordinate transformation and box model center calculation.
 */
import { Effect, Scope } from "effect";
import type { TargetId } from "../../shared/cloudflare-detection.js";
import { CdpSessionId } from "../../shared/cloudflare-detection.js";
import { CdpConnection } from "../../shared/cdp-rpc.js";
import { CdpSessionGone } from "./cf-errors.js";
import { CLEAN_WS_OPEN_TIMEOUT_MS, CLEAN_WS_CMD_TIMEOUT_MS } from "./cf-schedules.js";
import { openScopedWs } from "./cf-ws-resource.js";

/**
 * Get iframe page-space coordinates for translating iframe-relative
 * click coords → page-absolute coords (for replay visualization).
 */
export function getIframePageCoords(
  pageTargetId: TargetId,
  iframeBackendNodeId: number,
  chromePort: string,
): Effect.Effect<{ x: number | null; y: number | null }> {
  return Effect.fn("cf.getIframePageCoords")(function* () {
    yield* Effect.annotateCurrentSpan({ "cf.target_id": pageTargetId });
    // acquireRelease guarantees WS cleanup even on fiber interruption
    const conn = yield* openCleanPageWsScoped(pageTargetId, chromePort).pipe(
      Effect.catchTag("CdpSessionGone", () => Effect.succeed(null)),
    );
    if (!conn) return { x: null, y: null };

    const iframeBox = yield* conn
      .send("DOM.getBoxModel", {
        backendNodeId: iframeBackendNodeId,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (iframeBox?.model?.content) {
      const q = iframeBox.model.content;
      // content quad: [x0,y0, x1,y1, x2,y2, x3,y3] — top-left origin is q[0],q[1]
      return { x: q[0] as number, y: q[1] as number };
    }
    return { x: null, y: null };
  })().pipe(Effect.scoped);
}

/**
 * Open a fresh /devtools/page/{targetId} WS with zero V8 state.
 *
 * CdpSession's WS is tainted by rrweb's addScriptToEvaluateOnNewDocument
 * and Runtime.addBinding calls. A fresh page WS has zero state — matching
 * how pydoll connects via /devtools/page/{targetId}.
 *
 * Returns a scoped CdpConnection — callers use Effect.scoped to guarantee
 * WS cleanup even on fiber interruption.
 *
 * Delegates to openScopedWs factory — counter placement, acquireRelease
 * wrapping, and cleanup are all structural (no way to get them wrong).
 */
export function openCleanPageWsScoped(
  targetId: TargetId,
  chromePort: string,
): Effect.Effect<CdpConnection, CdpSessionGone, Scope.Scope> {
  const pageWsUrl = `ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`;
  return openScopedWs("clean_page", pageWsUrl, {
    startId: 500_000,
    defaultTimeout: CLEAN_WS_CMD_TIMEOUT_MS,
    openTimeoutMs: CLEAN_WS_OPEN_TIMEOUT_MS,
  }).pipe(
    Effect.mapError(
      () =>
        new CdpSessionGone({
          sessionId: CdpSessionId.makeUnsafe(""),
          method: "openCleanPageWs",
        }),
    ),
  );
}
