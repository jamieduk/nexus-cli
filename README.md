# Nexus CLI/FM v1.0.1

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

To launch Nexus from the desktop (in a fresh terminal, so a parent CLI cannot steal F9), install the included launcher:

```bash
./create-launcher.sh
```

This installs it in the application menu and on the Desktop, using the binary placed by `install.sh`. Options: `--bin /path/to/nexus`, `--no-desktop`, `--no-menu`.

See `launcher.txt` for desktop-icon setup, terminal-specific Exec lines, and the F9/F10/input-capture troubleshooting notes.

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
| `F9` | Actions menu (sorting, hidden files, theme, Nerd Fonts, search, AI modes, web UI, refresh, about, quit) |
| `Ctrl+F` | Recursive file search (name, type, size or content) |
| `F10`, `Ctrl+Q` | Quit. Use `Ctrl+Q` if your desktop/window manager captures `F10`. |

### File manager

| Key | Action |
|---|---|
| `↑`/`↓` or `k`/`j` | Move selection |
| `←`/`h` or `Backspace`/`u` | Parent directory |
| `→`/`l` | Open the highlighted directory |
| `Enter` | Open a directory, or view a file |
| `Enter` on `../` | Go to the parent directory (the `../` entry is always at the top) |
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

## Search

Press `Ctrl+F` in the file pane or use `/search` from the shell. Search is recursive
from the current directory and understands field filters:

```text
report                       name or file contents
name:config type:json        name and extension
content:apiKey type:ts       text inside matching files
type:pdf size:>1M            extension and size comparison
size:10K..2M                 inclusive size range
```

Supported keys: `name:` (or `file:`), `type:` (or `ext:`), `content:`, `size:`, and
`regex:` to treat the query as a regular expression. Select a result with Enter to
jump to its directory and select the file.

The `.git`, `node_modules`, caches and similar heavy directories are skipped while
searching. Content search reads text files up to 2 MiB.

---

## AI agent and chat

Run `/agent` to enter agent mode. The first use asks for:

1. Provider name (for example `ollama`, `openai`, `openrouter`, `lm-studio`).
2. OpenAI-compatible endpoint URL (for example `http://localhost:11434`).
3. Model name (blank uses `deepseek-v4.1-flash`).
4. API key (blank is fine for local models).
5. An optional image-generation model.
6. Self-improvement policy: guided (recommended), auto, or off.

Configuration is stored in `~/.config/nexus-cli/ai.json` with mode `0600`.
Nexus sends a stable per-conversation `x-opencode-session` header (required by
OpenCode Go/Zen), a real `User-Agent`, `x-opencode-client`, `x-session-id` and
`x-client-request-id`. A new conversation via `/new` rotates the session id.

You can add provider-specific headers with `extraHeaders` in `ai.json`:

```json
{
  "extraHeaders": {
    "x-opencode-session": "ses_customstableid",
    "X-Custom-Header": "value"
  }
}
```

After setup, type an instruction directly:

```text
/agent read package.json and add a test script
/agent find every TODO under src and summarise them
/agent copy src/index.ts to src/index.ts.bak and make it executable
```

The agent runs immediately and uses real tools: read/write/edit files, copy, move,
delete, list directories, search by name/type/size/content, execute shell commands,
change permissions (including execute bits), fetch the web, ask you a clarifying
question, remember facts, generate images, and access credentials.

### Agent directories

All paths are configurable in `ai.json`:

```text
~/.config/nexus-cli/projects/      agent workspace / generated files
~/.config/nexus-cli/skills/        Markdown skills injected into the prompt
~/.config/nexus-cli/tools/         executable custom tools
~/.config/nexus-cli/memory/        long-term memory files (agent and chat)
~/.config/nexus-cli/vault/         credentials, files written with 0600 permissions
~/.config/nexus-cli/personality.md agent and chat personality
```

Add `.md` files to `skills/` to teach the agent new workflows, or let it create
skills/tools itself when self-improvement is enabled. Custom tools are callable by
the agent and receive their arguments as JSON in `NEXUS_TOOL_ARGS`.

