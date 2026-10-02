// Contract: PWA precache baseline (characterization).
// Executes the real service-worker.js in a vm sandbox (stubbed self/caches/
// fetch) to read its ASSETS and to drive its install/activate/fetch handlers.
//
// Resource classes used here:
//   CORE OFFLINE ASSET     - needed to open the app shell and its linked legal
//                            pages offline: must be precached.
//   NETWORK-ONLY           - /.netlify/functions/* and cross-origin services
//                            (OpenAI via functions, Overpass, Nominatim, Google):
//                            must never be served by the service worker.
//   CONDITIONAL DEV TOOL   - developer-test.js, loaded only with ?sosTest=...:
//                            intentionally NOT precached.
//   DEV-ONLY               - dev-all-languages-test.js (not referenced by the
//                            app): intentionally NOT precached.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {readRepoFile, repoFileExists} from "./_source.mjs";

const ORIGIN = "https://sos-bridge.test";
const CONDITIONAL_DEV_TOOLS = ["./developer-test.js"];
const DEV_ONLY = ["./dev-all-languages-test.js"];

function loadServiceWorker(overrides = {}){
  const listeners = {};
  const cacheStore = {added:[], deleted:[], keys:[]};
  const sandbox = {
    URL,
    Promise,
    console,
    self:{
      location:{href:`${ORIGIN}/service-worker.js`, origin:ORIGIN},
      addEventListener(type, handler){ listeners[type] = handler; },
      skipWaiting:async () => {},
      clients:{claim:async () => {}}
    },
    caches:{
      open:async () => ({addAll:async (assets) => { cacheStore.added.push(...assets); }}),
      keys:async () => cacheStore.keys.slice(),
      delete:async (key) => { cacheStore.deleted.push(key); return true; },
      match:async () => undefined
    },
    fetch:async (request) => { throw new Error(`network disabled in test: ${request && request.url || request}`); },
    ...overrides
  };
  vm.runInNewContext(
    `${readRepoFile("service-worker.js")}\n;this.__ASSETS = ASSETS; this.__CACHE_NAME = CACHE_NAME;`,
    sandbox,
    {filename:"service-worker.js"}
  );
  return {assets:Array.from(sandbox.__ASSETS), cacheName:sandbox.__CACHE_NAME, listeners, cacheStore};
}

function normalizeLocal(ref){
  const clean = ref.split("#")[0].split("?")[0];
  if(clean === "./" || clean === "/") return "./";
  return "./" + clean.replace(/^\.?\//, "");
}

function isLocalRef(ref){
  return ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref) && !ref.includes("'+");
}

// Static references that the app shell (index.html) and the pages it links to
// load or navigate to. Dynamically injected dev loaders are not static refs.
function staticLocalRefs(html){
  const refs = new Set();
  for(const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) if(isLocalRef(match[1])) refs.add(normalizeLocal(match[1]));
  for(const match of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) if(isLocalRef(match[1])) refs.add(normalizeLocal(match[1]));
  for(const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) if(isLocalRef(match[1])) refs.add(normalizeLocal(match[1]));
  return refs;
}

function coreOfflineAssets(){
  const core = new Set(["./", "./index.html"]);
  const queue = ["./index.html"];
  const seen = new Set();
  while(queue.length){
    const page = queue.shift();
    if(seen.has(page)) continue;
    seen.add(page);
    for(const ref of staticLocalRefs(readRepoFile(page.slice(2)))){
      core.add(ref);
      if(ref.endsWith(".html") && !seen.has(ref)) queue.push(ref);
    }
  }
  const manifest = JSON.parse(readRepoFile("manifest.json"));
  core.add(normalizeLocal(manifest.start_url));
  for(const icon of manifest.icons || []) core.add(normalizeLocal(icon.src));
  return core;
}

function fakeFetchEvent(url, {method = "GET", mode = "cors"} = {}){
  const event = {
    request:{url, method, mode},
    responded:false,
    respondWith(promise){
      this.responded = true;
      // Network is disabled and the cache is empty in this sandbox, so the
      // worker's response promise may reject; only the routing decision matters.
      Promise.resolve(promise).catch(() => {});
    }
  };
  return event;
}

test("every precached asset exists in the repository", () => {
  const {assets} = loadServiceWorker();
  for(const asset of assets){
    if(asset === "./") continue;
    assert.ok(repoFileExists(asset.slice(2)), `${asset} exists`);
  }
});

