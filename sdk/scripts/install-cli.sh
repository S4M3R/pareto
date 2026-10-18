#!/bin/sh
# Builds the pareto CLI into ONE self-contained file and installs it, so `pareto` works from any folder
# and does not depend on this repo staying where it is.
#   sh sdk/scripts/install-cli.sh            installs to ~/.local/bin/pareto
#   PREFIX=/usr/local/bin sh ...             installs somewhere else
set -e
cd "$(dirname "$0")/.."
BIN="${PREFIX:-$HOME/.local/bin}"
./node_modules/.bin/esbuild src/cli.ts --bundle --platform=node --format=cjs --target=node20 --outfile=dist/pareto.cjs --log-level=warning
mkdir -p "$BIN"
cp dist/pareto.cjs "$BIN/pareto"
chmod +x "$BIN/pareto"
echo "Installed $BIN/pareto"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use it from anywhere." ;; esac
