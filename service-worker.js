const CACHE_PREFIX = "sos-bridge-";
// Increment the cache version whenever a core offline file such as index.html or countries.js changes.
const CACHE_NAME = "sos-bridge-korean-traveler-v49";
const ASSETS = [
  "./",
  "./index.html",
  "./privacy.html",
  "./terms.html",
  "./disclaimer.html",
  "./emergency-sources.html",
  "./install.html",
  "./countries.js",
  "./manifest.json",
  "./icon.svg"
];
const PRECACHE_URLS = new Set(ASSETS.map((asset) => new URL(asset, self.location.href).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/.netlify/functions/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const exactCached = await caches.match(request);
        return exactCached || caches.match("./index.html");
      })
    );
    return;
  }

  if (!PRECACHE_URLS.has(url.href)) return;

  event.respondWith(
    fetch(request).catch(async (error) => {
      const exactCached = await caches.match(request);
      if (exactCached) return exactCached;
      throw error;
    })
  );
});
