// NAM! Service Worker v2.3.8
// iOS PWA optimized + Leaflet-safe + offline-capable + activate-time LRU eviction

const APP_CACHE   = 'nam-app-v2.3.8';
const APP_VERSION = APP_CACHE.replace('nam-app-', ''); // 'v2.3.8'
const TILE_CACHE  = 'nam-tiles-v5';

// Versioned URLs match what index.html requests — precache is actually hit on first visit.
// Bump APP_CACHE to update both the cache name and these precache URLs in one place.
const APP_SHELL_LOCAL = [
    './index.html',
    `./nam.js?${APP_VERSION}`,
    `./nam.css?${APP_VERSION}`,
    `./nam-config.js?${APP_VERSION}`
];

const APP_SHELL_STATIC = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];



const TILE_HOSTS = [
    'tile.openstreetmap.org',
    'basemap.nationalmap.gov',
    'api.mapbox.com',
    'server.arcgisonline.com',
    'tile.opentopomap.org',
    'basemaps.cartocdn.com'
];

const MAX_TILE_ENTRIES = 500;

// Cache opened fresh per-request — pre-opening caused stale handles after cache clear




// ─────────────────────────────────────────────
//  INSTALL
// ─────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(APP_CACHE);

        // Cache local app shell files using known relative URLs.
        // self.clients.matchAll() is unreliable here — no clients exist during
        // a fresh install (first visit, SW update, iOS resume after kill).
        // Relative URLs resolve against the SW's own location, always correct.
        await Promise.allSettled(
            APP_SHELL_LOCAL.map(url =>
                fetch(url)
                    .then(res => { if (res.ok) cache.put(url, res.clone()); })
                    .catch(() => {})
            )
        );

        // Cache Leaflet CDN files — Promise.allSettled won't abort if one fails
        await Promise.allSettled(
            APP_SHELL_STATIC.map(url =>
                fetch(url)
                    .then(res => { if (res.ok) cache.put(url, res.clone()); })
                    .catch(() => {})
            )
        );

        await self.skipWaiting();
    })());
});


// ─────────────────────────────────────────────
//  ACTIVATE
// ─────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Delete old cache versions
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter(k => k !== APP_CACHE && k !== TILE_CACHE)
                .map(k => caches.delete(k))
        );

        // LRU eviction — trim tile cache once on SW update, not per-tile
        // Safe to do here: runs once, not during tile serving, no interference
        try {
            const tileCache = await caches.open(TILE_CACHE);
            const tileKeys = await tileCache.keys();
            if (tileKeys.length > MAX_TILE_ENTRIES) {
                const excess = tileKeys.length - MAX_TILE_ENTRIES;
                await Promise.all(tileKeys.slice(0, excess).map(k => tileCache.delete(k)));
                console.log('[SW] Tile cache trimmed: removed ' + excess + ' old tiles');
            }
        } catch (e) {
            console.warn('[SW] Tile eviction failed:', e);
        }

        await self.clients.claim();
    })());
});


