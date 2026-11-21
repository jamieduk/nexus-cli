import os from 'node:os';
import path from 'node:path';
export const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}
export function charWidth(codePoint) {
    if (codePoint === 0)
        return 0;
    if ((codePoint >= 0x0300 && codePoint <= 0x036f) ||
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f)) {
        return 0;
    }
    if (codePoint >= 0x1100 &&
        (codePoint <= 0x115f ||
            codePoint === 0x2329 ||
            codePoint === 0x232a ||
            (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
            (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
            (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
            (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
            (codePoint >= 0xff00 && codePoint <= 0xff60) ||
            (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
            (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
            (codePoint >= 0x20000 && codePoint <= 0x3fffd))) {
        return 2;
    }
    return 1;
}
export function visibleWidth(text) {
    const plain = stripAnsi(text);
    let width = 0;
    for (const char of plain) {
        width += charWidth(char.codePointAt(0) ?? 0);
    }
    return width;
}
/**
 * Truncate an ANSI styled string to a visible width without cutting escape
 * sequences. A reset is appended when truncation happens.
 */
export function truncateAnsi(text, maxWidth) {
    if (maxWidth <= 0)
        return '';
    if (visibleWidth(text) <= maxWidth)
        return text;
    let out = '';
    let width = 0;
    let index = 0;
    while (index < text.length) {
        if (text[index] === '\x1b') {
            const match = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(index));
            if (match) {
                out += match[0];
                index += match[0].length;
                continue;
            }
        }
        const codePoint = text.codePointAt(index) ?? 0;
        const char = String.fromCodePoint(codePoint);
        const cw = charWidth(codePoint);
        if (width + cw > maxWidth)
            break;
        out += char;
        width += cw;
        index += char.length;
    }
    return out + '\x1b[0m';
}
export function padAnsi(text, width, align = 'left') {
    const clipped = truncateAnsi(text, width);
    const gap = Math.max(0, width - visibleWidth(clipped));
    if (align === 'right')
        return ' '.repeat(gap) + clipped;
    if (align === 'center') {
        const left = Math.floor(gap / 2);
        return ' '.repeat(left) + clipped + ' '.repeat(gap - left);
    }
    return clipped + ' '.repeat(gap);
}
function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean))
        return null;
    return [
        Number.parseInt(clean.slice(0, 2), 16),
        Number.parseInt(clean.slice(2, 4), 16),
        Number.parseInt(clean.slice(4, 6), 16),
    ];
}
export function color(text, opts) {
    const codes = [];
    if (opts.bold)
        codes.push('\x1b[1m');
    if (opts.dim)
        codes.push('\x1b[2m');
    if (opts.italic)
        codes.push('\x1b[3m');
    if (opts.underline)
        codes.push('\x1b[4m');
    if (opts.inverse)
        codes.push('\x1b[7m');
    if (opts.fg) {
        const rgb = hexToRgb(opts.fg);
        if (rgb)
            codes.push(`\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`);
    }
    if (opts.bg) {
        const rgb = hexToRgb(opts.bg);
        if (rgb)
            codes.push(`\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`);
    }
    return codes.join('') + text + '\x1b[0m';
}
export function fg(text, colorValue, bold = false) {
    return color(text, { fg: colorValue, bold });
}
export function humanBytes(bytes, width = 6) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '?';
    const units = ['B', 'K', 'M', 'G', 'T', 'P'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const fixed = value >= 100 || unit === 0 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return `${fixed}${units[unit]}`.padStart(width);
}
export function formatDate(timestamp) {
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
export function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
export function tildify(input) {
    const home = os.homedir();
    if (input === home)
        return '~';
    if (input.startsWith(home + path.sep))
        return '~' + input.slice(home.length);
    return input;
}
export function shortenPath(input, maxWidth) {
    const tilda = tildify(input);
    if (visibleWidth(tilda) <= maxWidth)
        return tilda;
    const parts = tilda.split(path.sep).filter(Boolean);
    const rootPrefix = tilda.startsWith(path.sep) ? path.sep : '';
    const tail = [];
    let length = 0;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index] ?? '';
        const extra = (tail.length > 0 ? 1 : 0) + visibleWidth(part);
        if (length + extra + 2 > maxWidth)
            break;
        tail.unshift(part);
        length += extra;
    }
    if (tail.length > 0) {
        const candidate = '…' + path.sep + tail.join(path.sep);
        if (visibleWidth(candidate) <= maxWidth)
            return candidate;
    }
    if (maxWidth <= 1)
        return '…';
    return '…' + tilda.slice(-(maxWidth - 1));
}
export function basenameSafe(input) {
    const normalized = input.replace(/[\\/]+$/, '');
    const base = path.basename(normalized);
    return base === '' ? path.sep : base;
}
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
export function shellQuote(value) {
    if (value === '')
        return "''";
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function expandTabs(text, tabSize = 4) {
    let out = '';
    let column = 0;
    for (const char of text) {
        if (char === '\t') {
            const spaces = tabSize - (column % tabSize);
            out += ' '.repeat(spaces);
            column += spaces;
        }
        else {
            out += char;
            column += 1;
        }
    }
    return out;
}
export function sanitizeText(text) {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t/g, '    ')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
export function sanitizeCommandOutput(text) {
    return sanitizeText(stripAnsi(text))
        .split('\n')
        .map((line) => line.replace(/[\x00-\x1f\x7f]/g, ''))
        .join('\n');
}
export function wrapText(text, width) {
    if (width <= 0)
        return [];
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        if (current === '') {
            current = word;
        }
        else if (current.length + 1 + word.length <= width) {
            current += ' ' + word;
        }
        else {
            lines.push(current);
            current = word;
        }
    }
    if (current !== '')
        lines.push(current);
    return lines.length > 0 ? lines : [''];
}
export function percent(part, total) {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0)
        return 0;
    return clamp((part / total) * 100, 0, 100);
}
export const PALETTES = {
    'tokyo-night': {
        name: 'tokyo-night',
        bg: '#1a1b26',
        panel: '#16161e',
        panelAlt: '#1f2335',
        fg: '#c0caf5',
        muted: '#7982a9',
        dim: '#565f89',
        border: '#2f3549',
        borderFocus: '#7aa2f7',
        accent: '#7aa2f7',
        accent2: '#bb9af7',
        green: '#9ece6a',
        yellow: '#e0af68',
        orange: '#ff9e64',
        red: '#f7768e',
        purple: '#bb9af7',
        cyan: '#7dcfff',
        selectionBg: '#283457',
        selectionFg: '#c0caf5',
        cursorBg: '#7aa2f7',
        cursorFg: '#1a1b26',
        headerBg: '#16161e',
        headerFg: '#c0caf5',
    },
    nord: {
        name: 'nord',
        bg: '#2e3440',
        panel: '#2b303b',
        panelAlt: '#3b4252',
        fg: '#e5e9f0',
        muted: '#a3abbd',
        dim: '#7b8498',
        border: '#434c5e',
        borderFocus: '#88c0d0',
        accent: '#88c0d0',
        accent2: '#b48ead',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        orange: '#d08770',
        red: '#bf616a',
        purple: '#b48ead',
        cyan: '#8fbcbb',
        selectionBg: '#3b4252',
        selectionFg: '#eceff4',
        cursorBg: '#88c0d0',
        cursorFg: '#2e3440',
        headerBg: '#2b303b',
        headerFg: '#e5e9f0',
    },
    mono: {
        name: 'mono',
        bg: '#0b0b0b',
        panel: '#111111',
        panelAlt: '#1a1a1a',
        fg: '#e6e6e6',
        muted: '#9a9a9a',
        dim: '#666666',
        border: '#333333',
        borderFocus: '#e6e6e6',
        accent: '#e6e6e6',
        accent2: '#cccccc',
        green: '#d0d0d0',
        yellow: '#d0d0d0',
        orange: '#b9b9b9',
        red: '#f0f0f0',
        purple: '#c8c8c8',
        cyan: '#e0e0e0',
        selectionBg: '#2d2d2d',
        selectionFg: '#ffffff',
        cursorBg: '#e6e6e6',
        cursorFg: '#0b0b0b',
        headerBg: '#111111',
        headerFg: '#e6e6e6',
    },
};
export function getPalette(theme) {
    return PALETTES[theme] ?? PALETTES['tokyo-night'];
}
