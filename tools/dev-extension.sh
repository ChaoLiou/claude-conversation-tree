#!/usr/bin/env bash
#
# Build the extension and put it where Chrome can read it.
#
# Chrome will not install an unpacked extension on its own any more. The
# --load-extension flag is gone, and the DevTools command
# Extensions.loadUnpacked answers with an id but registers nothing. So the
# first install is a manual step. After that, two clicks reload it.
#
# For a loop with no clicks at all, use `pnpm inject` instead. That puts the
# same bundle into the page over the DevTools protocol.
#
# Usage:
#   tools/dev-extension.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

note() { printf '%s\n' "$*" >&2; }

note "building ..."
node tools/build.mjs --target chrome >&2

USERPROFILE_WIN="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
if [ -z "$USERPROFILE_WIN" ]; then
  note "ERROR: could not read USERPROFILE from Windows"
  exit 1
fi
EXT_WIN="${USERPROFILE_WIN}\\.claude-tree-dev\\ext-chrome"
EXT_WSL="$(wslpath -u "${USERPROFILE_WIN}")/.claude-tree-dev/ext-chrome"

mkdir -p "${EXT_WSL}"
rm -f "${EXT_WSL}"/*.js "${EXT_WSL}"/*.json
cp -r dist/chrome/. "${EXT_WSL}/"

DISTRO="$(wsl.exe -l -q 2>/dev/null | head -1 | tr -d '\r\0' || echo Ubuntu)"
UNC_WIN="\\\\wsl.localhost\\${DISTRO}\\home\\${USER}\\claude-chat-extension\\dist\\chrome"

note ""
note "the build is ready in two places:"
note ""
note "  on the Windows drive   ${EXT_WIN}"
note "  straight from WSL      ${UNC_WIN}"
note ""
note "FIRST TIME ONLY"
note "  1. open chrome://extensions"
note "  2. turn on developer mode"
note "  3. press 'Load unpacked' and pick one of the folders above"
note ""
note "     Pick the WSL one, and 'pnpm build' alone updates it next time."
note "     Pick the Windows one, and run this script to copy the build over."
note ""
note "AFTER EVERY CHANGE"
note "  1. press the reload arrow on the extension card"
note "  2. reload the claude.ai tab"
note ""
note "     A page reload alone is not enough. Chrome keeps the old content"
note "     script until the extension itself reloads."
note ""
note "NOTE ON STORAGE"
note "  The installed extension keeps its trees in extension storage."
note "  'pnpm inject' keeps them in claude.ai's localStorage. They are two"
note "  different places, so a freshly installed extension starts empty."
