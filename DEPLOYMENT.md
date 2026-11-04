# Deploying & Distributing portctl

portctl is a self-contained CLI tool that runs on Bun or Node.js. There is no
server to host — "deployment" here means **packaging it so end users can install
and run it on their machines**. This guide covers the four practical
distribution paths, from lowest-effort to most polished, plus the small
`package.json` changes each one needs.

| Path | User experience | Requires Bun on user's machine? | Effort |
| --- | --- | --- | --- |
| 1. Run from source | `bunx portctl` / clone + `bun install` | Yes | Minimal |
| 2. npm package | `npm i -g portctl` → `portctl` | No (Node 26.1+ or Bun) | Low |
| 3. Standalone binary | Download + run `./portctl` | **No** | Medium |
| 4. Homebrew tap | `brew install portctl` | No | Medium |

Pick the one that matches your audience. Path 3 (standalone binary) is the
single best option if you want zero-friction installs for non-Bun users.

---

## 0. Prerequisites (one-time, all paths)

Before publishing anything:

1. Bump `version` in `package.json` (use [SemVer](https://semver.org/)).
2. Make sure `bun install` + `bun index.ts` works cleanly from a fresh clone.
3. Decide on a package name and check it's free on npm:
   ```bash
   npm view portctl
   ```
4. Have an npm account and run `npm login` (for paths 1 & 2).
5. Have a GitHub repo pushed (for paths 3 & 4 release artifacts).

---

## 1. Run from source (quickest)

No packaging changes required. Users with Bun installed just do:

```bash
git clone https://github.com/you/portctl.git
cd portctl
bun install
bun index.ts
```

Or, if you've published to npm (see path 2), they can skip the clone:

```bash
bunx portctl        # runs the published package without installing
```

**Good for:** teammates, contributors, yourself.
**Not good for:** end users who don't have Bun.

---

## 2. Publish to npm as a global CLI

This is the standard way to ship a Bun/Node CLI. Add a `bin` field so the
package installs an executable on `PATH`. The repo already does this: the build
targets Node (`bun build --target=node`), which runs under both Bun and Node,
and `bin` points at a small launcher (`dist/cli.js`) that re-execs Node with
`--experimental-ffi` when needed — OpenTUI's native core loads via `node:ffi`,
which is experimental (Node 26.1+) and gated behind that flag.

### 2a. Update `package.json`

```jsonc
{
  "name": "@ashhitch/portctl",
  "version": "0.2.0",
  "type": "module",
  "bin": {
    "portctl": "dist/cli.js"
  },
  "main": "dist/index.js",
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "start": "bun index.ts",
    "build": "bun build index.ts --outfile=dist/index.js --target=node --format=esm --external @opentui/core --banner \"#!/usr/bin/env node\" && bun build cli.ts --outfile=dist/cli.js --target=node --format=esm --banner \"#!/usr/bin/env node\" && chmod +x dist/index.js dist/cli.js",
    "test": "bun run build && node --test test/",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=26.1.0"
  },
  "dependencies": {
    "@opentui/core": "^0.4.2"
  }
}
```

Notes:
- The published build is runtime-agnostic: `bun build --target=node` output runs
  under both Bun and Node.js, and `src/ports.ts` uses `node:child_process`
  (no `Bun.*` APIs). The `bin` launcher handles Node's `--experimental-ffi`
  requirement transparently — end users don't need any flags.
- `files` whitelists what gets published. Without it, `node_modules` and other
  junk can leak into the tarball. **Do not** publish `node_modules`.

### 2b. Sanity-check the tarball

```bash
bun run build            # produce dist/ first — it's what gets published
bun pm pack              # produces ashhitch-portctl-0.2.0.tgz
tar -tzf ashhitch-portctl-0.2.0.tgz   # verify only dist/, README.md, package.json are inside
```

### 2c. Publish

```bash
npm publish              # first release
# or for a scoped package: npm publish --access public
```

### 2d. User install

```bash
npm install -g portctl     # or: bun add -g portctl
portctl
```

**Good for:** anyone with Bun or Node.js 26.1+ (the launcher auto-sets the
`--experimental-ffi` flag OpenTUI needs under Node).
**Not good for:** users with neither runtime, or who dislike global npm installs.

---

## 3. Ship a standalone compiled binary (recommended)

`bun build --compile` bundles your code **and the Bun runtime** into a single
self-contained executable. Users don't need Bun, Node, or any dependencies
installed — just download and run. This is the most user-friendly option.

### 3a. Build per target

Bun can cross-compile to all supported targets from one machine:

```bash
mkdir -p dist

# macOS (Apple Silicon)
bun build ./index.ts --compile --target=bun-darwin-arm64 --outfile dist/portctl-darwin-arm64

# macOS (Intel)
bun build ./index.ts --compile --target=bun-darwin-x64 --outfile dist/portctl-darwin-x64

# Linux (x64)
bun build ./index.ts --compile --target=bun-linux-x64 --outfile dist/portctl-linux-x64

# Linux (arm64)
bun build ./index.ts --compile --target=bun-linux-arm64 --outfile dist/portctl-linux-arm64

# Windows (x64)
bun build ./index.ts --compile --target=bun-windows-x64 --outfile dist/portctl-windows-x64.exe
```

Verify each binary on its target platform if you can (or via CI — see §5).

### 3b. Strip the `.exe` suffix on Unix

The Windows build needs `.exe`; the others don't. Keep the suffix only on the
Windows artifact (as above).

### 3c. Distribute the binaries

Two common options:

**Option A — GitHub Releases.** Tag a release and upload the `dist/*` binaries:

```bash
git tag v0.1.0 && git push --tags
gh release create v0.1.0 dist/* --title "v0.1.0" --notes "First release"
```

Users then download the right file for their platform from the Releases page.

**Option B — Install script.** A small `install.sh` that detects the platform
and fetches the right binary from the latest release:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="you/portctl"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  target="darwin-arm64" ;;
  Darwin-x86_64) target="darwin-x64"   ;;
  Linux-x86_64)  target="linux-x64"    ;;
  Linux-aarch64) target="linux-arm64"  ;;
  *) echo "Unsupported platform"; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/portctl-$target"
