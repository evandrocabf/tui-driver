#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };

const TARGETS = {
  "bun-linux-x64-baseline": { platform: "linux", arch: "x64" },
  "bun-linux-arm64": { platform: "linux", arch: "arm64" },
  "bun-darwin-x64": { platform: "darwin", arch: "x64" },
  "bun-darwin-arm64": { platform: "darwin", arch: "arm64" },
} as const;

type ReleaseTarget = keyof typeof TARGETS;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const rawTarget = option("--target");
if (!rawTarget || !(rawTarget in TARGETS)) {
  fail(`--target must be one of: ${Object.keys(TARGETS).join(", ")}`);
}
const target = rawTarget as ReleaseTarget;
const spec = TARGETS[target];
if (process.platform !== spec.platform || process.arch !== spec.arch) {
  fail(
    `${target} must be built and smoke-tested on ${spec.platform}/${spec.arch}, running on ${process.platform}/${process.arch}`,
  );
}
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json has an invalid release version: ${version}`);
}

const tag = process.env["GITHUB_REF_TYPE"] === "tag" ? process.env["GITHUB_REF_NAME"] : undefined;
if (tag && tag !== `v${version}`) {
  fail(`tag ${tag} does not match package.json version ${version}`);
}

const outDir = resolve(option("--out-dir") ?? "dist");
const asset = `tui-driver-${spec.platform}-${spec.arch}.tar.gz`;
const staging = join(outDir, `.staging-${spec.platform}-${spec.arch}`);
const packageRoot = join(staging, "tui-driver");
const executable = join(packageRoot, "bin", "tui");
const archive = join(outDir, asset);

await rm(staging, { recursive: true, force: true });
await mkdir(join(packageRoot, "bin"), { recursive: true });
await mkdir(join(packageRoot, "skills"), { recursive: true });

const build = await Bun.build({
  entrypoints: [resolve("bin/tui.ts")],
  compile: {
    target,
    outfile: executable,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
  sourcemap: "linked",
  define: {
    "process.env.TUI_DRIVER_STANDALONE": JSON.stringify("1"),
  },
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}

await chmod(executable, 0o755);
await cp(resolve("skills/tui-driver"), join(packageRoot, "skills", "tui-driver"), {
  recursive: true,
});
for (const file of ["README.md", "LICENSE", "install.sh"]) {
  await copyFile(resolve(file), join(packageRoot, file));
}
await Bun.write(
  join(packageRoot, "release.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      name: packageJson.name,
      version,
      target,
      platform: spec.platform,
      arch: spec.arch,
      commit: process.env["GITHUB_SHA"] ?? "local",
    },
    null,
    2,
  )}\n`,
);

if (spec.platform === "darwin") {
  const sign = Bun.spawn(
    [
      "codesign",
      "--deep",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve("release/entitlements.plist"),
      executable,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await sign.exited) !== 0) fail("ad-hoc codesigning failed");

  const verify = Bun.spawn(["codesign", "--verify", "--strict", executable], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await verify.exited) !== 0) fail("codesign verification failed");
}

const versionCheck = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
const versionOutput = (await new Response(versionCheck.stdout).text()).trim();
const versionError = (await new Response(versionCheck.stderr).text()).trim();
if ((await versionCheck.exited) !== 0 || versionOutput !== `tui-driver ${version}`) {
  fail(`compiled executable failed its version smoke test: ${versionError || versionOutput}`);
}

await mkdir(outDir, { recursive: true });
await rm(archive, { force: true });
const tar = Bun.spawn(["tar", "-czf", archive, "-C", staging, "tui-driver"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
if ((await tar.exited) !== 0) fail("tar failed while packaging the release");

const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
  .digest("hex");
await Bun.write(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
await rm(staging, { recursive: true, force: true });

console.log(
  JSON.stringify({ version, target, archive, checksum: `${archive}.sha256`, sha256: digest }),
);
