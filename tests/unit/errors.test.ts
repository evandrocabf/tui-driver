import { describe, expect, test } from "bun:test";

import {
  CliError,
  ConditionError,
  DependencyError,
  EXIT_CONDITION,
  EXIT_DEPENDENCY,
  EXIT_NO_SESSION,
  EXIT_USAGE,
  SessionError,
  UsageError,
} from "../../src/errors.js";

describe("CliError", () => {
  test("carries the exit code the process should report", () => {
    const error = new CliError("something went wrong", 7);
    expect(error.exitCode).toBe(7);
    expect(error.message).toBe("something went wrong");
    expect(error).toBeInstanceOf(Error);
  });

  test("names itself after the concrete subclass", () => {
    /* `new.target.name` rather than a hard-coded string, so a subclass reports its own name in a
       stack trace instead of the base class's. */
    expect(new CliError("x", 1).name).toBe("CliError");
    expect(new UsageError("x").name).toBe("UsageError");
    expect(new DependencyError("x").name).toBe("DependencyError");
    expect(new SessionError("x").name).toBe("SessionError");
    expect(new ConditionError("x").name).toBe("ConditionError");
  });
});

describe("the exit-code contract", () => {
  /* These are documented in the README and the skill, and agents are told to branch on them, so a
     renumbering is a breaking change and this test is the thing that says so. */
  test("each error class maps to its documented code", () => {
    expect(new UsageError("bad flag").exitCode).toBe(EXIT_USAGE);
    expect(new DependencyError("no tmux").exitCode).toBe(EXIT_DEPENDENCY);
    expect(new SessionError("gone").exitCode).toBe(EXIT_NO_SESSION);
    expect(new ConditionError("timed out").exitCode).toBe(EXIT_CONDITION);
  });

  test("the codes themselves have not moved", () => {
    expect([EXIT_CONDITION, EXIT_USAGE, EXIT_DEPENDENCY, EXIT_NO_SESSION]).toEqual([1, 2, 3, 4]);
  });

  test("every one is catchable as a CliError", () => {
    /* main() branches on `instanceof CliError` to turn a throw into an exit code; a subclass that
       broke the chain would fall through to the crash handler instead. */
    for (const error of [
      new UsageError("x"),
      new DependencyError("x"),
      new SessionError("x"),
      new ConditionError("x"),
    ]) {
      expect(error).toBeInstanceOf(CliError);
    }
  });
});
