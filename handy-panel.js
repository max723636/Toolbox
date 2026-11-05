#!/usr/bin/env node
/* =====================================================================
   Toolbox Handy-Panel  ·  kleines Server-Panel für Handy (Termux), Linux,
   Windows und Mac
   ---------------------------------------------------------------------
   Läuft ohne Docker und spricht dieselbe Sprache wie Pterodactyl. Die
   Toolbox-App steuert es wie ein echtes Panel: mehrere Server anlegen,
   starten/stoppen, Live-Konsole, Dateien, Plugins – auch von unterwegs.

   Einrichten (einmalig):  siehe Toolbox-App → Server → Neue Verbindung
                           → „Handy-Panel einrichten“ (ein Befehl je System)
   Start:                  hp        (oder: node handy-panel.js)
   Optionen:               --port 8090        anderer Port
                           --lan              auch im WLAN erreichbar
                           --fernzugriff      sichere https-Adresse für unterwegs
                           --dir <ordner>     anderer Datenordner
                           --neuer-schluessel neuen Zugangsschlüssel erzeugen
   Befehle:                hp hilfe   (zeigt alle: status, konsole, start/stop,
                           verbinden, fernzugriff, autostart, hintergrund …)
   Die Server laufen weiter, auch wenn das Panel beendet wird. Beim nächsten
   Start übernimmt das Panel sie wieder.
   Keine zusätzlichen Pakete nötig – nur Node.js 18 oder neuer.
   ===================================================================== */
