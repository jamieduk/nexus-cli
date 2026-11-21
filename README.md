# Nexus CLI/FM v1.0.0

https://github.com/jamieduk/nexus-cli

A production-ready terminal file manager **and** a real integrated bash prompt, written in TypeScript for Ubuntu on Raspberry Pi 5 (ARM64).

- Dual-pane layout: file explorer on the left, contextual preview/inspector on the right.
- A working bash prompt at the bottom that sources `~/.bashrc`, `~/.bash_aliases` and `~/.bash_functions`.
- Aliases, functions and exported variables work; `cd` changes stay in sync with the file manager.
- Interactive programs (`vim`, `top`, `htop`, `less`, `ssh`, `apt`, `sudo`, …) take over the terminal and return to Nexus when they exit.
- Zero runtime dependencies: a custom ANSI renderer and direct interactive `bash` integration. Standalone binaries are produced with Bun.

---

## Requirements

- Ubuntu 22.04 / 24.04 LTS (or newer) 64-bit, ARM64 / aarch64 for the Pi 5.
- A real TTY terminal (not a pipe or non-interactive CI shell).
- Either:
  - **Bun 1.1+** (recommended; used for the standalone binary), or
  - **Node.js 20+** with npm (fallback build).
- `bash` and coreutils. The installer also installs basic build and terminal helpers.
- Optional: a Nerd Font for the icon set (`nerdFonts`).

---

## Install

```bash
cd /home/jay/Documents/Scripts/AI/Opencode/Projects/DESKTOP-APPS/TS-Terminal
./install.sh
```

The installer:

1. Checks the architecture and installs basic packages (`curl`, `unzip`, `build-essential`, `file`, `less`, `nano`, `util-linux`).
2. Uses Bun if available; if not, asks to install Bun.
3. Falls back to a Node 20+ build if Bun is unavailable.
4. Builds a standalone ELF binary (`bun-linux-arm64` on the Pi) and installs it to `/usr/local/bin/nexus`.
5. Optionally installs shell integration into `~/.bashrc`.

Non-interactive:

```bash
./install.sh --yes
./install.sh --no-bun          # Node fallback
./install.sh --no-shell        # do not modify ~/.bashrc
./install.sh --prefix "$HOME/.local"
```

One-shot build + install with Bun (builds the standalone binary, smoke-tests it, then hands it to `install.sh`):

```bash
./export-ts.sh --yes
./export-ts.sh --yes --no-shell --prefix "$HOME/.local"
```

If Bun is not installed yet, `export-ts.sh` hands off to `install.sh`, which offers to install Bun and then builds the binary.

### Shell integration

The integration creates `~/.config/nexus-cli/shell-integration.sh` and sources it from `~/.bashrc`. It installs a `nexus` shell function that:

- runs `/usr/local/bin/nexus`,
- when Nexus is launched with no arguments, changes the parent shell to the directory Nexus was in when it exited.

This is why you can navigate folders inside Nexus and keep the location after quitting. `nexus --help` and `nexus --version` are not affected. The installer backs up `~/.bashrc` to `~/.bashrc.nexus.bak` before adding the source block.

To activate manually:

```bash
source ~/.bashrc
# or open a new terminal
```

---

## Run

```bash
nexus
nexus --cwd /var/log
nexus --help
nexus --version
```

The interface starts in the current working directory. `--cwd` overrides it.

> Nexus requires an interactive TTY. Running it through a pipe, a non-interactive CI job, or a file redirect fails with a clear message. Use `--help`/`--version` in scripts.

---

## Keyboard reference

### Global

| Key | Action |
|---|---|
| `F1` / `?` | Help screen |
| `F2` | Full-screen file viewer (scrollable) |
| `F3` | Edit the focused file with `$VISUAL` / `$EDITOR` / nano / vi |
| `F4` | Copy tagged items (or focused item) to a destination |
| `F5` | Move tagged items (or focused item) |
| `F6` | Delete tagged items (confirmation) |
| `F7` | Create a directory |
| `F8`, `Ctrl+O` | Switch focus between files and the shell |
| `F9` | Actions menu (sorting, hidden files, theme, Nerd Fonts, refresh, reload bash profile, about, quit) |
| `F10`, `Ctrl+Q` | Quit |

### File manager

| Key | Action |
|---|---|
| `↑`/`↓` or `k`/`j` | Move selection |
| `←`/`h` or `Backspace`/`u` | Parent directory |
| `→`/`l` | Open the highlighted directory |
| `Enter` | Open a directory, or view a file |
| `Space` | Tag/un-tag the focused item and advance (multi-select) |
| `Home`/`End` or `g`/`G` | First/last item |
| `PageUp`/`PageDown` | Page through the list |
| `/` | Filter the current directory |
| `s` | Cycle sort: name → size → date → type |
| `S` | Reverse sort direction |
| `.` | Toggle hidden files |
| `r` | Refresh the directory and reload the bash profile |
| `~` | Jump to home |
| `Esc` | Clear the filter, then clear tags |