// ─────────────────────────────────────────────
//  FETCH HANDLER
// ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // HTML pages: stale-while-revalidate.
    // NEVER resolves with null — a null respondWith() throws a SW TypeError
    // which renders a blank white page on iOS. Always return a fallback response.
    if (url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
        event.respondWith((async () => {
            const cache = await caches.open(APP_CACHE);
            const cached = await cache.match(event.request);
            const network = fetch(event.request)
                .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
                .catch(() => null);
            if (cached) { event.waitUntil(network); return cached; }
            const fresh = await network;
            if (fresh) return fresh;
            // No cache, no network — return a visible offline shell instead of crashing
            return new Response(
                '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NAM! Offline</title><style>body{margin:0;background:#06120a;color:#4ade80;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px;box-sizing:border-box}h1{font-size:2rem;margin-bottom:8px}p{opacity:.7;margin-bottom:24px}button{background:#4ade80;color:#000;border:none;padding:12px 28px;border-radius:12px;font-weight:900;font-size:14px;cursor:pointer}</style></head><body><h1>NAM!</h1><p>Starting offline — loading cached data…</p><button onclick="location.reload()">Retry</button><script>setTimeout(()=>location.reload(),2500)<\/script></body></html>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
        })());
        return;
    }

    // JS and CSS (app shell): stale-while-revalidate.
    // These files are NOT auto-cached by the browser HTTP cache on iOS after
    // memory pressure eviction. The SW must serve them from its own cache or
    // JS fails to load entirely — leaving the page with HTML but no event
    // listeners, which is exactly the "buttons do nothing" failure mode.
    if (url.pathname.match(/\.(js|css)(\?.*)?$/)) {
        event.respondWith((async () => {
            const cache = await caches.open(APP_CACHE);
            const cached = await cache.match(event.request);
            const network = fetch(event.request)
                .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
                .catch(() => null);
            if (cached) { event.waitUntil(network); return cached; }
            const fresh = await network;
            if (fresh) return fresh;
            // Offline fallback — empty but valid response so the page doesn't hard-error
            const isJs = url.pathname.endsWith('.js') || url.pathname.includes('.js?');
            return new Response(
                isJs ? '/* NAM offline */' : '/* NAM offline */',
                { status: 503, headers: { 'Content-Type': isJs ? 'application/javascript' : 'text/css' } }
            );
        })());
        return;
    }

    // Map tiles: network-first, cache fallback
    const isTile = TILE_HOSTS.some(h => url.hostname.includes(h));
    if (isTile) {
        event.respondWith(handleTile(event.request));
        return;
    }

    // Everything else (API calls, WMS, parcel) — passthrough, no caching
});


// ─────────────────────────────────────────────
//  TILE HANDLER
// ─────────────────────────────────────────────
async function handleTile(request) {
    const cache = await caches.open(TILE_CACHE);
    try {
        // Use cors mode for OSM/USGS/Carto — they require it from SW context
        // No mode override for Mapbox/Esri — WKWebView (iOS PWA) rejects forced
        // cors on these CDNs, returning opaque status=0 responses
        const url = request.url;
        const needsCors = url.includes('openstreetmap.org') ||
                          url.includes('nationalmap.gov') ||
                          url.includes('opentopomap.org') ||
                          url.includes('cartocdn.com');
        const fetchOpts = needsCors
            ? { mode: 'cors', credentials: 'omit' }
            : { credentials: 'omit' };

        const res = await fetch(request, fetchOpts);

        if (res && res.ok && res.type !== 'opaque') {
            // Good response — cache and return
            cache.put(request, res.clone()).catch(() => {});
            return res;
        }

        if (res && res.type === 'opaque') {
            // Opaque response (iOS PWA + Mapbox/Esri) — try cache first,
            // if not cached store and return the opaque response anyway
            // since it's likely valid image data even though we can't inspect it
            const cached = await cache.match(request);
            if (cached) return cached;
            cache.put(request, res.clone()).catch(() => {});
            return res;
        }

        return fallbackTile(cache, request);
    } catch(e) {
        return fallbackTile(cache, request);
    }
}


// ─────────────────────────────────────────────
//  TILE FALLBACK
// ─────────────────────────────────────────────
async function fallbackTile(cache, request) {
    try {
        const cached = await cache.match(request);
        if (cached) return cached;
    } catch {}
    return grayTileResponse();
}


// ─────────────────────────────────────────────
//  MESSAGE: MANUAL TILE PREFETCH
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
    if (event.data?.type === 'PRECACHE_TILES') {
        const urls = event.data.tiles || [];
        caches.open(TILE_CACHE).then(cache => {
            Promise.allSettled(
                urls.map(async tileUrl => {
                    try {
                        const existing = await cache.match(tileUrl);
                        if (existing) return;
                        const res = await fetch(tileUrl);
                        if (res.ok) cache.put(tileUrl, res);
                    } catch {}
                })
            ).then(results => {
                const count = results.filter(r => r.status === 'fulfilled').length;
                event.source?.postMessage({ type: 'PRECACHE_DONE', count, total: urls.length });
            });
        });
    }
});


// ─────────────────────────────────────────────
//  GRAY PLACEHOLDER TILE
// ─────────────────────────────────────────────
function grayTileResponse() {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes.buffer, { status: 200, headers: { 'Content-Type': 'image/png' } });
}
