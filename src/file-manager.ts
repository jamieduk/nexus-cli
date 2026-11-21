import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  Config,
  FileItem,
  Palette,
  PreviewMeta,
  PreviewState,
  SortDirection,
  SortKey,
} from './types.js';
import { highlightLine, languageFromPath } from './highlight.js';
import { expandTabs, humanBytes, shortenPath, tildify } from './utils.js';

export interface FileOperationResult {
  ok: boolean;
  message: string;
  affected: string[];
}

const MIME_MAP: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', jsonl: 'application/x-ndjson', xml: 'application/xml',
  yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/toml', ini: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', scss: 'text/x-scss',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  py: 'text/x-python', sh: 'text/x-shellscript', bash: 'text/x-shellscript',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', hpp: 'text/x-c++',
  rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java', rb: 'text/x-ruby',
  php: 'text/x-php', sql: 'text/x-sql',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  bz2: 'application/x-bzip2', xz: 'application/x-xz', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', deb: 'application/vnd.debian.binary-package',
  appimage: 'application/x-executable', exe: 'application/x-msdownload',
  so: 'application/x-sharedlib', bin: 'application/octet-stream',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

const NERD_ICONS: Record<string, string> = {
  dir: '\uf07b', file: '\uf15b', symlink: '\uf481', exec: '\uf085',
  ts: '\ue628', js: '\ue74e', json: '\ue60b', md: '\ue609', txt: '\uf15c',
  sh: '\uf489', py: '\ue73c', html: '\ue736', css: '\ue749', image: '\uf1c5',
  video: '\uf03d', audio: '\uf001', pdf: '\uf1c1', archive: '\uf1c6',
  git: '\ue702', lock: '\uf023', config: '\ue615', log: '\uf18d',
};

const FALLBACK_ICONS: Record<string, string> = {
  dir: '▸', file: '·', symlink: '⇢', exec: '⚙',
  ts: '◇', js: '◇', json: '◇', md: '☰', txt: '☰',
  sh: '❯', py: '◈', html: '◇', css: '◈', image: '◫',
  video: '▶', audio: '♪', pdf: '▤', archive: '▤',
  git: '⎇', lock: '⚿', config: '⚙', log: '☰',
};

let userMap: Map<number, string> | null = null;
let groupMap: Map<number, string> | null = null;

function loadNames(file: string): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const id = Number(parts[2]);
        const name = parts[0];
        if (name !== undefined && Number.isFinite(id)) map.set(id, name);
      }
    }
  } catch {
    // Ignore unreadable account databases.
  }
  return map;
}

function userName(uid: number): string {
  userMap ??= loadNames('/etc/passwd');
  return userMap.get(uid) ?? String(uid);
}

function groupName(gid: number): string {
  groupMap ??= loadNames('/etc/group');
  return groupMap.get(gid) ?? String(gid);
}

function modeString(mode: number, isDir: boolean, isSymlink: boolean): string {
  const type = isDir ? 'd' : isSymlink ? 'l' : '-';
  const bits = [
    mode & 0o400 ? 'r' : '-', mode & 0o200 ? 'w' : '-',
    mode & 0o4000 ? (mode & 0o100 ? 's' : 'S') : mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-', mode & 0o020 ? 'w' : '-',
    mode & 0o2000 ? (mode & 0o010 ? 's' : 'S') : mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-', mode & 0o002 ? 'w' : '-',
    mode & 0o1000 ? (mode & 0o001 ? 't' : 'T') : mode & 0o001 ? 'x' : '-',
  ];
  return type + bits.join('');
}

function iconFor(name: string, item: Partial<FileItem>, config: Config): string {
  if (item.isParent) return '↰';
  const set = config.nerdFonts ? NERD_ICONS : FALLBACK_ICONS;
  if (item.isSymlink) return set.symlink ?? set.file ?? '·';
  if (item.isDir) return set.dir ?? '▸';
  if (item.isExecutable) return set.exec ?? '⚙';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (set[ext]) return set[ext] as string;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'avif', 'ico'].includes(ext)) return set.image ?? '◫';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return set.video ?? '▶';
  if (['mp3', 'ogg', 'opus', 'wav', 'flac', 'm4a'].includes(ext)) return set.audio ?? '♪';
  if (['zip', 'gz', 'bz2', 'xz', 'tar', '7z', 'rar'].includes(ext)) return set.archive ?? '▤';
  if (ext === 'pdf') return set.pdf ?? '▤';
  if (['md', 'markdown', 'txt', 'rst'].includes(ext)) return set.md ?? '☰';
  if (['sh', 'bash', 'zsh', 'fish', 'env'].includes(ext)) return set.sh ?? '❯';
  if (['json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg'].includes(ext)) return set.config ?? '⚙';
  if (['log'].includes(ext)) return set.log ?? '☰';
  return set.file ?? '·';
}

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / buffer.length > 0.2;
}