'use strict';
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto'), os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const VERSION = '1.2.0';
const ARGS = process.argv.slice(2);
const WITHVAL = ['--port', '--dir', '--wrap', '--app'];
const POS = ARGS.filter((x, i) => !x.startsWith('--') && !WITHVAL.includes(ARGS[i - 1])); // Wörter, die keine Optionen sind
const CMD = POS[0] ? POS[0].toLowerCase() : null; // Termux-Befehl statt Panel-Start
const opt = n => { const i = ARGS.indexOf('--' + n); return i < 0 ? null : (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true) };
const PORT = +(opt('port') || process.env.HP_PORT || 8090);
const HOST = opt('lan') ? '0.0.0.0' : '127.0.0.1';
const BASE = path.resolve(String(opt('dir') || process.env.HP_DIR || path.join(os.homedir(), 'handy-panel')));
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin', TERMUX = /com\.termux/.test(process.env.PREFIX || '');
const WRAP = opt('wrap'); // interner Wächter-Modus für einen einzelnen Server
const PLAT = TERMUX ? 'Android (Termux)' : WIN ? 'Windows' : MAC ? 'macOS' : 'Linux';
const PY = WIN ? 'python' : 'python3';
// Vom Installationsskript mitgebrachtes Node.js/Java benutzen (ohne Administrator-Rechte installiert)
for (const d of ['node', 'java']) { const b = path.join(BASE, d); try { let bin = null; for (const c of [path.join(b, 'bin'), b]) if (fs.existsSync(path.join(c, WIN ? d + '.exe' : d))) bin = c; if (!bin) for (const x of fs.readdirSync(b)) for (const c of [path.join(b, x, 'bin'), path.join(b, x, 'Contents', 'Home', 'bin')]) if (fs.existsSync(path.join(c, WIN ? (d === 'java' ? 'java.exe' : 'node.exe') : d))) bin = c; if (bin && !(process.env.PATH || '').includes(bin)) process.env.PATH = bin + path.delimiter + process.env.PATH } catch (e) { } }
const SRV = path.join(BASE, 'servers'), CFG = path.join(BASE, 'panel.json');
const now = () => new Date().toISOString();
const rid = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Konfiguration ---------- */
fs.mkdirSync(SRV, { recursive: true });
let C;
try { C = JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch (e) { C = null }
if (!C) C = { key: '', servers: [], allocs: [], seq: { server: 0, alloc: 0 }, user: null };
if (!C.key || (opt('neuer-schluessel') && !CMD && !WRAP)) C.key = 'tbp_' + rid(20);
if (opt('app') && opt('app') !== true && !WRAP) C.app = String(opt('app')).replace(/\/*$/, '/');
if (opt('fernzugriff') && !WRAP) C.tunnel = true;
if (!C.user) C.user = { id: 1, uuid: crypto.randomUUID(), username: 'handy', email: 'handy@localhost', first_name: 'Handy', last_name: 'Panel', language: 'de', root_admin: true, '2fa': false, created_at: now(), updated_at: now() };
if (!C.allocs.length) { for (const p of [25565, 25566, 25567, 25568, 25569, 25570, 19132, 3000, 3001, 3002, 8081, 8082]) C.allocs.push({ id: ++C.seq.alloc, ip: '0.0.0.0', alias: null, port: p, notes: null }) }
let saveT = null;
function save(now_) {
  clearTimeout(saveT);
  const w = () => { const tmp = CFG + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(C, null, 1)); fs.renameSync(tmp, CFG) };
  if (now_) w(); else saveT = setTimeout(w, 200);
}
if (!WRAP && (!CMD || !fs.existsSync(CFG) || opt('app'))) save(true);

/* ---------- Vorlagen (Eggs) ---------- */
const MC_VARS = (dflt) => [
  { name: 'Minecraft-Version', env: 'MINECRAFT_VERSION', def: 'latest', desc: '„latest“ = neueste Version, die mit deinem Java läuft. Oder z. B. 1.21.11', rules: 'required|string|max:20' },
  { name: 'Server-Datei', env: 'SERVER_JARFILE', def: dflt || 'server.jar', desc: 'Name der .jar-Datei', rules: 'required|string|max:60' },
  { name: 'Minecraft-EULA akzeptieren', env: 'EULA', def: 'false', desc: 'true = du akzeptierst die Minecraft-EULA (aka.ms/MinecraftEULA). Ohne „true“ startet der Server nicht.', rules: 'required|in:true,false' }];
const JAVA_START = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui';
const NESTS = [{ id: 1, name: 'Minecraft', description: 'Minecraft: Java Edition (braucht Java 21 oder neuer)', eggs: [1, 2, 3] }, { id: 2, name: 'Programme', description: 'Eigene Programme, Bots und Web-Apps', eggs: [4, 5, 6] }];
const EGGS = {
  1: { nest: 1, name: 'Paper', description: 'Schneller Minecraft-Server mit Plugins (empfohlen).', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'paper' },
  2: { nest: 1, name: 'Vanilla', description: 'Original-Minecraft-Server von Mojang.', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'vanilla' },
  3: { nest: 1, name: 'Fabric', description: 'Minecraft mit Fabric-Mods.', image: 'termux/java', startup: JAVA_START, stop: 'stop', done: /\)! For help, type/, vars: MC_VARS(), install: 'fabric' },
  4: { nest: 2, name: 'Node.js', description: 'JavaScript-Programm oder Discord-Bot (Node.js).', image: 'termux/node', startup: 'node {{MAIN_FILE}}', stop: '^C', vars: [{ name: 'Startdatei', env: 'MAIN_FILE', def: 'index.js', desc: 'Datei, die gestartet wird', rules: 'required|string|max:100' }], install: 'node' },
  5: { nest: 2, name: 'Python', description: 'Python-Programm oder Bot.', image: 'termux/python', startup: PY + ' {{MAIN_FILE}}', stop: '^C', vars: [{ name: 'Startdatei', env: 'MAIN_FILE', def: 'main.py', desc: 'Datei, die gestartet wird', rules: 'required|string|max:100' }], install: 'python' },
  6: { nest: 2, name: 'Eigener Befehl', description: 'Startet einen beliebigen Befehl (Standard: ' + (WIN ? 'start.cmd' : 'start.sh') + ').', image: 'termux/shell', startup: WIN ? 'start.cmd' : 'sh start.sh', stop: '^C', vars: [], install: 'shell' }
};
const eggAttr = (id, inclVars) => {
  const e = EGGS[id]; if (!e) return null;
  const a = { id, uuid: 'egg-' + id, name: e.name, nest: e.nest, author: 'handy-panel', description: e.description, docker_image: e.image, docker_images: { [e.name + ' (lokal)']: e.image }, config: {}, startup: e.startup, script: {}, created_at: now(), updated_at: now() };
  if (inclVars) a.relationships = { variables: { object: 'list', data: e.vars.map((v, i) => ({ object: 'egg_variable', attributes: { id: id * 10 + i, egg_id: id, name: v.name, description: v.desc, env_variable: v.env, default_value: v.def, user_viewable: true, user_editable: true, rules: v.rules } })) } };
  return { object: 'egg', attributes: a };
};

/* ---------- Laufzeit-Zustand je Server ---------- */
const RT = new Map(); // uuid -> {proc, state, log[], ws:Set, started, cpu, stats}
const rt = s => { let r = RT.get(s.uuid); if (!r) { r = { pid: null, state: 'offline', log: [], ws: new Set(), started: 0, last: null, disk: 0, diskT: 0, mem: 0, cpu: 0 }; RT.set(s.uuid, r) } return r };
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
/* Jeder Server läuft unter einem eigenen kleinen „Wächter“ (dieses Programm mit --wrap).
   Der Wächter startet den Server, schreibt alle Ausgaben nach .hp/console.log und nimmt
   Befehle über einen nur lokal erreichbaren Anschluss an (.hp/ctl.json). Darum läuft der
   Server weiter, wenn das Panel beendet wird – auf Android, Linux, Windows und Mac. */
const hpd = s => path.join(dirOf(s), '.hp');
const ctl = s => ({ log: path.join(hpd(s), 'console.log'), ex: path.join(hpd(s), 'exit'), ctl: path.join(hpd(s), 'ctl.json'), fifo: path.join(hpd(s), 'stdin') });
const alive = pid => { // läuft der Prozess noch? (Zombies zählen als beendet)
  if (!pid) return false; try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return false }
  try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3)) } catch (e) { return true }
};
const owned = (s, pid) => { try { return fs.readlinkSync('/proc/' + pid + '/cwd') === fs.realpathSync(dirOf(s)) } catch (e) { return alive(pid) } };
const running = s => { const r = rt(s); return !!(r.pid && alive(r.pid)) };
const ctlInfo = s => { try { return JSON.parse(fs.readFileSync(ctl(s).ctl, 'utf8')) } catch (e) { return null } };
async function start(s, opts) {
  opts = opts || {}; const r = rt(s);
  if (running(s) || s.suspended || s.status) return;
  setState(s, 'starting'); out(s, 'Server wird gestartet …', 'daemon');
  try { if (!await prepare(s)) { setState(s, 'offline'); return } } catch (e) { out(s, 'Vorbereitung fehlgeschlagen: ' + e.message, 'error'); setState(s, 'offline'); return }
  const F = ctl(s);
  try {
    await fsp.mkdir(hpd(s), { recursive: true });
    try { if ((await fsp.stat(F.log)).size > 10 * 1048576) await fsp.rename(F.log, F.log.replace(/\.log$/, '.alt.log')) } catch (e) { }
    for (const f of [F.ex, F.ctl]) { try { await fsp.unlink(f) } catch (e) { } }
  } catch (e) { out(s, 'Start nicht möglich: ' + e.message, 'error'); setState(s, 'offline'); return }
  const cmd = fill(s, s.startup || (EGGS[s.egg] || {}).startup || '');
  out(s, '$ ' + cmd, 'daemon');
  let off = 0; try { off = fs.statSync(F.log).size } catch (e) { }
  const w = spawn(process.execPath, [path.resolve(__filename), '--wrap', s.uuid, '--dir', BASE], { cwd: dirOf(s), env: Object.assign({}, process.env, envOf(s), { HP_CMD: cmd }), detached: true, stdio: 'ignore', windowsHide: true });
  w.on('error', err => out(s, 'Start fehlgeschlagen: ' + err.message, 'error'));
  w.unref();
  s.pid = w.pid; s.started = Date.now(); s.wasRunning = true; save(opts.now);
  if (!opts.detach) follow(s, off, true);
}
// Ausgaben eines (auch schon laufenden) Servers mitlesen und auf sein Ende achten
function follow(s, off, fresh) {
  const r = rt(s); r.pid = s.pid; r.started = s.started || Date.now(); r.off = off; r.part = ''; r.skip1 = off > 0 && !fresh; r.dec = new StringDecoder('utf8'); r.cpuT = null; r.child = null;
  setState(s, fresh ? 'starting' : 'running');
  const e = EGGS[s.egg];
  if (fresh && !(e && e.done)) setTimeout(() => { if (r.pid === s.pid && r.state === 'starting') setState(s, 'running') }, 1500);
  clearInterval(r.iv); r.iv = setInterval(() => pump(s), 400); pump(s);
}
function pump(s) {
  const r = rt(s), F = ctl(s), e = EGGS[s.egg];
  try {
    const st = fs.statSync(F.log); if (st.size < r.off) r.off = 0;
    while (st.size > r.off) {
      const n = Math.min(st.size - r.off, 1048576), b = Buffer.alloc(n), fd = fs.openSync(F.log, 'r');
      try { fs.readSync(fd, b, 0, n, r.off) } finally { fs.closeSync(fd) }
      r.off += n; r.part += r.dec.write(b);
      let i; while ((i = r.part.indexOf('\n')) >= 0) {
        const line = r.part.slice(0, i).replace(/\r$/, ''); r.part = r.part.slice(i + 1);
        if (r.skip1) { r.skip1 = false; continue }
        out(s, line); if (r.state === 'starting' && e && e.done && e.done.test(line)) setState(s, 'running');
      }
    }
  } catch (x) { }
  if (r.pid && !alive(r.pid)) gone(s);
}
const HINT = () => TERMUX ? 'Minecraft: pkg install openjdk-21 · Python: pkg install python · Node.js: pkg install nodejs' : WIN ? 'Java (Minecraft): adoptium.net · Python: python.org · Node.js: nodejs.org – danach das Panel neu starten.' : MAC ? 'Java: brew install openjdk@21 · Python: brew install python' : 'Java: sudo apt install openjdk-21-jre-headless · Python: sudo apt install python3';
function gone(s) {
  const r = rt(s); clearInterval(r.iv); r.iv = null; clearTimeout(r.killT);
  let code = null; try { code = parseInt(fs.readFileSync(ctl(s).ex, 'utf8'), 10) } catch (e) { }
  if (r.part) { out(s, r.part); r.part = '' }
  r.pid = null; r.child = null; s.pid = null;
  const was = r.state; setState(s, 'offline');
  out(s, 'Server beendet' + (code != null && !isNaN(code) ? ' (Code ' + code + ')' : '') + '.', 'daemon');
  if (code === 127 || (WIN && code === 9009)) out(s, 'Ein Befehl wurde nicht gefunden. Fehlt ein Programm? ' + HINT(), 'error');
  if (r.restart) { r.restart = false; save(); setTimeout(() => start(s), 1000) }
  else { if (was !== 'stopping') s.wasRunning = false; save() }
}
// Prozessbaum hart beenden (Fallback, falls der Wächter nicht antwortet)
const grp = (pid, sig) => { if (!pid) return; if (WIN) { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { }); return } try { process.kill(-pid, sig) } catch (e) { try { process.kill(pid, sig) } catch (x) { } } };
// Nachricht an den Wächter eines Servers (z. B. „cmd say Hallo“, „int“, „kill“)
function ctlSend(s, line) {
  return new Promise(res => {
    const c = ctlInfo(s);
    if (!c) { // Server aus einer älteren Panel-Version (Pipe statt Wächter)
      if (!/^cmd /.test(line)) return res(false);
      try { const fd = fs.openSync(ctl(s).fifo, 'r+'); try { fs.writeSync(fd, line.slice(4) + '\n') } finally { fs.closeSync(fd) } return res(true) } catch (e) { return res(false) }
    }
    let done = false; const so = net.connect(c.port, '127.0.0.1', () => so.write(c.tok + '\n' + line + '\n'));
    const fin = v => { if (done) return; done = true; try { so.destroy() } catch (e) { } res(v) };
    so.on('data', d => { if (/ok/.test(String(d))) fin(true) }); so.on('error', () => fin(false)); setTimeout(() => fin(false), 3000);
  });
}
async function sig(s, g) {
  if (await ctlSend(s, { SIGINT: 'int', SIGTERM: 'term', SIGKILL: 'kill' }[g])) return;
  const c = ctlInfo(s); if (c && c.child) grp(c.child, g); grp(s.pid || rt(s).pid, g);
}
async function stop(s, kill) {
  const r = rt(s), pid = r.pid; if (!pid || !alive(pid)) { if (pid) gone(s); else setState(s, 'offline'); return }
  if (kill) { out(s, 'Prozess wird hart beendet (Kill).', 'daemon'); await sig(s, 'SIGKILL'); return }
  setState(s, 'stopping'); out(s, 'Server wird gestoppt …', 'daemon'); s.wasRunning = false; save();
  const e = EGGS[s.egg];
  if (!(e && e.stop && e.stop !== '^C' && await command(s, e.stop))) await sig(s, 'SIGINT');
  clearTimeout(r.killT); r.killT = setTimeout(() => { if (r.pid === pid && alive(pid)) { out(s, 'Stoppt nicht von selbst – wird beendet.', 'daemon'); sig(s, 'SIGKILL') } }, 30000);
}
function power(s, sg) {
  if (sg === 'start') start(s);
  else if (sg === 'stop') stop(s);
  else if (sg === 'kill') stop(s, true);
  else if (sg === 'restart') { const r = rt(s); if (running(s)) { r.restart = true; stop(s) } else start(s) }
}
const command = async (s, cmd) => { const r = rt(s); if (!r.pid) r.pid = s.pid; if (!alive(r.pid)) return false; return ctlSend(s, 'cmd ' + String(cmd).replace(/[\r\n]+/g, ' ')) };
/* Der Wächter selbst: startet den Server-Befehl und reicht Befehle weiter */
function wrapper(uuid) {
  if (!/^[0-9a-f-]{36}$/.test(uuid)) process.exit(2);
  const s = { uuid }; // braucht keine Konfiguration – nur den Ordner des Servers
  const F = ctl(s), cmd = process.env.HP_CMD || '', fd = fs.openSync(F.log, 'a');
  const ch = spawn(WIN ? (process.env.ComSpec || 'cmd.exe') : 'sh', WIN ? ['/d', '/s', '/c', '"' + cmd + '"'] : ['-c', cmd], { cwd: process.cwd(), env: process.env, stdio: ['pipe', fd, fd], detached: !WIN, windowsHide: true, windowsVerbatimArguments: WIN });
  ch.stdin.on('error', () => { });
  const kill = g => { if (WIN) { execFile('taskkill', ['/PID', String(ch.pid), '/T'].concat(g === 'SIGTERM' ? [] : ['/F']), { windowsHide: true }, () => { }); return } try { process.kill(-ch.pid, g) } catch (e) { try { ch.kill(g) } catch (x) { } } };
  const tok = rid(16);
  const sv = net.createServer(so => {
    let b = '', ok = false; so.setEncoding('utf8'); so.on('error', () => { });
    so.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) {
      const l = b.slice(0, i).replace(/\r$/, ''); b = b.slice(i + 1);
      if (!ok) { ok = l === tok; if (!ok) { so.destroy(); return } continue }
      const k = l.indexOf(' '), op = k < 0 ? l : l.slice(0, k), arg = k < 0 ? '' : l.slice(k + 1);
      if (op === 'cmd') { try { ch.stdin.write(arg + '\n') } catch (e) { } } else if (op === 'int') kill('SIGINT'); else if (op === 'term') kill('SIGTERM'); else if (op === 'kill') kill('SIGKILL');
      so.write('ok\n') } });
  });
  sv.listen(0, '127.0.0.1', () => { try { fs.writeFileSync(F.ctl, JSON.stringify({ port: sv.address().port, tok, pid: process.pid, child: ch.pid })) } catch (e) { } });
  const end = c => { try { fs.writeFileSync(F.ex, String(c)) } catch (e) { } try { fs.unlinkSync(F.ctl) } catch (e) { } process.exit(0) };
  ch.on('exit', (c, g) => end(c != null ? c : g === 'SIGKILL' ? 137 : 130));
  ch.on('error', e => { try { fs.appendFileSync(F.log, 'Start fehlgeschlagen: ' + e.message + '\n') } catch (x) { } end(127) });
  for (const g of ['SIGINT', 'SIGHUP']) { try { process.on(g, () => { }) } catch (e) { } }
  try { process.on('SIGTERM', () => kill('SIGTERM')) } catch (e) { }
}

