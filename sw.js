const CACHE_NAME = "academie-etoile-v1";
const CORE_ASSETS = [
  "index.html",
  "push.html",
  "pull.html",
  "legs.html",
  "cardio.html",
  "mobility.html",
  "nutrition.html",
  "corps.html",
  "assets/style.css",
  "assets/app.js",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie : réseau d'abord (pour avoir les dernières recettes/menus),
// puis repli sur le cache si hors-ligne. Ne touche jamais aux appels
// vers Firebase/Google (laissés tels quels).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  if(event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
