// Validation-report helper: finds hospital records that the EXISTING client
// pipeline (src/app/legacy-app.js) will collapse into one whenever both are
// returned, and classifies mixed-evidence pairs. Used only for reporting;
// it never removes or edits records. A contract test compares these keys with
// the real client functions.
//
// Client collapse points mirrored here:
//   map:       mapOverpass keeps the first record per display name plus
//              5-decimal coordinates (input order decides).
//   coord:     finalizeFacilityResults keeps the first record per 5-decimal
//              coordinates, after a stable distance sort.
//   namecoord: same, per normalized display name plus 4-decimal coordinates.
//
// A mixed-evidence pair is "resolved by ordering" when evidence-first order
// always makes the stronger record survive: the pair shares the map key, or
// both records have identical coordinates (equal distance from any search
// point). Otherwise it is "distance dependent": the client keeps whichever
// record is closer to the search point, which S1 cannot change.

import {facilityEvidenceRank} from "./evidence.mjs";

const UNNAMED_HOSPITAL = "이름 확인 필요 병원·의원";

function firstTag(tags, keys){
  for(const key of keys){
    if(tags && tags[key]) return tags[key];
  }
  return "";
}

function recordPoint(record){
  return record.type === "node" ? record : record.center;
}

// Same as the client display name for hospital searches.
export function clientDisplayName(tags){
  return (firstTag(tags, ["name:ko", "name:en", "name"]) || "").trim() || UNNAMED_HOSPITAL;
}

// Same as the client normalizedFacilityName().
function normalizedName(value){
  return String(value || "").toLowerCase().replace(/[\s·.,()\-_/]/g, "");
}

export function clientCollapseKeys(record){
  const point = recordPoint(record);
  const latitude = Number(point.lat);
  const longitude = Number(point.lon);
  const displayName = clientDisplayName(record.tags);
  const keys = [
    `map:${displayName}-${latitude.toFixed(5)}-${longitude.toFixed(5)}`,
    `coord:${latitude.toFixed(5)}:${longitude.toFixed(5)}`
  ];
  const name = normalizedName(displayName);
  if(name) keys.push(`namecoord:${name}:${latitude.toFixed(4)}:${longitude.toFixed(4)}`);
  return keys;
}

function label(record){
  return `${record.type}/${record.id}`;
}

export function analyzeClientCollapse(records, sampleLimit){
  const byKey = new Map();
  for(const record of records){
    for(const key of clientCollapseKeys(record)){
      if(!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(record);
    }
  }
  // Union-find over records that share any key.
  const parent = new Map(records.map((record) => [label(record), label(record)]));
  const find = (item) => {
    while(parent.get(item) !== item){
      parent.set(item, parent.get(parent.get(item)));
      item = parent.get(item);
    }
    return item;
  };
  for(const group of byKey.values()){
    for(let index = 1; index < group.length; index += 1){
      const a = find(label(group[0]));
      const b = find(label(group[index]));
      if(a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const groups = new Map();
  for(const record of records){
    const root = find(label(record));
    if(!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }

  let groupCount = 0;
  let mixedEvidenceGroups = 0;
  let resolvedPairs = 0;
  const distanceDependent = [];
  for(const group of groups.values()){
    if(group.length < 2) continue;
    groupCount += 1;
    const ranks = new Set(group.map((record) => facilityEvidenceRank(record.tags)));
    if(ranks.size > 1) mixedEvidenceGroups += 1;
    for(let i = 0; i < group.length; i += 1){
      for(let j = i + 1; j < group.length; j += 1){
        const a = group[i];
        const b = group[j];
        if(facilityEvidenceRank(a.tags) === facilityEvidenceRank(b.tags)) continue;
        const keysA = clientCollapseKeys(a);
        const keysB = new Set(clientCollapseKeys(b));
        const shared = keysA.filter((key) => keysB.has(key));
        if(!shared.length) continue;
        const pointA = recordPoint(a);
        const pointB = recordPoint(b);
        const identical = pointA.lat === pointB.lat && pointA.lon === pointB.lon;
        if(identical || shared.some((key) => key.startsWith("map:"))) resolvedPairs += 1;
        else distanceDependent.push([label(a), label(b)].sort().join("+"));
      }
    }
  }
  distanceDependent.sort();
  return {
    collapseGroupCount: groupCount,
    mixedEvidenceGroupCount: mixedEvidenceGroups,
    mixedEvidencePairsResolvedByOrdering: resolvedPairs,
    mixedEvidencePairsDistanceDependent: distanceDependent.length,
    distanceDependentSample: distanceDependent.slice(0, sampleLimit)
  };
}
