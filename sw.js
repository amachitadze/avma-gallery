// AvmaDrive service worker. Pages: network first. Assets: cache first, refreshed in the background.
const VER = '12';
const CACHE = 'avmadrive-' + VER;
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'assets/css/inter.css?v=12', 'assets/css/fontawesome.css?v=12', 'assets/css/tailwind.css?v=12', 'assets/js/i18n.js?v=12', 'assets/lang/es.js?v=12', 'assets/js/app.js?v=12', 'assets/js/extras.js?v=12', 'assets/js/features.js?v=12', 'assets/js/editor.js?v=12', 'assets/vendor/leaflet/leaflet.css?v=12', 'assets/vendor/leaflet/leaflet.js?v=12', 'assets/vendor/leaflet/images/layers.png', 'assets/vendor/leaflet/images/layers-2x.png', 'assets/vendor/leaflet/images/marker-icon.png', 'assets/vendor/leaflet/images/marker-icon-2x.png', 'assets/vendor/leaflet/images/marker-shadow.png', 'assets/fonts/fa-solid-900.woff2', 'assets/fonts/inter-latin-ext.woff2', 'assets/fonts/inter-latin.woff2', 'assets/guide/data.webp', 'assets/guide/folder.webp', 'assets/guide/gallery.webp', 'assets/guide/home.webp', 'assets/guide/install.webp', 'assets/guide/search.webp', 'assets/guide/select.webp', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png'];
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
      .catch(() => caches.match(r, { ignoreSearch: true })
        .then((m) => m || caches.match('index.html', { ignoreSearch: true }))
        .then((m) => m || caches.match('./', { ignoreSearch: true }))
        .then((m) => m || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
    return;
  }
  e.respondWith(caches.match(r).then((hit) => {
    const net = fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
