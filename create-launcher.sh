#!/usr/bin/env bash
#
# Install a Nexus desktop launcher in the application menu and on the Desktop.
# It always launches the installed Nexus binary (the one placed by install.sh).
#
#   ./create-launcher.sh
#   ./create-launcher.sh --bin /home/jay/.local/bin/nexus
#   ./create-launcher.sh --no-desktop
#   ./create-launcher.sh --no-menu
#
# The launcher opens Nexus in a fresh terminal, so a parent CLI cannot steal
# function keys such as F9. F10 is still subject to OS/desktop shortcuts; use
# Ctrl+Q inside Nexus if the desktop eats F10.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$ROOT/nexus.desktop"
NEXUS_BIN=""
INSTALL_MENU=1
INSTALL_DESKTOP=1

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { printf "${GREEN}OK   ${NC}%s\n" "$*"; }
warn() { printf "${YELLOW}WARN ${NC}%s\n" "$*"; }
fail() { printf "${RED}FAIL ${NC}%s\n" "$*"; exit 1; }
info() { printf "${CYAN}==> ${NC}%s\n" "$*"; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin) shift; [ "$#" -gt 0 ] || fail "--bin requires a path"; NEXUS_BIN="$1" ;;
    --bin=*) NEXUS_BIN="${1#--bin=}" ;;
    --no-menu) INSTALL_MENU=0 ;;
    --no-desktop) INSTALL_DESKTOP=0 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

if [ "$INSTALL_MENU" -eq 0 ] && [ "$INSTALL_DESKTOP" -eq 0 ]; then
  fail "Nothing to do: both menu and desktop installation are disabled."
fi

# Resolve the installed binary. Do not use the source tree or a build artifact.
if [ -z "$NEXUS_BIN" ]; then
  if [ -x /usr/local/bin/nexus ]; then
    NEXUS_BIN="/usr/local/bin/nexus"
  else
    NEXUS_BIN="$(command -v nexus 2>/dev/null || true)"
  fi
fi

[ -n "$NEXUS_BIN" ] || fail "Nexus is not installed. Run ./install.sh --yes first, or pass --bin /path/to/nexus."
[ -e "$NEXUS_BIN" ] || fail "Nexus binary not found: $NEXUS_BIN"
[ -x "$NEXUS_BIN" ] || fail "Nexus binary is not executable: $NEXUS_BIN"
NEXUS_BIN="$(readlink -f "$NEXUS_BIN")"
case "$NEXUS_BIN" in
  *$'\n'*) fail "The Nexus binary path contains a newline; refusing to write a broken launcher." ;;
esac
ok "Using installed binary: $NEXUS_BIN"

if ! "$NEXUS_BIN" --version >/dev/null 2>&1; then
  warn "The binary did not answer --version; the launcher will still be created."
fi

EXEC_BIN="$NEXUS_BIN"
if printf '%s' "$NEXUS_BIN" | grep -q '[[:space:]]'; then
  EXEC_BIN="\"$NEXUS_BIN\""
fi

TMP="$(mktemp --suffix=.desktop)"
trap 'rm -f "$TMP"' EXIT

# Prefer the project template, but generate one if the script was copied alone.
if [ -f "$TEMPLATE" ]; then
  awk -v exec_bin="$EXEC_BIN" -v bin="$NEXUS_BIN" '
    /^Exec=/ { print "Exec=" exec_bin; next }
    /^TryExec=/ { print "TryExec=" bin; next }
    { print }
  ' "$TEMPLATE" > "$TMP"
else
  cat > "$TMP" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Nexus CLI/FM
GenericName=Terminal File Manager
Comment=Dual-pane terminal file manager with an integrated bash prompt
Exec=$EXEC_BIN
TryExec=$NEXUS_BIN
Icon=utilities-terminal
Terminal=true
Categories=Utility;FileTools;
Keywords=nexus;terminal;file manager;bash;command line;
StartupNotify=true
EOF
fi

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$TMP" >/dev/null 2>&1 || fail "Generated .desktop file failed validation."
  ok "Desktop file is valid"
fi

if [ "$INSTALL_MENU" -eq 1 ]; then
  APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APP_DIR"
  install -m 0755 "$TMP" "$APP_DIR/nexus.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APP_DIR" >/dev/null 2>&1 || warn "Could not update the desktop database."
  fi
  ok "Installed menu launcher: $APP_DIR/nexus.desktop"
fi

if [ "$INSTALL_DESKTOP" -eq 1 ]; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  if [ -z "$DESKTOP_DIR" ] || [ "$DESKTOP_DIR" = "/" ]; then
    DESKTOP_DIR="$HOME/Desktop"
  fi
  mkdir -p "$DESKTOP_DIR"
  install -m 0755 "$TMP" "$DESKTOP_DIR/nexus.desktop"
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/nexus.desktop" metadata::trusted true 2>/dev/null || true
  fi
  ok "Installed desktop icon: $DESKTOP_DIR/nexus.desktop"
  warn "If the icon says untrusted, right-click it and choose 'Allow Launching'."
fi

cat <<EOF

$(printf "${GREEN}Nexus launcher installed.${NC}")

Launch it from the Activities/app menu by searching for "Nexus", or use the
desktop icon. It opens Nexus in a fresh terminal and uses:

  $NEXUS_BIN

Reminder: F10 can be intercepted by the OS/desktop. Use Ctrl+Q inside Nexus to
quit; F9 is the Nexus actions menu (which also has Quit). See launcher.txt for
key-capture diagnostics and terminal-specific alternatives.

EOF
