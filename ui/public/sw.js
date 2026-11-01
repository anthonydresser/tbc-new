// Minimal service worker: exists so Chrome offers "Install app" (PWA installability
// requires an active worker with a fetch handler). It does no caching — every request
// goes straight to the network, so nothing ever serves a stale build.
self.addEventListener('install', event => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
	event.respondWith(fetch(event.request));
});