/* ---------- Ressourcen (Linux/Android: /proc · Mac: ps · Windows: PowerShell) ---------- */
const TICK = 100, PAGE = 4096;
function procTree(root) {
  const kids = new Map(), info = new Map();
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const st = fs.readFileSync('/proc/' + d + '/stat', 'utf8'), x = st.slice(st.lastIndexOf(')') + 2).split(' '); const ppid = +x[1]; info.set(+d, { ut: +x[11] + +x[12], rss: +x[21] * PAGE }); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(+d) } catch (e) { }
    }
  } catch (e) { return null }
  if (!info.size) return null;
  let ut = 0, rss = 0; const q = [root];
  while (q.length) { const p = q.pop(), i = info.get(p); if (i) { ut += i.ut; rss += i.rss } (kids.get(p) || []).forEach(c => q.push(c)) }
  return { ut, rss };
}
// Prozessliste über Systemprogramme (für Systeme ohne /proc), höchstens alle 4 s
const PS = { t: 0, map: null, busy: false };
const secs = t => { t = String(t).trim(); let d = 0; const m = /^(\d+)-(.*)$/.exec(t); if (m) { d = +m[1]; t = m[2] } return d * 86400 + t.split(':').reduce((a, x) => a * 60 + parseFloat(x || 0), 0) };
function psRefresh() {
  if (PS.busy || Date.now() - PS.t < 4000) return; PS.busy = true;
  const done = so => { const m = new Map(); String(so || '').split(/\r?\n/).forEach(l => { const x = l.trim().split(/[\s,]+/); if (x.length >= 4 && /^\d+$/.test(x[0])) m.set(+x[0], { ppid: +x[1], rss: WIN ? +x[2] : +x[2] * 1024, ut: WIN ? +x[3] / 1e7 * TICK : secs(x[3]) * TICK }) }); PS.map = m; PS.t = Date.now(); PS.busy = false };
  if (WIN) execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.KernelModeTime + $_.UserModeTime)" }'], { windowsHide: true, maxBuffer: 16e6, timeout: 15000 }, (e, so) => done(so));
  else execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { maxBuffer: 16e6, timeout: 10000 }, (e, so) => done(so));
}
function psTree(root) {
  psRefresh(); const m = PS.map; if (!m || !m.has(root)) return null;
  const kids = new Map(); for (const [pid, x] of m) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(pid) }
  let ut = 0, rss = 0; const q = [root]; while (q.length) { const p = q.pop(), x = m.get(p); if (x) { ut += x.ut; rss += x.rss } (kids.get(p) || []).forEach(c => q.push(c)) }
  return { ut, rss, t: PS.t };
}
async function dirSize(d) { let n = 0; const walk = async p => { let l; try { l = await fsp.readdir(p, { withFileTypes: true }) } catch (e) { return } for (const x of l) { const f = path.join(p, x.name); try { if (x.isDirectory()) await walk(f); else n += (await fsp.lstat(f)).size } catch (e) { } } }; await walk(d); return n }
function stats(s) {
  const r = rt(s);
  if (r.pid) {
    if (!r.child) { const c = ctlInfo(s); r.child = (c && c.child) || null }
    const root = r.child || r.pid, t = (!process.env.HP_NOPROC && procTree(root)) || psTree(root);
    if (t) { const nowT = t.t || Date.now(); if (r.cpuT && nowT > r.cpuT) r.cpu = Math.max(0, (t.ut - r.cpuU) / TICK / ((nowT - r.cpuT) / 1000) * 100); if (!r.cpuT || nowT > r.cpuT) { r.cpuT = nowT; r.cpuU = t.ut } r.mem = t.rss }
  } else { r.cpu = 0; r.mem = 0; r.cpuT = null }
  if (Date.now() - r.diskT > 60000) { r.diskT = Date.now(); dirSize(dirOf(s)).then(n => r.disk = n) }
  return { memory_bytes: r.mem, memory_limit_bytes: (+s.limits.memory || 0) * 1048576, cpu_absolute: +r.cpu.toFixed(2), network: { rx_bytes: 0, tx_bytes: 0 }, state: r.state, disk_bytes: r.disk, uptime: r.pid ? Date.now() - r.started : 0 };
}
setInterval(() => { for (const s of C.servers) { const r = RT.get(s.uuid); if (r && r.ws.size) emit(s, 'stats', [JSON.stringify(stats(s))]) } }, 2000).unref();

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
function run(cmd, args, cwd, log) { return new Promise(res => { let p; try { p = spawn(cmd, args, { cwd, env: process.env, shell: WIN, windowsHide: true }) } catch (e) { log('Befehl nicht verfügbar: ' + cmd); return res(127) } const f = ch => ch.toString().split(/\r?\n/).filter(Boolean).forEach(l => log(l)); p.stdout.on('data', f); p.stderr.on('data', f); p.on('error', () => { log('Befehl nicht gefunden: ' + cmd); res(127) }); p.on('exit', c => res(c)) }) }
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
    const jv = await javaMajor(); log(jv ? 'Gefundenes Java: ' + jv : 'Java ist (noch) nicht installiert. ' + HINT());
    const v = await pickPaper(env.MINECRAFT_VERSION, jv || 21, log); log('Minecraft-Version: ' + v);
    const b = await getJSON('https://fill.papermc.io/v3/projects/paper/versions/' + v + '/builds/latest');
    const dl = b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]); if (!dl) throw Error('Kein Download für Paper ' + v);
    log('Lade ' + dl.name + ' …'); await download(dl.url, path.join(d, env.SERVER_JARFILE || 'server.jar'), log);
  },
  async vanilla(s, d, env, log) {
    const jv = await javaMajor(); log(jv ? 'Gefundenes Java: ' + jv : 'Java ist (noch) nicht installiert. ' + HINT());
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
    if (fs.existsSync(path.join(d, 'requirements.txt'))) { log('pip install -r requirements.txt …'); await run(PY, ['-m', 'pip', 'install', '-r', 'requirements.txt'], d, log) }
  },
  async shell(s, d, env, log) {
    if (WIN) { const f = path.join(d, 'start.cmd'); if (!fs.existsSync(f)) { await fsp.writeFile(f, '@echo off\r\nrem Hier deinen Startbefehl eintragen\r\necho Hallo vom Handy-Panel! Port: %SERVER_PORT%\r\n:loop\r\nset /p line=\r\nif errorlevel 1 goto :eof\r\necho Eingabe: %line%\r\ngoto loop\r\n'); log('start.cmd angelegt – bearbeite sie unter „Dateien“.') } return }
    const f = path.join(d, 'start.sh'); if (!fs.existsSync(f)) { await fsp.writeFile(f, '#!/bin/sh\n# Hier deinen Startbefehl eintragen\necho "Hallo vom Handy-Panel! Port: $SERVER_PORT"\nwhile read line; do echo "Eingabe: $line"; done\n'); log('start.sh angelegt – bearbeite sie unter „Dateien“.') } }
};
async function install(s, re) {
  if (running(s)) { stop(s, true); await sleep(800) }
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
setInterval(() => { const n = Date.now(); for (const [k, v] of TOK) if (v.exp < n) TOK.delete(k) }, 60000).unref();
// Eigene Adresse für Links (Konsole, Download): über den Fernzugriff (cloudflared) immer https/wss
const selfUrl = req => { const h = req.headers, host = h.host || ('127.0.0.1:' + PORT), pr = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return (pr === 'https' || /"scheme":"https"/.test(h['cf-visitor'] || '') || /\.trycloudflare\.com$/i.test(host.split(':')[0]) ? 'https' : 'http') + '://' + host };
const sh = (cmd, args, cwd) => new Promise((res, rej) => execFile(cmd, args, { cwd, maxBuffer: 4 * 1048576 }, (e, so, se) => e ? rej(new HErr(e.code === 'ENOENT' ? 501 : 500, e.code === 'ENOENT' ? 'Das Programm „' + cmd + '“ fehlt.' + (TERMUX ? ' In Termux: pkg install ' + cmd : WIN ? '' : ' Installiere es (z. B. sudo apt install ' + cmd + ').') : String(se || e.message).slice(0, 300))) : res(so)));

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
  if (sub === '/command' && M === 'POST') { const j = await json(req); if (!await command(s, j.command)) throw new HErr(502, 'Der Server läuft nicht.'); return send(res, 204) }
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
  if (sub === '/list') { const d = safe(s, q.get('directory') || '/'); let l; try { l = await fsp.readdir(d) } catch (e) { throw new HErr(404, 'Ordner nicht gefunden.') } const out = []; for (const n of l) { if (d === root && n === '.hp') continue; try { out.push(fileAttr(n, await fsp.lstat(path.join(d, n)))) } catch (e) { } } return send(res, 200, list(out)) }
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
  if (sub === '/decompress' && M === 'POST') { const d = safe(s, base), f = safe(s, path.posix.join(base, j.file)), n = f.toLowerCase(); if (/\.zip$/.test(n)) { if (WIN || MAC) await sh('tar', ['-xf', f, '-C', d], d); else await sh('unzip', ['-o', '-q', f, '-d', d], d) } else if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/.test(n)) await sh('tar', ['-xf', f, '-C', d], d); else bad('Dieses Archiv-Format wird nicht unterstützt (zip, tar, tar.gz).', 'file'); return send(res, 204) }
  if (sub === '/pull' && M === 'POST') {
    let u; try { u = new URL(j.url) } catch (e) { bad('Ungültige Adresse.', 'url') } if (!/^https?:$/.test(u.protocol)) bad('Nur http(s).', 'url');
    const d = safe(s, j.directory || base), name = (j.filename || decodeURIComponent(path.posix.basename(u.pathname)) || 'download').replace(/[\/\\]/g, '_');
    await fsp.mkdir(d, { recursive: true }); out(s, 'Lade ' + u.href + ' …', 'daemon');
    const job = download(u.href, path.join(d, name), l => { }).then(() => out(s, 'Fertig geladen: ' + name, 'daemon'), e => { out(s, 'Laden fehlgeschlagen: ' + e.message, 'error'); throw e });
    if (j.foreground) { try { await job } catch (e) { throw new HErr(502, 'Download fehlgeschlagen: ' + e.message) } } else job.catch(() => { });
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
    else if (j.event === 'send command') { command(s, a[0]).then(ok => { if (!ok) W.send(JSON.stringify({ event: 'daemon error', args: ['Der Server läuft nicht.'] })) }) }
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

/* ---------- Fernzugriff: kostenloser Cloudflare-Schnelltunnel (https, ohne Konto, ohne Router-Einstellungen) ---------- */
const TUN = { proc: null, url: null, state: 'aus', err: '', tries: 0, t: null };
let STOPPING = false;
const cfName = WIN ? 'cloudflared.exe' : 'cloudflared';
function cfBin() {
  const own = path.join(BASE, 'bin', cfName); if (fs.existsSync(own)) return own;
  for (const d of (process.env.PATH || '').split(path.delimiter)) { if (!d) continue; const f = path.join(d, cfName); if (fs.existsSync(f)) return f }
  return null;
}
async function cfInstall(log) {
  if (TERMUX) { log('Installiere cloudflared (pkg install cloudflared) …'); await run('pkg', ['install', '-y', 'cloudflared'], BASE, log); const b = cfBin(); if (!b) throw Error('cloudflared ließ sich nicht installieren. Versuche: pkg install cloudflared'); return b }
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch]; if (!arch) throw Error('Für diesen Prozessor (' + process.arch + ') gibt es kein cloudflared.');
  const plat = WIN ? 'windows' : MAC ? 'darwin' : 'linux', name = 'cloudflared-' + plat + '-' + arch + (WIN ? '.exe' : MAC ? '.tgz' : '');
  const dir = path.join(BASE, 'bin'), dest = path.join(dir, cfName), url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + name;
  await fsp.mkdir(dir, { recursive: true }); log('Lade cloudflared (' + name + ') …');
  if (MAC) { const tgz = path.join(dir, name); await download(url, tgz, log); await sh('tar', ['-xzf', tgz, '-C', dir], dir); try { fs.unlinkSync(tgz) } catch (e) { } }
  else await download(url, dest, log);
  if (!WIN) fs.chmodSync(dest, 0o755);
  return dest;
}
async function tunnelStart() {
  if (TUN.proc || STOPPING) return; clearTimeout(TUN.t); TUN.state = 'startet'; TUN.err = '';
  let bin = cfBin();
  if (!bin) { try { TUN.state = 'installiert cloudflared'; bin = await cfInstall(l => console.log('  [Fernzugriff] ' + l)) } catch (e) { TUN.state = 'fehler'; TUN.err = e.message; console.log('  [Fernzugriff] ' + e.message); return } }
  if (!C.tunnel || TUN.proc) return;
  const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  TUN.proc = p; TUN.state = 'verbindet';
  const scan = d => { const t = String(d), m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(t);
    if (m && TUN.url !== m[0]) { TUN.url = m[0]; TUN.tries = 0; console.log('  🌍 Fernzugriff an: ' + TUN.url); publishUrl() }
    if (/Registered tunnel connection/i.test(t)) TUN.state = 'an' };
  p.stdout.on('data', scan); p.stderr.on('data', scan);
  p.on('error', e => { TUN.state = 'fehler'; TUN.err = e.message });
  p.on('exit', code => { if (TUN.proc !== p) return; TUN.proc = null; TUN.url = null;
    if (C.tunnel && !STOPPING) { const d = [5, 15, 30, 60, 120][Math.min(TUN.tries++, 4)]; TUN.state = 'fehler'; TUN.err = 'cloudflared wurde beendet (Code ' + code + '). Neuer Versuch in ' + d + ' s.'; TUN.t = setTimeout(tunnelStart, d * 1000) } else TUN.state = 'aus' });
}
function tunnelStop() { clearTimeout(TUN.t); const p = TUN.proc; TUN.proc = null; TUN.url = null; TUN.state = 'aus'; TUN.err = ''; if (p) { try { p.kill() } catch (e) { } } }
// Aktuelle Adresse verschlüsselt hinterlegen, damit die App sie nach einem Neustart selbst findet (ntfy.sh)
const sha = t => crypto.createHash('sha256').update(t).digest();
const topicOf = k => 'tbhp-' + sha('topic:' + k).toString('hex').slice(0, 32);
function seal(o) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', sha('seal:' + C.key), iv); const ct = Buffer.concat([c.update(JSON.stringify(o)), c.final(), c.getAuthTag()]); return Buffer.concat([iv, ct]).toString('base64') }
async function publishUrl() { if (!TUN.url) return; try { await fetch((process.env.HP_NTFY || 'https://ntfy.sh') + '/' + topicOf(C.key), { method: 'POST', body: seal({ u: TUN.url, t: Date.now(), v: VERSION }), signal: AbortSignal.timeout(15000) }) } catch (e) { } }
setInterval(publishUrl, 6 * 3600e3).unref();

