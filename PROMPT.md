You are an expert systems engineer and TypeScript developer specializing in high-performance Terminal User Interfaces (TUIs) and Linux shell integration.

Project Location /home/jay/Documents/Scripts/AI/Opencode/Projects/DESKTOP-APPS/nexus-cli/

Your task is to build a complete, production-ready, beautiful CLI application named "Nexus" (nexus-cli) written in TypeScript. It must run natively on Linux Ubuntu 64-bit (ARM64 / aarch64) for Raspberry Pi 5.

"Nexus" is a hybrid terminal tool: it is BOTH a dual-pane visual File Manager (with previews, navigation, and shortcuts) AND an active, fully integrated command-line prompt that sources and executes the user's ~/.bashrc aliases, functions, and environment variables, synchronizing the current working directory in real time.

---

### 1. TARGET ENVIRONMENT & TECH STACK
- OS: Ubuntu 22.04 / 24.04 LTS (64-bit ARM64 / aarch64) on Raspberry Pi 5.
- Runtime: Bun (v1.1+ recommended for ARM64) OR Node.js 20+ with TypeScript. 
  *Prefer Bun for sub-15ms startup, built-in TS support, and native single-binary compilation via 'bun build --compile --target=bun-linux-arm64'.*
- Key Libraries:
  - TUI rendering: 'blessed' / 'neo-blessed' (or a robust, zero-dependency ANSI/terminal grid library like 'terminal-kit' or custom escape-sequence renderer).
  - Shell / PTY integration: 'node-pty' (compiled for arm64) or direct spawned interactive bash sub-processes `bash -i -c`.
  - Icons & UI elements: Nerd Fonts / Unicode fallback (directory icons, file type glyphs).
  - Syntax Highlighting: Minimal, fast highlighter for files (like 'highlight.js' or lightweight ANSI lexer).

---

### 2. CORE FUNCTIONAL SPECIFICATIONS

#### A. Dual-Pane TUI File Manager (Top ~75% of Screen)
- Left Pane (Explorer):
  - Interactive file list with Unicode/Nerd Font icons, filename, size, permissions (drwxr-xr-x), owner, and modification date.
  - Directory navigation (Arrow keys / Vim hjkl, Enter to enter, Backspace/u to go up, '/' to search/filter).
  - Sorting toggles (by Name, Size, Date, Type).
  - File selection / Multi-select (Space to tag).
- Right Pane (Contextual Preview & Inspector):
  - If a Text/Code file is focused: syntax-highlighted preview (lines, line numbers).
  - If Directory: summary stats (# of items, total size, disk usage).
  - If Binary/Executable: file metadata, size, MIME type, permissions, hex snippet or checksum.
- Top Header / Status bar:
  - Application title: "Nexus CLI/FM v1.0.0" | Hostname & OS | System stats (CPU Load, RAM used/total on RPi 5, Uptime).
  - Breadcrumbs: Current working directory (e.g., `root > home > pi > projects > nexus`).
- Bottom Shortcut Bar:
  - Visual keys: [F1] Help | [F2] View | [F3] Edit (nano/vim) | [F4] Copy | [F5] Move | [F6] Delete | [F7] Mkdir | [F8] Toggle Mode | [F9] Menu | [F10] Exit.

#### B. Integrated Bash Command-Line Interface (Bottom ~25% of Screen)
- Seamless Terminal Prompt:
  - A real interactive bash prompt at the bottom: `pi@rpi-ubuntu:~/projects/nexus$ _`.
  - Hotkey Toggle: Press 'Tab' or 'Ctrl+O' to seamlessly switch focus between the File Manager pane and the active CLI prompt.
  - Direct Bash Integration:
    - On startup, Nexus MUST load/source `~/.bashrc` (and `~/.bash_aliases` / `~/.bash_functions` if present) into its subprocess environment.
    - Commands run at the CLI input must support user-defined bash aliases (e.g. `ll`, `la`, `git status`), custom bash functions, and exported environment variables.
    - Run user inputs inside an interactive shell: `bash -i -c "source ~/.bashrc && cd '<current_dir>' && <command>"`, or pipe through an active pseudo-terminal (PTY) to support interactive CLI programs (like git, curl, apt, top).
- Bi-directional Directory Sync:
  - If the user types `cd /var/log` in the CLI prompt, the File Manager immediately updates its current directory to `/var/log`.
  - If the user navigates to `/etc` in the File Manager, the CLI prompt's working directory automatically changes to `/etc`.

---

### 3. LOOK & FEEL (VISUAL REQUIREMENTS)
- Modern Terminal Aesthetic: Nord or Tokyo Night color palette (deep slate/navy backgrounds, cyan highlights, green status accents, warm orange warning/file indicators).
- Box-drawing characters (└, ┌, ─, │, ┤, ├) for seamless panel borders.
- Clear indicators of which pane is currently focused (border highlight, cursor state).
- Subtle, informative footer display: "Loaded X aliases and Y functions from ~/.bashrc".

---

### 4. PROJECT STRUCTURE & CODE REQUIREMENTS
Please write the complete TypeScript project. Provide:
1. `package.json` with scripts, types, and ARM64-compatible dependencies.
2. `tsconfig.json` optimized for modern Node/Bun and ESM.
3. `src/types.ts`: Define interfaces for FileItem, Config, ShellState, PaneState.
4. `src/bash-loader.ts`: Logic to parse and safely source ~/.bashrc environment, aliases, and functions.
5. `src/file-manager.ts`: File traversal, reading metadata, sorting, filtering, generating visual tree, reading previews, handling basic operations (cp, mv, mkdir, rm).
6. `src/shell-handler.ts`: PTY / subprocess management running bash -i, executing commands, catching directory changes (`pwd`).
7. `src/tui.ts`: Screen rendering, window layouts, keyboard event handling, focusing, status bars.
8. `src/index.ts`: Application entry point, initialization, error handling, terminal resize handlers.
9. `install.sh`: A shell script specifically for Ubuntu on Raspberry Pi 5 to install prerequisites (Node/Bun, build-essential), build/compile the app into a standalone binary, place it in `/usr/local/bin/nexus`, and configure shell integration.

Ensure the code is robust, fully typed, handles empty/permission-denied folders gracefully, and is well-documented. Start generating the full codebase now.
