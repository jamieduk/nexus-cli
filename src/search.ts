import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseSize } from './utils.js';

export type SearchMatchKind = 'name' | 'type' | 'size' | 'content' | 'any';

export interface SearchOptions {
  root: string;
  query?: string;
  name?: string;
  type?: string;
  content?: string;
  minSize?: number;
  maxSize?: number;
  mode?: SearchMatchKind;
  caseSensitive?: boolean;
  includeHidden?: boolean;
  recursive?: boolean;
  maxDepth?: number;
  maxResults?: number;
  maxFileBytes?: number;
  regex?: boolean;
}

export interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  matched: SearchMatchKind;
  line?: number;
  column?: number;
  snippet?: string;
}

const DEFAULT_IGNORED = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.cache', '.npm', '.yarn',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', '.turbo', 'target', 'dist', 'build', '.idea', '.vscode',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif',
  'mp3', 'ogg', 'opus', 'wav', 'flac', 'm4a', 'mp4', 'mkv', 'webm', 'mov', 'avi',
  'zip', 'gz', 'bz2', 'xz', 'tar', '7z', 'rar', 'pdf', 'so', 'o', 'a', 'bin',
  'exe', 'dll', 'deb', 'rpm', 'appimage', 'woff', 'woff2', 'ttf', 'otf', 'db',
]);

function tokenize(raw: string): Array<{ key: string | null; value: string }> {
  const tokens: Array<{ key: string | null; value: string }> = [];
  let current = '';
  let quote: string | null = null;
  const push = (token: string) => {
    const trimmed = token.trim();
    if (trimmed === '') return;
    const match = /^(name|file|type|ext|size|content|text|in|regex):(.*)$/i.exec(trimmed);
    if (match) tokens.push({ key: (match[1] ?? '').toLowerCase(), value: match[2] ?? '' });
    else tokens.push({ key: null, value: trimmed });
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? '';
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push(current);
      current = '';
      continue;
    }
    current += char;
  }
  push(current);
  return tokens;
}

function parseSizeTerm(value: string): { min?: number; max?: number } {
  const trimmed = value.trim();
  const range = /^(.*?)\.\.(.*)$/.exec(trimmed);
  if (range) {
    const min = parseSize(range[1] ?? '');
    const max = parseSize(range[2] ?? '');
    return { min: min ?? undefined, max: max ?? undefined };
  }
  const rangeDash = /^([0-9.]+\s*[bkmgtp]?)\s*-\s*([0-9.]+\s*[bkmgtp]?)$/i.exec(trimmed);
  if (rangeDash) {
    return { min: parseSize(rangeDash[1] ?? '') ?? undefined, max: parseSize(rangeDash[2] ?? '') ?? undefined };
  }
  const comparison = /^(>=|<=|>|<|=)\s*(.+)$/.exec(trimmed);
  if (comparison) {
    const amount = parseSize(comparison[2] ?? '');
    if (amount === null) return {};
    switch (comparison[1]) {
      case '>': return { min: amount + 1 };
      case '>=': return { min: amount };
      case '<': return { max: Math.max(0, amount - 1) };
      case '<=': return { max: amount };
      default: return { min: amount, max: amount };
    }
  }
  const exact = parseSize(trimmed);
  return exact === null ? {} : { min: exact, max: exact };
}

