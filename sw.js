/* SanMarynaGO — service worker
 *
 *  • index.html (the program) is served from the saved copy and is replaced ONLY when the page asks for it
 *    (the «Update Software» button sends {type:'refresh-app'}). Opening the site never changes the program.
 *  • data (data/…), photos and other files of the site: the network first (fresh), the saved copy when there is no internet.
 *  • map tiles and CDN files (Leaflet…): the saved copy first, refreshed in the background.
 *  • the check «is there a new version?» (index.html?_=…) always goes to the network, it is never cached.
 */
const APP_CACHE = 'smg-app-v1';        // index.html (the program)
const DATA_CACHE = 'smg-data-v1';      // data, photos, other files of the site
const TILE_CACHE = 'smg-tiles-v1';     // map tiles (images of other sites)
const CDN_CACHE = 'smg-cdn-v1';        // scripts / styles of other sites
const TILE_LIMIT = 3000;
const INDEX_URL = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const c = await caches.open(APP_CACHE);
        if (!(await c.match(INDEX_URL))) {                  // the very first install: remember the current program once
            try { await c.put(INDEX_URL, await fetch(new Request(INDEX_URL, { cache: 'reload' }))); } catch (e) { }
        }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = [APP_CACHE, DATA_CACHE, TILE_CACHE, CDN_CACHE];
        for (const k of await caches.keys()) if (k.startsWith('smg-') && !keep.includes(k)) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    const d = event.data || {}, port = event.ports && event.ports[0];
    if (d.type === 'ping') { if (port) port.postMessage({ pong: true, version: 1 }); return; }
    if (d.type === 'refresh-app') {                         // «Update Software»: download the new index.html and keep it
        event.waitUntil((async () => {
            let ok = false;
            try {
                const r = await fetch(new Request(INDEX_URL + '?_=' + Date.now(), { cache: 'reload' }));
                if (r.ok) { const c = await caches.open(APP_CACHE); await c.put(INDEX_URL, r); ok = true; }
            } catch (e) { }
            if (port) port.postMessage({ ok });
        })());
    }
});

async function trim(cacheName, limit) {
    const c = await caches.open(cacheName), keys = await c.keys();
    for (let i = 0; i < keys.length - limit; i++) await c.delete(keys[i]);
}

async function appShell(request) {
    const c = await caches.open(APP_CACHE);
    const hit = await c.match(INDEX_URL, { ignoreSearch: true });
    if (hit) return hit;
    try {                                                   // nothing saved yet (should not happen): take the network and save it
        const r = await fetch(new Request(INDEX_URL, { cache: 'reload' }));
        if (r.ok) c.put(INDEX_URL, r.clone());
        return r;
    } catch (e) { return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
}

async function networkFirst(request) {
    const c = await caches.open(DATA_CACHE);
    try {
        const r = await fetch(request, { cache: 'no-cache' });
        if (r && r.ok && r.status === 200) c.put(request, r.clone());
        return r;
    } catch (e) {
        const hit = await c.match(request, { ignoreSearch: false });
        if (hit) return hit;
        throw e;
    }
}

async function staleWhileRevalidate(request, cacheName, limit) {
    const c = await caches.open(cacheName);
    const hit = await c.match(request);
    const net = fetch(request).then(r => {
        if (r && (r.ok || r.type === 'opaque')) { c.put(request, r.clone()); if (limit) trim(cacheName, limit); }
        return r;
    }).catch(() => null);
    return hit || (await net) || new Response('', { status: 504 });
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    const url = new URL(req.url);
    if (url.origin === self.location.origin) {
        if (url.pathname.endsWith('/sw.js')) return;
        const isIndex = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
        if (isIndex) {
            if (url.searchParams.has('_')) return;          // «is there a new version?» → straight to the network
            event.respondWith(appShell(req));
            return;
        }
        event.respondWith(networkFirst(req));
        return;
    }
    if (req.destination === 'image') { event.respondWith(staleWhileRevalidate(req, TILE_CACHE, TILE_LIMIT)); return; }
    if (req.destination === 'script' || req.destination === 'style' || req.destination === 'font') { event.respondWith(staleWhileRevalidate(req, CDN_CACHE, 200)); return; }
});
