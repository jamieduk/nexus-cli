#!/usr/bin/env node
import crypto from 'node:crypto';
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
import { parseSearchQuery, searchFiles } from './search.js';
import { Agent } from './ai/agent.js';
import { PermissionManager } from './ai/permissions.js';
import { defaultAIConfig, ensureAgentAssets, listSkills, listVaultEntries, loadAIConfig, loadWebConfig, saveAIConfig, saveWebConfig, writeVaultEntry, } from './ai/settings.js';
import { DEFAULT_MODEL } from './ai/types.js';
import { WebServer, generatePassword, hashPassword } from './web/server.js';
import { VERSION } from './version.js';
import { clamp, formatDuration, getPalette, humanBytes, sanitizeCommandOutput, shellQuote, tildify, } from './utils.js';
const MAX_OUTPUT_LINES = 800;
const MAX_SHELL_INPUT = 8000;
const STATUS_TIMEOUT = 4500;
function usage() {
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

Commands:
  /agent [prompt]   AI agent mode with files, exec, web, vault tools
  /chat [prompt]    chat mode using your personality and memory
  /search <query>   recursive file search: name:, type:, size:, content:
  /web [on|off|reset|status|port <n>]   password-protected web UI
  /ai status|setup|model|endpoint|key|image|improve|search
  /skills /permissions /vault /memory /new /exit
  Ctrl+F            search files (file pane)

Config:
  ${path.join(configDir(), 'config.json')}
  ${path.join(configDir(), 'ai.json')}
  ${path.join(configDir(), 'permissions.json')}
  ${path.join(configDir(), 'web.json')}
`;
}
function parseArgs(argv) {
    const options = {
        startDir: process.cwd(),
        help: false,
        version: false,
        debug: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined)
            continue;
        if (arg === '-h' || arg === '--help')
            options.help = true;
        else if (arg === '-v' || arg === '--version')
            options.version = true;
        else if (arg === '--debug')
            options.debug = true;
        else if (arg === '--cwd') {
            const next = argv[index + 1];
            if (!next)
                throw new Error('--cwd requires a path');
            options.startDir = path.resolve(next);
            index += 1;
        }
        else if (arg.startsWith('--cwd=')) {
            options.startDir = path.resolve(arg.slice('--cwd='.length));
        }
        else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    return options;
}
function executableOnPath(name) {
    if (name.includes('/')) {
        try {
            fs.accessSync(name, fs.constants.X_OK);
            return name;
        }
        catch {
            return null;
        }
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (dir === '')
            continue;
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
function previousBoundary(value, cursor) {
    if (cursor <= 0)
        return 0;
    const low = value.charCodeAt(cursor - 1);
    if (low >= 0xdc00 && cursor >= 2) {
        const high = value.charCodeAt(cursor - 2);
        if (high >= 0xd800 && high <= 0xdbff)
            return cursor - 2;
    }
    return cursor - 1;
}
function nextBoundary(value, cursor) {
    if (cursor >= value.length)
        return value.length;
    const code = value.codePointAt(cursor) ?? 0;
    return cursor + (code > 0xffff ? 2 : 1);
}
function editLine(value, cursor, key) {
    let nextValue = value;
    let nextCursor = cursor;
    let changed = false;
    const text = key.char ?? (key.name === 'space' ? ' ' : '');
    if ((key.name === 'char' || key.name === 'space') && text !== '') {
        nextValue = value.slice(0, cursor) + text + value.slice(cursor);
        nextCursor = cursor + text.length;
        changed = true;
    }
    else if (key.name === 'backspace') {
        const start = previousBoundary(value, cursor);
        if (start !== cursor) {
            nextValue = value.slice(0, start) + value.slice(cursor);
            nextCursor = start;
            changed = true;
        }
    }
    else if (key.name === 'delete') {
        const end = nextBoundary(value, cursor);
        if (end !== cursor) {
            nextValue = value.slice(0, cursor) + value.slice(end);
            changed = true;
        }
    }
    else if (key.name === 'left') {
        nextCursor = previousBoundary(value, cursor);
    }
    else if (key.name === 'right') {
        nextCursor = nextBoundary(value, cursor);
    }
    else if (key.name === 'home' || key.name === 'ctrl-a') {
        nextCursor = 0;
    }
    else if (key.name === 'end' || key.name === 'ctrl-e') {
        nextCursor = value.length;
    }
    else if (key.name === 'ctrl-u') {
        nextValue = value.slice(cursor);
        nextCursor = 0;
        changed = true;
    }
    else if (key.name === 'ctrl-k') {
        nextValue = value.slice(0, cursor);
        changed = true;
    }
    else if (key.name === 'ctrl-w') {
        let start = cursor;
        while (start > 0 && /\s/.test(value[start - 1] ?? ''))
            start -= 1;
        while (start > 0 && !/\s/.test(value[start - 1] ?? ''))
            start -= 1;
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
function isEscapedAt(value, index) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1)
        backslashes += 1;
    return backslashes % 2 === 1;
}
function unescapeShellToken(value) {
    let out = '';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index] ?? '';
        if (char === '\\' && index + 1 < value.length) {
            index += 1;
            out += value[index] ?? '';
        }
        else {
            out += char;
        }
    }
    return out;
}
function modalBase(kind, title) {
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
    config;
    palette;
    fm;
    shellHandler;
    tui;
    bashProfile;
    system;
    shell;
    focus = 'shell';
    modal = null;
    modalAction = null;
    pendingConfirm = null;
    preview;
    status = '';
    statusTone = 'normal';
    statusTimer = null;
    previewToken = 0;
    operationBusy = false;
    interactiveActive = false;
    quitting = false;
    intervals = [];
    lastSystemAt = 0;
    commandCache = null;
    startDir;
    ai;
    permissions;
    agent = null;
    chatAgent = null;
    webConfig = null;
    webServer = null;
    pendingInput = null;
    pendingChoice = null;
    searchResults = [];
    agentAbort = null;
    setupRunning = false;
    constructor(startDir, config) {
        this.startDir = path.resolve(startDir);
        this.config = config;
        this.palette = getPalette(config.theme);
        this.fm = new FileManager(this.startDir, config);
        this.shellHandler = new ShellHandler();
        this.shellHandler.setTimeoutMs(config.commandTimeoutMs);
        this.bashProfile = loadBashProfile();
        this.system = getSystemInfo();
        this.ai = loadAIConfig();
        this.permissions = new PermissionManager((request, options) => this.requestPermissionModal(request, options));
        this.webConfig = loadWebConfig();
        ensureAgentAssets(this.ai);
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
            mode: 'shell',
        };
        this.tui = new Tui((key) => { void this.handleKey(key); }, () => this.render());
    }
    start() {
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
        }
        else {
            this.setStatus('Shell focused · type /agent, /chat, /search or a command · F8 files', 'normal', 6000);
        }
        this.updatePreview();
        this.render();
        this.intervals.push(setInterval(() => this.tick(), 200));
        if (this.webConfig?.enabled === true) {
            void this.startWeb(false);
        }
    }
    isInteractiveActive() {
        return this.interactiveActive;
    }
    interruptInteractive() {
        this.shellHandler.interruptInteractive();
    }
    shutdown(code = 0) {
        if (this.quitting)
            return;
        this.quitting = true;
        if (this.statusTimer)
            clearTimeout(this.statusTimer);
        for (const interval of this.intervals)
            clearInterval(interval);
        this.intervals = [];
        if (this.agentAbort)
            this.agentAbort.abort();
        if (this.interactiveActive)
            this.shellHandler.interruptInteractive();
        if (this.shell.running)
            this.shellHandler.cancel();
        if (this.webServer) {
            const server = this.webServer;
            this.webServer = null;
            void server.stop();
        }
        try {
            this.tui.stop();
        }
        catch {
            // best effort
        }
        writeLastCwd(this.shell.cwd);
        process.exit(code);
    }
    tick() {
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
        if (dirty)
            this.render();
    }
    render() {
        if (this.quitting || this.tui.isSuspended())
            return;
        const width = process.stdout.columns || this.tui.cols || 100;
        const height = process.stdout.rows || this.tui.rows || 30;
        const model = {
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
    setStatus(text, tone = 'normal', timeout = STATUS_TIMEOUT) {
        if (this.statusTimer)
            clearTimeout(this.statusTimer);
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
    appendOutput(lines) {
        this.shell.output.push(...lines);
        if (this.shell.output.length > MAX_OUTPUT_LINES) {
            this.shell.output.splice(0, this.shell.output.length - MAX_OUTPUT_LINES);
        }
        this.shell.outputScroll = 0;
    }
    updatePreview() {
        const token = ++this.previewToken;
        const item = this.fm.selected;
        const base = this.fm.error !== '' && item === null
            ? {
                kind: 'permission',
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
        if (!item || !item.isDir || base.kind !== 'directory')
            return;
        void this.fm.enrichPreview(item, base).then((next) => {
            if (token !== this.previewToken)
                return;
            if (this.fm.selected?.path !== item.path)
                return;
            this.preview = next;
            this.render();
        }).catch(() => {
            // Preview enrichment is best-effort.
        });
    }
    reloadBashProfile() {
        this.bashProfile = loadBashProfile();
        this.commandCache = null;
        this.setStatus(`Reloaded ${this.bashProfile.aliases.size} aliases and ${this.bashProfile.functions.size} functions.`, 'good');
    }
    changeCwd(target) {
        let isDir = false;
        try {
            isDir = fs.statSync(target).isDirectory();
        }
        catch {
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
    toggleFocus() {
        this.focus = this.focus === 'files' ? 'shell' : 'files';
        this.setStatus(this.focus === 'shell' ? 'Shell focused · type a command' : 'File manager focused', 'normal', 1800);
        this.render();
    }
    openHelp() {
        const modal = modalBase('help', 'Help · keyboard & shell integration');
        modal.lines = helpLines();
        modal.hint = '↑/↓ scroll · Esc close';
        this.modal = modal;
        this.render();
    }
    openViewer() {
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
        if (viewer.truncated)
            modal.lines.push('… file truncated for the viewer');
        this.modal = modal;
        this.render();
    }
    openMenu() {
        const options = [
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
            { label: 'Search files… (Ctrl+F)', value: 'search', description: 'Name, type, size or content' },
            { label: 'AI agent mode', value: 'agent', description: 'Open /agent' },
            { label: 'AI chat mode', value: 'chat', description: 'Open /chat' },
            { label: 'Web UI', value: 'web', description: 'Start or inspect the browser interface' },
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
    openAbout() {
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
    closeModal() {
        this.modal = null;
        this.modalAction = null;
        this.pendingConfirm = null;
        const input = this.pendingInput;
        this.pendingInput = null;
        if (input)
            input(null);
        const choice = this.pendingChoice;
        this.pendingChoice = null;
        if (choice)
            choice(null);
        this.render();
    }
    requestInputModal(options) {
        return new Promise((resolve) => {
            const modal = modalBase('input', options.title);
            modal.message = options.message;
            modal.hint = options.hint ?? 'Enter to confirm · Esc to cancel';
            modal.input = options.defaultValue ?? '';
            modal.cursor = modal.input.length;
            modal.secret = options.secret === true;
            this.pendingInput = (value) => {
                this.pendingInput = null;
                resolve(value);
            };
            this.modal = modal;
            this.render();
        });
    }
    requestChoiceModal(title, message, options) {
        return new Promise((resolve) => {
            const modal = modalBase('menu', title);
            modal.message = message;
            modal.options = options;
            modal.hint = '↑/↓ select · Enter confirm · Esc cancel';
            this.pendingChoice = (value) => {
                this.pendingChoice = null;
                resolve(value);
            };
            this.modal = modal;
            this.render();
        });
    }
    async showMessageModal(title, message) {
        await this.requestChoiceModal(title, message, [{ label: 'OK', value: 'ok' }]);
    }
    async requestPermissionModal(request, options) {
        const value = await this.requestChoiceModal(`Permission · ${request.title}`, `${request.description}\n\nChoose "Always allow" to remember this across sessions, or deny and suggest another approach.`, options.map((option) => ({
            label: option.label,
            value: option.value,
            danger: option.value === 'deny' || option.value === 'suggest',
        })));
        if (value === 'always' || value === 'once')
            return { choice: value };
        if (value === 'suggest') {
            const reason = await this.requestInputModal({
                title: 'Suggest an alternative',
                message: 'Tell the agent what to do instead. It will see this note and adjust its approach.',
                hint: 'Enter send · Esc skip',
            });
            return { choice: 'deny', reason: reason?.trim() ?? '' };
        }
        return { choice: 'deny' };
    }
    openInput(action) {
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
        }
        else if (action === 'mkdir') {
            modal.message = `Create a directory inside ${tildify(this.fm.cwd)}.`;
            modal.hint = 'Directory name · Enter create · Esc cancel';
        }
        else {
            modal.message = 'Show only entries whose names match this text.';
            modal.input = this.fm.filter;
            modal.cursor = modal.input.length;
            modal.hint = 'Filter · Enter apply · Esc cancel';
        }
        this.modal = modal;
        this.modalAction = action;
        this.render();
    }
    requestDelete() {
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
    async performDelete() {
        if (this.operationBusy)
            return;
        this.operationBusy = true;
        this.setStatus('Deleting…', 'warn', 0);
        let message = 'Delete failed.';
        let ok = false;
        try {
            const result = await this.fm.deleteMarked();
            message = result.message;
            ok = result.ok;
        }
        catch (error) {
            message = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        finally {
            this.operationBusy = false;
            this.updatePreview();
            this.setStatus(message, ok ? 'good' : 'bad', ok ? 3500 : 7000);
            this.render();
        }
    }
    async applyModalInput(action, value) {
        if (action === 'filter') {
            const command = value.trim();
            if (command.startsWith('/') && await this.handleSlashCommand(command))
                return;
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
        }
        catch (error) {
            message = `Operation failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        finally {
            this.operationBusy = false;
            this.updatePreview();
            this.setStatus(message, ok ? 'good' : 'bad', ok ? 3500 : 8000);
            this.render();
        }
    }
    async editSelected() {
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
        const code = await new Promise((resolve) => {
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
    handleMenu(value) {
        if (value.startsWith('search:')) {
            const index = Number(value.slice('search:'.length));
            const target = this.searchResults[index];
            if (!target) {
                this.setStatus('Search result is no longer available.', 'warn', 3000);
                return;
            }
            try {
                const stat = fs.statSync(target);
                const dir = stat.isDirectory() ? target : path.dirname(target);
                if (this.changeCwd(dir) && !stat.isDirectory()) {
                    this.fm.selectPath(target);
                    this.updatePreview();
                }
                this.setStatus(`Opened ${tildify(target)}`, 'good', 3000);
            }
            catch (error) {
                this.setStatus(`Cannot open ${target}: ${error instanceof Error ? error.message : String(error)}`, 'bad', 5000);
            }
            return;
        }
        switch (value) {
            case 'sort-name':
            case 'sort-size':
            case 'sort-date':
            case 'sort-type': {
                const key = value.slice(5);
                if (this.fm.sortBy === key)
                    this.fm.sortAsc = !this.fm.sortAsc;
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
                const order = ['tokyo-night', 'nord', 'mono'];
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
            case 'search':
                void this.openSearch('');
                break;
            case 'agent':
                void this.handleSlashCommand('/agent');
                break;
            case 'chat':
                void this.handleSlashCommand('/chat');
                break;
            case 'web':
                void this.handleWebCommand('status');
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
    async handleModalKey(key) {
        const modal = this.modal;
        if (!modal)
            return;
        if (key.name === 'escape' || key.name === 'ctrl-c') {
            this.closeModal();
            return;
        }
        if (modal.kind === 'help' || modal.kind === 'viewer') {
            const page = Math.max(3, (process.stdout.rows || 24) - 8);
            if (key.name === 'up')
                modal.scroll = clamp(modal.scroll - 1, 0, Math.max(0, modal.lines.length - 1));
            else if (key.name === 'down')
                modal.scroll = clamp(modal.scroll + 1, 0, Math.max(0, modal.lines.length - 1));
            else if (key.name === 'pageup')
                modal.scroll = clamp(modal.scroll - page, 0, Math.max(0, modal.lines.length - 1));
            else if (key.name === 'pagedown')
                modal.scroll = clamp(modal.scroll + page, 0, Math.max(0, modal.lines.length - 1));
            else if (key.name === 'home' || key.name === 'ctrl-a')
                modal.scroll = 0;
            else if (key.name === 'end' || key.name === 'ctrl-e')
                modal.scroll = Math.max(0, modal.lines.length - 1);
            else if (key.name === 'char' && key.char === 'q')
                this.closeModal();
            else if (key.name === 'f1')
                this.closeModal();
            this.render();
            return;
        }
        if (modal.kind === 'menu') {
            if (key.name === 'up')
                modal.selected = clamp(modal.selected - 1, 0, Math.max(0, modal.options.length - 1));
            else if (key.name === 'down')
                modal.selected = clamp(modal.selected + 1, 0, Math.max(0, modal.options.length - 1));
            else if (key.name === 'home')
                modal.selected = 0;
            else if (key.name === 'end')
                modal.selected = Math.max(0, modal.options.length - 1);
            else if (key.name === 'enter') {
                const option = modal.options[modal.selected];
                if (this.pendingChoice) {
                    const resolver = this.pendingChoice;
                    this.pendingChoice = null;
                    this.modal = null;
                    this.modalAction = null;
                    this.render();
                    resolver(option?.value ?? null);
                    return;
                }
                this.closeModal();
                if (option)
                    this.handleMenu(option.value);
                return;
            }
            else if (key.name === 'char' && key.char === 'q') {
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
                if (this.pendingInput) {
                    const resolver = this.pendingInput;
                    this.pendingInput = null;
                    this.modal = null;
                    this.modalAction = null;
                    this.render();
                    resolver(value);
                    return;
                }
                this.closeModal();
                if (action)
                    await this.applyModalInput(action, value);
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
                if (action)
                    await action();
                return;
            }
            if ((key.name === 'char' && (key.char === 'n' || key.char === 'N')) || key.name === 'enter') {
                this.closeModal();
                return;
            }
            return;
        }
        if (modal.kind === 'message') {
            if (key.name === 'enter' || (key.name === 'char' && key.char === 'q'))
                this.closeModal();
            return;
        }
    }
    async handleShellKey(key) {
        if (this.shell.running) {
            if (key.name === 'ctrl-c') {
                if (this.agentAbort) {
                    this.agentAbort.abort();
                    this.setStatus('Cancelling agent…', 'warn', 2500);
                }
                else {
                    this.shellHandler.cancel();
                    this.setStatus('Sending interrupt…', 'warn', 2500);
                }
            }
            else if (key.name === 'pageup') {
                this.shell.outputScroll = clamp(this.shell.outputScroll + 6, 0, this.shell.output.length);
                this.render();
            }
            else if (key.name === 'pagedown') {
                this.shell.outputScroll = clamp(this.shell.outputScroll - 6, 0, this.shell.output.length);
                this.render();
            }
            else if (key.name === 'home') {
                this.shell.outputScroll = this.shell.output.length;
                this.render();
            }
            else if (key.name === 'end') {
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
            if (this.shell.history.length === 0)
                return;
            if (key.name === 'up') {
                this.shell.historyIndex = this.shell.historyIndex < 0
                    ? this.shell.history.length - 1
                    : Math.max(0, this.shell.historyIndex - 1);
            }
            else if (this.shell.historyIndex >= 0) {
                this.shell.historyIndex += 1;
                if (this.shell.historyIndex >= this.shell.history.length)
                    this.shell.historyIndex = -1;
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
            }
            else {
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
    parseCd(command) {
        const match = /^cd(?:\s+(.+))?$/.exec(command);
        if (!match)
            return null;
        let argument = (match[1] ?? '').trim();
        if (/[;&|]/.test(argument))
            return null;
        if (argument.includes('$') || argument.includes('`'))
            return null;
        if (argument.startsWith('-') && argument !== '-')
            return null;
        if (this.bashProfile.aliases.has('cd') || this.bashProfile.functions.has('cd'))
            return null;
        if (argument === '')
            return { target: os.homedir() };
        if (argument === '-')
            return { target: this.shell.previousDir };
        if ((argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'"))) {
            argument = argument.slice(1, -1);
        }
        if (argument === '~')
            return { target: os.homedir() };
        if (argument.startsWith('~/'))
            return { target: path.join(os.homedir(), argument.slice(2)) };
        return { target: path.resolve(this.shell.cwd, argument) };
    }
    commandNames() {
        if (this.commandCache !== null)
            return this.commandCache;
        const names = new Set([
            'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'compgen', 'complete',
            'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit',
            'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill',
            'let', 'local', 'logout', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readonly',
            'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap',
            'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
            'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
            'esac', 'function', 'select', 'in', 'time', 'coproc', '[[', ']]',
            '/agent', '/chat', '/search', '/find', '/web', '/ai', '/skills', '/permissions',
            '/vault', '/memory', '/new', '/exit', '/help', '/clear', '/status', '/setup',
        ]);
        for (const name of this.bashProfile.aliases.keys())
            names.add(name);
        for (const name of this.bashProfile.functions)
            names.add(name);
        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
            if (dir === '')
                continue;
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory())
                        continue;
                    const full = path.join(dir, entry.name);
                    try {
                        const stat = fs.statSync(full);
                        if (stat.isFile() && (stat.mode & 0o111) !== 0)
                            names.add(entry.name);
                    }
                    catch {
                        // broken symlink or unreadable entry
                    }
                }
            }
            catch {
                // missing or unreadable PATH entry
            }
        }
        this.commandCache = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return this.commandCache;
    }
    escapeCompletion(value, command) {
        if (command)
            return value;
        let out = '';
        for (let index = 0; index < value.length; index += 1) {
            const char = value[index] ?? '';
            if (/[\s'"\\$`!&;|<>()*?\[\]#{}]/.test(char)) {
                out += '\\' + char;
            }
            else {
                out += char;
            }
        }
        return out;
    }
    completionMatches(prefix, commandPosition, directoryOnly) {
        const pathLike = prefix.includes('/') || prefix.startsWith('~') || prefix.startsWith('./') || prefix.startsWith('../');
        if (commandPosition && prefix.startsWith('/') && !prefix.slice(1).includes('/')) {
            const matches = this.commandNames().filter((name) => name.startsWith(prefix));
            if (matches.length > 0)
                return { matches, command: true };
        }
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
        let entries = [];
        try {
            entries = fs.readdirSync(lookupDir, { withFileTypes: true });
        }
        catch {
            return { matches: [], command: false };
        }
        const includeHidden = base.startsWith('.');
        const names = [];
        for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith('.'))
                continue;
            if (/[\x00-\x1f\x7f]/.test(entry.name))
                continue;
            if (!entry.name.startsWith(base))
                continue;
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    isDir = fs.statSync(path.join(lookupDir, entry.name)).isDirectory();
                }
                catch {
                    isDir = false;
                }
            }
            if (directoryOnly && !isDir)
                continue;
            names.push(dirPrefix + entry.name + (isDir ? '/' : ''));
        }
        if (includeHidden || base === '') {
            if ('.'.startsWith(base) && !names.some((name) => name === dirPrefix + './'))
                names.push(dirPrefix + './');
            if ('..'.startsWith(base) && !names.some((name) => name === dirPrefix + '../'))
                names.push(dirPrefix + '../');
        }
        names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return { matches: names, command: false };
    }
    completeShell() {
        const value = this.shell.input;
        const cursor = clamp(this.shell.cursor, 0, value.length);
        let start = cursor;
        while (start > 0) {
            const previous = value[start - 1] ?? '';
            if (/\s/.test(previous) && !isEscapedAt(value, start - 1))
                break;
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
        while (wordIndex < words.length && (wrappers.has(words[wordIndex] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[wordIndex] ?? '')))
            wordIndex += 1;
        const directoryOnly = ['cd', 'pushd', 'rmdir'].includes(words[wordIndex] ?? '');
        const { matches, command } = this.completionMatches(prefix, commandPosition, directoryOnly);
        if (matches.length === 0) {
            this.setStatus('No completions.', 'warn', 1800);
            return;
        }
        const escaped = matches.map((match) => this.escapeCompletion(match, command));
        const apply = (replacement, addSpace) => {
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
            while (index < acc.length && index < item.length && acc[index] === item[index])
                index += 1;
            return acc.slice(0, index);
        });
        if (common.length > rawPrefix.length && common !== rawPrefix) {
            apply(common, false);
            return;
        }
        this.appendOutput([{ kind: 'info', text: '  ' + escaped.slice(0, 120).join('  ') + (escaped.length > 120 ? ' …' : '') }]);
        this.setStatus(`${escaped.length} completions`, 'normal', 3000);
    }
    async executeCommand() {
        if (this.shell.running)
            return;
        const raw = this.shell.input.trim();
        if (raw === '')
            return;
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
        if (raw.startsWith('/')) {
            const handled = await this.handleSlashCommand(raw);
            if (handled)
                return;
        }
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
        if (this.shell.mode !== 'shell') {
            await this.runAgentTurn(raw, this.shell.mode);
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
            }
            else if (cd.target) {
                const previous = this.shell.cwd;
                if (this.changeCwd(cd.target)) {
                    this.appendOutput([{ kind: 'info', text: `→ ${tildify(this.shell.cwd)}` }]);
                    this.setStatus(`Directory changed to ${tildify(this.shell.cwd)}.`, 'good', 2500);
                }
                else {
                    this.appendOutput([{ kind: 'error', text: `cd: not a directory: ${cd.target}` }]);
                    this.setStatus(`Not a directory: ${tildify(cd.target)}`, 'bad');
                    this.shell.cwd = previous;
                }
            }
            this.render();
            return;
        }
        try {
            if (!fs.statSync(this.shell.cwd).isDirectory())
                throw new Error('missing');
        }
        catch {
            this.changeCwd(os.homedir());
        }
        const forceInteractive = raw.startsWith('!');
        const command = forceInteractive ? raw.slice(1).trim() : raw;
        const interactive = forceInteractive || isInteractiveCommand(command);
        let result;
        if (interactive) {
            this.interactiveActive = true;
            this.tui.suspend();
            try {
                result = await this.shellHandler.runInteractive(command, this.shell.cwd);
            }
            finally {
                this.interactiveActive = false;
                this.tui.resume();
            }
        }
        else {
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
                this.appendOutput(lines.map((text) => ({ kind: 'output', text })));
            }
            if (result.cancelled) {
                this.appendOutput([{ kind: 'error', text: `Interrupted after ${formatDuration(result.durationMs)}` }]);
                this.setStatus('Command cancelled.', 'warn', 3000);
            }
            else if (result.code !== 0) {
                this.appendOutput([{ kind: 'error', text: `✕ exit ${result.code} · ${formatDuration(result.durationMs)}` }]);
                this.setStatus(`Command failed (exit ${result.code}).`, 'bad');
            }
            else if (output === '') {
                this.appendOutput([{ kind: 'info', text: `✓ done in ${formatDuration(result.durationMs)}` }]);
            }
        }
        if (result.cwd) {
            this.changeCwd(result.cwd);
        }
        if (result.cancelled) {
            this.setStatus('Command cancelled.', 'warn', 3000);
        }
        else if (result.code === 0) {
            this.setStatus(interactive ? 'Interactive command finished.' : `Command finished in ${formatDuration(result.durationMs)}.`, 'good', 2600);
        }
        else if (interactive) {
            this.appendOutput([{ kind: 'error', text: `✕ interactive command exited ${result.code}` }]);
            this.setStatus(`Interactive command exited ${result.code}.`, 'warn', 4000);
        }
        this.render();
    }
    getAgent() {
        if (!this.agent) {
            this.agent = new Agent({
                config: this.ai,
                permissions: this.permissions,
                cwd: this.shell.cwd,
            });
        }
        return this.agent;
    }
    getChatAgent() {
        if (!this.chatAgent) {
            this.chatAgent = new Agent({
                config: this.ai,
                permissions: this.permissions,
                cwd: this.shell.cwd,
            });
        }
        return this.chatAgent;
    }
    async ensureAIConfigured() {
        if (this.ai.initialized) {
            ensureAgentAssets(this.ai);
            return true;
        }
        return this.runAISetup(false);
    }
    async runAISetup(force) {
        if (this.setupRunning) {
            this.setStatus('AI setup is already open.', 'warn', 2000);
            return false;
        }
        this.setupRunning = true;
        const base = { ...defaultAIConfig(), ...this.ai };
        try {
            const provider = await this.requestInputModal({
                title: 'AI setup · 1/6 · Provider',
                message: 'Which LLM provider do you want to use? (for example: ollama, openai, openrouter, lm-studio)',
                defaultValue: base.provider,
            });
            if (provider === null)
                return false;
            const endpoint = await this.requestInputModal({
                title: 'AI setup · 2/6 · Endpoint',
                message: 'OpenAI-compatible API endpoint URL.\nExamples: http://localhost:11434 (Ollama), https://api.openai.com',
                defaultValue: base.baseUrl,
            });
            if (endpoint === null)
                return false;
            const model = await this.requestInputModal({
                title: 'AI setup · 3/6 · Model',
                message: `Model name for the agent and chat.\nLeave blank for the default: ${DEFAULT_MODEL}`,
                defaultValue: base.model || DEFAULT_MODEL,
            });
            if (model === null)
                return false;
            const apiKey = await this.requestInputModal({
                title: 'AI setup · 4/6 · API key',
                message: 'API key for the endpoint. Leave blank for local models that do not require one.',
                defaultValue: '',
                secret: true,
            });
            if (apiKey === null)
                return false;
            const imageModel = await this.requestInputModal({
                title: 'AI setup · 5/6 · Image model',
                message: 'Optional image generation model (for /agent image tasks).\nLeave blank to disable image generation.',
                defaultValue: base.imageModel,
            });
            if (imageModel === null)
                return false;
            const improve = await this.requestChoiceModal('AI setup · 6/6 · Self-improvement', 'Should the agent be allowed to propose and create its own skills/tools?\n\nGuided: ask you before every change (recommended).\nAuto: allow improvements automatically.\nOff: disable self-improvement.', [
                { label: 'Guided (recommended)', value: 'guided', description: 'Explain and ask before each change' },
                { label: 'Auto allow', value: 'auto', description: 'Create skills/tools without prompting' },
                { label: 'Off', value: 'off', description: 'Never self-modify' },
            ]);
            if (improve === null)
                return false;
            this.ai.provider = provider.trim() || base.provider;
            this.ai.baseUrl = endpoint.trim() || base.baseUrl;
            this.ai.model = model.trim() || DEFAULT_MODEL;
            if (apiKey.trim() !== '' || !force)
                this.ai.apiKey = apiKey.trim();
            this.ai.imageModel = imageModel.trim();
            this.ai.selfImprove = improve === 'auto' || improve === 'off' ? improve : 'guided';
            this.ai.initialized = true;
            ensureAgentAssets(this.ai);
            saveAIConfig(this.ai);
            this.agent = null;
            this.chatAgent = null;
            this.appendOutput([
                { kind: 'info', text: `AI ready · ${this.ai.provider} · ${this.ai.model}` },
                { kind: 'info', text: `Skills: ${this.ai.skillsDir} · Projects: ${this.ai.projectsDir} · Vault: ${this.ai.vaultDir}` },
            ]);
            this.setStatus('AI configured. Use /agent or /chat.', 'good', 5000);
            return true;
        }
        finally {
            this.setupRunning = false;
        }
    }
    async handleSlashCommand(raw) {
        const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(raw);
        if (!match)
            return false;
        const command = (match[1] ?? '').toLowerCase();
        const rest = (match[2] ?? '').trim();
        const known = new Set([
            'agent', 'chat', 'exit', 'quit', 'back', 'new', 'reset', 'help', 'search', 'find',
            'web', 'ai', 'model', 'image', 'skills', 'permissions', 'memory', 'vault', 'clear',
            'setup', 'status',
        ]);
        if (!known.has(command))
            return false;
        switch (command) {
            case 'agent': {
                if (!(await this.ensureAIConfigured()))
                    return true;
                if (this.shell.mode !== 'agent') {
                    this.shell.mode = 'agent';
                    this.appendOutput([{ kind: 'info', text: 'Agent mode. Describe what to do, or type /exit to return to the shell.' }]);
                    this.setStatus('Agent mode ready.', 'good', 3000);
                }
                this.focus = 'shell';
                if (rest !== '')
                    await this.runAgentTurn(rest, 'agent');
                else
                    this.render();
                return true;
            }
            case 'chat': {
                if (!(await this.ensureAIConfigured()))
                    return true;
                if (this.shell.mode !== 'chat') {
                    this.shell.mode = 'chat';
                    this.appendOutput([{ kind: 'info', text: 'Chat mode. Talk to the model; it uses your personality and memory files. /exit returns to the shell.' }]);
                    this.setStatus('Chat mode ready.', 'good', 3000);
                }
                this.focus = 'shell';
                if (rest !== '')
                    await this.runAgentTurn(rest, 'chat');
                else
                    this.render();
                return true;
            }
            case 'exit':
            case 'back':
                if (this.shell.mode !== 'shell') {
                    this.shell.mode = 'shell';
                    this.appendOutput([{ kind: 'info', text: 'Returned to shell mode.' }]);
                    this.setStatus('Shell mode.', 'normal', 2500);
                    this.render();
                    return true;
                }
                this.shutdown(0);
                return true;
            case 'quit':
                this.shutdown(0);
                return true;
            case 'new':
            case 'reset':
                if (this.shell.mode === 'chat')
                    this.chatAgent?.reset();
                else
                    this.agent?.reset();
                this.appendOutput([{ kind: 'info', text: `${this.shell.mode === 'chat' ? 'Chat' : 'Agent'} conversation cleared.` }]);
                this.setStatus('Conversation reset.', 'good', 2500);
                return true;
            case 'clear':
                this.shell.output = [];
                this.shell.outputScroll = 0;
                this.setStatus('Shell output cleared.', 'normal', 1800);
                this.render();
                return true;
            case 'help':
                this.openHelp();
                return true;
            case 'search':
            case 'find':
                await this.openSearch(rest);
                return true;
            case 'web':
                await this.handleWebCommand(rest);
                return true;
            case 'ai':
            case 'setup':
                await this.handleAICommand(command === 'setup' ? 'setup' : rest);
                return true;
            case 'model':
                await this.handleAICommand(rest === '' ? 'model' : `model ${rest}`);
                return true;
            case 'image':
                await this.handleAICommand(rest === '' ? 'image' : `image ${rest}`);
                return true;
            case 'skills':
                await this.handleAICommand('skills');
                return true;
            case 'permissions':
                this.showPermissions(rest);
                return true;
            case 'memory':
                await this.handleAICommand(rest === 'edit' ? 'memory edit' : 'memory');
                return true;
            case 'vault':
                await this.handleVaultCommand(rest);
                return true;
            case 'status': {
                const lines = [
                    `mode: ${this.shell.mode}`,
                    `cwd: ${this.shell.cwd}`,
                    `AI: ${this.ai.initialized ? `${this.ai.provider} · ${this.ai.model}` : 'not configured'}`,
                    `web: ${this.webServer ? this.webServer.address : this.webConfig?.enabled ? 'enabled (not running)' : 'off'}`,
                ];
                this.appendOutput(lines.map((text) => ({ kind: 'info', text })));
                this.render();
                return true;
            }
            default:
                return false;
        }
    }
    async runAgentTurn(prompt, mode) {
        if (this.shell.running) {
            this.setStatus('Already running. Press Ctrl+C to cancel.', 'warn', 2500);
            return;
        }
        if (!this.ai.initialized) {
            this.setStatus('Configure AI first with /agent.', 'warn', 3000);
            return;
        }
        const agent = mode === 'agent' ? this.getAgent() : this.getChatAgent();
        this.appendOutput([{ kind: 'command', text: `/${mode} ${prompt}` }]);
        this.shell.running = true;
        this.shell.runningCommand = `${mode}: ${prompt}`;
        this.shell.spinner = 0;
        this.shell.lastExitCode = null;
        this.shell.outputScroll = 0;
        const controller = new AbortController();
        this.agentAbort = controller;
        let lastAssistant = '';
        const emit = (event) => {
            if (event.kind === 'assistant') {
                lastAssistant = event.text;
                const lines = event.text.split('\n');
                this.appendOutput([
                    { kind: 'info', text: '◆ Nexus' },
                    ...lines.map((text) => ({ kind: 'agent', text })),
                    { kind: 'info', text: '' },
                ]);
                this.render();
            }
            else if (event.kind === 'tool-start') {
                this.appendOutput([{ kind: 'tool', text: `  ⚙ ${event.tool ?? 'tool'} · ${event.text}` }]);
                this.render();
            }
            else if (event.kind === 'tool-result') {
                const lines = event.text.split('\n').slice(0, 14);
                const text = lines.join('\n') + (event.text.split('\n').length > 14 ? '\n  …' : '');
                this.appendOutput([{ kind: event.ok === false ? 'agent-error' : 'tool', text: (event.ok === false ? '  ✕ ' : '  ✓ ') + text }]);
                this.render();
            }
            else if (event.kind === 'info') {
                this.appendOutput([{ kind: 'info', text: event.text }]);
                this.render();
            }
            else if (event.kind === 'error') {
                this.appendOutput([{ kind: 'agent-error', text: event.text }]);
                this.render();
            }
        };
        try {
            const reply = await agent.send(prompt, mode, {
                cwd: this.shell.cwd,
                signal: controller.signal,
                onEvent: emit,
                askUser: (question) => this.requestInputModal({
                    title: 'Agent question',
                    message: question,
                    hint: 'Answer · Enter submit · Esc skip',
                }),
            });
            if (reply !== '' && reply !== lastAssistant) {
                this.appendOutput([{ kind: 'agent', text: reply }, { kind: 'info', text: '' }]);
            }
            this.shell.lastExitCode = 0;
            this.setStatus(mode === 'agent' ? 'Agent finished.' : 'Chat reply ready.', 'good', 3000);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.shell.lastExitCode = 1;
            this.appendOutput([{ kind: 'agent-error', text: `✕ ${message}` }]);
            this.setStatus(message, 'bad', 6000);
        }
        finally {
            this.agentAbort = null;
            this.shell.running = false;
            this.shell.runningCommand = '';
            this.render();
        }
    }
    async openSearch(rawQuery) {
        let query = rawQuery.trim();
        if (query === '') {
            const answer = await this.requestInputModal({
                title: 'Search files',
                message: 'Search recursively from the current directory.\n\nExamples:\n  report                 name or content\n  name:config type:json\n  content:apiKey type:ts\n  type:pdf size:>1M\n  size:10K..2M',
                hint: 'Search query · Enter search · Esc cancel',
            });
            if (answer === null)
                return;
            query = answer.trim();
        }
        if (query === '') {
            this.setStatus('Search query was empty.', 'warn', 2500);
            return;
        }
        this.setStatus(`Searching “${query}”…`, 'warn', 0);
        try {
            const options = parseSearchQuery(query, this.fm.cwd);
            const hits = await searchFiles({ ...options, maxResults: 300, includeHidden: this.fm.showHidden });
            if (hits.length === 0) {
                this.setStatus('No matching files.', 'warn', 3500);
                return;
            }
            this.searchResults = hits.map((hit) => hit.path);
            const modal = modalBase('menu', `Search · ${hits.length} result${hits.length === 1 ? '' : 's'}`);
            modal.message = `Query: ${query}`;
            modal.options = hits.map((hit, index) => {
                const relative = path.relative(this.fm.cwd, hit.path) || hit.name;
                const where = hit.line !== undefined ? `:${hit.line}` : '';
                const snippet = hit.snippet ?? '';
                return {
                    label: `${hit.isDir ? '▸' : hit.matched === 'content' ? '◈' : '·'} ${relative}${where}`,
                    value: `search:${index}`,
                    description: `${hit.isDir ? 'directory' : humanBytes(hit.size).trim()}${snippet ? ` · ${snippet}` : ''}`,
                };
            });
            modal.hint = '↑/↓ select · Enter open · Esc close';
            this.modal = modal;
            this.setStatus(`${hits.length} result${hits.length === 1 ? '' : 's'}.`, 'good', 3000);
            this.render();
        }
        catch (error) {
            this.setStatus(`Search failed: ${error instanceof Error ? error.message : String(error)}`, 'bad', 6000);
        }
    }
    showPermissions(rest) {
        if (rest.toLowerCase() === 'reset' || rest.toLowerCase() === 'clear') {
            this.permissions.revokeAll();
            this.appendOutput([{ kind: 'info', text: 'All saved agent permissions were cleared.' }]);
            this.setStatus('Permissions cleared.', 'good', 3000);
            return;
        }
        const grants = this.permissions.list();
        if (grants.length === 0) {
            this.appendOutput([{ kind: 'info', text: 'No saved permissions. The agent will ask when it needs one.' }]);
        }
        else {
            this.appendOutput([
                { kind: 'info', text: 'Saved agent permissions (use /permissions reset to clear):' },
                ...grants.map((grant) => ({ kind: 'info', text: `  ${grant.id} · ${new Date(grant.grantedAt).toLocaleString()}` })),
            ]);
        }
        this.render();
    }
    async handleAICommand(rest) {
        const [subRaw, ...tailParts] = rest.split(/\s+/);
        const sub = (subRaw ?? '').toLowerCase();
        const value = tailParts.join(' ').trim();
        const save = () => {
            saveAIConfig(this.ai);
            this.agent = null;
            this.chatAgent = null;
        };
        switch (sub) {
            case '':
            case 'status': {
                const lines = [
                    `configured: ${this.ai.initialized ? 'yes' : 'no'}`,
                    `provider:   ${this.ai.provider}`,
                    `endpoint:   ${this.ai.baseUrl}`,
                    `model:      ${this.ai.model}`,
                    `image:      ${this.ai.imageModel || '(none)'}`,
                    `api key:    ${this.ai.apiKey ? 'set' : 'not set'}`,
                    `improve:    ${this.ai.selfImprove}`,
                    `web search: ${this.ai.webSearch ? 'on' : 'off'}`,
                    `personality:${this.ai.personalityPath}`,
                    `skills:     ${this.ai.skillsDir}`,
                    `projects:   ${this.ai.projectsDir}`,
                    `tools:      ${this.ai.toolsDir}`,
                    `memory:     ${this.ai.memoryDir}`,
                    `vault:      ${this.ai.vaultDir}`,
                ];
                this.appendOutput(lines.map((text) => ({ kind: 'info', text })));
                this.render();
                return;
            }
            case 'setup':
                await this.runAISetup(true);
                return;
            case 'model':
                if (value === '') {
                    this.setStatus(`Model: ${this.ai.model}`, 'normal', 3000);
                    return;
                }
                this.ai.model = value;
                this.ai.initialized = true;
                save();
                this.setStatus(`Model set to ${value}.`, 'good', 3000);
                return;
            case 'endpoint': {
                if (value === '') {
                    this.setStatus(`Endpoint: ${this.ai.baseUrl}`, 'normal', 3000);
                    return;
                }
                this.ai.baseUrl = value;
                this.ai.initialized = true;
                save();
                this.setStatus(`Endpoint set to ${value}.`, 'good', 3000);
                return;
            }
            case 'key': {
                const key = await this.requestInputModal({
                    title: 'AI API key',
                    message: 'Paste the API key for the configured endpoint. Leave blank to clear it.',
                    secret: true,
                    hint: 'Enter save · Esc cancel',
                });
                if (key === null)
                    return;
                this.ai.apiKey = key.trim();
                this.ai.initialized = true;
                save();
                this.setStatus(this.ai.apiKey ? 'API key saved.' : 'API key cleared.', 'good', 3000);
                return;
            }
            case 'image': {
                if (value === '') {
                    const answer = await this.requestInputModal({
                        title: 'Image model',
                        message: 'Model used when the agent generates images. Leave blank to disable.',
                        defaultValue: this.ai.imageModel,
                    });
                    if (answer === null)
                        return;
                    this.ai.imageModel = answer.trim();
                }
                else {
                    this.ai.imageModel = value;
                }
                save();
                this.setStatus(this.ai.imageModel ? `Image model: ${this.ai.imageModel}` : 'Image generation disabled.', 'good', 3000);
                return;
            }
            case 'improve': {
                if (value === 'auto' || value === 'guided' || value === 'off') {
                    this.ai.selfImprove = value;
                    save();
                    this.setStatus(`Self-improvement: ${value}.`, 'good', 3000);
                    return;
                }
                const choice = await this.requestChoiceModal('Self-improvement', 'Allow the agent to create skills, tools and personality updates?', [
                    { label: 'Guided (recommended)', value: 'guided' },
                    { label: 'Auto allow', value: 'auto' },
                    { label: 'Off', value: 'off' },
                ]);
                if (choice === null)
                    return;
                this.ai.selfImprove = choice === 'auto' || choice === 'off' ? choice : 'guided';
                save();
                this.setStatus(`Self-improvement: ${this.ai.selfImprove}.`, 'good', 3000);
                return;
            }
            case 'search':
            case 'websearch': {
                const next = value === 'on' || value === 'off' ? value : this.ai.webSearch ? 'off' : 'on';
                this.ai.webSearch = next === 'on';
                save();
                this.setStatus(`Web search ${this.ai.webSearch ? 'enabled' : 'disabled'}.`, 'good', 3000);
                return;
            }
            case 'personality':
                await this.openFileInEditor(this.ai.personalityPath);
                return;
            case 'memory':
                if (value === 'edit' || value === '') {
                    await this.openFileInEditor(this.ai.memoryPath);
                    return;
                }
                this.appendOutput([{ kind: 'info', text: `Memory directory: ${this.ai.memoryDir}` }]);
                this.render();
                return;
            case 'skills': {
                const skills = listSkills(this.ai);
                if (skills.length === 0) {
                    this.appendOutput([{ kind: 'info', text: `No skills found in ${this.ai.skillsDir}` }]);
                }
                else {
                    this.appendOutput([
                        { kind: 'info', text: `Skills in ${this.ai.skillsDir}:` },
                        ...skills.map((skill) => ({ kind: 'info', text: `  ${skill.name}${skill.custom ? ' (custom)' : ''} · ${skill.description}` })),
                    ]);
                }
                this.render();
                return;
            }
            case 'permissions':
                this.showPermissions(value);
                return;
            default:
                this.setStatus(`Unknown /ai option: ${sub}. Try status, setup, model, endpoint, key, image, improve, search, personality, memory, skills.`, 'warn', 5000);
                return;
        }
    }
    async handleVaultCommand(rest) {
        const [subRaw, ...tail] = rest.split(/\s+/);
        const sub = (subRaw ?? '').toLowerCase();
        const name = tail.join(' ').trim();
        if (sub === '' || sub === 'list') {
            const entries = listVaultEntries(this.ai);
            if (entries.length === 0)
                this.appendOutput([{ kind: 'info', text: `Vault is empty: ${this.ai.vaultDir}` }]);
            else {
                this.appendOutput([
                    { kind: 'info', text: `Vault entries in ${this.ai.vaultDir}:` },
                    ...entries.map((entry) => ({ kind: 'info', text: `  ${entry.name} · ${new Date(entry.updatedAt).toLocaleString()}` })),
                ]);
            }
            this.render();
            return;
        }
        if (sub === 'set') {
            if (name === '') {
                this.setStatus('Usage: /vault set <name>', 'warn', 3000);
                return;
            }
            const value = await this.requestInputModal({
                title: `Vault · ${name}`,
                message: 'Paste the credential or token. It is stored with 0600 permissions.',
                secret: true,
                hint: 'Enter save · Esc cancel',
            });
            if (value === null)
                return;
            const file = writeVaultEntry(this.ai, name, value.trim());
            this.appendOutput([{ kind: 'info', text: `Stored ${name} in ${file}` }]);
            this.setStatus(`Vault entry ${name} saved.`, 'good', 3000);
            return;
        }
        if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
            if (name === '') {
                this.setStatus('Usage: /vault remove <name>', 'warn', 3000);
                return;
            }
            const safe = name.replace(/[^A-Za-z0-9._-]/g, '-');
            const file = path.join(this.ai.vaultDir, `${safe}.json`);
            try {
                fs.unlinkSync(file);
                this.setStatus(`Removed vault entry ${name}.`, 'good', 3000);
            }
            catch {
                this.setStatus(`No vault entry named ${name}.`, 'warn', 3000);
            }
            return;
        }
        this.setStatus('Usage: /vault [list|set <name>|remove <name>]', 'warn', 4000);
    }
    async handleWebCommand(rest) {
        const parts = rest.split(/\s+/);
        const sub = (parts[0] ?? '').toLowerCase();
        if (sub === 'off' || sub === 'disable') {
            if (this.webConfig) {
                this.webConfig.enabled = false;
                saveWebConfig(this.webConfig);
            }
            if (this.webServer) {
                const server = this.webServer;
                this.webServer = null;
                await server.stop();
            }
            this.appendOutput([{ kind: 'info', text: 'Web UI disabled.' }]);
            this.setStatus('Web UI disabled.', 'good', 3000);
            return;
        }
        if (sub === 'status') {
            const lines = [
                `web ui: ${this.webConfig ? (this.webConfig.enabled ? 'enabled' : 'disabled') : 'not configured'}`,
                `address: ${this.webServer ? this.webServer.address : '(not running)'}`,
                `bind: ${this.webConfig ? `${this.webConfig.host}:${this.webConfig.port}` : '(none)'}`,
            ];
            this.appendOutput(lines.map((text) => ({ kind: 'info', text })));
            this.render();
            return;
        }
        if (sub === 'port') {
            const port = Number(parts[1]);
            if (!Number.isFinite(port) || port < 1 || port > 65535) {
                this.setStatus('Usage: /web port <1-65535>', 'warn', 3000);
                return;
            }
            if (!this.webConfig) {
                this.setStatus('Set a web password first with /web.', 'warn', 3000);
                return;
            }
            const wasRunning = this.webServer !== null;
            if (this.webServer) {
                const server = this.webServer;
                this.webServer = null;
                await server.stop();
            }
            this.webConfig.port = port;
            saveWebConfig(this.webConfig);
            if (wasRunning)
                await this.startWeb(true);
            this.setStatus(`Web port set to ${port}.`, 'good', 3000);
            return;
        }
        if (sub === 'reset') {
            if (!this.webConfig) {
                await this.handleWebCommand('');
                return;
            }
            const password = await this.promptWebPassword(true);
            if (password === null)
                return;
            this.webConfig.passwordHash = hashPassword(password.password, password.salt);
            this.webConfig.salt = password.salt;
            saveWebConfig(this.webConfig);
            if (this.webConfig.enabled) {
                if (this.webServer) {
                    const server = this.webServer;
                    this.webServer = null;
                    await server.stop();
                }
                await this.startWeb(true);
            }
            if (password.generated) {
                this.appendOutput([{ kind: 'info', text: `New web password: ${password.password}` }]);
                await this.showMessageModal('Save your new web UI password', `New web UI password:\n\n    ${password.password}\n\nIt is stored only as a hash and cannot be shown again.`);
            }
            this.setStatus('Web password reset.', 'good', 4000);
            return;
        }
        if (sub === 'on' || sub === '' || sub === 'start') {
            if (!this.webConfig) {
                const password = await this.promptWebPassword(false);
                if (password === null)
                    return;
                this.webConfig = {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 8787,
                    passwordHash: hashPassword(password.password, password.salt),
                    salt: password.salt,
                    createdAt: Date.now(),
                };
                saveWebConfig(this.webConfig);
                if (password.generated) {
                    this.appendOutput([
                        { kind: 'info', text: `Web UI password (save this now): ${password.password}` },
                        { kind: 'info', text: 'The password is stored only as a hash; it cannot be shown again. Use /web reset to change it.' },
                    ]);
                    await this.showMessageModal('Save your web UI password', `Web UI password:\n\n    ${password.password}\n\nIt is stored only as a hash and cannot be shown again. Use /web reset to change it.`);
                }
            }
            else {
                this.webConfig.enabled = true;
                saveWebConfig(this.webConfig);
            }
            await this.startWeb(true);
            return;
        }
        this.setStatus('Usage: /web [on|off|status|reset|port <n>]', 'warn', 4000);
    }
    async promptWebPassword(reset) {
        const answer = await this.requestInputModal({
            title: reset ? 'Reset web UI password' : 'Nexus Web UI',
            message: `${reset ? 'Enter a new password for the web UI.' : 'Set a password for the web UI.'}\nLeave blank to generate a strong password automatically.`,
            secret: true,
            hint: 'Enter confirm · Esc cancel',
        });
        if (answer === null)
            return null;
        const trimmed = answer.trim();
        if (trimmed === '') {
            return { password: generatePassword(), salt: crypto.randomBytes(16).toString('hex'), generated: true };
        }
        if (trimmed.length < 6) {
            this.setStatus('Password must be at least 6 characters.', 'warn', 3500);
            return null;
        }
        return { password: trimmed, salt: crypto.randomBytes(16).toString('hex'), generated: false };
    }
    async startWeb(announce) {
        if (!this.webConfig)
            return;
        if (this.webServer) {
            if (announce)
                this.setStatus(`Web UI already at ${this.webServer.address}`, 'normal', 4000);
            return;
        }
        const server = new WebServer({
            aiConfig: this.ai,
            webConfig: this.webConfig,
            getCwd: () => this.shell.cwd,
        });
        try {
            const url = await server.start();
            this.webServer = server;
            this.appendOutput([
                { kind: 'info', text: `Web UI listening at ${url}` },
                { kind: 'info', text: 'Open it in a browser and use the password you set. /web off disables it.' },
            ]);
            this.setStatus(`Web UI: ${url}`, 'good', 6000);
        }
        catch (error) {
            this.setStatus(`Web UI failed to start: ${error instanceof Error ? error.message : String(error)}`, 'bad', 7000);
        }
    }
    async openFileInEditor(file) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (!fs.existsSync(file))
                fs.writeFileSync(file, '', { mode: 0o600 });
        }
        catch (error) {
            this.setStatus(`Cannot create ${file}: ${error instanceof Error ? error.message : String(error)}`, 'bad', 5000);
            return;
        }
        let editor = this.config.editor.trim() || process.env.VISUAL || process.env.EDITOR || '';
        if (editor === '')
            editor = executableOnPath('nano') ? 'nano' : executableOnPath('vi') ? 'vi' : '';
        const editorName = editor.split(/\s+/)[0] ?? '';
        if (editor === '' || executableOnPath(editorName) === null) {
            this.setStatus('No editor found. Set $EDITOR or config.editor.', 'bad', 5000);
            return;
        }
        this.tui.suspend();
        const code = await new Promise((resolve) => {
            const child = spawn('bash', ['-c', `${editor} ${shellQuote(file)}`], {
                cwd: this.shell.cwd,
                stdio: 'inherit',
                env: { ...process.env, NEXUS_CLI: '1' },
            });
            child.on('error', () => resolve(1));
            child.on('close', (exitCode) => resolve(exitCode ?? 1));
        });
        this.tui.resume();
        this.agent = null;
        this.chatAgent = null;
        this.setStatus(code === 0 ? `Edited ${tildify(file)}.` : `${editorName} exited with code ${code}.`, code === 0 ? 'good' : 'warn', 3000);
        this.render();
    }
    async handleFileKey(key) {
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
                if (!item)
                    break;
                if (item.isDir) {
                    this.changeCwd(item.path);
                }
                else if (key.name === 'enter') {
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
            case 'ctrl-f':
                await this.openSearch('');
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
                }
                else if (this.fm.marked.size > 0) {
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
                }
                else if (char === 'k') {
                    this.fm.move(-1);
                    this.updatePreview();
                }
                else if (char === 'h') {
                    this.changeCwd(path.dirname(this.fm.cwd));
                }
                else if (char === 'l') {
                    const item = this.fm.selected;
                    if (item?.isDir)
                        this.changeCwd(item.path);
                }
                else if (char === 'g') {
                    this.fm.selectFirst();
                    this.updatePreview();
                }
                else if (char === 'G') {
                    this.fm.selectLast();
                    this.updatePreview();
                }
                else if (char === 'u') {
                    this.changeCwd(path.dirname(this.fm.cwd));
                }
                else if (char === '/') {
                    this.openInput('filter');
                }
                else if (char === 's') {
                    const sort = this.fm.cycleSort();
                    this.config.sortBy = this.fm.sortBy;
                    this.config.sortAsc = this.fm.sortAsc;
                    saveConfig(this.config);
                    this.setStatus(`Sorted by ${sort} ${this.fm.sortAsc ? 'ascending' : 'descending'}.`, 'good', 2500);
                    this.updatePreview();
                }
                else if (char === 'S') {
                    this.fm.sortAsc = !this.fm.sortAsc;
                    this.fm.refresh();
                    this.config.sortAsc = this.fm.sortAsc;
                    saveConfig(this.config);
                    this.setStatus(this.fm.sortAsc ? 'Ascending sort.' : 'Descending sort.', 'good', 2200);
                    this.updatePreview();
                }
                else if (char === '.') {
                    this.fm.showHidden = !this.fm.showHidden;
                    this.fm.refresh();
                    this.config.showHidden = this.fm.showHidden;
                    saveConfig(this.config);
                    this.setStatus(this.fm.showHidden ? 'Hidden files shown.' : 'Hidden files hidden.', 'good', 2200);
                    this.updatePreview();
                }
                else if (char === 'r') {
                    this.fm.refresh();
                    this.reloadBashProfile();
                    this.updatePreview();
                    this.setStatus('Refreshed directory and bash profile.', 'good', 2500);
                }
                else if (char === '~') {
                    this.changeCwd(os.homedir());
                }
                else if (char === '?') {
                    this.openHelp();
                }
                break;
            }
            default:
                break;
        }
    }
    async handleKey(key) {
        if (this.quitting)
            return;
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
        if (this.focus === 'shell')
            await this.handleShellKey(key);
        else
            await this.handleFileKey(key);
    }
}
async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    }
    catch (error) {
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
    if (options.debug)
        process.env.NEXUS_DEBUG = '1';
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
        process.stderr.write('Nexus requires an interactive terminal (TTY).\nRun "nexus --help" for usage.\n');
        process.exit(1);
    }
    let startDir = options.startDir;
    try {
        if (!fs.statSync(startDir).isDirectory())
            startDir = process.cwd();
    }
    catch {
        process.stderr.write(`Cannot open start directory: ${options.startDir}\n`);
        process.exit(1);
    }
    const config = loadConfig();
    const app = new NexusApp(startDir, config);
    const cleanup = (code) => {
        try {
            app.shutdown(code);
        }
        catch {
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
        }
        catch {
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
    }
    catch (error) {
        process.stderr.write(`Nexus could not start: ${error instanceof Error ? error.message : String(error)}\n`);
        try {
            app.shutdown(1);
        }
        catch {
            process.exit(1);
        }
    }
}
void main().catch((error) => {
    process.stderr.write(`Nexus failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
