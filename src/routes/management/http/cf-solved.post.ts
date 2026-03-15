import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  Request,
  contentTypes,
} from "@browserless.io/browserless";
import { ServerResponse } from "http";
import { Effect } from "effect";

/**
 * Receives navigator.sendBeacon from the browser when a Turnstile token
 * is received. Bypasses CDP entirely — fires well before pydoll disconnects.
 *
 * Body: { s: sessionId, t: targetId, l: tokenLength }
 *
 * Auth disabled: beacon is sent by Chrome inside the same Docker container.
 */
export default class CfSolvedPostRoute extends HTTPRoute {
  name = BrowserlessRoutes.CfSolvedPostRoute;
  accepts = [contentTypes.any, contentTypes.json, contentTypes.text];
  auth = false;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Receives CF solved beacon from browser (internal, no auth).";
  method = Methods.post;
  path = HTTPManagementRoutes.cfSolved;
  tags = [APITags.management];

  async handler(_req: Request, res: ServerResponse): Promise<void> {
    const route = this;
    return Effect.runPromise(
      Effect.fn("route.cf-solved.post")(function* () {
        try {
          // Log ALL incoming requests to diagnose if beacons arrive at all
          const rawBody = _req.body;
          yield* Effect.logInfo(
            `Beacon request: type=${typeof rawBody} content-type=${_req.headers["content-type"]} len=${typeof rawBody === "string" ? rawBody.length : (JSON.stringify(rawBody)?.length ?? 0)}`,
          );

          // sendBeacon sends text/plain — body may be a string or pre-parsed object
          let body: { s?: string; t?: string; l?: number } | undefined;
          if (typeof rawBody === "string") {
            try {
              body = JSON.parse(rawBody);
            } catch {
              body = undefined;
            }
          } else {
            body = rawBody as { s?: string; t?: string; l?: number } | undefined;
          }
          const sessionId = body?.s;
          const targetId = body?.t;
          const tokenLength = body?.l ?? 0;

          if (!targetId) {
            yield* Effect.logInfo(
              `Beacon 400: no targetId. s=${sessionId ?? "null"} t=${targetId ?? "null"} body=${JSON.stringify(body)?.slice(0, 200)}`,
            );
            res.writeHead(400);
            res.end();
            return;
          }

          const browserManager = route.browserManager();
          const sessionCoordinator = browserManager.getSessionCoordinator();
          const handled = sessionCoordinator.handleCfBeacon(sessionId ?? "", targetId, tokenLength);

          if (handled) {
            yield* Effect.logInfo(
              `Beacon: session=${sessionId ? sessionId.slice(0, 8) : "broadcast"} target=${targetId.slice(0, 8)} len=${tokenLength}`,
            );
          } else {
            yield* Effect.logInfo(
              `Beacon: no solver for session=${sessionId ? sessionId.slice(0, 8) : "empty"} (already cleaned up)`,
            );
          }

          res.writeHead(204);
          res.end();
        } catch (e) {
          yield* Effect.logDebug(`Beacon error: ${e instanceof Error ? e.message : String(e)}`);
          res.writeHead(204);
          res.end();
        }
      })(),
    );
  }
}
