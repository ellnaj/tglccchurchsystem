// Minimal service worker: enables "Add to Home Screen / Install" on Android
// Chrome and desktop Chrome/Edge, and caches the app shell so the page still
// opens (offline) even without a signal. Data itself always requires the
// internet, since it lives in Supabase.
const CACHE_NAME = 'tglcc-registration-v1';
const SHELL_FILES = [
  './TGLCC_New_Member_Registration.html',
  './manifest-registration.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase API calls or non-GET requests — always go live.
  if (url.hostname.includes('supabase.co') || event.request.method !== 'GET') {
    return;
  }

  // App shell: cache-first, falling back to network, and refreshing the
  // cache in the background so updates still reach the device.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
