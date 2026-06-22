#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

targets=(
  "linux amd64 linux-x64 canmv-backend"
  "linux arm64 linux-arm64 canmv-backend"
  "windows amd64 win32-x64 canmv-backend.exe"
  "windows arm64 win32-arm64 canmv-backend.exe"
  "darwin amd64 darwin-x64 canmv-backend"
  "darwin arm64 darwin-arm64 canmv-backend"
)

cd "$ROOT"
for entry in "${targets[@]}"; do
  read -r goos goarch target exe <<< "$entry"
  echo "Building $target ($goos/$goarch)..."
  mkdir -p "$DIST/$target"
  env GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$DIST/$target/$exe" ./cmd/canmv-backend
done
