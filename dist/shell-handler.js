import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sanitizeCommandOutput } from './utils.js';
const INTERACTIVE_COMMANDS = new Set([
    'vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'micro', 'code',
    'top', 'htop', 'btop', 'atop', 'less', 'more', 'most', 'man', 'info',
    'watch', 'ssh', 'telnet', 'mosh', 'tmux', 'screen', 'fzf', 'ncdu',
    'ranger', 'mc', 'vifm', 'passwd', 'su', 'visudo', 'vipw', 'crontab',
    'apt', 'apt-get', 'dpkg', 'dnf', 'yum', 'pacman', 'snap',
    'mysql', 'psql', 'sqlite3', 'redis-cli', 'mongo', 'mongosh',
    'sudo', 'doas', 'gsudo', 'nmtui', 'alsamixer', 'lazygit',
    'dialog', 'whiptail', 'byobu',
]);
const REPL_COMMANDS = new Set(['python', 'python3', 'python3.11', 'python3.12', 'node', 'irb', 'php', 'bash', 'sh', 'zsh', 'fish']);
const OUTPUT_LIMIT = 2 * 1024 * 1024;
function normalizeCarriageReturns(text) {
    return text
        .split('\n')
        .map((line) => {
        if (!line.includes('\r'))
            return line;
        const pieces = line.split('\r');
        return pieces[pieces.length - 1] ?? '';
    })
        .join('\n');
}
function filterBashNoise(text) {
    return text
        .split('\n')
        .filter((line) => {
        if (/^bash: cannot set terminal process group\b/.test(line))
            return false;
        if (/^bash: no job control in this shell$/.test(line))
            return false;
        if (/^bash: cannot set terminal process group \\(.*\\): Inappropriate ioctl for device$/.test(line))
            return false;
        if (/^bash: warning: setlocale:/.test(line))
            return false;
        if (/^bash: \[.*\] tcsetattr:/.test(line))
            return false;
        return true;
    })
        .join('\n');
}
export function isInteractiveCommand(command) {
    const raw = command.trim();
    if (raw.startsWith('!'))
        return true;
    if (/\|\s*(less|more|most|view|vim|nano)\b/.test(raw))
        return true;
    const tokens = raw.replace(/^!/, '').split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) {
        index += 1;
    }
    const wrappers = new Set(['env', 'command', 'builtin', 'exec', 'time', 'nice', 'ionice', 'stdbuf']);
    while (index < tokens.length && wrappers.has(path.basename(tokens[index] ?? ''))) {
        index += 1;
        while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? ''))
            index += 1;
    }
    const name = path.basename(tokens[index] ?? '');
    if (name === '')
        return false;
    if (INTERACTIVE_COMMANDS.has(name))
        return true;
    const rest = tokens.slice(index + 1).join(' ');
    if (REPL_COMMANDS.has(name)) {
        return rest.trim() === '' || /(?:^|\s)(?:-i|--interactive|-a)(?:\s|$)/.test(rest);
    }
    if (['npm', 'yarn', 'pnpm'].includes(name)) {
        if (/^(?:init|create)\b/.test(rest) && !/(?:^|\s)-y(?:\s|$)/.test(rest))
            return true;
    }
    if (name === 'git') {
        if (/^rebase\s+(?:-i|--interactive)\b/.test(rest))
            return true;
        if (/^add\s+-p\b/.test(rest))
            return true;
        if (/^commit\b/.test(rest) && !/(?:^|\s)-m(?:\s|=|$)/.test(rest))
            return true;
        if (/^(?:difftool|mergetool|config\s+--edit)\b/.test(rest))
            return true;
    }
    if (name === 'docker' && /^(?:run\s+.*-it|exec\s+.*-it|compose\s+run)/.test(rest)) {
        return true;
    }
    if (name === 'kubectl' && /^(?:exec\s+.*-it|attach|edit)/.test(rest)) {
        return true;
    }
    return false;
}
export class ShellHandler {
    currentChild = null;
    cancelled = false;
    buildScript() {
        return [
            'exec 9>&1 8>&2',
            'exec 1>/dev/null 2>/dev/null',
            'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc" || true; fi',
            'if [ -f "$HOME/.bash_aliases" ]; then source "$HOME/.bash_aliases" || true; fi',
            'if [ -f "$HOME/.bash_functions" ]; then source "$HOME/.bash_functions" || true; fi',
            'exec 1>&9 2>&8',
            'set +e',
            'set +u',
            'set +x',
            'set +v',
            'set +n',
            'shopt -s expand_aliases',
            'cd "$NEXUS_CWD" 2>/dev/null || cd "$HOME"',
            'eval "$NEXUS_COMMAND"',
            '__nexus_status=$?',
            'printf "%s" "$PWD" > "$NEXUS_CWD_FILE" 2>/dev/null || true',
            'printf "%s" "$__nexus_status" > "$NEXUS_STATUS_FILE" 2>/dev/null || true',
            'exec /bin/sh -c "exit $__nexus_status"',
        ].join('\n');
    }
    prepare() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-'));
        return { dir, cwdFile: path.join(dir, 'cwd'), statusFile: path.join(dir, 'status') };
    }
    cleanup(context) {
        try {
            fs.rmSync(context.dir, { recursive: true, force: true });
        }
        catch {
            // best effort
        }
    }
    readResultFiles(context, fallbackCode) {
        let cwd = null;
        let code = fallbackCode;
        try {
            const cwdValue = fs.readFileSync(context.cwdFile, 'utf8').trim();
            if (cwdValue !== '')
                cwd = cwdValue;
        }
        catch {
            cwd = null;
        }
        try {
            const statusValue = Number(fs.readFileSync(context.statusFile, 'utf8').trim());
            if (Number.isFinite(statusValue))
                code = statusValue;
        }
        catch {
            // keep fallback
        }
        return { cwd, code };
    }
    run(command, cwd) {
        const context = this.prepare();
        const started = Date.now();
        this.cancelled = false;
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let finished = false;
            let timedOut = false;
            const child = spawn('bash', ['--norc', '-i', '-c', this.buildScript()], {
                cwd,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    NEXUS_CLI: '1',
                    NEXUS_COMMAND: command,
                    NEXUS_CWD: cwd,
                    NEXUS_CWD_FILE: context.cwdFile,
                    NEXUS_STATUS_FILE: context.statusFile,
                },
            });
            this.currentChild = child;
            const append = (target, chunk) => {
                if (target === 'stdout')
                    stdout += chunk;
                else
                    stderr += chunk;
                if (stdout.length > OUTPUT_LIMIT)
                    stdout = stdout.slice(-OUTPUT_LIMIT);
                if (stderr.length > OUTPUT_LIMIT)
                    stderr = stderr.slice(-OUTPUT_LIMIT);
            };
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => append('stdout', chunk));
            child.stderr.on('data', (chunk) => append('stderr', chunk));
            const timeoutMs = this.commandTimeoutMs;
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    timedOut = true;
                    this.terminate(child, 'SIGTERM');
                }, timeoutMs)
                : null;
            const finish = (code, signal) => {
                if (finished)
                    return;
                finished = true;
                if (timer)
                    clearTimeout(timer);
                this.currentChild = null;
                const files = this.readResultFiles(context, code ?? (signal ? 130 : 1));
                this.cleanup(context);
                const combined = normalizeCarriageReturns(filterBashNoise(stdout + (stderr ? (stdout.endsWith('\n') ? '' : '\n') + stderr : '')));
                const output = sanitizeCommandOutput(combined).replace(/^\n+/, '').replace(/\n+$/, '');
                resolve({
                    code: this.cancelled ? 130 : files.code,
                    output,
                    stderr: sanitizeCommandOutput(filterBashNoise(stderr)),
                    cwd: files.cwd,
                    durationMs: Date.now() - started,
                    cancelled: this.cancelled || timedOut,
                });
            };
            child.on('error', (error) => {
                stderr += `${error.message}\n`;
                finish(1, null);
                nexusLog('shell spawn failed', error);
            });
            child.on('close', (code, signal) => finish(code, signal));
        });
    }
    runInteractive(command, cwd) {
        const context = this.prepare();
        const started = Date.now();
        const script = this.buildScript();
        const env = {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            NEXUS_CLI: '1',
            NEXUS_COMMAND: command,
            NEXUS_CWD: cwd,
            NEXUS_CWD_FILE: context.cwdFile,
            NEXUS_STATUS_FILE: context.statusFile,
        };
        // The TUI has already released the real terminal, so the child can use the
        // inherited PTY directly. This keeps job control and signals native.
        const child = spawn('bash', ['--norc', '-i', '-c', script], { cwd, stdio: 'inherit', env });
        this.currentChild = child;
        return new Promise((resolve) => {
            child.on('error', (error) => {
                this.currentChild = null;
                this.cleanup(context);
                nexusLog('interactive shell spawn failed', error);
                resolve({ code: 1, output: String(error.message), stderr: '', cwd: null, durationMs: Date.now() - started, cancelled: false });
            });
            child.on('close', (code, signal) => {
                this.currentChild = null;
                const files = this.readResultFiles(context, code ?? (signal ? 130 : 1));
                this.cleanup(context);
                resolve({
                    code: files.code,
                    output: '',
                    stderr: '',
                    cwd: files.cwd,
                    durationMs: Date.now() - started,
                    cancelled: false,
                });
            });
        });
    }
    cancel() {
        if (!this.currentChild)
            return false;
        this.cancelled = true;
        this.terminate(this.currentChild, 'SIGINT');
        setTimeout(() => {
            if (this.currentChild)
                this.terminate(this.currentChild, 'SIGKILL');
        }, 300);
        return true;
    }
    interruptInteractive() {
        if (!this.currentChild)
            return false;
        const pid = this.currentChild.pid;
        if (typeof pid !== 'number')
            return false;
        const targets = [...this.descendantPids(pid), pid];
        let sent = false;
        for (const target of targets) {
            try {
                process.kill(target, 'SIGINT');
                sent = true;
            }
            catch {
                // process already gone
            }
        }
        return sent;
    }
    descendantPids(pid) {
        const direct = [];
        try {
            const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
            for (const value of raw.split(/\s+/)) {
                const child = Number(value);
                if (Number.isFinite(child) && child > 0)
                    direct.push(child);
            }
        }
        catch {
            return [];
        }
        const out = [];
        for (const child of direct) {
            out.push(child, ...this.descendantPids(child));
        }
        return out;
    }
    terminate(child, signal) {
        try {
            if (typeof child.pid === 'number')
                process.kill(-child.pid, signal);
        }
        catch {
            try {
                child.kill(signal);
            }
            catch {
                // process already gone
            }
        }
    }
    commandTimeoutMs = 0;
    setTimeoutMs(timeoutMs) {
        this.commandTimeoutMs = Math.max(0, timeoutMs);
    }
}
function nexusLog(message, error) {
    if (process.env.NEXUS_DEBUG === '1') {
        process.stderr.write(`[nexus] ${message}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
}
