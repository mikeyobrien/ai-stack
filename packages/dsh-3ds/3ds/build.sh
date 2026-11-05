#!/usr/bin/env bash
# Build the 3DSX with the devkitPro toolchain, without touching the host.
set -euo pipefail
cd "$(dirname "$0")"
if command -v docker >/dev/null 2>&1; then
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/work -w /work \
    -e HOME=/tmp devkitpro/devkitarm:latest make "$@"
else
  make "$@"
fi
