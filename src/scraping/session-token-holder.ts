/**
 * Stable-until-block session-token holder for the oeili proxy
 * (ADR-0065 §3, ADR-0037 §1).
 *
 * The proxy username carries a `-session-<token>` rotation handle. Reusing the
 * same token keeps egress pinned to the same cellular IP (sticky, 10-min TTI,
 * ADR-0004); changing it is the customer's statement "the last IP failed —
 * give me a fresh one," which the relay services by pool-walk → modem-rotate.
 * The relay never sees the block; the token change *is* the signal.
 *
 * This holder owns the customer side of that contract. It returns ONE stable
 * token across scrapes (`current()`) and rotates it to a fresh value ONLY when
 * a block is observed (`observe()` → `isBlockTrigger`). Holding the token
 * stable on healthy scrapes is what stops browserless from spending the
 * relay's finite rotation budget (N phones × 1 rotation / 60s) on IPs that are
 * already working — the exact failure ADR-0065 was written to fix, where every
 * browser minted its own fresh token and forced a rotation per scrape.
 *
 * It also tracks a serve counter (`recordServe()` / `servesOnCurrentToken()`):
 * how many scrape attempts have egressed on the current sticky token. A block
 * rotation resets it to 0 (the fresh IP starts clean), so the value captured
 * just before a rotation is "serves before block" — the single most valuable
 * rotation-tuning number, surfaced as a histogram on the scrape path.
 *
 * The token is hyphen-free by construction (`freshSessionId` → 32-hex); see
 * `session-id.ts` for why the relay parser requires that.
 *
 * Deliberately a plain synchronous deep module (not an Effect service): the
 * state is a single string mutated in-process, read from both Effect
 * generators and the `page.authenticate()` async closure. A `Ref` would force
 * every read through an Effect context for no benefit. Mirrors the Rust
 * scraper's `SessionTokenHolder` so both customers behave identically.
 */
import type { ScrapeError } from "./ahrefs-errors.js";
import { isBlockTrigger } from "./block-detection.js";
import { freshSessionId } from "./session-id.js";

export class SessionTokenHolder {
  #token: string;
  #servesOnToken = 0;
  readonly #generate: () => string;

  /**
   * @param generate token generator — defaults to `freshSessionId` (32-hex,
   *   hyphen-free). Injectable so unit tests assert deterministic rotation
   *   without depending on randomness.
   */
  constructor(generate: () => string = freshSessionId) {
    this.#generate = generate;
    this.#token = generate();
  }

  /**
   * The current `-session-` token. Stable across calls until a block rotates
   * it. Callers inject this into the proxy username at auth time so a
   * post-block rotation propagates to the next CONNECT.
   */
  current(): string {
    return this.#token;
  }

  /**
   * Record that one scrape attempt egressed on the current sticky token (= one
   * serve on the pinned cellular IP). The caller bumps this once per attempt;
   * `observe()` resets it to 0 on rotation so the count read just before a
   * block is "serves before block."
   */
  recordServe(): void {
    this.#servesOnToken += 1;
  }

  /**
   * Serves recorded against the current token since it was last minted/rotated.
   */
  servesOnCurrentToken(): number {
    return this.#servesOnToken;
  }

  /**
   * Inspect a scrape outcome and rotate the token iff it was an
   * IP-attributable block (`isBlockTrigger`). Successes and non-block errors
   * (solver failures, CDP/navigation faults) leave the token untouched — that
   * is the stable-until-block guarantee. Rotating on a non-block error would
   * burn a fresh IP that the block detector says rotation cannot help.
   *
   * On rotation the serve counter resets to 0 — the fresh IP starts clean, so
   * the value read just before this call is "serves before block."
   *
   * @returns `true` if the token was rotated, `false` if held.
   */
  observe(error: ScrapeError | undefined): boolean {
    if (!isBlockTrigger(error)) return false;
    this.#token = this.#generate();
    this.#servesOnToken = 0;
    return true;
  }
}
