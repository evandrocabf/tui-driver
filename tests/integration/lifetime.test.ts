import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createState, destroyState, hasBinary, restoreHome, until } from "../helpers/tui.js";

const TMUX_AVAILABLE = await hasBinary("tmux");
const previousHome = process.env["TUI_DRIVER_HOME"];
const previousInterval = process.env["TUI_DRIVER_WATCHDOG_INTERVAL"];
let stateDir = "";

/** Something that stays alive on its own, so only the lease can end the session. */
const IDLE = ["sh", "-c", "sleep 600"];

describe.skipIf(!TMUX_AVAILABLE)("session leases", () => {
  beforeAll(async () => {
    stateDir = await createState("lifetime");
    /* The watchdog polls; a test cannot wait five seconds for every assertion. */
    process.env["TUI_DRIVER_WATCHDOG_INTERVAL"] = "200ms";
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
    if (previousInterval === undefined) delete process.env["TUI_DRIVER_WATCHDOG_INTERVAL"];
    else process.env["TUI_DRIVER_WATCHDOG_INTERVAL"] = previousInterval;
  });

  test("the watchdog kills a session when its lease runs out", async () => {
    const { startSession } = await import("../../src/session.js");
    const { hasSession } = await import("../../src/tmux.js");

    await startSession({ name: "lease-watchdog", argv: IDLE, cols: 40, rows: 10, ttlMs: 1500 });
    expect(await hasSession("lease-watchdog")).toBe(true);

    /* No CLI command runs in between: the session has to die without anyone asking it to. */
    expect(await until(async () => !(await hasSession("lease-watchdog")), 15_000, 200)).toBe(true);
  });

  test("a past deadline is reaped by the sweep, and the pane's process goes with it", async () => {
    const { NEVER, reap, setDeadline } = await import("../../src/lifetime.js");
    const { listSessions, startSession } = await import("../../src/session.js");
    const { hasSession } = await import("../../src/tmux.js");
    const { isProcessAlive } = await import("../../src/util.js");

    /* No watchdog on this one: the sweep alone has to notice, which is what this test is about. */
    await startSession({ name: "lease-sweep", argv: IDLE, cols: 40, rows: 10, ttlMs: NEVER });
    const info = (await listSessions()).find((session) => session.name === "lease-sweep");
    expect(info?.panePid).toBeGreaterThan(0);

    await setDeadline("lease-sweep", Date.now() - 1000);
    const reaped = await reap();

    expect(reaped.map((session) => session.name)).toContain("lease-sweep");
    expect(reaped.find((session) => session.name === "lease-sweep")?.reason).toBe("expired");
    expect(await hasSession("lease-sweep")).toBe(false);
    expect(await until(() => !isProcessAlive(info?.panePid ?? 0), 5000, 100)).toBe(true);
  });

  test("keepAlive pushes the deadline back, and the running watchdog honours it", async () => {
    const { readDeadline, reap } = await import("../../src/lifetime.js");
    const { keepAlive, startSession } = await import("../../src/session.js");
    const { hasSession } = await import("../../src/tmux.js");
    const { sleep } = await import("../../src/util.js");

    await startSession({ name: "lease-renew", argv: IDLE, cols: 40, rows: 10, ttlMs: 1500 });
    await keepAlive("lease-renew", 600_000);
    expect(await readDeadline("lease-renew")).toBeGreaterThan(Date.now() + 500_000);

    /* Well past the original lease: the watchdog re-reads the deadline instead of caching it. */
    await sleep(3000);
    const reaped = await reap();
    expect(reaped.map((session) => session.name)).not.toContain("lease-renew");
    expect(await hasSession("lease-renew")).toBe(true);
  });

  test("a session with no lease at all falls back to the default one", async () => {
    const { DEFAULT_TTL_MS, EXPIRES_OPTION, NEVER, reap } = await import("../../src/lifetime.js");
    const { startSession } = await import("../../src/session.js");
    const { exactTarget, hasSession, tmux } = await import("../../src/tmux.js");

    await startSession({ name: "lease-legacy", argv: IDLE, cols: 40, rows: 10, ttlMs: NEVER });
    /* What a session started by an older version — or by hand — looks like. */
    await tmux(["set-option", "-u", "-t", `${exactTarget("lease-legacy")}:`, EXPIRES_OPTION]);

    expect((await reap()).map((session) => session.name)).not.toContain("lease-legacy");
    const later = await reap({ now: Date.now() + DEFAULT_TTL_MS + 60_000 });
    expect(later.map((session) => session.name)).toContain("lease-legacy");
    expect(await hasSession("lease-legacy")).toBe(false);
  });

  test("an opted-out session survives the sweep but not an explicit max age", async () => {
    const { NEVER, reap } = await import("../../src/lifetime.js");
    const { startSession } = await import("../../src/session.js");
    const { hasSession, listSessionNames } = await import("../../src/tmux.js");

    await startSession({ name: "lease-never", argv: IDLE, cols: 40, rows: 10, ttlMs: NEVER });
    const far = await reap({ now: Date.now() + 10 * 60 * 60_000 });
    expect(far.map((session) => session.name)).not.toContain("lease-never");
    expect(await hasSession("lease-never")).toBe(true);

    /* `tui gc --max-age 0`: the last resort that ignores every lease. */
    const forced = await reap({ maxAgeMs: 0 });
    expect(forced.map((session) => session.name)).toContain("lease-never");
    expect(await listSessionNames()).toHaveLength(0);
  });
});
