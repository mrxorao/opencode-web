const CACHE_NAME = 'opencode-pwa-v1';
const STATIC_ASSETS = [
    '/',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable.png',
    '/icon.svg'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('[SW] Cache prefetch warning:', err);
            });
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((name) => {
                        if (name !== CACHE_NAME) {
                            return caches.delete(name);
                        }
                    })
                );
            }),
            self.clients.claim()
        ])
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Bypass caching for WebSocket, auth/tokens, and API requests
    if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/ws') ||
        url.pathname.startsWith('/token') ||
        url.pathname.startsWith('/auth_token') ||
        event.request.method !== 'GET'
    ) {
        return;
    }

    // Network First strategy with Cache fallback
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    if (event.request.mode === 'navigate') {
                        return caches.match('/');
                    }
                });
            })
    );
});
