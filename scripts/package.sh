#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="$(node -p "require('$PROJECT_DIR/extension/package.json').version")"
COMMIT="${CI_COMMIT_SHORT_SHA:-${GITHUB_SHA:-}}"
COMMIT="${COMMIT:0:7}"
if [ -z "$COMMIT" ]; then
  COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")"
fi
VERSION="${VERSION%-${COMMIT}}"
VERSION="${VERSION%-${COMMIT:0:7}}"
VSIX_NAME="canmv-vscode-${VERSION}-${COMMIT}.vsix"

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
mkdir -p "$PROJECT_DIR/release"
pushd "$PROJECT_DIR/extension" > /dev/null
npx @vscode/vsce package -o "$PROJECT_DIR/release/$VSIX_NAME"
popd > /dev/null

echo "=== Done: $PROJECT_DIR/release/$VSIX_NAME ==="