/* ---------- Koppeln mit der App ---------- */
const htmlEsc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function lanUrls() { if (HOST !== '0.0.0.0') return []; const o = []; for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (a.family === 'IPv4' && !a.internal) o.push('http://' + a.address + ':' + PORT); return o }
function pairInfo() {
  const o = { v: 1, k: C.key, l: 'http://127.0.0.1:' + PORT, n: (os.hostname() || PLAT).slice(0, 40), p: TERMUX ? 'android' : process.platform }; if (TUN.url) o.r = TUN.url; const a = lanUrls(); if (a.length) o.a = a;
  const code = 'HP1' + Buffer.from(JSON.stringify(o)).toString('base64url');
  return { code, link: C.app ? C.app + '#hp=' + code : null };
}
function info() { const p = pairInfo(); return { version: VERSION, platform: PLAT, os: process.platform, arch: process.arch, host: os.hostname(), node: process.versions.node, servers: C.servers.length, running: C.servers.filter(running).length, tunnel: { on: !!C.tunnel, state: TUN.state, url: TUN.url, err: TUN.err }, lan: lanUrls(), local: 'http://127.0.0.1:' + PORT, app: C.app || null, code: p.code, link: p.link } }
// Nur direkt auf diesem Gerät (nicht über Tunnel/WLAN): Seite mit QR-Code und Schlüssel
const isLocal = req => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['cf-connecting-ip'] && !req.headers['cf-ray'] && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
function pageHtml() {
  const p = pairInfo(), t = TUN, q = JSON.stringify(p.link || p.code);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handy-Panel</title>
<style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:20px 16px;background:#0b0f19;color:#e8ecf7}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 8px}a{color:#818cf8}code{background:#0b0f19;padding:2px 6px;border-radius:6px;word-break:break-all;font-size:13px}.c{background:#131a2a;border:1px solid #242d44;border-radius:14px;padding:16px;margin:14px 0}#qr{background:#fff;padding:12px;border-radius:12px;display:inline-block;margin:6px 0}button,.b{display:inline-block;font:inherit;font-weight:600;padding:10px 16px;border-radius:10px;border:0;background:#818cf8;color:#0b0f19;cursor:pointer;text-decoration:none;margin:4px 0}.m{color:#8b97b3;font-size:14px}</style></head><body>
<h1>Toolbox Handy-Panel ${VERSION}</h1><p class="m">Läuft auf ${htmlEsc(PLAT)} · ${htmlEsc(os.hostname())} · ${C.servers.length} Server, ${C.servers.filter(running).length} laufen</p>
<div class="c"><h2>Mit der Toolbox-App verbinden</h2>${p.link ? `<a class="b" href="${htmlEsc(p.link)}">In der App öffnen</a><p class="m">Auf einem anderen Gerät: QR-Code mit der Kamera scannen.</p>` : '<p class="m">In der App: Server → Neue Verbindung → Handy-Panel → QR-Code scannen.</p>'}
${t.url ? '' : '<p class="m"><b>Für ein anderes Gerät (z. B. dein Handy)</b> schalte unten zuerst den Fernzugriff ein – dann enthält der QR-Code die sichere https-Adresse.</p>'}<div id="qr"></div><p class="m">Oder diesen Verbindungs-Code in der App einfügen:</p><p><code id="code">${htmlEsc(p.code)}</code></p><button onclick="navigator.clipboard.writeText(document.getElementById('code').textContent).then(()=>this.textContent='Kopiert ✓')">Code kopieren</button></div>
<div class="c"><h2>Fernzugriff ${t.url ? '✓ an' : C.tunnel ? '…' : 'aus'}</h2><p>${t.url ? 'Erreichbar von überall über <code>' + htmlEsc(t.url) + '</code>' : C.tunnel ? 'Wird eingerichtet (' + htmlEsc(t.state) + (t.err ? ': ' + htmlEsc(t.err) : '') + ') …' : 'Aus – das Panel ist nur von diesem Gerät erreichbar.'}</p>
<button onclick="tg()">${C.tunnel ? 'Fernzugriff ausschalten' : 'Fernzugriff einschalten'}</button><p class="m">Mit Fernzugriff bekommt das Panel eine sichere https-Adresse über einen kostenlosen Cloudflare-Tunnel. Dann steuert die App es von überall – ohne Portfreigabe im Router. Ohne den Schlüssel kommt niemand hinein.</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>try{new QRCode(document.getElementById('qr'),{text:${q},width:256,height:256,correctLevel:QRCode.CorrectLevel.L})}catch(e){document.getElementById('qr').textContent='Für den QR-Code braucht diese Seite Internet – nutze den Code darunter.'}
async function tg(){await fetch('/api/handy/tunnel',{method:'POST',headers:{Authorization:'Bearer ${C.key}','Content-Type':'application/json'},body:JSON.stringify({on:${!C.tunnel}})});setTimeout(()=>location.reload(),1500)}
${C.tunnel && !t.url ? 'setTimeout(()=>location.reload(),4000)' : ''}</script></body></html>`;
}

/* ---------- Selbst-Update und Neustart ---------- */
const vcmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0) } return 0 };
async function selfUpdate(base, force) {
  const u = String(base).replace(/\/*$/, '/') + 'handy-panel.js';
  let r; try { r = await fetch(u, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) }) } catch (e) { throw new HErr(502, 'Download nicht möglich: ' + e.message) }
  if (!r.ok) throw new HErr(502, 'Download fehlgeschlagen (HTTP ' + r.status + ').');
  const t = await r.text(), m = /const VERSION = '([\d.]+)'/.exec(t);
  if (!m || !/Toolbox Handy-Panel/.test(t)) throw new HErr(502, 'Die geladene Datei ist kein Handy-Panel.');
  if (vcmp(m[1], VERSION) <= 0 && !force) return { updated: false, version: VERSION, latest: m[1] };
  const me = path.resolve(__filename), tmp = me.replace(/\.js$/i, '') + '.neu.js'; fs.writeFileSync(tmp, t);
  await new Promise((res, rej) => execFile(process.execPath, ['--check', tmp], { windowsHide: true }, e => { if (e) { try { fs.unlinkSync(tmp) } catch (x) { } rej(new HErr(502, 'Die neue Version ist fehlerhaft – nichts geändert.')) } else res() }));
  try { fs.copyFileSync(me, me + '.alt') } catch (e) { } fs.renameSync(tmp, me);
  return { updated: true, from: VERSION, version: m[1] };
}
function restartSelf() {
  STOPPING = true; tunnelStop(); save(true); try { fs.unlinkSync(path.join(BASE, 'panel.pid')) } catch (e) { }
  try { srv.close(); srv.closeAllConnections() } catch (e) { }
  if (process.env.HP_SUPERVISED) { console.log('Neue Version installiert – Neustart durch den Autostart-Dienst.'); setTimeout(() => process.exit(0), 300); return }
  const fd = fs.openSync(path.join(BASE, 'panel.log'), 'a');
  const c = spawn(process.execPath, process.argv.slice(1).filter(a => a !== '--neustart').concat(['--neustart']), { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: process.cwd() }); c.unref();
  console.log('\nNeue Version installiert – das Panel läuft jetzt im Hintergrund weiter (Protokoll: ' + path.join(BASE, 'panel.log') + '). Status: hp status');
  setTimeout(() => process.exit(0), 300);
}

/* ---------- HTTP-Server ---------- */
const FAIL = new Map(); // Schutz gegen das Durchprobieren von Schlüsseln
async function handyApi(req, res, p) {
  const M = req.method;
  if (p === '/info') return send(res, 200, info());
  if (p === '/tunnel' && M === 'POST') { const j = await json(req); C.tunnel = !!j.on; save(); if (C.tunnel) tunnelStart(); else tunnelStop(); await sleep(400); return send(res, 200, info()) }
  if (p === '/update' && M === 'POST') { const j = await json(req), from = String(j.from || C.app || ''); if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(from)) bad('Unbekannte Quelle für das Update.', 'from'); const r = await selfUpdate(from, !!j.force); send(res, 200, r); if (r.updated) setTimeout(restartSelf, 400); return }
  if (p === '/shutdown' && M === 'POST') { send(res, 202, { ok: true }); setTimeout(() => bye(), 200); return }
  throw new HErr(404, 'Nicht gefunden.');
}
const srv = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (p === '/' && req.method === 'GET') {
      if (isLocal(req)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(pageHtml()) }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Toolbox Handy-Panel ' + VERSION + ' läuft. Verbinde dich mit der Toolbox-App (Server → Neue Verbindung → Handy-Panel).');
    }
    if (p === '/download/file') { const t = useTok(u.searchParams.get('token'), 'dl'); if (!t) throw new HErr(403, 'Link abgelaufen.'); const st = await fsp.stat(t.file); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + path.basename(t.file).replace(/"/g, '') + '"' }); return fs.createReadStream(t.file).pipe(res) }
    if (p === '/upload/file' && req.method === 'POST') { const t = useTok(u.searchParams.get('token'), 'up'), s = t && C.servers.find(x => x.uuid === t.uuid); if (!s) throw new HErr(403, 'Link abgelaufen.'); return upload(req, res, s, u.searchParams.get('directory') || '/') }
    if (!p.startsWith('/api/')) throw new HErr(404, 'Nicht gefunden.');
    // Anfragen direkt von diesem Gerät zählen nicht (wer hier ist, kann den Schlüssel ohnehin lesen).
    // Über den Fernzugriff kommt alles von cloudflared (127.0.0.1) – dann zählt die echte Adresse aus cf-connecting-ip.
    const ra = String(req.socket.remoteAddress || '?'), lo = /^(::1|127\.|::ffff:127\.)/.test(ra), cf = lo && req.headers['cf-connecting-ip'];
    const ip = cf ? String(cf) : ra, lim = !lo || !!cf, f = lim && FAIL.get(ip);
    if (f && f.n >= 10 && Date.now() - f.t < 600000) throw new HErr(429, 'Zu viele falsche Schlüssel – bitte 10 Minuten warten.');
    const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!eqKey(k)) { if (lim) { FAIL.set(ip, { n: (f && Date.now() - f.t < 600000 ? f.n : 0) + 1, t: Date.now() }); if (FAIL.size > 5000) FAIL.delete(FAIL.keys().next().value) } throw new HErr(401, 'Falscher Schlüssel. Den richtigen zeigt „hp verbinden“ bzw. „hp schluessel“.') }
    if (f) FAIL.delete(ip);
    if (p.startsWith('/api/client')) return await client(req, res, p.slice(11), u.searchParams);
    if (p.startsWith('/api/application')) return await application(req, res, p.slice(16), u.searchParams);
    if (p.startsWith('/api/handy')) return await handyApi(req, res, p.slice(10));
    throw new HErr(404, 'Nicht gefunden.');
  } catch (e) {
    if (res.headersSent) { try { res.end() } catch (x) { } return }
    if (e instanceof HErr) return err(res, e.st, e.message, e.st === 422 ? 'ValidationException' : 'HttpException', e.f);
    console.error(e); err(res, 500, 'Interner Fehler: ' + e.message);
  }
});
srv.on('upgrade', (req, sock) => wsAccept(req, sock));

/* ---------- Befehl „hp“ und Autostart einrichten ---------- */
const DEFBASE = path.join(os.homedir(), 'handy-panel');
const passOpts = () => [].concat(BASE !== DEFBASE ? ['--dir', BASE] : [], PORT !== 8090 ? ['--port', String(PORT)] : [], HOST === '0.0.0.0' ? ['--lan'] : []);
const shq = a => "'" + String(a).replace(/'/g, "'\\''") + "'";
function installHp() {
  const me = path.resolve(__filename), extra = passOpts();
  let f, body;
  if (WIN) { const d = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps'); if (!fs.existsSync(d)) return false; f = path.join(d, 'hp.cmd'); body = '@echo off\r\nrem Toolbox Handy-Panel\r\n"' + process.execPath + '" "' + me + '" ' + extra.map(x => '"' + x + '"').join(' ') + ' %*\r\n' }
  else if (TERMUX) { f = path.join(process.env.PREFIX, 'bin', 'hp'); body = '#!' + path.join(process.env.PREFIX, 'bin', 'sh') + '\n# Toolbox Handy-Panel\nexec node ' + [me, ...extra].map(shq).join(' ') + ' "$@"\n' }
  else { const d = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'].find(x => { try { fs.mkdirSync(x, { recursive: true }); fs.accessSync(x, fs.constants.W_OK); return true } catch (e) { return false } }); if (!d) return false; f = path.join(d, 'hp'); body = '#!/bin/sh\n# Toolbox Handy-Panel\nexec ' + [process.execPath, me, ...extra].map(shq).join(' ') + ' "$@"\n' }
  try { if (!(fs.existsSync(f) && fs.readFileSync(f, 'utf8') === body)) { fs.writeFileSync(f, body); if (!WIN) fs.chmodSync(f, 0o755) } return f } catch (e) { return false }
}
const xs = (c, a, o) => { try { return require('child_process').execFileSync(c, a, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 }, o || {})).toString() } catch (e) { return null } };
function autostart(on) {
  const me = path.resolve(__filename), args = [me, ...passOpts()], log = path.join(BASE, 'panel.log');
  if (TERMUX) {
    const f = path.join(os.homedir(), '.termux', 'boot', 'toolbox-panel');
    if (!on) { try { fs.unlinkSync(f) } catch (e) { } return { how: 'Termux:Boot' } }
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '#!' + path.join(process.env.PREFIX, 'bin', 'sh') + '\n# Toolbox Handy-Panel beim Hochfahren starten\ntermux-wake-lock\nexec node ' + args.map(shq).join(' ') + ' >> ' + shq(log) + ' 2>&1\n'); fs.chmodSync(f, 0o700);
    return { how: 'Termux:Boot', hint: 'Dafür einmal die App „Termux:Boot“ aus F-Droid installieren und öffnen.' };
  }
  if (WIN) {
    const f = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'toolbox-panel.vbs');
    if (!on) { try { fs.unlinkSync(f) } catch (e) { } return { how: 'Windows-Autostart' } }
    fs.writeFileSync(f, "' Toolbox Handy-Panel unsichtbar beim Anmelden starten\r\nCreateObject(\"WScript.Shell\").Run \"" + [process.execPath, ...args].map(a => '""' + a + '""').join(' ') + "\", 0, False\r\n");
    return { how: 'Windows-Autostart (beim Anmelden)' };
  }
  if (MAC) {
    const f = path.join(os.homedir(), 'Library', 'LaunchAgents', 'de.toolbox.handy-panel.plist');
    if (!on) { xs('launchctl', ['unload', '-w', f]); try { fs.unlinkSync(f) } catch (e) { } return { how: 'launchd' } }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>de.toolbox.handy-panel</string><key>ProgramArguments</key><array>${[process.execPath, ...args].map(a => '<string>' + htmlEsc(a) + '</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>HP_SUPERVISED</key><string>1</string><key>PATH</key><string>${htmlEsc(process.env.PATH || '')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${htmlEsc(log)}</string><key>StandardErrorPath</key><string>${htmlEsc(log)}</string></dict></plist>\n`);
    xs('launchctl', ['load', '-w', f]); return { how: 'launchd (beim Anmelden)', svc: f };
  }
  // Linux: systemd (Benutzer-Dienst), sonst crontab
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'toolbox-panel.service');
  if (!on) { xs('systemctl', ['--user', 'disable', '--now', 'toolbox-panel']); try { fs.unlinkSync(unit) } catch (e) { } const ct = xs('crontab', ['-l']); if (ct && /toolbox-panel/.test(ct)) xs('crontab', ['-'], { input: ct.split('\n').filter(l => !/toolbox-panel/.test(l)).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] }); return { how: 'Linux' } }
  if (xs('systemctl', ['--user', 'show-environment']) !== null) {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=Toolbox Handy-Panel\nAfter=network-online.target\n\n[Service]\nExecStart=${[process.execPath, ...args].map(a => /\s/.test(a) ? '"' + a + '"' : a).join(' ')}\nEnvironment=HP_SUPERVISED=1\nEnvironment="PATH=${process.env.PATH || ''}"\nRestart=always\nRestartSec=3\n# Server laufen weiter, wenn das Panel neu startet\nKillMode=process\n\n[Install]\nWantedBy=default.target\n`);
    xs('systemctl', ['--user', 'daemon-reload']); xs('systemctl', ['--user', 'enable', 'toolbox-panel']);
    return { how: 'systemd', svc: 'toolbox-panel', hint: 'Damit es auch ohne Anmeldung startet: sudo loginctl enable-linger ' + (os.userInfo().username || '$USER') };
  }
  const ct = xs('crontab', ['-l']) || '';
  if (xs('crontab', ['-'], { input: ct.split('\n').filter(l => l && !/toolbox-panel/.test(l)).concat(['@reboot ' + [process.execPath, ...args].map(shq).join(' ') + ' >> ' + shq(log) + ' 2>&1 # toolbox-panel']).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] }) !== null) return { how: 'crontab (@reboot)' };
  return { how: null, hint: 'Kein Autostart möglich (weder systemd noch crontab gefunden).' };
}