The left pane shows icon, name, size, permissions, owner and modified time. Columns are dropped automatically when the terminal is narrow.

### Shell prompt

| Key | Action |
|---|---|
| `Enter` | Run the command |
| `↑`/`↓` | Previous/next history entry |
| `←`/`→`, `Home`/`End` | Move the cursor |
| `Backspace`, `Delete` | Edit |
| `Ctrl+A` / `Ctrl+E` | Start/end of line |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | Delete before cursor / after cursor / previous word |
| `Ctrl+C` | Cancel the running command (or clear the current line) |
| `Ctrl+L` | Clear the shell output pane |
| `PageUp`/`PageDown` | Scroll the shell output |
| `Tab` | Auto-complete the current command or path |
| `Ctrl+O`, `F8` | Return to the file manager |

Tab completion uses the shell's current directory, your aliases and functions, executables from `$PATH`, and file/directory names. Multiple matches show a common prefix first, then a list in the output pane.

Commands are executed through an interactive bash:

```bash
bash --norc -i -c '<source ~/.bashrc, ~/.bash_aliases, ~/.bash_functions; cd $NEXUS_CWD; eval "$NEXUS_COMMAND">'
```

The shell startup output is suppressed, so aliases and functions load without banner noise. The real command is passed through an environment variable, so quoting is preserved.

`cd` is handled as a fast path in Nexus when there is no custom `cd` alias/function:

- `cd` → home
- `cd -` → previous directory
- `cd ~/projects` → expanded home path
- `cd ../logs` → relative to the current directory

`cd` inside compound commands (`cd /tmp && ls`) is executed by bash and the new `$PWD` is read back from a temporary file.

### Interactive programs

Commands such as `vim`, `nano`, `top`, `htop`, `less`, `man`, `ssh`, `apt`, `sudo`, `git rebase -i`, `docker run -it`, REPLs and similar are detected automatically. Nexus releases the terminal (leaves the alternate screen, restores cursor/input), runs the command on the inherited PTY, then re-enters the TUI and refreshes. Ctrl+C is forwarded to the interactive process tree while it runs.

Prefix any command with `!` to force interactive mode even when detection is unsure:

```bash
!my-interactive-tool --setup
```

While an interactive command is running, the terminal belongs to that program. Its output is not copied into the shell pane.

---

## Preview and inspector

The right pane adapts to the focused item:

- **Text / source files** — syntax-highlighted preview with line numbers. The highlighter covers Markdown, JSON, JavaScript/TypeScript, Python, shell, C-family, Go, Rust, HTML, CSS, YAML/TOML, SQL and diffs.
- **Directories** — item count, permissions, owner, modified time, filesystem free space, and total size calculated asynchronously with `du -sb`.
- **Binary / executable files** — MIME type, size, permissions, a SHA-256 checksum (first MiB for large files) and a hex snippet.
- **Symlinks** — the link target is shown in the metadata.
- **Permission errors** — a clear error is shown instead of crashing.

`F2` opens a larger viewer with scrolling (`↑/↓`, `PageUp/PageDown`, `Home`/`End`). `F3` opens the configured editor in a real terminal and restores the TUI when it exits.

Files are never executed by the previewer. The hex/checksum routines only read file bytes.

---

## Configuration

Configuration lives at:

```text
~/.config/nexus-cli/config.json
```

It is created/updated when you change sorting, hidden files, theme, Nerd Fonts or delete confirmation. A full example:

```json
{
  "theme": "tokyo-night",
  "nerdFonts": false,
  "showHidden": false,
  "dirsFirst": true,
  "sortBy": "name",
  "sortAsc": true,
  "editor": "",
  "pager": "",
  "previewLines": 120,
  "maxPreviewBytes": 262144,
  "commandTimeoutMs": 0,
  "historySize": 200,
  "confirmDelete": true,
  "mouse": false
}
```

| Key | Meaning |
|---|---|
| `theme` | `tokyo-night`, `nord` or `mono` |
| `nerdFonts` | Use Nerd Font glyphs (set `NEXUS_NERD_FONTS=1` to force on first run) |
| `editor` | Editor command; empty uses `$VISUAL`, `$EDITOR`, `nano`, then `vi` |
| `pager` | Reserved for external pager integration |
| `previewLines` | Lines shown in the right-pane preview |
| `maxPreviewBytes` | Bytes read for the right-pane preview |
| `commandTimeoutMs` | 0 = no timeout; otherwise kills long non-interactive commands |
| `historySize` | Shell history entries kept |
| `confirmDelete` | Show the y/n confirmation for deletes |
| `mouse` | Reserved for future mouse support |

The actions menu (`F9`) can change theme, icons, sorting, hidden files, directory-first ordering, delete confirmation and reload the bash profile.

Extra environment variables:

