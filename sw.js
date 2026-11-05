const V='toolbox-v1.8.0';
/* Zwischengespeichert werden nur die App selbst und ihre Bibliotheken/Schriften (CDN).
   Anfragen an dein Panel, den Vermittler und die Server-Knoten gehen IMMER direkt ins Netz,
   sonst gäbe es veraltete Serverlisten, Dateien und Konsolen-Zugangsdaten.
   Die Dateien des Handy-Panels (handy-panel.js, install.sh, install.ps1) werden nie zwischengespeichert.
   KI-Modelle speichern ihre Bibliotheken selbst (eigene Caches, z. B. "webllm/…" und
   "transformers-cache"). Diese werden beim Update NICHT gelöscht – nur alte Toolbox-Caches. */
const CDN=/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>/^toolbox-/.test(x)&&x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||!/^https?:/.test(r.url))return;
  const u=new URL(r.url);if(u.origin!==self.location.origin&&!CDN.test(u.hostname))return;
  if(/\/(handy-panel\.js|install\.(sh|ps1))$/.test(u.pathname))return; // Panel-Dateien immer frisch (Update-Prüfung)
  const put=n=>{if(n&&(n.ok||n.type==='opaque')){const c=n.clone();caches.open(V).then(x=>x.put(r,c))}return n};
  e.respondWith(r.mode==='navigate'?fetch(r).then(put).catch(()=>caches.match('index.html')):caches.match(r).then(h=>h||fetch(r).then(put)))});
