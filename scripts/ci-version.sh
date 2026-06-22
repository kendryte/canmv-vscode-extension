#!/bin/bash
# CI auto-version: generates version string for package.json
# Format: <tag-or-branch>-<7-char-commit>[-dirty]
# Examples: v0.1.0-abc1234, main-abc1234-dirty
BASE=$(git describe --tags --abbrev=0 2>/dev/null || git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short=7 HEAD)
DIRTY=$(git diff --quiet 2>/dev/null || echo "-dirty")
echo "${BASE}-${COMMIT}${DIRTY}"