export function parseSearchQuery(raw: string, root: string): SearchOptions {
  const options: SearchOptions = { root: path.resolve(root), recursive: true };
  const plain: string[] = [];
  for (const token of tokenize(raw)) {
    if (token.key === null) {
      plain.push(token.value);
      continue;
    }
    switch (token.key) {
      case 'name':
      case 'file':
        options.name = token.value;
        break;
      case 'type':
      case 'ext':
        options.type = token.value.replace(/^\./, '').toLowerCase();
        break;
      case 'content':
      case 'text':
        options.content = token.value;
        break;
      case 'in':
        options.root = path.resolve(root, token.value);
        break;
      case 'regex':
        options.regex = true;
        if (token.value !== '') plain.push(token.value);
        break;
      case 'size': {
        const { min, max } = parseSizeTerm(token.value);
        if (min !== undefined) options.minSize = min;
        if (max !== undefined) options.maxSize = max;
        break;
      }
      default:
        plain.push(token.value);
        break;
    }
  }
  if (plain.length > 0) {
    const text = plain.join(' ');
    options.query = text;
    if (options.content === undefined && options.mode !== 'content') options.mode = 'any';
  }
  if (options.content !== undefined && options.name === undefined && options.query === undefined) {
    options.mode = 'content';
  }
  return options;
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

function makeMatcher(value: string, options: SearchOptions): (text: string) => boolean {
  if (options.regex) {
    try {
      const regex = new RegExp(value, options.caseSensitive ? '' : 'i');
      return (text) => regex.test(text);
    } catch {
      // Invalid regular expression: fall back to literal matching.
    }
  }
  const needle = options.caseSensitive ? value : value.toLowerCase();
  return (text) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
}

function snippetForLine(line: string, matcher: (text: string) => boolean, needle: string, caseSensitive: boolean): { column: number; snippet: string } {
  let column = 0;
  if (needle !== '') {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const target = caseSensitive ? needle : needle.toLowerCase();
    column = haystack.indexOf(target);
  }
  const start = Math.max(0, column - 60);
  const end = Math.min(line.length, Math.max(column, 0) + 120);
  const snippet = (start > 0 ? '…' : '') + line.slice(start, end).trim() + (end < line.length ? '…' : '');
  void matcher;
  return { column: Math.max(0, column), snippet };
}

export async function searchFiles(options: SearchOptions): Promise<SearchHit[]> {
  const root = path.resolve(options.root);
  const hits: SearchHit[] = [];
  const maxResults = Math.max(1, Math.min(5000, options.maxResults ?? 500));
  const maxDepth = Math.max(0, options.maxDepth ?? 24);
  const maxFileBytes = Math.max(1024, options.maxFileBytes ?? 2 * 1024 * 1024);
  const recursive = options.recursive !== false;
  const includeHidden = options.includeHidden === true;
  const matchers: Array<{ kind: Exclude<SearchMatchKind, 'any'>; test: (text: string) => boolean; needle: string }> = [];
  if (options.name !== undefined && options.name !== '') {
    matchers.push({ kind: 'name', test: makeMatcher(options.name, options), needle: options.name });
  }
  const anyNameMatcher = options.mode === 'any' && options.query !== undefined && options.query !== ''
    ? makeMatcher(options.query, options)
    : null;
  const contentNeedle = options.content
    ?? (options.mode === 'content' || options.mode === 'any' ? options.query : undefined);
  const contentMatcher = contentNeedle !== undefined && contentNeedle !== ''
    ? makeMatcher(contentNeedle, options)
    : null;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && hits.length < maxResults) {
    const next = stack.pop();
    if (!next) break;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hits.length >= maxResults) break;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (DEFAULT_IGNORED.has(entry.name)) continue;
      const full = path.join(next.dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(full);
      } catch {
        continue;
      }
      const isSymlink = stat.isSymbolicLink();
      let isDir = stat.isDirectory();
      let size = stat.size;
      if (isSymlink) {
        try {
          const target = await fsp.stat(full);
          isDir = target.isDirectory();
          size = target.size;
        } catch {
          isDir = false;
        }
      }
      const extension = path.extname(entry.name).slice(1).toLowerCase();

      if (isDir) {
        if (recursive && next.depth < maxDepth) stack.push({ dir: full, depth: next.depth + 1 });
        if (options.type === undefined && sizeWithin(size, options) && (
          (matchers.length > 0 && matchesAll(matchers, entry.name))
          || (anyNameMatcher !== null && anyNameMatcher(entry.name))
        )) {
          hits.push({ path: full, name: entry.name, isDir, size, mtime: stat.mtimeMs, matched: 'name' });
        }
        continue;
      }

      if (!sizeWithin(size, options)) continue;
      if (options.type !== undefined && options.type !== '' && extension !== options.type) continue;
      if (matchers.length > 0 && !matchesAll(matchers, entry.name)) continue;

      if (contentMatcher) {
        if (size > maxFileBytes || BINARY_EXTENSIONS.has(extension)) continue;
        let buffer: Buffer;
        try {
          buffer = await fsp.readFile(full);
        } catch {
          continue;
        }
        if (isProbablyBinary(buffer)) continue;
        const text = buffer.toString('utf8');
        const lines = text.split('\n');
        let found = false;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex] ?? '';
          if (!contentMatcher(line)) continue;
          const detail = snippetForLine(line, contentMatcher, contentNeedle ?? '', options.caseSensitive === true);
          hits.push({
            path: full,
            name: entry.name,
            isDir: false,
            size,
            mtime: stat.mtimeMs,
            matched: 'content',
            line: lineIndex + 1,
            column: detail.column + 1,
            snippet: detail.snippet,
          });
          found = true;
          break;
        }
        if (found) continue;
        if (matchers.length === 0 && !anyNameMatcher && options.type === undefined) continue;
      }

      if (anyNameMatcher && anyNameMatcher(entry.name)) {
        hits.push({ path: full, name: entry.name, isDir: false, size, mtime: stat.mtimeMs, matched: 'name' });
        continue;
      }
      if (anyNameMatcher && options.type === undefined && options.minSize === undefined && options.maxSize === undefined) {
        continue;
      }
      if (matchers.length > 0 || options.type !== undefined || options.minSize !== undefined || options.maxSize !== undefined) {
        const matched: SearchMatchKind = matchers.length > 0 ? matchers[0]?.kind ?? 'name' : options.type !== undefined ? 'type' : 'size';
        hits.push({ path: full, name: entry.name, isDir: false, size, mtime: stat.mtimeMs, matched });
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits;
}

function sizeWithin(size: number, options: SearchOptions): boolean {
  if (options.minSize !== undefined && size < options.minSize) return false;
  if (options.maxSize !== undefined && size > options.maxSize) return false;
  return true;
}

function matchesAll(matchers: Array<{ test: (text: string) => boolean }>, name: string): boolean {
  return matchers.every((matcher) => matcher.test(name));
}
