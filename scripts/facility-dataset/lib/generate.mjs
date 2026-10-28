// Deterministic static facility dataset generator (pure: no file system,
// network or clock access). Input is OSM JSON ({elements: [...]}, the format
// returned by the OSM API and Overpass) holding nodes, ways and relations.
// Output is a versioned candidate dataset: per-type geographic tiles of
// Overpass-compatible elements (the exact shape the live Function returns),
// a validation report, an attribution notice and a manifest with SHA-256
// checksums. Publishing is a separate, later step; the generator never marks
// a dataset as published.

import {canonicalJson, canonicalJsonBytes, sha256Hex, isPlainObject} from "./canonical-json.mjs";
import {
  FACILITY_TYPES,
  HOSPITAL_CORE_SELECTORS,
  HOSPITAL_EXTENDED_SELECTORS,
  PHARMACY_SELECTORS,
  PRESERVED_TAG_KEYS,
  facilityScope,
  preservedTags
} from "./selectors.mjs";
import {recordComparatorFor} from "./evidence.mjs";
import {analyzeClientCollapse} from "./collisions.mjs";
import {
  isValidLatitude,
  isValidLongitude,
  toE7,
  fromE7,
  tileIdForE7,
  tileBounds,
  boundsContain
} from "./geo.mjs";

export const GENERATOR_NAME = "sos-bridge-facility-dataset";
export const GENERATOR_VERSION = "0.1.0";
export const MANIFEST_SCHEMA_VERSION = "1";
export const TILE_SCHEMA_VERSION = "1";
export const REPORT_SCHEMA_VERSION = "1";
export const MAX_TAG_TEXT_LENGTH = 255;
export const REJECTED_SAMPLE_LIMIT = 100;

export const LICENSE = Object.freeze({
  id: "ODbL-1.0",
  name: "Open Data Commons Open Database License 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  attributionUrl: "https://www.openstreetmap.org/copyright",
  shareAlike: true,
  notice: "Contains information from OpenStreetMap, which is made available here under the Open Database License (ODbL) 1.0."
});

export const SEMANTICS = Object.freeze({
  emergency: "OSM emergency-related tags are community map annotations copied verbatim. They do not verify that an emergency department exists, is open, is staffed, or can accept patients.",
  classification: "Objects are selected with the same tag selectors as netlify/functions/nearby-facilities.js and keep raw OSM tags (preservedTagKeys only). Facility classification, non-medical filtering, emergency tiers and deduplication stay in the client pipeline.",
  selection: "Use this dataset only when the search coordinates fall inside coverage.serviceArea and the search box fits inside coverage.dataBounds. The traveler's selected country is not an input to dataset selection.",
  ordering: "Hospital tiles are ordered by OSM evidence (hospital with affirmative emergency-related tags, then other hospital, then other), then OSM type and id, so a stronger hospital/emergency record is never displaced by an order-dependent client collapse. Pharmacy tiles are ordered by OSM type and id (Overpass order, as the live Function returns them). Consumers must merge tiles of one facility type with that type's order. The order is a hint only: no tag is added or changed.",
  coverage: "Static candidates are every selected object whose point is within the search radius. The live Function can return fewer (it stops after 20 raw candidates, may skip the extended hospital selector, and caps hospital searches at 10 km), so static and live results match only when the live response consulted every selector at its final radius.",
  emptyTile: "A tile id that is not listed for a facility type has zero objects of that type. A listed tile that cannot be fetched or fails its SHA-256 check makes the dataset unavailable for that search."
});

export const REJECTION_REASONS = Object.freeze([
  "incomplete_geometry",
  "invalid_coordinates",
  "malformed_element",
  "malformed_tags",
  "outside_data_bounds"
]);

const TYPE_ORDER = Object.freeze({node: 0, way: 1, relation: 2});
const EMERGENCY_TAG_KEYS = Object.freeze([
  "emergency", "emergency:department", "healthcare:emergency", "emergency_ward", "emergency_ward_entrance"
]);
const DATA_AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class DatasetBuildError extends Error{
  constructor(code, message, details = {}){
    super(`${code}: ${message}`);
    this.name = "DatasetBuildError";
    this.code = code;
    this.details = details;
  }
}

