# Releasing tui-driver

Releases are built by GitHub Actions from a version tag. Users download standalone executables;
they do not clone the repository or need Bun installed.

## Prepare the tag

1. Update `version` in `package.json` and move the relevant entries in `CHANGELOG.md` from
   `Unreleased` into that version.
2. Open a pull request and let CI test the source suite plus native release packages for Linux x64
   and macOS arm64.
3. Merge the pull request to `main`.
4. Create and push an annotated `vMAJOR.MINOR.PATCH` tag at the reviewed commit. The tag must match
   `package.json` exactly; the build refuses a mismatch.

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "tui-driver v0.1.0"
git push origin v0.1.0
```

Pushing the tag runs `.github/workflows/release.yml`. Each artifact is compiled and smoke-tested on
its own architecture. The publish job runs only after all four builds pass, verifies the assembled
checksums, and creates the GitHub release with generated notes.

## Release assets

Every release contains:

- `tui-driver-linux-x64.tar.gz`
- `tui-driver-linux-arm64.tar.gz`
- `tui-driver-darwin-x64.tar.gz`
- `tui-driver-darwin-arm64.tar.gz`
- one `.sha256` file for each archive
- `install.sh`

The archive root is `tui-driver/` and contains the standalone executable, the agent skill, license,
README, installer, and `release.json` metadata. Darwin executables receive an ad hoc signature with
the Bun JIT entitlements. There is currently no Apple Developer ID signing or notarization.

## Verify after publication

Inspect the workflow and the release page, then test both the moving and pinned installer URLs on
at least one Linux and one macOS machine:

```bash
curl -fsSL https://github.com/evandrocabf/tui-driver/releases/latest/download/install.sh | bash
tui --version
tui doctor

curl -fsSL https://github.com/evandrocabf/tui-driver/releases/download/v0.1.0/install.sh \
  | bash -s -- --version v0.1.0
```

Do not create a release manually before the build jobs finish. The workflow creates it only when
the four archives and their smoke tests are complete. It uploads into a draft first and publishes
the release only after every asset is attached. Tags with a prerelease suffix create a GitHub
prerelease and do not replace the stable `latest` installer target.
