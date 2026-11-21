import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { searchFiles } from '../search.js';
import { humanBytes, parseSize, sanitizeCommandOutput } from '../utils.js';
import { listCustomTools, listSkills, listVaultEntries, loadMemory, readVaultEntry, saveMemory, writeVaultEntry, writePersonality, writeSkill, writeTool, } from './settings.js';
function schema(name, description, properties, required) {
    return {
        type: 'function',
        function: {
            name,
            description,
            parameters: { type: 'object', properties, required, additionalProperties: false },
        },
    };
}
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
export const TOOL_SCHEMAS = [
    schema('read_file', 'Read a text file from disk. Returns the content with line numbers.', {
        path: str('File path, absolute or relative to the current working directory.'),
        offset: num('First line to return (1-based). Optional.'),
        limit: num('Maximum number of lines to return (default 400).'),
    }, ['path']),
    schema('write_file', 'Create or overwrite a file with new content. Creates parent directories.', {
        path: str('File path.'),
        content: str('Complete file content.'),
    }, ['path', 'content']),
    schema('edit_file', 'Replace an exact string in a file. Read the file first so old_string matches.', {
        path: str('File path.'),
        old_string: str('Exact text to replace.'),
        new_string: str('Replacement text.'),
        replace_all: bool('Replace every occurrence instead of requiring a unique match.'),
    }, ['path', 'old_string', 'new_string']),
    schema('list_directory', 'List the contents of a directory with type and size.', {
        path: str('Directory path (default current working directory).'),
    }, []),
    schema('search_files', 'Search files by name, extension/type, size or text content.', {
        path: str('Directory to search recursively (default current working directory).'),
        query: str('Text to look for in names and/or file contents.'),
        name: str('Only match this text in file names.'),
        type: str('Only files with this extension (without the dot).'),
        content: str('Only files containing this text.'),
        min_size: str('Minimum size, e.g. "10K", "1M", "1.5G".'),
        max_size: str('Maximum size, e.g. "10M".'),
        regex: bool('Treat query/name/content as a regular expression.'),
        include_hidden: bool('Include dotfiles and hidden directories.'),
        max_results: num('Maximum results (default 100, max 1000).'),
    }, []),
    schema('make_directory', 'Create a directory (including missing parents).', {
        path: str('Directory path to create.'),
    }, ['path']),
    schema('copy_path', 'Copy a file or directory recursively to a new location.', {
        source: str('Existing file or directory.'),
        destination: str('Destination file or directory.'),
        overwrite: bool('Replace an existing destination (default false).'),
    }, ['source', 'destination']),
    schema('move_file', 'Move or rename a file or directory.', {
        source: str('Existing path.'),
        destination: str('New path.'),
    }, ['source', 'destination']),
    schema('delete_path', 'Delete a file or directory recursively. This is irreversible.', {
        path: str('Path to delete.'),
    }, ['path']),
    schema('set_permissions', 'Change POSIX permissions. Supports execute bits and recursive mode.', {
        path: str('File or directory path.'),
        mode: str('Octal mode such as "755", "644" or "u+x".'),
        recursive: bool('Apply to every descendant of a directory.'),
    }, ['path', 'mode']),
    schema('exec_command', 'Run a non-interactive shell command in bash and return its output.', {
        command: str('Shell command to execute.'),
        cwd: str('Working directory (default current working directory).'),
        timeout_ms: num('Timeout in milliseconds (default 120000, max 600000).'),
    }, ['command']),
    schema('web_search', 'Search the web and return result titles, URLs and snippets.', {
        query: str('Search query.'),
        max_results: num('Maximum results (default 6).'),
    }, ['query']),
    schema('web_fetch', 'Fetch a URL and return readable text (HTML is stripped).', {
        url: str('Absolute http(s) URL.'),
        max_chars: num('Maximum characters to return (default 20000).'),
    }, ['url']),
    schema('ask_user', 'Ask the user a question when the request is truly ambiguous. Use sparingly.', {
        question: str('A short, specific question.'),
    }, ['question']),
    schema('list_skills', 'List the skills available to this agent.', {}, []),
    schema('remember', 'Append a durable note to your long-term memory file.', {
        note: str('Concise fact or preference worth remembering.'),
    }, ['note']),
    schema('create_skill', 'Create a new reusable skill (Markdown instructions) for future sessions.', {
        name: str('Skill file name, e.g. "rust-debugging".'),
        description: str('One line explaining the benefit of this skill.'),
        content: str('Full Markdown content of the skill.'),
    }, ['name', 'description', 'content']),
    schema('create_tool', 'Create a new executable tool script in the tools directory.', {
        name: str('Tool file name, e.g. "backup-db.sh".'),
        description: str('One line explaining what the tool does and why it helps.'),
        content: str('Script source. A shebang is added when missing.'),
    }, ['name', 'description', 'content']),
    schema('update_personality', 'Improve the persistent personality/instructions file.', {
        description: str('Why the personality should change.'),
        content: str('Complete replacement Markdown personality.'),
    }, ['description', 'content']),
    schema('run_custom_tool', 'Run a tool from the Nexus tools directory by file name.', {
        name: str('Tool file name.'),
        args: { type: 'object', description: 'Arguments exposed to the script as JSON in NEXUS_TOOL_ARGS.' },
    }, ['name']),
    schema('vault_list', 'List credential names stored in the vault (values are not returned).', {}, []),
    schema('vault_get', 'Read a credential from the vault. Use for GitHub tokens, API keys and similar secrets.', {
        name: str('Vault entry name, e.g. "github".'),
    }, ['name']),
    schema('vault_set', 'Store or update a credential in the vault (written with 0600 permissions).', {
        name: str('Vault entry name, e.g. "github".'),
        value: str('Secret value such as a token or password.'),
        fields: { type: 'object', description: 'Optional extra key/value fields, e.g. username or host.' },
    }, ['name', 'value']),
    schema('generate_image', 'Generate an image with the configured image model and save it to disk.', {
        prompt: str('Image description.'),
        path: str('Output file path (default: <projects>/generated-<timestamp>.png).'),
    }, ['prompt']),
];
function expandPath(input, cwd) {
    const value = input.trim();
    if (value === '')
        return cwd;
    if (value === '~')
        return os.homedir();
    if (value.startsWith('~/'))
        return path.join(os.homedir(), value.slice(2));
    return path.resolve(cwd, value);
}
function clampNumber(value, fallback, min, max) {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}
function stringArg(args, key, fallback = '') {
    const value = args[key];
    return typeof value === 'string' ? value : fallback;
}
function denial(ctx, prefix = 'Permission denied by user.') {
    const reason = ctx.permissions.consumeDenialReason();
    return reason === '' ? prefix : `${prefix}\nThe user suggested a different approach: ${reason}`;
}
function isInside(child, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function guardVault(ctx, target, write) {
    if (!isInside(target, ctx.config.vaultDir))
        return true;
    return ctx.permissions.ensure({
        id: write ? 'vault:write' : 'vault:access',
        title: write ? 'Write to the credential vault' : 'Access the credential vault',
        description: `The path ${target} is inside the credential vault.`,
        risk: 'high',
    });
}
function parseMode(value) {
    const trimmed = value.trim();
    if (/^[0-7]{3,4}$/.test(trimmed))
        return Number.parseInt(trimmed, 8) & 0o7777;
    const match = /^([ugoa]*)([+-=])([rwxXst]+)$/.exec(trimmed);
    if (!match)
        return null;
    return { symbolic: trimmed };
}
function modeFromOctal(value) {
    const trimmed = value.trim();
    if (!/^[0-7]{3,4}$/.test(trimmed))
        return null;
    return Number.parseInt(trimmed, 8) & 0o7777;
}
async function walk(root, fn, depth = 0) {
    if (depth > 40)
        return;
    let entries;
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        await fn(full);
        if (entry.isDirectory() && !entry.isSymbolicLink())
            await walk(full, fn, depth + 1);
    }
}
function decodeEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return text
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&([a-z]+);/gi, (all, name) => named[name.toLowerCase()] ?? all);
}
function stripHtml(html) {
    return decodeEntities(html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function execCommand(command, cwd, timeoutMs, signal, env = {}) {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-lc', command], {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NEXUS_AGENT: '1', ...env },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const limit = 200 * 1024;
        const finish = (code, cancelled = false) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener('abort', onAbort);
            resolve({ code, output: sanitizeCommandOutput(stdout + (stderr ? `\n${stderr}` : '')).slice(-limit), cancelled });
        };
        const kill = () => {
            try {
                if (typeof child.pid === 'number')
                    process.kill(-child.pid, 'SIGKILL');
                else
                    child.kill('SIGKILL');
            }
            catch {
                // already gone
            }
        };
        const onAbort = () => {
            kill();
            finish(130, true);
        };
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
        const timer = setTimeout(() => {
            kill();
            finish(124, false);
        }, Math.max(1000, timeoutMs));
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout = (stdout + chunk).slice(-limit);
        });
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-limit);
        });
        child.on('error', (error) => {
            stderr += `\n${error.message}`;
            finish(1);
        });
        child.on('close', (code, sig) => finish(code ?? (sig ? 130 : 1)));
    });
}
async function ensureSelfImprove(ctx, description) {
    if (ctx.config.selfImprove === 'off') {
        throw new Error('Self-improvement is disabled. Ask the user to enable it with /ai improve guided or auto.');
    }
    if (ctx.config.selfImprove === 'guided') {
        const allowed = await ctx.permissions.ensure({
            id: 'self:improve',
            title: 'Agent self-improvement',
            description,
            risk: 'medium',
        });
        if (!allowed)
            return false;
    }
    else {
        ctx.onSelfImprove?.(description);
    }
    return true;
}
async function executeInternal(name, args, ctx) {
    const cwd = ctx.cwd;
    switch (name) {
        case 'read_file': {
            const file = expandPath(stringArg(args, 'path'), cwd);
            if (!(await guardVault(ctx, file, false)))
                return { ok: false, output: denial(ctx) };
            const stat = await fsp.stat(file);
            if (stat.isDirectory())
                return { ok: false, output: `${file} is a directory; use list_directory.` };
            if (stat.size > 4 * 1024 * 1024)
                return { ok: false, output: 'File is larger than 4 MiB. Use exec_command with head/tail.' };
            const content = await fsp.readFile(file, 'utf8');
            const lines = content.split('\n');
            const offset = clampNumber(args.offset, 1, 1, Math.max(1, lines.length));
            const limit = clampNumber(args.limit, 400, 1, 4000);
            const slice = lines.slice(offset - 1, offset - 1 + limit);
            const numbered = slice.map((line, index) => `${String(offset + index).padStart(5)} │ ${line}`).join('\n');
            const suffix = offset - 1 + limit < lines.length ? `\n… ${lines.length} lines total; use offset to read more.` : '';
            return { ok: true, output: numbered + suffix };
        }
        case 'write_file': {
            const allowed = await ctx.permissions.ensure({
                id: 'files:write',
                title: 'Write files',
                description: `Create or overwrite files on this system.\n\nTarget: ${expandPath(stringArg(args, 'path'), cwd)}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const file = expandPath(stringArg(args, 'path'), cwd);
            if (!(await guardVault(ctx, file, true)))
                return { ok: false, output: denial(ctx) };
            const content = stringArg(args, 'content');
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.writeFile(file, content, 'utf8');
            return { ok: true, output: `Wrote ${content.length} bytes to ${file}` };
        }
        case 'edit_file': {
            const allowed = await ctx.permissions.ensure({
                id: 'files:write',
                title: 'Edit files',
                description: `Modify existing files on this system.\n\nTarget: ${expandPath(stringArg(args, 'path'), cwd)}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const file = expandPath(stringArg(args, 'path'), cwd);
            if (!(await guardVault(ctx, file, true)))
                return { ok: false, output: denial(ctx) };
            const oldString = stringArg(args, 'old_string');
            const newString = stringArg(args, 'new_string');
            if (oldString === '')
                return { ok: false, output: 'old_string must not be empty.' };
            const content = await fsp.readFile(file, 'utf8');
            const count = content.split(oldString).length - 1;
            if (count === 0)
                return { ok: false, output: 'old_string was not found in the file.' };
            if (count > 1 && args.replace_all !== true) {
                return { ok: false, output: `old_string occurs ${count} times. Provide more context or set replace_all.` };
            }
            const next = args.replace_all === true ? content.split(oldString).join(newString) : content.replace(oldString, newString);
            await fsp.writeFile(file, next, 'utf8');
            return { ok: true, output: `Updated ${file} (${count} occurrence${count === 1 ? '' : 's'}).` };
        }
        case 'list_directory': {
            const dir = expandPath(stringArg(args, 'path', '.'), cwd);
            if (!(await guardVault(ctx, dir, false)))
                return { ok: false, output: denial(ctx) };
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            const lines = entries
                .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
                .map((entry) => {
                let size = 0;
                try {
                    size = fs.lstatSync(path.join(dir, entry.name)).size;
                }
                catch {
                    // ignore
                }
                return `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-'} ${humanBytes(size, 6)}  ${entry.name}`;
            });
            return { ok: true, output: `${dir}\n${lines.join('\n')}` };
        }
        case 'search_files': {
            const root = expandPath(stringArg(args, 'path', '.'), cwd);
            if (!(await guardVault(ctx, root, false)))
                return { ok: false, output: denial(ctx) };
            const hits = await searchFiles({
                root,
                query: stringArg(args, 'query') || undefined,
                name: stringArg(args, 'name') || undefined,
                type: stringArg(args, 'type') || undefined,
                content: stringArg(args, 'content') || undefined,
                minSize: parseSize(stringArg(args, 'min_size')) ?? undefined,
                maxSize: parseSize(stringArg(args, 'max_size')) ?? undefined,
                maxResults: clampNumber(args.max_results, 100, 1, 1000),
                regex: args.regex === true,
                includeHidden: args.include_hidden === true,
                caseSensitive: false,
            }).catch((error) => {
                throw error instanceof Error ? error : new Error(String(error));
            });
            if (hits.length === 0)
                return { ok: true, output: 'No matching files.' };
            const lines = hits.map((hit) => {
                const where = hit.line ? `:${hit.line}` : '';
                const detail = hit.snippet ? ` — ${hit.snippet}` : '';
                return `${hit.path}${where}${detail}`;
            });
            return { ok: true, output: lines.join('\n'), data: hits };
        }
        case 'make_directory': {
            const allowed = await ctx.permissions.ensure({
                id: 'files:write',
                title: 'Create directories',
                description: `Create directories on this system.\n\nTarget: ${expandPath(stringArg(args, 'path'), cwd)}`,
                risk: 'medium',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const dir = expandPath(stringArg(args, 'path'), cwd);
            await fsp.mkdir(dir, { recursive: true });
            return { ok: true, output: `Created ${dir}` };
        }
        case 'copy_path': {
            const source = expandPath(stringArg(args, 'source'), cwd);
            const destination = expandPath(stringArg(args, 'destination'), cwd);
            if (path.resolve(source) === path.resolve(destination)) {
                return { ok: false, output: 'Source and destination are the same.' };
            }
            if (path.resolve(destination).startsWith(path.resolve(source) + path.sep)) {
                return { ok: false, output: 'Cannot copy a directory into itself.' };
            }
            const allowed = await ctx.permissions.ensure({
                id: 'files:copy',
                title: 'Copy files',
                description: `Copy ${source}\n  → ${destination}`,
                risk: 'medium',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            if (args.overwrite !== true && fs.existsSync(destination)) {
                return { ok: false, output: `Destination already exists: ${destination}` };
            }
            await fsp.cp(source, destination, {
                recursive: true,
                force: args.overwrite === true,
                errorOnExist: args.overwrite !== true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });
            return { ok: true, output: `Copied ${source} to ${destination}` };
        }
        case 'move_file': {
            const source = expandPath(stringArg(args, 'source'), cwd);
            const destination = expandPath(stringArg(args, 'destination'), cwd);
            const allowed = await ctx.permissions.ensure({
                id: 'files:move',
                title: 'Move or rename files',
                description: `Move ${source}\n  → ${destination}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            await fsp.rename(source, destination);
            return { ok: true, output: `Moved ${source} to ${destination}` };
        }
        case 'delete_path': {
            const target = expandPath(stringArg(args, 'path'), cwd);
            const allowed = await ctx.permissions.ensure({
                id: 'files:delete',
                title: 'Delete files or directories',
                description: `Permanently delete this path and everything inside it:\n\n${target}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            await fsp.rm(target, { recursive: true, force: true });
            return { ok: true, output: `Deleted ${target}` };
        }
        case 'set_permissions': {
            const target = expandPath(stringArg(args, 'path'), cwd);
            const allowed = await ctx.permissions.ensure({
                id: 'files:chmod',
                title: 'Change file permissions',
                description: `Change permissions (${stringArg(args, 'mode')}) of:\n\n${target}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const mode = modeFromOctal(stringArg(args, 'mode'));
            if (mode === null) {
                const symbolic = stringArg(args, 'mode');
                const result = await execCommand(`chmod ${args.recursive === true ? '-R ' : ''}${JSON.stringify(symbolic)} ${JSON.stringify(target)}`, cwd, 30000, ctx.signal);
                return { ok: result.code === 0, output: result.output || `chmod exited ${result.code}` };
            }
            if (args.recursive === true) {
                await walk(target, async (file) => {
                    try {
                        await fsp.chmod(file, mode);
                    }
                    catch {
                        // ignore individual failures
                    }
                });
            }
            await fsp.chmod(target, mode);
            return { ok: true, output: `Set ${target} to ${mode.toString(8)}` };
        }
        case 'exec_command': {
            const command = stringArg(args, 'command');
            const runCwd = expandPath(stringArg(args, 'cwd', '.'), cwd);
            const allowed = await ctx.permissions.ensure({
                id: 'exec:command',
                title: 'Run shell commands',
                description: `Execute commands as your user with your shell environment.\n\n${command.slice(0, 500)}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const result = await execCommand(command, runCwd, clampNumber(args.timeout_ms, 120000, 1000, 600000), ctx.signal);
            const status = result.cancelled ? 'cancelled' : `exit ${result.code}`;
            return { ok: result.code === 0 && !result.cancelled, output: `[${status}]\n${result.output}` };
        }
        case 'web_search': {
            if (!ctx.config.webSearch)
                return { ok: false, output: 'Web search is disabled in the Nexus AI config.' };
            const allowed = await ctx.permissions.ensure({
                id: 'network:web',
                title: 'Access the web',
                description: 'Search the web and fetch pages on your behalf.',
                risk: 'medium',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            return webSearch(stringArg(args, 'query'), clampNumber(args.max_results, 6, 1, 15), ctx.signal);
        }
        case 'web_fetch': {
            if (!ctx.config.webSearch)
                return { ok: false, output: 'Web access is disabled in the Nexus AI config.' };
            const allowed = await ctx.permissions.ensure({
                id: 'network:web',
                title: 'Access the web',
                description: 'Search the web and fetch pages on your behalf.',
                risk: 'medium',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            return webFetch(stringArg(args, 'url'), clampNumber(args.max_chars, 20000, 1000, 100000), ctx.signal);
        }
        case 'ask_user': {
            if (!ctx.askUser)
                return { ok: false, output: 'No interactive user is available in this mode. Proceed with the most reasonable assumption.' };
            const answer = await ctx.askUser(stringArg(args, 'question'));
            if (answer === null || answer.trim() === '')
                return { ok: false, output: 'The user did not answer.' };
            return { ok: true, output: answer };
        }
        case 'list_skills': {
            const skills = listSkills(ctx.config);
            if (skills.length === 0)
                return { ok: true, output: 'No skills found.' };
            return { ok: true, output: skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join('\n') };
        }
        case 'remember': {
            const note = stringArg(args, 'note').trim();
            if (note === '')
                return { ok: false, output: 'note must not be empty.' };
            const current = loadMemory(ctx.config);
            const next = `${current.trimEnd()}\n\n- ${new Date().toISOString().slice(0, 10)}: ${note}\n`;
            saveMemory(ctx.config, next);
            return { ok: true, output: 'Remembered.' };
        }
        case 'create_skill': {
            const name = stringArg(args, 'name');
            const description = stringArg(args, 'description');
            const content = stringArg(args, 'content');
            if (name === '' || content === '')
                return { ok: false, output: 'name and content are required.' };
            if (!(await ensureSelfImprove(ctx, `Create skill "${name}": ${description}`))) {
                return { ok: false, output: denial(ctx, 'Self-improvement denied by user.') };
            }
            const file = writeSkill(ctx.config, name, content);
            return { ok: true, output: `Created skill ${file}. It is available in future sessions.` };
        }
        case 'create_tool': {
            const name = stringArg(args, 'name');
            const description = stringArg(args, 'description');
            let content = stringArg(args, 'content');
            if (name === '' || content === '')
                return { ok: false, output: 'name and content are required.' };
            if (!(await ensureSelfImprove(ctx, `Create tool "${name}": ${description}`))) {
                return { ok: false, output: denial(ctx, 'Self-improvement denied by user.') };
            }
            if (!content.startsWith('#!')) {
                if (/\.py$/i.test(name))
                    content = `#!/usr/bin/env python3\n${content}`;
                else if (/\.(js|mjs)$/i.test(name))
                    content = `#!/usr/bin/env node\n${content}`;
                else
                    content = `#!/usr/bin/env bash\n${content}`;
            }
            const file = writeTool(ctx.config, name, content);
            return { ok: true, output: `Created executable tool ${file}. Call it with run_custom_tool.` };
        }
        case 'update_personality': {
            const content = stringArg(args, 'content');
            const description = stringArg(args, 'description');
            if (content.trim() === '')
                return { ok: false, output: 'content is required.' };
            if (!(await ensureSelfImprove(ctx, `Update personality: ${description}`))) {
                return { ok: false, output: denial(ctx, 'Self-improvement denied by user.') };
            }
            const file = writePersonality(ctx.config, content);
            return { ok: true, output: `Updated personality at ${file}.` };
        }
        case 'run_custom_tool': {
            const name = stringArg(args, 'name');
            const tool = listCustomTools(ctx.config).find((entry) => entry.name === name);
            if (!tool)
                return { ok: false, output: `No custom tool named ${name}.` };
            const allowed = await ctx.permissions.ensure({
                id: 'exec:custom-tool',
                title: 'Run a custom agent tool',
                description: `Execute ${tool.name}\n\n${tool.description}`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const ext = path.extname(tool.path).toLowerCase();
            const interpreter = ext === '.py' ? 'python3' : ext === '.js' || ext === '.mjs' ? 'node' : 'bash';
            const result = await execCommand(`${interpreter} ${JSON.stringify(tool.path)}`, cwd, 120000, ctx.signal, { NEXUS_TOOL_ARGS: JSON.stringify(args.args ?? {}) });
            return { ok: result.code === 0, output: `[exit ${result.code}]\n${result.output}` };
        }
        case 'vault_list': {
            const allowed = await ctx.permissions.ensure({
                id: 'vault:access',
                title: 'Access the credential vault',
                description: `Read credential metadata from ${ctx.config.vaultDir}. Secrets are only revealed on explicit vault_get calls.`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const entries = listVaultEntries(ctx.config);
            if (entries.length === 0)
                return { ok: true, output: 'The vault is empty.' };
            return { ok: true, output: entries.map((entry) => `${entry.name} (updated ${new Date(entry.updatedAt).toISOString()})`).join('\n') };
        }
        case 'vault_get': {
            const name = stringArg(args, 'name');
            const allowed = await ctx.permissions.ensure({
                id: 'vault:access',
                title: 'Access the credential vault',
                description: `Reveal the secret stored as "${name}" in the vault.`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const entry = readVaultEntry(ctx.config, name);
            if (!entry)
                return { ok: false, output: `No vault entry named ${name}.` };
            const extra = Object.entries(entry.fields ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n');
            return { ok: true, output: `value: ${entry.value}${extra ? `\n${extra}` : ''}` };
        }
        case 'vault_set': {
            const name = stringArg(args, 'name');
            const value = stringArg(args, 'value');
            if (name === '' || value === '')
                return { ok: false, output: 'name and value are required.' };
            const allowed = await ctx.permissions.ensure({
                id: 'vault:write',
                title: 'Write to the credential vault',
                description: `Store or update the secret "${name}" in the vault.`,
                risk: 'high',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const fields = {};
            if (args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)) {
                for (const [key, field] of Object.entries(args.fields)) {
                    if (typeof field === 'string')
                        fields[key] = field;
                }
            }
            const file = writeVaultEntry(ctx.config, name, value, fields);
            return { ok: true, output: `Stored credential ${name} at ${file} (mode 0600).` };
        }
        case 'generate_image': {
            const allowed = await ctx.permissions.ensure({
                id: 'image:generate',
                title: 'Generate images',
                description: 'Send a prompt to the configured image model and save the result.',
                risk: 'medium',
            });
            if (!allowed)
                return { ok: false, output: denial(ctx) };
            const { AIClient } = await import('./client.js');
            const client = new AIClient(ctx.config);
            const output = stringArg(args, 'path') !== ''
                ? expandPath(stringArg(args, 'path'), cwd)
                : path.join(ctx.config.projectsDir, `generated-${Date.now()}.png`);
            const file = await client.generateImage(stringArg(args, 'prompt'), output, ctx.signal);
            return { ok: true, output: `Generated image saved to ${file}` };
        }
        default:
            return { ok: false, output: `Unknown tool: ${name}` };
    }
}
async function webSearch(query, maxResults, signal) {
    if (query.trim() === '')
        return { ok: false, output: 'query must not be empty.' };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let html = '';
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Nexus-Agent/1.0',
                Accept: 'text/html',
            },
            signal,
        });
        if (!response.ok)
            return { ok: false, output: `Search failed (HTTP ${response.status}).` };
        html = await response.text();
    }
    catch (error) {
        return { ok: false, output: `Search failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const results = [];
    const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
        let href = decodeEntities(match[1] ?? '');
        const title = stripHtml(match[2] ?? '').replace(/\s+/g, ' ').trim();
        const redirect = /uddg=([^&]+)/.exec(href);
        if (redirect)
            href = decodeURIComponent(redirect[1] ?? '');
        if (href.startsWith('//'))
            href = `https:${href}`;
        if (href === '' || title === '')
            continue;
        results.push({ title, url: href, snippet: '' });
    }
    const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let snippetIndex = 0;
    while ((match = snippetRegex.exec(html)) !== null && snippetIndex < results.length) {
        const target = results[snippetIndex];
        if (target)
            target.snippet = stripHtml(match[1] ?? '').replace(/\s+/g, ' ').trim();
        snippetIndex += 1;
    }
    if (results.length === 0)
        return { ok: false, output: 'No search results (the search provider may be blocking requests).' };
    return {
        ok: true,
        output: results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join('\n\n'),
        data: results,
    };
}
async function webFetch(url, maxChars, signal) {
    if (!/^https?:\/\//i.test(url))
        return { ok: false, output: 'Only http(s) URLs are supported.' };
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Nexus-Agent/1.0' },
            signal,
        });
        if (!response.ok)
            return { ok: false, output: `Fetch failed (HTTP ${response.status}).` };
        const text = await response.text();
        const isHtml = /html/i.test(response.headers.get('content-type') ?? '');
        const readable = isHtml ? stripHtml(text) : text;
        return { ok: true, output: readable.slice(0, maxChars) };
    }
    catch (error) {
        return { ok: false, output: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export async function executeTool(name, rawArguments, ctx) {
    let args = {};
    if (rawArguments.trim() !== '') {
        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                args = parsed;
        }
        catch {
            return { ok: false, output: `Tool arguments are not valid JSON: ${rawArguments.slice(0, 300)}` };
        }
    }
    try {
        return await executeInternal(name, args, ctx);
    }
    catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
}
/** Unused helper retained for symbolic chmod support in future. */
export function symbolicModeSupported() {
    return parseMode('u+x') !== null;
}