function hasOwn(object, key){
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isValidDataAsOf(value){
  if(typeof value !== "string" || !DATA_AS_OF_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value.slice(0, 19) + ".000Z";
}

// The dataset timestamp always comes from the source data or an explicit
// option, never from the wall clock, so rebuilding the same input is
// byte-identical.
function resolveDataAsOf(input, explicitDataAsOf){
  const sourceValue = isPlainObject(input.osm3s) ? input.osm3s.timestamp_osm_base : undefined;
  const hasSource = sourceValue !== undefined;
  const hasExplicit = explicitDataAsOf !== undefined && explicitDataAsOf !== null;
  if(hasSource && !isValidDataAsOf(sourceValue)){
    throw new DatasetBuildError("INVALID_DATA_AS_OF", "osm3s.timestamp_osm_base must be YYYY-MM-DDTHH:MM:SSZ");
  }
  if(hasExplicit && !isValidDataAsOf(explicitDataAsOf)){
    throw new DatasetBuildError("INVALID_DATA_AS_OF", "dataAsOf must be YYYY-MM-DDTHH:MM:SSZ");
  }
  if(hasSource && hasExplicit && sourceValue !== explicitDataAsOf){
    throw new DatasetBuildError("DATA_AS_OF_CONFLICT", "explicit dataAsOf differs from the source timestamp");
  }
  if(!hasSource && !hasExplicit){
    throw new DatasetBuildError("MISSING_DATA_AS_OF", "no source timestamp and no explicit dataAsOf");
  }
  return hasExplicit ? explicitDataAsOf : sourceValue;
}

function validateRegion(region){
  if(!isPlainObject(region) || typeof region.regionCode !== "string" || !/^[A-Z]{2}$/.test(region.regionCode) ||
    !region.dataBounds || !region.grid || !region.serviceArea ||
    !Number.isSafeInteger(region.tileMaxBytes) || region.tileMaxBytes <= 0 ||
    typeof region.maxSearchRadiusMeters !== "number"){
    throw new DatasetBuildError("INVALID_REGION", "region definition is incomplete");
  }
}

function validateGenerator(generator){
  if(!generator || typeof generator.name !== "string" || typeof generator.version !== "string" ||
    typeof generator.sourceSha256 !== "string" || !SHA256_PATTERN.test(generator.sourceSha256)){
    throw new DatasetBuildError("INVALID_GENERATOR_INFO", "generator {name, version, sourceSha256} is required");
  }
}

function textLength(value){
  return Array.from(value).length;
}

function validTags(tags){
  if(tags === undefined) return true;
  if(!isPlainObject(tags)) return false;
  for(const key of Object.keys(tags)){
    const value = tags[key];
    if(key === "" || textLength(key) > MAX_TAG_TEXT_LENGTH) return false;
    if(typeof value !== "string" || value === "" || textLength(value) > MAX_TAG_TEXT_LENGTH) return false;
  }
  return true;
}

function isPositiveId(value){
  return Number.isSafeInteger(value) && value > 0;
}

function validShape(element){
  if(!isPlainObject(element) || !hasOwn(TYPE_ORDER, element.type) || !isPositiveId(element.id)) return false;
  if(element.type === "way"){
    return Array.isArray(element.nodes) && element.nodes.length >= 2 && element.nodes.every(isPositiveId);
  }
  if(element.type === "relation"){
    return Array.isArray(element.members) && element.members.every((member) =>
      isPlainObject(member) && hasOwn(TYPE_ORDER, member.type) && isPositiveId(member.ref));
  }
  return true;
}

function elementLabel(element){
  if(isPlainObject(element) && typeof element.type === "string" && /^[a-z]{1,16}$/.test(element.type) &&
    Number.isSafeInteger(element.id)){
    return `${element.type}/${element.id}`;
  }
  return null;
}

function createRejections(){
  const rejections = {};
  for(const reason of REJECTION_REASONS) rejections[reason] = {count: 0, labels: []};
  return rejections;
}

function reject(rejections, reason, element){
  rejections[reason].count += 1;
  const label = elementLabel(element);
  if(label) rejections[reason].labels.push(label);
}

function boxCenter(points){
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for(const point of points){
    minLat = Math.min(minLat, point.latE7);
    maxLat = Math.max(maxLat, point.latE7);
    minLon = Math.min(minLon, point.lonE7);
    maxLon = Math.max(maxLon, point.lonE7);
  }
  // Center of the bounding box, as Overpass "out center" reports it.
  return {latE7: Math.round((minLat + maxLat) / 2), lonE7: Math.round((minLon + maxLon) / 2)};
}

function wayPoints(way, nodeCoordinates){
  const points = [];
  for(const ref of way.nodes){
    const point = nodeCoordinates.get(ref);
    if(!point) return null;
    points.push(point);
  }
  return points;
}

// Position of a facility object, or a rejection reason. Ways and relations
// use the bounding-box center of their member geometry; an object with any
// missing member geometry is rejected instead of being placed approximately.
function positionOf(element, nodeCoordinates, ways, geometryStats){
  if(element.type === "node"){
    if(!isValidLatitude(element.lat) || !isValidLongitude(element.lon)) return {reason: "invalid_coordinates"};
    return {latE7: toE7(element.lat), lonE7: toE7(element.lon)};
  }
  if(element.type === "way"){
    const points = wayPoints(element, nodeCoordinates);
    return points ? boxCenter(points) : {reason: "incomplete_geometry"};
  }
  const points = [];
  for(const member of element.members){
    if(member.type === "node"){
      const point = nodeCoordinates.get(member.ref);
      if(!point) return {reason: "incomplete_geometry"};
      points.push(point);
    }else if(member.type === "way"){
      const way = ways.get(member.ref);
      const memberPoints = way ? wayPoints(way, nodeCoordinates) : null;
      if(!memberPoints) return {reason: "incomplete_geometry"};
      points.push(...memberPoints);
    }else{
      geometryStats.subrelationMembersIgnored += 1;
    }
  }
  return points.length ? boxCenter(points) : {reason: "incomplete_geometry"};
}

function attributionText(datasetVersionId, regionCode, dataAsOf){
  return [
    `SOS Bridge static facility dataset ${datasetVersionId}`,
    `Region: ${regionCode}`,
    `Data as of: ${dataAsOf}`,
    "",
    LICENSE.notice,
    `${LICENSE.attribution} - ${LICENSE.attributionUrl}`,
    `License text: ${LICENSE.url}`,
    "",
    "This dataset is a Derivative Database of OpenStreetMap data. Anyone who",
    "distributes it, or a database derived from it, must keep this notice and",
    "offer that database under the ODbL 1.0 (share-alike).",
    "",
    SEMANTICS.emergency,
    ""
  ].join("\n");
}

function tileStats(entries){
  return {
    count: entries.length,
    maxElements: entries.reduce((max, entry) => Math.max(max, entry.count), 0),
    maxBytes: entries.reduce((max, entry) => Math.max(max, entry.bytes), 0),
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalElements: entries.reduce((sum, entry) => sum + entry.count, 0)
  };
}

export function buildDataset(input, options = {}){
  const {region, generator, dataAsOf: explicitDataAsOf, sourceLabel = "unspecified", rawInputSha256} = options;
  validateRegion(region);
  validateGenerator(generator);
  if(typeof sourceLabel !== "string" || sourceLabel === "" || sourceLabel.length > 200){
    throw new DatasetBuildError("INVALID_SOURCE_LABEL", "sourceLabel must be a short non-empty string");
  }
  if(rawInputSha256 !== undefined && (typeof rawInputSha256 !== "string" || !SHA256_PATTERN.test(rawInputSha256))){
    throw new DatasetBuildError("INVALID_RAW_INPUT_SHA256", "rawInputSha256 must be 64 lowercase hex characters");
  }
  if(!isPlainObject(input) || !Array.isArray(input.elements)){
    throw new DatasetBuildError("INVALID_INPUT", "input must be an OSM JSON object with an elements array");
  }
  const dataAsOf = resolveDataAsOf(input, explicitDataAsOf);

  const rejections = createRejections();
  const canonicalByIdentity = new Map();
  const duplicateIdentical = [];
  const uniqueElements = [];

  // Pass 1: shape validation and duplicate object IDs. Identical duplicates
  // are collapsed; conflicting duplicates stop the build because the correct
  // version cannot be chosen safely.
  for(const element of input.elements){
    if(!validShape(element)){
      reject(rejections, "malformed_element", element);
      continue;
    }
    let canonical;
    try{
      canonical = canonicalJson(element);
    }catch(error){
      reject(rejections, "malformed_element", element);
      continue;
    }
    const identity = `${element.type}/${element.id}`;
    if(canonicalByIdentity.has(identity)){
      if(canonicalByIdentity.get(identity) === canonical){
        duplicateIdentical.push(identity);
        continue;
      }
      throw new DatasetBuildError("DUPLICATE_ID_CONFLICT", `conflicting duplicate object ${identity}`, {identity});
    }
    canonicalByIdentity.set(identity, canonical);
    uniqueElements.push(element);
  }

  const nodeCoordinates = new Map();
  const ways = new Map();
  const byType = {node: 0, way: 0, relation: 0};
  for(const element of uniqueElements){
    byType[element.type] += 1;
    if(element.type === "node" && isValidLatitude(element.lat) && isValidLongitude(element.lon)){
      nodeCoordinates.set(element.id, {latE7: toE7(element.lat), lonE7: toE7(element.lon)});
    }
    if(element.type === "way") ways.set(element.id, element);
  }

  // Pass 2: selector scope, geometry, bounds and tile assignment.
  const buckets = {};
  for(const type of FACILITY_TYPES) buckets[type] = new Map();
  const accepted = {hospital: 0, pharmacy: 0, inBothTypes: 0, hospitalCoreScope: 0, hospitalExtendedOnlyScope: 0};
  const emergencyTagPresent = {hospital: 0, pharmacy: 0};
  const geometryStats = {subrelationMembersIgnored: 0};
  let untagged = 0;
  let outOfScope = 0;
  let droppedTagEntries = 0;

  for(const element of uniqueElements){
    if(!validTags(element.tags)){
      reject(rejections, "malformed_tags", element);
      continue;
    }
    const tags = element.tags || {};
    if(!Object.keys(tags).length){
      untagged += 1;
      continue;
    }
    const scope = facilityScope(tags);
    if(!scope.hospital && !scope.pharmacy){
      outOfScope += 1;
      continue;
    }
    const position = positionOf(element, nodeCoordinates, ways, geometryStats);
    if(position.reason){
      reject(rejections, position.reason, element);
      continue;
    }
    const latitude = fromE7(position.latE7);
    const longitude = fromE7(position.lonE7);
    if(!boundsContain(region.dataBounds, latitude, longitude)){
      reject(rejections, "outside_data_bounds", element);
      continue;
    }
    const kept = preservedTags(tags);
    droppedTagEntries += kept.dropped;
    const record = element.type === "node"
      ? {type: element.type, id: element.id, lat: latitude, lon: longitude, tags: kept.tags}
      : {type: element.type, id: element.id, center: {lat: latitude, lon: longitude}, tags: kept.tags};
    const tileId = tileIdForE7(position.latE7, position.lonE7, region.grid);
    const hasEmergencyTag = EMERGENCY_TAG_KEYS.some((key) => hasOwn(kept.tags, key));
    for(const type of FACILITY_TYPES){
      if(!scope[type]) continue;
      if(!buckets[type].has(tileId)) buckets[type].set(tileId, []);
      buckets[type].get(tileId).push(record);
      accepted[type] += 1;
      if(hasEmergencyTag) emergencyTagPresent[type] += 1;
    }
    if(scope.hospital && scope.pharmacy) accepted.inBothTypes += 1;
    if(scope.hospitalCore) accepted.hospitalCoreScope += 1;
    else if(scope.hospitalExtended) accepted.hospitalExtendedOnlyScope += 1;
  }

  for(const type of FACILITY_TYPES){
    if(accepted[type] === 0){
      throw new DatasetBuildError("EMPTY_DATASET", `no ${type} objects accepted; refusing to build an empty dataset`, {
        hospital: accepted.hospital,
        pharmacy: accepted.pharmacy
      });
    }
  }

  // Tiles.
  const tileFiles = [];
  const tiles = {};
  for(const type of FACILITY_TYPES){
    tiles[type] = [];
    for(const tileId of [...buckets[type].keys()].sort()){
      // Per-type order (see evidence.mjs): hospital tiles evidence-first, so
      // the stronger hospital/emergency record wins every order-dependent
      // collapse in the existing client; pharmacy tiles keep Overpass order,
      // like the live Function and S1 v1.
      const elements = buckets[type].get(tileId).slice().sort(recordComparatorFor(type));
      for(const element of elements){
        const point = element.type === "node" ? element : element.center;
        if(tileIdForE7(toE7(point.lat), toE7(point.lon), region.grid) !== tileId){
          throw new DatasetBuildError("TILE_MEMBERSHIP_MISMATCH", `${element.type}/${element.id} is outside tile ${tileId}`);
        }
      }
      const bounds = tileBounds(tileId, region.grid);
      const bytes = canonicalJsonBytes({
        schemaVersion: TILE_SCHEMA_VERSION,
        regionCode: region.regionCode,
        facilityType: type,
        tileId,
        bounds,
        dataAsOf,
        license: {id: LICENSE.id, attribution: LICENSE.attribution, attributionUrl: LICENSE.attributionUrl},
        elements
      });
      if(bytes.length > region.tileMaxBytes){
        throw new DatasetBuildError("TILE_TOO_LARGE", `${type}/${tileId} is ${bytes.length} bytes (limit ${region.tileMaxBytes})`, {
          type, tileId, bytes: bytes.length
        });
      }
      const path = `${type}/${tileId}.json`;
      const sha256 = sha256Hex(bytes);
      tileFiles.push({path, bytes, sha256});
      tiles[type].push({tileId, path, sha256, bytes: bytes.length, count: elements.length, bounds});
    }
  }

  const contentSha256 = sha256Hex(Buffer.from(
    tileFiles.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => `${file.path} ${file.sha256}\n`).join(""),
    "utf8"
  ));
  const datasetVersionId = `${region.regionCode.toLowerCase()}-osm-${dataAsOf.replace(/[-:]/g, "")}-${contentSha256.slice(0, 12)}`;

  const canonicalInputSha256 = sha256Hex(Buffer.from([...canonicalByIdentity.values()].sort().join("\n"), "utf8"));

  const rejectedReport = {};
  let rejectedTotal = 0;
  for(const reason of REJECTION_REASONS){
    const labels = rejections[reason].labels.slice().sort();
    rejectedTotal += rejections[reason].count;
    rejectedReport[reason] = {count: rejections[reason].count, sample: labels.slice(0, REJECTED_SAMPLE_LIMIT)};
  }

  const report = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    datasetVersionId,
    regionCode: region.regionCode,
    dataAsOf,
    input: {
      elementCount: input.elements.length,
      uniqueElementCount: uniqueElements.length,
      byType,
      untaggedElementCount: untagged,
      duplicateIdenticalCount: duplicateIdentical.length,
      duplicateIdenticalSample: duplicateIdentical.slice().sort().slice(0, REJECTED_SAMPLE_LIMIT)
    },
    accepted: {...accepted, osmEmergencyTagPresent: emergencyTagPresent},
    excluded: {outOfSelectorScope: outOfScope},
    rejected: {total: rejectedTotal, byReason: rejectedReport},
    tags: {preservedTagKeyCount: PRESERVED_TAG_KEYS.length, droppedTagEntryCount: droppedTagEntries},
    geometry: geometryStats,
    clientCollapse: {
      scope: "hospital records only; potential, before client category filters",
      ...analyzeClientCollapse([...buckets.hospital.values()].flat(), REJECTED_SAMPLE_LIMIT)
    },
    tiles: {
      tileMaxBytesLimit: region.tileMaxBytes,
      hospital: tileStats(tiles.hospital),
      pharmacy: tileStats(tiles.pharmacy)
    },
    gates: [
      {id: "non_empty_hospital", status: "PASSED"},
      {id: "non_empty_pharmacy", status: "PASSED"},
      {id: "tile_max_bytes", status: "PASSED"},
      {id: "tile_membership", status: "PASSED"},
      {id: "data_bounds", status: "PASSED"},
      {id: "max_rejected_ratio", status: "NOT_CONFIGURED"},
      {id: "count_delta_vs_previous_version", status: "NOT_CONFIGURED"},
      {id: "known_facility_sample", status: "NOT_CONFIGURED"},
      {id: "nonmedical_contamination_sample", status: "NOT_CONFIGURED"}
    ]
  };
  const reportBytes = canonicalJsonBytes(report);
  const attributionBytes = Buffer.from(attributionText(datasetVersionId, region.regionCode, dataAsOf), "utf8");

  const source = {
    kind: "openstreetmap",
    label: sourceLabel,
    canonicalInputSha256,
    canonicalInputSha256Method: "sha256 of the sorted, de-duplicated canonical JSON of each input element joined by newlines"
  };
  if(rawInputSha256) source.rawInputSha256 = rawInputSha256;

  const manifest = {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetVersionId,
    status: "candidate",
    regionCode: region.regionCode,
    dataAsOf,
    source,
    license: LICENSE,
    semantics: SEMANTICS,
    selectors: {
      hospital: {core: HOSPITAL_CORE_SELECTORS, extended: HOSPITAL_EXTENDED_SELECTORS},
      pharmacy: PHARMACY_SELECTORS
    },
    preservedTagKeys: PRESERVED_TAG_KEYS,
    coverage: {
      serviceArea: region.serviceArea,
      serviceAreaStatus: region.serviceAreaStatus || "unspecified",
      dataBounds: region.dataBounds,
      maxSearchRadiusMeters: region.maxSearchRadiusMeters
    },
    grid: {scheme: "latlon-e7-floor-half-open", origin: {lat: -90, lon: -180}, tileSizeE7: region.grid.tileSizeE7},
    counts: {hospital: accepted.hospital, pharmacy: accepted.pharmacy},
    tiles,
    contentSha256,
    contentSha256Method: "sha256 of sorted lines '<path> <sha256>\\n' over all tile files",
    files: {
      validationReport: {path: "validation-report.json", sha256: sha256Hex(reportBytes), bytes: reportBytes.length},
      attribution: {path: "ATTRIBUTION.txt", sha256: sha256Hex(attributionBytes), bytes: attributionBytes.length}
    },
    generator: {name: generator.name, version: generator.version, sourceSha256: generator.sourceSha256}
  };
  const manifestBytes = canonicalJsonBytes(manifest);

  const files = [
    ...tileFiles,
    {path: "validation-report.json", bytes: reportBytes, sha256: sha256Hex(reportBytes)},
    {path: "ATTRIBUTION.txt", bytes: attributionBytes, sha256: sha256Hex(attributionBytes)},
    {path: "manifest.json", bytes: manifestBytes, sha256: sha256Hex(manifestBytes)}
  ];

  return {datasetVersionId, manifest, report, files, manifestSha256: sha256Hex(manifestBytes)};
}
