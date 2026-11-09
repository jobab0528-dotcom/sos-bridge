// Geometry integrity for facility objects (fail-closed).
//
// A way or relation facility is placed at the bounding-box center of ALL the
// geometry it references. That center is only meaningful when every
// reference resolves: a center computed from part of the members can be
// kilometres off (a hospital relation whose missing sub-relation holds the
// main building, a way whose missing node is the far corner). So:
//
// - every referenced node must exist and carry valid coordinates;
// - every referenced way must exist, and all of ITS nodes must resolve;
// - every referenced relation must exist and resolve recursively;
// - a relation that (directly or through others) contains itself, nests more
//   than MAX_RELATION_DEPTH levels, has no members, or expands to more than
//   MAX_GEOMETRY_POINTS points is not resolvable;
// - a referenced object that was present but malformed (rejected in pass 1)
//   counts as unresolvable, never as "skipped";
// - a resolved outline wider or taller than MAX_FACILITY_EXTENT_E7 is
//   refused: no single facility spans that, so the outline (or a member) is
//   wrong and its center would misplace the facility.
//
// Any problem makes the facility UNRESOLVED. The generator then stops the
// build (REFERENTIAL_INTEGRITY_FAILED) unless that exact object is listed in
// an explicit allowance with a written reason (quality-gates file
// allowIncompleteGeometry). Allowed objects are still excluded from the
// tiles; they are never placed approximately. Repeated references to the same
// member inside one relation (legal in OSM, for example a route that uses a
// way twice) do not change a bounding box; they are visited once and counted.

export const MAX_RELATION_DEPTH = 8;
export const MAX_GEOMETRY_POINTS = 100000;
// 0.05 degrees: about 5.5 km north-south, about 4.4 km east-west at 37°N.
export const MAX_FACILITY_EXTENT_E7 = 500000;
export const MAX_PROBLEMS_PER_OBJECT = 20;

export const INTEGRITY_CODES = Object.freeze([
  "MISSING_NODE",
  "NODE_WITHOUT_VALID_LOCATION",
  "MISSING_WAY",
  "MISSING_RELATION",
  "MALFORMED_REFERENCED_OBJECT",
  "RELATION_CYCLE",
  "RELATION_DEPTH_EXCEEDED",
  "EMPTY_RELATION",
  "GEOMETRY_TOO_LARGE",
  "GEOMETRY_EXTENT_TOO_LARGE"
]);

class Budget{
  constructor(){ this.points = 0; this.exceeded = false; }
  take(count){
    this.points += count;
    if(this.points > MAX_GEOMETRY_POINTS) this.exceeded = true;
    return !this.exceeded;
  }
}

function emptyBox(){
  return {minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity, points: 0};
}

function extend(box, point){
  if(point.latE7 < box.minLat) box.minLat = point.latE7;
  if(point.latE7 > box.maxLat) box.maxLat = point.latE7;
  if(point.lonE7 < box.minLon) box.minLon = point.lonE7;
  if(point.lonE7 > box.maxLon) box.maxLon = point.lonE7;
  box.points += 1;
}

// index: {nodeCoordinates: Map<id, {latE7, lonE7}>, nodeIds: Set<id>,
//         ways: Map<id, way>, relations: Map<id, relation>,
//         malformed: Set<"type/id">}
export function createGeometryResolver(index){
  const stats = {duplicateMemberReferences: 0, maxRelationDepth: 0};

  function nodeProblem(ref, via){
    if(index.malformed.has(`node/${ref}`)) return {code: "MALFORMED_REFERENCED_OBJECT", missingType: "node", missingRef: ref, via};
    if(index.nodeIds.has(ref)) return {code: "NODE_WITHOUT_VALID_LOCATION", missingType: "node", missingRef: ref, via};
    return {code: "MISSING_NODE", missingType: "node", missingRef: ref, via};
  }

  function addWay(way, box, problems, via, budget){
    if(!budget.take(way.nodes.length)) return;
    for(const ref of way.nodes){
      const point = index.nodeCoordinates.get(ref);
      if(point) extend(box, point);
      else problems.push(nodeProblem(ref, via));
    }
  }

  function addRelation(relation, box, problems, path, budget){
    const depth = path.length - 1;
    if(depth > stats.maxRelationDepth) stats.maxRelationDepth = depth;
    if(depth > MAX_RELATION_DEPTH){
      problems.push({code: "RELATION_DEPTH_EXCEEDED", missingType: "relation", missingRef: relation.id, via: path.slice()});
      return;
    }
    if(!relation.members.length){
      problems.push({code: "EMPTY_RELATION", missingType: "relation", missingRef: relation.id, via: path.slice()});
      return;
    }
    const seen = new Set();
    for(const member of relation.members){
      if(budget.exceeded || problems.length >= MAX_PROBLEMS_PER_OBJECT) return;
      const key = `${member.type}/${member.ref}`;
      if(seen.has(key)){
        stats.duplicateMemberReferences += 1;
        continue;
      }
      seen.add(key);
      if(member.type === "node"){
        if(!budget.take(1)) return;
        const point = index.nodeCoordinates.get(member.ref);
        if(point) extend(box, point);
        else problems.push(nodeProblem(member.ref, path.slice()));
      }else if(member.type === "way"){
        const way = index.ways.get(member.ref);
        if(way) addWay(way, box, problems, [...path, `way/${member.ref}`], budget);
        else problems.push({
          code: index.malformed.has(key) ? "MALFORMED_REFERENCED_OBJECT" : "MISSING_WAY",
          missingType: "way", missingRef: member.ref, via: path.slice()
        });
      }else{
        if(path.includes(key)){
          problems.push({code: "RELATION_CYCLE", missingType: "relation", missingRef: member.ref, via: [...path, key]});
          continue;
        }
        const child = index.relations.get(member.ref);
        if(child) addRelation(child, box, problems, [...path, key], budget);
        else problems.push({
          code: index.malformed.has(key) ? "MALFORMED_REFERENCED_OBJECT" : "MISSING_RELATION",
          missingType: "relation", missingRef: member.ref, via: path.slice()
        });
      }
    }
  }

  // Returns {latE7, lonE7} (bounding-box center, as Overpass "out center"
  // reports it) or {problems: [...]} for a way or relation facility.
  function resolve(element){
    const label = `${element.type}/${element.id}`;
    const box = emptyBox();
    const problems = [];
    const budget = new Budget();
    if(element.type === "way") addWay(element, box, problems, [label], budget);
    else addRelation(element, box, problems, [label], budget);
    if(budget.exceeded){
      problems.unshift({code: "GEOMETRY_TOO_LARGE", missingType: element.type, missingRef: element.id, via: [label]});
    }
    if(problems.length) return {problems: problems.slice(0, MAX_PROBLEMS_PER_OBJECT), problemCount: problems.length};
    if(!box.points){
      return {problems: [{code: "EMPTY_RELATION", missingType: element.type, missingRef: element.id, via: [label]}], problemCount: 1};
    }
    if(box.maxLat - box.minLat > MAX_FACILITY_EXTENT_E7 || box.maxLon - box.minLon > MAX_FACILITY_EXTENT_E7){
      return {problems: [{
        code: "GEOMETRY_EXTENT_TOO_LARGE", missingType: element.type, missingRef: element.id, via: [label],
        extentE7: {lat: box.maxLat - box.minLat, lon: box.maxLon - box.minLon}
      }], problemCount: 1};
    }
    return {latE7: Math.round((box.minLat + box.maxLat) / 2), lonE7: Math.round((box.minLon + box.maxLon) / 2)};
  }

  return {resolve, stats};
}
