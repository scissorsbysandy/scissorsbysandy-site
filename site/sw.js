/* Scissors by Sandy — service worker.
   It exists for two reasons: Chrome will not offer the "Add to Home Screen"
   prompt without a fetch handler, and once the site is on a home screen it
   should still open something useful with no signal.

   Deliberately NETWORK FIRST for everything. The cache is only ever a fallback
   for when the network fails. Prices, hours and the booking link change, and a
   service worker that serves yesterday's page is worse than no service worker
   at all. */
const CACHE = 'sbs-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Booking calls are live answers from the calendar: never cache them, so an
  // offline phone can never be shown yesterday's free times as if they were open.
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
