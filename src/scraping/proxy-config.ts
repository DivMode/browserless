/**
 * Mandatory proxy configuration for ahrefs scraping.
 *
 * Background: 2026-05-21 PR #2227 renamed the k8s env var
 * LOCAL_MOBILE_PROXY → OEILI_PROXY_URL but missed the two `process.env`
 * reads inside browserless. The result was a silent fallback to
 * `--proxy-server` UNSET, which leaked scrape traffic out of the Talos
 * worker's datacenter IP for ~13h before detection. This module guards
 * against that recurring.
 *
 * Why NOT throw at module load: the Docker build runs `npm run
 * build:openapi`, which imports route modules to extract their schemas.
 * That import path triggers any top-level work in the route module,
 * including a top-level `requireProxyUrl()` call. The build container
 * has no OEILI_PROXY_URL set (build env != runtime env), so a
 * module-load throw fails the entire image build. Instead we throw on
 * FIRST USE inside the scrape path — the route still hard-fails loudly
 * if the env var is missing at runtime, but the build can complete and
 * the pod can boot to surface a real error log instead of timing out.
 */

/**
 * Returns the validated proxy URL. Throws on first call if the env var
 * is missing or not a valid URL. Safe to call at module load AT TOP OF
 * a function body — NOT safe to call at module top level (breaks build).
 */
export function requireProxyUrl(): string {
  const raw = process.env.OEILI_PROXY_URL?.trim();
  if (!raw) {
    throw new Error(
      "OEILI_PROXY_URL is required — browserless will NOT scrape unproxied. " +
        "Check infra/kubernetes-browserless.ts (env var name) and the Pulumi " +
        "phoneProxy 1Password secret.",
    );
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(
      `OEILI_PROXY_URL is not a valid URL: ${JSON.stringify(raw)}. ` +
        "Browserless will NOT scrape with a malformed proxy.",
    );
  }
  return raw;
}

/**
 * Returns the proxy URL as a string, or empty string if unset. Use this
 * at module top level — does NOT throw, so build-time imports succeed.
 * Pair with a `requireProxyUrl()` call inside any function body that
 * actually needs the proxy.
 */
export function proxyUrlOrEmpty(): string {
  return process.env.OEILI_PROXY_URL?.trim() ?? "";
}
