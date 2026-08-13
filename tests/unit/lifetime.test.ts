import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  NEVER,
  defaultTtlMs,
  describeTtl,
  resolveTtlMs,
} from "../../src/lifetime.js";

const previousTtl = process.env["TUI_DRIVER_TTL"];

function setEnvTtl(value: string | undefined): void {
  if (value === undefined) delete process.env["TUI_DRIVER_TTL"];
  else process.env["TUI_DRIVER_TTL"] = value;
}

afterEach(() => setEnvTtl(previousTtl));

describe("defaultTtlMs", () => {
  test("is ten minutes unless the environment says otherwise", () => {
    setEnvTtl(undefined);
    expect(defaultTtlMs()).toBe(DEFAULT_TTL_MS);
    expect(DEFAULT_TTL_MS).toBe(600_000);
  });

  test("reads a duration from TUI_DRIVER_TTL", () => {
    setEnvTtl("90s");
    expect(defaultTtlMs()).toBe(90_000);
  });

  test("lets a human opt out entirely", () => {
    for (const value of ["never", "off", "none", "0"]) {
      setEnvTtl(value);
      expect(defaultTtlMs()).toBe(NEVER);
    }
  });
});

describe("resolveTtlMs", () => {
  test("falls back to the default when no flag is given", () => {
    setEnvTtl(undefined);
    expect(resolveTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
    expect(resolveTtlMs("")).toBe(DEFAULT_TTL_MS);
  });

  test("parses a duration", () => {
    expect(resolveTtlMs("45m")).toBe(2_700_000);
  });

  test("refuses to disable the lease from the command line", () => {
    expect(() => resolveTtlMs("never")).toThrow(/cannot disable/);
    expect(() => resolveTtlMs("0")).toThrow(/must be positive/);
  });

  test("caps how long a caller may ask for", () => {
    expect(resolveTtlMs(`${MAX_TTL_MS}`)).toBe(MAX_TTL_MS);
    expect(() => resolveTtlMs("2h")).toThrow(/cannot exceed/);
  });
});

describe("describeTtl", () => {
  test("phrases both outcomes", () => {
    expect(describeTtl(DEFAULT_TTL_MS)).toBe("expires in 10m");
    expect(describeTtl(NEVER)).toBe("no expiry");
  });
});
