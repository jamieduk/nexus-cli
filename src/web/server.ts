import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Agent } from '../ai/agent.js';
import { PermissionManager } from '../ai/permissions.js';
import { loadPermissionStore, savePermissionStore } from '../ai/settings.js';
import type { AgentEvent, AIConfig, WebUiConfig } from '../ai/types.js';
import { ShellHandler, isInteractiveCommand } from '../shell-handler.js';
import { humanBytes } from '../utils.js';

export interface WebServerOptions {
  aiConfig: AIConfig;
  webConfig: WebUiConfig;
  getCwd: () => string;
  onEvent?: (event: AgentEvent) => void;
}

interface Session {
  expires: number;
}

const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_MESSAGE = 20000;

const WEB_PERMISSIONS: Array<{ id: string; label: string; description: string; risk: string }> = [
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

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff']);
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
};

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / buffer.length > 0.2;
}

function hexDump(buffer: Buffer, limit = 1024): string[] {
  const lines: string[] = [];
  const max = Math.min(buffer.length, limit);
  for (let offset = 0; offset < max; offset += 16) {
    const slice = buffer.subarray(offset, Math.min(offset + 16, max));
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
    lines.push(offset.toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  ' + ascii);
  }
  return lines;
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function makePasswordVerifier(passwordHash: string, salt: string): (password: string) => boolean {
  const expected = Buffer.from(passwordHash, 'hex');
  return (password: string) => {
    if (expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
}

export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let index = 0; index < 24; index += 1) {
    out += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 24)}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key !== '') cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function loginPage(error = ''): string {
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

function appPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Web</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1a1b26;color:#c0caf5;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #2f3549;background:#16161e;flex-wrap:wrap}
header h1{font-size:15px;margin:0;color:#7aa2f7}
header .meta{font-size:11px;color:#7982a9;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tabs{display:flex;gap:3px;background:#1f2335;border:1px solid #2f3549;border-radius:8px;padding:3px}
.tab{background:transparent;border:0;color:#7982a9;padding:5px 11px;border-radius:6px;cursor:pointer;font:inherit}
.tab.active{background:#7aa2f7;color:#1a1b26;font-weight:700}
button,select{font:inherit;background:#1f2335;color:#c0caf5;border:1px solid #2f3549;border-radius:7px;padding:6px 9px;cursor:pointer}
button.primary{background:#7aa2f7;color:#1a1b26;border-color:#7aa2f7;font-weight:700}
button:disabled{opacity:.5;cursor:default}
main{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.panel{flex:1;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:10px;min-height:0}
.panel[hidden]{display:none}
.msg{max-width:900px;width:100%;margin:0 auto;padding:12px 14px;border-radius:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.user{background:#283457;border:1px solid #3b4a7a}
.assistant{background:#16161e;border:1px solid #2f3549}
.tool{background:#141822;border:1px dashed #3b4252;color:#7982a9;font-size:12px;white-space:pre-wrap;max-height:280px;overflow:auto}
.info{color:#e0af68;font-size:12px;text-align:center}
.error{border-color:#f7768e;color:#f7768e}
.log{max-width:900px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.clilog{max-width:none;gap:0;font-size:13px;line-height:1.45}
.cli-line{white-space:pre-wrap;word-break:break-word;padding:1px 0}
.cli-cmd{color:#7aa2f7;font-weight:700}
.cli-err{color:#f7768e}
.cli-info{color:#e0af68}
.cli-out{color:#c0caf5}
.composer{border-top:1px solid #2f3549;padding:12px 18px;background:#16161e;display:flex;gap:10px;align-items:flex-end}
textarea{flex:1;min-height:52px;max-height:220px;resize:vertical;background:#1f2335;border:1px solid #2f3549;border-radius:9px;color:#c0caf5;padding:11px;font:inherit}
.hint{font-size:11px;color:#565f89;text-align:center;padding:4px;background:#16161e;border-top:1px solid #202534}
.small{font-size:11px;color:#565f89}
code{background:#1f2335;padding:1px 4px;border-radius:4px}
.perm{max-width:900px;width:calc(100% - 36px);margin:12px auto 0;background:#16161e;border:1px solid #2f3549;border-radius:10px;padding:14px}
.permhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:#7aa2f7;font-weight:700}
.permitem{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #242a3a}
.permitem:last-child{border-bottom:0}
.permitem input{margin-top:3px}
.permitem .name{color:#c0caf5}
.permitem .desc{color:#7982a9;font-size:11px}
.risk-high{color:#f7768e}.risk-medium{color:#e0af68}
.files{max-width:1500px;width:100%;margin:0 auto;padding:12px 16px;overflow:hidden;display:flex;flex-direction:column;gap:10px}
.files[hidden]{display:none}
.pathbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.pathbar input{flex:1;min-width:180px;background:#1f2335;border:1px solid #2f3549;border-radius:8px;color:#c0caf5;padding:8px 10px;font:inherit}
.filegrid{flex:1;display:grid;grid-template-columns:minmax(260px,44%) 1fr;gap:12px;min-height:0}
.filelist{overflow:auto;border:1px solid #2f3549;border-radius:9px;background:#16161e;min-height:150px}
.fileitem{display:flex;gap:10px;align-items:center;padding:7px 11px;border-bottom:1px solid #202534;cursor:pointer}
.fileitem:last-child{border-bottom:0}
.fileitem:hover{background:#1f2335}
.fileitem.selected{background:#283457}
.ficon{width:18px;text-align:center;color:#7aa2f7;flex:none}
.ftext{min-width:0;flex:1}
.fname{color:#c0caf5;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmeta{color:#565f89;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filepreview{overflow:auto;border:1px solid #2f3549;border-radius:9px;background:#16161e;padding:12px;min-width:0}
.previewmeta{display:grid;grid-template-columns:110px minmax(0,1fr);gap:4px 10px;margin-bottom:10px;font-size:12px}
.previewmeta .k{color:#565f89}.previewmeta .v{color:#c0caf5;word-break:break-all}
.previewtext{margin:0;background:#1f2335;padding:10px;border-radius:7px;overflow:auto;font-size:12px;line-height:1.45;white-space:pre-wrap}
.previewimg{max-width:100%;border-radius:8px;display:block}
.empty{color:#565f89;font-size:12px;font-style:italic}
@media (max-width:760px){.filegrid{grid-template-columns:1fr}.files{overflow:auto}.filelist{max-height:40vh}.filepreview{min-height:220px}}
</style></head><body>
<header>
<h1>Nexus Web</h1>
<span class="meta" id="meta">connecting…</span>
<div class="tabs">
<button class="tab active" data-mode="cli">CLI</button>
<button class="tab" data-mode="files">Files</button>
<button class="tab" data-mode="agent">Agent</button>
<button class="tab" data-mode="chat">Chat</button>
</div>
<button id="perms">Permissions</button>
<button id="clear">Clear</button>
<button id="logout">Lock</button>
</header>
<div id="permPanel" class="perm" hidden>
<div class="permhead">Agent permissions <button id="permClose">Close</button></div>
<div class="small">Granted permissions apply immediately to the browser agent. Grant only what you trust.</div>
<div id="permList"></div>
</div>
<main>
<section id="chatPanel" class="panel" hidden><div id="log" class="log"></div></section>
<section id="cliPanel" class="panel"><div id="cliLog" class="log clilog"></div></section>
<section id="filesPanel" class="panel files" hidden>
<div class="pathbar">
<button id="up" title="Parent directory">..</button>
<input id="pathInput" spellcheck="false" placeholder="/path/to/directory">
<button id="go">Go</button>
<button id="projects">Projects</button>
<button id="refresh">Refresh</button>
<button id="clearFiles">Clear preview</button>
</div>
<div class="filegrid">
<div id="fileList" class="filelist"></div>
<div id="filePreview" class="filepreview"><div class="empty">Select a file to preview it, or click a directory to open it.</div></div>
</div>
</section>
</main>
<div id="composer" class="composer"><textarea id="input" placeholder="Run a shell command… (Enter to run, Shift+Enter newline)"></textarea><button class="primary" id="send">Run</button></div>
<div id="hint" class="hint">CLI mode: remote shell in the current web directory. Try: pwd, ls, cd projects, git status. Switch modes without losing your place.</div>
<script>
const tabs=Array.from(document.querySelectorAll('.tab'));
const chatPanel=document.getElementById('chatPanel');
const cliPanel=document.getElementById('cliPanel');
const filesPanel=document.getElementById('filesPanel');
const chatLog=document.getElementById('log');
const cliLog=document.getElementById('cliLog');
const fileList=document.getElementById('fileList');
const filePreview=document.getElementById('filePreview');
const pathInput=document.getElementById('pathInput');
const input=document.getElementById('input');
const send=document.getElementById('send');
const meta=document.getElementById('meta');
const composer=document.getElementById('composer');
const hint=document.getElementById('hint');
const permPanel=document.getElementById('permPanel');
const permList=document.getElementById('permList');
let mode='cli', busy=false, cwd='', projectsDir='', parentDir='', modelInfo='';
function humanBytes(n){if(!Number.isFinite(n)||n<0)return '?';const u=['B','K','M','G','T'];let v=n,i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return (v>=100||i===0?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2))+u[i];}
function fmtDate(t){try{return new Date(t).toLocaleString();}catch(e){return '';}}
function updateMeta(){meta.textContent=(modelInfo?modelInfo+' · ':'')+(cwd||'?');}
function setBusy(v){busy=v;send.disabled=v;input.disabled=v;}
function addChat(kind,text,tool){
  const el=document.createElement('div');el.className='msg '+kind;
  el.textContent=(tool?tool+': ':'')+text;chatLog.appendChild(el);chatLog.scrollTop=chatLog.scrollHeight;return el;
}
function addCli(kind,text){
  const el=document.createElement('div');el.className='cli-line '+kind;el.textContent=text;
  cliLog.appendChild(el);cliLog.scrollTop=cliLog.scrollHeight;return el;
}
async function status(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    if(j.cwd)cwd=j.cwd;if(j.projectsDir)projectsDir=j.projectsDir;
    modelInfo=(j.provider||'?')+' · '+(j.model||'?');updateMeta();
  }catch(e){}
}
function setMode(next){
  mode=next;
  tabs.forEach(function(b){b.classList.toggle('active',b.dataset.mode===next);});
  cliPanel.hidden=next!=='cli';filesPanel.hidden=next!=='files';chatPanel.hidden=!(next==='agent'||next==='chat');
  composer.style.display=next==='files'?'none':'flex';
  if(next==='cli'){send.textContent='Run';input.placeholder='Run a shell command… (Enter to run, Shift+Enter newline)';hint.textContent='CLI mode: remote shell in the current web directory. Try: pwd, ls, cd projects, git status. Switch modes without losing your place.';input.focus();}
  else if(next==='files'){send.textContent='Send';hint.textContent='File manager: click a directory to open it, click a file to preview it. Projects jumps to the configured projects directory.';loadFiles(cwd||undefined);}
  else if(next==='agent'){send.textContent='Send';input.placeholder='Ask the agent to build, edit, copy, run, search or inspect…';hint.textContent='Agent mode: uses real tools in the current web directory. New projects go in the Projects directory. Grant tools with Permissions.';input.focus();}
  else{send.textContent='Send';input.placeholder='Ask a question using your personality and memory files…';hint.textContent='Chat mode: same model, personality and memory, without tools.';input.focus();}
}
async function sendCli(){
  const text=input.value.trim();if(text===''||busy)return;
  if(text==='clear'){cliLog.innerHTML='';input.value='';return;}
  input.value='';addCli('cli-cmd','$ '+text);setBusy(true);
  try{
    const res=await fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:text})});
    const data=await res.json();
    if(!res.ok){addCli('cli-err',data.error||('HTTP '+res.status));return;}
    const output=String(data.output||'').slice(0,200000);
    if(output!==''){const lines=output.split('\\n');for(const line of lines)addCli(data.code===0?'cli-out':'cli-err',line);}
    else if(data.code!==0)addCli('cli-err','exit '+data.code);
    if(data.cwd){cwd=data.cwd;updateMeta();pathInput.value=cwd;}
    if(data.code===0)addCli('cli-info','ok');
  }catch(e){addCli('cli-err',e&&e.message?e.message:String(e));}
  finally{setBusy(false);input.focus();}
}
async function sendChat(){
  const text=input.value.trim();if(text===''||busy)return;
  input.value='';addChat('user',text);setBusy(true);
  const working=addChat('assistant','Working…');
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,mode:mode==='chat'?'chat':'agent'})});
    const data=await res.json();working.remove();
    if(!res.ok){addChat('error',data.error||('HTTP '+res.status));return;}
    for(const ev of data.events||[]){
      if(ev.kind==='tool-start')addChat('tool',ev.text||'',ev.tool);
      else if(ev.kind==='tool-result')addChat('tool',(ev.ok?'':'['+(ev.tool||'tool')+' failed] ')+(ev.text||'').slice(0,4000));
      else if(ev.kind==='info')addChat('info',ev.text||'');
      else if(ev.kind==='error')addChat('error',ev.text||'');
    }
    addChat('assistant',data.reply||'(no reply)');
    status();
  }catch(e){working.remove();addChat('error',e&&e.message?e.message:String(e));}
  finally{setBusy(false);input.focus();}
}
function sendMessage(){if(mode==='cli')sendCli();else sendChat();}
function fileRow(label,path,isDir,isImage,size,mtime,onClick){
  const row=document.createElement('div');row.className='fileitem';
  const icon=document.createElement('span');icon.className='ficon';icon.textContent=isDir?'▸':isImage?'▣':'·';
  const text=document.createElement('div');text.className='ftext';
  const name=document.createElement('div');name.className='fname';name.textContent=label;
  const sub=document.createElement('div');sub.className='fmeta';sub.textContent=isDir?'directory':humanBytes(size);
  if(mtime)sub.textContent+=' · '+fmtDate(mtime);
  text.appendChild(name);text.appendChild(sub);row.appendChild(icon);row.appendChild(text);
  row.addEventListener('click',function(){onClick(row);});fileList.appendChild(row);return row;
}
async function loadFiles(target){
  fileList.textContent='Loading…';filePreview.innerHTML='<div class="empty">Loading preview…</div>';
  try{
    const res=await fetch('/api/files?path='+encodeURIComponent(target||cwd||''));
    const data=await res.json();
    if(!res.ok){fileList.innerHTML='';filePreview.innerHTML='';const e=document.createElement('div');e.className='empty';e.textContent=data.error||('HTTP '+res.status);filePreview.appendChild(e);return;}
    cwd=data.cwd;parentDir=data.parent||'';projectsDir=data.projectsDir||projectsDir;pathInput.value=cwd;updateMeta();
    fileList.innerHTML='';
    if(parentDir)fileRow('..',parentDir,true,false,0,0,function(){loadFiles(parentDir);});
    for(const item of data.entries||[]){
      (function(it){
        fileRow(it.name,it.path,it.isDir,it.isImage,it.size,it.mtime,function(row){
          if(it.isDir){loadFiles(it.path);return;}
          const rows=Array.from(fileList.querySelectorAll('.fileitem'));rows.forEach(function(r){r.classList.remove('selected');});
          if(row)row.classList.add('selected');previewFile(it.path);
        });
      })(item);
    }
    if((data.entries||[]).length===0){const empty=document.createElement('div');empty.className='empty';empty.textContent='Empty directory.';fileList.appendChild(empty);}
  }catch(e){fileList.innerHTML='';const err=document.createElement('div');err.className='empty';err.textContent=e&&e.message?e.message:String(e);fileList.appendChild(err);}
}
async function previewFile(path){
  filePreview.innerHTML='<div class="empty">Loading…</div>';
  try{
    const res=await fetch('/api/preview?path='+encodeURIComponent(path));
    const data=await res.json();filePreview.innerHTML='';
    if(!res.ok){const e=document.createElement('div');e.className='empty';e.textContent=data.error||('HTTP '+res.status);filePreview.appendChild(e);return;}
    const grid=document.createElement('div');grid.className='previewmeta';
    for(const item of data.meta||[]){
      const k=document.createElement('div');k.className='k';k.textContent=item.label;
      const v=document.createElement('div');v.className='v';v.textContent=item.value;
      grid.appendChild(k);grid.appendChild(v);
    }
    filePreview.appendChild(grid);
    if(data.kind==='image'){
      const img=document.createElement('img');img.className='previewimg';img.alt=data.name||'image';img.src='/api/raw?path='+encodeURIComponent(data.path);filePreview.appendChild(img);
    }else if(data.kind==='text'){
      const pre=document.createElement('pre');pre.className='previewtext';pre.textContent=data.content||'';filePreview.appendChild(pre);
      if(data.truncated){const t=document.createElement('div');t.className='empty';t.textContent='… preview truncated';filePreview.appendChild(t);}
    }else if(data.kind==='binary'){
      const pre=document.createElement('pre');pre.className='previewtext';pre.textContent=(data.hex||[]).join('\\n');filePreview.appendChild(pre);
      if(data.truncated){const t=document.createElement('div');t.className='empty';t.textContent='… hex preview truncated';filePreview.appendChild(t);}
    }
  }catch(e){filePreview.innerHTML='';const err=document.createElement('div');err.className='empty';err.textContent=e&&e.message?e.message:String(e);filePreview.appendChild(err);}
}
async function loadPerms(){
  permPanel.hidden=false;permList.textContent='Loading…';
  try{
    const r=await fetch('/api/permissions');const j=await r.json();
    permList.innerHTML='';
    for(const p of j.permissions||[]){
      const row=document.createElement('label');row.className='permitem';
      const box=document.createElement('input');box.type='checkbox';box.checked=p.granted;
      box.addEventListener('change',async function(){
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
    if((j.permissions||[]).length===0)permList.textContent='No permissions registered.';
  }catch(e){permList.textContent='Could not load permissions.';}
}
tabs.forEach(function(b){b.addEventListener('click',function(){setMode(b.dataset.mode);});});
send.addEventListener('click',sendMessage);
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
document.getElementById('perms').addEventListener('click',loadPerms);
document.getElementById('permClose').addEventListener('click',function(){permPanel.hidden=true;});
document.getElementById('clear').addEventListener('click',function(){if(mode==='cli')cliLog.innerHTML='';else if(mode==='agent'||mode==='chat')chatLog.innerHTML='';});
document.getElementById('logout').addEventListener('click',async function(){await fetch('/logout',{method:'POST'});location.reload();});
document.getElementById('go').addEventListener('click',function(){loadFiles(pathInput.value.trim());});
pathInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();loadFiles(pathInput.value.trim());}});
document.getElementById('up').addEventListener('click',function(){loadFiles(parentDir||cwd);});
document.getElementById('projects').addEventListener('click',function(){if(!projectsDir){status().then(function(){if(projectsDir)loadFiles(projectsDir);});}else loadFiles(projectsDir);});
document.getElementById('refresh').addEventListener('click',function(){loadFiles(cwd);});
document.getElementById('clearFiles').addEventListener('click',function(){filePreview.innerHTML='<div class="empty">Select a file to preview it.</div>';});
status().then(function(){setMode('cli');});
</script></body></html>`;
}

export class WebServer {
  private server: http.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly verify: (password: string) => boolean;
  private readonly agent: Agent;
  private readonly chatAgent: Agent;
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
  private readonly getCwd: () => string;
  private readonly options: WebServerOptions;
  private readonly cliShell = new ShellHandler();
  private webCwd: string;
  private previousCwd: string;
  private cliBusy = false;
  private url = '';

  constructor(options: WebServerOptions) {
    this.options = options;
    this.getCwd = options.getCwd;
    this.verify = makePasswordVerifier(options.webConfig.passwordHash, options.webConfig.salt);
    const permissions = new PermissionManager(null);
    this.webCwd = this.validDirectory(this.getCwd()) ?? os.homedir();
    this.previousCwd = this.webCwd;
    this.cliShell.setTimeoutMs(5 * 60 * 1000);
    this.agent = new Agent({ config: options.aiConfig, permissions, cwd: this.webCwd });
    this.chatAgent = new Agent({ config: options.aiConfig, permissions, cwd: this.webCwd });
  }

  private validDirectory(input: string): string | null {
    try {
      const resolved = path.resolve(input);
      return fs.statSync(resolved).isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private resolveWebPath(input: string): string {
    const value = input.trim();
    if (value === '') return this.webCwd;
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    if (value === 'projects' || value === './projects' || value === 'projects/') {
      const local = path.resolve(this.webCwd, 'projects');
      if (this.validDirectory(local)) return local;
      return this.options.aiConfig.projectsDir;
    }
    if (value.startsWith('projects/') || value.startsWith('./projects/')) {
      const rest = value.replace(/^\.\/projects\//, '').replace(/^projects\//, '');
      const local = path.resolve(this.webCwd, 'projects', rest);
      if (this.validDirectory(local)) return local;
      return path.join(this.options.aiConfig.projectsDir, rest);
    }
    return path.resolve(this.webCwd, value);
  }

  private projectCdTarget(command: string): string | null {
    const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(command);
    if (!match) return null;
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (target === 'projects' || target === './projects' || target === 'projects/') {
      const local = path.resolve(this.webCwd, 'projects');
      if (this.validDirectory(local)) return local;
      return this.validDirectory(this.options.aiConfig.projectsDir);
    }
    if (target.startsWith('projects/') || target.startsWith('./projects/')) {
      const rest = target.replace(/^\.\/projects\//, '').replace(/^projects\//, '');
      const local = path.resolve(this.webCwd, 'projects', rest);
      if (this.validDirectory(local)) return local;
      const fallback = path.join(this.options.aiConfig.projectsDir, rest);
      return this.validDirectory(fallback);
    }
    return null;
  }

  private setWebCwd(next: string): void {
    const resolved = path.resolve(next);
    if (resolved === this.webCwd) return;
    this.previousCwd = this.webCwd;
    this.webCwd = resolved;
  }

  private sameOrigin(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  private async listDirectory(dir: string): Promise<unknown[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const output: Array<{
      name: string;
      path: string;
      isDir: boolean;
      isSymlink: boolean;
      isImage: boolean;
      size: number;
      mtime: number;
      mode: string;
    }> = [];
    for (const entry of entries.slice(0, 3000)) {
      const full = path.join(dir, entry.name);
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
      output.push({
        name: entry.name,
        path: full,
        isDir,
        isSymlink,
        isImage: !isDir && IMAGE_EXTENSIONS.has(extension),
        size,
        mtime: stat.mtimeMs,
        mode: modeText(stat.mode),
      });
    }
    output.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return output;
  }

  private async previewPath(file: string): Promise<Record<string, unknown>> {
    const stat = await fsp.stat(file);
    const name = path.basename(file);
    if (stat.isDirectory()) {
      let count = 0;
      try {
        count = (await fsp.readdir(file)).length;
      } catch {
        // unreadable directory
      }
      return {
        kind: 'directory',
        name,
        path: file,
        meta: [
          { label: 'Path', value: file },
          { label: 'Type', value: 'Directory' },
          { label: 'Items', value: String(count) },
          { label: 'Modified', value: new Date(stat.mtimeMs).toLocaleString() },
          { label: 'Permissions', value: modeText(stat.mode) },
        ],
      };
    }
    const extension = path.extname(name).slice(1).toLowerCase();
    const meta: Array<{ label: string; value: string }> = [
      { label: 'Path', value: file },
      { label: 'Type', value: extension ? extension.toUpperCase() + ' file' : 'File' },
      { label: 'Size', value: humanBytes(stat.size).trim() },
      { label: 'Permissions', value: modeText(stat.mode) },
      { label: 'Modified', value: new Date(stat.mtimeMs).toLocaleString() },
    ];
    if (IMAGE_EXTENSIONS.has(extension)) {
      return { kind: 'image', name, path: file, mime: IMAGE_MIME[extension] ?? 'application/octet-stream', meta };
    }
    if (!stat.isFile()) {
      return { kind: 'binary', name, path: file, meta, hex: ['Special file or device; no preview available.'], truncated: false };
    }
    const handle = await fsp.open(file, 'r');
    let buffer: Buffer;
    try {
      const size = Math.min(stat.size, 512 * 1024);
      buffer = Buffer.alloc(size);
      const read = await handle.read(buffer, 0, size, 0);
      buffer = buffer.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
    if (isProbablyBinary(buffer)) {
      return {
        kind: 'binary',
        name,
        path: file,
        meta,
        hex: hexDump(buffer),
        truncated: stat.size > buffer.length,
      };
    }
    const text = buffer.toString('utf8');
    let lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const truncated = stat.size > buffer.length || lines.length > 800;
    lines = lines.slice(0, 800);
    meta.push({ label: 'Lines', value: String(lines.length) + (truncated ? '+' : '') });
    return { kind: 'text', name, path: file, meta, content: lines.join('\n'), truncated };
  }

  get address(): string {
    return this.url;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.webConfig.port, this.options.webConfig.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as AddressInfo | null;
    const host = this.options.webConfig.host === '0.0.0.0' ? '<this-machine-ip>' : this.options.webConfig.host;
    this.url = `http://${host}:${address?.port ?? this.options.webConfig.port}/`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private respondJson(response: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
    response.end(payload);
  }

  private respondHtml(response: http.ServerResponse, status: number, html: string): void {
    response.writeHead(status, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    response.end(html);
  }

  private respondRaw(response: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
    response.writeHead(status, securityHeaders({
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    }));
    response.end(body);
  }

  private sessionFrom(request: http.IncomingMessage): string | null {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.nexus_session;
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return token;
  }

  private async readBody(request: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
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

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
          password = String((JSON.parse(body) as Record<string, unknown>).password ?? '');
        } else {
          password = new URLSearchParams(body).get('password') ?? '';
        }
      } catch {
        this.respondHtml(response, 400, loginPage('Bad request.'));
        return;
      }
      if (!this.verify(password)) {
        const next = { count: (failure?.count ?? 0) + 1, blockedUntil: 0 };
        if (next.count >= 5) next.blockedUntil = Date.now() + 30000;
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
      if (token) this.sessions.delete(token);
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
        cwd: this.webCwd,
        previousCwd: this.previousCwd,
        projectsDir: this.options.aiConfig.projectsDir,
        running: this.isRunning(),
      });
      return;
    }

    if (url.pathname === '/api/files' && method === 'GET') {
      const requested = url.searchParams.get('path') ?? '';
      const dir = this.resolveWebPath(requested);
      if (this.validDirectory(dir) === null) {
        this.respondJson(response, 404, { error: 'Not a directory: ' + dir });
        return;
      }
      this.setWebCwd(dir);
      try {
        const entries = await this.listDirectory(dir);
        const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
        this.respondJson(response, 200, {
          cwd: dir,
          parent,
          projectsDir: this.options.aiConfig.projectsDir,
          entries,
        });
      } catch (error) {
        this.respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (url.pathname === '/api/cwd' && method === 'POST') {
      if (!this.sameOrigin(request)) {
        this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
        return;
      }
      let payload: { path?: unknown };
      try {
        payload = JSON.parse(await this.readBody(request, 16 * 1024)) as { path?: unknown };
      } catch {
        this.respondJson(response, 400, { error: 'Invalid JSON.' });
        return;
      }
      const target = this.resolveWebPath(typeof payload.path === 'string' ? payload.path : '');
      if (this.validDirectory(target) === null) {
        this.respondJson(response, 404, { error: 'Not a directory: ' + target });
        return;
      }
      this.setWebCwd(target);
      this.respondJson(response, 200, { cwd: target, previousCwd: this.previousCwd });
      return;
    }

    if (url.pathname === '/api/preview' && method === 'GET') {
      const requested = url.searchParams.get('path') ?? '';
      if (requested.trim() === '') {
        this.respondJson(response, 400, { error: 'path is required.' });
        return;
      }
      const target = this.resolveWebPath(requested);
      try {
        this.respondJson(response, 200, await this.previewPath(target));
      } catch (error) {
        this.respondJson(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (url.pathname === '/api/raw' && method === 'GET') {
      const requested = url.searchParams.get('path') ?? '';
      const target = this.resolveWebPath(requested);
      const extension = path.extname(target).slice(1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        this.respondJson(response, 415, { error: 'Only image previews are served through this endpoint.' });
        return;
      }
      try {
        const stat = await fsp.stat(target);
        if (!stat.isFile() || stat.size > 30 * 1024 * 1024) {
          this.respondJson(response, 413, { error: 'Image is too large for a browser preview.' });
          return;
        }
        this.respondRaw(response, 200, IMAGE_MIME[extension] ?? 'application/octet-stream', await fsp.readFile(target));
      } catch (error) {
        this.respondJson(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (url.pathname === '/api/cli' && method === 'POST') {
      if (!this.sameOrigin(request)) {
        this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
        return;
      }
      let payload: { command?: unknown };
      try {
        payload = JSON.parse(await this.readBody(request, 64 * 1024)) as { command?: unknown };
      } catch {
        this.respondJson(response, 400, { error: 'Invalid JSON.' });
        return;
      }
      const command = typeof payload.command === 'string' ? payload.command.trim() : '';
      if (command === '') {
        this.respondJson(response, 400, { error: 'Command is required.' });
        return;
      }
      if (command.length > 8000) {
        this.respondJson(response, 413, { error: 'Command is too long.' });
        return;
      }
      if (this.cliBusy) {
        this.respondJson(response, 409, { error: 'Another CLI command is still running.' });
        return;
      }
      if (/^cd\s+-\s*$/.test(command)) {
        const target = this.previousCwd;
        if (this.validDirectory(target) === null) {
          this.respondJson(response, 400, { error: 'Previous directory is no longer available.' });
          return;
        }
        this.setWebCwd(target);
        this.respondJson(response, 200, { output: '→ ' + target, code: 0, cwd: target });
        return;
      }
      const projectTarget = this.projectCdTarget(command);
      if (projectTarget !== null) {
        this.setWebCwd(projectTarget);
        this.respondJson(response, 200, { output: '→ ' + projectTarget, code: 0, cwd: projectTarget });
        return;
      }
      if (isInteractiveCommand(command)) {
        this.respondJson(response, 400, {
          error: 'Interactive commands are not supported in the web CLI. Run them in the Nexus terminal or use a non-interactive equivalent.',
        });
        return;
      }
      this.cliBusy = true;
      try {
        const result = await this.cliShell.run(command, this.webCwd);
        if (result.cwd && this.validDirectory(result.cwd) !== null) this.setWebCwd(result.cwd);
        this.respondJson(response, 200, {
          output: result.output.slice(0, 200000),
          code: result.code,
          cwd: this.webCwd,
          cancelled: result.cancelled,
        });
      } catch (error) {
        this.respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.cliBusy = false;
      }
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
        } catch {
          this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
          return;
        }
      }
      let payload: { id?: unknown; granted?: unknown };
      try {
        payload = JSON.parse(await this.readBody(request, 16 * 1024)) as { id?: unknown; granted?: unknown };
      } catch {
        this.respondJson(response, 400, { error: 'Invalid JSON.' });
        return;
      }
      const id = typeof payload.id === 'string' ? payload.id : '';
      if (!WEB_PERMISSIONS.some((permission) => permission.id === id)) {
        this.respondJson(response, 400, { error: 'Unknown permission.' });
        return;
      }
      const store = loadPermissionStore();
      if (payload.granted === true) store.grants[id] = { grantedAt: Date.now() };
      else delete store.grants[id];
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
        } catch {
          this.respondJson(response, 403, { error: 'Cross-origin request blocked.' });
          return;
        }
      }
      let payload: { message?: unknown; mode?: unknown };
      try {
        payload = JSON.parse(await this.readBody(request)) as { message?: unknown; mode?: unknown };
      } catch {
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
      const events: AgentEvent[] = [];
      try {
        const target = mode === 'chat' ? this.chatAgent : this.agent;
        const reply = await target.send(message, mode, {
          cwd: this.webCwd,
          onEvent: (event) => {
            events.push(event);
            this.options.onEvent?.(event);
          },
        });
        this.respondJson(response, 200, { reply, events: events.filter((event) => event.kind !== 'final') });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        events.push({ kind: 'error', text });
        this.respondJson(response, 502, { error: text, events });
      }
      return;
    }

    this.respondJson(response, 404, { error: 'Not found.' });
  }
}
