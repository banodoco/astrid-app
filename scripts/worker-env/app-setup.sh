#!/usr/bin/env bash
# SETUP for an Astrid App checkout in a single-repository worker.
# Run from the checkout root. Installs the exact dependency graph from package-lock.json.
# Needs Node 20.19.x and npm on PATH. Any failure here is an ENV error, never a test result.
set -euo pipefail
trap 'status=$?; echo "ENV: setup failed (exit $status): $BASH_COMMAND" >&2; exit 3' ERR

CO=$(pwd -P)
NODE=$(command -v node) || { echo "ENV: missing tool node" >&2; exit 3; }
NPM=$(command -v npm) || { echo "ENV: missing tool npm" >&2; exit 3; }
NODE_VERSION=$("$NODE" --version) || { echo "ENV: could not read node version from $NODE" >&2; exit 3; }
if [[ ! "$NODE_VERSION" =~ ^v20\.19\.[0-9]+([+-].*)?$ ]]; then
  echo "ENV: expected Node 20.19.x first on PATH, found $NODE_VERSION ($NODE)" >&2
  exit 3
fi

test -f "$CO/package.json" -a -f "$CO/package-lock.json" || {
  echo "ENV: not an App checkout with package.json and package-lock.json: $CO" >&2
  exit 3
}

cd "$CO"
"$NPM" ci --legacy-peer-deps
