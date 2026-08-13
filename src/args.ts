/**
 * The command-line parser.
 *
 * Hand-written rather than pulled from a library, because two of its rules are unusual: everything
 * after `--` is passed through untouched to the program being launched, and a leading-digit token
 * like `-2` is a frame reference rather than an option.
 */

import { UsageError } from "./errors.js";

/**
 * How an option's value is read.
 *
 * `string[]` accumulates, so the option can be repeated (`--env A=1 --env B=2`).
 */
export type OptionType = "string" | "boolean" | "number" | "string[]";

/** The declaration of one option, used for both parsing and generated help. */
export interface OptionSpec {
  type: OptionType;
  /** A single-letter short form, without the dash. */
  alias?: string;
  /** One line shown by `tui help <command>`. */
  describe: string;
  /** What to call the value in help output. Defaults to `value`, or `n` for numbers. */
  placeholder?: string;
}

/** Every option a command accepts, keyed by its long name. */
export type OptionSpecs = Record<string, OptionSpec>;

/**
 * A parsed command line.
 *
 * Accessors are typed rather than generic: asking for a value as the wrong type yields `undefined`
 * instead of a surprise, which keeps every command's option handling to one line.
 */
export class Args {
  private readonly values: Map<string, string | boolean | number | string[]>;

  /** Arguments that were not options, in order. */
  readonly positionals: string[];
  /** Everything after `--`, passed through verbatim to the program being launched. */
  readonly passthrough: string[];
  /** Whether a `--` was present at all, which is different from it being followed by nothing. */
  readonly sawPassthrough: boolean;

  constructor(
    values: Map<string, string | boolean | number | string[]>,
    positionals: string[],
    passthrough: string[],
    sawPassthrough: boolean,
  ) {
    this.values = values;
    this.positionals = positionals;
    this.passthrough = passthrough;
    this.sawPassthrough = sawPassthrough;
  }

  /** Whether the option was given at all, whatever its value. */
  has(name: string): boolean {
    return this.values.has(name);
  }

  /** The option's value if it was given as a string, otherwise `undefined`. */
  string(name: string): string | undefined {
    const value = this.values.get(name);
    return typeof value === "string" ? value : undefined;
  }

  /** Every value given for a repeatable option; empty when it was not given. */
  list(name: string): string[] {
    const value = this.values.get(name);
    return Array.isArray(value) ? value : [];
  }

  /** The option's value if it was given as a number, otherwise `undefined`. */
  number(name: string): number | undefined {
    const value = this.values.get(name);
    return typeof value === "number" ? value : undefined;
  }

  /**
   * A flag's value.
   *
   * @param fallback - What to report when the flag was not given. Pass `true` for flags that are on
   * by default and turned off with `--no-<name>`.
   */
  boolean(name: string, fallback = false): boolean {
    const value = this.values.get(name);
    return typeof value === "boolean" ? value : fallback;
  }

  /** The nth non-option argument, or `undefined`. */
  positional(index: number): string | undefined {
    return this.positionals[index];
  }

  /**
   * The nth non-option argument, failing if it is absent.
   *
   * @param label - What the argument is called, used in the error: `missing session name`.
   * @throws {UsageError} If the argument was not given.
   */
  requirePositional(index: number, label: string): string {
    const value = this.positionals[index];
    if (value === undefined || value === "") throw new UsageError(`missing ${label}`);
    return value;
  }
}

/**
 * Parse an argument vector against a command's option declarations.
 *
 * Supports `--name value`, `--name=value`, `-a value`, bare boolean flags, and `--no-name` to turn
 * off a boolean that defaults on.
 *
 * @param argv - The arguments for this command, with the command name already removed.
 * @throws {UsageError} On an unknown option, a missing value, or a bad number.
 */
export function parseArgs(argv: readonly string[], specs: OptionSpecs): Args {
  const byAlias = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias) byAlias.set(spec.alias, name);
  }

  const values = new Map<string, string | boolean | number | string[]>();
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let sawPassthrough = false;

  /** Map a `--long` or `-a` token to its declaration. */
  const resolve = (token: string): { name: string; spec: OptionSpec } => {
    const name = token.startsWith("--") ? token.slice(2) : (byAlias.get(token.slice(1)) ?? "");
    const spec = specs[name];
    if (!spec) throw new UsageError(`unknown option ${token}`);
    return { name, spec };
  };

  /** Coerce and store one option value according to its declared type. */
  const assign = (name: string, spec: OptionSpec, raw: string): void => {
    if (spec.type === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed))
        throw new UsageError(`--${name} expects a number, got "${raw}"`);
      values.set(name, parsed);
      return;
    }
    if (spec.type === "string[]") {
      const current = values.get(name);
      const list = Array.isArray(current) ? current : [];
      list.push(raw);
      values.set(name, list);
      return;
    }
    if (spec.type === "boolean") {
      values.set(name, raw !== "false" && raw !== "0");
      return;
    }
    values.set(name, raw);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";

    if (token === "--") {
      sawPassthrough = true;
      passthrough.push(...argv.slice(index + 1));
      break;
    }

    /* "-1", "-2" … are relative frame references (`tui frame app -2`), never options. A negative
       value passed *to* an option never reaches here: the lookahead below consumes it first. */
    if (/^-\d/.test(token)) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-") && !specs[token.slice(2)]) {
      const name = token.slice(5);
      const spec = specs[name];
      if (spec?.type !== "boolean") throw new UsageError(`unknown option ${token}`);
      values.set(name, false);
      continue;
    }

    if (token.startsWith("--") && token.includes("=")) {
      const splitAt = token.indexOf("=");
      const { name, spec } = resolve(token.slice(0, splitAt));
      assign(name, spec, token.slice(splitAt + 1));
      continue;
    }

    if (token.startsWith("--") || (token.startsWith("-") && token.length === 2 && token !== "-")) {
      const { name, spec } = resolve(token);
      if (spec.type === "boolean") {
        values.set(name, true);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`--${name} expects a value`);
      assign(name, spec, next);
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return new Args(values, positionals, passthrough, sawPassthrough);
}

/** Render a command's options as the aligned two-column block `tui help <command>` prints. */
export function formatOptions(specs: OptionSpecs): string {
  const entries = Object.entries(specs);
  if (entries.length === 0) return "";
  const rendered = entries.map(([name, spec]) => {
    const alias = spec.alias ? `-${spec.alias}, ` : "";
    const placeholder =
      spec.type === "boolean"
        ? ""
        : ` <${spec.placeholder ?? (spec.type === "number" ? "n" : "value")}>`;
    return { left: `  ${alias}--${name}${placeholder}`, right: spec.describe };
  });
  const width = Math.max(...rendered.map((entry) => entry.left.length));
  return rendered.map((entry) => `${entry.left.padEnd(width + 2)}${entry.right}`).join("\n");
}
