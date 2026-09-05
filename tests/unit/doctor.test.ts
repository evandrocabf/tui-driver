import { describe, expect, test } from "bun:test";

import { assertSupportedTmuxVersion } from "../../src/doctor.js";
import { DependencyError } from "../../src/errors.js";

describe("tmux version contract", () => {
  test("accepts supported major and minor versions", () => {
    expect(assertSupportedTmuxVersion("tmux 3.2")).toBe("tmux 3.2");
    expect(assertSupportedTmuxVersion("tmux 3.6a")).toBe("tmux 3.6a");
    expect(assertSupportedTmuxVersion("tmux 4.0")).toBe("tmux 4.0");
  });

  test("rejects old and unparseable versions", () => {
    expect(() => assertSupportedTmuxVersion("tmux 3.1c")).toThrow(DependencyError);
    expect(() => assertSupportedTmuxVersion("tmux 2.9")).toThrow(/3\.2 or newer/);
    expect(() => assertSupportedTmuxVersion("unknown")).toThrow(/cannot parse/);
  });
});
