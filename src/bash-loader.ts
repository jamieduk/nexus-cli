import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BashProfile } from './types.js';

const MAX_FILES = 24;
const MAX_BYTES = 1024 * 1024;

const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_@.:+-]+)=(.+)\s*$/gm;
const FUNCTION_RE = /^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_:.-]*)\s*(?:\(\s*\))?|([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\s*\))\s*\{?/gm;
const EXPORT_RE = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=/gm;
const SOURCE_RE = /^\s*(?:source|\.)\s+(.+?)\s*$/gm;

function expandHome(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed
    .replace(/^\$HOME(?=\/|$)/, os.homedir())
    .replace(/^\$\{HOME\}(?=\/|$)/, os.homedir());
}

function readSafe(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function trimAliasValue(value: string): string {
  let out = value.trim();
  if ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"'))) {
    out = out.slice(1, -1);
  }
  return out;
}

/**
 * Reads (never executes) the user's bash startup files to build a profile for
 * the UI. The real command runner sources the same files inside bash, so this
 * parser is only a fast, safe inventory for the footer and completions.
 */
export function loadBashProfile(): BashProfile {
  const aliases = new Map<string, string>();
  const functions = new Set<string>();
  const env = new Set<string>();
  const sources: string[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  const queue = [
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.bash_aliases'),
    path.join(os.homedir(), '.bash_functions'),
  ];

  while (queue.length > 0 && visited.size < MAX_FILES) {
    const next = queue.shift();
    if (!next) break;
    const file = path.resolve(next);
    if (visited.has(file)) continue;
    visited.add(file);
    const content = readSafe(file);
    if (content === null) continue;
    sources.push(file);

    for (const match of content.matchAll(ALIAS_RE)) {
      const name = match[1];
      const value = match[2];
      if (name && value !== undefined) aliases.set(name, trimAliasValue(value));
    }
    for (const match of content.matchAll(FUNCTION_RE)) {
      const name = match[1] ?? match[2];
      if (name) functions.add(name);
    }
    for (const match of content.matchAll(EXPORT_RE)) {
      if (match[1]) env.add(match[1]);
    }
    for (const match of content.matchAll(SOURCE_RE)) {
      const raw = match[1];
      if (!raw) continue;
      const expanded = expandHome(raw);
      if (expanded.startsWith('/') && fs.existsSync(expanded)) {
        queue.push(expanded);
      }
    }
  }

  if (sources.length === 0) {
    errors.push('No ~/.bashrc, ~/.bash_aliases or ~/.bash_functions found.');
  }
  if (!fs.existsSync(path.join(os.homedir(), '.bashrc'))) {
    errors.push('~/.bashrc is missing; aliases and functions may be unavailable.');
  }

  return {
    aliases,
    functions,
    env,
    sources,
    errors,
    loadedAt: Date.now(),
  };
}

export function bashProfileSummary(profile: BashProfile): string {
  const file = profile.sources.some((s) => s.endsWith('.bashrc')) ? '~/.bashrc' : 'bash startup files';
  return `Loaded ${profile.aliases.size} aliases and ${profile.functions.size} functions from ${file}`;
}

export function profileNames(profile: BashProfile): string[] {
  return [...new Set([...profile.aliases.keys(), ...profile.functions])].sort();
}

export function resolveHomeFile(value: string): string {
  return expandHome(value);
}
