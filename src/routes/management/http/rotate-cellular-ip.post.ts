/**
 * POST /internal/rotate-cellular-ip — Trigger phone cellular IP rotation
 * via the oeili relay admin endpoint.
 *
 * Used by the Ahrefs scrape workflow when the destination returns
 * InvalidCaptcha — we've been IP-blocked by Ahrefs and need a verified
 * different IP before retrying.
 *
 * Background — 2026-05-19: this endpoint used to POST to
 * `http://192.168.4.200:8080/rotate` (Quectel modem proxy on VM200).
 * That endpoint rotated the modem's PDP context — a DIFFERENT physical
 * device than the phone the proxy actually egresses through. Phone
 * egress IPs sit in T-Mobile's `172.59.x.x` prefix; modem IPs are in
 * `172.56.x.x`. Different SIMs. After Ahrefs blocked the phone IP,
 * scrapers rotated the (unused) modem and retried with the same
 * blocked phone IP → guaranteed re-fail. Fixed by re-pointing this
 * caller at the relay admin endpoint that dispatches `RotateRequest`
 * over the same QUIC control stream the proxy traffic flows through.
 * See PRs #2160 + #2162 for the relay-side endpoint and the
 * axum-0.7 path-syntax fix.
 *
 * ## API contract
 *
 * `POST {OEILI_API_URL}/rotate/{phone_id}` with no body.
 *
 *   - 200 OK: rotation completed and the egress IP is verified
 *     different from before. Response body:
 *     `{"ok": true, "phone_id": "...", "new_ip": "172.59.x.x"}`.
 *   - 404: phone not registered (e.g., disconnected). Caller can
 *     either retry shortly or fall through.
 *   - 503: relay admin built without registry (test/dev config).
 *   - timeout: rotation loop gave up after MAX_ROTATE_ATTEMPTS=60.
 *
 * Auth: the relay admin port (8290) is opened by the Hetzner firewall
 * to scraper-class callers. No app-layer auth.
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

const OEILI_API_URL = process.env.OEILI_API_URL ?? "http://relay.oeili.com:8290";
const OEILI_PHONE_ID = process.env.OEILI_PHONE_ID ?? "pixel-10-1189";
const ROTATE_TIMEOUT_MS = 75_000;

export default class RotateCellularIpPostRoute extends HTTPRoute {
  name = BrowserlessRoutes.RotateCellularIpPostRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Trigger cellular IP rotation on the oeili phone proxy.";
  method = Methods.post;
  path = HTTPManagementRoutes.rotateCellularIp;
  tags = [APITags.management];

  async handler(_req: Request, res: ServerResponse): Promise<void> {
    const url = `${OEILI_API_URL.replace(/\/$/, "")}/rotate/${OEILI_PHONE_ID}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROTATE_TIMEOUT_MS);

    try {
      const upstream = await fetch(url, { method: "POST", signal: controller.signal });
      const body = await upstream.text();

      if (upstream.status === 200) {
        jsonResponse(res, 200, { ok: true, oeili_status: 200, oeili_body: body.slice(0, 200) });
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
