#!/usr/bin/env bash
#
# Nexus CLI/FM installer for Ubuntu (Raspberry Pi 5 / ARM64)
#
#   ./install.sh                 interactive
#   ./install.sh --yes           accept defaults
#   ./install.sh --no-bun        use Node.js instead of Bun
#   ./install.sh --no-shell      do not modify ~/.bashrc
#   ./install.sh --prefix DIR    install prefix (default /usr/local)
#   ./install.sh --prebuilt FILE install an already-built standalone binary
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PREFIX="/usr/local"
ASSUME_YES=0
NO_BUN=0
NO_SHELL=0
PREBUILT=""

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { printf "${GREEN}OK   ${NC}%s\n" "$*"; }
warn() { printf "${YELLOW}WARN ${NC}%s\n" "$*"; }
fail() { printf "${RED}FAIL ${NC}%s\n" "$*"; exit 1; }
info() { printf "${CYAN}==> ${NC}%s\n" "$*"; }
ask_yes() {
  local prompt="$1"
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  printf "%s [y/N] " "$prompt"
  local answer
  read -r answer || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-bun) NO_BUN=1 ;;
    --no-shell) NO_SHELL=1 ;;
    --prefix) shift; [ "$#" -gt 0 ] || fail "--prefix requires a directory"; PREFIX="$1" ;;
    --prebuilt) shift; [ "$#" -gt 0 ] || fail "--prebuilt requires a binary path"; PREBUILT="$1" ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

[ -n "$PREFIX" ] || fail "Empty install prefix"
if [ -n "$PREBUILT" ]; then
  [ -f "$PREBUILT" ] || fail "Prebuilt binary not found: $PREBUILT"
  [ -x "$PREBUILT" ] || fail "Prebuilt binary is not executable: $PREBUILT"
fi
info "Nexus CLI/FM installer"
echo "    Project: $ROOT"
echo "    Prefix:  $PREFIX"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) BUN_TARGET="bun-linux-arm64" ;;
  x86_64|amd64)  BUN_TARGET="bun-linux-x64" ;;
  *) BUN_TARGET="" ;;
esac
if [ -z "$BUN_TARGET" ]; then
  warn "Unsupported architecture: $ARCH (standalone Bun build may not work)."