curl -fsSL "$url" -o "$INSTALL_DIR/portctl"
chmod +x "$INSTALL_DIR/portctl"
echo "Installed to $INSTALL_DIR/portctl — make sure $INSTALL_DIR is on your PATH"
```

Host this as `install.sh` in the repo so users can run:

```bash
curl -fsSL https://raw.githubusercontent.com/you/portctl/main/install.sh | bash
```

**Good for:** everyone. No runtime dependency, no package manager.
**Caveats:**
- Compiled binaries are larger (~50–90 MB) because they embed Bun.
- Each platform needs its own binary — you must build/CI all targets.
- Code signing / notarization is recommended for macOS distribution outside
  Homebrew (see §6).

---

## 4. Homebrew tap (macOS-friendliest)

Wrap the prebuilt binary from path 3 in a Homebrew formula so macOS users get
the familiar `brew install` flow.

### 4a. Create a tap repo

Create a new GitHub repo named `homebrew-portctl` (the `homebrew-` prefix is
required). Add a `Formula/portctl.rb`:

```ruby
class PortCloser < Formula
  desc "Terminal UI for listing TCP listening ports and killing their processes"
  homepage "https://github.com/you/portctl"
  url "https://github.com/you/portctl/releases/download/v0.1.0/portctl-darwin-arm64"
  sha256 "REPLACE_WITH_SHA256_OF_THE_DOWNLOADED_BINARY"
  version "0.1.0"
  license "MIT"

  # This is a prebuilt binary, not built from source.
  def install
    bin.install "portctl-darwin-arm64" => "portctl"
  end

  test do
    assert_match "portctl", shell_output("#{bin}/portctl --help 2>&1", 1)
  end
end
```

Compute the sha256:

```bash
shasum -a 256 portctl-darwin-arm64
```

For multi-arch support, use `on_macos do ... on_arm do ... on_intel do ... end end`
blocks with separate `url`/`sha256` per arch. See the
[Homebrew formula docs](https://docs.brew.sh/Formula-Cookbook).

### 4b. Users install

```bash
brew tap you/portctl
brew install portctl
portctl
```

Or, if you publish the tap to a custom repo name, adjust the `brew tap` line
accordingly.

**Good for:** macOS power users.
**Caveats:** macOS only. Linuxbrew works too but the formula above targets
darwin — add `on_linux do` blocks with the linux binary URL if you want it.

---

## 5. CI to automate builds & releases

Put the build matrix in GitHub Actions so every tag produces all binaries
automatically. `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target:
          - bun-darwin-arm64
          - bun-darwin-x64
          - bun-linux-x64
          - bun-linux-arm64
          - bun-windows-x64
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Build
        run: |
          ext=""
          [[ "${{ matrix.target }}" == "bun-windows-x64" ]] && ext=".exe"
          bun build ./index.ts --compile --target=${{ matrix.target }} \
            --outfile dist/portctl-${{ matrix.target }}${ext}
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*
```

Push a tag (`git tag v0.1.0 && git push --tags`) and the binaries land in the
GitHub Release attached to that tag.

---

## 6. macOS code signing & notarization (optional, recommended)

Unsigned macOS binaries downloaded from the web will trigger Gatekeeper
("cannot be opened because the developer cannot be verified"). To silence that
for end users:

1. Enroll in the [Apple Developer Program](https://developer.apple.com/) ($99/yr).
2. In CI (a `macos-latest` runner), sign and notarize the darwin binaries:
   ```bash
   codesign --force --sign "Developer ID Application: Your Name (TEAMID)" \
     --options runtime dist/portctl-darwin-arm64
   xcrun notarytool submit dist/portctl-darwin-arm64.zip \
     --apple-id you@example.com --team-id TEAMID --password APP-SPECIFIC-PWD --wait
   xcrun stapler staple dist/portctl-darwin-arm64
   ```
3. Store credentials as GitHub Actions secrets.

Distributing via Homebrew (path 4) sidesteps Gatekeeper for most users, so
signing is less urgent if Homebrew is your primary channel.

---

## 7. Which path should I pick?

- **Internal tool / just for you** → path 1 (run from source).
- **Open-source CLI aimed at developers** → paths 2 + 3 together: publish to
  npm *and* ship compiled binaries on GitHub Releases. Cover both audiences.
- **Polished macOS-first product** → path 3 + path 4 (binary + Homebrew tap),
  with path 6 signing.
- **Want one thing that works everywhere with zero deps** → path 3 only.

## 8. Checklist before each release

- [ ] `package.json` version bumped
- [ ] `bun install` + `bun index.ts` works from a clean clone
- [ ] `npm test` passes (builds `dist/`, then runs the Node test suite)
- [ ] `npm run typecheck` is clean
- [ ] All target binaries build locally (or in CI)
- [ ] Smoke-test each binary on its target OS
- [ ] Tag pushed, CI release workflow ran green
- [ ] GitHub Release published with all artifacts attached
- [ ] (If path 2) `npm publish` succeeded; `bunx portctl@latest` and `portctl` on plain Node both work
- [ ] (If path 4) Homebrew formula `url`/`sha256` updated to the new release
- [ ] README "Install" section points users at the right command for the path(s) you ship
