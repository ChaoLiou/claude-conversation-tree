#!/usr/bin/env bash
#
# Start a Chrome instance on Windows that this project can drive from WSL.
#
# Chrome 136 and later ignore --remote-debugging-port for the default profile.
# That is a security measure. So this script uses a separate profile folder.
# Your everyday Chrome is never touched, and its windows are never affected.
#
# You sign in to claude.ai once inside this profile. The profile keeps the
# session, so every later run needs no sign in.
#
# Usage:
#   tools/dev-chrome.sh                 start it, open claude.ai
#   tools/dev-chrome.sh <url>           start it, open that url
#   CDP_PORT=9333 tools/dev-chrome.sh   use another debug port
#   tools/dev-chrome.sh --stop          close this Chrome instance
#
set -euo pipefail

PORT="${CDP_PORT:-9222}"
CHROME_EXE="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE_LEAF='.claude-tree-dev\chrome-profile'
START_URL="${1:-https://claude.ai/new}"

note() { printf '%s\n' "$*" >&2; }

if [ ! -f "$CHROME_EXE" ]; then
  note "ERROR: Chrome is not at: $CHROME_EXE"
  note "Edit CHROME_EXE in this script to the right path."
  exit 1
fi

if [ "${1:-}" = "--stop" ]; then
  note "closing the Chrome instance that uses the dev profile"
  powershell.exe -NoProfile -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*claude-tree-dev*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
    >/dev/null 2>&1 || true
  note "done"
  exit 0
fi

# Already running? Then do nothing, so that a second call is harmless.
if curl -s --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  note "the debug port ${PORT} already answers; Chrome is up"
  curl -s "http://127.0.0.1:${PORT}/json/version"
  echo
  exit 0
fi

USERPROFILE_WIN="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
if [ -z "$USERPROFILE_WIN" ]; then
  note "ERROR: could not read USERPROFILE from Windows"
  exit 1
fi
PROFILE_WIN="${USERPROFILE_WIN}\\${PROFILE_LEAF}"

note "profile folder : ${PROFILE_WIN}"
note "debug port     : ${PORT}"
note "start url      : ${START_URL}"

# Extra Chrome flags, for example --load-extension=<windows path>.
EXTRA_FLAGS="${CHROME_EXTRA_FLAGS:-}"

nohup "$CHROME_EXE" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE_WIN}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --window-size=1360,960 \
  --enable-unsafe-extension-debugging \
  --silent-debugger-extension-api \
  ${EXTRA_FLAGS} \
  "${START_URL}" \
  >/dev/null 2>&1 &
disown || true

note "waiting for the debug port ..."
for _ in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    note "OK, the debug port answers:"
    curl -s "http://127.0.0.1:${PORT}/json/version"
    echo
    exit 0
  fi
  sleep 0.5
done

note "ERROR: the debug port ${PORT} never answered within 30 seconds"
exit 1
