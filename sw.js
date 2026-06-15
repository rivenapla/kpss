/* ============================================================
   KPSS DİJİTAL ATLAS — Service Worker v1
   Strateji: Cache-first (statik), Network-first (Firebase)
   ============================================================ */

const CACHE_NAME = 'kpss-atlas-v1';

// Offline'da da çalışması gereken statik dosyalar
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './data.js',
    './manifest.json',
    'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,400;1,700&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Firebase ve Google — her zaman network'ten
const NETWORK_ONLY = [
    'firebaseapp.com',
    'googleapis.com',
    'gstatic.com',
    'firestore.googleapis.com'
];

// ── Install: statik dosyaları cache'e al ──────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// ── Activate: eski cache'leri temizle ─────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// ── Fetch: istek yönetimi ─────────────────────────────────
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Firebase / Google → her zaman network
    if (NETWORK_ONLY.some(domain => url.includes(domain))) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Statik dosyalar → cache-first, yoksa network
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;

            return fetch(event.request).then(response => {
                // Geçerli response'u cache'e ekle
                if (response && response.status === 200 && response.type !== 'opaque') {
                    const toCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
                }
                return response;
            }).catch(() => {
                // Tamamen offline ve cache'de yoksa
                if (event.request.destination === 'document') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});