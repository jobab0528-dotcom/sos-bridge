// Shared helpers for tests/unit/facility-dataset-*.test.mjs (not a test file:
// the npm test glob only runs *.test.mjs). Everything runs offline on the
// synthetic fixture; no real OSM data and no network access.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildDataset} from "../../scripts/facility-dataset/lib/generate.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import vm from "node:vm";
import {tileIdsForSearch, haversineMeters} from "../../scripts/facility-dataset/lib/geo.mjs";
import {mergeTileElements, elementsWithinRadius, tileMatchesChecksum} from "../../scripts/facility-dataset/lib/read.mjs";
import {readRepoFile, extractFunction} from "../contract/_source.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_PATH = path.join(ROOT, "tests", "fixtures", "facility-dataset", "kr-synthetic.osm.json");
export const GENERATOR_DIR = path.join(ROOT, "scripts", "facility-dataset");

export function loadFixture(){
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

export function buildFixture(overrides = {}){
  const input = overrides.input || loadFixture();
  return buildDataset(input, {
    region: overrides.region || KR_REGION,
    generator: overrides.generator || generatorInfo(),
    sourceLabel: "kr-synthetic.osm.json",
    ...(overrides.options || {})
  });
}

export function fileMap(result){
  return new Map(result.files.map((file) => [file.path, file]));
}

export function tileDocument(result, relativePath){
  return JSON.parse(fileMap(result).get(relativePath).bytes.toString("utf8"));
}

// Deterministic PRNG (mulberry32) so property tests are repeatable.
export function seededRandom(seed){
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, random){
  const copy = items.slice();
  for(let index = copy.length - 1; index > 0; index -= 1){
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Real production code, executed in node:vm from the unmodified sources.

const CLIENT_PIPELINE_FUNCTIONS = Object.freeze([
  "toRadians", "getDistanceKm", "tag", "formatAddress", "isObviouslyNonMedicalPlace", "isBlockedNonMedicalCategory",
  "isAllowedFacilityCategory", "isNonPatientCareFacilityName", "normalizedOsmTagTokens", "isEmergencyNarrowSpecialtyFacility",
  "getFacilityEmergencyMetadata", "facilityDistanceValue", "normalizedFacilityName", "facilityDedupeKeys",
  "isEmergencyHospitalRecommendation", "facilityEmergencyTier", "compareFacilityResults", "isSameFacilitySite",
  "finalizeFacilityResults", "mapOverpass"
]);

// Client facility pipeline from src/app/legacy-app.js:
// run(elements, type, base, recommendation) = finalizeFacilityResults(mapOverpass(...)).
export function loadClientPipeline(){
  const source = readRepoFile("src/app/legacy-app.js");
  const maxResults = /\nconst MAX_FACILITY_RESULTS = (\d+);/.exec(source);
  if(!maxResults) throw new Error("MAX_FACILITY_RESULTS declaration missing");
  const code = [
    `const MAX_FACILITY_RESULTS = ${maxResults[1]};`,
    ...CLIENT_PIPELINE_FUNCTIONS.map((name) => extractFunction(source, name)),
    "this.run = (elements, type, base, recommendation) => JSON.stringify(finalizeFacilityResults(mapOverpass(elements, type, base), recommendation));",
    "this.mapOne = (element, type, base) => JSON.stringify(mapOverpass([element], type, base));",
    "this.tierOf = (tags) => { const amenity = tag(tags, [\"amenity\"]); const healthcare = tag(tags, [\"healthcare\"]);" +
      " const specialty = tag(tags, [\"healthcare:speciality\", \"speciality\", \"medical_system:specialty\"]);" +
      " const meta = getFacilityEmergencyMetadata(tags, amenity, healthcare, specialty, \"\");" +
      " return {tier: facilityEmergencyTier(Object.assign({amenity, healthcare}, meta)), tierIgnoringNarrow: facilityEmergencyTier(Object.assign({amenity, healthcare}, meta, {emergencyNarrowSpecialty: false}))}; };",
    "this.dedupeKeys = (facility) => JSON.stringify(facilityDedupeKeys(facility));"
  ].join("\n");
  const sandbox = {};
  vm.runInNewContext(code, sandbox, {filename: "legacy-app.js"});
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    run: (elements, type, base, recommendation) => JSON.parse(sandbox.run(copy(elements), type, base, recommendation)),
    mapOne: (element, type, base) => JSON.parse(sandbox.mapOne(copy(element), type, base)),
    tierOf: (tags) => sandbox.tierOf(copy(tags)),
    dedupeKeys: (facility) => JSON.parse(sandbox.dedupeKeys(copy(facility)))
  };
}

// Real netlify/functions/nearby-facilities.js handler with an injected
// provider stub (no network). The stub answers each Overpass query from an
// in-memory element universe: it parses the selectors and the around filter
// from the query text, matches like Overpass (key present; "~" unanchored and
// case-sensitive; "=" exact), measures by node position or way/relation
// center, and returns elements in Overpass order (nodes, ways, relations;
// ascending id). Real Overpass "around" also matches outlines; the stub uses
// the center, like the static path.
export function loadLiveFunction(universe){
  const source = readRepoFile("netlify/functions/nearby-facilities.js");
  const module = {exports: {}};
  const sandbox = {
    module, exports: module.exports, process: {env: {}}, Buffer, AbortController,
    fetch: async () => { throw new Error("unexpected unmocked fetch"); },
    setTimeout, clearTimeout, console
  };
  vm.runInNewContext(source, sandbox, {filename: "nearby-facilities.js"});
  const queries = [];
  const typeOrder = {node: 0, way: 1, relation: 2};
  const fetchImpl = async (url, options) => {
    const query = decodeURIComponent(String(options.body).replace(/^data=/, ""));
    const around = /around:(\d+),(-?[\d.]+),(-?[\d.]+)/.exec(query);
    const radius = Number(around[1]);
    const latitude = Number(around[2]);
    const longitude = Number(around[3]);
    const selectors = [...query.matchAll(/\["([^"]+)"(~|=)"([^"]+)"\]/g)].map((match) => ({key: match[1], operator: match[2], value: match[3]}));
    const scope = selectors.some((selector) => selector.value === "centre|center|yes") ? "extended"
      : selectors.some((selector) => selector.value === "pharmacy") ? "pharmacy" : "core";
    queries.push({scope, radius});
    const elements = universe.filter((element) => selectors.some((selector) => {
      const value = element.tags && element.tags[selector.key];
      if(typeof value !== "string") return false;
      return selector.operator === "=" ? value === selector.value : new RegExp(selector.value).test(value);
    })).filter((element) => {
      const point = element.type === "node" ? element : element.center;
      return haversineMeters(latitude, longitude, point.lat, point.lon) <= radius;
    }).sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (a.id - b.id));
    return {status: 200, text: async () => JSON.stringify({elements})};
  };
  const handler = module.exports._test.createNearbyFacilitiesHandler({fetchImpl});
  return {
    queries,
    EARLY_EXIT_RAW_CANDIDATE_COUNT: module.exports._test.EARLY_EXIT_RAW_CANDIDATE_COUNT,
    async search(type, latitude, longitude){
      const response = await handler({
        httpMethod: "POST",
        body: JSON.stringify({schemaVersion: "1", type, latitude, longitude, maxRadiusMeters: 50000})
      });
      return JSON.parse(response.body);
    }
  };
}

// Static path for one search: tiles touched by the search, checksum-verified,
// merged with the facility type's order, filtered by point distance.
export function staticCandidates(result, type, latitude, longitude, radius){
  const files = fileMap(result);
  const listed = new Map(result.manifest.tiles[type].map((entry) => [entry.tileId, entry]));
  const documents = tileIdsForSearch(latitude, longitude, radius, result.manifest.grid)
    .filter((tileId) => listed.has(tileId))
    .map((tileId) => {
      const entry = listed.get(tileId);
      const document = JSON.parse(files.get(entry.path).bytes.toString("utf8"));
      if(!tileMatchesChecksum(document, entry.sha256)) throw new Error(`checksum mismatch ${entry.path}`);
      return document;
    });
  return elementsWithinRadius(mergeTileElements(documents, type), latitude, longitude, radius);
}