/* ---------- Panel starten ---------- */
function bye() {
  STOPPING = true; tunnelStop();
  const n = C.servers.filter(running).length;
  console.log('\nHandy-Panel beendet.' + (n ? ' ' + n + ' Server läuft/laufen weiter.\nWieder aufnehmen: hp konsole <server>  ·  Panel starten: hp  ·  Alle stoppen: hp stopp-alle' : ''));
  try { fs.unlinkSync(path.join(BASE, 'panel.pid')) } catch (e) { }
  save(true); setTimeout(() => process.exit(0), 100);
}
function panel() {
  let tries = 0;
  srv.on('error', e => {
    if (e.code === 'EADDRINUSE' && opt('neustart') && tries++ < 40) { setTimeout(() => srv.listen(PORT, HOST), 500); return }
    console.error(e.code === 'EADDRINUSE' ? '\nDer Port ' + PORT + ' ist schon belegt – läuft das Handy-Panel schon? Dann reicht: hp status · hp verbinden\nSonst anderen Port wählen: hp --port 8091\n' : e.message); process.exit(1);
  });
  srv.listen(PORT, HOST, () => {
    try { fs.writeFileSync(path.join(BASE, 'panel.pid'), String(process.pid)) } catch (e) { }
    const line = '─'.repeat(58), hp = installHp(), pi = pairInfo();
    console.log('\n' + line + '\n  Toolbox Handy-Panel ' + VERSION + ' läuft (' + PLAT + ')\n' + line);
    console.log('  Auf diesem Gerät:  http://127.0.0.1:' + PORT + '   ← im Browser öffnen: QR-Code zum Koppeln');
    lanUrls().forEach(u => console.log('  Im WLAN:           ' + u));
    console.log('  Schlüssel:         ' + C.key);
    if (pi.link) console.log('  Koppel-Link:       ' + pi.link);
    console.log('  Daten:             ' + BASE + '\n' + line);
    console.log('  Fernzugriff (https, von überall): ' + (C.tunnel ? 'wird eingeschaltet …' : 'aus – einschalten: hp fernzugriff an'));
    console.log('  Strg+C beendet nur das Panel – deine Server laufen weiter.');
    console.log('  Befehle: ' + (hp ? 'hp verbinden · hp status · hp konsole <server> · hp hilfe' : 'node ' + path.basename(__filename) + ' hilfe'));
    if (TERMUX) { console.log('  Termux: Wake-Lock ist an, damit Android das Panel im Standby nicht beendet.'); try { execFile('termux-wake-lock', { windowsHide: true }, () => { }) } catch (e) { } }
    console.log(line + '\n');
    if (HOST === '0.0.0.0') console.log('  Hinweis: --lan ist an. Jeder im WLAN mit dem Schlüssel kann zugreifen.\n');
    for (const s of C.servers) {
      if (s.status === 'installing') { s.status = 'install_failed'; save(); continue }
      if (s.pid && alive(s.pid) && owned(s, s.pid)) {
        let off = 0; try { off = Math.max(0, fs.statSync(ctl(s).log).size - 65536) } catch (e) { }
        follow(s, off, false); out(s, 'Handy-Panel hat den laufenden Server wieder übernommen.', 'daemon');
        console.log('  ↺ Übernommen: ' + s.name + ' (läuft weiter)');
      } else { if (s.pid) { s.pid = null; save() } if (s.wasRunning && !s.suspended && !s.status) { console.log('  ▶ Starte wieder: ' + s.name); start(s) } }
    }
    if (C.tunnel) tunnelStart();
  });
  process.on('SIGINT', bye); process.on('SIGTERM', bye); try { process.on('SIGHUP', bye) } catch (e) { }
}