### Permissions

Dangerous tools (write, copy, move, delete, execute, chmod, web access, vault
access, image generation, self-improvement) ask for permission the first time.
Choose **Always allow** to persist the grant in
`~/.config/nexus-cli/permissions.json`; it is never asked again. You can choose
**Deny and suggest an alternative** to tell the agent what to do instead.
`/permissions` lists grants and `/permissions reset` clears them.

### Chat

`/chat` uses the same endpoint, model, personality and memory files, but no tools.
It is useful for explanations, drafting and planning. `/new` clears the current
conversation and `/exit` returns to the shell.

---

## Web UI

Run `/web` for the first time. Nexus asks for a password (or generates a strong one
when you leave it blank). The password is stored only as a scrypt hash in
`~/.config/nexus-cli/web.json`.

Once enabled, the server starts automatically every time Nexus starts:

```text
http://127.0.0.1:8787/
```

Commands:

```text
/web                 start / enable the web UI
/web off             stop and disable it
/web reset           set a new password
/web status          show address and bind details
/web port 9000       change the port
```

The web interface is password-protected with HttpOnly SameSite session cookies,
rate-limited login attempts, strict security headers and a same-origin API. It binds
to `127.0.0.1` by default. To expose it on a LAN, edit `host` in `web.json` and put
it behind a TLS reverse proxy such as Caddy or nginx; do not expose plain HTTP.

The browser header has a **Permissions** panel for one-time tool grants. Those
grants are shared with the terminal agent and persisted in `permissions.json`.
Outside that panel the browser agent cannot show interactive approval prompts, so
grant what it needs there (or in the TUI) before asking it to modify the system.

---


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
NEXUS_AI_PROVIDER=ollama
NEXUS_AI_BASE_URL=http://localhost:11434
NEXUS_AI_MODEL=deepseek-v4.1-flash
NEXUS_AI_API_KEY=...
```

AI configuration, permissions and the web password live alongside the main config:

```text
~/.config/nexus-cli/ai.json
~/.config/nexus-cli/permissions.json
~/.config/nexus-cli/web.json
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
  index.ts          application controller: key handling, operations, slash commands, AI/web
  tui.ts            custom ANSI renderer, layout, key decoder, modals, viewer
  types.ts          shared interfaces (FileItem, Config, ShellState, Pane/view state…)
  file-manager.ts   directory traversal, metadata, sorting, previews, cp/mv/rm/mkdir
  shell-handler.ts  interactive bash execution, terminal handoff, cwd sync, cancellation
  bash-loader.ts    safe inventory of ~/.bashrc aliases/functions/export names
  highlight.ts      lightweight syntax highlighter
  system-info.ts    CPU load, RAM, uptime, OS/hostname for the header
  search.ts         recursive search by name, type, size, content and regex
  utils.ts          ANSI/width/padding helpers, palette, formatting
  config.ts         JSON config and last-cwd persistence
  version.ts        version constants
  ai/types.ts       AI config, permissions, messages and agent event types
  ai/settings.ts    ai.json, permissions, web config, skills, memory and vault paths
  ai/client.ts      OpenAI-compatible chat/image client with cancellation
  ai/tools.ts       agent tools: files, exec, chmod, web, vault, skills, images
  ai/agent.ts       tool-calling agent loop and chat sessions
  ai/permissions.ts one-time permission prompts and persistent grants
  web/server.ts     password-protected web UI, sessions, login rate limiting
install.sh          Ubuntu installer, Bun/Node build, /usr/local/bin install, shell integration
create-launcher.sh  install the .desktop launcher in the app menu and on the Desktop
nexus.desktop       ready-to-use desktop launcher template
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

**F10 does not quit / a desktop shortcut steals it**

Many desktops reserve `F10` for the application menu. Nexus always supports `Ctrl+Q` as an alternative quit key, and the footer labels it `^Q Exit`. You can also use `F9` → **Quit Nexus**. If your desktop captures `F9` too, use the desktop launcher described in `launcher.txt` to run Nexus in a dedicated terminal.

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
