// Reader-side helpers that define how a consumer must combine tiles before
// handing elements to the existing client pipeline (mapOverpass ->
// finalizeFacilityResults). Not wired into the app in S1; the S3 client port
// must keep these semantics and the same test vectors.

import {canonicalJsonBytes, sha256Hex} from "./canonical-json.mjs";
import {haversineMeters} from "./geo.mjs";
import {recordComparatorFor} from "./evidence.mjs";

// True when the tile document re-serializes to the exact bytes listed in the
// manifest. A mismatch must be treated as "dataset unavailable" (fallback).
export function tileMatchesChecksum(tileDocument, expectedSha256){
  try{
    return sha256Hex(canonicalJsonBytes(tileDocument)) === expectedSha256;
  }catch(error){
    return false;
  }
}

// Concatenates tiles of ONE facility type, drops repeated objects and orders
// them across ALL tiles (a node and a way of one facility can sit in
// neighbouring tiles) with that type's comparator, the same one the generator
// uses inside each tile: hospital evidence-first, pharmacy Overpass order.
// Output order never depends on tile or input order. Mixing facility types
// is refused.
export function mergeTileElements(tileDocuments, facilityType){
  const compare = recordComparatorFor(facilityType);
  const seen = new Set();
  const merged = [];
  for(const tile of tileDocuments){
    if(tile && tile.facilityType !== undefined && tile.facilityType !== facilityType){
      throw new TypeError(`Tile ${tile.tileId} is ${tile.facilityType}, not ${facilityType}`);
    }
    for(const element of (tile && Array.isArray(tile.elements)) ? tile.elements : []){
      const identity = `${element.type}/${element.id}`;
      if(seen.has(identity)) continue;
      seen.add(identity);
      merged.push(element);
    }
  }
  return merged.sort(compare);
}

function elementPoint(element){
  return element.type === "node" ? element : element.center;
}

// Keeps elements whose point (node position or way/relation center) is within
// radiusMeters. Note: Overpass "around" also matches a way or relation whose
// outline (not center) reaches the radius; the static path uses the center.
export function elementsWithinRadius(elements, latitude, longitude, radiusMeters){
  return elements.filter((element) => {
    const point = elementPoint(element);
    return haversineMeters(latitude, longitude, point.lat, point.lon) <= radiusMeters;
  });
}