/* ---------- Befehle (hp …) ---------- */
async function panelUp() { try { const r = await fetch('http://127.0.0.1:' + PORT + '/', { signal: AbortSignal.timeout(1500) }); return r.ok } catch (e) { return false } }
async function viaPanel(method, p, j) { const r = await fetch('http://127.0.0.1:' + PORT + '/api/' + p, { method, headers: { Authorization: 'Bearer ' + C.key, 'Content-Type': 'application/json' }, body: j ? JSON.stringify(j) : undefined, signal: AbortSignal.timeout(60000) }); if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).errors[0].detail } catch (e) { } throw Error(m) } const t = await r.text(); return t ? JSON.parse(t) : null }
function pick(q) {
  if (!q) return null; const l = String(q).toLowerCase(), S = C.servers;
  return S.find(s => s.identifier === l) || S.find(s => s.name.toLowerCase() === l) || (/^\d+$/.test(l) && S[+l - 1]) || S.filter(s => s.name.toLowerCase().includes(l)).sort((a, b) => a.name.length - b.name.length)[0] || null;
}
const reload = () => { try { C = JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch (e) { } };
const HELP = `Toolbox Handy-Panel ${VERSION} – Befehle
  hp                       Panel starten (im Vordergrund, Strg+C beendet)
  hp hintergrund           Panel im Hintergrund starten
  hp beenden               Panel im Hintergrund beenden (Server laufen weiter)
  hp verbinden             Koppel-Link, Code und QR-Code für die App anzeigen
  hp fernzugriff an|aus    sichere https-Adresse für unterwegs (Cloudflare-Tunnel)
  hp autostart an|aus      Panel beim Hochfahren/Anmelden automatisch starten
  hp status                alle Server und ob sie laufen
  hp konsole <server>      Live-Konsole wieder aufnehmen, Befehle eintippen
                           (Strg+C trennt nur – der Server läuft weiter)
  hp start|stop|restart|kill <server>      ·      hp stopp-alle
  hp update                neue Version aus der Toolbox-App laden
  hp schluessel            Zugangsschlüssel anzeigen
<server> = Name (oder ein Teil davon), Server-ID oder Nummer aus „hp status“.`;
async function bg() {
  if (await panelUp()) return true;
  const direct = () => { const fd = fs.openSync(path.join(BASE, 'panel.log'), 'a'); spawn(process.execPath, [path.resolve(__filename), ...passOpts()], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }).unref() };
  const sd = autoInfo() === 'systemd' && xs('systemctl', ['--user', 'restart', 'toolbox-panel']) !== null; if (!sd) direct();
  for (let i = 0; i < 60; i++) { await sleep(250); if (await panelUp()) return true; if (sd && i === 24) direct() } return false;
}
const autoInfo = () => !WIN && !MAC && !TERMUX && fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'toolbox-panel.service')) ? 'systemd' : null;
async function showPair(wait) {
  let i = null; try { i = await viaPanel('GET', 'handy/info') } catch (e) { console.log('Das Panel läuft nicht. Starten: hp   (oder im Hintergrund: hp hintergrund)'); return null }
  if (wait && i.tunnel.on && !i.tunnel.url) { process.stdout.write('Fernzugriff wird eingerichtet (beim ersten Mal wird cloudflared geladen) '); for (let k = 0; k < 120 && i.tunnel.on && !i.tunnel.url; k++) { await sleep(1000); if (k % 3 === 2) process.stdout.write('.'); try { i = await viaPanel('GET', 'handy/info') } catch (e) { } } console.log(i.tunnel.url ? ' ✓' : ' – noch nicht bereit (' + (i.tunnel.err || i.tunnel.state) + ')') }
  const line = '─'.repeat(58);
  console.log('\n' + line + '\n  Mit der Toolbox-App verbinden\n' + line);
  if (i.link) console.log('  Link (öffnet die App und verbindet):\n  ' + i.link + '\n');
  console.log('  Verbindungs-Code (in der App einfügen):\n  ' + i.code + '\n');
  console.log('  Fernzugriff: ' + (i.tunnel.url ? i.tunnel.url : i.tunnel.on ? '… (' + i.tunnel.state + ')' : 'aus – nur dieses Gerät. Einschalten: hp fernzugriff an'));
  console.log('  Seite mit QR-Code (auf diesem Gerät im Browser): ' + i.local);
  const qr = xs('qrencode', ['-t', 'ANSIUTF8', '-m', '1', i.link || i.code]);
  if (qr) console.log('\n' + qr); else if (!WIN) console.log('  (QR-Code hier im Terminal: ' + (TERMUX ? 'pkg install libqrencode' : 'qrencode installieren') + ')');
  console.log(line);
  return i;
}
// Alte Panel-Prozesse (vor 1.2 ohne Beenden-Befehl) finden und beenden – nur Linux/Android
function killOld() { let n = 0; if (WIN) return n; try { for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d) || +d === process.pid) continue; let c = ''; try { c = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8') } catch (e) { continue } const a = c.split('\0');
  if (a.some(x => /handy-panel(\.js)?$/.test(x)) && !a.includes('--wrap') && !a.some(x => /^(einrichten|setup|konsole|status)$/.test(x))) { try { process.kill(+d, 'SIGTERM'); n++ } catch (e) { } } } } catch (e) { } return n }