function safeRead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function hashFirstMegabyte(file: string): { hash: string; partial: boolean } {
  const size = fs.statSync(file).size;
  const bytes = Math.min(size, 1024 * 1024);
  const buffer = safeRead(file, bytes);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return { hash, partial: size > bytes };
}

function hexDump(buffer: Buffer, limit = 256): string[] {
  const lines: string[] = [];
  const max = Math.min(buffer.length, limit);
  for (let offset = 0; offset < max; offset += 16) {
    const slice = buffer.subarray(offset, Math.min(offset + 16, max));
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines;
}

function baseMeta(item: FileItem): PreviewMeta[] {
  return [
    { label: 'Path', value: tildify(item.path) },
    { label: 'Type', value: item.isDir ? 'Directory' : item.isSymlink ? 'Symlink' : 'File' },
    { label: 'Size', value: item.isDir ? '—' : humanBytes(item.size).trim() },
    { label: 'Permissions', value: item.modeString },
    { label: 'Owner', value: `${item.user}:${item.group}` },
    { label: 'Modified', value: new Date(item.mtime).toLocaleString() },
  ];
}

function diskMeta(dir: string): PreviewMeta | null {
  try {
    const stats = fs.statfsSync(dir);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { label: 'Disk free', value: `${humanBytes(free).trim()} / ${humanBytes(total).trim()}`, tone: 'muted' };
  } catch {
    return null;
  }
}

export class FileManager {
  cwd: string;
  items: FileItem[] = [];
  selectedIndex = 0;
  marked = new Set<string>();
  filter = '';
  sortBy: SortKey;
  sortAsc: boolean;
  showHidden: boolean;
  dirsFirst: boolean;
  error = '';

  private readonly config: Config;

  constructor(startDir: string, config: Config) {
    this.config = config;
    this.cwd = this.resolveDir(startDir);
    this.sortBy = config.sortBy;
    this.sortAsc = config.sortAsc;
    this.showHidden = config.showHidden;
    this.dirsFirst = config.dirsFirst;
    this.refresh();
    if (this.items.length > 1 && this.items[0]?.isParent) this.selectedIndex = 1;
  }

  private resolveDir(input: string): string {
    try {
      const resolved = path.resolve(input);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // fall through
    }
    return os.homedir();
  }

  get selected(): FileItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  updateConfig(config: Config): void {
    const iconsChanged = this.config.nerdFonts !== config.nerdFonts;
    this.sortBy = config.sortBy;
    this.sortAsc = config.sortAsc;
    this.showHidden = config.showHidden;
    this.dirsFirst = config.dirsFirst;
    this.config.nerdFonts = config.nerdFonts;
    this.config.theme = config.theme;
    if (iconsChanged) {
      for (const item of this.items) item.icon = iconFor(item.name, item, this.config);
    }
  }

  refresh(preserveSelection = true): void {
    const previous = preserveSelection ? this.selected?.path : null;
    this.error = '';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.cwd, { withFileTypes: true });
    } catch (error) {
      this.items = [];
      this.selectedIndex = 0;
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }

    const items: FileItem[] = [];
    for (const entry of entries) {
      if (!this.showHidden && entry.name.startsWith('.')) continue;
      const fullPath = path.join(this.cwd, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      const isSymlink = stat.isSymbolicLink();
      let target: string | undefined;
      let effectiveIsDir = stat.isDirectory();
      if (isSymlink) {
        try {
          target = fs.readlinkSync(fullPath);
          effectiveIsDir = fs.statSync(fullPath).isDirectory();
        } catch {
          effectiveIsDir = false;
        }
      }
      const isDir = effectiveIsDir;
      const mode = stat.mode & 0o777;
      const item: FileItem = {
        name: entry.name,
        path: fullPath,
        isDir,
        isSymlink,
        isExecutable: !isDir && (mode & 0o111) !== 0,
        hidden: entry.name.startsWith('.'),
        size: isDir ? 0 : stat.size,
        blocks: stat.blocks,
        mtime: stat.mtimeMs,
        mode,
        modeString: modeString(mode, isDir, isSymlink),
        uid: stat.uid,
        gid: stat.gid,
        user: userName(stat.uid),
        group: groupName(stat.gid),
        extension: path.extname(entry.name).slice(1).toLowerCase(),
        icon: '',
        target,
      };
      item.icon = iconFor(item.name, item, this.config);
      items.push(item);
    }

    if (this.filter.trim() !== '') {
      const needle = this.filter.trim().toLowerCase();
      items.splice(0, items.length, ...items.filter((item) => item.name.toLowerCase().includes(needle)));
    }

    const direction = this.sortAsc ? 1 : -1;
    items.sort((a, b) => {
      if (this.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let comparison = 0;
      switch (this.sortBy) {
        case 'size':
          comparison = a.size - b.size;
          break;
        case 'date':
          comparison = a.mtime - b.mtime;
          break;
        case 'type': {
          const extA = a.extension || (a.isDir ? '~dir' : '');
          const extB = b.extension || (b.isDir ? '~dir' : '');
          comparison = extA.localeCompare(extB, undefined, { sensitivity: 'base' });
          break;
        }
        case 'name':
        default:
          comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
          break;
      }
      if (comparison === 0) comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return comparison * direction;
    });

    if (this.filter.trim() === '') {
      const parentPath = path.dirname(this.cwd);
      if (parentPath !== this.cwd) {
        let parentStat: fs.Stats | null = null;
        try {
          parentStat = fs.lstatSync(parentPath);
        } catch {
          parentStat = null;
        }
        const parent: FileItem = {
          name: '../',
          path: parentPath,
          isDir: true,
          isSymlink: false,
          isExecutable: false,
          hidden: false,
          size: 0,
          blocks: parentStat?.blocks ?? 0,
          mtime: parentStat?.mtimeMs ?? Date.now(),
          mode: 0,
          modeString: 'd---------',
          uid: parentStat?.uid ?? 0,
          gid: parentStat?.gid ?? 0,
          user: parentStat ? userName(parentStat.uid) : '',
          group: parentStat ? groupName(parentStat.gid) : '',
          extension: '',
          icon: '↰',
          isParent: true,
        };
        items.unshift(parent);
      }
    }

    this.items = items;
    if (previous) {
      const nextIndex = items.findIndex((item) => item.path === previous);
      this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, items.length - 1);
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, items.length - 1);
    }
    if (this.selectedIndex < 0) this.selectedIndex = 0;

    const valid = new Set(items.map((item) => item.path));
    for (const marked of [...this.marked]) {
      if (!valid.has(marked)) this.marked.delete(marked);
    }
  }

  setCwd(dir: string): boolean {
    const resolved = path.resolve(dir);
    try {
      if (!fs.statSync(resolved).isDirectory()) return false;
    } catch {
      return false;
    }
    this.cwd = resolved;
    this.selectedIndex = 0;
    this.filter = '';
    this.refresh(false);
    this.selectedIndex = this.items.length > 1 && this.items[0]?.isParent ? 1 : 0;
    return true;
  }

  goUp(): boolean {
    const parent = path.dirname(this.cwd);
    if (parent === this.cwd) return false;
    return this.setCwd(parent);
  }

  goHome(): boolean {
    return this.setCwd(os.homedir());
  }

  move(delta: number): void {
    if (this.items.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
  }

  page(delta: number, pageSize: number): void {
    this.move(delta * Math.max(1, pageSize));
  }

  selectFirst(): void {
    this.selectedIndex = 0;
  }

  selectLast(): void {
    this.selectedIndex = Math.max(0, this.items.length - 1);
  }

  toggleMark(): void {
    const item = this.selected;
    if (!item || item.isParent) return;
    if (this.marked.has(item.path)) this.marked.delete(item.path);
    else this.marked.add(item.path);
    this.move(1);
  }

  clearMarks(): void {
    this.marked.clear();
  }

  cycleSort(): SortKey {
    const order: SortKey[] = ['name', 'size', 'date', 'type'];
    const current = order.indexOf(this.sortBy);
    this.sortBy = order[(current + 1) % order.length] ?? 'name';
    this.refresh();
    return this.sortBy;
  }

  toggleSortDirection(): boolean {
    this.sortAsc = !this.sortAsc;
    this.refresh();
    return this.sortAsc;
  }

  toggleHidden(): boolean {
    this.showHidden = !this.showHidden;
    this.refresh();
    return this.showHidden;
  }

  toggleDirsFirst(): boolean {
    this.dirsFirst = !this.dirsFirst;
    this.refresh();
    return this.dirsFirst;
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh(false);
    this.selectedIndex = 0;
  }

  markedItems(): FileItem[] {
    return this.items.filter((item) => this.marked.has(item.path));
  }

  actionItems(): FileItem[] {
    const marked = this.markedItems().filter((item) => item.isParent !== true);
    if (marked.length > 0) return marked;
    const selected = this.selected;
    return selected && selected.isParent !== true ? [selected] : [];
  }

  selectPath(target: string): boolean {
    const resolved = path.resolve(target);
    const index = this.items.findIndex((item) => item.path === resolved);
    if (index < 0) return false;
    this.selectedIndex = index;
    return true;
  }

  preview(item: FileItem | null, palette: Palette, config: Config): PreviewState {
    if (!item) {
      return emptyPreview('Nothing selected', 'Use the arrow keys or hjkl to choose a file.');
    }

    if (item.isParent) {
      return {
        kind: 'directory',
        title: '../',
        subtitle: 'Parent directory',
        lines: [],
        meta: [
          { label: 'Path', value: tildify(item.path) },
          { label: 'Type', value: 'Parent directory', tone: 'muted' },
          { label: 'Action', value: 'Press Enter to go up', tone: 'muted' },
        ],
        hex: [],
        language: 'text',
        scroll: 0,
        loading: false,
        truncated: false,
      };
    }

    if (item.isDir) {
      const meta = baseMeta(item);
      meta[2] = { label: 'Size', value: 'calculating…', tone: 'muted' };
      let count = 0;
      try {
        count = fs.readdirSync(item.path).length;
      } catch {
        return {
          kind: 'permission',
          title: item.name,
          subtitle: 'Directory',
          lines: ['Permission denied while reading this directory.'],
          meta,
          hex: [],
          language: 'text',
          scroll: 0,
          loading: false,
          truncated: false,
          error: 'Permission denied',
        };
      }
      meta.push({ label: 'Items', value: String(count) });
      const disk = diskMeta(item.path);
      if (disk) meta.push(disk);
      if (item.isSymlink && item.target) meta.push({ label: 'Symlink', value: item.target, tone: 'muted' });
      return {
        kind: 'directory',
        title: item.name,
        subtitle: `Directory · ${count} item${count === 1 ? '' : 's'}`,
        lines: [],
        meta,
        hex: [],
        language: 'text',
        scroll: 0,
        loading: true,
        truncated: false,
      };
    }

    const meta = baseMeta(item);
    if (item.isSymlink && item.target) meta.push({ label: 'Symlink', value: item.target, tone: 'muted' });
    const mime = mimeForPath(item.path);
    meta.push({ label: 'MIME', value: mime, tone: 'muted' });

    let buffer: Buffer;
    try {
      buffer = safeRead(item.path, Math.max(4096, config.maxPreviewBytes));
    } catch (error) {
      return {
        kind: 'permission',
        title: item.name,
        subtitle: 'Unreadable file',
        lines: [error instanceof Error ? error.message : String(error)],
        meta,
        hex: [],
        language: 'text',
        scroll: 0,
        loading: false,
        truncated: false,
        error: 'Unreadable',
      };
    }

    if (isProbablyBinary(buffer)) {
      let checksumHash = 'unavailable';
      let partial = false;
      try {
        const checksum = hashFirstMegabyte(item.path);
        checksumHash = checksum.hash;
        partial = checksum.partial;
      } catch {
        // The file may have disappeared between listing and preview.
      }
      meta.push({ label: 'SHA-256', value: checksumHash === 'unavailable' ? 'unavailable' : checksumHash.slice(0, 16) + '…', tone: 'muted' });
      meta.push({ label: 'Checksum', value: partial ? 'first 1 MiB' : 'whole file', tone: 'muted' });
      return {
        kind: 'binary',
        title: item.name,
        subtitle: `Binary · ${mime}`,
        lines: [],
        meta,
        hex: hexDump(buffer),
        language: 'text',
        scroll: 0,
        loading: false,
        truncated: buffer.length >= config.maxPreviewBytes,
        mime,
        checksum: checksumHash === 'unavailable' ? undefined : checksumHash,
      };
    }

    let text = buffer.toString('utf8');
    if (text.length > 0 && text.includes('\u0000')) {
      return {
        kind: 'binary',
        title: item.name,
        subtitle: `Binary · ${mime}`,
        lines: [],
        meta,
        hex: hexDump(buffer),
        language: 'text',
        scroll: 0,
        loading: false,
        truncated: false,
        mime,
      };
    }
    let lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;
    const truncated = item.size > buffer.length || lines.length > config.previewLines;
    lines = lines.slice(0, config.previewLines);
    const language = languageFromPath(item.path);
    const highlighted = lines.map((line) => {
      const cleanLine = line.replace(/\r$/, '');
      const capped = cleanLine.length > 2000 ? cleanLine.slice(0, 2000) + '…' : cleanLine;
      return highlightLine(expandTabs(capped, 4), language, palette);
    });
    meta.push({ label: 'Lines', value: `${Math.min(lines.length, config.previewLines)}${truncated ? '+' : ''}`, tone: 'muted' });
    return {
      kind: 'text',
      title: item.name,
      subtitle: `${language} · ${humanBytes(item.size).trim()}`,
      lines: highlighted,
      meta,
      hex: [],
      language,
      scroll: 0,
      loading: false,
      truncated,
      mime,
      totalLines,
    };
  }


  viewer(item: FileItem | null, palette: Palette, config: Config): { lines: string[]; truncated: boolean } {
    if (!item || item.isDir) return { lines: [], truncated: false };
    const maxBytes = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, config.maxPreviewBytes * 8));
    let buffer: Buffer;
    try {
      buffer = safeRead(item.path, maxBytes);
    } catch {
      return { lines: ['Unable to read this file.'], truncated: false };
    }
    if (isProbablyBinary(buffer)) {
      return { lines: hexDump(buffer, 4096), truncated: item.size > 4096 };
    }
    const text = buffer.toString('utf8');
    let lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const truncated = item.size > buffer.length || lines.length > 2000;
    lines = lines.slice(0, 2000);
    const language = languageFromPath(item.path);
    return {
      lines: lines.map((line) => {
        const capped = line.length > 4000 ? line.slice(0, 4000) + '…' : line;
        return highlightLine(expandTabs(capped, 4), language, palette);
      }),
      truncated,
    };
  }

  async directorySize(dir: string): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn('du', ['-sb', dir], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null);
      }, 2500);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          finish(null);
          return;
        }
        const first = output.split('\n')[0]?.split(/\s+/)[0];
        const size = first ? Number(first) : NaN;
        finish(Number.isFinite(size) ? size : null);
      });
    });
  }

  async enrichPreview(item: FileItem | null, preview: PreviewState): Promise<PreviewState> {
    if (!item || item.isParent || preview.kind !== 'directory') return preview;
    const size = await this.directorySize(item.path);
    const next: PreviewState = {
      ...preview,
      meta: preview.meta.map((meta) => {
        if (meta.label === 'Size') {
          return { ...meta, value: size === null ? 'unavailable' : humanBytes(size).trim(), tone: size === null ? 'warn' : 'normal' };
        }
        return meta;
      }),
      loading: false,
    };
    return next;
  }

  resolveDestination(input: string): string {
    const trimmed = input.trim();
    if (trimmed === '') return this.cwd;
    if (trimmed === '~') return os.homedir();
    if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
    return path.resolve(this.cwd, trimmed);
  }

  private static async copyOne(source: string, destination: string): Promise<void> {
    const target = destination;
    await fsp.cp(source, target, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }

  async copyTo(destination: string): Promise<FileOperationResult> {
    const sources = this.actionItems();
    if (sources.length === 0) return { ok: false, message: 'Nothing selected.', affected: [] };
    const dest = this.resolveDestination(destination);
    let destIsDir = false;
    try {
      destIsDir = fs.statSync(dest).isDirectory();
    } catch {
      destIsDir = false;
    }
    if (sources.length > 1 && !destIsDir) {
      return { ok: false, message: 'Select a directory when copying multiple items.', affected: [] };
    }

    const affected: string[] = [];
    for (const source of sources) {
      const target = destIsDir ? path.join(dest, path.basename(source.path)) : dest;
      if (path.resolve(source.path) === path.resolve(target)) {
        return { ok: false, message: 'Source and destination are the same.', affected };
      }
      if (path.resolve(target).startsWith(path.resolve(source.path) + path.sep)) {
        return { ok: false, message: 'Cannot copy a directory into itself.', affected };
      }
      try {
        fs.lstatSync(target);
        return { ok: false, message: `Destination already exists: ${shortenPath(target, 60)}`, affected };
      } catch {
        // Target does not exist (expected).
      }
      try {
        await FileManager.copyOne(source.path, target);
        affected.push(target);
      } catch (error) {
        return {
          ok: false,
          message: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
          affected,
        };
      }
    }
    this.refresh();
    this.clearMarks();
    return { ok: true, message: `Copied ${affected.length} item${affected.length === 1 ? '' : 's'}.`, affected };
  }

  async moveTo(destination: string): Promise<FileOperationResult> {
    const sources = this.actionItems();
    if (sources.length === 0) return { ok: false, message: 'Nothing selected.', affected: [] };
    const dest = this.resolveDestination(destination);
    let destIsDir = false;
    try {
      destIsDir = fs.statSync(dest).isDirectory();
    } catch {
      destIsDir = false;
    }
    if (sources.length > 1 && !destIsDir) {
      return { ok: false, message: 'Select a directory when moving multiple items.', affected: [] };
    }

    const affected: string[] = [];
    for (const source of sources) {
      const target = destIsDir ? path.join(dest, path.basename(source.path)) : dest;
      if (path.resolve(source.path) === path.resolve(target)) {
        return { ok: false, message: 'Source and destination are the same.', affected };
      }
      if (path.resolve(target).startsWith(path.resolve(source.path) + path.sep)) {
        return { ok: false, message: 'Cannot move a directory into itself.', affected };
      }
      try {
        fs.lstatSync(target);
        return { ok: false, message: `Destination already exists: ${shortenPath(target, 60)}`, affected };
      } catch {
        // Target does not exist (expected).
      }
      try {
        await fsp.rename(source.path, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV') {
          return {
            ok: false,
            message: `Move failed: ${error instanceof Error ? error.message : String(error)}`,
            affected,
          };
        }
        try {
          await FileManager.copyOne(source.path, target);
          await fsp.rm(source.path, { recursive: true, force: true });
        } catch (fallbackError) {
          return {
            ok: false,
            message: `Move failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            affected,
          };
        }
      }
      affected.push(target);
    }
    this.refresh();
    this.clearMarks();
    return { ok: true, message: `Moved ${affected.length} item${affected.length === 1 ? '' : 's'}.`, affected };
  }

  async deleteMarked(): Promise<FileOperationResult> {
    const sources = this.actionItems();
    if (sources.length === 0) return { ok: false, message: 'Nothing selected.', affected: [] };
    const affected: string[] = [];
    for (const source of sources) {
      try {
        await fsp.rm(source.path, { recursive: true, force: true });
        affected.push(source.path);
      } catch (error) {
        return {
          ok: false,
          message: `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
          affected,
        };
      }
    }
    this.refresh();
    this.clearMarks();
    return { ok: true, message: `Deleted ${affected.length} item${affected.length === 1 ? '' : 's'}.`, affected };
  }

  async makeDirectory(name: string): Promise<FileOperationResult> {
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, message: 'Directory name is empty.', affected: [] };
    const target = path.resolve(this.cwd, trimmed);
    try {
      await fsp.mkdir(target, { recursive: false });
      this.refresh();
      return { ok: true, message: `Created ${shortenPath(target, 50)}.`, affected: [target] };
    } catch (error) {
      return {
        ok: false,
        message: `mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
        affected: [],
      };
    }
  }
}

export function emptyPreview(title = 'Preview', subtitle = 'Select a file to inspect it.'): PreviewState {
  return {
    kind: 'empty',
    title,
    subtitle,
    lines: [],
    meta: [],
    hex: [],
    language: 'text',
    scroll: 0,
    loading: false,
    truncated: false,
  };
}
