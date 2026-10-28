// Record ordering policy for static facility tiles, per facility type.
//
// HOSPITAL tiles: evidence first (this file's rank), then OSM type and id.
// PHARMACY tiles: OSM type, then id (Overpass response order), exactly as the
// live Function returns pharmacy results and as S1 v1 stored them. Emergency
// evidence is irrelevant to a pharmacy search, and ranking an object that is
// tagged both as a pharmacy and as an emergency hospital ahead of a plain
// pharmacy record of the same place made the client keep the wrong record
// (different id, phone, opening hours and emergency fields).
//
// Hospital rationale:
// Why: the client pipeline (src/app/legacy-app.js) collapses records in two
// places where INPUT ORDER decides the survivor:
//   - mapOverpass keeps the first record per (display name, 5-decimal
//     coordinates), before any distance sorting;
//   - finalizeFacilityResults sorts by distance (stable) and then keeps the
//     first record per dedupe key (OSM id, 5-decimal coordinates, or name plus
//     4-decimal coordinates), so records at an equal distance keep input order.
// If a plain clinic record came first, a hospital record carrying OSM
// emergency evidence for the same place was silently dropped. Ordering the
// records by evidence first makes the stronger record win every
// order-dependent collapse, without changing or adding any tag.
//
// facilityEvidenceRank mirrors the client's facilityEmergencyTier for the
// tiers that express evidence (0 = hospital with affirmative OSM emergency
// evidence, 1 = other hospital, 2 = everything else, including a hospital
// explicitly tagged without emergency care). The client's narrow-specialty
// tier 3 is not reproduced: in emergency mode the client removes tier-3
// records before deduplication, so they never displace another record there.
// A contract test compares this function with the real client functions.
// The rank only orders records; it is never stored and never shown.

const TYPE_ORDER = Object.freeze({node: 0, way: 1, relation: 2});

const AFFIRMATIVE_EMERGENCY_TOKENS = new Set([
  "yes", "true", "designated", "official", "main", "24_7",
  "emergency", "emergency_department", "emergency_ward", "emergency_medicine", "emergency_medical_services"
]);
const NEGATIVE_EMERGENCY_TOKENS = new Set(["no", "false", "none"]);
const EMERGENCY_SPECIALTY_TOKENS = new Set(["emergency", "emergency_medicine", "emergency_medical_services"]);

// Same lookup as the client tag(): first listed key with a truthy value.
function firstTag(tags, keys){
  for(const key of keys){
    if(tags && tags[key]) return tags[key];
  }
  return "";
}

// Same normalization as the client normalizedOsmTagTokens().
function tokens(value){
  return String(value || "")
    .toLowerCase()
    .split(/[;,|]/)
    .map((item) => item.trim().replace(/[\s/-]+/g, "_"))
    .filter(Boolean);
}

export function facilityEvidenceRank(tags){
  const safeTags = tags && typeof tags === "object" ? tags : {};
  const amenity = String(firstTag(safeTags, ["amenity"]) || "").toLowerCase();
  const healthcare = String(firstTag(safeTags, ["healthcare"]) || "").toLowerCase();
  const isHospital = amenity === "hospital" || healthcare === "hospital";
  if(!isHospital) return 2;
  const structured = tokens([
    String(firstTag(safeTags, ["emergency"]) || "").trim(),
    String(firstTag(safeTags, ["emergency:department", "healthcare:emergency"]) || "").trim(),
    String(firstTag(safeTags, ["emergency_ward", "emergency_ward_entrance"]) || "").trim()
  ].filter(Boolean).join(";"));
  const specialty = tokens(firstTag(safeTags, ["healthcare:speciality", "speciality", "medical_system:specialty"]));
  if(structured.some((token) => AFFIRMATIVE_EMERGENCY_TOKENS.has(token)) ||
    specialty.some((token) => EMERGENCY_SPECIALTY_TOKENS.has(token))){
    return 0;
  }
  const explicitNo = structured.length > 0 && structured.every((token) => NEGATIVE_EMERGENCY_TOKENS.has(token));
  return explicitNo ? 2 : 1;
}

// Overpass response order: nodes, ways, relations; ascending id.
export function compareOverpassOrder(a, b){
  return (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.id - b.id);
}

// Hospital order: evidence rank, then Overpass order. Deterministic: it does
// not depend on input order, tile order or tag key order.
export function compareFacilityRecords(a, b){
  return (facilityEvidenceRank(a.tags) - facilityEvidenceRank(b.tags)) || compareOverpassOrder(a, b);
}

// The single source of the per-type policy, used by the generator (inside
// each tile) and by mergeTileElements (across tiles).
export function recordComparatorFor(facilityType){
  if(facilityType === "hospital") return compareFacilityRecords;
  if(facilityType === "pharmacy") return compareOverpassOrder;
  throw new TypeError(`Unknown facility type: ${facilityType}`);
}
