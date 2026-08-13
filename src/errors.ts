/**
 * The exit codes the CLI contracts on.
 *
 * These are documented in the README and the agent skill, and callers are told to branch on them
 * rather than parse output, so they are part of the public interface and must not be renumbered.
 *
 * Success (0) has no constant: nothing ever needs to name it, since a command that succeeds simply
 * returns 0.
 */

/**
 * A condition was not met: `wait` timed out, `find` matched nothing, a scenario step failed, or
 * `diff` found changes. The command worked; the answer was no.
 */
export const EXIT_CONDITION = 1;

/** The command line itself was wrong — unknown option, bad duration, missing argument. */
export const EXIT_USAGE = 2;

/** A required external tool is missing: tmux, or a rasterizer when `--png` was asked for. */
export const EXIT_DEPENDENCY = 3;

/** No session by that name — it was never started, already stopped, or its lease ran out. */
export const EXIT_NO_SESSION = 4;

/**
 * An error that carries the process exit code to report for it.
 *
 * Throwing one of these from anywhere in a command is how the CLI turns a failure into the right
 * exit status without threading return values back up by hand.
 */
export class CliError extends Error {
  /** The status the process should exit with; one of the `EXIT_*` constants. */
  readonly exitCode: number;

  /**
   * @param message - Shown to the user on stderr, so it should say what to do next.
   * @param exitCode - One of the `EXIT_*` constants.
   */
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** The command line was malformed or self-contradictory. Exits {@link EXIT_USAGE}. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
  }
}

/** A required external tool is missing. Exits {@link EXIT_DEPENDENCY}. */
export class DependencyError extends CliError {
  constructor(message: string) {
    super(message, EXIT_DEPENDENCY);
  }
}

/** The named session does not exist, or no longer does. Exits {@link EXIT_NO_SESSION}. */
export class SessionError extends CliError {
  constructor(message: string) {
    super(message, EXIT_NO_SESSION);
  }
}

/**
 * The command ran but its condition did not hold. Exits {@link EXIT_CONDITION}.
 *
 * This is a normal outcome rather than a fault, which is why it is separate from every other error:
 * a `wait` that times out has not malfunctioned.
 */
export class ConditionError extends CliError {
  constructor(message: string) {
    super(message, EXIT_CONDITION);
  }
}