fi
ok "Architecture: $ARCH"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if [ -w "$PREFIX" ] || [ -w "$(dirname "$PREFIX")" ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    fail "sudo is required to install to $PREFIX (or choose a writable --prefix)"
  fi
fi

if [ -n "$PREBUILT" ]; then
  info "Prebuilt binary supplied; skipping build prerequisites"
elif command -v apt-get >/dev/null 2>&1; then
  info "Installing system prerequisites"
  $SUDO apt-get update -qq >/dev/null 2>&1 || warn "apt update failed; continuing"
  $SUDO apt-get install -y -qq curl ca-certificates unzip build-essential file less nano util-linux >/dev/null 2>&1 || warn "Some packages could not be installed"
  ok "System prerequisites checked"
else
  warn "apt-get not found. Install curl, unzip and file manually if needed."
fi

BUN_BIN=""
if [ -z "$PREBUILT" ] && [ "$NO_BUN" -eq 0 ]; then
  BUN_BIN="$(command -v bun 2>/dev/null || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
    BUN_BIN="$HOME/.bun/bin/bun"
  fi
  if [ -z "$BUN_BIN" ]; then
    if ask_yes "Bun is not installed. Install Bun for the fastest standalone build?"; then
      info "Installing Bun"
      if curl -fsSL https://bun.sh/install | bash >/tmp/nexus-bun-install.log 2>&1; then
        export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
        export PATH="$BUN_INSTALL/bin:$PATH"
        BUN_BIN="$BUN_INSTALL/bin/bun"
        ok "Bun installed"
      else
        warn "Bun installation failed; see /tmp/nexus-bun-install.log"
      fi
    fi
  fi
fi

install_shell_integration() {
  [ "$NO_SHELL" -eq 1 ] && return 0
  local bashrc="$HOME/.bashrc"
  local cfgdir="${XDG_CONFIG_HOME:-$HOME/.config}/nexus-cli"
  local script="$cfgdir/shell-integration.sh"
  mkdir -p "$cfgdir"
  cat > "$script" <<'EOS'
# >>> nexus-cli shell integration >>>
# Managed by install.sh. The wrapper keeps your shell's current directory in
# sync with the directory you leave Nexus in.
nexus() {
    command "@NEXUS_BIN@" "$@"
    local __nexus_status=$?
    if [ "$#" -eq 0 ] && [ -t 0 ] && [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/nexus-cli/last-cwd" ]; then
        local __nexus_dir
        __nexus_dir="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/nexus-cli/last-cwd" 2>/dev/null || true)"
        if [ -n "$__nexus_dir" ] && [ -d "$__nexus_dir" ]; then
            cd "$__nexus_dir" || true
        fi
    fi
    return "$__nexus_status"
}
# <<< nexus-cli shell integration <<<
EOS
  sed -i "s|@NEXUS_BIN@|$PREFIX/bin/nexus|g" "$script"
  chmod 0644 "$script"
  if [ ! -f "$bashrc" ]; then
    warn "$bashrc not found; shell integration not installed"
    return 0
  fi
  if grep -q 'nexus-cli initialize' "$bashrc" 2>/dev/null; then
    ok "Shell integration already present in ~/.bashrc"
  else
    if ask_yes "Add Nexus shell integration to ~/.bashrc? (recommended)"; then
      cp "$bashrc" "$bashrc.nexus.bak" 2>/dev/null || true
      {
        printf '\n# >>> nexus-cli initialize >>>\n'
        printf '[ -f "%s" ] && source "%s"\n' "$script" "$script"
        printf '# <<< nexus-cli initialize <<<\n'
      } >> "$bashrc"
      ok "Shell integration added to ~/.bashrc"
      info "Run 'source ~/.bashrc' or open a new terminal to activate it."
    else
      warn "Skipped ~/.bashrc integration"
    fi
  fi
}

BUN_BIN="${BUN_BIN:-}"
BUN_OK=0
if [ -n "$PREBUILT" ]; then
  info "Installing prebuilt binary"
  if "$PREBUILT" --version >/dev/null 2>&1; then
    $SUDO install -d "$PREFIX/bin"
    $SUDO install -m 0755 "$PREBUILT" "$PREFIX/bin/nexus"
    "$PREFIX/bin/nexus" --version >/dev/null || fail "Installed binary smoke test failed"
    ok "Installed $PREFIX/bin/nexus (prebuilt)"
    BUN_OK=1
  else
    fail "Prebuilt binary smoke test failed: $PREBUILT"
  fi
fi
if [ "$BUN_OK" -eq 0 ] && [ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] && [ -n "$BUN_TARGET" ]; then
  info "Building standalone binary with Bun"
  if ( cd "$ROOT" && "$BUN_BIN" build src/index.ts --compile --target="$BUN_TARGET" --outfile "$ROOT/nexus" ); then
    chmod +x "$ROOT/nexus"
    if "$ROOT/nexus" --version >/dev/null; then
      $SUDO install -d "$PREFIX/bin"
      $SUDO install -m 0755 "$ROOT/nexus" "$PREFIX/bin/nexus"
      ok "Installed $PREFIX/bin/nexus"
      BUN_OK=1
    else
      warn "Bun binary smoke test failed; falling back to Node."
    fi
  else
    warn "Bun build failed; falling back to Node."
  fi
fi
if [ "$BUN_OK" -eq 0 ] && [ -z "$PREBUILT" ]; then
  info "Falling back to Node.js build"
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    fail "Node.js 20+ and npm are required for the fallback build. Install Bun or Node.js and retry."
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ is required (found $(node --version 2>/dev/null || echo unknown))."
  ( cd "$ROOT" && npm install --no-audit --no-fund && npm run build )
  $SUDO install -d "$PREFIX/bin" "$PREFIX/lib/nexus-cli"
  $SUDO rm -rf "$PREFIX/lib/nexus-cli/dist"
  $SUDO cp -R "$ROOT/dist" "$PREFIX/lib/nexus-cli/dist"
  $SUDO cp "$ROOT/package.json" "$PREFIX/lib/nexus-cli/package.json"
  TMP_WRAPPER="$(mktemp)"
  cat > "$TMP_WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$PREFIX/lib/nexus-cli/dist/index.js" "\$@"
EOF
  chmod +x "$TMP_WRAPPER"
  $SUDO install -m 0755 "$TMP_WRAPPER" "$PREFIX/bin/nexus"
  rm -f "$TMP_WRAPPER"
  "$PREFIX/bin/nexus" --version >/dev/null || fail "Installed wrapper smoke test failed"
  ok "Installed $PREFIX/bin/nexus (Node runtime)"
fi

install_shell_integration

cat <<EOF

$(printf "${GREEN}Nexus CLI/FM is installed.${NC}")

  Run:       $PREFIX/bin/nexus
  Version:   $PREFIX/bin/nexus --version
  Help:      $PREFIX/bin/nexus --help
  Config:    ${XDG_CONFIG_HOME:-$HOME/.config}/nexus-cli/config.json

The interface needs a real TTY. It starts in the current directory, sources
~/.bashrc, ~/.bash_aliases and ~/.bash_functions, and keeps the file manager
and bash prompt in sync. Press F1 inside Nexus for the full key reference.

EOF
