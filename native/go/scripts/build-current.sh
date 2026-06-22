#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

goos="$(go env GOOS)"
goarch="$(go env GOARCH)"
case "$goos/$goarch" in
  linux/amd64) target="linux-x64"; exe="canmv-backend" ;;
  linux/arm64) target="linux-arm64"; exe="canmv-backend" ;;
  windows/amd64) target="win32-x64"; exe="canmv-backend.exe" ;;
  windows/arm64) target="win32-arm64"; exe="canmv-backend.exe" ;;
  darwin/amd64) target="darwin-x64"; exe="canmv-backend" ;;
  darwin/arm64) target="darwin-arm64"; exe="canmv-backend" ;;
  *) echo "Unsupported Go target: $goos/$goarch" >&2; exit 1 ;;
esac

mkdir -p "$DIST/$target"
cd "$ROOT"
go build -trimpath -ldflags="-s -w" -o "$DIST/$target/$exe" ./cmd/canmv-backend
