/* Kiln service worker — makes Kiln installable and usable offline.
   Bump VERSION whenever index.html changes so installed apps pick up the update. */
const VERSION = 'kiln-v2';
const SHELL = VERSION + '-shell';
const RUNTIME = VERSION + '-runtime';

// The app itself: everything needed to start Kiln without a connection.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

// Third-party files Kiln may load (PDF export library and web fonts), cached after first use.
const RUNTIME_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));
    // Fetch the PDF library ahead of time so PDF export also works offline.
    try {
      const rt = await caches.open(RUNTIME);
      await rt.add(new Request('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', { mode: 'cors' }));
    } catch (e) { /* not fatal: it is cached on first PDF export instead */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kiln-') && !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

// The page asks the waiting worker to take over when the user accepts an update.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Opening the app: network first (so updates arrive), cached copy when offline or slow.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const preload = await event.preloadResponse;
        const net = preload || await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
        ]);
        if (net && net.ok && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'))) {
          cache.put('./index.html', net.clone());
        }
        return net;
      } catch (e) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Own files (icons, manifest…): cache first, refresh in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  // PDF library and fonts: cache first, refresh in the background.
  // Everything else (AI, picture search, thesaurus, grammar check) always goes to the network.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: req.url.startsWith(self.location.origin) });
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}
