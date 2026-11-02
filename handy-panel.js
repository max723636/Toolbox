#!/usr/bin/env node
/* =====================================================================
   Toolbox Handy-Panel  ·  kleines Server-Panel für Termux (Android)
   ---------------------------------------------------------------------
   Läuft direkt auf dem Handy (ohne Docker) und spricht dieselbe Sprache
   wie Pterodactyl. Die Toolbox-App steuert es wie ein echtes Panel:
   mehrere Server anlegen, starten/stoppen, Live-Konsole, Dateien.

   Start in Termux:   node handy-panel.js
   Optionen:          --port 8090      anderer Port
                      --lan            auch im WLAN erreichbar (Vorsicht!)
                      --dir <ordner>   anderer Datenordner
                      --neuer-schluessel   neuen Zugangsschlüssel erzeugen
   Keine zusätzlichen Pakete nötig – nur Node.js (pkg install nodejs).
   Für Minecraft zusätzlich Java: pkg install openjdk-21
   ===================================================================== */
'use strict';
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto'), os = require('os');
const { spawn, execFile } = require('child_process');

const VERSION = '1.0.0';
const ARGS = process.argv.slice(2);
const opt = n => { const i = ARGS.indexOf('--' + n); return i < 0 ? null : (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true) };
const PORT = +(opt('port') || process.env.HP_PORT || 8090);
const HOST = opt('lan') ? '0.0.0.0' : '127.0.0.1';
const BASE = path.resolve(String(opt('dir') || process.env.HP_DIR || path.join(os.homedir(), 'handy-panel')));
const SRV = path.join(BASE, 'servers'), CFG = path.join(BASE, 'panel.json');
const now = () => new Date().toISOString();
const rid = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Konfiguration ---------- */
fs.mkdirSync(SRV, { recursive: true });
let C;
try { C = JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch (e) { C = null }
if (!C) C = { key: '', servers: [], allocs: [], seq: { server: 0, alloc: 0 }, user: null };
if (!C.key || opt('neuer-schluessel')) C.key = 'tbp_' + rid(20);
if (!C.user) C.user = { id: 1, uuid: crypto.randomUUID(), username: 'handy', email: 'handy@localhost', first_name: 'Handy', last_name: 'Panel', language: 'de', root_admin: true, '2fa': false, created_at: now(), updated_at: now() };
if (!C.allocs.length) { for (const p of [25565, 25566, 25567, 25568, 25569, 25570, 19132, 3000, 3001, 3002, 8081, 8082]) C.allocs.push({ id: ++C.seq.alloc, ip: '0.0.0.0', alias: null, port: p, notes: null }) }
let saveT = null;
function save(now_) {
  clearTimeout(saveT);
  const w = () => { const tmp = CFG + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(C, null, 1)); fs.renameSync(tmp, CFG) };
  if (now_) w(); else saveT = setTimeout(w, 200);
}
save(true);

/* ---------- Vorlagen (Eggs) ---------- */
const MC_VARS = (dflt) => [
  { name: 'Minecraft-Version', env: 'MINECRAFT_VERSION', def: 'latest', desc: '„latest“ = neueste Version, die mit deinem Java läuft. Oder z. B. 1.21.11', rules: 'required|string|max:20' },
  { name: 'Server-Datei', env: 'SERVER_JARFILE', def: dflt || 'server.jar', desc: 'Name der .jar-Datei', rules: 'required|string|max:60' },
  { name: 'Minecraft-EULA akzeptieren', env: 'EULA', def: 'false', desc: 'true = du akzeptierst die Minecraft-EULA (aka.ms/MinecraftEULA). Ohne „true“ startet der Server nicht.', rules: 'required|in:true,false' }];
const JAVA_START = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui';
const NESTS = [{ id: 1, name: 'Minecraft', description: 'Minecraft: Java Edition (braucht Java: pkg install openjdk-21)', eggs: [1, 2, 3] }, { id: 2, name: 'Programme', description: 'Eigene Programme, Bots und Web-Apps', eggs: [4, 5, 6] }];
const EGGS = {
  1: { nest: 1, name: 'Paper', description: 'Schneller Minecraft-Server mit Plugins (empfohlen).', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'paper' },
  2: { nest: 1, name: 'Vanilla', description: 'Original-Minecraft-Server von Mojang.', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'vanilla' },
  3: { nest: 1, name: 'Fabric', description: 'Minecraft mit Fabric-Mods.', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'fabric' },
  4: { nest: 2, name: 'Node.js', description: 'JavaScript-Programm oder Discord-Bot (Node.js).', image: 'termux/node', startup: 'node {{MAIN_FILE}}', stop: '^C', vars: [{ name: 'Startdatei', env: 'MAIN_FILE', def: 'index.js', desc: 'Datei, die gestartet wird', rules: 'required|string|max:100' }], install: 'node' },
  5: { nest: 2, name: 'Python', description: 'Python-Programm oder Bot.', image: 'termux/python', startup: 'python {{MAIN_FILE}}', stop: '^C', vars: [{ name: 'Startdatei', env: 'MAIN_FILE', def: 'main.py', desc: 'Datei, die gestartet wird', rules: 'required|string|max:100' }], install: 'python' },
  6: { nest: 2, name: 'Eigener Befehl', description: 'Startet einen beliebigen Befehl (Standard: start.sh).', image: 'termux/shell', startup: 'sh start.sh', stop: '^C', vars: [], install: 'shell' }
};
const eggAttr = (id, inclVars) => {
  const e = EGGS[id]; if (!e) return null;
  const a = { id, uuid: 'egg-' + id, name: e.name, nest: e.nest, author: 'handy-panel', description: e.description, docker_image: e.image, docker_images: { [e.name + ' (Termux)']: e.image }, config: {}, startup: e.startup, script: {}, created_at: now(), updated_at: now() };
  if (inclVars) a.relationships = { variables: { object: 'list', data: e.vars.map((v, i) => ({ object: 'egg_variable', attributes: { id: id * 10 + i, egg_id: id, name: v.name, description: v.desc, env_variable: v.env, default_value: v.def, user_viewable: true, user_editable: true, rules: v.rules } })) } };
  return { object: 'egg', attributes: a };
};

