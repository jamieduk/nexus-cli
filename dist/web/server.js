import crypto from 'node:crypto';
import http from 'node:http';
import { Agent } from '../ai/agent.js';
import { PermissionManager } from '../ai/permissions.js';
import { loadPermissionStore, savePermissionStore } from '../ai/settings.js';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_MESSAGE = 20000;
const WEB_PERMISSIONS = [
    { id: 'files:write', label: 'Write and edit files', description: 'Create, overwrite and edit files.', risk: 'high' },
    { id: 'files:copy', label: 'Copy files', description: 'Copy files and directories.', risk: 'medium' },
    { id: 'files:move', label: 'Move or rename', description: 'Move or rename files and directories.', risk: 'high' },
    { id: 'files:delete', label: 'Delete files', description: 'Permanently delete files and directories.', risk: 'high' },
    { id: 'files:chmod', label: 'Change permissions', description: 'Change POSIX permissions, including execute bits.', risk: 'high' },
    { id: 'exec:command', label: 'Run shell commands', description: 'Execute commands as your user.', risk: 'high' },
    { id: 'exec:custom-tool', label: 'Run custom tools', description: 'Execute scripts from the tools directory.', risk: 'high' },
    { id: 'network:web', label: 'Access the web', description: 'Search and fetch web pages.', risk: 'medium' },
    { id: 'vault:access', label: 'Read the vault', description: 'Reveal stored credentials.', risk: 'high' },
    { id: 'vault:write', label: 'Write the vault', description: 'Create or update stored credentials.', risk: 'high' },
    { id: 'image:generate', label: 'Generate images', description: 'Send prompts to the image model.', risk: 'medium' },
    { id: 'self:improve', label: 'Self-improvement', description: 'Create skills/tools and update the personality.', risk: 'medium' },
];
export function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}
export function makePasswordVerifier(passwordHash, salt) {
    const expected = Buffer.from(passwordHash, 'hex');
    return (password) => {
        if (expected.length === 0)
            return false;
        const actual = crypto.scryptSync(password, salt, 64);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    };
}
export function generatePassword() {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(24);
    let out = '';
    for (let index = 0; index < 24; index += 1) {
        out += alphabet[(bytes[index] ?? 0) % alphabet.length];
    }
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 24)}`;
}
function parseCookies(header) {
    const cookies = {};
    if (!header)
        return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0)
            continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key !== '')
            cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}
function securityHeaders(extra = {}) {
    return {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        ...extra,
    };
}
function loginPage(error = '') {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Web</title>
<style>
:root{color-scheme:dark}body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1a1b26;color:#c0caf5;display:grid;min-height:100vh;place-items:center}
.card{width:min(380px,92vw);background:#16161e;border:1px solid #2f3549;border-radius:12px;padding:28px;box-shadow:0 20px 60px #0008}
h1{margin:0 0 6px;font-size:20px;color:#7aa2f7}p{margin:0 0 20px;color:#7982a9;font-size:13px}
label{display:block;font-size:12px;color:#7982a9;margin-bottom:6px}
input{width:100%;box-sizing:border-box;background:#1f2335;border:1px solid #2f3549;color:#c0caf5;padding:11px;border-radius:8px;font:inherit}
button{width:100%;margin-top:14px;background:#7aa2f7;color:#1a1b26;border:0;border-radius:8px;padding:11px;font:inherit;font-weight:700;cursor:pointer}
.err{margin-top:12px;color:#f7768e;font-size:12px;min-height:16px}
</style></head><body>
<form class="card" method="post" action="/login">
<h1>Nexus Web</h1><p>Enter the password shown in your terminal.</p>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Unlock</button>
<div class="err">${error}</div>
</form></body></html>`;
}
function appPage() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Web</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1a1b26;color:#c0caf5;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #2f3549;background:#16161e}
header h1{font-size:15px;margin:0;color:#7aa2f7;flex:1}
header .meta{font-size:11px;color:#7982a9}
select,button{font:inherit;background:#1f2335;color:#c0caf5;border:1px solid #2f3549;border-radius:7px;padding:6px 9px}
button{cursor:pointer}button.primary{background:#7aa2f7;color:#1a1b26;border-color:#7aa2f7;font-weight:700}
button:disabled{opacity:.5;cursor:default}
main{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:900px;width:100%;margin:0 auto;padding:12px 14px;border-radius:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.user{background:#283457;border:1px solid #3b4a7a}
.assistant{background:#16161e;border:1px solid #2f3549}
.tool{background:#141822;border:1px dashed #3b4252;color:#7982a9;font-size:12px;white-space:pre-wrap;max-height:280px;overflow:auto}
.info{color:#e0af68;font-size:12px;text-align:center}
.error{border-color:#f7768e;color:#f7768e}
.composer{border-top:1px solid #2f3549;padding:12px 18px;background:#16161e;display:flex;gap:10px;align-items:flex-end}
textarea{flex:1;min-height:52px;max-height:200px;resize:vertical;background:#1f2335;border:1px solid #2f3549;border-radius:9px;color:#c0caf5;padding:11px;font:inherit}
.hint{font-size:11px;color:#565f89;text-align:center;padding:4px}
.small{font-size:11px;color:#565f89}
code{background:#1f2335;padding:1px 4px;border-radius:4px}
pre{background:#1f2335;padding:10px;border-radius:8px;overflow:auto}
.perm{max-width:900px;width:calc(100% - 36px);margin:12px auto 0;background:#16161e;border:1px solid #2f3549;border-radius:10px;padding:14px}
.permhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:#7aa2f7;font-weight:700}
.permitem{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #242a3a}
.permitem:last-child{border-bottom:0}
.permitem input{margin-top:3px}
.permitem .name{color:#c0caf5}
.permitem .desc{color:#7982a9;font-size:11px}
.risk-high{color:#f7768e}.risk-medium{color:#e0af68}
</style></head><body>
<header>
<h1>Nexus Web</h1>
<span class="meta" id="meta">connecting…</span>
<select id="mode" title="Mode"><option value="agent">Agent</option><option value="chat">Chat</option></select>
<button id="perms">Permissions</button>
<button id="clear">Clear</button>
<button id="logout">Lock</button>
</header>
<div id="permPanel" class="perm" hidden>
<div class="permhead">Agent permissions <button id="permClose">Close</button></div>
<div class="small">Granted permissions apply immediately to the browser agent. Grant only what you trust.</div>
<div id="permList"></div>
</div>
<main id="log"></main>
<div class="composer"><textarea id="input" placeholder="Ask Nexus to inspect files, run commands or answer a question… (Enter to send, Shift+Enter newline)"></textarea><button class="primary" id="send">Send</button></div>
<div class="hint">Agent mode can run tools on this machine using the permissions you granted in the terminal. Password-protected session.</div>
<script>
const log=document.getElementById('log');
const input=document.getElementById('input');
const send=document.getElementById('send');
const mode=document.getElementById('mode');
const meta=document.getElementById('meta');
const permPanel=document.getElementById('permPanel');
const permList=document.getElementById('permList');
let busy=false;
function esc(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function add(kind,text,tool){
  const el=document.createElement('div');el.className='msg '+kind;
  el.textContent=(tool?tool+': ':'')+text;log.appendChild(el);log.scrollTop=log.scrollHeight;return el;
}
function setBusy(v){busy=v;send.disabled=v;input.disabled=v;}
async function status(){
  try{const r=await fetch('/api/status');const j=await r.json();meta.textContent=(j.provider||'?')+' · '+(j.model||'?')+' · '+j.cwd;}catch(e){}
}
async function sendMessage(){
  const text=input.value.trim();if(text===''||busy)return;
  input.value='';add('user',text);setBusy(true);
  const tool=add('assistant','Working…');
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,mode:mode.value})});
    const data=await res.json();
    tool.remove();
    if(!res.ok){add('error',data.error||('HTTP '+res.status));return;}
    for(const ev of data.events||[]){
      if(ev.kind==='tool-start')add('tool',ev.text||'',ev.tool);
      else if(ev.kind==='tool-result')add('tool',(ev.ok?'':'['+(ev.tool||'tool')+' failed] ')+(ev.text||'').slice(0,4000));
      else if(ev.kind==='info')add('info',ev.text||'');
      else if(ev.kind==='error')add('error',ev.text||'');
    }
    add('assistant',data.reply||'(no reply)');
    status();
  }catch(e){tool.remove();add('error',e&&e.message?e.message:String(e));}
  finally{setBusy(false);input.focus();}
}
send.addEventListener('click',sendMessage);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
document.getElementById('clear').addEventListener('click',()=>{log.innerHTML='';});
document.getElementById('logout').addEventListener('click',async()=>{await fetch('/logout',{method:'POST'});location.reload();});
async function loadPerms(){
  permPanel.hidden=false;permList.textContent='Loading…';
  try{
    const r=await fetch('/api/permissions');const j=await r.json();
    permList.innerHTML='';
    for(const p of j.permissions||[]){
      const row=document.createElement('label');row.className='permitem';
      const box=document.createElement('input');box.type='checkbox';box.checked=p.granted;
      box.addEventListener('change',async()=>{
        box.disabled=true;
        try{await fetch('/api/permissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,granted:box.checked})});}
        catch(e){box.checked=!box.checked;}
        finally{box.disabled=false;}
      });
      const text=document.createElement('div');
      const name=document.createElement('div');name.className='name';name.textContent=p.label+' ';
      const risk=document.createElement('span');risk.className='risk-'+p.risk;risk.textContent='['+p.risk+']';name.appendChild(risk);
      const desc=document.createElement('div');desc.className='desc';desc.textContent=p.description;
      text.appendChild(name);text.appendChild(desc);row.appendChild(box);row.appendChild(text);permList.appendChild(row);
    }
    if((j.permissions||[]).length===0){permList.textContent='No permissions registered.';}
  }catch(e){permList.textContent='Could not load permissions.';}
}
document.getElementById('perms').addEventListener('click',loadPerms);
document.getElementById('permClose').addEventListener('click',()=>{permPanel.hidden=true;});
status();
input.focus();
</script></body></html>`;
}
export class WebServer {
    server = null;
    sessions = new Map();
    verify;
    agent;
    chatAgent;
    failures = new Map();
    getCwd;
    options;
    url = '';
    constructor(options) {
        this.options = options;
        this.getCwd = options.getCwd;
        this.verify = makePasswordVerifier(options.webConfig.passwordHash, options.webConfig.salt);
        const permissions = new PermissionManager(null);
        this.agent = new Agent({ config: options.aiConfig, permissions, cwd: this.getCwd() });
        this.chatAgent = new Agent({ config: options.aiConfig, permissions, cwd: this.getCwd() });
    }
    get address() {
        return this.url;
    }
    isRunning() {
        return this.server !== null;
    }
    async start() {
        if (this.server)
            return this.url;
        const server = http.createServer((request, response) => {
            this.handle(request, response).catch((error) => {
                this.respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
            });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.options.webConfig.port, this.options.webConfig.host, () => {
                server.off('error', reject);
                resolve();
            });
        });
        this.server = server;
        const address = server.address();
        const host = this.options.webConfig.host === '0.0.0.0' ? '<this-machine-ip>' : this.options.webConfig.host;
        this.url = `http://${host}:${address?.port ?? this.options.webConfig.port}/`;
        return this.url;
    }
    async stop() {
        const server = this.server;
        if (!server)
            return;
        this.server = null;
        this.sessions.clear();
        await new Promise((resolve) => server.close(() => resolve()));
    }
    respondJson(response, status, body) {
        const payload = JSON.stringify(body);
        response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
        response.end(payload);
    }
    respondHtml(response, status, html) {
        response.writeHead(status, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
        response.end(html);
    }
    sessionFrom(request) {
        const cookies = parseCookies(request.headers.cookie);
        const token = cookies.nexus_session;
        if (!token)
            return null;
        const session = this.sessions.get(token);
        if (!session)
            return null;
        if (session.expires < Date.now()) {
            this.sessions.delete(token);
            return null;
        }
        return token;
    }
    async readBody(request, limit = 256 * 1024) {
        return new Promise((resolve, reject) => {
            let body = '';
            request.setEncoding('utf8');
            request.on('data', (chunk) => {
                body += chunk;
                if (body.length > limit) {
                    reject(new Error('Request body too large.'));
                    request.destroy();
                }
            });
            request.on('end', () => resolve(body));
            request.on('error', reject);
        });
    }
    async handle(request, response) {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        const method = request.method ?? 'GET';
        const ip = request.socket.remoteAddress ?? 'unknown';
        if (url.pathname === '/login' && method === 'POST') {
            const failure = this.failures.get(ip);
            if (failure && failure.blockedUntil > Date.now()) {
                this.respondHtml(response, 429, loginPage('Too many attempts. Wait a moment.'));
                return;
            }
            let password = '';
            const contentType = request.headers['content-type'] ?? '';
            try {
                const body = await this.readBody(request, 16 * 1024);
                if (contentType.includes('application/json')) {
                    password = String(JSON.parse(body).password ?? '');
                }
                else {
                    password = new URLSearchParams(body).get('password') ?? '';
                }
            }
            catch {
                this.respondHtml(response, 400, loginPage('Bad request.'));
                return;
            }
            if (!this.verify(password)) {
                const next = { count: (failure?.count ?? 0) + 1, blockedUntil: 0 };
                if (next.count >= 5)
                    next.blockedUntil = Date.now() + 30000;
                this.failures.set(ip, next);
                this.respondHtml(response, 401, loginPage('Wrong password.'));
                return;
            }
            this.failures.delete(ip);
            const token = crypto.randomBytes(32).toString('hex');
            this.sessions.set(token, { expires: Date.now() + SESSION_TTL });
            response.writeHead(303, securityHeaders({
                'Set-Cookie': `nexus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
                Location: '/',
            }));
            response.end();
            return;
        }
        if (url.pathname === '/logout' && method === 'POST') {
            const token = this.sessionFrom(request);
            if (token)
                this.sessions.delete(token);
            response.writeHead(303, securityHeaders({
                'Set-Cookie': 'nexus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
                Location: '/login',
            }));
            response.end();
            return;
        }
        const token = this.sessionFrom(request);
        if (!token) {
            if (url.pathname === '/') {
                this.respondHtml(response, 200, loginPage());
                return;
            }
            this.respondJson(response, 401, { error: 'Not authenticated.' });
            return;
        }
        if (url.pathname === '/' && method === 'GET') {
            this.respondHtml(response, 200, appPage());
            return;
        }
        if (url.pathname === '/api/status' && method === 'GET') {
            this.respondJson(response, 200, {
                provider: this.options.aiConfig.provider,
                model: this.options.aiConfig.model,
                cwd: this.getCwd(),
                running: this.isRunning(),
            });
            return;
        }
        if (url.pathname === '/api/permissions' && method === 'GET') {
            const store = loadPermissionStore();
            this.respondJson(response, 200, {
                permissions: WEB_PERMISSIONS.map((permission) => ({
                    ...permission,
                    granted: Boolean(store.grants[permission.id]),
                })),
            });
            return;
        }
        if (url.pathname === '/api/permissions' && method === 'POST') {
            const origin = request.headers.origin;
            if (origin) {
                try {
                    if (new URL(origin).host !== request.headers.host) {
                        this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
                        return;
                    }
                }
                catch {
                    this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
                    return;
                }
            }
            let payload;
            try {
                payload = JSON.parse(await this.readBody(request, 16 * 1024));
            }
            catch {
                this.respondJson(response, 400, { error: 'Invalid JSON.' });
                return;
            }
            const id = typeof payload.id === 'string' ? payload.id : '';
            if (!WEB_PERMISSIONS.some((permission) => permission.id === id)) {
                this.respondJson(response, 400, { error: 'Unknown permission.' });
                return;
            }
            const store = loadPermissionStore();
            if (payload.granted === true)
                store.grants[id] = { grantedAt: Date.now() };
            else
                delete store.grants[id];
            savePermissionStore(store);
            this.respondJson(response, 200, { ok: true });
            return;
        }
        if (url.pathname === '/api/chat' && method === 'POST') {
            const origin = request.headers.origin;
            if (origin) {
                try {
                    if (new URL(origin).host !== request.headers.host) {
                        this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
                        return;
                    }
                }
                catch {
                    this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
                    return;
                }
            }
            let payload;
            try {
                payload = JSON.parse(await this.readBody(request));
            }
            catch {
                this.respondJson(response, 400, { error: 'Invalid JSON.' });
                return;
            }
            const message = typeof payload.message === 'string' ? payload.message.trim() : '';
            const mode = payload.mode === 'chat' ? 'chat' : 'agent';
            if (message === '') {
                this.respondJson(response, 400, { error: 'Message is required.' });
                return;
            }
            if (message.length > MAX_MESSAGE) {
                this.respondJson(response, 413, { error: 'Message too long.' });
                return;
            }
            if (!this.options.aiConfig.initialized) {
                this.respondJson(response, 503, { error: 'AI is not configured yet. Run /agent in the Nexus terminal.' });
                return;
            }
            const events = [];
            try {
                const target = mode === 'chat' ? this.chatAgent : this.agent;
                const reply = await target.send(message, mode, {
                    cwd: this.getCwd(),
                    onEvent: (event) => {
                        events.push(event);
                        this.options.onEvent?.(event);
                    },
                });
                this.respondJson(response, 200, { reply, events: events.filter((event) => event.kind !== 'final') });
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                events.push({ kind: 'error', text });
                this.respondJson(response, 502, { error: text, events });
            }
            return;
        }
        this.respondJson(response, 404, { error: 'Not found.' });
    }
}
