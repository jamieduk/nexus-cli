import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config.js';
import type {
  AIConfig,
  PermissionStore,
  SelfImproveMode,
  SkillInfo,
  WebUiConfig,
} from './types.js';
import { DEFAULT_MODEL } from './types.js';

export function aiDir(): string {
  return configDir();
}

export function aiConfigPath(): string {
  return path.join(aiDir(), 'ai.json');
}

export function permissionsPath(): string {
  return path.join(aiDir(), 'permissions.json');
}

export function webConfigPath(): string {
  return path.join(aiDir(), 'web.json');
}

export function defaultPersonalityPath(): string {
  return path.join(aiDir(), 'personality.md');
}

export function defaultSkillsDir(): string {
  return path.join(aiDir(), 'skills');
}

export function defaultProjectsDir(): string {
  return path.join(aiDir(), 'projects');
}

export function defaultToolsDir(): string {
  return path.join(aiDir(), 'tools');
}

export function defaultMemoryDir(): string {
  return path.join(aiDir(), 'memory');
}

export function defaultMemoryPath(): string {
  return path.join(defaultMemoryDir(), 'notes.md');
}

export function defaultVaultDir(): string {
  return path.join(aiDir(), 'vault');
}

export function defaultAIConfig(): AIConfig {
  return {
    initialized: false,
    provider: process.env.NEXUS_AI_PROVIDER || 'ollama',
    baseUrl: process.env.NEXUS_AI_BASE_URL || 'http://localhost:11434',
    apiKey: process.env.NEXUS_AI_API_KEY || '',
    model: process.env.NEXUS_AI_MODEL || DEFAULT_MODEL,
    imageModel: process.env.NEXUS_AI_IMAGE_MODEL || '',
    temperature: 0.2,
    maxTokens: 8192,
    maxAgentSteps: 32,
    selfImprove: 'guided',
    personalityPath: defaultPersonalityPath(),
    skillsDir: defaultSkillsDir(),
    projectsDir: defaultProjectsDir(),
    toolsDir: defaultToolsDir(),
    memoryDir: defaultMemoryDir(),
    memoryPath: defaultMemoryPath(),
    vaultDir: defaultVaultDir(),
    webSearch: true,
    extraHeaders: {},
  };
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function dirValue(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return fallback;
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function selfImprove(value: unknown, fallback: SelfImproveMode): SelfImproveMode {
  return value === 'auto' || value === 'guided' || value === 'off' ? value : fallback;
}

function headers(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header === 'string' && key.trim() !== '') out[key.trim()] = header;
  }
  return out;
}

export function loadAIConfig(): AIConfig {
  const defaults = defaultAIConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(aiConfigPath(), 'utf8')) as Partial<Record<keyof AIConfig, unknown>>;
    return {
      initialized: bool(parsed.initialized, defaults.initialized),
      provider: str(parsed.provider, defaults.provider),
      baseUrl: str(parsed.baseUrl, defaults.baseUrl),
      apiKey: str(parsed.apiKey, defaults.apiKey),
      model: str(parsed.model, defaults.model),
      imageModel: str(parsed.imageModel, defaults.imageModel),
      temperature: num(parsed.temperature, defaults.temperature, 0, 2),
      maxTokens: num(parsed.maxTokens, defaults.maxTokens, 256, 131072),
      maxAgentSteps: num(parsed.maxAgentSteps, defaults.maxAgentSteps, 1, 200),
      selfImprove: selfImprove(parsed.selfImprove, defaults.selfImprove),
      personalityPath: dirValue(parsed.personalityPath, defaults.personalityPath),
      skillsDir: dirValue(parsed.skillsDir, defaults.skillsDir),
      projectsDir: dirValue(parsed.projectsDir, defaults.projectsDir),
      toolsDir: dirValue(parsed.toolsDir, defaults.toolsDir),
      memoryDir: dirValue(parsed.memoryDir, defaults.memoryDir),
      memoryPath: dirValue(parsed.memoryPath, defaults.memoryPath),
      vaultDir: dirValue(parsed.vaultDir, defaults.vaultDir),
      webSearch: bool(parsed.webSearch, defaults.webSearch),
      extraHeaders: headers(parsed.extraHeaders),
    };
  } catch {
    return defaults;
  }
}

