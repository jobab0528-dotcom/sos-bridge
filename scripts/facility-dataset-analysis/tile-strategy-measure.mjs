#!/usr/bin/env node
// S2-a v2 analysis tool (review FINDING 4). NOT part of the generator: it is
// not imported by it and not covered by its provenance hash. It measures tile
// strategies on SYNTHETIC data only (no network, no real OSM data):
//
//   A. fixed 0.25 degree grid (current S1/S2-a generator)
//   B. fixed 0.125 degree grid
//   C. fixed 0.0625 degree grid
//   D. adaptive quadtree: 0.25 degree base cells, a cell is split into four
//      half-open quadrants while its tile is over the target size, at most
//      5 levels (0.0078125 degree, still an integer in 1e-7 units).
//
// Fixed grids are built with the REAL generator (buildDataset with the grid
// size changed and the tile limit lifted so sizes can be measured). The
// quadtree is a prototype over the same records and the same canonical tile
// document. For each strategy and scenario it reports the largest tile, the
// number of tile files, total bytes, requests and bytes for one search at the
// hotspot center (1, 5, 10, 50 km), rebuild determinism under shuffled input,
// and radius completeness: for random searches, every record within the
// radius must be inside a fetched tile.
//
//   node --max-old-space-size=4096 scripts/facility-dataset-analysis/tile-strategy-measure.mjs [--quick]

import {buildDataset} from "../facility-dataset/lib/generate.mjs";
import {generatorInfo} from "../facility-dataset/lib/provenance.mjs";
import {canonicalJsonBytes, sha256Hex} from "../facility-dataset/lib/canonical-json.mjs";
import {KR_REGION} from "../facility-dataset/regions/kr.mjs";
import {recordComparatorFor} from "../facility-dataset/lib/evidence.mjs";
import {searchBox, tileIdsForSearch, haversineMeters, toE7, E7} from "../facility-dataset/lib/geo.mjs";

const QUICK = process.argv.includes("--quick");
const LIMIT = KR_REGION.tileMaxBytes; // 512 KiB
const QUADTREE_TARGET = 384 * 1024;   // split below the limit, leaving headroom
const QUADTREE_MAX_DEPTH = 5;
const BASE_TILE_E7 = 2500000;
const HOTSPOT = {lat: 37.5547, lon: 126.9707};
const DATA_AS_OF = "2026-10-20T00:00:00Z";

function rng(seed){
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random){
  return Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
}

const HANGUL = "가나다라마바사아자차카타파하서울강남종로중구";
function koreanName(random, index){
  let text = "";
  for(let k = 0; k < 4 + Math.floor(random() * 6); k += 1) text += HANGUL[Math.floor(random() * HANGUL.length)];
  return `${text}${index % 3 ? "의원" : "병원"}`;
}

