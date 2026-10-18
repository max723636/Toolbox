const V='toolbox-v1.3.1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||!/^https?:/.test(r.url))return;
  const put=n=>{if(n&&(n.ok||n.type==='opaque')){const c=n.clone();caches.open(V).then(x=>x.put(r,c))}return n};
  e.respondWith(r.mode==='navigate'?fetch(r).then(put).catch(()=>caches.match('index.html')):caches.match(r).then(h=>h||fetch(r).then(put)))});
