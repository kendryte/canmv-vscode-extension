#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GO_DIR="$PROJECT_DIR/native/go"

pushd "$GO_DIR" > /dev/null
env GOCACHE="$GO_DIR/.gocache" GOMODCACHE="$GO_DIR/.gomodcache" bash ./scripts/build-current.sh
goos="$(go env GOOS)"
goarch="$(go env GOARCH)"
popd > /dev/null

case "$goos/$goarch" in
  linux/amd64) target="linux-x64"; exe="canmv-backend" ;;
  linux/arm64) target="linux-arm64"; exe="canmv-backend" ;;
  windows/amd64) target="win32-x64"; exe="canmv-backend.exe" ;;
  windows/arm64) target="win32-arm64"; exe="canmv-backend.exe" ;;
  darwin/amd64) target="darwin-x64"; exe="canmv-backend" ;;
  darwin/arm64) target="darwin-arm64"; exe="canmv-backend" ;;
  *) echo "Unsupported Go target: $goos/$goarch" >&2; exit 1 ;;
esac

mkdir -p "$PROJECT_DIR/extension/bin/$target"
cp -a "$GO_DIR/dist/$target/$exe" "$PROJECT_DIR/extension/bin/$target/$exe"
echo "Staged backend: extension/bin/$target/$exe"