test("all CORE OFFLINE ASSETS of the app shell and its linked pages are precached", () => {
  const {assets} = loadServiceWorker();
  const precached = new Set(assets.map(normalizeLocal));
  const core = coreOfflineAssets();
  const missing = [...core].filter((asset) => !precached.has(asset));
  assert.deepEqual(missing, [], "core offline assets missing from service-worker ASSETS");
  // Characterization of today's core set.
  assert.deepEqual([...core].sort(), [
    "./", "./countries.js", "./disclaimer.html", "./emergency-sources.html", "./icon.svg",
    "./index.html", "./install.html", "./manifest.json", "./privacy.html",
    "./src/app/legacy-app.js", "./terms.html"
  ]);
});

test("CONDITIONAL DEV TOOL and DEV-ONLY scripts are intentionally not precached", () => {
  const {assets} = loadServiceWorker();
  const precached = new Set(assets.map(normalizeLocal));
  for(const asset of [...CONDITIONAL_DEV_TOOLS, ...DEV_ONLY]){
    assert.equal(precached.has(asset), false, `${asset} must not be a core offline asset`);
  }
});

test("install precaches exactly ASSETS under the current cache name", async () => {
  const {assets, cacheName, listeners, cacheStore} = loadServiceWorker();
  assert.match(cacheName, /^sos-bridge-/);
  let pending;
  listeners.install({waitUntil(promise){ pending = promise; }});
  await pending;
  assert.deepEqual(cacheStore.added, assets);
});

test("activate removes only older sos-bridge caches", async () => {
  const sw = loadServiceWorker();
  sw.cacheStore.keys = ["sos-bridge-old-v1", sw.cacheName, "other-app-cache", "workbox-precache"];
  let pending;
  sw.listeners.activate({waitUntil(promise){ pending = promise; }});
  await pending;
  assert.deepEqual(sw.cacheStore.deleted, ["sos-bridge-old-v1"]);
});

test("NETWORK-ONLY: functions, non-GET and cross-origin requests are never handled by the service worker", () => {
  const {listeners} = loadServiceWorker();
  const untouched = [
    fakeFetchEvent(`${ORIGIN}/.netlify/functions/ai-care`),
    fakeFetchEvent(`${ORIGIN}/.netlify/functions/nearby-facilities`),
    // A navigation to a function URL must not be answered with the cached app shell.
    fakeFetchEvent(`${ORIGIN}/.netlify/functions/ai-care`, {mode:"navigate"}),
    fakeFetchEvent(`${ORIGIN}/.netlify/functions/translate-help-phrases`, {method:"POST"}),
    fakeFetchEvent(`${ORIGIN}/index.html`, {method:"POST"}),
    fakeFetchEvent("https://overpass-api.de/api/interpreter"),
    fakeFetchEvent("https://nominatim.openstreetmap.org/search?q=Paris"),
    fakeFetchEvent("https://www.google.com/maps/search/?api=1&query=hospital"),
    fakeFetchEvent(`${ORIGIN}/developer-test.js?v=1`),
    fakeFetchEvent(`${ORIGIN}/dev-all-languages-test.js`)
  ];
  for(const event of untouched){
    listeners.fetch(event);
    assert.equal(event.responded, false, `${event.request.method} ${event.request.url}`);
  }
});

test("core assets and navigations are served by the service worker (offline fallback)", () => {
  const {listeners} = loadServiceWorker();
  const handled = [
    fakeFetchEvent(`${ORIGIN}/index.html`),
    fakeFetchEvent(`${ORIGIN}/countries.js`),
    fakeFetchEvent(`${ORIGIN}/privacy.html`),
    fakeFetchEvent(`${ORIGIN}/?utm=1`, {mode:"navigate"}),
    fakeFetchEvent(`${ORIGIN}/index.html?sosTest=all-languages`, {mode:"navigate"})
  ];
  for(const event of handled){
    listeners.fetch(event);
    assert.equal(event.responded, true, `${event.request.mode} ${event.request.url}`);
  }
});

// ---------- Offline shell and update transition ----------
// The app logic now lives in src/app/legacy-app.js, a separate file the shell
// cannot run without. These tests drive the real worker against an in-memory
// model of Cache Storage and the network. As in browsers, cache.addAll is
// atomic: one failed fetch stores nothing.

function repoAssetFiles(){
  const files = {};
  for(const asset of loadServiceWorker().assets){
    if(asset === "./") continue;
    files[asset.slice(2)] = readRepoFile(asset.slice(2));
  }
  return files;
}