/* ---------- Laufzeit-Zustand je Server ---------- */
const RT = new Map(); // uuid -> {proc, state, log[], ws:Set, started, cpu, stats}
const rt = s => { let r = RT.get(s.uuid); if (!r) { r = { proc: null, state: 'offline', log: [], ws: new Set(), started: 0, last: null, disk: 0, diskT: 0, mem: 0, cpu: 0 }; RT.set(s.uuid, r) } return r };
const dirOf = s => path.join(SRV, s.uuid);
const findSrv = id => C.servers.find(s => s.identifier === id || s.uuid === id || String(s.id) === String(id));
const allocOf = s => C.allocs.find(a => a.id === s.allocation);
function emit(s, event, args) { const r = rt(s), m = JSON.stringify({ event, args }); for (const w of r.ws) w.send(m) }
function out(s, line, kind) { // kind: console | daemon | install | error
  const r = rt(s); r.log.push([kind || 'console', line]); if (r.log.length > 1000) r.log.splice(0, r.log.length - 1000);
  emit(s, kind === 'daemon' ? 'daemon message' : kind === 'install' ? 'install output' : kind === 'error' ? 'daemon error' : 'console output', [line]);
}
function setState(s, st) { const r = rt(s); if (r.state === st) return; r.state = st; emit(s, 'status', [st]) }
const fill = (s, t) => String(t).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (m, k) => { const v = envOf(s)[k]; return v == null ? '' : String(v) });
function envOf(s) {
  const a = allocOf(s), e = EGGS[s.egg], env = {};
  (e ? e.vars : []).forEach(v => env[v.env] = v.def);
  Object.assign(env, s.env || {});
  env.SERVER_MEMORY = String(+s.limits.memory || 1024); env.SERVER_PORT = String(a ? a.port : 25565); env.SERVER_IP = '0.0.0.0'; env.P_SERVER_UUID = s.uuid; env.P_SERVER_LOCATION = 'handy';
  return env;
}

/* ---------- Prozesse starten/stoppen ---------- */
async function prepare(s) {
  const e = EGGS[s.egg], d = dirOf(s), env = envOf(s);
  if (e && e.nest === 1) {
    await fsp.writeFile(path.join(d, 'eula.txt'), 'eula=' + (String(env.EULA).toLowerCase() === 'true') + '\n');
    const pf = path.join(d, 'server.properties'); let t = '';
    try { t = await fsp.readFile(pf, 'utf8') } catch (x) { }
    const setp = (k, v) => { const re = new RegExp('^' + k.replace('.', '\\.') + '=.*$', 'm'); t = re.test(t) ? t.replace(re, k + '=' + v) : t + (t && !t.endsWith('\n') ? '\n' : '') + k + '=' + v + '\n' };
    setp('server-port', env.SERVER_PORT); setp('query.port', env.SERVER_PORT);
    await fsp.writeFile(pf, t);
    if (String(env.EULA).toLowerCase() !== 'true') { out(s, 'Die Minecraft-EULA ist nicht akzeptiert. Setze die Variable „Minecraft-EULA akzeptieren“ (EULA) unter Startup auf true.', 'error'); return false }
  }
  return true;
}
async function start(s) {
  const r = rt(s);
  if (r.proc || s.suspended || s.status) return;
  setState(s, 'starting'); out(s, 'Server wird gestartet …', 'daemon');
  try { if (!await prepare(s)) { setState(s, 'offline'); return } } catch (e) { out(s, 'Vorbereitung fehlgeschlagen: ' + e.message, 'error'); setState(s, 'offline'); return }
  const cmd = fill(s, s.startup || (EGGS[s.egg] || {}).startup || '');
  out(s, '$ ' + cmd, 'daemon');
  const p = spawn('sh', ['-c', cmd], { cwd: dirOf(s), env: Object.assign({}, process.env, envOf(s)), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  r.proc = p; r.started = Date.now(); r.cpuT = null; s.wasRunning = true; save();
  const e = EGGS[s.egg];
  let buf = { o: '', e: '' };
  const feed = (k, ch) => { buf[k] += ch.toString('utf8'); let i; while ((i = buf[k].search(/\r?\n/)) >= 0) { const line = buf[k].slice(0, i); buf[k] = buf[k].slice(i + (buf[k][i] === '\r' ? 2 : 1)); out(s, line); if (r.state === 'starting' && e && e.done && e.done.test(line)) setState(s, 'running') } };
  p.stdout.on('data', ch => feed('o', ch)); p.stderr.on('data', ch => feed('e', ch));
  p.stdin.on('error', () => { });
  p.on('error', err => out(s, 'Start fehlgeschlagen: ' + err.message, 'error'));
  p.on('exit', (code, sig) => {
    if (buf.o) out(s, buf.o); if (buf.e) out(s, buf.e);
    r.proc = null; clearTimeout(r.killT);
    const was = r.state; setState(s, 'offline');
    out(s, 'Server beendet' + (code != null ? ' (Code ' + code + ')' : sig ? ' (' + sig + ')' : '') + '.', 'daemon');
    if (code === 127) out(s, 'Ein Befehl wurde nicht gefunden. Fehlt ein Paket? Minecraft: pkg install openjdk-21 · Python: pkg install python · Node.js: pkg install nodejs', 'error');
    if (r.restart) { r.restart = false; setTimeout(() => start(s), 1000) }
    else if (was !== 'stopping' && was !== 'offline') { s.wasRunning = false; save() }
  });
  if (!(e && e.done)) setTimeout(() => { if (r.proc === p && r.state === 'starting') setState(s, 'running') }, 1500);
}
function stop(s, kill) {
  const r = rt(s), p = r.proc; if (!p) { setState(s, 'offline'); return }
  const grp = sig => { try { process.kill(-p.pid, sig) } catch (e) { try { p.kill(sig) } catch (x) { } } };
  if (kill) { out(s, 'Prozess wird hart beendet (Kill).', 'daemon'); grp('SIGKILL'); return }
  setState(s, 'stopping'); out(s, 'Server wird gestoppt …', 'daemon'); s.wasRunning = false; save();
  const e = EGGS[s.egg];
  if (e && e.stop && e.stop !== '^C') { try { p.stdin.write(e.stop + '\n') } catch (x) { grp('SIGINT') } } else grp('SIGINT');
  clearTimeout(r.killT); r.killT = setTimeout(() => { if (r.proc === p) { out(s, 'Stoppt nicht von selbst – wird beendet.', 'daemon'); grp('SIGKILL') } }, 30000);
}
function power(s, sig) {
  if (sig === 'start') start(s);
  else if (sig === 'stop') stop(s);
  else if (sig === 'kill') stop(s, true);
  else if (sig === 'restart') { const r = rt(s); if (r.proc) { r.restart = true; stop(s) } else start(s) }
}
function command(s, cmd) { const r = rt(s); if (!r.proc) return false; try { r.proc.stdin.write(String(cmd) + '\n'); return true } catch (e) { return false } }

/* ---------- Ressourcen (aus /proc, eigene Prozesse) ---------- */
const TICK = 100, PAGE = 4096;
function procTree(root) {
  const kids = new Map(), info = new Map();
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const st = fs.readFileSync('/proc/' + d + '/stat', 'utf8'), x = st.slice(st.lastIndexOf(')') + 2).split(' '); const ppid = +x[1]; info.set(+d, { ut: +x[11] + +x[12], rss: +x[21] * PAGE }); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(+d) } catch (e) { }
    }
  } catch (e) { return null }
  let ut = 0, rss = 0; const q = [root];
  while (q.length) { const p = q.pop(), i = info.get(p); if (i) { ut += i.ut; rss += i.rss } (kids.get(p) || []).forEach(c => q.push(c)) }
  return { ut, rss };
}
async function dirSize(d) { let n = 0; const walk = async p => { let l; try { l = await fsp.readdir(p, { withFileTypes: true }) } catch (e) { return } for (const x of l) { const f = path.join(p, x.name); try { if (x.isDirectory()) await walk(f); else n += (await fsp.lstat(f)).size } catch (e) { } } }; await walk(d); return n }
function stats(s) {
  const r = rt(s);
  if (r.proc) { const t = procTree(r.proc.pid); if (t) { const nowT = Date.now(); if (r.cpuT) r.cpu = Math.max(0, (t.ut - r.cpuU) / TICK / ((nowT - r.cpuT) / 1000) * 100); r.cpuT = nowT; r.cpuU = t.ut; r.mem = t.rss } } else { r.cpu = 0; r.mem = 0; r.cpuT = null }
  if (Date.now() - r.diskT > 60000) { r.diskT = Date.now(); dirSize(dirOf(s)).then(n => r.disk = n) }
  return { memory_bytes: r.mem, memory_limit_bytes: (+s.limits.memory || 0) * 1048576, cpu_absolute: +r.cpu.toFixed(2), network: { rx_bytes: 0, tx_bytes: 0 }, state: r.state, disk_bytes: r.disk, uptime: r.proc ? Date.now() - r.started : 0 };
}
setInterval(() => { for (const s of C.servers) { const r = RT.get(s.uuid); if (r && r.ws.size) emit(s, 'stats', [JSON.stringify(stats(s))]) } }, 2000);

