#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$HERE"
export ELECTRON_RUN_AS_NODE=1
APP='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
"$APP" --test test/*.test.js
