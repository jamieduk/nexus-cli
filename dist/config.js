import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DEFAULT_CONFIG = {
    theme: 'tokyo-night',
    nerdFonts: process.env.NEXUS_NERD_FONTS === '1',
    showHidden: false,
    dirsFirst: true,
    sortBy: 'name',
    sortAsc: true,
    editor: process.env.EDITOR || '',
    pager: process.env.PAGER || '',
    previewLines: 120,
    maxPreviewBytes: 256 * 1024,
    commandTimeoutMs: 0,
    historySize: 200,
    confirmDelete: true,
    mouse: false,
};
export function configDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    return path.join(xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config'), 'nexus-cli');
}
export function configPath() {
    return path.join(configDir(), 'config.json');
}
export function lastCwdPath() {
    return path.join(configDir(), 'last-cwd');
}
function isTheme(value) {
    return value === 'tokyo-night' || value === 'nord' || value === 'mono';
}
function isSortKey(value) {
    return value === 'name' || value === 'size' || value === 'date' || value === 'type';
}
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function string(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}
function number(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
}
export function loadConfig() {
    try {
        const raw = fs.readFileSync(configPath(), 'utf8');
        const parsed = JSON.parse(raw);
        return {
            theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_CONFIG.theme,
            nerdFonts: bool(parsed.nerdFonts, DEFAULT_CONFIG.nerdFonts),
            showHidden: bool(parsed.showHidden, DEFAULT_CONFIG.showHidden),
            dirsFirst: bool(parsed.dirsFirst, DEFAULT_CONFIG.dirsFirst),
            sortBy: isSortKey(parsed.sortBy) ? parsed.sortBy : DEFAULT_CONFIG.sortBy,
            sortAsc: bool(parsed.sortAsc, DEFAULT_CONFIG.sortAsc),
            editor: string(parsed.editor, DEFAULT_CONFIG.editor),
            pager: string(parsed.pager, DEFAULT_CONFIG.pager),
            previewLines: number(parsed.previewLines, DEFAULT_CONFIG.previewLines, 20, 2000),
            maxPreviewBytes: number(parsed.maxPreviewBytes, DEFAULT_CONFIG.maxPreviewBytes, 4096, 8 * 1024 * 1024),
            commandTimeoutMs: number(parsed.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs, 0, 24 * 60 * 60 * 1000),
            historySize: number(parsed.historySize, DEFAULT_CONFIG.historySize, 10, 2000),
            confirmDelete: bool(parsed.confirmDelete, DEFAULT_CONFIG.confirmDelete),
            mouse: bool(parsed.mouse, DEFAULT_CONFIG.mouse),
        };
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
export function saveConfig(config) {
    try {
        fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        const tmp = `${configPath()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, configPath());
    }
    catch {
        // Configuration persistence is best-effort; never break the TUI for it.
    }
}
export function writeLastCwd(cwd) {
    try {
        fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        fs.writeFileSync(lastCwdPath(), cwd + '\n', { mode: 0o600 });
    }
    catch {
        // best-effort
    }
}
export function readLastCwd() {
    try {
        const value = fs.readFileSync(lastCwdPath(), 'utf8').trim();
        return value !== '' && fs.statSync(value).isDirectory() ? value : null;
    }
    catch {
        return null;
    }
}
