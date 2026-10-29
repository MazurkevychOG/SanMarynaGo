// Service worker: офлайн-режим для SanMarynaGO.
// Стратегія: сторінка й дані — «спершу мережа» (завжди свіже з GitHub), а коли інтернету немає — остання збережена копія.
// Фото, бібліотека карти й плитки карти — «спершу кеш», щоб було швидко й працювало без мережі.
const SHELL = 'sanmaryna-shell-v1', RUNTIME = 'sanmaryna-data-v1', TILES = 'sanmaryna-tiles-v1';
const LEAFLET = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js'
];
const MEDIA_RE = /\.(webp|jpe?g|png|gif|mp4|webm|mov)$/i;
const MAX_TILES = 600;

self.addEventListener('install', e => {
    e.waitUntil((async () => {
        const c = await caches.open(SHELL);
        const own = ['./', 'index.html', 'apple-touch-icon.png'].map(u => fetch(u, { cache: 'reload' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => { }));
        const libs = LEAFLET.map(u => fetch(u, { mode: 'cors', credentials: 'omit' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => { }));
        await Promise.all([...own, ...libs]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        const keep = [SHELL, RUNTIME, TILES];
        for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.searchParams.has('_')) return;                         // службові перевірки версії йдуть напряму в мережу
    if (req.mode === 'navigate') { e.respondWith(navigate(req, url)); return; }
    if (url.origin === location.origin) {
        e.respondWith(MEDIA_RE.test(url.pathname) ? cacheFirst(req, RUNTIME) : networkFirst(req, RUNTIME));
        return;
    }
    if (url.hostname === 'unpkg.com') { e.respondWith(cacheFirst(new Request(req.url, { mode: 'cors', credentials: 'omit' }), SHELL)); return; }
    if (/(^|\.)arcgisonline\.com$|(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) { e.respondWith(tile(req)); return; }
});

async function navigate(req, url) {
    const cache = await caches.open(SHELL), key = url.origin + url.pathname;
    try {
        const r = await fetch(req.url.split('#')[0], { cache: 'no-store', redirect: 'manual' });
        if (r.type === 'opaqueredirect') return r;
        if (r.ok) { cache.put(key, r.clone()); return r; }
        return (await cache.match(key)) || r;
    } catch (err) {
        return (await cache.match(key)) || (await cache.match(self.registration.scope)) ||
            (await cache.match(self.registration.scope + 'index.html')) || Response.error();
    }
}

async function networkFirst(req, name) {
    const cache = await caches.open(name);
    try {
        const r = await fetch(req);
        if (r && r.status === 200) cache.put(req, r.clone());
        return r;
    } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        return hit || Response.error();
    }
}

async function cacheFirst(req, name) {
    const cache = await caches.open(name);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
        const r = await fetch(req);
        if (r && (r.status === 200 || r.type === 'opaque')) cache.put(req, r.clone());
        return r;
    } catch (err) { return Response.error(); }
}

async function tile(req) {
    const cache = await caches.open(TILES);
    const hit = await cache.match(req.url);
    if (hit) return hit;
    try {
        const r = await fetch(req.url, { mode: 'cors', credentials: 'omit' });   // не «opaque», щоб не роздувати квоту
        if (r.ok) { cache.put(req.url, r.clone()); if (Math.random() < 0.05) trim(cache); }
        return r;
    } catch (err) {
        try { return await fetch(req); } catch (e2) { return Response.error(); }
    }
}

async function trim(cache) {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}