function makeBrowser(files){
  const network = {online:true, files:{...files}};
  const store = new Map();
  const absolute = (input) => new URL(typeof input === "string" ? input : input.url, `${ORIGIN}/service-worker.js`).href;
  const fetchImpl = async (input) => {
    const url = new URL(absolute(input));
    if(!network.online) throw new TypeError("Failed to fetch (offline)");
    const key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if(!Object.hasOwn(network.files, key)) return {ok:false, status:404, url:url.href, body:""};
    return {ok:true, status:200, url:url.href, body:network.files[key]};
  };
  const caches = {
    open:async (name) => {
      if(!store.has(name)) store.set(name, new Map());
      const cache = store.get(name);
      return {
        addAll:async (assets) => {
          const responses = await Promise.all(assets.map(async (asset) => {
            const response = await fetchImpl(asset);
            if(!response.ok) throw new TypeError(`addAll failed: ${asset} -> ${response.status}`);
            return [absolute(asset), response];
          }));
          for(const [url, response] of responses) cache.set(url, response);
        }
      };
    },
    keys:async () => [...store.keys()],
    delete:async (name) => store.delete(name),
    match:async (input) => {
      const url = absolute(input);
      for(const cache of store.values()) if(cache.has(url)) return cache.get(url);
      return undefined;
    }
  };
  return {network, store, fetch:fetchImpl, caches};
}

function runLifecycle(sw, type){
  let pending;
  sw.listeners[type]({waitUntil(promise){ pending = promise; }});
  return pending;
}

function dispatchFetch(sw, url, mode = "cors"){
  let response;
  const event = {request:{url, method:"GET", mode}, respondWith(promise){ response = promise; }};
  sw.listeners.fetch(event);
  assert.ok(response, `service worker must answer ${mode} ${url}`);
  return response;
}

test("offline reload after an update serves the new shell and every local script it loads from the new precache", async () => {
  const files = repoAssetFiles();
  const browser = makeBrowser(files);
  // A previous version's cache (inline app script, no legacy-app.js) exists.
  browser.store.set("sos-bridge-korean-traveler-v72", new Map([
    [`${ORIGIN}/`, {ok:true, status:200, body:"<!doctype html><script>/* previous inline app */</script>"}],
    [`${ORIGIN}/index.html`, {ok:true, status:200, body:"<!doctype html><script>/* previous inline app */</script>"}]
  ]));
  const sw = loadServiceWorker({fetch:browser.fetch, caches:browser.caches});
  await runLifecycle(sw, "install");
  await runLifecycle(sw, "activate");
  assert.deepEqual([...browser.store.keys()], [sw.cacheName], "only the new cache remains after activation");

  browser.network.online = false;
  const shell = await dispatchFetch(sw, `${ORIGIN}/`, "navigate");
  assert.equal(shell.body, files["index.html"]);
  const scripts = [...shell.body.matchAll(/<script\b[^>]*\bsrc="\.\/([^"?#]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, ["countries.js", "src/app/legacy-app.js"]);
  for(const script of scripts){
    const response = await dispatchFetch(sw, `${ORIGIN}/${script}`);
    assert.equal(response.body, files[script], `${script} is served offline from the precache`);
  }
  const deepLink = await dispatchFetch(sw, `${ORIGIN}/index.html?sosTest=all-languages`, "navigate");
  assert.equal(deepLink.body, files["index.html"]);
});

test("online, legacy-app.js is network-first, so a fresh shell never runs a stale cached app script", async () => {
  const browser = makeBrowser(repoAssetFiles());
  const sw = loadServiceWorker({fetch:browser.fetch, caches:browser.caches});
  await runLifecycle(sw, "install");
  await runLifecycle(sw, "activate");
  browser.network.files["src/app/legacy-app.js"] = "/* next deploy */";
  const response = await dispatchFetch(sw, `${ORIGIN}/src/app/legacy-app.js`);
  assert.equal(response.body, "/* next deploy */");
});

test("install fails as a whole when legacy-app.js cannot be precached, so no incomplete offline shell is activated", async () => {
  const files = repoAssetFiles();
  delete files["src/app/legacy-app.js"];
  const browser = makeBrowser(files);
  const sw = loadServiceWorker({fetch:browser.fetch, caches:browser.caches});
  await assert.rejects(runLifecycle(sw, "install"), /legacy-app\.js/);
  assert.equal((browser.store.get(sw.cacheName) || new Map()).size, 0, "nothing from the failed install is cached");
});
