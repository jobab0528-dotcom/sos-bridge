// Deterministic static facility dataset generator (pure: no file system,
// network or clock access). Input is OSM JSON ({elements: [...]}, the format
// returned by the OSM API and Overpass) holding nodes, ways and relations.
// Output is a versioned candidate dataset: per-type geographic tiles of
// Overpass-compatible elements (the exact shape the live Function returns),
// a validation report, an attribution notice and a manifest with SHA-256
// checksums. Publishing is a separate, later step; the generator never marks
// a dataset as published.
//
// Safety policy (fail-closed):
// - A facility way or relation whose referenced geometry does not fully
//   resolve (lib/integrity.mjs) stops the build with
//   REFERENTIAL_INTEGRITY_FAILED, unless that exact object is listed in an
//   explicit allowance with a reason (lib/quality-gates.mjs); allowed objects
//   are excluded, never placed approximately.
// - A hospital object carrying affirmative OSM emergency evidence is never
//   dropped silently: if it would be rejected for invalid coordinates or
//   unresolved geometry the build stops (EMERGENCY_EVIDENCE_REJECTED, no
//   allowance possible). If it lies outside the region's data bounds the build
//   stops (EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS) unless that exact object is
//   acknowledged in the quality-gates file (acknowledgeEmergencyOutsideDataBounds,
//   with a written reason); acknowledged exclusions are listed with their
//   coordinates and reasons in the report and the manifest and add a
//   PENDING_REVIEW publish gate.
// - Gates report PASSED only for checks that were configured and evaluated.
//   A required build gate without a configured threshold is NOT_CONFIGURED and
//   the candidate is NOT accepted (report/manifest "acceptance"); the writer
//   refuses to write it. Gates that need people or a previous version are
//   PENDING_REVIEW and keep the candidate unpublishable.

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
import {recordComparatorFor, facilityEvidenceRank} from "./evidence.mjs";
import {DatasetBuildError} from "./errors.mjs";
import {createGeometryResolver, INTEGRITY_CODES, MAX_RELATION_DEPTH, MAX_GEOMETRY_POINTS, MAX_FACILITY_EXTENT_E7} from "./integrity.mjs";
import {normalizeQualityGates} from "./quality-gates.mjs";
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
export const GENERATOR_VERSION = "0.4.0";
export const MANIFEST_SCHEMA_VERSION = "1";
export const TILE_SCHEMA_VERSION = "1";
export const REPORT_SCHEMA_VERSION = "3";
export const INTEGRITY_ERROR_LIMIT = 1000;
export const SOURCE_FORMATS = Object.freeze(["osm-json", "osm-opl"]);
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

export {DatasetBuildError};

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

// OSM tag rules: a key is 1..255 characters, a value is a string of 0..255
// characters. An EMPTY value (for example `name=`) is valid OSM data (osmium
// writes it as "key="); the client tag() treats it as absent, exactly as it
// does for the live Function. S2-a v3 wrongly treated it as malformed, which
// excluded the whole object before any safety check ran (review of v3).
function validTags(tags){
  if(tags === undefined) return true;
  if(!isPlainObject(tags)) return false;
  for(const key of Object.keys(tags)){
    const value = tags[key];
    if(key === "" || textLength(key) > MAX_TAG_TEXT_LENGTH) return false;
    if(typeof value !== "string" || textLength(value) > MAX_TAG_TEXT_LENGTH) return false;
  }
  return true;
}

// The string-valued tags of an object, even when other tags are malformed,
// so selector scope and emergency evidence can be judged BEFORE an object is
// rejected for its tags. Own data properties (any key, including "__proto__").
// null when the tags are not an object at all.
function readableTags(tags){
  if(tags === undefined) return {};
  if(!isPlainObject(tags)) return null;
  const readable = {};
  for(const key of Object.keys(tags)){
    if(typeof tags[key] === "string"){
      Object.defineProperty(readable, key, {value: tags[key], enumerable: true, writable: true, configurable: true});
    }
  }
  return readable;
}

