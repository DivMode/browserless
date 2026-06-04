/**
 * Unit tests for the ADR-0068 guaranteed-terminal-outcome path.
 *
 * The invariant under test: scrape work that hangs / defects / is interrupted
 * MUST be converted into a VISIBLE, categorized failure `ScrapeOutput` value
 * (never thrown past the dispatch boundary, never silent), and that value MUST
 * produce a valid (under Loki's attribute cap) `ahrefs.scrape.wide_event`.
 *
 * These tests exercise the pure pieces — `buildTerminalFailureOutput` and the
 * `Effect.timeout` → `Effect.catchCause` conversion — without launching a
 * browser, so they run in the unit project.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect } from "effect";
import { buildTerminalFailureOutput } from "./ahrefs-session.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import type { ScrapeOutput } from "./ahrefs-service.js";

const wideEventOf = (output: ScrapeOutput) =>
  buildWideEvent({
    result: output.result,
    cfMetrics: output.cfMetrics ?? emptyCfMetrics(),
    replayMeta: output.replayMeta ?? null,
    diagnostics: output.diagnostics,
    domain: output.domain,
    scrapeType: output.scrapeType,
    scrapeUrl: output.scrapeUrl,
    apiCallStatus: output.apiCallStatus,
  });

describe("ADR-0068 terminal failure output", () => {
  it("a die/defect cause → visible scrape_defect failure (never thrown, never silent)", () => {
    const output = buildTerminalFailureOutput(
      "example.com",
      "backlinks",
      Cause.die(new Error("page crashed mid-solve")),
    );
    expect(output.result.success).toBe(false);
    expect(output.apiCallStatus).toBe("scrape_defect");
    expect(output.result.error).toContain("scrape_defect");
    // The failure carries a categorized typed error so the wide event surfaces it.
    expect(output.result.scrapeError?._tag).toBe("ScrapeInfraError");
  });

  it("an interrupt cause (the hard-deadline trip) → scrape_timeout failure", () => {
    const output = buildTerminalFailureOutput("example.com", "backlinks", Cause.interrupt(0));
    expect(output.result.success).toBe(false);
    expect(output.apiCallStatus).toBe("scrape_timeout");
    expect(output.result.error).toContain("scrape_timeout");
  });

  it("the terminal failure output ALWAYS produces a valid wide event (under the Loki cap)", () => {
    // The ADR invariant: a hung/dead scrape is recordable as a normal failure
    // wide event — the success metric stops lying.
    const output = buildTerminalFailureOutput(
      "example.com",
      "traffic",
      Cause.die(new Error("teardown wedged")),
    );
    const event = wideEventOf(output);
    expect(event.ahrefs_success).toBe("false");
    expect(event.ahrefs_domain).toBe("example.com");
    expect(event.scraper_type).toBe("traffic");
    // Categorized as infrastructure so it is queryable, not a "?" bucket.
    expect(event.scrape_error_category).toBe("infrastructure");
    // Wide event must stay well under the 113 attribute ceiling.
    expect(Object.keys(event).length).toBeLessThanOrEqual(113);
    expect(Object.keys(event).length).toBeGreaterThanOrEqual(90);
  });
});

describe("ADR-0068 hard-deadline conversion (Effect.timeout -> catchCause)", () => {
  // Mirrors the runDispatch control flow: hung scrape work -> timeout -> cause
  // -> failure VALUE. We assert the converted Effect SUCCEEDS with a failure
  // ScrapeOutput rather than failing/dying — proving scrape work "always yields
  // a result value and never throws past this point".
  const convert = (work: Effect.Effect<ScrapeOutput, Error>) =>
    work.pipe(
      Effect.timeout("100 millis"),
      Effect.catchCause((cause) =>
        Effect.succeed(buildTerminalFailureOutput("example.com", "backlinks", cause)),
      ),
    );

  it("a scrape that hangs past the deadline yields a scrape_timeout failure VALUE", async () => {
    // Effect.never is Effect<never> — assignable to Effect<ScrapeOutput, Error>.
    const output = await Effect.runPromise(convert(Effect.never));
    expect(output.result.success).toBe(false);
    expect(output.apiCallStatus).toBe("scrape_timeout");
  });

  it("a scrape that defects yields a scrape_defect failure VALUE (no throw escapes)", async () => {
    // The thrown Error makes this a defect; the function never returns, so the
    // Effect is Effect<never> — no value cast needed.
    const boom = Effect.sync(() => {
      throw new Error("CDP session gone");
    });
    const output = await Effect.runPromise(convert(boom));
    expect(output.result.success).toBe(false);
    expect(output.apiCallStatus).toBe("scrape_defect");
    expect(output.result.error).toContain("CDP session gone");
  });
});
