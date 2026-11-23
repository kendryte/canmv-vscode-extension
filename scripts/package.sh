#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST_PATH="$PROJECT_DIR/extension/package.json"
DEV_BUILD=0
if [ "$#" -eq 1 ] && [ "$1" = "--dev" ]; then
  DEV_BUILD=1
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--dev]" >&2
  exit 2
fi

VERSION="$(node -p 'require(process.argv[1]).version' "$MANIFEST_PATH")"
COMMIT_FULL="${CI_COMMIT_SHA:-${GITHUB_SHA:-}}"
if [ -z "$COMMIT_FULL" ]; then
  COMMIT_FULL="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
fi
COMMIT="${CI_COMMIT_SHORT_SHA:-${COMMIT_FULL:0:7}}"
VERSION="${VERSION%-${COMMIT}}"
VERSION="${VERSION%-${COMMIT:0:7}}"
if [ "$DEV_BUILD" = 1 ]; then
  # A prerelease version sorts below the release, so VS Code offers the Marketplace build as an
  # update, and the version in logs and build-info.json shows that this is a dev build.
  VERSION="${VERSION}-dev.$(date -u +%Y%m%d%H%M)"
fi
VSIX_NAME="canmv-vscode-${VERSION}-${COMMIT}.vsix"
BUILD_INFO_PATH="$PROJECT_DIR/extension/build-info.json"
BUILD_INFO_BACKUP=""
BUILD_INFO_EXISTED=0
MANIFEST_BACKUP=""
if [ -f "$BUILD_INFO_PATH" ]; then
  BUILD_INFO_EXISTED=1
  BUILD_INFO_BACKUP="$(mktemp)"
  cp "$BUILD_INFO_PATH" "$BUILD_INFO_BACKUP"
fi

cleanup_package_files() {
  if [ -n "$MANIFEST_BACKUP" ]; then
    cp "$MANIFEST_BACKUP" "$MANIFEST_PATH"
    rm -f "$MANIFEST_BACKUP"
  fi
  if [ "$BUILD_INFO_EXISTED" -eq 1 ] && [ -n "$BUILD_INFO_BACKUP" ]; then
    cp "$BUILD_INFO_BACKUP" "$BUILD_INFO_PATH"
    rm -f "$BUILD_INFO_BACKUP"
  else
    rm -f "$BUILD_INFO_PATH"
  fi
}
trap cleanup_package_files EXIT

write_build_info() {
  local dirty=0
  if ! git -C "$PROJECT_DIR" diff --quiet 2>/dev/null || ! git -C "$PROJECT_DIR" diff --cached --quiet 2>/dev/null; then
    dirty=1
  fi

  node - "$BUILD_INFO_PATH" "$VERSION" "$COMMIT_FULL" "$COMMIT" "$dirty" <<'NODE'
const fs = require('fs');
const [file, version, commit, shortCommit, dirty] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  version,
  commit,
  shortCommit,
  dirty: dirty === '1',
  builtAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE
}

echo "=== Packaging CanMV VS Code Extension ==="
echo "Version: $VERSION"
echo "Commit: $COMMIT"

stage_backend() {
  local target="$1"
  local exe="$2"
  local src="$PROJECT_DIR/native/go/dist/$target/$exe"
  local dst="$PROJECT_DIR/extension/bin/$target/$exe"

  if [ ! -f "$src" ]; then
    echo "Missing backend binary: $src" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
}

# Step 1: Build TypeScript
echo "Building TypeScript..."
pushd "$PROJECT_DIR/extension" > /dev/null
npm ci
rm -rf out
npx tsc -p tsconfig.json
popd > /dev/null

# Step 2: Build and stage the Go backend for all supported VS Code platforms.
if [ "${CANMV_SKIP_BACKEND_BUILD:-0}" != "1" ]; then
  echo "Building Go backend..."
  pushd "$PROJECT_DIR/native/go" > /dev/null
  env GOCACHE="$PWD/.gocache" GOMODCACHE="$PWD/.gomodcache" bash ./scripts/build-all.sh
  popd > /dev/null
else
  echo "Using prebuilt Go backend artifacts..."
fi

stage_backend "linux-x64" "canmv-backend"
stage_backend "linux-arm64" "canmv-backend"
stage_backend "win32-x64" "canmv-backend.exe"
stage_backend "win32-arm64" "canmv-backend.exe"
stage_backend "darwin-x64" "canmv-backend"
stage_backend "darwin-arm64" "canmv-backend"

# Step 3: Package VSIX
echo "Packaging VSIX..."
write_build_info
if [ "$DEV_BUILD" = 1 ]; then
  manifest_backup="$(mktemp)"
  cp "$MANIFEST_PATH" "$manifest_backup"
  MANIFEST_BACKUP="$manifest_backup"
  node - "$MANIFEST_PATH" "$VERSION" <<'NODE'
const fs = require('fs');
const [file, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.version = version;
manifest.displayName = `${manifest.displayName}-dev`;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
NODE
fi
mkdir -p "$PROJECT_DIR/release"
pushd "$PROJECT_DIR/extension" > /dev/null
npx @vscode/vsce package -o "$PROJECT_DIR/release/$VSIX_NAME"
popd > /dev/null

echo "=== Done: $PROJECT_DIR/release/$VSIX_NAME ==="