/* ---------- Installation ---------- */
async function getJSON(u) { const r = await fetch(u, { headers: { 'User-Agent': 'toolbox-handy-panel/' + VERSION } }); if (!r.ok) throw Error(u + ' → HTTP ' + r.status); return r.json() }
async function download(u, file, log) {
  const r = await fetch(u, { headers: { 'User-Agent': 'toolbox-handy-panel/' + VERSION } }); if (!r.ok || !r.body) throw Error('Download fehlgeschlagen (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || 0; let got = 0, lastP = -1;
  const ws = fs.createWriteStream(file + '.part');
  for await (const ch of r.body) { got += ch.length; if (!ws.write(ch)) await new Promise(res => ws.once('drain', res)); const p = total ? Math.floor(got / total * 10) : -1; if (p !== lastP && p >= 0) { lastP = p; log('… ' + (p * 10) + ' % (' + (got / 1048576).toFixed(1) + ' MB)') } }
  await new Promise((res, rej) => ws.end(e => e ? rej(e) : res()));
  await fsp.rename(file + '.part', file);
}
function run(cmd, args, cwd, log) { return new Promise(res => { let p; try { p = spawn(cmd, args, { cwd, env: process.env }) } catch (e) { log('Befehl nicht verfügbar: ' + cmd); return res(127) } const f = ch => ch.toString().split(/\r?\n/).filter(Boolean).forEach(l => log(l)); p.stdout.on('data', f); p.stderr.on('data', f); p.on('error', () => { log('Befehl nicht gefunden: ' + cmd); res(127) }); p.on('exit', c => res(c)) }) }
function javaMajor() { return new Promise(res => execFile('java', ['-version'], (err, so, se) => { if (err && !se) return res(0); const m = /version "(\d+)(?:\.(\d+))?/.exec(String(se) + String(so)); if (!m) return res(0); res(+m[1] === 1 ? +m[2] : +m[1]) })) }
async function pickPaper(want, jv, log) {
  const pr = await getJSON('https://fill.papermc.io/v3/projects/paper');
  const all = Object.values(pr.versions || {}).flat().filter(v => !/-(rc|pre)/.test(v));
  if (want && want !== 'latest') return want;
  for (const v of all) { try { const j = await getJSON('https://fill.papermc.io/v3/projects/paper/versions/' + v); const min = j.version && j.version.java && j.version.java.version && j.version.java.version.minimum || 17; if (!jv || min <= jv) return v; } catch (e) { } }
  return all[0];
}
const INST = {
  async paper(s, d, env, log) {
    const jv = await javaMajor(); log(jv ? 'Gefundenes Java: ' + jv : 'Java ist (noch) nicht installiert – installiere es mit: pkg install openjdk-21');
    const v = await pickPaper(env.MINECRAFT_VERSION, jv || 21, log); log('Minecraft-Version: ' + v);
    const b = await getJSON('https://fill.papermc.io/v3/projects/paper/versions/' + v + '/builds/latest');
    const dl = b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]); if (!dl) throw Error('Kein Download für Paper ' + v);
    log('Lade ' + dl.name + ' …'); await download(dl.url, path.join(d, env.SERVER_JARFILE || 'server.jar'), log);
  },
  async vanilla(s, d, env, log) {
    const jv = await javaMajor(); log(jv ? 'Gefundenes Java: ' + jv : 'Java ist (noch) nicht installiert – installiere es mit: pkg install openjdk-21');
    const man = await getJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    let list = man.versions.filter(v => v.type === 'release'); if (env.MINECRAFT_VERSION && env.MINECRAFT_VERSION !== 'latest') list = list.filter(v => v.id === env.MINECRAFT_VERSION);
    if (!list.length) throw Error('Version ' + env.MINECRAFT_VERSION + ' gibt es nicht.');
    for (const v of list.slice(0, 40)) { const j = await getJSON(v.url); const need = (j.javaVersion && j.javaVersion.majorVersion) || 8; if (env.MINECRAFT_VERSION !== 'latest' || need <= (jv || 21)) { log('Minecraft-Version: ' + v.id + ' (braucht Java ' + need + ')'); return download(j.downloads.server.url, path.join(d, env.SERVER_JARFILE || 'server.jar'), log) } }
    throw Error('Keine passende Version für Java ' + jv + ' gefunden.');
  },
  async fabric(s, d, env, log) {
    const jv = await javaMajor();
    const g = await getJSON('https://meta.fabricmc.net/v2/versions/game'), L = await getJSON('https://meta.fabricmc.net/v2/versions/loader'), I = await getJSON('https://meta.fabricmc.net/v2/versions/installer');
    let game = env.MINECRAFT_VERSION && env.MINECRAFT_VERSION !== 'latest' ? env.MINECRAFT_VERSION : null;
    if (!game) { const man = await getJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'); for (const v of g.filter(x => x.stable).slice(0, 30)) { const m = man.versions.find(x => x.id === v.version); if (!m) continue; const j = await getJSON(m.url); if (((j.javaVersion && j.javaVersion.majorVersion) || 8) <= (jv || 21)) { game = v.version; break } } }
    if (!game) throw Error('Keine passende Minecraft-Version gefunden.');
    const lo = L.find(x => x.stable) || L[0], ins = I.find(x => x.stable) || I[0]; log('Fabric ' + lo.version + ' für Minecraft ' + game);
    await download(`https://meta.fabricmc.net/v2/versions/loader/${game}/${lo.version}/${ins.version}/server/jar`, path.join(d, env.SERVER_JARFILE || 'server.jar'), log);
  },
  async node(s, d, env, log) {
    const f = path.join(d, env.MAIN_FILE || 'index.js');
    if (!fs.existsSync(f)) { await fsp.writeFile(f, "// Beispiel: kleine Webseite auf dem Port des Servers\nconst http = require('http');\nconst port = process.env.SERVER_PORT || 3000;\nhttp.createServer((q, r) => r.end('Hallo vom Handy-Panel!')).listen(port, () => console.log('Läuft auf Port ' + port));\nprocess.stdin.on('data', d => console.log('Befehl erhalten: ' + d.toString().trim()));\n"); log('Beispiel-Datei ' + path.basename(f) + ' angelegt.') }
    if (fs.existsSync(path.join(d, 'package.json'))) { log('npm install …'); await run('npm', ['install', '--omit=dev'], d, log) }
  },
  async python(s, d, env, log) {
    const f = path.join(d, env.MAIN_FILE || 'main.py');
    if (!fs.existsSync(f)) { await fsp.writeFile(f, "# Beispiel: kleine Webseite auf dem Port des Servers\nimport http.server, os\nport = int(os.environ.get('SERVER_PORT', '3000'))\nprint('Läuft auf Port', port, flush=True)\nhttp.server.ThreadingHTTPServer(('0.0.0.0', port), http.server.SimpleHTTPRequestHandler).serve_forever()\n"); log('Beispiel-Datei ' + path.basename(f) + ' angelegt.') }
    if (fs.existsSync(path.join(d, 'requirements.txt'))) { log('pip install -r requirements.txt …'); await run('pip', ['install', '-r', 'requirements.txt'], d, log) }
  },
  async shell(s, d, env, log) { const f = path.join(d, 'start.sh'); if (!fs.existsSync(f)) { await fsp.writeFile(f, '#!/bin/sh\n# Hier deinen Startbefehl eintragen\necho "Hallo vom Handy-Panel! Port: $SERVER_PORT"\nwhile read line; do echo "Eingabe: $line"; done\n'); log('start.sh angelegt – bearbeite sie unter „Dateien“.') } }
};
async function install(s, re) {
  const r = rt(s); if (r.proc) { stop(s, true); await sleep(800) }
  s.status = 'installing'; save(); emit(s, 'install started', []);
  const d = dirOf(s); await fsp.mkdir(d, { recursive: true });
  const log = l => out(s, l, 'install');
  log((re ? 'Neuinstallation' : 'Installation') + ' von „' + s.name + '“ (' + ((EGGS[s.egg] || {}).name || '?') + ') …');
  try { const e = EGGS[s.egg]; if (e && INST[e.install]) await INST[e.install](s, d, envOf(s), log); s.status = null; log('Installation abgeschlossen.') }
  catch (e) { s.status = 'install_failed'; log('Installation fehlgeschlagen: ' + e.message) }
  s.updated_at = now(); save(); emit(s, 'install completed', []);
  if (!s.status && s.start_on_completion && !re) start(s);
}

/* ---------- Pterodactyl-Antworten ---------- */
const list = (data, object) => ({ object: 'list', data, meta: { pagination: { total: data.length, count: data.length, per_page: Math.max(data.length, 1), current_page: 1, total_pages: 1, links: {} } } });
const allocAttr = (a, s) => ({ id: a.id, ip: a.ip, alias: a.alias, ip_alias: a.alias, port: a.port, notes: a.notes, assigned: !!C.servers.find(x => x.allocation === a.id), is_default: !!(s && s.allocation === a.id) });
const PERMS = ['websocket.connect', 'control.console', 'control.start', 'control.stop', 'control.restart', 'file.create', 'file.read', 'file.read-content', 'file.update', 'file.delete', 'file.archive', 'startup.read', 'startup.update', 'startup.docker-image', 'settings.rename', 'settings.reinstall'];
function cliSrv(s) {
  const a = allocOf(s);
  return { object: 'server', attributes: { server_owner: true, identifier: s.identifier, internal_id: s.id, uuid: s.uuid, name: s.name, node: 'Dieses Handy', is_node_under_maintenance: false, sftp_details: { ip: '', port: 0 }, description: s.description || '', limits: s.limits, invocation: fill(s, s.startup), docker_image: s.image, egg_features: [], feature_limits: s.feature_limits, status: s.status, is_suspended: !!s.suspended, is_transferring: false, relationships: { allocations: { object: 'list', data: a ? [{ object: 'allocation', attributes: allocAttr(a, s) }] : [] } } } };
}
function appSrv(s, inc) {
  const at = { id: s.id, external_id: null, uuid: s.uuid, identifier: s.identifier, name: s.name, description: s.description || '', status: s.suspended ? 'suspended' : s.status, suspended: !!s.suspended, limits: s.limits, feature_limits: s.feature_limits, user: 1, node: 1, allocation: s.allocation, nest: (EGGS[s.egg] || {}).nest || 1, egg: s.egg, container: { startup_command: s.startup, image: s.image, installed: s.status ? 0 : 1, environment: envOf(s) }, updated_at: s.updated_at, created_at: s.created_at };
  if (inc) { at.relationships = {}; if (inc.includes('user')) at.relationships.user = { object: 'user', attributes: C.user }; if (inc.includes('node')) at.relationships.node = { object: 'node', attributes: nodeAttr() }; if (inc.includes('allocations')) { const a = allocOf(s); at.relationships.allocations = { object: 'list', data: a ? [{ object: 'allocation', attributes: allocAttr(a, s) }] : [] } } }
  return { object: 'server', attributes: at };
}
function nodeAttr() {
  const used = C.servers.reduce((t, s) => ({ m: t.m + (+s.limits.memory || 0), d: t.d + (+s.limits.disk || 0) }), { m: 0, d: 0 });
  return { id: 1, uuid: 'handy-node', public: true, name: 'Dieses Handy', description: 'Läuft in Termux', location_id: 1, fqdn: '127.0.0.1', scheme: 'http', behind_proxy: false, maintenance_mode: false, memory: Math.round(os.totalmem() / 1048576), memory_overallocate: 0, disk: 0, disk_overallocate: 0, upload_size: 1024, daemon_listen: PORT, daemon_sftp: 0, daemon_base: SRV, created_at: now(), updated_at: now(), allocated_resources: { memory: used.m, disk: used.d } };
}
const fileAttr = (name, st) => {
  const m = st.mode, perm = (m & 0o777).toString(8).padStart(3, '0'), rwx = n => (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-');
  const ext = path.extname(name).toLowerCase().slice(1), txt = /^(txt|log|json|yml|yaml|properties|cfg|conf|ini|md|js|mjs|ts|py|sh|toml|xml|html|css|csv|env|lang)$/.test(ext);
  return { object: 'file_object', attributes: { name, mode: (st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-') + rwx(m >> 6) + rwx(m >> 3) + rwx(m), mode_bits: perm, size: st.isDirectory() ? 0 : st.size, is_file: st.isFile(), is_symlink: st.isSymbolicLink(), mimetype: st.isDirectory() ? 'inode/directory' : txt || name === 'eula.txt' ? 'text/plain' : ext === 'jar' ? 'application/java-archive' : ext === 'zip' ? 'application/zip' : /gz$/.test(ext) ? 'application/gzip' : 'application/octet-stream', created_at: (st.birthtime || st.mtime).toISOString(), modified_at: st.mtime.toISOString() } };
};

/* ---------- HTTP-Grundlagen ---------- */
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '600');
}
const send = (res, status, obj) => { if (obj == null) { res.writeHead(status); return res.end() } const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b) };
const err = (res, status, detail, code, field) => send(res, status, { errors: [{ code: code || 'Error', status: String(status), detail, source: field ? { field } : undefined }] });
class HErr extends Error { constructor(st, m, f) { super(m); this.st = st; this.f = f } }
const bad = (m, f) => { throw new HErr(422, m, f) };
function body(req, max) { return new Promise((res, rej) => { const b = []; let n = 0; req.on('data', c => { n += c.length; if (n > max) { rej(new HErr(413, 'Zu groß.')); req.destroy() } else b.push(c) }); req.on('end', () => res(Buffer.concat(b))); req.on('error', rej) }) }
async function json(req) { const b = await body(req, 2 * 1048576); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')) } catch (e) { throw new HErr(400, 'Ungültiges JSON.') } }
const eqKey = k => { const a = Buffer.from(String(k || '')), b = Buffer.from(C.key); return a.length === b.length && crypto.timingSafeEqual(a, b) };
function safe(s, p) { const root = dirOf(s), f = path.resolve(root, '.' + path.posix.normalize('/' + String(p || '')).replace(/^\/+/, '/')); if (f !== root && !f.startsWith(root + path.sep)) throw new HErr(400, 'Ungültiger Pfad.'); return f }
const TOK = new Map(); // Kurzzeit-Token: Konsole, Download, Upload
const token = (data, ms) => { const t = rid(24); TOK.set(t, Object.assign({ exp: Date.now() + ms }, data)); return t };
const useTok = (t, kind) => { const x = TOK.get(String(t || '')); if (!x || x.kind !== kind || x.exp < Date.now()) return null; return x };
setInterval(() => { const n = Date.now(); for (const [k, v] of TOK) if (v.exp < n) TOK.delete(k) }, 60000);
const selfUrl = req => 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
const sh = (cmd, args, cwd) => new Promise((res, rej) => execFile(cmd, args, { cwd, maxBuffer: 4 * 1048576 }, (e, so, se) => e ? rej(new HErr(e.code === 'ENOENT' ? 501 : 500, e.code === 'ENOENT' ? 'Das Programm „' + cmd + '“ fehlt. In Termux: pkg install ' + (cmd === 'unzip' ? 'unzip' : 'tar') : String(se || e.message).slice(0, 300))) : res(so)));

/* ---------- Client-API (/api/client) ---------- */
async function client(req, res, p, q) {
  const M = req.method;
  if (p === '' || p === '/') return send(res, 200, list(C.servers.map(cliSrv)));
  if (p === '/account') return send(res, 200, { object: 'user', attributes: { id: 1, admin: true, username: C.user.username, email: C.user.email, first_name: C.user.first_name, last_name: C.user.last_name, language: 'de' } });
  const m = /^\/servers\/([^/]+)(\/.*)?$/.exec(p); if (!m) throw new HErr(404, 'Nicht gefunden.');
  const s = findSrv(decodeURIComponent(m[1])); if (!s) throw new HErr(404, 'Server nicht gefunden.');
  const sub = m[2] || '', r = rt(s);
  if (sub === '' && M === 'GET') return send(res, 200, Object.assign(cliSrv(s), { meta: { is_server_owner: true, user_permissions: PERMS } }));
  if (sub === '/resources') { const st = stats(s); return send(res, 200, { object: 'stats', attributes: { current_state: r.state, is_suspended: !!s.suspended, resources: { memory_bytes: st.memory_bytes, cpu_absolute: st.cpu_absolute, disk_bytes: st.disk_bytes, network_rx_bytes: 0, network_tx_bytes: 0, uptime: st.uptime } } }) }
  if (sub === '/websocket') return send(res, 200, { data: { token: token({ kind: 'ws', uuid: s.uuid }, 86400000), socket: selfUrl(req).replace(/^http/, 'ws') + '/ws/servers/' + s.uuid } });
  if (s.suspended) throw new HErr(409, 'Der Server ist gesperrt.');
  if (sub === '/power' && M === 'POST') { const j = await json(req); if (!['start', 'stop', 'restart', 'kill'].includes(j.signal)) bad('Unbekanntes Signal.', 'signal'); if (s.status) throw new HErr(409, 'Der Server wird gerade installiert.'); power(s, j.signal); return send(res, 204) }
  if (sub === '/command' && M === 'POST') { const j = await json(req); if (!command(s, j.command)) throw new HErr(502, 'Der Server läuft nicht.'); return send(res, 204) }
  if (sub === '/startup' && M === 'GET') { const e = EGGS[s.egg] || { vars: [] }, env = envOf(s); return send(res, 200, Object.assign(list(e.vars.map(v => ({ object: 'egg_variable', attributes: { name: v.name, description: v.desc, env_variable: v.env, default_value: v.def, server_value: env[v.env], is_editable: true, rules: v.rules } }))), { meta: { startup_command: fill(s, s.startup), raw_startup_command: s.startup, docker_images: { [(e.name || 'Termux')]: s.image } } })) }
  if (sub === '/startup/variable' && M === 'PUT') { const j = await json(req), e = EGGS[s.egg] || { vars: [] }, v = e.vars.find(x => x.env === j.key); if (!v) bad('Unbekannte Variable.', 'key'); s.env = s.env || {}; s.env[v.env] = String(j.value == null ? '' : j.value); save(); return send(res, 200, { object: 'egg_variable', attributes: { name: v.name, description: v.desc, env_variable: v.env, default_value: v.def, server_value: s.env[v.env], is_editable: true, rules: v.rules } }) }
  if (sub === '/settings/rename' && M === 'POST') { const j = await json(req); if (!String(j.name || '').trim()) bad('Name fehlt.', 'name'); s.name = String(j.name).trim().slice(0, 191); s.description = String(j.description || ''); save(); return send(res, 204) }
  if (sub === '/settings/reinstall' && M === 'POST') { install(s, true); return send(res, 202) }
  if (sub === '/settings/docker-image' && M === 'PUT') { const j = await json(req); s.image = String(j.docker_image || s.image); save(); return send(res, 204) }
  if (sub.startsWith('/files')) return files(req, res, s, sub.slice(6), q);
  if (/^\/(backups|schedules|databases|network)/.test(sub)) throw new HErr(400, 'Das gibt es im Handy-Panel nicht.');
  throw new HErr(404, 'Nicht gefunden.');
}
async function uniqueCopy(f) { const d = path.dirname(f), ext = path.extname(f), b = path.basename(f, ext); for (let i = 0; i < 100; i++) { const n = path.join(d, b + ' copy' + (i ? ' ' + i : '') + ext); if (!fs.existsSync(n)) return n } throw new HErr(409, 'Zu viele Kopien.') }
async function files(req, res, s, sub, q) {
  const M = req.method, root = dirOf(s); await fsp.mkdir(root, { recursive: true });
  if (sub === '/list') { const d = safe(s, q.get('directory') || '/'); let l; try { l = await fsp.readdir(d) } catch (e) { throw new HErr(404, 'Ordner nicht gefunden.') } const out = []; for (const n of l) { try { out.push(fileAttr(n, await fsp.lstat(path.join(d, n)))) } catch (e) { } } return send(res, 200, list(out)) }
  if (sub === '/contents') { const f = safe(s, q.get('file')); let st; try { st = await fsp.stat(f) } catch (e) { throw new HErr(404, 'Datei nicht gefunden.') } if (st.isDirectory()) throw new HErr(400, 'Das ist ein Ordner.'); if (st.size > 16 * 1048576) throw new HErr(400, 'Datei zu groß.'); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return fs.createReadStream(f).pipe(res) }
  if (sub === '/download') { const f = safe(s, q.get('file')); if (!fs.existsSync(f)) throw new HErr(404, 'Datei nicht gefunden.'); return send(res, 200, { object: 'signed_url', attributes: { url: selfUrl(req) + '/download/file?token=' + token({ kind: 'dl', file: f }, 900000) } }) }
  if (sub === '/upload') return send(res, 200, { object: 'signed_url', attributes: { url: selfUrl(req) + '/upload/file?token=' + token({ kind: 'up', uuid: s.uuid }, 900000) } });
  if (sub === '/write' && M === 'POST') { const f = safe(s, q.get('file')); const b = await body(req, 64 * 1048576); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, b); return send(res, 204) }
  const j = await json(req), base = j.root || '/';
  if (sub === '/rename' && M === 'PUT') { for (const x of j.files || []) { const a = safe(s, path.posix.join(base, x.from)), b = safe(s, path.posix.join(base, x.to)); await fsp.mkdir(path.dirname(b), { recursive: true }); await fsp.rename(a, b) } return send(res, 204) }
  if (sub === '/copy' && M === 'POST') { const f = safe(s, j.location); await fsp.cp(f, await uniqueCopy(f), { recursive: true }); return send(res, 204) }
  if (sub === '/delete' && M === 'POST') { for (const n of j.files || []) { const f = safe(s, path.posix.join(base, n)); if (f === root) continue; await fsp.rm(f, { recursive: true, force: true }) } return send(res, 204) }
  if (sub === '/create-folder' && M === 'POST') { await fsp.mkdir(safe(s, path.posix.join(base, j.name || 'neu')), { recursive: true }); return send(res, 204) }
  if (sub === '/chmod' && M === 'POST') { for (const x of j.files || []) { const m = parseInt(String(x.mode), 8); if (!(m >= 0 && m <= 0o777)) bad('Ungültige Rechte.', 'mode'); await fsp.chmod(safe(s, path.posix.join(base, x.file)), m) } return send(res, 204) }
  if (sub === '/compress' && M === 'POST') { const d = safe(s, base), names = (j.files || []).map(n => { safe(s, path.posix.join(base, n)); return n }); if (!names.length) bad('Keine Dateien gewählt.', 'files'); const n = 'archive-' + now().replace(/[:.]/g, '').slice(0, 15) + '.tar.gz'; await sh('tar', ['-czf', path.join(d, n), '--', ...names], d); return send(res, 200, fileAttr(n, await fsp.lstat(path.join(d, n)))) }
  if (sub === '/decompress' && M === 'POST') { const d = safe(s, base), f = safe(s, path.posix.join(base, j.file)), n = f.toLowerCase(); if (/\.zip$/.test(n)) await sh('unzip', ['-o', '-q', f, '-d', d], d); else if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/.test(n)) await sh('tar', ['-xf', f, '-C', d], d); else bad('Dieses Archiv-Format wird nicht unterstützt (zip, tar, tar.gz).', 'file'); return send(res, 204) }
  if (sub === '/pull' && M === 'POST') {
    let u; try { u = new URL(j.url) } catch (e) { bad('Ungültige Adresse.', 'url') } if (!/^https?:$/.test(u.protocol)) bad('Nur http(s).', 'url');
    const d = safe(s, j.directory || base), name = (j.filename || decodeURIComponent(path.posix.basename(u.pathname)) || 'download').replace(/[\/\\]/g, '_');
    out(s, 'Lade ' + u.href + ' …', 'daemon'); download(u.href, path.join(d, name), l => { }).then(() => out(s, 'Fertig geladen: ' + name, 'daemon'), e => out(s, 'Laden fehlgeschlagen: ' + e.message, 'error'));
    return send(res, 204);
  }
  throw new HErr(404, 'Nicht gefunden.');
}

/* ---------- Application-API (/api/application) ---------- */
function newIdent() { let i; do { i = rid(4) } while (C.servers.some(s => s.identifier === i)); return i }
function limitsFrom(l) { l = l || {}; const n = (k, d) => Math.max(k === 'swap' ? -1 : 0, Math.round(+l[k] || d || 0)); return { memory: n('memory', 1024), swap: n('swap'), disk: n('disk'), io: Math.min(1000, Math.max(10, n('io', 500))), cpu: n('cpu'), threads: null, oom_disabled: true } }
async function application(req, res, p, q) {
  const M = req.method, inc = (q.get('include') || '').split(',');
  if (p === '/servers' && M === 'GET') return send(res, 200, list(C.servers.map(s => appSrv(s, inc))));
  if (p === '/servers' && M === 'POST') {
    const j = await json(req), e = EGGS[+j.egg];
    if (!String(j.name || '').trim()) bad('Der Name fehlt.', 'name'); if (!e) bad('Unbekanntes Egg.', 'egg');
    let al = j.allocation && C.allocs.find(a => a.id === +j.allocation.default);
    if (!al && j.deploy) al = C.allocs.find(a => !C.servers.some(s => s.allocation === a.id));
    if (!al) bad('Bitte einen freien Port wählen.', 'allocation.default'); if (C.servers.some(s => s.allocation === al.id)) bad('Dieser Port ist schon vergeben.', 'allocation.default');
    const env = {}; e.vars.forEach(v => env[v.env] = j.environment && j.environment[v.env] != null ? String(j.environment[v.env]) : v.def);
    const s = { id: ++C.seq.server, uuid: crypto.randomUUID(), identifier: newIdent(), name: String(j.name).trim().slice(0, 191), description: String(j.description || ''), egg: +j.egg, image: j.docker_image || e.image, startup: j.startup || e.startup, env, limits: limitsFrom(j.limits), feature_limits: { databases: 0, allocations: 1, backups: 0 }, allocation: al.id, status: 'installing', suspended: false, start_on_completion: !!j.start_on_completion, created_at: now(), updated_at: now() };
    C.servers.push(s); save(); setImmediate(() => install(s, false));
    return send(res, 201, appSrv(s, []));
  }
  let m = /^\/servers\/(\d+)(\/[a-z]+)?(\/force)?$/.exec(p);
  if (m) {
    const s = C.servers.find(x => x.id === +m[1]); if (!s) throw new HErr(404, 'Server nicht gefunden.'); const sub = m[2] || '';
    if (sub === '' && M === 'GET') return send(res, 200, appSrv(s, inc));
    if ((sub === '' || sub === '/force') && M === 'DELETE' || (m[3] && M === 'DELETE')) { stop(s, true); C.servers = C.servers.filter(x => x !== s); save(); RT.delete(s.uuid); fsp.rm(dirOf(s), { recursive: true, force: true }).catch(() => { }); return send(res, 204) }
    if (sub === '/details' && M === 'PATCH') { const j = await json(req); if (j.name != null) { if (!String(j.name).trim()) bad('Der Name fehlt.', 'name'); s.name = String(j.name).trim() } if (j.description != null) s.description = String(j.description); s.updated_at = now(); save(); return send(res, 200, appSrv(s, [])) }
    if (sub === '/build' && M === 'PATCH') { const j = await json(req); s.limits = limitsFrom(j); if (j.feature_limits) s.feature_limits = { databases: 0, allocations: Math.max(1, +j.feature_limits.allocations || 1), backups: 0 }; if (j.allocation && C.allocs.some(a => a.id === +j.allocation)) s.allocation = +j.allocation; s.updated_at = now(); save(); return send(res, 200, appSrv(s, [])) }
    if (sub === '/startup' && M === 'PATCH') { const j = await json(req); if (j.startup) s.startup = String(j.startup); if (j.image) s.image = String(j.image); if (j.environment) { s.env = s.env || {}; for (const k in j.environment) s.env[k] = String(j.environment[k] == null ? '' : j.environment[k]) } s.updated_at = now(); save(); return send(res, 200, appSrv(s, [])) }
    if (sub === '/suspend' && M === 'POST') { stop(s, true); s.suspended = true; save(); return send(res, 204) }
    if (sub === '/unsuspend' && M === 'POST') { s.suspended = false; save(); return send(res, 204) }
    if (sub === '/reinstall' && M === 'POST') { install(s, true); return send(res, 204) }
  }
  if (p === '/users' && M === 'GET') return send(res, 200, list([{ object: 'user', attributes: C.user }]));
  if (/^\/users\/\d+$/.test(p) && M === 'GET') return send(res, 200, { object: 'user', attributes: C.user });
  if (p.startsWith('/users')) throw new HErr(400, 'Im Handy-Panel gibt es nur einen Benutzer (dich).');
  if (p === '/locations' && M === 'GET') return send(res, 200, list([{ object: 'location', attributes: { id: 1, short: 'handy', long: 'Dieses Gerät', created_at: now(), updated_at: now() } }]));
  if (p.startsWith('/locations')) throw new HErr(400, 'Im Handy-Panel gibt es nur einen Standort.');
  if (p === '/nodes' && M === 'GET') { const n = { object: 'node', attributes: nodeAttr() }; if (inc.includes('location')) n.attributes.relationships = { location: { object: 'location', attributes: { id: 1, short: 'handy', long: 'Dieses Gerät' } } }; return send(res, 200, list([n])) }
  if (p === '/nodes/1' && M === 'GET') return send(res, 200, { object: 'node', attributes: nodeAttr() });
  if (p === '/nodes/1/configuration' && M === 'GET') return send(res, 200, { info: 'Das Handy-Panel braucht keine Wings-Konfiguration.', daemon: { listen: PORT, data: SRV }, version: VERSION });
  if (p === '/nodes/1/allocations' && M === 'GET') return send(res, 200, list(C.allocs.map(a => ({ object: 'allocation', attributes: allocAttr(a) }))));
  if (p === '/nodes/1/allocations' && M === 'POST') { const j = await json(req); const ps = (j.ports || []).flatMap(x => { const r = /^(\d+)(?:-(\d+))?$/.exec(String(x)); if (!r) return []; const a = +r[1], b = +(r[2] || r[1]); const o = []; for (let i = a; i <= b && o.length < 1000; i++)o.push(i); return o }); let n = 0; for (const port of ps) { if (port < 1024 || port > 65535 || C.allocs.some(a => a.port === port)) continue; C.allocs.push({ id: ++C.seq.alloc, ip: String(j.ip || '0.0.0.0'), alias: j.alias || null, port, notes: null }); n++ } save(); if (!n) bad('Keine neuen Ports (schon vorhanden oder ungültig).', 'ports'); return send(res, 204) }
  m = /^\/nodes\/1\/allocations\/(\d+)$/.exec(p);
  if (m && M === 'DELETE') { const id = +m[1]; if (C.servers.some(s => s.allocation === id)) throw new HErr(400, 'Dieser Port wird von einem Server benutzt.'); C.allocs = C.allocs.filter(a => a.id !== id); save(); return send(res, 204) }
  if (p.startsWith('/nodes')) throw new HErr(400, 'Das Handy-Panel hat genau einen Node: dieses Handy.');
  if (p === '/nests' && M === 'GET') return send(res, 200, list(NESTS.map(n => ({ object: 'nest', attributes: Object.assign({ id: n.id, uuid: 'nest-' + n.id, author: 'handy-panel', name: n.name, description: n.description, created_at: now(), updated_at: now() }, inc.includes('eggs') ? { relationships: { eggs: list(n.eggs.map(i => eggAttr(i, false))) } } : {}) }))));
  m = /^\/nests\/(\d+)\/eggs(?:\/(\d+))?$/.exec(p);
  if (m && M === 'GET') { const n = NESTS.find(x => x.id === +m[1]); if (!n) throw new HErr(404, 'Nicht gefunden.'); if (!m[2]) return send(res, 200, list(n.eggs.map(i => eggAttr(i, inc.includes('variables'))))); const e = eggAttr(+m[2], inc.includes('variables')); if (!e || !n.eggs.includes(+m[2])) throw new HErr(404, 'Egg nicht gefunden.'); return send(res, 200, e) }
  throw new HErr(404, 'Nicht gefunden.');
}

/* ---------- Upload (multipart/form-data, gestreamt) ---------- */
function upload(req, res, s, dir) {
  const ct = req.headers['content-type'] || '', bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!bm) return err(res, 400, 'Kein Multipart-Upload.');
  const B = Buffer.from('\r\n--' + (bm[1] || bm[2])), first = B.subarray(2);
  let buf = Buffer.alloc(0), state = 'start', ws = null, pending = [], failed = null;
  const openFile = hdr => { const m = /filename="([^"]*)"/i.exec(hdr); if (!m) return null; const name = path.basename(m[1].replace(/\\/g, '/')); if (!name) return null; const f = safe(s, path.posix.join(dir, name)); fs.mkdirSync(path.dirname(f), { recursive: true }); return fs.createWriteStream(f) };
  const closeFile = () => { if (ws) { const w = ws; pending.push(new Promise(r => w.end(r))); ws = null } };
  req.on('data', chunk => {
    if (failed) return; buf = Buffer.concat([buf, chunk]);
    for (; ;) {
      if (state === 'start') { const i = buf.indexOf(first); if (i < 0) return; buf = buf.subarray(i + first.length); state = 'afterb' }
      if (state === 'afterb') { if (buf.length < 2) return; if (buf[0] === 45 && buf[1] === 45) { state = 'end'; buf = Buffer.alloc(0); return } buf = buf.subarray(2); state = 'hdr' }
      if (state === 'hdr') { const i = buf.indexOf('\r\n\r\n'); if (i < 0) { if (buf.length > 16384) { failed = 'Ungültige Kopfzeilen'; } return } try { ws = openFile(buf.subarray(0, i).toString('utf8')) } catch (e) { failed = e.message; return } buf = buf.subarray(i + 4); state = 'data' }
      if (state === 'data') { const i = buf.indexOf(B); if (i < 0) { const keep = Math.min(buf.length, B.length); const w = buf.subarray(0, buf.length - keep); if (ws && w.length && !ws.write(w)) { req.pause(); ws.once('drain', () => req.resume()) } buf = buf.subarray(buf.length - keep); return } if (ws && i) ws.write(buf.subarray(0, i)); closeFile(); buf = buf.subarray(i + B.length); state = 'afterb' }
      if (state === 'end') return;
    }
  });
  req.on('end', async () => { closeFile(); await Promise.all(pending); if (failed) return err(res, 400, failed); send(res, 200, {}) });
  req.on('error', () => { closeFile() });
}

/* ---------- WebSocket (Live-Konsole) ---------- */
function wsAccept(req, sock) {
  const key = req.headers['sec-websocket-key'];
  const m = /^\/ws\/servers\/([0-9a-f-]+)$/.exec((req.url || '').split('?')[0]), s = m && C.servers.find(x => x.uuid === m[1]);
  if (!key || !s) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const W = { authed: false, send(t) { if (sock.destroyed) return; const p = Buffer.from(t), n = p.length; const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]); sock.write(Buffer.concat([h, p])) }, close() { try { sock.end(Buffer.from([0x88, 0])) } catch (e) { } } };
  let buf = Buffer.alloc(0), frag = [];
  const r = rt(s);
  const onMsg = txt => {
    let j; try { j = JSON.parse(txt) } catch (e) { return }
    const a = j.args || [];
    if (j.event === 'auth') { const t = useTok(a[0], 'ws'); if (!t || t.uuid !== s.uuid) { W.send(JSON.stringify({ event: 'jwt error', args: ['Ungültiges Token'] })); return } W.authed = true; r.ws.add(W); W.send(JSON.stringify({ event: 'auth success' })); W.send(JSON.stringify({ event: 'status', args: [r.state] })); return }
    if (!W.authed) return;
    if (j.event === 'send logs') { for (const [k, l] of r.log) W.send(JSON.stringify({ event: k === 'daemon' ? 'daemon message' : k === 'install' ? 'install output' : k === 'error' ? 'daemon error' : 'console output', args: [l] })) }
    else if (j.event === 'send stats') W.send(JSON.stringify({ event: 'stats', args: [JSON.stringify(stats(s))] }));
    else if (j.event === 'send command') { if (!command(s, a[0])) W.send(JSON.stringify({ event: 'daemon error', args: ['Der Server läuft nicht.'] })) }
    else if (j.event === 'set state') { if (!s.suspended && !s.status) power(s, a[0]) }
  };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (; ;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 128, op = buf[0] & 15, masked = buf[1] & 128; let n = buf[1] & 127, o = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); o = 4 } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); o = 10 }
      if (n > 4 * 1048576) { sock.destroy(); return }
      const mk = masked ? buf.subarray(o, o + 4) : null; if (masked) o += 4; if (buf.length < o + n) return;
      let p = Buffer.from(buf.subarray(o, o + n)); buf = buf.subarray(o + n);
      if (mk) for (let i = 0; i < p.length; i++)p[i] ^= mk[i & 3];
      if (op === 8) { W.close(); sock.destroy(); return }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, p.length]), p.subarray(0, 125)])); continue }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) { frag.push(p); if (fin) { const t = Buffer.concat(frag).toString('utf8'); frag = []; onMsg(t) } }
    }
  });
  const bye = () => r.ws.delete(W); sock.on('close', bye); sock.on('error', bye);
}

