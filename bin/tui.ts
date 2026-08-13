#!/usr/bin/env bun
/**
 * The `tui` / `tui-driver` entry point.
 *
 * Deliberately thin: it owns the process — exit status and last-resort error reporting — and
 * nothing else. Everything testable lives in {@link main}, which returns a code instead of exiting,
 * so the test suite drives the whole CLI in-process.
 */

import { main } from "../src/cli.js";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  /* Anything reaching here is a bug rather than a handled failure: every expected error carries its
     own exit code and is reported by `main`. 70 is EX_SOFTWARE, distinct from every code the CLI
     uses deliberately, so a crash is never mistaken for a normal outcome. */
  process.stderr.write(`unexpected error: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 70;
}
