/**
 * Lint rules, in the flat-config format ESLint 9+ uses.
 *
 * Exported as a plain array rather than through `tseslint.config()`: flat config *is* an array, and
 * the helper's variadic form is deprecated in typescript-eslint 8.
 *
 * The rules are deliberately type-aware. `tsc` already rejects anything ill-typed, so a linter that
 * only reads syntax would have little left to say. What this adds is the class of bug that is
 * perfectly well-typed and still wrong — a promise nobody awaited, an `async` callback handed to
 * something that discards the promise it returns. In a CLI that spawns processes and races a
 * background recorder, those are exactly the bugs worth catching.
 *
 * No formatting rules: `eslint-config-prettier` switches them all off, because Prettier owns layout
 * and two tools with opinions about the same comma is a fight nobody wins. It must stay last.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  /* Generated and vendored trees. A config object with only `ignores` applies globally. */
  { ignores: ["node_modules/**", "coverage/**", "**/.tui-artifacts/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        /* Resolves each file to the nearest tsconfig, so the type-aware rules have types to use. */
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* The whole reason for type-aware linting here: a dropped promise in a command that drives
         tmux means the process can exit before the work has landed. */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      /* `catch {}` is used deliberately throughout — a corrupt metadata file has to read as "not
         there" rather than take down the command reading it. Empty blocks elsewhere stay an error. */
      "no-empty": ["error", { allowEmptyCatch: true }],

      /* tsconfig's noUnusedLocals already reports these at build time; both on means every unused
         binding is flagged twice, in two different wordings. */
      "@typescript-eslint/no-unused-vars": "off",

      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true }],

      /* Environment variables are read as `process.env["TUI_DRIVER_HOME"]` throughout. Both forms
         type-identically here (checked: `noPropertyAccessFromIndexSignature` is off), so this is
         purely a house style — and the brackets say "this key is data, not a known property".
         The rule still fires on genuine `obj["knownProperty"]` access. */
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
    },
  },

  {
    /* Tests reach into internals and assert against loosely-typed parsed JSON on purpose. */
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  {
    /* This file, and anything else JS: no tsconfig covers them, so type-aware rules cannot run. */
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
];
