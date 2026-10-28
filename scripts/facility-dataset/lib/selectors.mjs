// Mirror of the Overpass tag selectors in netlify/functions/nearby-facilities.js
// (buildHospitalCoreQuery, buildHospitalExtendedQuery, buildOverpassQuery for
// pharmacy). The static dataset must contain exactly the objects the live
// Function would return for the same area, so the client keeps one
// classification pipeline (mapOverpass, finalizeFacilityResults) for both
// sources. A contract test fails if these drift from the Function source.
//
// Overpass semantics reproduced here:
// - ["key"~"a|b"]  : the key exists and the value matches the regular
//   expression anywhere (unanchored, case-sensitive).
// - ["key"="v"]    : the key exists and the value equals v exactly.

export const FACILITY_TYPES = Object.freeze(["hospital", "pharmacy"]);

export const HOSPITAL_CORE_SELECTORS = Object.freeze([
  Object.freeze({key: "amenity", operator: "~", value: "hospital|clinic|doctors|doctor"}),
  Object.freeze({key: "healthcare", operator: "~", value: "hospital|clinic|doctor|doctors"})
]);

export const HOSPITAL_EXTENDED_SELECTORS = Object.freeze([
  Object.freeze({key: "healthcare", operator: "~", value: "centre|center|yes"})
]);

export const PHARMACY_SELECTORS = Object.freeze([
  Object.freeze({key: "amenity", operator: "=", value: "pharmacy"}),
  Object.freeze({key: "healthcare", operator: "=", value: "pharmacy"})
]);

// Every OSM tag key read by the client facility pipeline in
// src/app/legacy-app.js (classification, non-medical filters, emergency
// metadata and tiers, deduplication aliases, address, phone, hours). Tags not
// listed here are dropped from tiles; a contract test fails if the client
// starts reading a key that is not preserved.
export const PRESERVED_TAG_KEYS = Object.freeze([
  "addr:city",
  "addr:county",
  "addr:district",
  "addr:full",
  "addr:full:ko",
  "addr:housenumber",
  "addr:province",
  "addr:street",
  "addr:suburb",
  "amenity",
  "contact:phone",
  "craft",
  "description",
  "emergency",
  "emergency:department",
  "emergency_ward",
  "emergency_ward_entrance",
  "healthcare",
  "healthcare:emergency",
  "healthcare:speciality",
  "industrial",
  "leisure",
  "medical_system:specialty",
  "name",
  "name:en",
  "name:ko",
  "office",
  "opening_hours",
  "operator",
  "phone",
  "shop",
  "speciality",
  "tourism"
]);

const PRESERVED_TAG_KEY_SET = new Set(PRESERVED_TAG_KEYS);
const compiledPatterns = new Map();

function patternFor(value){
  if(!compiledPatterns.has(value)) compiledPatterns.set(value, new RegExp(value));
  return compiledPatterns.get(value);
}

export function matchesSelector(tags, selector){
  if(!Object.prototype.hasOwnProperty.call(tags, selector.key)) return false;
  const value = tags[selector.key];
  if(typeof value !== "string") return false;
  if(selector.operator === "=") return value === selector.value;
  return patternFor(selector.value).test(value);
}

function matchesAny(tags, selectors){
  return selectors.some((selector) => matchesSelector(tags, selector));
}

// Returns which facility types (and hospital query scope) an object belongs to.
export function facilityScope(tags){
  const hospitalCore = matchesAny(tags, HOSPITAL_CORE_SELECTORS);
  const hospitalExtended = matchesAny(tags, HOSPITAL_EXTENDED_SELECTORS);
  const pharmacy = matchesAny(tags, PHARMACY_SELECTORS);
  return {
    hospital: hospitalCore || hospitalExtended,
    hospitalCore,
    hospitalExtended,
    pharmacy
  };
}

export function preservedTags(tags){
  const kept = {};
  let dropped = 0;
  for(const key of Object.keys(tags)){
    if(PRESERVED_TAG_KEY_SET.has(key)) kept[key] = tags[key];
    else dropped += 1;
  }
  return {tags: kept, dropped};
}