```bash
NEXUS_DEBUG=1          # diagnostics on stderr
NEXUS_NERD_FONTS=1     # enable Nerd Font icons initially
```

---

## Build from source

### Bun (standalone binary)

```bash
bun build src/index.ts --compile --target=bun-linux-arm64 --outfile nexus
./nexus --version
```

On x86_64 use `--target=bun-linux-x64`.

### Node.js (development / fallback)

```bash
npm install
npm run build
npm start
# or
node dist/index.js
```

`npm run typecheck` runs the TypeScript compiler without emitting. `./export-ts.sh` builds a Bun standalone binary and then runs `./install.sh --prebuilt` so build, smoke test, installation and shell integration happen in one command.

The code targets ES2022 ESM with NodeNext resolution. All imports use `.js` specifiers, which both `tsc` and Bun resolve correctly.

---

## Project layout

```text
src/
  index.ts          application controller: key handling, operations, shell execution
  tui.ts            custom ANSI renderer, layout, key decoder, modals, viewer
  types.ts          shared interfaces (FileItem, Config, ShellState, Pane/view state…)
  file-manager.ts   directory traversal, metadata, sorting, previews, cp/mv/rm/mkdir
  shell-handler.ts  interactive bash execution, terminal handoff, cwd sync, cancellation
  bash-loader.ts    safe inventory of ~/.bashrc aliases/functions/export names
  highlight.ts      lightweight syntax highlighter
  system-info.ts    CPU load, RAM, uptime, OS/hostname for the header
  utils.ts          ANSI/width/padding helpers, palette, formatting
  config.ts         JSON config and last-cwd persistence
  version.ts        version constants
install.sh          Ubuntu installer, Bun/Node build, /usr/local/bin install, shell integration
start.sh            run from the project folder
export-ts.sh        build standalone binary + launch install.sh in one step
```

---

## Troubleshooting

**“Nexus requires an interactive terminal (TTY)”**

Run it directly in a terminal. Do not pipe it, redirect stdin, or run it from a non-interactive CI step. Use `--help` or `--version` in scripts.

**“Terminal too small”**

The layout needs at least **60 × 16** characters. Maximise the terminal or reduce the font size.

**Aliases don’t work**

- Nexus sources `~/.bashrc`, `~/.bash_aliases` and `~/.bash_functions` in an interactive bash.
- Check `F1` → shell integration notes, or press `F9` → **Reload bash profile**.
- If `~/.bashrc` exits early for non-interactive shells, Nexus still forces `bash -i`; but a custom `return` at the top of your file can still interfere. Run `bash -i` manually to test.

**Some commands don’t render inside the pane**

Commands that need a TTY (editors, pagers, `top`, REPLs, interactive installers) intentionally take over the terminal. This is expected. Use `!command` to force it for tools Nexus does not auto-detect.

**Interactive command returns but the screen looks odd**

Nexus re-enters the alternate screen and redraws after the child exits. If a program leaves the terminal in a bad state, run `reset` from your normal shell, then start Nexus again.

**Nerd Font icons show as boxes**

Install a Nerd Font in your terminal and enable `nerdFonts` in the config (or press `F9` → **Nerd Font icons**). The default icon set is plain Unicode and works without special fonts.

**A directory preview stays on “calculating…”**

Directory sizes use `du -sb` with a short timeout. Very large trees or permission failures are reported as unavailable. The file list still works.

**Permission denied**

The file manager shows the error and keeps the rest of the UI usable. Use your normal shell permissions; Nexus does not elevate privileges. Commands can use `sudo` (they run interactively with a terminal).

**The shell wrapper doesn’t change my directory on exit**

- Shell integration must be enabled in `~/.bashrc` (`./install.sh --yes` or answer yes during install).
- It only changes directory when Nexus was launched with no arguments and the shell is interactive.
- Nexus writes the last directory to `~/.config/nexus-cli/last-cwd`.

**Node fallback fails**

Use Node.js 20+ and npm. The preferred build is Bun; `./install.sh --yes` installs Bun into `~/.bun` if it is missing.

---

## Notes and limitations

- Nexus parses bash files to display alias/function counts, but never `eval`s them while parsing. The actual command shell sources them normally.
- Shell variables exported during a Nexus command are scoped to that bash invocation. Exports from `~/.bashrc` are always available. Persistent interactive shell variables are not preserved between separate commands.
- The shell output pane stores a bounded log (800 lines) and strips ANSI colour codes from captured command output. Interactive command output is not captured.
- The right-pane preview is intentionally bounded; `F2` reads more (up to 2 MiB / 2000 lines) but still protects the terminal from enormous files.
- File operations are local filesystem operations and honour normal Unix permissions. Deletions are permanent; the confirmation can be turned off in the config/menu.
- Themes use 24-bit ANSI colour. Most modern terminals on Ubuntu support it.

---

## License

MIT. See [LICENSE](LICENSE).