// True when an object is in hospital selector scope with affirmative OSM
// emergency evidence, judged from its readable tags.
function hasEmergencyEvidence(element){
  const tags = isPlainObject(element) ? readableTags(element.tags) : null;
  return !!tags && facilityScope(tags).hospital && facilityEvidenceRank(tags) === 0;
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

function validateUpstream(upstream){
  if(upstream === undefined) return;
  const ok = isPlainObject(upstream) && Object.keys(upstream).every((key) => key === "url" || key === "sha256") &&
    typeof upstream.url === "string" && /^https:\/\/[^\s]{1,500}$/.test(upstream.url) &&
    typeof upstream.sha256 === "string" && SHA256_PATTERN.test(upstream.sha256);
  if(!ok) throw new DatasetBuildError("INVALID_UPSTREAM", "upstream must be {url: https URL, sha256: 64 lowercase hex}");
}

function compareLabels(a, b){
  return a < b ? -1 : a > b ? 1 : 0;
}

function gate(id, stage, status, threshold, observed){
  const entry = {id, stage, status};
  if(threshold !== undefined) entry.threshold = threshold;
  if(observed !== undefined) entry.observed = observed;
  return entry;
}

function integritySummary(unresolved){
  const byCode = {};
  for(const code of INTEGRITY_CODES) byCode[code] = 0;
  for(const item of unresolved){
    for(const problem of item.problems) byCode[problem.code] += 1;
  }
  const sorted = unresolved.slice().sort((a, b) => compareLabels(a.object, b.object));
  return {
    objectCount: unresolved.length,
    problemCountByCode: byCode,
    objects: sorted.slice(0, INTEGRITY_ERROR_LIMIT).map((item) => ({
      object: item.object,
      facilityTypes: item.facilityTypes,
      problemCount: item.problemCount,
      problems: item.problems
    })),
    truncated: sorted.length > INTEGRITY_ERROR_LIMIT
  };
}

export function buildDataset(input, options = {}){
  const {
    region, generator, dataAsOf: explicitDataAsOf, sourceLabel = "unspecified", rawInputSha256,
    sourceFormat, upstream, qualityGates
  } = options;
  validateRegion(region);
  validateGenerator(generator);
  if(sourceFormat !== undefined && !SOURCE_FORMATS.includes(sourceFormat)){
    throw new DatasetBuildError("INVALID_SOURCE_FORMAT", `sourceFormat must be one of ${SOURCE_FORMATS.join(", ")}`);
  }
  validateUpstream(upstream);
  const gates = normalizeQualityGates(qualityGates, region.regionCode);
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
  // Labels of objects present in the input but malformed: a facility that
  // references one is unresolvable, not "missing".
  const malformed = new Set();
  // Malformed objects that carry hospital emergency evidence: never dropped
  // silently; they stop the build with EMERGENCY_EVIDENCE_REJECTED.
  const emergencyMalformed = [];
  const noteMalformedEmergency = (element) => {
    if(hasEmergencyEvidence(element)){
      emergencyMalformed.push({object: elementLabel(element) || "unlabelled-object", reason: "malformed_element"});
    }
  };
  for(const element of input.elements){
    if(!validShape(element)){
      reject(rejections, "malformed_element", element);
      const label = elementLabel(element);
      if(label) malformed.add(label);
      noteMalformedEmergency(element);
      continue;
    }
    let canonical;
    try{
      canonical = canonicalJson(element);
    }catch(error){
      reject(rejections, "malformed_element", element);
      noteMalformedEmergency(element);
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
  const nodeIds = new Set();
  const ways = new Map();
  const relations = new Map();
  const byType = {node: 0, way: 0, relation: 0};
  for(const element of uniqueElements){
    byType[element.type] += 1;
    if(element.type === "node"){
      nodeIds.add(element.id);
      if(isValidLatitude(element.lat) && isValidLongitude(element.lon)){
        nodeCoordinates.set(element.id, {latE7: toE7(element.lat), lonE7: toE7(element.lon)});
      }
    }
    if(element.type === "way") ways.set(element.id, element);
    if(element.type === "relation") relations.set(element.id, element);
  }
  const resolver = createGeometryResolver({nodeCoordinates, nodeIds, ways, relations, malformed});
  const unresolved = [];
  const allowedExclusions = [];
  const emergencyRejected = [...emergencyMalformed];
  // Emergency-evidence hospitals outside the data bounds: acknowledged
  // (excluded, listed) or not (the build stops).
  const emergencyOutsideAcknowledged = [];
  const emergencyOutsideUnacknowledged = [];

  // Pass 2: selector scope, geometry, bounds and tile assignment.
  const buckets = {};
  for(const type of FACILITY_TYPES) buckets[type] = new Map();
  const accepted = {hospital: 0, pharmacy: 0, inBothTypes: 0, hospitalCoreScope: 0, hospitalExtendedOnlyScope: 0};
  const emergencyTagPresent = {hospital: 0, pharmacy: 0};
  const geometryStats = {wayFacilities: 0, relationFacilities: 0};
  let untagged = 0;
  let outOfScope = 0;
  let droppedTagEntries = 0;

  // Validation ORDER (S2-a v4): selector scope and emergency evidence are
  // judged from the readable (string-valued) tags first; then position,
  // referential integrity and data bounds are checked; malformed tags are
  // rejected LAST. So a malformed tag can never hide a facility from the
  // integrity, bounds or emergency checks: those still stop the build.
  for(const element of uniqueElements){
    const tagsValid = validTags(element.tags);
    const tags = readableTags(element.tags);
    if(tags === null){
      reject(rejections, "malformed_tags", element);
      continue;
    }
    if(tagsValid && !Object.keys(tags).length){
      untagged += 1;
      continue;
    }
    const scope = facilityScope(tags);
    if(!scope.hospital && !scope.pharmacy){
      if(tagsValid) outOfScope += 1;
      else reject(rejections, "malformed_tags", element);
      continue;
    }
    const label = `${element.type}/${element.id}`;
    const facilityTypes = FACILITY_TYPES.filter((type) => scope[type]);
    const emergencyEvidence = scope.hospital && facilityEvidenceRank(tags) === 0;
    let position;
    if(element.type === "node"){
      if(!isValidLatitude(element.lat) || !isValidLongitude(element.lon)){
        reject(rejections, "invalid_coordinates", element);
        if(emergencyEvidence) emergencyRejected.push({object: label, reason: "invalid_coordinates"});
        continue;
      }
      position = {latE7: toE7(element.lat), lonE7: toE7(element.lon)};
    }else{
      geometryStats[element.type === "way" ? "wayFacilities" : "relationFacilities"] += 1;
      position = resolver.resolve(element);
      if(position.problems){
        reject(rejections, "incomplete_geometry", element);
        const item = {object: label, facilityTypes, problemCount: position.problemCount, problems: position.problems};
        if(emergencyEvidence){
          emergencyRejected.push({object: label, reason: "incomplete_geometry", problems: position.problems});
        }else if(gates.allowIncompleteGeometry.has(label)){
          allowedExclusions.push({...item, reason: gates.allowIncompleteGeometry.get(label)});
        }else{
          unresolved.push(item);
        }
        continue;
      }
    }
    const latitude = fromE7(position.latE7);
    const longitude = fromE7(position.lonE7);
    if(!boundsContain(region.dataBounds, latitude, longitude)){
      reject(rejections, "outside_data_bounds", element);
      if(emergencyEvidence){
        const item = {object: label, reason: "outside_data_bounds", latitude, longitude};
        if(gates.acknowledgeEmergencyOutsideDataBounds.has(label)){
          emergencyOutsideAcknowledged.push({...item, acknowledgement: gates.acknowledgeEmergencyOutsideDataBounds.get(label)});
        }else{
          emergencyOutsideUnacknowledged.push(item);
        }
      }
      continue;
    }
    if(!tagsValid){
      // Facility position, integrity and bounds were fine; only its tags are
      // malformed (for example a value over 255 characters, a non-string
      // value or an empty key). Counted; with emergency evidence it stops.
      reject(rejections, "malformed_tags", element);
      if(emergencyEvidence) emergencyRejected.push({object: label, reason: "malformed_tags"});
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
        pharmacy: accepted.pharmacy,
        unresolvedGeometryObjects: unresolved.length + emergencyRejected.length
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

  // Integrity gates. Evaluated after every object was examined (and after
  // the tile size check, a hard resource limit), so a failure reports every
  // affected object at once. Nothing has been written at this point.
  if(emergencyRejected.length){
    const sorted = emergencyRejected.slice().sort((a, b) => compareLabels(a.object, b.object));
    throw new DatasetBuildError("EMERGENCY_EVIDENCE_REJECTED",
      `${sorted.length} hospital object(s) with affirmative OSM emergency evidence would be dropped (first: ${sorted[0].object}, ${sorted[0].reason}); allowances cannot exclude them`, {
        objectCount: sorted.length,
        objects: sorted.slice(0, INTEGRITY_ERROR_LIMIT),
        allowanceRefused: sorted.filter((item) => gates.allowIncompleteGeometry.has(item.object)).map((item) => item.object)
      });
  }
  if(emergencyOutsideUnacknowledged.length){
    const sorted = emergencyOutsideUnacknowledged.slice().sort((a, b) => compareLabels(a.object, b.object));
    throw new DatasetBuildError("EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS",
      `${sorted.length} hospital object(s) with affirmative OSM emergency evidence lie outside the region data bounds (first: ${sorted[0].object} at ${sorted[0].latitude},${sorted[0].longitude}); review each and list it in acknowledgeEmergencyOutsideDataBounds, or change the data bounds`, {
        objectCount: sorted.length,
        objects: sorted.slice(0, INTEGRITY_ERROR_LIMIT)
      });
  }
  const acknowledgedOutside = new Set(emergencyOutsideAcknowledged.map((item) => item.object));
  const staleAcknowledgements = [...gates.acknowledgeEmergencyOutsideDataBounds.keys()].filter((label) => !acknowledgedOutside.has(label)).sort(compareLabels);
  if(staleAcknowledgements.length){
    throw new DatasetBuildError("STALE_EMERGENCY_ACKNOWLEDGEMENT",
      `acknowledgement(s) match no emergency-evidence hospital outside the data bounds: ${staleAcknowledgements.slice(0, 20).join(", ")}`,
      {objects: staleAcknowledgements.slice(0, INTEGRITY_ERROR_LIMIT), objectCount: staleAcknowledgements.length});
  }
  if(unresolved.length){
    const summary = integritySummary(unresolved);
    const first = summary.objects[0];
    throw new DatasetBuildError("REFERENTIAL_INTEGRITY_FAILED",
      `${unresolved.length} facility object(s) reference geometry that does not resolve (first: ${first.object} ${first.problems[0].code} ${first.problems[0].missingType}/${first.problems[0].missingRef}); nothing was built`,
      {...summary, allowedExclusionCount: allowedExclusions.length});
  }
  const matchedAllowances = new Set(allowedExclusions.map((item) => item.object));
  const staleAllowances = [...gates.allowIncompleteGeometry.keys()].filter((label) => !matchedAllowances.has(label)).sort(compareLabels);
  if(staleAllowances.length){
    throw new DatasetBuildError("STALE_GEOMETRY_ALLOWANCE",
      `allowance(s) match no facility with unresolved geometry: ${staleAllowances.slice(0, 20).join(", ")}`,
      {objects: staleAllowances.slice(0, INTEGRITY_ERROR_LIMIT), objectCount: staleAllowances.length});
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

  const acceptedObjectCount = accepted.hospital + accepted.pharmacy - accepted.inBothTypes;
  const rejectedRatio = rejectedTotal + acceptedObjectCount === 0 ? 0 : rejectedTotal / (rejectedTotal + acceptedObjectCount);
  let rejectedRatioStatus = "NOT_CONFIGURED";
  if(gates.maxRejectedRatio !== null){
    rejectedRatioStatus = rejectedRatio <= gates.maxRejectedRatio ? "PASSED" : "FAILED";
  }
  const maxTileBytes = Math.max(tileStats(tiles.hospital).maxBytes, tileStats(tiles.pharmacy).maxBytes);
  const gateTable = [
    gate("non_empty_hospital", "build", "PASSED", {minAccepted: 1}, accepted.hospital),
    gate("non_empty_pharmacy", "build", "PASSED", {minAccepted: 1}, accepted.pharmacy),
    gate("referential_integrity", "build", "PASSED", {maxUnresolvedObjects: 0, allowanceRequired: "explicit per object"},
      {unresolvedObjects: 0, allowedExclusions: allowedExclusions.length}),
    gate("emergency_evidence_preserved", "build", "PASSED",
      {maxSilentlyDroppedObjects: 0, outsideDataBoundsRequires: "explicit per-object acknowledgement"},
      {silentlyDropped: 0, acknowledgedOutsideDataBounds: emergencyOutsideAcknowledged.length}),
    gate("max_rejected_ratio", "build", rejectedRatioStatus,
      gates.maxRejectedRatio === null ? null : gates.maxRejectedRatio,
      {rejected: rejectedTotal, acceptedObjects: acceptedObjectCount, ratio: Number(rejectedRatio.toFixed(6))}),
    gate("tile_max_bytes", "build", "PASSED", region.tileMaxBytes, maxTileBytes),
    gate("tile_membership", "build", "PASSED", "every element inside its tile", "checked per element"),
    gate("data_bounds", "build", "PASSED", region.dataBounds, {outsideRejected: rejections.outside_data_bounds.count}),
    gate("service_area_review", "publish", "PENDING_REVIEW", "authoritative boundary check", region.serviceAreaStatus || "unspecified"),
    gate("count_delta_vs_previous_version", "publish", "PENDING_REVIEW", "needs the previously published version"),
    gate("known_facility_sample", "publish", "PENDING_REVIEW", "needs a human sample review"),
    gate("nonmedical_contamination_sample", "publish", "PENDING_REVIEW", "needs a human sample review")
  ];
  if(emergencyOutsideAcknowledged.length){
    gateTable.push(gate("emergency_evidence_exclusions_review", "publish", "PENDING_REVIEW",
      "every excluded emergency-evidence object reviewed before publishing", {excludedObjects: emergencyOutsideAcknowledged.length}));
  }
  if(rejectedRatioStatus === "FAILED"){
    throw new DatasetBuildError("QUALITY_GATE_FAILED",
      `rejected ratio ${rejectedRatio.toFixed(6)} exceeds maxRejectedRatio ${gates.maxRejectedRatio}`, {gates: gateTable});
  }
  const buildGates = gateTable.filter((entry) => entry.stage === "build");
  const notConfigured = buildGates.filter((entry) => entry.status === "NOT_CONFIGURED").map((entry) => entry.id);
  const emergencyEvidenceExclusions = {
    count: emergencyOutsideAcknowledged.length,
    objects: emergencyOutsideAcknowledged.slice().sort((a, b) => compareLabels(a.object, b.object)).slice(0, INTEGRITY_ERROR_LIMIT)
  };
  const acceptance = {
    status: notConfigured.length ? "NOT_ACCEPTED" : "BUILD_GATES_PASSED",
    notConfigured,
    emergencyEvidenceExclusions: emergencyEvidenceExclusions.count,
    pendingReview: gateTable.filter((entry) => entry.status === "PENDING_REVIEW").map((entry) => entry.id),
    publishable: false,
    note: "BUILD_GATES_PASSED means every automated build gate was configured and passed. Publishing additionally needs every PENDING_REVIEW gate; this generator never marks a dataset publishable."
  };

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
    geometry: {
      ...geometryStats,
      duplicateMemberReferences: resolver.stats.duplicateMemberReferences,
      maxRelationDepthSeen: resolver.stats.maxRelationDepth,
      limits: {maxRelationDepth: MAX_RELATION_DEPTH, maxGeometryPoints: MAX_GEOMETRY_POINTS, maxFacilityExtentE7: MAX_FACILITY_EXTENT_E7}
    },
    integrity: {
      policy: "fail-closed: every facility way/relation must resolve every referenced node, way and relation; only objects listed in allowIncompleteGeometry (with a reason) may be excluded instead of stopping the build; objects with OSM emergency evidence are never excluded",
      unresolvedObjectCount: 0,
      allowedExclusionCount: allowedExclusions.length,
      allowedExclusions: allowedExclusions.slice().sort((a, b) => compareLabels(a.object, b.object)).slice(0, INTEGRITY_ERROR_LIMIT)
    },
    emergencyEvidenceExclusions: {
      policy: "hospital objects with affirmative OSM emergency evidence are excluded only when outside the data bounds AND acknowledged per object in the quality-gates file; every such exclusion is listed here and in the manifest and adds a PENDING_REVIEW publish gate",
      ...emergencyEvidenceExclusions
    },
    clientCollapse: {
      scope: "hospital records only; potential, before client category filters",
      ...analyzeClientCollapse([...buckets.hospital.values()].flat(), REJECTED_SAMPLE_LIMIT)
    },
    tiles: {
      tileMaxBytesLimit: region.tileMaxBytes,
      hospital: tileStats(tiles.hospital),
      pharmacy: tileStats(tiles.pharmacy)
    },
    qualityGates: {configured: gates.configured, description: gates.description},
    gates: gateTable,
    acceptance
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
  if(sourceFormat) source.format = sourceFormat;
  if(upstream) source.upstream = {url: upstream.url, sha256: upstream.sha256};

  const manifest = {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetVersionId,
    status: "candidate",
    acceptance: {status: acceptance.status, notConfigured: acceptance.notConfigured, pendingReview: acceptance.pendingReview, publishable: false},
    emergencyEvidenceExclusions,
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
