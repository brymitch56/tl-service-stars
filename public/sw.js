'use strict';
/**
 * Service worker: make the installed app predictable to update, and keep the
 * shell available offline. Bump VERSION whenever a cached file changes.
 *
 * WHY THIS IS SHAPED THE WAY IT IS. An installed PWA that serves its shell
 * cache-first can get stuck on an old version with no obvious way out — the
 * troop's check-in app did exactly that on a Chromebook, where the app is
 * resumed from the launcher rather than reloaded, so nothing ever triggered
 * an update check and only Ctrl+Shift+R broke the spell. Three rules follow
 * from that, and none of them should be relaxed for speed:
 *
 *   1. NAVIGATIONS ARE NETWORK-FIRST. index.html is what names the versioned
 *      assets, so as long as it is fresh, everything else follows. The cached
 *      copy is an offline fallback, never the normal path.
 *   2. skipWaiting + clients.claim, so a new worker takes over at once
 *      instead of waiting for every window to close — which, for an
 *      installed app, may be never.
 *   3. The page asks for an update check on load AND whenever the app is
 *      brought back to the foreground (see app.js). Resuming an installed
 *      PWA is the moment a Chromebook user expects to get the new version.
 *
 * /api is never cached. It is per-leader, authenticated, and a stale answer
 * here is worse than an error: it would show one leader's view to another
 * after a sign-out, and stale star counts are exactly what this app exists
 * to get right.
 */
const VERSION = 'tls-v3'; // v3: only people at a star level; show the portal level

/** The minimum needed to render the app offline. Versioned assets are added at runtime. */
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the browser's HTTP cache, so a brand-new VERSION
  // cache can never be filled with stale bytes by a proxy that stretched an
  // asset's TTL. A failure aborts the install: a partial shell must never
  // replace a complete one.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(`precache ${u}: ${r.status}`);
        return c.put(u, r);
      }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Let the page ask what it is running, and ask a waiting worker to take over. */
self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'version' && e.source) e.source.postMessage({ type: 'version', version: VERSION });
  if (e.data.type === 'skip-waiting') self.skipWaiting();
});

const putInCache = (req, res) => {
  const copy = res.clone();
  caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Authenticated, per-leader, and changing constantly: never cached.
  if (url.pathname.startsWith('/api') || url.pathname === '/health') return;

  // The shell: always try the network, fall back to the cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => (res && res.ok ? putInCache('/index.html', res) : res))
        .catch(() => caches.match('/index.html').then((hit) => hit
          || new Response('<h1>Offline</h1><p>Service Stars needs a connection the first time.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html' } }))),
    );
    return;
  }

  // Assets carrying ?v= are immutable for that version: serve from cache and
  // only reach the network the first time each new version is asked for.
  if (url.search.includes('v=')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => (res && res.ok ? putInCache(req, res) : res))),
    );
    return;
  }

  // Everything else (icons, the manifest): fresh when possible, cache when not.
  e.respondWith(
    fetch(req)
      .then((res) => (res && res.ok ? putInCache(req, res) : res))
      .catch(() => caches.match(req)),
  );
});