// Hospitals inside the 0.25 degree cell holding the hotspot: 70 % in five
// clusters (sigma about 1 km), 30 % uniform; tags shaped like real OSM KR
// clinic objects (Korean and English name, address, phone, hours). Plus a
// metropolitan background of hospitals/2 objects spread uniformly over the
// surrounding 1 x 1 degree box, so wide searches touch many non-empty tiles.
function scenario(hospitals, seed){
  const random = rng(seed);
  const cellSouth = Math.floor(HOTSPOT.lat * 4) / 4;
  const cellWest = Math.floor(HOTSPOT.lon * 4) / 4;
  // Cluster centers inside the hotspot cell [37.5, 37.75) x [126.75, 127.0).
  const clusters = [[37.555, 126.972], [37.520, 126.930], [37.570, 126.985], [37.600, 126.920], [37.510, 126.880]];
  const elements = [];
  for(let index = 0; index < hospitals; index += 1){
    let lat;
    let lon;
    if(random() < 0.7){
      const [cLat, cLon] = clusters[index % clusters.length];
      lat = cLat + gaussian(random) * 0.009;
      lon = cLon + gaussian(random) * 0.011;
    }else{
      lat = cellSouth + random() * 0.25;
      lon = cellWest + random() * 0.25;
    }
    lat = Math.min(cellSouth + 0.2499999, Math.max(cellSouth, lat));
    lon = Math.min(cellWest + 0.2499999, Math.max(cellWest, lon));
    const tags = {
      amenity: index % 9 ? "clinic" : "hospital",
      healthcare: index % 9 ? "clinic" : "hospital",
      name: koreanName(random, index),
      "name:en": `Synthetic Clinic ${index}`,
      "addr:street": "테헤란로",
      "addr:housenumber": String(1 + (index % 500)),
      phone: `+82-2-${String(1000 + (index % 9000))}-${String(index % 10000).padStart(4, "0")}`,
      opening_hours: "Mo-Fr 09:00-18:00; Sa 09:00-13:00"
    };
    if(index % 9 === 0) tags.emergency = index % 2 ? "yes" : "no";
    elements.push({type: "node", id: 100000 + index, lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, tags});
  }
  for(let index = 0; index < Math.floor(hospitals / 2); index += 1){
    const lat = 37.0 + random() * 1.0;
    const lon = 126.5 + random() * 1.0;
    elements.push({type: "node", id: 900000 + index, lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, tags: {
      amenity: "clinic", healthcare: "clinic", name: koreanName(random, index), "name:en": `Background Clinic ${index}`,
      "addr:street": "중앙로", "addr:housenumber": String(1 + (index % 300)), phone: `+82-31-000-${String(index % 10000).padStart(4, "0")}`
    }});
  }
  elements.push({type: "node", id: 99, lat: 35.1, lon: 129.0, tags: {amenity: "pharmacy", name: "filler"}});
  return elements;
}

function buildFixed(elements, tileSizeE7){
  const region = {...KR_REGION, grid: {tileSizeE7}, tileMaxBytes: 64 * 1024 * 1024};
  return buildDataset({elements}, {region, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "tile-analysis",
    qualityGates: {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0}});
}

function tileDocumentBytes(tileId, bounds, records){
  return canonicalJsonBytes({
    schemaVersion: "1", regionCode: "KR", facilityType: "hospital", tileId, bounds, dataAsOf: DATA_AS_OF,
    license: {id: "ODbL-1.0", attribution: "© OpenStreetMap contributors", attributionUrl: "https://www.openstreetmap.org/copyright"},
    elements: records
  });
}

