import { describe, expect, it } from "vitest";
import { createBrowserTestSearchOutcome } from "./browserTestSearch";

const RETRIEVED_AT = "2026-08-11T05:00:00.000Z";

describe("browser Test search fixture", () => {
  it("returns stable fictional Australian results without a live provider", () => {
    const first = createBrowserTestSearchOutcome(
      "Lockwood 4570",
      "results",
      RETRIEVED_AT,
    );
    const second = createBrowserTestSearchOutcome(
      "Lockwood 4570",
      "results",
      RETRIEVED_AT,
    );

    expect(second).toEqual(first);
    expect(first.state).toBe("ok");
    expect(first.provider).toBe("browser-test-fixture");
    expect(first.results).toHaveLength(3);
    expect(first.results.every((result) => result.currency === "AUD")).toBe(
      true,
    );
    expect(
      first.results.every((result) =>
        /^https:\/\/example\.(com|net|org)\//.test(result.url),
      ),
    ).toBe(true);
    expect(first.coverage?.sourceDomains).toEqual([
      "example.com",
      "example.net",
      "example.org",
    ]);
  });

  it.each([
    ["empty", "empty"],
    ["timeout", "timeout"],
    ["provider_error", "provider_error"],
  ] as const)("maps the %s scenario to its distinct UI state", (scenario, state) => {
    const outcome = createBrowserTestSearchOutcome(
      "Synthetic item",
      scenario,
      RETRIEVED_AT,
    );

    expect(outcome.state).toBe(state);
    expect(outcome.results).toEqual([]);
    expect(outcome.band).toBeNull();
  });
});
