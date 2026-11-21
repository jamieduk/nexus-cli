#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadBashProfile } from './bash-loader.js';
import { configDir, loadConfig, saveConfig, writeLastCwd } from './config.js';
import { FileManager } from './file-manager.js';
import { getSystemInfo } from './system-info.js';
import { ShellHandler, isInteractiveCommand } from './shell-handler.js';
import { Tui, helpLines } from './tui.js';
import type {
  BashProfile,
  Config,
  FocusTarget,
  KeyEvent,
  MenuOption,
  ModalState,
  Palette,
  PreviewState,
  ShellLine,
  ShellResult,
  ShellState,
  SortKey,
  SystemInfo,
  ViewModel,
} from './types.js';
import { VERSION } from './version.js';
import {
  clamp,
  formatDuration,
  getPalette,
  sanitizeCommandOutput,
  shellQuote,
  tildify,
} from './utils.js';

const MAX_OUTPUT_LINES = 800;
const MAX_SHELL_INPUT = 8000;
const STATUS_TIMEOUT = 4500;

interface CliOptions {
  startDir: string;
  help: boolean;
  version: boolean;
  debug: boolean;
}

function usage(): string {
  return `Nexus CLI/FM v${VERSION}

A dual-pane terminal file manager with an integrated bash prompt.

Usage:
  nexus [options]

Options:
  --cwd <path>     Start in this directory (default: current directory)
  -h, --help       Show this help
  -v, --version    Show version
  --debug          Write diagnostics to stderr

Keyboard:
  F1 Help        F2 View        F3 Edit        F4 Copy
  F5 Move        F6 Delete      F7 Mkdir       F8 Focus
  F9 Menu        F10/^Q Quit    Ctrl+O         Switch focus
  Tab            Auto-complete shell commands and paths

File manager:
  ↑/↓ or j/k move · h/← parent · l/→ open directory
  Enter open/select · Space tag · / filter · s sort · S reverse
  . hidden files · r refresh · ~ home · Backspace/u parent

Shell:
  The bottom prompt sources ~/.bashrc, ~/.bash_aliases and
  ~/.bash_functions in an interactive bash. Aliases, functions and
  exported variables work. cd changes update the file manager.
  Interactive commands take over the terminal automatically.
  Prefix a command with ! to force interactive mode.

Config:
  ${path.join(configDir(), 'config.json')}
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    startDir: process.cwd(),
    help: false,
    version: false,
    debug: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--cwd') {
      const next = argv[index + 1];
      if (!next) throw new Error('--cwd requires a path');
      options.startDir = path.resolve(next);
      index += 1;
    } else if (arg.startsWith('--cwd=')) {
      options.startDir = path.resolve(arg.slice('--cwd='.length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function executableOnPath(name: string): string | null {
  if (name.includes('/')) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function previousBoundary(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const low = value.charCodeAt(cursor - 1);
  if (low >= 0xdc00 && cursor >= 2) {
    const high = value.charCodeAt(cursor - 2);
    if (high >= 0xd800 && high <= 0xdbff) return cursor - 2;
  }
  return cursor - 1;
}

function nextBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const code = value.codePointAt(cursor) ?? 0;
  return cursor + (code > 0xffff ? 2 : 1);
}

function editLine(value: string, cursor: number, key: KeyEvent): { value: string; cursor: number; changed: boolean } {
  let nextValue = value;
  let nextCursor = cursor;
  let changed = false;
  const text = key.char ?? (key.name === 'space' ? ' ' : '');
  if ((key.name === 'char' || key.name === 'space') && text !== '') {
    nextValue = value.slice(0, cursor) + text + value.slice(cursor);
    nextCursor = cursor + text.length;
    changed = true;
  } else if (key.name === 'backspace') {
    const start = previousBoundary(value, cursor);
    if (start !== cursor) {
      nextValue = value.slice(0, start) + value.slice(cursor);
      nextCursor = start;
      changed = true;
    }
  } else if (key.name === 'delete') {
    const end = nextBoundary(value, cursor);
    if (end !== cursor) {
      nextValue = value.slice(0, cursor) + value.slice(end);
      changed = true;
    }
  } else if (key.name === 'left') {
    nextCursor = previousBoundary(value, cursor);
  } else if (key.name === 'right') {
    nextCursor = nextBoundary(value, cursor);
  } else if (key.name === 'home' || key.name === 'ctrl-a') {
    nextCursor = 0;
  } else if (key.name === 'end' || key.name === 'ctrl-e') {
    nextCursor = value.length;
  } else if (key.name === 'ctrl-u') {
    nextValue = value.slice(cursor);
    nextCursor = 0;
    changed = true;
  } else if (key.name === 'ctrl-k') {
    nextValue = value.slice(0, cursor);
    changed = true;
  } else if (key.name === 'ctrl-w') {
    let start = cursor;
    while (start > 0 && /\s/.test(value[start - 1] ?? '')) start -= 1;
    while (start > 0 && !/\s/.test(value[start - 1] ?? '')) start -= 1;
    nextValue = value.slice(0, start) + value.slice(cursor);
    nextCursor = start;
    changed = true;
  }
  if (nextValue.length > MAX_SHELL_INPUT) {
    nextValue = nextValue.slice(0, MAX_SHELL_INPUT);
    nextCursor = Math.min(nextCursor, nextValue.length);
  }
  return { value: nextValue, cursor: nextCursor, changed };
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function unescapeShellToken(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '\\' && index + 1 < value.length) {
      index += 1;
      out += value[index] ?? '';
    } else {
      out += char;
    }
  }
  return out;
}

function modalBase(kind: ModalState['kind'], title: string): ModalState {
  return {
    kind,
    title,
    message: '',
    hint: '',
    input: '',
    cursor: 0,
    danger: false,
    options: [],
    selected: 0,
    scroll: 0,
    lines: [],
  };
}

class NexusApp {
  private config: Config;
  private palette: Palette;
  private fm: FileManager;
  private shellHandler: ShellHandler;
  private tui: Tui;
  private bashProfile: BashProfile;
  private system: SystemInfo;
  private shell: ShellState;
  private focus: FocusTarget = 'files';
  private modal: ModalState | null = null;
  private modalAction: 'copy' | 'move' | 'mkdir' | 'filter' | null = null;
  private pendingConfirm: (() => void | Promise<void>) | null = null;
  private preview: PreviewState;
  private status = '';
  private statusTone: 'normal' | 'good' | 'warn' | 'bad' = 'normal';
  private statusTimer: NodeJS.Timeout | null = null;
  private previewToken = 0;
  private operationBusy = false;
  private interactiveActive = false;
  private quitting = false;
  private intervals: NodeJS.Timeout[] = [];
  private lastSystemAt = 0;
  private commandCache: string[] | null = null;
  private startDir: string;

  constructor(startDir: string, config: Config) {
    this.startDir = path.resolve(startDir);
    this.config = config;
    this.palette = getPalette(config.theme);
    this.fm = new FileManager(this.startDir, config);
    this.shellHandler = new ShellHandler();
    this.shellHandler.setTimeoutMs(config.commandTimeoutMs);
    this.bashProfile = loadBashProfile();
    this.system = getSystemInfo();
    this.preview = this.fm.preview(null, this.palette, this.config);
    this.shell = {
      cwd: this.fm.cwd,
      previousDir: this.fm.cwd,
      input: '',
      cursor: 0,
      history: [],
      historyIndex: -1,
      output: [],
      outputScroll: 0,
      running: false,
      runningCommand: '',
      spinner: 0,
      lastExitCode: null,
      lastDurationMs: null,
    };
    this.tui = new Tui(
      (key) => { void this.handleKey(key); },
      () => this.render(),
    );
  }

  start(): void {
    this.tui.start();
    this.system = getSystemInfo();
    writeLastCwd(this.shell.cwd);
    this.appendOutput([
      {
        kind: 'info',
        text: `Nexus ${VERSION} ready · ${this.bashProfile.aliases.size} aliases, ${this.bashProfile.functions.size} functions · ${tildify(this.fm.cwd)}`,
      },
    ]);
    if (this.bashProfile.errors.length > 0) {
      this.setStatus(this.bashProfile.errors[0] ?? 'Bash profile warning', 'warn', 6500);
    } else {
      this.setStatus('F1 help · Tab completes · F8 focus', 'normal', 5000);
    }
    this.updatePreview();
    this.render();
    this.intervals.push(setInterval(() => this.tick(), 200));
  }

  isInteractiveActive(): boolean {
    return this.interactiveActive;
  }

  interruptInteractive(): void {
    this.shellHandler.interruptInteractive();
  }

  shutdown(code = 0): void {
    if (this.quitting) return;
    this.quitting = true;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    if (this.interactiveActive) this.shellHandler.interruptInteractive();
    if (this.shell.running) this.shellHandler.cancel();
    try {
      this.tui.stop();
    } catch {
      // best effort
    }
    writeLastCwd(this.shell.cwd);
    process.exit(code);
  }

  private tick(): void {
    const now = Date.now();
    let dirty = false;
    if (this.shell.running) {
      this.shell.spinner = (this.shell.spinner + 1) % 10;
      dirty = true;
    }
    if (now - this.lastSystemAt > 2000) {
      this.system = getSystemInfo();
      this.lastSystemAt = now;
      dirty = true;
    }
    if (dirty) this.render();
  }

  private render(): void {
    if (this.quitting || this.tui.isSuspended()) return;
    const width = process.stdout.columns || this.tui.cols || 100;
    const height = process.stdout.rows || this.tui.rows || 30;
    const model: ViewModel = {
      width,
      height,
      cwd: this.fm.cwd,
      items: this.fm.items,
      error: this.fm.error,
      selectedIndex: this.fm.selectedIndex,
      marked: this.fm.marked,
      filter: this.fm.filter,
      sortBy: this.fm.sortBy,
      sortAsc: this.fm.sortAsc,
      showHidden: this.fm.showHidden,
      dirsFirst: this.fm.dirsFirst,
      preview: this.preview,
      focus: this.focus,
      shell: this.shell,
      system: this.system,
      bashProfile: this.bashProfile,
      modal: this.modal,
      status: this.status,
      statusTone: this.statusTone,
      palette: this.palette,
      config: this.config,
      viewerOpen: this.modal?.kind === 'viewer',
    };
    this.tui.render(model);
  }

  private setStatus(text: string, tone: 'normal' | 'good' | 'warn' | 'bad' = 'normal', timeout = STATUS_TIMEOUT): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.status = text.replace(/[\r\n\t]/g, ' ');
    this.statusTone = tone;
    if (timeout > 0) {
      this.statusTimer = setTimeout(() => {
        this.status = '';
        this.statusTone = 'normal';
        this.statusTimer = null;
        this.render();
      }, timeout);
    }
    this.render();
  }

  private appendOutput(lines: ShellLine[]): void {
    this.shell.output.push(...lines);
    if (this.shell.output.length > MAX_OUTPUT_LINES) {
      this.shell.output.splice(0, this.shell.output.length - MAX_OUTPUT_LINES);
    }
    this.shell.outputScroll = 0;
  }

  private updatePreview(): void {
    const token = ++this.previewToken;
    const item = this.fm.selected;
    const base = this.fm.error !== '' && item === null
      ? {
          kind: 'permission' as const,
          title: 'Unreadable directory',
          subtitle: this.fm.error,
          lines: [this.fm.error],
          meta: [],
          hex: [],
          language: 'text',
          scroll: 0,
          loading: false,
          truncated: false,
          error: this.fm.error,
        }
      : this.fm.preview(item, this.palette, this.config);
    this.preview = base;
    this.render();
    if (!item || !item.isDir || base.kind !== 'directory') return;
    void this.fm.enrichPreview(item, base).then((next) => {
      if (token !== this.previewToken) return;
      if (this.fm.selected?.path !== item.path) return;
      this.preview = next;
      this.render();
    }).catch(() => {
      // Preview enrichment is best-effort.
    });
  }

  private reloadBashProfile(): void {
    this.bashProfile = loadBashProfile();
    this.commandCache = null;
    this.setStatus(
      `Reloaded ${this.bashProfile.aliases.size} aliases and ${this.bashProfile.functions.size} functions.`,
      'good',
    );
  }

  private changeCwd(target: string): boolean {
    let isDir = false;
    try {
      isDir = fs.statSync(target).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      this.setStatus(`Not a directory: ${tildify(target)}`, 'bad');
      return false;
    }
    const old = this.shell.cwd;
    if (path.resolve(target) === path.resolve(old)) {
      this.updatePreview();
      return true;
    }
    this.shell.previousDir = old;
    this.shell.cwd = path.resolve(target);
    writeLastCwd(this.shell.cwd);
    const fmOk = this.fm.setCwd(this.shell.cwd);
    this.updatePreview();
    this.render();
    if (!fmOk || this.fm.error !== '') {
      this.setStatus(`Cannot read ${tildify(this.shell.cwd)}: ${this.fm.error || 'permission denied'}`, 'warn', 5000);
    }
    return true;
  }

  private toggleFocus(): void {
    this.focus = this.focus === 'files' ? 'shell' : 'files';
    this.setStatus(this.focus === 'shell' ? 'Shell focused · type a command' : 'File manager focused', 'normal', 1800);
    this.render();
  }

  private openHelp(): void {
    const modal = modalBase('help', 'Help · keyboard & shell integration');
    modal.lines = helpLines();
    modal.hint = '↑/↓ scroll · Esc close';
    this.modal = modal;
    this.render();
  }

  private openViewer(): void {
    const item = this.fm.selected;
    if (!item) {
      this.setStatus('Nothing selected.', 'warn');
      return;
    }
    if (item.isDir) {
      this.setStatus('Select a file to view (F2). Directories are browsed in the left pane.', 'warn');
      return;
    }
    const viewer = this.fm.viewer(item, this.palette, this.config);
    if (viewer.lines.length === 0) {
      this.setStatus('This file has no text preview.', 'warn');
      return;
    }
    const modal = modalBase('viewer', `View · ${item.name}`);
    modal.lines = viewer.lines;
    modal.hint = '↑/↓ scroll · PgUp/PgDn page · Esc close';
    if (viewer.truncated) modal.lines.push('… file truncated for the viewer');
    this.modal = modal;
    this.render();
  }

  private openMenu(): void {
    const options: MenuOption[] = [
      { label: `Sort by name${this.fm.sortBy === 'name' ? (this.fm.sortAsc ? ' ↑' : ' ↓') : ''}`, value: 'sort-name', description: 'A → Z or Z → A' },
      { label: `Sort by size${this.fm.sortBy === 'size' ? (this.fm.sortAsc ? ' ↑' : ' ↓') : ''}`, value: 'sort-size', description: 'Smallest or largest first' },
      { label: `Sort by date${this.fm.sortBy === 'date' ? (this.fm.sortAsc ? ' ↑' : ' ↓') : ''}`, value: 'sort-date', description: 'Oldest or newest first' },
      { label: `Sort by type${this.fm.sortBy === 'type' ? (this.fm.sortAsc ? ' ↑' : ' ↓') : ''}`, value: 'sort-type', description: 'Group by extension' },
      { label: `${this.fm.sortAsc ? 'Reverse sort direction' : 'Restore ascending sort'}`, value: 'sort-direction' },
      { label: `Show hidden files: ${this.fm.showHidden ? 'on' : 'off'}`, value: 'hidden' },
      { label: `Directories first: ${this.fm.dirsFirst ? 'on' : 'off'}`, value: 'dirs-first' },
      { label: `Nerd Font icons: ${this.config.nerdFonts ? 'on' : 'off'}`, value: 'nerd' },
      { label: `Theme: ${this.config.theme}`, value: 'theme', description: 'Cycle Tokyo Night / Nord / Mono' },
      { label: `Confirm delete: ${this.config.confirmDelete ? 'on' : 'off'}`, value: 'confirm-delete' },
      { label: 'Refresh directory', value: 'refresh' },
      { label: 'Reload bash profile', value: 'reload-bash' },
      { label: 'Help', value: 'help' },
      { label: 'About Nexus', value: 'about' },
      { label: 'Quit Nexus', value: 'quit', danger: true },
    ];
    const modal = modalBase('menu', 'Actions');
    modal.options = options;
    modal.hint = '↑/↓ select · Enter run · Esc close';
    this.modal = modal;
    this.render();
  }

  private openAbout(): void {
    const modal = modalBase('message', `About Nexus ${VERSION}`);
    modal.message = [
      'A dual-pane terminal file manager with a real integrated bash prompt.',
      '',
      `Host: ${this.system.hostname} · ${this.system.os}`,
      `Kernel: ${this.system.kernel}`,
      `CPU: ${this.system.cpuModel}`,
      `Shell: ${this.system.shell}`,
      `Config: ${path.join(configDir(), 'config.json')}`,
      '',
      'Bash integration sources ~/.bashrc, ~/.bash_aliases and ~/.bash_functions.',
      'Interactive programs take over the terminal and return when they exit.',
      '',
      'Press F1 for the full keyboard reference.',
    ].join('\n');
    modal.hint = 'Enter or Esc to close';
    this.modal = modal;
    this.render();
  }

  private closeModal(): void {
    this.modal = null;
    this.modalAction = null;
    this.pendingConfirm = null;
    this.render();
  }

  private openInput(action: 'copy' | 'move' | 'mkdir' | 'filter'): void {
    const modal = modalBase('input', action === 'copy' ? 'Copy items' : action === 'move' ? 'Move items' : action === 'mkdir' ? 'New directory' : 'Filter directory');
    if (action === 'copy' || action === 'move') {
      const items = this.fm.actionItems();
      if (items.length === 0) {
        this.setStatus('Select a file or tag items first.', 'warn');
        return;
      }
      modal.message = `${action === 'copy' ? 'Copy' : 'Move'} ${items.length} item${items.length === 1 ? '' : 's'} from ${tildify(this.fm.cwd)}.`;
      modal.input = this.fm.cwd + path.sep;
      modal.cursor = modal.input.length;
      modal.hint = 'Destination path (absolute or relative) · Enter confirm · Esc cancel';
    } else if (action === 'mkdir') {
      modal.message = `Create a directory inside ${tildify(this.fm.cwd)}.`;
      modal.hint = 'Directory name · Enter create · Esc cancel';
    } else {
      modal.message = 'Show only entries whose names match this text.';
      modal.input = this.fm.filter;
      modal.cursor = modal.input.length;
      modal.hint = 'Filter · Enter apply · Esc cancel';
    }
    this.modal = modal;
    this.modalAction = action;
    this.render();
  }

  private requestDelete(): void {
    const items = this.fm.actionItems();
    if (items.length === 0) {
      this.setStatus('Select a file or tag items first.', 'warn');
      return;
    }
    if (!this.config.confirmDelete) {
      void this.performDelete();
      return;
    }
    const modal = modalBase('confirm', 'Delete items');
    modal.message = `Delete ${items.length} item${items.length === 1 ? '' : 's'}? This cannot be undone.`;
    modal.hint = 'Press y to delete · n or Esc to cancel';
    modal.danger = true;
    this.pendingConfirm = () => this.performDelete();
    this.modal = modal;
    this.render();
  }

  private async performDelete(): Promise<void> {
    if (this.operationBusy) return;
    this.operationBusy = true;
    this.setStatus('Deleting…', 'warn', 0);
    let message = 'Delete failed.';
    let ok = false;
    try {
      const result = await this.fm.deleteMarked();
      message = result.message;
      ok = result.ok;
    } catch (error) {
      message = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.operationBusy = false;
      this.updatePreview();
      this.setStatus(message, ok ? 'good' : 'bad', ok ? 3500 : 7000);
      this.render();
    }
  }

  private async applyModalInput(action: 'copy' | 'move' | 'mkdir' | 'filter', value: string): Promise<void> {
    if (action === 'filter') {
      this.fm.setFilter(value);
      this.setStatus(value === '' ? 'Filter cleared.' : `Filter: ${value}`, 'normal', 3000);
      this.updatePreview();
      this.render();
      return;
    }
    if (this.operationBusy) {
      this.setStatus('A file operation is already running.', 'warn');
      return;
    }
    this.operationBusy = true;
    this.setStatus(action === 'copy' ? 'Copying…' : action === 'move' ? 'Moving…' : 'Creating directory…', 'warn', 0);
    this.render();
    let message = 'Operation failed.';
    let ok = false;
    try {
      const result = action === 'copy'
        ? await this.fm.copyTo(value)
        : action === 'move'
          ? await this.fm.moveTo(value)
          : await this.fm.makeDirectory(value);
      message = result.message;
      ok = result.ok;
    } catch (error) {
      message = `Operation failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.operationBusy = false;
      this.updatePreview();
      this.setStatus(message, ok ? 'good' : 'bad', ok ? 3500 : 8000);
      this.render();
    }
  }

  private async editSelected(): Promise<void> {
    const item = this.fm.selected;
    if (!item) {
      this.setStatus('Nothing selected.', 'warn');
      return;
    }
    if (item.isDir) {
      this.setStatus('Directories cannot be edited; press Enter to open it.', 'warn');
      return;
    }
    let editor = this.config.editor.trim();
    if (editor === '') {
      editor = process.env.VISUAL || process.env.EDITOR || '';
    }
    if (editor === '') {
      editor = executableOnPath('nano') ? 'nano' : executableOnPath('vi') ? 'vi' : '';
    }
    const editorName = editor.split(/\s+/)[0] ?? '';
    if (editor === '' || executableOnPath(editorName) === null) {
      this.setStatus('No editor found. Set editor in ~/.config/nexus-cli/config.json or $EDITOR.', 'bad', 7000);
      return;
    }
    this.setStatus(`Opening ${editorName}…`, 'warn', 0);
    this.tui.suspend();
    const code = await new Promise<number>((resolve) => {
      const child = spawn('bash', ['-c', `${editor} ${shellQuote(item.path)}`], {
        cwd: this.fm.cwd,
        stdio: 'inherit',
        env: { ...process.env, NEXUS_CLI: '1' },
      });
      child.on('error', () => resolve(1));
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
    this.tui.resume();
    this.fm.refresh();
    this.updatePreview();
    this.setStatus(code === 0 ? `Closed ${editorName}.` : `${editorName} exited with code ${code}.`, code === 0 ? 'good' : 'warn', 3000);
    this.render();
  }

  private handleMenu(value: string): void {
    switch (value) {
      case 'sort-name':
      case 'sort-size':
      case 'sort-date':
      case 'sort-type': {
        const key = value.slice(5) as SortKey;
        if (this.fm.sortBy === key) this.fm.sortAsc = !this.fm.sortAsc;
        else {
          this.fm.sortBy = key;
          this.fm.sortAsc = true;
        }
        this.fm.refresh();
        this.config.sortBy = this.fm.sortBy;
        this.config.sortAsc = this.fm.sortAsc;
        saveConfig(this.config);
        this.setStatus(`Sorted by ${key} ${this.fm.sortAsc ? 'ascending' : 'descending'}.`, 'good', 2500);
        this.updatePreview();
        break;
      }
      case 'sort-direction':
        this.fm.sortAsc = !this.fm.sortAsc;
        this.fm.refresh();
        this.config.sortAsc = this.fm.sortAsc;
        saveConfig(this.config);
        this.setStatus(this.fm.sortAsc ? 'Ascending sort.' : 'Descending sort.', 'good', 2200);
        this.updatePreview();
        break;
      case 'hidden':
        this.fm.showHidden = !this.fm.showHidden;
        this.config.showHidden = this.fm.showHidden;
        this.fm.refresh();
        saveConfig(this.config);
        this.setStatus(this.fm.showHidden ? 'Hidden files shown.' : 'Hidden files hidden.', 'good', 2200);
        this.updatePreview();
        break;
      case 'dirs-first':
        this.fm.dirsFirst = !this.fm.dirsFirst;
        this.config.dirsFirst = this.fm.dirsFirst;
        this.fm.refresh();
        saveConfig(this.config);
        this.setStatus(this.fm.dirsFirst ? 'Directories first.' : 'Mixed sort order.', 'good', 2200);
        this.updatePreview();
        break;
      case 'nerd':
        this.config.nerdFonts = !this.config.nerdFonts;
        this.fm.updateConfig(this.config);
        this.fm.refresh();
        saveConfig(this.config);
        this.setStatus(this.config.nerdFonts ? 'Nerd Font icons enabled.' : 'Unicode fallback icons enabled.', 'good', 2500);
        this.render();
        break;
      case 'theme': {
        const order: Config['theme'][] = ['tokyo-night', 'nord', 'mono'];
        const next = order[(order.indexOf(this.config.theme) + 1) % order.length] ?? 'tokyo-night';
        this.config.theme = next;
        this.palette = getPalette(next);
        this.fm.updateConfig(this.config);
        saveConfig(this.config);
        this.setStatus(`Theme: ${next}.`, 'good', 2500);
        this.updatePreview();
        break;
      }
      case 'confirm-delete':
        this.config.confirmDelete = !this.config.confirmDelete;
        saveConfig(this.config);
        this.setStatus(this.config.confirmDelete ? 'Delete confirmation enabled.' : 'Delete confirmation disabled.', 'warn', 3000);
        this.render();
        break;
      case 'refresh':
        this.fm.refresh();
        this.updatePreview();
        this.setStatus('Directory refreshed.', 'good', 2200);
        break;
      case 'reload-bash':
        this.reloadBashProfile();
        break;
      case 'help':
        this.openHelp();
        break;
      case 'about':
        this.openAbout();
        break;
      case 'quit':
        this.shutdown(0);
        break;
      default:
        this.setStatus(`Unknown action: ${value}`, 'bad');
        break;
    }
  }

  private async handleModalKey(key: KeyEvent): Promise<void> {
    const modal = this.modal;
    if (!modal) return;
    if (key.name === 'escape' || key.name === 'ctrl-c') {
      this.closeModal();
      return;
    }
    if (modal.kind === 'help' || modal.kind === 'viewer') {
      const page = Math.max(3, (process.stdout.rows || 24) - 8);
      if (key.name === 'up') modal.scroll = clamp(modal.scroll - 1, 0, Math.max(0, modal.lines.length - 1));
      else if (key.name === 'down') modal.scroll = clamp(modal.scroll + 1, 0, Math.max(0, modal.lines.length - 1));
      else if (key.name === 'pageup') modal.scroll = clamp(modal.scroll - page, 0, Math.max(0, modal.lines.length - 1));
      else if (key.name === 'pagedown') modal.scroll = clamp(modal.scroll + page, 0, Math.max(0, modal.lines.length - 1));
      else if (key.name === 'home' || key.name === 'ctrl-a') modal.scroll = 0;
      else if (key.name === 'end' || key.name === 'ctrl-e') modal.scroll = Math.max(0, modal.lines.length - 1);
      else if (key.name === 'char' && key.char === 'q') this.closeModal();
      else if (key.name === 'f1') this.closeModal();
      this.render();
      return;
    }
    if (modal.kind === 'menu') {
      if (key.name === 'up') modal.selected = clamp(modal.selected - 1, 0, Math.max(0, modal.options.length - 1));
      else if (key.name === 'down') modal.selected = clamp(modal.selected + 1, 0, Math.max(0, modal.options.length - 1));
      else if (key.name === 'home') modal.selected = 0;
      else if (key.name === 'end') modal.selected = Math.max(0, modal.options.length - 1);
      else if (key.name === 'enter') {
        const option = modal.options[modal.selected];
        this.closeModal();
        if (option) this.handleMenu(option.value);
        return;
      } else if (key.name === 'char' && key.char === 'q') {
        this.closeModal();
        return;
      }
      this.render();
      return;
    }
    if (modal.kind === 'input') {
      if (key.name === 'enter') {
        const action = this.modalAction;
        const value = modal.input;
        this.closeModal();
        if (action) await this.applyModalInput(action, value);
        return;
      }
      const edited = editLine(modal.input, modal.cursor, key);
      if (edited.changed || edited.cursor !== modal.cursor) {
        modal.input = edited.value;
        modal.cursor = edited.cursor;
        this.render();
      }
      return;
    }
    if (modal.kind === 'confirm') {
      if (key.name === 'char' && (key.char === 'y' || key.char === 'Y')) {
        const action = this.pendingConfirm;
        this.closeModal();
        if (action) await action();
        return;
      }
      if ((key.name === 'char' && (key.char === 'n' || key.char === 'N')) || key.name === 'enter') {
        this.closeModal();
        return;
      }
      return;
    }
    if (modal.kind === 'message') {
      if (key.name === 'enter' || (key.name === 'char' && key.char === 'q')) this.closeModal();
      return;
    }
  }

  private async handleShellKey(key: KeyEvent): Promise<void> {
    if (this.shell.running) {
      if (key.name === 'ctrl-c') {
        this.shellHandler.cancel();
        this.setStatus('Sending interrupt…', 'warn', 2500);
      } else if (key.name === 'pageup') {
        this.shell.outputScroll = clamp(this.shell.outputScroll + 6, 0, this.shell.output.length);
        this.render();
      } else if (key.name === 'pagedown') {
        this.shell.outputScroll = clamp(this.shell.outputScroll - 6, 0, this.shell.output.length);
        this.render();
      } else if (key.name === 'home') {
        this.shell.outputScroll = this.shell.output.length;
        this.render();
      } else if (key.name === 'end') {
        this.shell.outputScroll = 0;
        this.render();
      }
      return;
    }

    if (key.name === 'enter') {
      await this.executeCommand();
      return;
    }
    if (key.name === 'up' || key.name === 'down') {
      if (this.shell.history.length === 0) return;
      if (key.name === 'up') {
        this.shell.historyIndex = this.shell.historyIndex < 0
          ? this.shell.history.length - 1
          : Math.max(0, this.shell.historyIndex - 1);
      } else if (this.shell.historyIndex >= 0) {
        this.shell.historyIndex += 1;
        if (this.shell.historyIndex >= this.shell.history.length) this.shell.historyIndex = -1;
      }
      this.shell.input = this.shell.historyIndex >= 0 ? (this.shell.history[this.shell.historyIndex] ?? '') : '';
      this.shell.cursor = this.shell.input.length;
      this.render();
      return;
    }
    if (key.name === 'tab') {
      this.completeShell();
      return;
    }
    if (key.name === 'ctrl-l') {
      this.shell.output = [];
      this.shell.outputScroll = 0;
      this.setStatus('Shell output cleared.', 'normal', 1800);
      this.render();
      return;
    }
    if (key.name === 'ctrl-c') {
      if (this.shell.input !== '') {
        this.shell.input = '';
        this.shell.cursor = 0;
        this.shell.historyIndex = -1;
        this.render();
      } else {
        this.setStatus('Type a command, or F8/Ctrl+O to return to files.', 'normal', 2500);
      }
      return;
    }
    if (key.name === 'pageup') {
      this.shell.outputScroll = clamp(this.shell.outputScroll + 6, 0, this.shell.output.length);
      this.render();
      return;
    }
    if (key.name === 'pagedown') {
      this.shell.outputScroll = clamp(this.shell.outputScroll - 6, 0, this.shell.output.length);
      this.render();
      return;
    }
    if (key.name === 'escape') {
      this.shell.input = '';
      this.shell.cursor = 0;
      this.shell.historyIndex = -1;
      this.render();
      return;
    }
    const edited = editLine(this.shell.input, this.shell.cursor, key);
    if (edited.changed || edited.cursor !== this.shell.cursor) {
      this.shell.input = edited.value;
      this.shell.cursor = edited.cursor;
      this.shell.historyIndex = -1;
      this.render();
    }
  }

  private parseCd(command: string): { target: string | null; error?: string } | null {
    const match = /^cd(?:\s+(.+))?$/.exec(command);
    if (!match) return null;
    let argument = (match[1] ?? '').trim();
    if (/[;&|]/.test(argument)) return null;
    if (argument.includes('$') || argument.includes('`')) return null;
    if (argument.startsWith('-') && argument !== '-') return null;
    if (this.bashProfile.aliases.has('cd') || this.bashProfile.functions.has('cd')) return null;
    if (argument === '') return { target: os.homedir() };
    if (argument === '-') return { target: this.shell.previousDir };
    if ((argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'"))) {
      argument = argument.slice(1, -1);
    }
    if (argument === '~') return { target: os.homedir() };
    if (argument.startsWith('~/')) return { target: path.join(os.homedir(), argument.slice(2)) };
    return { target: path.resolve(this.shell.cwd, argument) };
  }


  private commandNames(): string[] {
    if (this.commandCache !== null) return this.commandCache;
    const names = new Set<string>([
      'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'compgen', 'complete',
      'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit',
      'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill',
      'let', 'local', 'logout', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readonly',
      'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap',
      'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
      'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
      'esac', 'function', 'select', 'in', 'time', 'coproc', '[[', ']]',
    ]);
    for (const name of this.bashProfile.aliases.keys()) names.add(name);
    for (const name of this.bashProfile.functions) names.add(name);
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir === '') continue;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(full);
            if (stat.isFile() && (stat.mode & 0o111) !== 0) names.add(entry.name);
          } catch {
            // broken symlink or unreadable entry
          }
        }
      } catch {
        // missing or unreadable PATH entry
      }
    }
    this.commandCache = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return this.commandCache;
  }

  private escapeCompletion(value: string, command: boolean): string {
    if (command) return value;
    let out = '';
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index] ?? '';
      if (/[\s'"\\$`!&;|<>()*?\[\]#{}]/.test(char)) {
        out += '\\' + char;
      } else {
        out += char;
      }
    }
    return out;
  }

  private completionMatches(prefix: string, commandPosition: boolean, directoryOnly: boolean): { matches: string[]; command: boolean } {
    const pathLike = prefix.includes('/') || prefix.startsWith('~') || prefix.startsWith('./') || prefix.startsWith('../');
    if (commandPosition && !pathLike) {
      const matches = this.commandNames().filter((name) => name.startsWith(prefix));
      return { matches, command: true };
    }

    const slash = prefix.lastIndexOf('/');
    const bareTilde = prefix === '~';
    const dirPrefix = bareTilde ? '~/' : slash >= 0 ? prefix.slice(0, slash + 1) : '';
    const base = bareTilde ? '' : slash >= 0 ? prefix.slice(slash + 1) : prefix;
    const lookupRaw = dirPrefix === '' ? '' : dirPrefix;
    const lookupDir = lookupRaw === ''
      ? this.shell.cwd
      : lookupRaw === '~'
        ? os.homedir()
        : lookupRaw.startsWith('~/')
          ? path.join(os.homedir(), lookupRaw.slice(2))
          : path.resolve(this.shell.cwd, lookupRaw);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(lookupDir, { withFileTypes: true });
    } catch {
      return { matches: [], command: false };
    }
    const includeHidden = base.startsWith('.');
    const names: string[] = [];
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (/[\x00-\x1f\x7f]/.test(entry.name)) continue;
      if (!entry.name.startsWith(base)) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(lookupDir, entry.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (directoryOnly && !isDir) continue;
      names.push(dirPrefix + entry.name + (isDir ? '/' : ''));
    }
    if (includeHidden || base === '') {
      if ('.'.startsWith(base) && !names.some((name) => name === dirPrefix + './')) names.push(dirPrefix + './');
      if ('..'.startsWith(base) && !names.some((name) => name === dirPrefix + '../')) names.push(dirPrefix + '../');
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return { matches: names, command: false };
  }

  private completeShell(): void {
    const value = this.shell.input;
    const cursor = clamp(this.shell.cursor, 0, value.length);
    let start = cursor;
    while (start > 0) {
      const previous = value[start - 1] ?? '';
      if (/\s/.test(previous) && !isEscapedAt(value, start - 1)) break;
      start -= 1;
    }
    const rawPrefix = value.slice(start, cursor);
    const prefix = unescapeShellToken(rawPrefix);
    const before = value.slice(0, start);
    const commandPosition = before.trim() === ''
      || /(?:^|\s)(?:sudo|doas|env|command|exec|time|nice|nohup|builtin)\s*$/.test(before);
    const words = before.trim().split(/\s+/).filter(Boolean);
    let wordIndex = 0;
    const wrappers = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'time', 'nice', 'nohup', 'builtin']);
    while (wordIndex < words.length && (wrappers.has(words[wordIndex] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[wordIndex] ?? ''))) wordIndex += 1;
    const directoryOnly = ['cd', 'pushd', 'rmdir'].includes(words[wordIndex] ?? '');
    const { matches, command } = this.completionMatches(prefix, commandPosition, directoryOnly);
    if (matches.length === 0) {
      this.setStatus('No completions.', 'warn', 1800);
      return;
    }

    const escaped = matches.map((match) => this.escapeCompletion(match, command));
    const apply = (replacement: string, addSpace: boolean): void => {
      const suffix = addSpace ? ' ' : '';
      const next = value.slice(0, start) + replacement + suffix + value.slice(cursor);
      this.shell.input = next;
      this.shell.cursor = start + replacement.length + suffix.length;
      this.shell.historyIndex = -1;
      this.render();
    };

    if (escaped.length === 1) {
      const only = escaped[0] ?? '';
      apply(only, !only.endsWith('/'));
      return;
    }

    const common = escaped.reduce((acc, item) => {
      let index = 0;
      while (index < acc.length && index < item.length && acc[index] === item[index]) index += 1;
      return acc.slice(0, index);
    });
    if (common.length > rawPrefix.length && common !== rawPrefix) {
      apply(common, false);
      return;
    }

    this.appendOutput([{ kind: 'info', text: '  ' + escaped.slice(0, 120).join('  ') + (escaped.length > 120 ? ' …' : '') }]);
    this.setStatus(`${escaped.length} completions`, 'normal', 3000);
  }

  private async executeCommand(): Promise<void> {
    if (this.shell.running) return;
    const raw = this.shell.input.trim();
    if (raw === '') return;

    this.shell.history = this.shell.history.filter((entry) => entry !== raw);
    this.shell.history.push(raw);
    const maxHistory = Math.max(10, this.config.historySize);
    if (this.shell.history.length > maxHistory) {
      this.shell.history.splice(0, this.shell.history.length - maxHistory);
    }
    this.shell.historyIndex = -1;
    this.shell.input = '';
    this.shell.cursor = 0;
    this.shell.outputScroll = 0;

    if (/^(exit|logout)(?:\s+\d+)?$/.test(raw)) {
      this.shutdown(0);
      return;
    }
    if (raw === 'clear' || raw === 'reset') {
      this.shell.output = [];
      this.setStatus('Shell output cleared.', 'normal', 1800);
      this.render();
      return;
    }

    this.appendOutput([{ kind: 'command', text: raw }]);
    this.shell.running = true;
    this.shell.runningCommand = raw;
    this.shell.spinner = 0;
    this.shell.lastExitCode = null;
    this.render();

    const cd = this.parseCd(raw);
    if (cd !== null) {
      this.shell.running = false;
      this.shell.lastExitCode = 0;
      this.shell.lastDurationMs = 0;
      if (cd.error !== undefined) {
        this.appendOutput([{ kind: 'error', text: cd.error }]);
        this.setStatus(cd.error, 'bad');
      } else if (cd.target) {
        const previous = this.shell.cwd;
        if (this.changeCwd(cd.target)) {
          this.appendOutput([{ kind: 'info', text: `→ ${tildify(this.shell.cwd)}` }]);
          this.setStatus(`Directory changed to ${tildify(this.shell.cwd)}.`, 'good', 2500);
        } else {
          this.appendOutput([{ kind: 'error', text: `cd: not a directory: ${cd.target}` }]);
          this.setStatus(`Not a directory: ${tildify(cd.target)}`, 'bad');
          this.shell.cwd = previous;
        }
      }
      this.render();
      return;
    }

    try {
      if (!fs.statSync(this.shell.cwd).isDirectory()) throw new Error('missing');
    } catch {
      this.changeCwd(os.homedir());
    }

    const forceInteractive = raw.startsWith('!');
    const command = forceInteractive ? raw.slice(1).trim() : raw;
    const interactive = forceInteractive || isInteractiveCommand(command);
    let result: ShellResult;
    if (interactive) {
      this.interactiveActive = true;
      this.tui.suspend();
      try {
        result = await this.shellHandler.runInteractive(command, this.shell.cwd);
      } finally {
        this.interactiveActive = false;
        this.tui.resume();
      }
    } else {
      result = await this.shellHandler.run(command, this.shell.cwd);
    }

    this.shell.running = false;
    this.shell.lastExitCode = result.code;
    this.shell.lastDurationMs = result.durationMs;
    this.shell.runningCommand = '';

    if (interactive && result.output.trim() !== '') {
      const message = sanitizeCommandOutput(result.output).trim();
      this.appendOutput([{ kind: result.code === 0 ? 'info' : 'error', text: message }]);
    }

    if (!interactive) {
      const output = sanitizeCommandOutput(result.output);
      if (output !== '') {
        const lines = output.split('\n');
        this.appendOutput(lines.map((text) => ({ kind: 'output' as const, text })));
      }
      if (result.cancelled) {
        this.appendOutput([{ kind: 'error', text: `Interrupted after ${formatDuration(result.durationMs)}` }]);
        this.setStatus('Command cancelled.', 'warn', 3000);
      } else if (result.code !== 0) {
        this.appendOutput([{ kind: 'error', text: `✕ exit ${result.code} · ${formatDuration(result.durationMs)}` }]);
        this.setStatus(`Command failed (exit ${result.code}).`, 'bad');
      } else if (output === '') {
        this.appendOutput([{ kind: 'info', text: `✓ done in ${formatDuration(result.durationMs)}` }]);
      }
    }

    if (result.cwd) {
      this.changeCwd(result.cwd);
    }
    if (result.cancelled) {
      this.setStatus('Command cancelled.', 'warn', 3000);
    } else if (result.code === 0) {
      this.setStatus(interactive ? 'Interactive command finished.' : `Command finished in ${formatDuration(result.durationMs)}.`, 'good', 2600);
    } else if (interactive) {
      this.appendOutput([{ kind: 'error', text: `✕ interactive command exited ${result.code}` }]);
      this.setStatus(`Interactive command exited ${result.code}.`, 'warn', 4000);
    }
    this.render();
  }

  private async handleFileKey(key: KeyEvent): Promise<void> {
    const pageSize = Math.max(3, (process.stdout.rows || 24) - 10);
    switch (key.name) {
      case 'up':
        this.fm.move(-1);
        this.updatePreview();
        break;
      case 'down':
        this.fm.move(1);
        this.updatePreview();
        break;
      case 'left':
        this.changeCwd(path.dirname(this.fm.cwd));
        break;
      case 'right':
      case 'enter': {
        const item = this.fm.selected;
        if (!item) break;
        if (item.isDir) {
          this.changeCwd(item.path);
        } else if (key.name === 'enter') {
          this.openViewer();
        }
        break;
      }
      case 'backspace':
        this.changeCwd(path.dirname(this.fm.cwd));
        break;
      case 'pageup':
        this.fm.page(-1, pageSize);
        this.updatePreview();
        break;
      case 'pagedown':
        this.fm.page(1, pageSize);
        this.updatePreview();
        break;
      case 'home':
        this.fm.selectFirst();
        this.updatePreview();
        break;
      case 'end':
        this.fm.selectLast();
        this.updatePreview();
        break;
      case 'space':
        this.fm.toggleMark();
        this.updatePreview();
        this.setStatus(`${this.fm.marked.size} item${this.fm.marked.size === 1 ? '' : 's'} tagged.`, 'normal', 1800);
        break;
      case 'escape':
        if (this.fm.filter !== '') {
          this.fm.setFilter('');
          this.updatePreview();
          this.setStatus('Filter cleared.', 'normal', 2000);
        } else if (this.fm.marked.size > 0) {
          this.fm.clearMarks();
          this.setStatus('Tags cleared.', 'normal', 2000);
          this.render();
        }
        break;
      case 'char': {
        const char = key.char ?? '';
        if (char === 'j') {
          this.fm.move(1);
          this.updatePreview();
        } else if (char === 'k') {
          this.fm.move(-1);
          this.updatePreview();
        } else if (char === 'h') {
          this.changeCwd(path.dirname(this.fm.cwd));
        } else if (char === 'l') {
          const item = this.fm.selected;
          if (item?.isDir) this.changeCwd(item.path);
        } else if (char === 'g') {
          this.fm.selectFirst();
          this.updatePreview();
        } else if (char === 'G') {
          this.fm.selectLast();
          this.updatePreview();
        } else if (char === 'u') {
          this.changeCwd(path.dirname(this.fm.cwd));
        } else if (char === '/') {
          this.openInput('filter');
        } else if (char === 's') {
          const sort = this.fm.cycleSort();
          this.config.sortBy = this.fm.sortBy;
          this.config.sortAsc = this.fm.sortAsc;
          saveConfig(this.config);
          this.setStatus(`Sorted by ${sort} ${this.fm.sortAsc ? 'ascending' : 'descending'}.`, 'good', 2500);
          this.updatePreview();
        } else if (char === 'S') {
          this.fm.sortAsc = !this.fm.sortAsc;
          this.fm.refresh();
          this.config.sortAsc = this.fm.sortAsc;
          saveConfig(this.config);
          this.setStatus(this.fm.sortAsc ? 'Ascending sort.' : 'Descending sort.', 'good', 2200);
          this.updatePreview();
        } else if (char === '.') {
          this.fm.showHidden = !this.fm.showHidden;
          this.fm.refresh();
          this.config.showHidden = this.fm.showHidden;
          saveConfig(this.config);
          this.setStatus(this.fm.showHidden ? 'Hidden files shown.' : 'Hidden files hidden.', 'good', 2200);
          this.updatePreview();
        } else if (char === 'r') {
          this.fm.refresh();
          this.reloadBashProfile();
          this.updatePreview();
          this.setStatus('Refreshed directory and bash profile.', 'good', 2500);
        } else if (char === '~') {
          this.changeCwd(os.homedir());
        } else if (char === '?') {
          this.openHelp();
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleKey(key: KeyEvent): Promise<void> {
    if (this.quitting) return;
    if (key.name === 'f10' || key.name === 'ctrl-q') {
      this.shutdown(0);
      return;
    }
    if (this.operationBusy) {
      this.setStatus('File operation in progress…', 'warn', 1200);
      return;
    }
    if (this.modal) {
      await this.handleModalKey(key);
      return;
    }
    if (key.name === 'f1') {
      this.openHelp();
      return;
    }
    if (key.name === 'f8' || key.name === 'ctrl-o') {
      this.toggleFocus();
      return;
    }
    if (key.name === 'f9') {
      this.openMenu();
      return;
    }
    if (key.name === 'f2') {
      this.openViewer();
      return;
    }
    if (key.name === 'f3') {
      await this.editSelected();
      return;
    }
    if (key.name === 'f4') {
      this.openInput('copy');
      return;
    }
    if (key.name === 'f5') {
      this.openInput('move');
      return;
    }
    if (key.name === 'f6') {
      this.requestDelete();
      return;
    }
    if (key.name === 'f7') {
      this.openInput('mkdir');
      return;
    }
    if (this.focus === 'shell') await this.handleShellKey(key);
    else await this.handleFileKey(key);
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exit(1);
  }

  if (options.version) {
    process.stdout.write(`Nexus CLI/FM v${VERSION} (nexus-cli)\n`);
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.debug) process.env.NEXUS_DEBUG = '1';

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('Nexus requires an interactive terminal (TTY).\nRun "nexus --help" for usage.\n');
    process.exit(1);
  }

  let startDir = options.startDir;
  try {
    if (!fs.statSync(startDir).isDirectory()) startDir = process.cwd();
  } catch {
    process.stderr.write(`Cannot open start directory: ${options.startDir}\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const app = new NexusApp(startDir, config);
  const cleanup = (code: number) => {
    try {
      app.shutdown(code);
    } catch {
      process.exit(code);
    }
  };
  process.on('SIGINT', () => {
    if (app.isInteractiveActive()) {
      app.interruptInteractive();
      return;
    }
    cleanup(0);
  });
  process.on('SIGTERM', () => cleanup(0));
  process.on('SIGHUP', () => cleanup(0));
  process.on('SIGTSTP', () => {
    // Ctrl+Z belongs to the TUI or the interactive child, not to Node's default
    // job-control stop. Ignoring it here keeps the interface alive.
  });
  process.on('uncaughtException', (error) => {
    try {
      app.shutdown(1);
    } catch {
      process.stderr.write(`Nexus crashed: ${error.stack ?? error.message}\n`);
    }
  });
  process.on('unhandledRejection', (reason) => {
    if (process.env.NEXUS_DEBUG === '1') {
      process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
    }
  });

  try {
    app.start();
  } catch (error) {
    process.stderr.write(`Nexus could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    try {
      app.shutdown(1);
    } catch {
      process.exit(1);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`Nexus failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
