/**
 * POST /internal/rotate-cellular-ip — Trigger cellular IP rotation on oeili.
 *
 * Proxies through to oeili's `/rotate` endpoint, which sends AT commands to
 * the modem (CFUN cycle) to release the current carrier-assigned IP and
 * negotiate a fresh one. Used by the Ahrefs scrape workflow when the
 * destination returns InvalidCaptcha — we've been IP-blocked by Ahrefs and
 * need a new IP before retrying.
 *
 * Why proxy here vs calling oeili from CF Workers directly:
 *   - oeili's API binds to LAN-only (`192.168.4.200:8080`), unreachable
 *     from CF Workers' edge runtime
 *   - browserless runs on the Talos worker (`192.168.4.170`) which is on
 *     the same LAN as oeili — direct call is one hop, no tunnel needed
 *
 * The pattern mirrors `packages/godaddy-fetcher/src/proxy_rotate.rs` —
 * same oeili `/rotate` contract:
 *   - 200 → success
 *   - 409 → already rotating, treat as success (the in-flight rotation
 *     also gives us a fresh IP)
 *   - 5xx / network → fail; caller falls through (retry with same IP, or
 *     surface the error)
 *
 * Auth: relies on CF Access on the Cloudflare Tunnel + the LAN-only bind.
 * Same security posture as the dispatch routes.
 */
import type { Request } from "@browserless.io/browserless";
import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  contentTypes,
  jsonResponse,
} from "@browserless.io/browserless";
import type { ServerResponse } from "http";

const OEILI_API_URL = process.env.OEILI_API_URL ?? "http://192.168.4.200:8080";
const ROTATE_TIMEOUT_MS = 75_000;

export default class RotateCellularIpPostRoute extends HTTPRoute {
  name = BrowserlessRoutes.RotateCellularIpPostRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Trigger cellular IP rotation on the oeili modem.";
  method = Methods.post;
  path = HTTPManagementRoutes.rotateCellularIp;
  tags = [APITags.management];

  async handler(_req: Request, res: ServerResponse): Promise<void> {
    const url = `${OEILI_API_URL.replace(/\/$/, "")}/rotate`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROTATE_TIMEOUT_MS);

    try {
      const upstream = await fetch(url, { method: "POST", signal: controller.signal });
      const body = await upstream.text();

      if (upstream.status === 200) {
        jsonResponse(res, 200, { ok: true, oeili_status: 200, oeili_body: body.slice(0, 200) });
        return;
      }
      if (upstream.status === 409) {
        // Another rotation is already in flight — its fresh IP serves us too.
        jsonResponse(res, 200, {
          ok: true,
          oeili_status: 409,
          oeili_body: body.slice(0, 200),
          note: "rotation already in progress",
        });
        return;
      }
      jsonResponse(res, 503, {
        ok: false,
        oeili_status: upstream.status,
        oeili_body: body.slice(0, 200),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 503, { ok: false, error: msg });
    } finally {
      clearTimeout(timer);
    }
  }
}
