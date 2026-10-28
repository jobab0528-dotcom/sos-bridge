// Coordinate validation, fixed lat/lon tile grid, search-tile lookup and
// coordinate-based dataset selection for the static facility dataset.
//
// Coordinates are handled as integer 1e-7 degree units (OSM precision) for
// tile assignment, so tile membership never depends on floating point
// rounding. Tiles are half-open cells: [south, north) x [west, east).

export const E7 = 10000000;
const LAT_OFFSET_E7 = 90 * E7;
const LON_OFFSET_E7 = 180 * E7;
// Smaller than any Earth radius, so degree spans derived from it over-cover.
const CONSERVATIVE_EARTH_RADIUS_METERS = 6356000;
const HAVERSINE_EARTH_RADIUS_METERS = 6371000;
const TILE_SEARCH_MARGIN_DEGREES = 0.000001;

export function isValidLatitude(value){
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value){
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function toE7(degrees){
  return Math.round(degrees * E7);
}

export function fromE7(valueE7){
  return valueE7 / E7;
}

function assertGrid(grid){
  if(!grid || !Number.isSafeInteger(grid.tileSizeE7) || grid.tileSizeE7 <= 0 ||
    (180 * E7) % grid.tileSizeE7 !== 0 || (360 * E7) % grid.tileSizeE7 !== 0){
    throw new RangeError("grid.tileSizeE7 must be a positive integer that divides 180 and 360 degrees");
  }
}

function latIndexE7(latE7, grid){
  const maxIndex = (180 * E7) / grid.tileSizeE7 - 1;
  return Math.min(Math.floor((latE7 + LAT_OFFSET_E7) / grid.tileSizeE7), maxIndex);
}

function lonIndexE7(lonE7, grid){
  const maxIndex = (360 * E7) / grid.tileSizeE7 - 1;
  return Math.min(Math.floor((lonE7 + LON_OFFSET_E7) / grid.tileSizeE7), maxIndex);
}

export function tileIdForE7(latE7, lonE7, grid){
  assertGrid(grid);
  return `${latIndexE7(latE7, grid)}_${lonIndexE7(lonE7, grid)}`;
}

export function tileIdFor(latitude, longitude, grid){
  if(!isValidLatitude(latitude) || !isValidLongitude(longitude)) throw new RangeError("Invalid coordinates");
  return tileIdForE7(toE7(latitude), toE7(longitude), grid);
}

export function parseTileId(tileId){
  const match = /^(\d+)_(\d+)$/.exec(String(tileId));
  if(!match) throw new RangeError(`Invalid tile id: ${tileId}`);
  return {latIndex: Number(match[1]), lonIndex: Number(match[2])};
}

export function tileBounds(tileId, grid){
  assertGrid(grid);
  const {latIndex, lonIndex} = parseTileId(tileId);
  const southE7 = latIndex * grid.tileSizeE7 - LAT_OFFSET_E7;
  const westE7 = lonIndex * grid.tileSizeE7 - LON_OFFSET_E7;
  return {
    south: fromE7(southE7),
    west: fromE7(westE7),
    north: fromE7(southE7 + grid.tileSizeE7),
    east: fromE7(westE7 + grid.tileSizeE7)
  };
}

// Half-open membership test in integer units ([south, north) x [west, east)),
// with the grid's last row/column closed at +90 / +180.
export function tileContainsE7(tileId, latE7, lonE7, grid){
  return tileIdForE7(latE7, lonE7, grid) === tileId;
}

export function haversineMeters(lat1, lon1, lat2, lon2){
  const rad = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * HAVERSINE_EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Conservative lat/lon box that contains every point within radiusMeters.
// Returns null when the box would cross a pole or the antimeridian (not
// supported by this grid lookup; callers must fall back to the live search).
export function searchBox(latitude, longitude, radiusMeters){
  if(!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  if(typeof radiusMeters !== "number" || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return null;
  const dLat = (radiusMeters / CONSERVATIVE_EARTH_RADIUS_METERS) * (180 / Math.PI) + TILE_SEARCH_MARGIN_DEGREES;
  const south = latitude - dLat;
  const north = latitude + dLat;
  if(south <= -90 || north >= 90) return null;
  const extremeLat = Math.max(Math.abs(south), Math.abs(north));
  const dLon = dLat / Math.cos(extremeLat * Math.PI / 180) + TILE_SEARCH_MARGIN_DEGREES;
  const west = longitude - dLon;
  const east = longitude + dLon;
  if(west < -180 || east > 180) return null;
  return {south, west, north, east};
}

// Every tile that may hold a point within radiusMeters of the search point,
// sorted. Returns null when searchBox is not supported for this point.
export function tileIdsForSearch(latitude, longitude, radiusMeters, grid){
  assertGrid(grid);
  const box = searchBox(latitude, longitude, radiusMeters);
  if(!box) return null;
  const southIndex = latIndexE7(toE7(box.south), grid);
  const northIndex = latIndexE7(toE7(box.north), grid);
  const westIndex = lonIndexE7(toE7(box.west), grid);
  const eastIndex = lonIndexE7(toE7(box.east), grid);
  const ids = [];
  for(let latIndex = southIndex; latIndex <= northIndex; latIndex += 1){
    for(let lonIndex = westIndex; lonIndex <= eastIndex; lonIndex += 1){
      ids.push(`${latIndex}_${lonIndex}`);
    }
  }
  return ids.sort();
}

export function boundsContain(bounds, latitude, longitude){
  return latitude >= bounds.south && latitude <= bounds.north &&
    longitude >= bounds.west && longitude <= bounds.east;
}

function onSegment(lat, lon, a, b){
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const cross = (lon - lon1) * (lat2 - lat1) - (lat - lat1) * (lon2 - lon1);
  if(Math.abs(cross) > 1e-12) return false;
  return lat >= Math.min(lat1, lat2) && lat <= Math.max(lat1, lat2) &&
    lon >= Math.min(lon1, lon2) && lon <= Math.max(lon1, lon2);
}

// Ring as [[lat, lon], ...] (closing vertex optional). Points on an edge or
// vertex count as outside, so boundary ambiguity always falls back.
export function pointInRing(latitude, longitude, ring){
  let inside = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1){
    if(onSegment(latitude, longitude, ring[j], ring[i])) return false;
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];
    if((latI > latitude) !== (latJ > latitude)){
      const lonAtLat = lonJ + (latitude - latJ) * (lonI - lonJ) / (latI - latJ);
      if(longitude < lonAtLat) inside = !inside;
    }
  }
  return inside;
}

export function pointInServiceArea(latitude, longitude, serviceArea){
  if(!serviceArea || !Array.isArray(serviceArea.ringsLatLon)) return false;
  return serviceArea.ringsLatLon.some((ring) => pointInRing(latitude, longitude, ring));
}

// Chooses the static dataset for a search from the SEARCH COORDINATES ONLY.
// There is deliberately no country parameter: the traveler's selected country
// must not decide which dataset is used. Returns the single registry entry
// whose serviceArea contains the point and whose dataBounds contain the whole
// search box; otherwise null, meaning "use the existing live Function".
export function selectDatasetForSearch(latitude, longitude, radiusMeters, registry){
  if(!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  if(!Array.isArray(registry)) return null;
  const box = searchBox(latitude, longitude, radiusMeters);
  if(!box) return null;
  const matches = registry.filter((entry) => {
    if(!entry || !entry.coverage) return false;
    const {serviceArea, dataBounds, maxSearchRadiusMeters} = entry.coverage;
    if(typeof maxSearchRadiusMeters !== "number" || radiusMeters > maxSearchRadiusMeters) return false;
    if(!dataBounds || !pointInServiceArea(latitude, longitude, serviceArea)) return false;
    return boundsContain(dataBounds, box.south, box.west) && boundsContain(dataBounds, box.north, box.east);
  });
  return matches.length === 1 ? matches[0] : null;
}