function openUrl(u) { try { const c = WIN ? spawn('cmd.exe', ['/c', 'start', '""', u], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn(MAC ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' }); c.on('error', () => { }); c.unref() } catch (e) { } }
async function cli(cmd, a) {
  const say = t => console.log(t), arg = (a[0] || '').toLowerCase(); let up = await panelUp();
  if (cmd === 'hilfe' || cmd === 'help' || cmd === '-h') return say(HELP);
  if (cmd === 'schluessel' || cmd === 'schlüssel' || cmd === 'key') return say(C.key);
  if (cmd === 'verbinden' || cmd === 'koppeln' || cmd === 'pair') { await showPair(true); return }
  if (cmd === 'hintergrund' || cmd === 'bg') { if (up) say('Das Panel läuft schon.'); else { process.stdout.write('Starte das Panel im Hintergrund … '); say(await bg() ? '✓' : '✗ – siehe ' + path.join(BASE, 'panel.log')) } await showPair(true); return }
  if (cmd === 'beenden' || cmd === 'shutdown') {
    if (!up) return say('Das Panel läuft nicht.');
    // Läuft es als systemd-Dienst, erst den Dienst stoppen (sonst startet „Restart=always“ es gleich wieder)
    if (autoInfo() === 'systemd') { xs('systemctl', ['--user', 'stop', 'toolbox-panel']); for (let k = 0; k < 12 && await panelUp(); k++) await sleep(250); if (!(await panelUp())) return say('Panel (Dienst) beendet. Deine Server laufen weiter. Beim nächsten Hochfahren startet es wieder.') }
    let why = ''; try { await viaPanel('POST', 'handy/shutdown') } catch (e) { why = e.message }
    for (let k = 0; k < 20 && await panelUp(); k++) await sleep(250);
    if (await panelUp()) { let pid = 0; try { pid = +fs.readFileSync(path.join(BASE, 'panel.pid'), 'utf8') } catch (e) { } if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGTERM') } catch (e) { } for (let k = 0; k < 20 && await panelUp(); k++) await sleep(250) } }
    if (await panelUp()) return say('✗ Das Panel läuft noch' + (why ? ' (' + why + ')' : '') + '. Notfalls das Fenster/Termux-Sitzung schließen, in dem es läuft.');
    return say('Panel beendet. Deine Server laufen weiter.');
  }
  if (cmd === 'fernzugriff' || cmd === 'tunnel') {
    if (arg !== 'an' && arg !== 'aus') { say('Fernzugriff: ' + (C.tunnel ? 'an' : 'aus') + '\nBenutzung: hp fernzugriff an  ·  hp fernzugriff aus'); if (up && C.tunnel) await showPair(false); return }
    if (up) { await viaPanel('POST', 'handy/tunnel', { on: arg === 'an' }); say(arg === 'an' ? 'Fernzugriff wird eingeschaltet.' : 'Fernzugriff ausgeschaltet.'); if (arg === 'an') await showPair(true); return }
    C.tunnel = arg === 'an'; save(true); return say('Gespeichert – gilt beim nächsten Start des Panels (hp oder hp hintergrund).');
  }
  if (cmd === 'autostart') {
    if (arg !== 'an' && arg !== 'aus') return say('Benutzung: hp autostart an  ·  hp autostart aus');
    const r = autostart(arg === 'an'); say(r.how ? (arg === 'an' ? '✓ Autostart eingerichtet: ' : '✓ Autostart entfernt: ') + r.how : '✗ ' + (r.hint || 'Nicht möglich.')); if (arg === 'an' && r.hint && r.how) say('  ' + r.hint); return;
  }
  if (cmd === 'update') {
    const from = a[0] && /^https:\/\//.test(a[0]) ? a[0] : C.app; if (!from) return say('Woher? Beispiel: hp update https://dein-name.github.io/Toolbox/');
    if (up) { const r = await viaPanel('POST', 'handy/update', { from }); return say(r.updated ? '✓ Aktualisiert auf ' + r.version + ' – das Panel startet neu.' : 'Schon aktuell (' + r.version + ').') }
    const r = await selfUpdate(from); return say(r.updated ? '✓ Aktualisiert auf ' + r.version + '.' : 'Schon aktuell (' + r.version + ').');
  }
  if (cmd === 'einrichten' || cmd === 'setup') {
    // Läuft noch eine ältere Version (z. B. 1.1 in einer anderen Termux-Sitzung)? Dann beenden – die Server laufen weiter.
    if (up) { let i = null; try { i = await viaPanel('GET', 'handy/info') } catch (e) { }
      if (!i || vcmp(i.version, VERSION) < 0) {
        say('Ein älteres Panel läuft noch – es wird beendet (deine Server laufen weiter) …');
        if (i) { try { await viaPanel('POST', 'handy/shutdown') } catch (e) { } } else killOld();
        for (let k = 0; k < 24 && await panelUp(); k++) await sleep(250);
        up = await panelUp();
        if (up) return say('✗ Der Port ' + PORT + ' ist noch belegt. Beende das alte Panel (Strg+C in seinem Fenster bzw. seiner Termux-Sitzung) und führe den Befehl erneut aus.');
      } }
    save(true); const hp = installHp();
    say(hp ? '✓ Befehl „hp“ eingerichtet' + (!WIN && !TERMUX && !(process.env.PATH || '').split(':').includes(path.dirname(hp)) ? ' (' + hp + ' – Ordner ist nicht im PATH; neu anmelden oder direkt aufrufen)' : '') : '• Befehl „hp“ konnte nicht eingerichtet werden – nutze: node ' + path.resolve(__filename));
    if (!opt('ohne-autostart')) { const r = autostart(true); say(r.how ? '✓ Autostart: ' + r.how + (r.hint ? '\n  ' + r.hint : '') : '• ' + (r.hint || 'Kein Autostart möglich.')) }
    if (up && C.tunnel) { try { await viaPanel('POST', 'handy/tunnel', { on: true }) } catch (e) { } }
    if (!up) { process.stdout.write('Starte das Panel im Hintergrund … '); say(await bg() ? '✓' : '✗ – siehe ' + path.join(BASE, 'panel.log')) }
    const i = await showPair(true);
    if (i && i.link && TERMUX && !opt('ohne-app')) { say('Öffne die Toolbox-App …'); xs('termux-open-url', [i.link]) }
    else if (i && !TERMUX && !opt('ohne-app') && (WIN || MAC || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) { say('Öffne die Koppel-Seite im Browser …'); openUrl(i.local) }
    return;
  }
  if (cmd === 'status' || cmd === 'liste' || cmd === 'list') {
    let inf = null; if (up) { try { inf = await viaPanel('GET', 'handy/info') } catch (e) { } }
    say('Handy-Panel ' + VERSION + ' (' + PLAT + '): ' + (up ? 'läuft' + (inf && inf.tunnel.url ? ' · Fernzugriff: ' + inf.tunnel.url : inf && inf.tunnel.on ? ' · Fernzugriff: ' + inf.tunnel.state : '') : 'aus – starten mit: hp'));
    if (!C.servers.length) return say('Noch keine Server. Lege sie in der Toolbox-App an.');
    C.servers.forEach((s, i) => { const on = s.pid && alive(s.pid), a2 = allocOf(s); say(`  ${i + 1}. ${on ? '● läuft ' : '○ aus   '} ${s.name}  [${s.identifier}]${a2 ? '  Port ' + a2.port : ''}${s.suspended ? '  (gesperrt)' : s.status ? '  (' + s.status + ')' : ''}`) });
    return say('\nKonsole wieder aufnehmen: hp konsole <Name oder Nummer>');
  }
  if (cmd === 'stopp-alle' || cmd === 'stop-all') {
    const l = C.servers.filter(s => s.pid && alive(s.pid)); if (!l.length) return say('Es läuft kein Server.');
    for (const s of l) await cli('stop', [s.identifier]); return;
  }
  const s = pick(a.join(' '));
  if (['konsole', 'console', 'attach', 'start', 'stop', 'restart', 'kill'].includes(cmd) && !s) { say(a.length ? 'Server „' + a.join(' ') + '“ nicht gefunden.' : 'Welcher Server? Beispiel: hp ' + cmd + ' survival'); if (C.servers.length) await cli('status', []); process.exitCode = 1; return }
  if (cmd === 'konsole' || cmd === 'console' || cmd === 'attach') return attachCli(s);
  if (['start', 'stop', 'restart', 'kill'].includes(cmd)) {
    if (up) { await viaPanel('POST', 'client/servers/' + s.identifier + '/power', { signal: cmd }); say({ start: '▶ Start', stop: '■ Stopp', restart: '↻ Neustart', kill: '✕ Kill' }[cmd] + ' für „' + s.name + '“ ausgeführt.' + (cmd !== 'stop' && cmd !== 'kill' ? '  Konsole: hp konsole ' + s.identifier : '')); return }
    // Panel läuft nicht: direkt erledigen
    const on = s.pid && alive(s.pid);
    if (cmd === 'start' || (cmd === 'restart' && !on)) { if (on) return say('„' + s.name + '“ läuft schon. Konsole: hp konsole ' + s.identifier); RT.delete(s.uuid); await start(s, { detach: true, now: true }); return say(s.pid ? '▶ „' + s.name + '“ gestartet. Konsole: hp konsole ' + s.identifier : 'Start nicht möglich – Details: hp konsole ' + s.identifier) }
    if (!on) { if (s.pid) { s.pid = null; save(true) } return say('„' + s.name + '“ läuft nicht.') }
    const e = EGGS[s.egg], pid = s.pid; rt(s).pid = pid;
    if (cmd === 'kill') await sig(s, 'SIGKILL');
    else if (!(e && e.stop && e.stop !== '^C' && await command(s, e.stop))) await sig(s, 'SIGINT');
    process.stdout.write('Warte, bis „' + s.name + '“ beendet ist ');
    for (let i = 0; i < 60 && alive(pid); i++) { await sleep(500); if (i % 4 === 3) process.stdout.write('.') }
    if (alive(pid)) { await sig(s, 'SIGKILL'); await sleep(800) }
    say(alive(pid) ? ' – lässt sich nicht beenden.' : ' – beendet.');
    reload(); const s2 = C.servers.find(x => x.uuid === s.uuid); if (s2) { s2.pid = null; s2.wasRunning = false; save(true) }
    if (cmd === 'restart' && s2) { RT.delete(s2.uuid); await start(s2, { detach: true, now: true }); say('▶ Wieder gestartet. Konsole: hp konsole ' + s2.identifier) }
    return;
  }
  say('Unbekannter Befehl „' + cmd + '“.\n\n' + HELP); process.exitCode = 1;
}
// Live-Konsole im Terminal: Log mitlesen, Eingaben an den Server schicken
async function attachCli(s) {
  const F = ctl(s), on = () => s.pid && alive(s.pid);
  if (!on()) { console.log('„' + s.name + '“ läuft gerade nicht. Starten: hp start ' + s.identifier); try { const t = fs.readFileSync(F.log, 'utf8').split('\n').slice(-15).join('\n'); if (t.trim()) console.log('\n--- letzte Ausgaben ---\n' + t) } catch (e) { } return }
  let off = 0; try { const st = fs.statSync(F.log); off = Math.max(0, st.size - 8192); const b = Buffer.alloc(st.size - off), fd = fs.openSync(F.log, 'r'); fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd); const t = b.toString('utf8'); process.stdout.write((off ? t.slice(t.indexOf('\n') + 1) : t).split('\n').slice(-40).join('\n')); off = st.size } catch (e) { }
  console.log('\n─── Konsole von „' + s.name + '“ – Befehl eintippen + Enter · Strg+C trennt (Server läuft weiter) ───');
  const dec = new StringDecoder('utf8');
  const iv = setInterval(() => {
    try { const st = fs.statSync(F.log); if (st.size < off) off = 0; if (st.size > off) { const b = Buffer.alloc(st.size - off), fd = fs.openSync(F.log, 'r'); fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd); off = st.size; process.stdout.write(dec.write(b)) } } catch (e) { }
    if (!on()) { let c = ''; try { c = fs.readFileSync(F.ex, 'utf8').trim() } catch (e) { } console.log('\n─── Der Server wurde beendet' + (c ? ' (Code ' + c + ')' : '') + '. ───'); end(0) }
  }, 300);
  const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
  rl.on('line', l => { if (!l.trim()) return; rt(s).pid = s.pid; command(s, l).then(ok => { if (!ok) console.log('(Konnte den Befehl nicht senden – läuft der Server noch?)') }) });
  const end = code => { clearInterval(iv); rl.close(); process.exit(code || 0) };
  process.on('SIGINT', () => { console.log('\n─── Getrennt. „' + s.name + '“ läuft weiter. Wieder verbinden: hp konsole ' + s.identifier + ' ───'); end(0) });
}
if (WRAP) wrapper(String(WRAP));
else if (CMD) cli(CMD, POS.slice(1)).catch(e => { console.error('Fehler: ' + e.message); process.exit(1) });
else panel();
