import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatUptime, humanBytes, percent } from './utils.js';
function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
function osName() {
    const release = readText('/etc/os-release');
    for (const line of release.split('\n')) {
        if (line.startsWith('PRETTY_NAME=')) {
            return line.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '');
        }
    }
    return `${os.type()} ${os.release()}`;
}
function cpuModel() {
    const cpuInfo = readText('/proc/cpuinfo');
    const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo) ?? /^Model\s*:\s*(.+)$/m.exec(cpuInfo);
    return match?.[1]?.trim() ?? os.cpus()[0]?.model ?? 'Unknown CPU';
}
function memoryInfo() {
    const mem = readText('/proc/meminfo');
    const totalKb = Number(/^MemTotal:\s+(\d+)/m.exec(mem)?.[1] ?? 0);
    const availableKb = Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1] ?? 0);
    const total = totalKb * 1024;
    const available = availableKb * 1024;
    const used = Math.max(0, total - available);
    return { used, total, percent: percent(used, total) };
}
function loadAverage() {
    const raw = readText('/proc/loadavg').trim();
    if (raw === '') {
        const loads = os.loadavg();
        return loads.slice(0, 3).map((v) => v.toFixed(2)).join(' ');
    }
    return raw.split(/\s+/).slice(0, 3).join(' ');
}
export function getSystemInfo() {
    const memory = memoryInfo();
    let user = 'user';
    try {
        user = os.userInfo().username;
    }
    catch {
        // keep fallback
    }
    return {
        hostname: os.hostname(),
        os: osName(),
        kernel: `${os.type()} ${os.release()} ${os.arch()}`,
        uptime: formatUptime(os.uptime()),
        load: loadAverage(),
        memory: `${humanBytes(memory.used, 0).trim()} / ${humanBytes(memory.total, 0).trim()}`,
        memoryPercent: memory.percent,
        cpuModel: cpuModel(),
        user,
        shell: path.basename(process.env.SHELL || 'bash'),
    };
}
