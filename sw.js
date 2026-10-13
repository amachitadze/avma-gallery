// AvmaDrive service worker. Pages: network first. Assets: cache first, refreshed in the background.
const VER = '2';
const CACHE = 'avmadrive-' + VER;
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'assets/css/inter.css?v=2', 'assets/css/fontawesome.css?v=2', 'assets/css/tailwind.css?v=2', 'assets/js/app.js?v=2', 'assets/fonts/fa-solid-900.woff2', 'assets/fonts/inter-latin-ext.woff2', 'assets/fonts/inter-latin.woff2', 'assets/guide/data.webp', 'assets/guide/folder.webp', 'assets/guide/gallery.webp', 'assets/guide/home.webp', 'assets/guide/install.webp', 'assets/guide/search.webp', 'assets/guide/select.webp', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('avmadrive-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('index.html') || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(r).then((hit) => {
    const net = fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