// Quadtree over hospital records. Half-open quadrants in 1e-7 integers, so
// membership never depends on floating point. Returns leaves or throws.
function buildQuadtree(records){
  const compare = recordComparatorFor("hospital");
  const byBase = new Map();
  for(const record of records){
    const latE7 = toE7(record.lat);
    const lonE7 = toE7(record.lon);
    const key = `${Math.floor((latE7 + 90 * E7) / BASE_TILE_E7)}_${Math.floor((lonE7 + 180 * E7) / BASE_TILE_E7)}`;
    if(!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push({record, latE7, lonE7});
  }
  const leaves = [];
  const split = (baseId, path, southE7, westE7, sizeE7, items) => {
    const tileId = path ? `${baseId}~${path}` : baseId;
    const bounds = {south: southE7 / E7, west: westE7 / E7, north: (southE7 + sizeE7) / E7, east: (westE7 + sizeE7) / E7};
    const sorted = items.map((item) => item.record).sort(compare);
    const bytes = tileDocumentBytes(tileId, bounds, sorted);
    if(bytes.length <= QUADTREE_TARGET || path.length >= QUADTREE_MAX_DEPTH){
      if(bytes.length > LIMIT) throw new Error(`TILE_TOO_LARGE at max depth: ${tileId} ${bytes.length}`);
      leaves.push({tileId, southE7, westE7, sizeE7, bytes: bytes.length, count: sorted.length, sha256: sha256Hex(bytes)});
      return;
    }
    const half = sizeE7 / 2;
    const quadrants = [[], [], [], []];
    for(const item of items){
      const north = item.latE7 >= southE7 + half ? 1 : 0;
      const east = item.lonE7 >= westE7 + half ? 1 : 0;
      quadrants[north * 2 + east].push(item);
    }
    quadrants.forEach((quadrant, index) => {
      if(!quadrant.length) return; // empty child: not listed, like an empty fixed tile
      split(baseId, path + String(index), southE7 + (index >> 1) * half, westE7 + (index & 1) * half, half, quadrant);
    });
  };
  for(const [baseId, items] of [...byBase.entries()].sort()){
    const [latIndex, lonIndex] = baseId.split("_").map(Number);
    split(baseId, "", latIndex * BASE_TILE_E7 - 90 * E7, lonIndex * BASE_TILE_E7 - 180 * E7, BASE_TILE_E7, items);
  }
  return leaves.sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
}

function quadtreeLeavesForSearch(leaves, latitude, longitude, radius){
  const box = searchBox(latitude, longitude, radius);
  const s = toE7(box.south), n = toE7(box.north), w = toE7(box.west), e = toE7(box.east);
  return leaves.filter((leaf) => leaf.southE7 <= n && leaf.southE7 + leaf.sizeE7 > s && leaf.westE7 <= e && leaf.westE7 + leaf.sizeE7 > w);
}

function fixedStats(result){
  const tiles = result.manifest.tiles.hospital;
  const byId = new Map(tiles.map((entry) => [entry.tileId, entry]));
  const search = (radius) => {
    const ids = tileIdsForSearch(HOTSPOT.lat, HOTSPOT.lon, radius, result.manifest.grid).filter((id) => byId.has(id));
    return {requests: ids.length, bytes: ids.reduce((sum, id) => sum + byId.get(id).bytes, 0)};
  };
  return {
    maxTileBytes: Math.max(...tiles.map((entry) => entry.bytes)),
    tilesOverLimit: tiles.filter((entry) => entry.bytes > LIMIT).length,
    hospitalTileFiles: tiles.length,
    totalBytes: tiles.reduce((sum, entry) => sum + entry.bytes, 0),
    search: {"1km": search(1000), "5km": search(5000), "10km": search(10000), "50km": search(50000)},
    contentSha256: result.manifest.contentSha256
  };
}

function quadtreeStats(leaves){
  const search = (radius) => {
    const found = quadtreeLeavesForSearch(leaves, HOTSPOT.lat, HOTSPOT.lon, radius);
    return {requests: found.length, bytes: found.reduce((sum, leaf) => sum + leaf.bytes, 0)};
  };
  return {
    maxTileBytes: Math.max(...leaves.map((leaf) => leaf.bytes)),
    tilesOverLimit: leaves.filter((leaf) => leaf.bytes > LIMIT).length,
    hospitalTileFiles: leaves.length,
    maxDepthUsed: Math.max(...leaves.map((leaf) => (leaf.tileId.split("~")[1] || "").length)),
    totalBytes: leaves.reduce((sum, leaf) => sum + leaf.bytes, 0),
    search: {"1km": search(1000), "5km": search(5000), "10km": search(10000), "50km": search(50000)},
    contentSha256: sha256Hex(Buffer.from(leaves.map((leaf) => `${leaf.tileId} ${leaf.sha256}\n`).join(""), "utf8"))
  };
}

// Radius completeness: fetched tiles must contain every record within the
// radius (records are nodes, so the point is the record position).
function completeness(records, fetchRecordIds, searches, seed){
  const random = rng(seed);
  let failures = 0;
  let checked = 0;
  for(let index = 0; index < searches; index += 1){
    const latitude = HOTSPOT.lat - 0.2 + random() * 0.4;
    const longitude = HOTSPOT.lon - 0.2 + random() * 0.4;
    const radius = [500, 1000, 5000, 10000, 20000, 50000][index % 6];
    const fetched = fetchRecordIds(latitude, longitude, radius);
    for(const record of records){
      if(haversineMeters(latitude, longitude, record.lat, record.lon) <= radius){
        checked += 1;
        if(!fetched.has(record.id)) failures += 1;
      }
    }
  }
  return {searches, recordsWithinRadiusChecked: checked, missing: failures};
}

function shuffled(items, seed){
  const random = rng(seed);
  const copy = items.slice();
  for(let index = copy.length - 1; index > 0; index -= 1){
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function measure(label, fn){
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
  const started = Date.now();
  const value = fn();
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return {value, seconds: (Date.now() - started) / 1000, heapDeltaMiB: Math.round((peak - before) / 1048576)};
}

const SIZES = QUICK ? [5000] : [2000, 5000, 10000, 20000];
const output = {limitBytes: LIMIT, quadtreeTargetBytes: QUADTREE_TARGET, quadtreeMaxDepth: QUADTREE_MAX_DEPTH, hotspot: HOTSPOT, scenarios: []};
for(const size of SIZES){
  const elements = scenario(size, 20261028 + size);
  const entry = {hospitalsInHotspotCell: size, strategies: {}};
  for(const [name, tileSizeE7] of [["fixed_0.25", 2500000], ["fixed_0.125", 1250000], ["fixed_0.0625", 625000]]){
    const run = measure(name, () => buildFixed(elements, tileSizeE7));
    const stats = fixedStats(run.value);
    const rerun = fixedStats(buildFixed(shuffled(elements, 7), tileSizeE7));
    stats.deterministicUnderShuffle = rerun.contentSha256 === stats.contentSha256;
    stats.buildSeconds = run.seconds;
    stats.buildHeapDeltaMiB = run.heapDeltaMiB;
    if(size === SIZES[SIZES.length - 1] || QUICK){
      const tiles = new Map(run.value.manifest.tiles.hospital.map((tile) => [tile.tileId, tile]));
      const files = new Map(run.value.files.map((file) => [file.path, file]));
      const recordsByTile = new Map([...tiles.keys()].map((id) => [id, JSON.parse(files.get(tiles.get(id).path).bytes.toString("utf8")).elements.map((element) => element.id)]));
      stats.radiusCompleteness = completeness(elements.filter((element) => element.id >= 100000 && element.lat >= 32.5 && element.lon <= 131), (latitude, longitude, radius) => {
        const ids = new Set();
        for(const id of tileIdsForSearch(latitude, longitude, radius, run.value.manifest.grid)) for(const recordId of recordsByTile.get(id) || []) ids.add(recordId);
        return ids;
      }, QUICK ? 60 : 300, 99);
    }
    delete stats.contentSha256;
    entry.strategies[name] = stats;
  }
  // Quadtree prototype on the records the real generator accepted.
  const base = buildFixed(elements, 2500000);
  const files = new Map(base.files.map((file) => [file.path, file]));
  const records = base.manifest.tiles.hospital.flatMap((tile) => JSON.parse(files.get(tile.path).bytes.toString("utf8")).elements);
  try{
    const run = measure("quadtree", () => buildQuadtree(records));
    const stats = quadtreeStats(run.value);
    stats.deterministicUnderShuffle = quadtreeStats(buildQuadtree(shuffled(records, 7))).contentSha256 === stats.contentSha256;
    stats.buildSeconds = run.seconds;
    stats.buildHeapDeltaMiB = run.heapDeltaMiB;
    if(size === SIZES[SIZES.length - 1] || QUICK){
      const leafRecords = new Map();
      for(const leaf of run.value) leafRecords.set(leaf.tileId, []);
      for(const record of records){
        const latE7 = toE7(record.lat), lonE7 = toE7(record.lon);
        const leaf = run.value.find((item) => latE7 >= item.southE7 && latE7 < item.southE7 + item.sizeE7 && lonE7 >= item.westE7 && lonE7 < item.westE7 + item.sizeE7);
        leafRecords.get(leaf.tileId).push(record.id);
      }
      stats.radiusCompleteness = completeness(records, (latitude, longitude, radius) => {
        const ids = new Set();
        for(const leaf of quadtreeLeavesForSearch(run.value, latitude, longitude, radius)) for(const id of leafRecords.get(leaf.tileId)) ids.add(id);
        return ids;
      }, QUICK ? 60 : 300, 99);
    }
    delete stats.contentSha256;
    entry.strategies["adaptive_quadtree"] = stats;
  }catch(error){
    entry.strategies["adaptive_quadtree"] = {error: String(error.message)};
  }
  output.scenarios.push(entry);
}
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