export function saveAIConfig(config: AIConfig): void {
  fs.mkdirSync(aiDir(), { recursive: true, mode: 0o700 });
  const tmp = `${aiConfigPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, aiConfigPath());
}

export function loadPermissionStore(): PermissionStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8')) as PermissionStore;
    if (parsed && typeof parsed === 'object' && parsed.grants && typeof parsed.grants === 'object') return parsed;
  } catch {
    // Missing or corrupt permission store: start clean.
  }
  return { grants: {} };
}

export function savePermissionStore(store: PermissionStore): void {
  try {
    fs.mkdirSync(aiDir(), { recursive: true, mode: 0o700 });
    const tmp = `${permissionsPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, permissionsPath());
  } catch {
    // Best effort; permissions can be re-granted.
  }
}

export function loadWebConfig(): WebUiConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(webConfigPath(), 'utf8')) as Partial<WebUiConfig>;
    if (typeof parsed.passwordHash !== 'string' || typeof parsed.salt !== 'string') return null;
    return {
      enabled: parsed.enabled === true,
      host: typeof parsed.host === 'string' ? parsed.host : '127.0.0.1',
      port: typeof parsed.port === 'number' ? parsed.port : 8787,
      passwordHash: parsed.passwordHash,
      salt: parsed.salt,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveWebConfig(config: WebUiConfig): void {
  fs.mkdirSync(aiDir(), { recursive: true, mode: 0o700 });
  const tmp = `${webConfigPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, webConfigPath());
}

const DEFAULT_PERSONALITY = `# Nexus Agent Personality

You are **Nexus**, a senior Linux systems engineer and TypeScript developer living inside a terminal.

## Character
- Direct, calm and competent. You explain just enough, never waffle.
- You prefer doing over describing: inspect the real system with tools instead of guessing.
- You are careful with destructive actions and secrets, but you do not stall or ask for
  confirmation when the request is clear and the action is safe.
- You write clean, idiomatic code that matches the surrounding project.
- You keep the user informed with short progress notes while working.

## Working style
- Start immediately. Read the relevant files and environment before editing.
- Ask a clarifying question **only** when the request is genuinely ambiguous or when a
  destructive/irreversible action needs consent.
- Verify changes (typecheck, build, tests, or a smoke command) before declaring success.
- Prefer small, reversible edits over large rewrites.
- Never print secrets or API keys.
- When you finish, summarise exactly what changed and how it was verified.
`;

const DEFAULT_SKILLS: Record<string, string> = {
  'terminal-ops.md': `# Terminal Operations

Use the \`exec_command\` tool for shell work. Prefer non-interactive commands.
- Inspect before mutating: \`pwd\`, \`ls -la\`, \`git status\`.
- Use \`set_permissions\` rather than shelling out to chmod when possible.
- Long-running commands should use a timeout and be cancellable.
`,
  'code-review.md': `# Code Review

When reviewing code:
1. Read the whole changed file, not just the diff.
2. Look for correctness, security, error handling and missing tests.
3. Report findings ordered by severity with file:line references.
4. Do not rewrite code unless asked; offer concrete patches.
`,
  'file-management.md': `# File Management

- Resolve relative paths against the current working directory.
- Read a file before editing it so your old_string matches exactly.
- Preserve existing conventions, imports and formatting.
- Never delete data without explaining the consequence first.
`,
  'web-research.md': `# Web Research

Use \`web_search\` to find sources and \`web_fetch\` to read a specific page.
Quote or summarise sources with their URLs. Prefer primary documentation over blogs.
`,
  'self-improvement.md': `# Self Improvement

You may create new skills or tools when they would make future work faster or safer.
- Explain the benefit and the risk before creating anything.
- Skills are Markdown files in the skills directory; tools are executable scripts in the tools directory.
- Never create a tool that hides its actions, exfiltrates data or escalates privileges silently.
- After creating a skill, list it with \`list_skills\` to verify it loaded.
`,
};

const DEFAULT_MEMORY = `# Nexus Memory

Long-term notes the agent should remember across sessions. Keep this file concise.
`;

function writeIfMissing(file: string, content: string, mode = 0o600): void {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode });
    }
  } catch {
    // Best effort.
  }
}

export function ensureAgentAssets(config: AIConfig): void {
  fs.mkdirSync(aiDir(), { recursive: true, mode: 0o700 });
  writeIfMissing(config.personalityPath || defaultPersonalityPath(), DEFAULT_PERSONALITY);
  const skillsDir = config.skillsDir || defaultSkillsDir();
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(DEFAULT_SKILLS)) {
    writeIfMissing(path.join(skillsDir, name), content);
  }
  fs.mkdirSync(config.projectsDir || defaultProjectsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.toolsDir || defaultToolsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.memoryDir || defaultMemoryDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.vaultDir || defaultVaultDir(), { recursive: true, mode: 0o700 });
  writeIfMissing(config.memoryPath || defaultMemoryPath(), DEFAULT_MEMORY);
}