/* ---------- HTTP-Server ---------- */
const srv = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (p === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Toolbox Handy-Panel ' + VERSION + ' läuft. Verbinde dich mit der Toolbox-App (Server → Neue Verbindung → Handy-Panel).') }
    if (p === '/download/file') { const t = useTok(u.searchParams.get('token'), 'dl'); if (!t) throw new HErr(403, 'Link abgelaufen.'); const st = await fsp.stat(t.file); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + path.basename(t.file).replace(/"/g, '') + '"' }); return fs.createReadStream(t.file).pipe(res) }
    if (p === '/upload/file' && req.method === 'POST') { const t = useTok(u.searchParams.get('token'), 'up'), s = t && C.servers.find(x => x.uuid === t.uuid); if (!s) throw new HErr(403, 'Link abgelaufen.'); return upload(req, res, s, u.searchParams.get('directory') || '/') }
    if (!p.startsWith('/api/')) throw new HErr(404, 'Nicht gefunden.');
    const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!eqKey(k)) throw new HErr(401, 'Falscher Schlüssel. Den richtigen zeigt das Handy-Panel beim Start in Termux an.');
    if (p.startsWith('/api/client')) return await client(req, res, p.slice(11), u.searchParams);
    if (p.startsWith('/api/application')) return await application(req, res, p.slice(16), u.searchParams);
    throw new HErr(404, 'Nicht gefunden.');
  } catch (e) {
    if (res.headersSent) { try { res.end() } catch (x) { } return }
    if (e instanceof HErr) return err(res, e.st, e.message, e.st === 422 ? 'ValidationException' : 'HttpException', e.f);
    console.error(e); err(res, 500, 'Interner Fehler: ' + e.message);
  }
});
srv.on('upgrade', (req, sock) => wsAccept(req, sock));
srv.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '\nDer Port ' + PORT + ' ist schon belegt – läuft das Handy-Panel schon? Sonst: node handy-panel.js --port 8091\n' : e.message); process.exit(1) });
srv.listen(PORT, HOST, () => {
  const line = '─'.repeat(54);
  console.log('\n' + line + '\n  Toolbox Handy-Panel ' + VERSION + ' läuft\n' + line);
  console.log('  Adresse:   http://' + (HOST === '0.0.0.0' ? '<IP-dieses-Handys>' : '127.0.0.1') + ':' + PORT);
  console.log('  Schlüssel: ' + C.key);
  console.log('  Daten:     ' + BASE);
  console.log(line + '\n  In der Toolbox-App: Server → Neue Verbindung → „Handy-Panel“\n  und diesen Schlüssel einfügen.');
  console.log('  Tipp: „termux-wake-lock“ ausführen, damit Android die Server\n  im Hintergrund nicht beendet. Beenden: Strg+C\n' + line + '\n');
  if (HOST === '0.0.0.0') console.log('  ACHTUNG: --lan ist an. Jeder im WLAN mit dem Schlüssel kann zugreifen.\n');
  for (const s of C.servers) { if (s.status === 'installing') { s.status = 'install_failed'; save() } else if (s.wasRunning && !s.suspended && !s.status) start(s) }
});
const bye = () => { console.log('\nBeende Server …'); for (const s of C.servers) { const r = RT.get(s.uuid); if (r && r.proc) { try { process.kill(-r.proc.pid, 'SIGTERM') } catch (e) { } } } save(true); setTimeout(() => process.exit(0), 1500) };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
