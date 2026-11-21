import { StringDecoder } from 'node:string_decoder';
import { VERSION } from './version.js';
import os from 'node:os';
import path from 'node:path';
import { color, clamp, expandTabs, formatDate, humanBytes, padAnsi, sanitizeText, shortenPath, stripAnsi, truncateAnsi, visibleWidth, wrapText, } from './utils.js';
function bgCode(hex) {
    const clean = hex.replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean))
        return '';
    return `\x1b[48;2;${Number.parseInt(clean.slice(0, 2), 16)};${Number.parseInt(clean.slice(2, 4), 16)};${Number.parseInt(clean.slice(4, 6), 16)}m`;
}
function applyBackground(line, bg) {
    const code = bgCode(bg);
    if (code === '')
        return line;
    return code + line.replace(/\x1b\[0m/g, '\x1b[0m' + code) + '\x1b[0m';
}
function plainSlice(text, start, width) {
    const plain = stripAnsi(text);
    let out = '';
    let column = 0;
    let taken = 0;
    for (const char of plain) {
        const cw = char.codePointAt(0) === 0 ? 0 : visibleWidth(char);
        if (column + cw <= start) {
            column += cw;
            continue;
        }
        if (taken >= width)
            break;
        if (column < start) {
            column += cw;
            continue;
        }
        out += char;
        taken += cw;
        column += cw;
    }
    return out;
}
function overlayLine(base, overlay, left, width) {
    const basePlain = stripAnsi(base);
    const prefix = plainSlice(basePlain, 0, left);
    const suffixStart = left + width;
    const suffix = plainSlice(basePlain, suffixStart, Math.max(0, visibleWidth(basePlain) - suffixStart));
    return truncateAnsi(prefix + overlay + suffix, visibleWidth(basePlain));
}
function box(width, height, title, focused, palette, body) {
    if (width < 4 || height < 3)
        return Array.from({ length: Math.max(0, height) }, () => ' '.repeat(Math.max(0, width)));
    const innerWidth = width - 2;
    const borderColor = focused ? palette.borderFocus : palette.border;
    const titleText = truncateAnsi(title, Math.max(0, innerWidth - 3));
    const titleWidth = visibleWidth(titleText);
    const top = titleText === ''
        ? color('┌' + '─'.repeat(innerWidth) + '┐', { fg: borderColor })
        : color('┌─', { fg: borderColor }) +
            color(' ' + titleText + ' ', { fg: focused ? palette.accent : palette.muted, bold: focused }) +
            color('─'.repeat(Math.max(0, innerWidth - titleWidth - 3)) + '┐', { fg: borderColor });
    const bottom = color('└' + '─'.repeat(innerWidth) + '┘', { fg: borderColor });
    const lines = [top];
    for (let i = 0; i < height - 2; i += 1) {
        const content = body[i] ?? '';
        lines.push(color('│', { fg: borderColor }) + padAnsi(content, innerWidth) + color('│', { fg: borderColor }));
    }
    lines.push(bottom);
    return lines;
}
function centeredMessage(width, height, text) {
    const lines = Array.from({ length: height }, () => '');
    const row = Math.floor(height / 2);
    const wrapped = wrapText(text, Math.max(10, width - 8));
    wrapped.forEach((line, index) => {
        const target = row - Math.floor(wrapped.length / 2) + index;
        if (target >= 0 && target < height)
            lines[target] = padAnsi(line, width, 'center');
    });
    return lines;
}
function breadcrumb(cwd, maxWidth) {
    const home = os.homedir();
    let base = cwd;
    let prefix = '';
    if (cwd === home)
        return '~';
    if (cwd.startsWith(home + path.sep)) {
        base = cwd.slice(home.length + 1);
        prefix = '~' + path.sep;
    }
    else if (cwd.startsWith(path.sep)) {
        base = cwd.slice(1);
        prefix = path.sep;
    }
    const parts = base.split(path.sep).filter(Boolean);
    let text = prefix + parts.join(' › ');
    if (text.length <= maxWidth)
        return text;
    const tail = parts.slice(-3).join(' › ');
    text = prefix + '… › ' + tail;
    if (text.length > maxWidth)
        text = '…' + text.slice(-Math.max(3, maxWidth - 1));
    return text;
}
function sortLabel(sortBy, asc) {
    const arrow = asc ? '↑' : '↓';
    return `${sortBy}${arrow}`;
}
function focusLabel(focused, palette, label) {
    return focused ? color(label, { fg: palette.accent, bold: true }) : color(label, { fg: palette.muted });
}
function fileColumnLayout(width) {
    const iconWidth = 2;
    const minName = 10;
    let nonName = iconWidth + 1;
    let showSize = false;
    let showPerms = false;
    let showOwner = false;
    let showDate = false;
    if (width >= nonName + minName + 7) {
        showSize = true;
        nonName += 7;
    }
    if (width >= nonName + minName + 11) {
        showPerms = true;
        nonName += 11;
    }
    if (width >= nonName + minName + 9) {
        showOwner = true;
        nonName += 9;
    }
    if (width >= nonName + minName + 12) {
        showDate = true;
        nonName += 12;
    }
    return {
        iconWidth,
        nameWidth: Math.max(8, width - nonName),
        sizeWidth: 6,
        permsWidth: 10,
        ownerWidth: 8,
        dateWidth: 11,
        showSize,
        showPerms,
        showOwner,
        showDate,
    };
}
function safeLabel(value) {
    return sanitizeText(stripAnsi(value))
        .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
        .replace(/[\n\r\t]/g, ' ');
}
function styleKey(key, palette) {
    return color(key, { fg: palette.bg, bg: palette.accent, bold: true }) + color(' ', {});
}
function fileColor(item, palette) {
    if (item.isDir)
        return palette.accent;
    if (item.isSymlink)
        return palette.purple;
    if (item.isExecutable)
        return palette.green;
    return palette.fg;
}
export class Tui {
    onKey;
    onResize;
    started = false;
    suspended = false;
    stdinListener = null;
    resizeListener = null;
    decoder = new StringDecoder('utf8');
    pending = '';
    width = 80;
    height = 24;
    lastModel = null;
    constructor(onKey, onResize) {
        this.onKey = onKey;
        this.onResize = onResize;
    }
    get cols() {
        return this.width;
    }
    get rows() {
        return this.height;
    }
    start() {
        if (this.started)
            return;
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
            throw new Error('Nexus requires an interactive terminal (TTY).');
        }
        this.started = true;
        this.width = process.stdout.columns || 80;
        this.height = process.stdout.rows || 24;
        process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H');
        this.attach();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.detach();
        process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    }
    suspend() {
        if (!this.started || this.suspended)
            return;
        this.suspended = true;
        this.detach();
        process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    }
    resume() {
        if (!this.started || !this.suspended)
            return;
        this.suspended = false;
        process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H');
        this.attach();
        if (this.lastModel)
            this.render(this.lastModel);
    }
    isSuspended() {
        return this.suspended;
    }
    attach() {
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(true);
            }
            catch {
                // Some terminals disallow raw mode; the app will still render.
            }
            process.stdin.resume();
        }
        this.stdinListener = (chunk) => {
            this.pending += this.decoder.write(chunk);
            this.processPending();
        };
        process.stdin.on('data', this.stdinListener);
        this.resizeListener = () => {
            this.width = process.stdout.columns || this.width;
            this.height = process.stdout.rows || this.height;
            this.onResize();
            if (this.lastModel)
                this.render(this.lastModel);
        };
        process.stdout.on('resize', this.resizeListener);
    }
    detach() {
        if (this.stdinListener)
            process.stdin.off('data', this.stdinListener);
        this.stdinListener = null;
        if (this.resizeListener)
            process.stdout.off('resize', this.resizeListener);
        this.resizeListener = null;
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(false);
            }
            catch {
                // ignore
            }
        }
        process.stdin.pause();
    }
    processPending() {
        while (this.pending.length > 0) {
            const consumed = this.consumeOne();
            if (consumed === 0)
                break;
            this.pending = this.pending.slice(consumed);
        }
    }
    consumeOne() {
        const raw = this.pending;
        if (raw.length === 0)
            return 0;
        if (raw[0] === '\x1b') {
            if (raw.length === 1) {
                // Wait briefly for a possible sequence; a lone ESC is still useful.
                setTimeout(() => {
                    if (this.pending === '\x1b') {
                        this.pending = '';
                        this.emit({ name: 'escape', ctrl: false, alt: false, shift: false, raw: '\x1b' });
                    }
                }, 20);
                return 0;
            }
            const seq = this.matchEscape(raw);
            if (seq !== null) {
                this.emit(seq.key);
                return seq.length;
            }
            if (raw.startsWith('\x1b[') || raw.startsWith('\x1bO')) {
                const csi = /^\x1b\[[0-9;?<>=]*[ -/]*[@-~]/.exec(raw);
                if (csi) {
                    this.emit({ name: 'unknown', ctrl: false, alt: false, shift: false, raw: csi[0] });
                    return csi[0].length;
                }
                return 0;
            }
            // Alt + printable character.
            const next = raw.slice(1);
            const [char] = Array.from(next);
            if (char) {
                this.emit({ name: 'char', char, ctrl: false, alt: true, shift: /[A-Z]/.test(char), raw: raw.slice(0, 1 + char.length) });
                return 1 + char.length;
            }
            this.emit({ name: 'escape', ctrl: false, alt: false, shift: false, raw: '\x1b' });
            return 1;
        }
        const char = raw[0] ?? '';
        const code = char.charCodeAt(0);
        if (char === '\r' || char === '\n') {
            this.emit({ name: 'enter', ctrl: false, alt: false, shift: false, raw: char });
            return 1;
        }
        if (char === '\t') {
            this.emit({ name: 'tab', ctrl: false, alt: false, shift: false, raw: char });
            return 1;
        }
        if (char === '\x7f' || char === '\x08') {
            this.emit({ name: 'backspace', ctrl: false, alt: false, shift: false, raw: char });
            return 1;
        }
        if (code >= 1 && code <= 26) {
            const letter = String.fromCharCode(96 + code);
            this.emit({ name: `ctrl-${letter}`, ctrl: true, alt: false, shift: false, raw: char });
            return 1;
        }
        if (code === 0) {
            this.emit({ name: 'space', ctrl: true, alt: false, shift: false, raw: char });
            return 1;
        }
        if (code >= 27 && code <= 31) {
            this.emit({ name: 'unknown', ctrl: true, alt: false, shift: false, raw: char });
            return 1;
        }
        if (char === ' ') {
            this.emit({ name: 'space', ctrl: false, alt: false, shift: false, raw: char });
            return 1;
        }
        const [full] = Array.from(raw);
        if (!full)
            return 0;
        this.emit({ name: 'char', char: full, ctrl: false, alt: false, shift: full !== full.toLowerCase(), raw: full });
        return full.length;
    }
    matchEscape(raw) {
        const simple = {
            '\x1b[A': 'up',
            '\x1b[B': 'down',
            '\x1b[C': 'right',
            '\x1b[D': 'left',
            '\x1b[H': 'home',
            '\x1b[F': 'end',
            '\x1bOA': 'up',
            '\x1bOB': 'down',
            '\x1bOC': 'right',
            '\x1bOD': 'left',
            '\x1bOH': 'home',
            '\x1bOF': 'end',
            '\x1bOP': 'f1',
            '\x1bOQ': 'f2',
            '\x1bOR': 'f3',
            '\x1bOS': 'f4',
            '\x1b[Z': 'tab',
            '\x1b[2~': 'insert',
            '\x1b[3~': 'delete',
            '\x1b[5~': 'pageup',
            '\x1b[6~': 'pagedown',
            '\x1b[11~': 'f1',
            '\x1b[12~': 'f2',
            '\x1b[13~': 'f3',
            '\x1b[14~': 'f4',
            '\x1b[15~': 'f5',
            '\x1b[17~': 'f6',
            '\x1b[18~': 'f7',
            '\x1b[19~': 'f8',
            '\x1b[20~': 'f9',
            '\x1b[21~': 'f10',
            '\x1b[23~': 'f11',
            '\x1b[24~': 'f12',
            '\x1b[1~': 'home',
            '\x1b[4~': 'end',
            '\x1b[7~': 'home',
            '\x1b[8~': 'end',
        };
        for (const [sequence, name] of Object.entries(simple)) {
            if (raw.startsWith(sequence)) {
                return {
                    key: { name, ctrl: false, alt: false, shift: sequence === '\x1b[Z', raw: sequence },
                    length: sequence.length,
                };
            }
        }
        const parameterized = /^\x1b\[(\d+)(?:;(\d+))?([ABCDHF])/.exec(raw);
        if (parameterized) {
            const base = parameterized[1] ?? '';
            const modifier = Number(parameterized[2] ?? '1');
            const name = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[parameterized[3] ?? ''];
            if (name) {
                const shift = modifier === 2 || modifier === 4 || modifier === 6 || modifier === 8;
                const alt = modifier === 3 || modifier === 4 || modifier === 7 || modifier === 8;
                const ctrl = modifier === 5 || modifier === 6 || modifier === 7 || modifier === 8;
                return {
                    key: { name, ctrl, alt, shift, raw: parameterized[0] },
                    length: parameterized[0].length,
                };
            }
            void base;
        }
        const tilde = /^\x1b\[(\d+)(?:;(\d+))?~/.exec(raw);
        if (tilde) {
            const code = tilde[1];
            const mapping = {
                '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown',
                '7': 'home', '8': 'end', '11': 'f1', '12': 'f2', '13': 'f3', '14': 'f4',
                '15': 'f5', '17': 'f6', '18': 'f7', '19': 'f8', '20': 'f9', '21': 'f10',
                '23': 'f11', '24': 'f12',
            };
            const name = code ? mapping[code] : undefined;
            if (name) {
                return { key: { name, ctrl: false, alt: false, shift: false, raw: tilde[0] }, length: tilde[0].length };
            }
        }
        return null;
    }
    emit(key) {
        this.onKey(key);
    }
    render(model) {
        this.lastModel = model;
        if (!this.started || this.suspended)
            return;
        this.width = model.width || this.width;
        this.height = model.height || this.height;
        const lines = this.compose(model);
        const rendered = lines.map((line) => applyBackground(padAnsi(line, this.width), model.palette.bg));
        let output = '\x1b[?2026h\x1b[H';
        for (let i = 0; i < this.height; i += 1) {
            output += (rendered[i] ?? ' '.repeat(this.width)) + '\x1b[0m';
            if (i < this.height - 1)
                output += '\x1b[K\n';
            else
                output += '\x1b[K';
        }
        output += '\x1b[?2026l';
        process.stdout.write(output);
    }
    compose(model) {
        const { width, height, palette } = model;
        if (width < 60 || height < 16) {
            return centeredMessage(width, height, `Terminal too small (${width}x${height}). Nexus needs at least 60x16.`);
        }
        const headerHeight = 3;
        const footerHeight = height >= 18 ? 2 : 1;
        const available = height - headerHeight - footerHeight;
        const commandHeight = clamp(Math.floor(available * 0.27), 6, 15);
        const mainHeight = available - commandHeight;
        if (mainHeight < 6) {
            return centeredMessage(width, height, 'Terminal is too short. Resize the window and try again.');
        }
        const lines = [];
        lines.push(...this.renderHeader(model, headerHeight));
        lines.push(...this.renderMain(model, width, mainHeight));
        lines.push(...this.renderCommand(model, width, commandHeight));
        lines.push(...this.renderFooter(model, width, footerHeight));
        while (lines.length < height)
            lines.push('');
        if (lines.length > height)
            lines.length = height;
        if (model.modal) {
            return this.renderModal(model, lines);
        }
        return lines;
    }
    renderHeader(model, height) {
        const p = model.palette;
        const width = model.width;
        const compact = width < 132;
        const statsParts = [];
        statsParts.push(color(`CPU ${model.system.load}`, { fg: p.muted }));
        if (compact) {
            statsParts.push(color(`RAM ${Math.round(model.system.memoryPercent)}%`, { fg: p.muted }));
        }
        else {
            const memBar = this.meter(model.system.memoryPercent, 8, p);
            statsParts.push(color('RAM ', { fg: p.muted }) + memBar + color(` ${model.system.memory}`, { fg: p.muted }));
        }
        statsParts.push(color(`UP ${model.system.uptime}`, { fg: p.muted }));
        const stats = statsParts.join(color('  ·  ', { fg: p.dim }));
        const title = color('◆ Nexus CLI/FM', { fg: p.accent, bold: true }) + color(` v${VERSION}`, { fg: p.muted });
        const host = color(compact ? model.system.hostname : `${model.system.hostname} · ${model.system.os}`, { fg: p.dim });
        const left = ' ' + title + color('  │  ', { fg: p.dim }) + host;
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(stats) - 2);
        const row0 = truncateAnsi(left + ' '.repeat(gap) + stats + ' ', width);
        const crumb = safeLabel(breadcrumb(model.cwd, Math.max(20, Math.floor(width * 0.51))));
        const bread = color(' ', {}) + color('⌂ ', { fg: p.accent }) + color(crumb, { fg: p.fg, bold: true });
        const flags = [];
        if (compact)
            flags.push(color(model.system.os, { fg: p.dim }));
        flags.push(color(`sort ${sortLabel(model.sortBy, model.sortAsc)}`, { fg: p.muted }));
        if (model.filter !== '')
            flags.push(color(`filter "${model.filter}"`, { fg: p.yellow }));
        if (model.marked.size > 0)
            flags.push(color(`${model.marked.size} marked`, { fg: p.green }));
        if (model.showHidden)
            flags.push(color('hidden', { fg: p.purple }));
        const flagText = flags.join(color(' · ', { fg: p.dim }));
        const gap2 = Math.max(1, width - visibleWidth(bread) - visibleWidth(flagText) - 2);
        const row1 = truncateAnsi(bread + ' '.repeat(gap2) + flagText + ' ', width);
        const row2 = color('─'.repeat(width), { fg: p.border });
        const rows = [row0, row1, row2];
        while (rows.length < height)
            rows.push('');
        return rows.slice(0, height);
    }
    meter(percentValue, width, p) {
        const filled = Math.round((clamp(percentValue, 0, 100) / 100) * width);
        const colorValue = percentValue >= 85 ? p.red : percentValue >= 65 ? p.yellow : p.green;
        return color('█'.repeat(filled), { fg: colorValue }) + color('░'.repeat(Math.max(0, width - filled)), { fg: p.border });
    }
    renderMain(model, width, height) {
        const leftWidth = Math.max(34, Math.floor(width * 0.58));
        const rightWidth = width - leftWidth;
        if (rightWidth < 22) {
            return box(width, height, 'Files', true, model.palette, this.fileBody(model, width - 2, height - 2, true));
        }
        const leftTitle = `${focusLabel(model.focus === 'files', model.palette, 'FILES')} · ${safeLabel(shortenPath(model.cwd, Math.max(12, leftWidth - 16)))}`;
        const rightTitle = safeLabel(model.preview.title || 'PREVIEW');
        const left = box(leftWidth, height, leftTitle, model.focus === 'files', model.palette, this.fileBody(model, leftWidth - 2, height - 2, model.focus === 'files'));
        const right = box(rightWidth, height, rightTitle, false, model.palette, this.previewBody(model, rightWidth - 2, height - 2));
        return left.map((line, index) => line + (right[index] ?? ''));
    }
    fileBody(model, width, height, focused) {
        const p = model.palette;
        if (height <= 0)
            return [];
        const lines = [];
        const layout = fileColumnLayout(width);
        const { showSize, showPerms, showOwner, showDate, nameWidth, sizeWidth, permsWidth, ownerWidth, dateWidth } = layout;
        let header = color('   ', {}) + padAnsi(color('NAME', { fg: p.dim, bold: true }), nameWidth);
        if (showSize)
            header += ' ' + padAnsi(color('SIZE', { fg: p.dim, bold: true }), sizeWidth, 'right');
        if (showPerms)
            header += ' ' + padAnsi(color('MODE', { fg: p.dim, bold: true }), permsWidth);
        if (showOwner)
            header += ' ' + padAnsi(color('OWNER', { fg: p.dim, bold: true }), ownerWidth);
        if (showDate)
            header += ' ' + padAnsi(color('MODIFIED', { fg: p.dim, bold: true }), dateWidth);
        lines.push(truncateAnsi(header, width));
        const listHeight = height - 1;
        if (model.items.length === 0) {
            const message = model.error !== ''
                ? `Cannot read directory: ${model.error}`
                : model.filter !== '' ? 'No matches for this filter.' : 'Empty directory.';
            lines.push(color(safeLabel(message), { fg: model.error !== '' ? p.red : p.muted, italic: true }));
            while (lines.length < height)
                lines.push('');
            return lines;
        }
        const start = clamp(model.selectedIndex - Math.floor(listHeight / 2), 0, Math.max(0, model.items.length - listHeight));
        const visible = model.items.slice(start, start + listHeight);
        for (let offset = 0; offset < listHeight; offset += 1) {
            const item = visible[offset];
            if (!item) {
                lines.push('');
                continue;
            }
            const index = start + offset;
            const selected = index === model.selectedIndex;
            const marked = model.marked.has(item.path);
            lines.push(this.fileRow(item, width, selected, marked, focused, model));
        }
        return lines;
    }
    fileRow(item, width, selected, marked, focused, model) {
        const p = model.palette;
        const { showSize, showPerms, showOwner, showDate, nameWidth, sizeWidth, permsWidth, ownerWidth, dateWidth } = fileColumnLayout(width);
        const iconColor = item.isDir ? p.accent : item.isSymlink ? p.purple : item.isExecutable ? p.green : p.muted;
        const icon = color(item.icon, { fg: iconColor, bold: item.isDir });
        const mark = marked ? color('●', { fg: p.green, bold: true }) : selected ? color('›', { fg: focused ? p.accent : p.muted }) : ' ';
        const itemColor = fileColor(item, p);
        const name = padAnsi(color(safeLabel(item.name), { fg: itemColor, bold: item.isDir }), nameWidth);
        let row = mark + icon + ' ' + name;
        if (showSize) {
            row += ' ' + padAnsi(color(item.isDir ? '   DIR' : humanBytes(item.size), { fg: p.muted }), sizeWidth, 'right');
        }
        if (showPerms)
            row += ' ' + padAnsi(color(item.modeString, { fg: item.isExecutable ? p.green : p.dim }), permsWidth);
        if (showOwner)
            row += ' ' + padAnsi(color(item.user, { fg: p.dim }), ownerWidth);
        if (showDate)
            row += ' ' + padAnsi(color(formatDate(item.mtime).slice(5), { fg: p.dim }), dateWidth);
        row = truncateAnsi(row, width);
        if (selected) {
            row = color(padAnsi(stripAnsi(row), width), {
                bg: focused ? p.selectionBg : p.panelAlt,
                fg: p.selectionFg,
                bold: true,
            });
        }
        return row;
    }
    previewBody(model, width, height) {
        const p = model.palette;
        const preview = model.preview;
        if (height <= 0)
            return [];
        const lines = [];
        if (preview.meta.length > 0) {
            const labelWidth = Math.min(14, Math.max(9, Math.floor(width * 0.28)));
            const metaLimit = Math.min(preview.meta.length, Math.max(3, Math.floor(height * (preview.kind === 'text' ? 0.5 : 0.8))));
            for (const meta of preview.meta.slice(0, metaLimit)) {
                if (lines.length >= height - 2)
                    break;
                const tone = meta.tone === 'warn' ? p.yellow : meta.tone === 'bad' ? p.red : meta.tone === 'good' ? p.green : meta.tone === 'muted' ? p.muted : p.fg;
                lines.push(padAnsi(color(meta.label, { fg: p.dim }), labelWidth) +
                    color(' ', {}) +
                    padAnsi(color(safeLabel(meta.value), { fg: tone }), Math.max(4, width - labelWidth - 1)));
            }
            if (lines.length < height)
                lines.push(color('─'.repeat(Math.max(0, width)), { fg: p.border }));
        }
        if (preview.kind === 'directory') {
            if (lines.length < height)
                lines.push(color('Directory contents are in the left pane. Press Enter to open.', { fg: p.muted, italic: true }));
            if (preview.loading && lines.length < height)
                lines.push(color('Calculating size…', { fg: p.dim, italic: true }));
        }
        else if (preview.kind === 'binary') {
            for (const hex of preview.hex) {
                if (lines.length >= height)
                    break;
                const offset = color(hex.slice(0, 8), { fg: p.dim });
                const bytes = color(hex.slice(10, 58), { fg: p.accent2 });
                const ascii = color(hex.slice(58), { fg: p.muted });
                lines.push(offset + '  ' + bytes + '  ' + ascii);
            }
        }
        else if (preview.kind === 'text') {
            const remaining = Math.max(0, height - lines.length);
            const gutter = String(preview.totalLines ?? preview.lines.length).length + 1;
            const start = clamp(preview.scroll, 0, Math.max(0, preview.lines.length - remaining));
            const slice = preview.lines.slice(start, start + remaining);
            for (let i = 0; i < slice.length; i += 1) {
                const number = color(String(start + i + 1).padStart(gutter), { fg: p.dim });
                const content = truncateAnsi(slice[i] ?? '', Math.max(1, width - gutter - 2));
                lines.push(number + color(' │ ', { fg: p.border }) + content);
            }
            if (slice.length < remaining && preview.truncated) {
                lines.push(color('… preview truncated (F2 to view more)', { fg: p.dim, italic: true }));
            }
        }
        else if (preview.kind === 'permission' || preview.kind === 'error') {
            for (const line of preview.lines) {
                if (lines.length >= height)
                    break;
                lines.push(color(safeLabel(line), { fg: p.red }));
            }
        }
        else if (preview.kind === 'empty') {
            lines.push(color(safeLabel(preview.subtitle), { fg: p.muted, italic: true }));
        }
        while (lines.length < height)
            lines.push('');
        return lines.slice(0, height);
    }
    renderCommand(model, width, height) {
        const p = model.palette;
        const shell = model.shell;
        const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        const spinner = spinnerFrames[shell.spinner % spinnerFrames.length] ?? '⠋';
        const title = shell.running
            ? `${focusLabel(model.focus === 'shell', p, 'SHELL')} · ${color(spinner, { fg: p.yellow })} running ${truncateAnsi(safeLabel(shell.runningCommand), Math.max(10, width - 30))}`
            : `${focusLabel(model.focus === 'shell', p, 'SHELL')} · ${safeLabel(shortenPath(shell.cwd, Math.max(12, width - 16)))}`;
        const body = [];
        const outputHeight = Math.max(1, height - 3);
        if (shell.output.length === 0) {
            body.push(color('Bash prompt with your ~/.bashrc aliases, functions and exports. Try: ll · git status · cd /var/log', { fg: p.muted, italic: true }));
            for (let i = 1; i < outputHeight; i += 1)
                body.push('');
        }
        else {
            const end = Math.max(0, shell.output.length - shell.outputScroll);
            const start = Math.max(0, end - outputHeight);
            const visible = shell.output.slice(start, end);
            for (const line of visible) {
                let styled = line.text;
                if (line.kind === 'command')
                    styled = color('❯ ', { fg: p.accent, bold: true }) + color(line.text, { fg: p.accent });
                else if (line.kind === 'error')
                    styled = color(line.text, { fg: p.red });
                else if (line.kind === 'info')
                    styled = color(line.text, { fg: p.muted, italic: true });
                else
                    styled = color(line.text, { fg: p.fg });
                body.push(truncateAnsi(styled, width));
            }
            while (body.length < outputHeight)
                body.unshift('');
            if (body.length > outputHeight)
                body.splice(0, body.length - outputHeight);
        }
        const prompt = this.promptText(model);
        const available = Math.max(4, width - visibleWidth(prompt));
        const input = shell.input;
        const cursor = clamp(shell.cursor, 0, input.length);
        let displayInput = input;
        let displayCursor = cursor;
        if (visibleWidth(displayInput) > available - 1) {
            const tail = displayInput.slice(Math.max(0, displayCursor - available + 8));
            displayInput = '…' + tail;
            displayCursor = Math.max(0, displayCursor - Math.max(0, displayCursor - available + 8)) + 1;
        }
        const before = displayInput.slice(0, displayCursor);
        const at = displayInput.slice(displayCursor, displayCursor + 1) || ' ';
        const after = displayInput.slice(displayCursor + 1);
        const cursorStyled = color(at, { fg: p.bg, bg: p.accent, bold: true });
        const inputLine = truncateAnsi(prompt + before + cursorStyled + after, width);
        body.push(inputLine);
        if (body.length > height - 2)
            body.splice(0, body.length - (height - 2));
        return box(width, height, title, model.focus === 'shell', p, body);
    }
    promptText(model) {
        const p = model.palette;
        const system = model.system;
        const short = safeLabel(shortenPath(model.shell.cwd, Math.max(12, Math.floor(model.width * 0.32))));
        const prefix = color(`${system.user}@${system.hostname}`, { fg: p.green, bold: true }) + ':' + color(short, { fg: p.accent });
        const suffix = system.user === 'root' ? '#' : '$';
        return prefix + ' ' + color(suffix, { fg: p.muted }) + ' ';
    }
    renderFooter(model, width, height) {
        const p = model.palette;
        const rows = [];
        const fullKeys = [
            ['F1', 'Help'], ['F2', 'View'], ['F3', 'Edit'], ['F4', 'Copy'], ['F5', 'Move'],
            ['F6', 'Delete'], ['F7', 'Mkdir'], ['F8', 'Focus'], ['F9', 'Menu'], ['^Q', 'Exit'],
        ];
        const compactKeys = [['F1', 'Help'], ['F4', 'Copy'], ['F6', 'Del'], ['F8', 'Focus'], ['F9', 'Menu'], ['^Q', 'Exit']];
        const keys = width >= 96 ? fullKeys : compactKeys;
        let shortcuts = ' ';
        for (const [key, label] of keys) {
            const segment = styleKey(key, p) + color(label, { fg: p.muted }) + '  ';
            if (visibleWidth(shortcuts) + visibleWidth(segment) > width - 1)
                break;
            shortcuts += segment;
        }
        rows.push(truncateAnsi(shortcuts, width));
        if (height >= 2) {
            const focus = model.focus === 'shell' ? 'SHELL' : 'FILES';
            const summary = `Loaded ${model.bashProfile.aliases.size} aliases and ${model.bashProfile.functions.size} functions from ~/.bashrc`;
            const marks = model.marked.size > 0 ? `${model.marked.size} marked` : '';
            const filter = model.filter !== '' ? `filter: ${model.filter}` : '';
            const leftParts = [
                color(` ${focus} `, { fg: p.bg, bg: model.focus === 'shell' ? p.accent2 : p.accent, bold: true }),
                color(' ' + summary, { fg: p.dim }),
                marks ? color('  ' + marks, { fg: p.green }) : '',
                filter ? color('  ' + filter, { fg: p.yellow }) : '',
            ];
            let left = leftParts.join('');
            const statusTone = model.statusTone === 'bad' ? p.red : model.statusTone === 'warn' ? p.yellow : model.statusTone === 'good' ? p.green : p.muted;
            const right = model.status !== '' ? color(safeLabel(model.status), { fg: statusTone }) + ' ' : '';
            if (visibleWidth(left) + visibleWidth(right) > width)
                left = truncateAnsi(left, Math.max(10, width - visibleWidth(right) - 1));
            const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
            rows.push(truncateAnsi(left + ' '.repeat(gap) + right, width));
        }
        while (rows.length < height)
            rows.push('');
        return rows.slice(0, height);
    }
    renderModal(model, baseLines) {
        const modal = model.modal;
        if (!modal)
            return baseLines;
        const p = model.palette;
        if (modal.kind === 'help' || modal.kind === 'viewer') {
            return this.renderFullModal(model, modal);
        }
        const width = clamp(modal.kind === 'menu' ? 58 : 68, 30, model.width - 8);
        const innerHeight = Math.max(4, Math.min(model.height - 6, modal.kind === 'menu' ? modal.options.length + 4 : 8));
        const height = innerHeight + 2;
        const body = [];
        const wrapWidth = Math.max(10, width - 4);
        if (modal.kind === 'menu') {
            const visibleOptions = Math.max(3, innerHeight - 2);
            const start = clamp(modal.selected - Math.floor(visibleOptions / 2), 0, Math.max(0, modal.options.length - visibleOptions));
            const slice = modal.options.slice(start, start + visibleOptions);
            slice.forEach((option, offset) => {
                const index = start + offset;
                const selected = index === modal.selected;
                const label = selected ? color('› ' + option.label, { fg: p.bg, bg: p.accent, bold: true }) : color('  ' + option.label, { fg: option.danger ? p.red : p.fg });
                const desc = option.description ? color('  ' + option.description, { fg: p.dim, italic: true }) : '';
                body.push(padAnsi(label + desc, wrapWidth));
            });
        }
        else {
            const messageLines = modal.message.split('\n').flatMap((line) => line === '' ? [''] : wrapText(line, wrapWidth));
            for (const line of messageLines) {
                if (body.length >= innerHeight - 2)
                    break;
                body.push(color(safeLabel(line), { fg: modal.danger ? p.red : p.muted }));
            }
            if (modal.kind === 'input') {
                while (body.length < innerHeight - 2)
                    body.push('');
                const value = modal.input;
                const cursor = clamp(modal.cursor, 0, value.length);
                const availableInput = Math.max(4, wrapWidth - 2);
                let displayValue = value;
                let displayCursor = cursor;
                if (displayValue.length > availableInput - 1) {
                    const start = Math.max(0, cursor - availableInput + 8);
                    displayValue = '…' + value.slice(start);
                    displayCursor = cursor - start + 1;
                }
                const before = displayValue.slice(0, displayCursor);
                const at = displayValue.slice(displayCursor, displayCursor + 1) || ' ';
                const after = displayValue.slice(displayCursor + 1);
                body.push(color('› ', { fg: p.accent, bold: true }) + truncateAnsi(before + color(at, { fg: p.bg, bg: p.accent }) + after, availableInput));
            }
            else if (modal.kind === 'confirm') {
                while (body.length < innerHeight - 2)
                    body.push('');
            }
            else {
                while (body.length < innerHeight - 2)
                    body.push('');
            }
        }
        if (modal.kind === 'menu' || modal.kind === 'message' || modal.kind === 'confirm' || modal.kind === 'input') {
            body.push(color(modal.hint, { fg: p.dim, italic: true }));
        }
        const boxLines = box(width, height, safeLabel(modal.title), true, p, body);
        const result = [...baseLines];
        const left = Math.floor((model.width - width) / 2);
        const top = Math.floor((model.height - height) / 2);
        for (let i = 0; i < boxLines.length; i += 1) {
            const row = top + i;
            if (row >= 0 && row < result.length) {
                result[row] = overlayLine(result[row] ?? '', boxLines[i] ?? '', left, width);
            }
        }
        return result;
    }
    renderFullModal(model, modal) {
        const p = model.palette;
        const width = model.width - 4;
        const height = model.height - 2;
        const body = [];
        const contentHeight = height - 2;
        const scroll = clamp(modal.scroll, 0, Math.max(0, modal.lines.length - contentHeight));
        const gutter = modal.kind === 'viewer' ? String(modal.lines.length).length + 1 : 0;
        for (let i = 0; i < contentHeight; i += 1) {
            const line = modal.lines[scroll + i];
            if (line === undefined) {
                body.push('');
                continue;
            }
            if (modal.kind === 'viewer') {
                const number = color(String(scroll + i + 1).padStart(gutter), { fg: p.dim });
                body.push(number + color(' │ ', { fg: p.border }) + truncateAnsi(expandTabs(line), Math.max(4, width - gutter - 4)));
            }
            else if (/^##? /.test(line)) {
                body.push(color(line.replace(/^##? /, ''), { fg: p.accent, bold: true }));
            }
            else if (line.startsWith('- ')) {
                body.push(color(' ', {}) + color('• ', { fg: p.green }) + color(line.slice(2), { fg: p.fg }));
            }
            else {
                body.push(color(line, { fg: p.muted }));
            }
        }
        if (modal.lines.length > contentHeight) {
            body[contentHeight - 1] = color(`… ${scroll + contentHeight > modal.lines.length ? 'end' : 'more'} · ↑/↓ scroll · Esc close`, { fg: p.dim, italic: true });
        }
        const boxLines = box(width, height, safeLabel(modal.title), true, p, body);
        const result = Array.from({ length: model.height }, () => '');
        for (let i = 0; i < boxLines.length && i + 1 < result.length; i += 1) {
            result[i + 1] = padAnsi('  ' + (boxLines[i] ?? ''), model.width);
        }
        return result;
    }
}
export function defaultStatus() {
    return { text: '', tone: 'normal' };
}
export function helpLines() {
    return [
        '## Nexus keyboard reference',
        '',
        '- F8 / Ctrl+O : switch focus between the file manager and the bash prompt',
        '- Arrow keys / h j k l : move through files',
        '- Tab : auto-complete the current shell command or path while the prompt is focused',
        '- Enter : open the focused directory (files are previewed on the right)',
        '- Backspace / u : go to the parent directory',
        '- Home / End / g / G : first or last item',
        '- PageUp / PageDown : move one page',
        '- Space : tag the current item and advance (multi-select)',
        '- / : filter the current directory',
        '- s : cycle sorting (name → size → date → type)',
        '- S : reverse the sort direction',
        '- . : show or hide dotfiles',
        '- r : refresh the directory',
        '',
        '## File operations',
        '- F1 : this help screen',
        '- F2 : full-screen viewer for the focused file',
        '- F3 : edit with $EDITOR / nano / vi',
        '- F4 : copy tagged items to a destination',
        '- F5 : move tagged items to a destination',
        '- F6 : delete tagged items (confirmation)',
        '- F7 : create a directory',
        '- F9 : actions menu',
        '- F10 or Ctrl+Q : quit Nexus (Ctrl+Q also works when the desktop captures F10)',
        '',
        '## Shell integration',
        'The prompt at the bottom sources ~/.bashrc, ~/.bash_aliases and ~/.bash_functions in an interactive bash.',
        'Aliases, functions and exported variables are available. `cd` changes are reflected in the file manager, and',
        'file-manager navigation changes the shell working directory.',
        '',
        'Interactive programs (vim, nano, top, htop, less, man, ssh, apt, sudo, …) temporarily take over the terminal.',
        'Prefix a command with ! to force interactive mode. Ctrl+C cancels a running non-interactive command.',
        '',
        'Tip: edit ~/.config/nexus-cli/config.json to change theme, editor, preview limits, Nerd Font icons and more.',
    ];
}
