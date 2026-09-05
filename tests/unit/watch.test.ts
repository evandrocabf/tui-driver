import { describe, expect, test } from "bun:test";

import { watcherInvocation } from "../../src/watch.js";

describe("watcherInvocation", () => {
  test("re-executes a standalone release directly", () => {
    expect(watcherInvocation(true)).toEqual({ command: process.execPath, prefix: [] });
  });

  test("runs the TypeScript entry from a source checkout", () => {
    const invocation = watcherInvocation(false);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.prefix[0]).toBe("run");
    expect(invocation.prefix[1]).toEndWith("/bin/tui.ts");
  });
});