export function loadPersonality(config: AIConfig): string {
  const file = config.personalityPath || defaultPersonalityPath();
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_PERSONALITY;
  }
}

export function loadMemory(config: AIConfig): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const dir = config.memoryDir || defaultMemoryDir();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(md|markdown|txt|json)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const content = fs.readFileSync(file, 'utf8').trim();
        seen.add(path.resolve(file));
        if (content !== '') parts.push(`### ${entry.name}\n${content}`);
      } catch {
        // ignore unreadable memory file
      }
    }
  } catch {
    // no memory directory yet
  }
  const primary = config.memoryPath || defaultMemoryPath();
  if (!seen.has(path.resolve(primary))) {
    try {
      const content = fs.readFileSync(primary, 'utf8').trim();
      if (content !== '') parts.push(content);
    } catch {
      // no primary memory file yet
    }
  }
  return parts.join('\n\n').slice(0, 24000);
}

export function saveMemory(config: AIConfig, content: string): void {
  const dir = config.memoryDir || defaultMemoryDir();
  const file = config.memoryPath || path.join(dir, 'notes.md');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content.slice(0, 64000), { mode: 0o600 });
}

export function listVaultEntries(config: AIConfig): Array<{ name: string; updatedAt: number }> {
  const dir = config.vaultDir || defaultVaultDir();
  const entries: Array<{ name: string; updatedAt: number }> = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
      try {
        const stat = fs.statSync(path.join(dir, entry.name));
        entries.push({ name: entry.name.replace(/\.json$/i, ''), updatedAt: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  } catch {
    return entries;
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function readVaultEntry(config: AIConfig, name: string): { name: string; value: string; fields?: Record<string, string> } | null {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-');
  const file = path.join(config.vaultDir || defaultVaultDir(), `${safe}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const value = typeof parsed.value === 'string' ? parsed.value : '';
    const fields: Record<string, string> = {};
    if (parsed.fields && typeof parsed.fields === 'object') {
      for (const [key, field] of Object.entries(parsed.fields as Record<string, unknown>)) {
        if (typeof field === 'string') fields[key] = field;
      }
    }
    return { name: safe, value, fields };
  } catch {
    return null;
  }
}

export function writeVaultEntry(config: AIConfig, name: string, value: string, fields?: Record<string, string>): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'credential';
  const dir = config.vaultDir || defaultVaultDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safe}.json`);
  const payload = { name: safe, value, fields: fields ?? {}, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function listSkills(config: AIConfig): SkillInfo[] {
  const dirs = new Set<string>([config.skillsDir || defaultSkillsDir(), defaultSkillsDir()]);
  const skills: SkillInfo[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|markdown|txt)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      let content = '';
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
      const firstLine = content.split('\n').map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#'));
      const name = heading || entry.name.replace(/\.(md|markdown|txt)$/i, '');
      if (skills.some((skill) => skill.name === name)) continue;
      skills.push({
        name,
        description: (firstLine ?? '').replace(/^[-*]\s*/, '').slice(0, 160),
        path: file,
        content,
        custom: dir !== defaultSkillsDir(),
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listCustomTools(config: AIConfig): Array<{ name: string; path: string; description: string }> {
  const dir = config.toolsDir || defaultToolsDir();
  const tools: Array<{ name: string; path: string; description: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return tools;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(sh|bash|py|js|mjs|ts)$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let description = '';
    try {
      const content = fs.readFileSync(file, 'utf8').slice(0, 2000);
      description = /^(?:#|\/\/)\s*(?:description:\s*)?(.+)$/im.exec(content)?.[1]?.trim() ?? '';
    } catch {
      // ignore
    }
    tools.push({ name: entry.name, path: file, description: description.slice(0, 160) });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeSkill(config: AIConfig, name: string, content: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  const file = path.join(config.skillsDir || defaultSkillsDir(), safe.endsWith('.md') ? safe : `${safe}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

export function writeTool(config: AIConfig, name: string, content: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'tool';
  const ext = path.extname(safe) !== '' ? safe : `${safe}.sh`;
  const file = path.join(config.toolsDir || defaultToolsDir(), ext);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function writePersonality(config: AIConfig, content: string): string {
  const file = config.personalityPath || defaultPersonalityPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}
