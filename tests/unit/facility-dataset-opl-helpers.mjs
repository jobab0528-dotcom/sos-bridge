// Test-only OPL WRITER (not a test file: the npm test glob runs *.test.mjs).
// Written separately from the reader in scripts/facility-dataset/lib/opl.mjs
// so the two check each other. It follows the libosmium 2.23.1 writer
// (include/osmium/io/detail/opl_output_format.hpp and string_util.hpp,
// commit 6d473abd2d3d):
// - safe code points are written as-is; everything else as %hex% with
//   lowercase hex, 2 digits up to U+00FF, otherwise at least 4 digits;
// - coordinates are fixed-point 1e-7 integers printed without trailing zeros;
// - metadata (when present) v d c t i u, then T, then x y / N / M.

function isSafe(codePoint){
  return (codePoint >= 0x21 && codePoint <= 0x24) ||
    (codePoint >= 0x26 && codePoint <= 0x2b) ||
    (codePoint >= 0x2d && codePoint <= 0x3c) ||
    (codePoint >= 0x3e && codePoint <= 0x3f) ||
    (codePoint >= 0x41 && codePoint <= 0x7e) ||
    (codePoint >= 0xa1 && codePoint <= 0xac) ||
    (codePoint >= 0xae && codePoint <= 0x5ff);
}

export function encodeOplString(text){
  let out = "";
  for(const character of text){
    const codePoint = character.codePointAt(0);
    if(isSafe(codePoint)) out += character;
    else out += `%${codePoint.toString(16).padStart(codePoint <= 0xff ? 2 : 4, "0")}%`;
  }
  return out;
}

// libosmium append_location_coordinate_to_string, from the 1e-7 integer.
export function encodeCoordinate(degrees){
  let value = Math.round(degrees * 1e7);
  let sign = "";
  if(value < 0){ sign = "-"; value = -value; }
  const integer = Math.floor(value / 1e7);
  const fraction = String(value % 1e7).padStart(7, "0").replace(/0+$/, "");
  return `${sign}${integer}${fraction ? "." + fraction : ""}`;
}

function encodeTags(tags){
  if(!tags) return " T";
  return " T" + Object.keys(tags).map((key) => `${encodeOplString(key)}=${encodeOplString(tags[key])}`).join(",");
}

const TYPE_CHAR = {node: "n", way: "w", relation: "r"};

// metadata: optional {version, changeset, timestamp, uid, user} as osmium
// writes it by default (add_metadata); omitted when not given.
export function encodeOplElement(element, metadata){
  let line = TYPE_CHAR[element.type] + String(element.id);
  if(metadata){
    line += ` v${metadata.version} dV c${metadata.changeset} t${metadata.timestamp} i${metadata.uid} u${encodeOplString(metadata.user)}`;
  }
  line += encodeTags(element.tags);
  if(element.type === "node"){
    const located = typeof element.lat === "number" && typeof element.lon === "number";
    line += located ? ` x${encodeCoordinate(element.lon)} y${encodeCoordinate(element.lat)}` : " x y";
  }else if(element.type === "way"){
    line += " N" + element.nodes.map((ref) => `n${ref}`).join(",");
  }else{
    line += " M" + element.members.map((member) => `${TYPE_CHAR[member.type]}${member.ref}@${encodeOplString(member.role || "")}`).join(",");
  }
  return line;
}

export function encodeOplDocument(elements, {header = [], lineEnding = "\n", metadata} = {}){
  return [...header, ...elements.map((element, index) => encodeOplElement(element, metadata && metadata(element, index)))]
    .map((line) => line + lineEnding).join("");
}

// The part of the S1 JSON fixture that OPL can represent: node/way/relation
// objects with string tag values. OPL cannot write an "area" object or a
// numeric tag value, and writes a node with one coordinate as "no location".
export function oplRepresentableSubset(jsonFixture){
  return jsonFixture.elements
    .filter((element) => element && ["node", "way", "relation"].includes(element.type))
    .filter((element) => !element.tags || Object.values(element.tags).every((value) => typeof value === "string"))
    .map((element) => {
      if(element.type !== "node") return element;
      if(typeof element.lat === "number" && typeof element.lon === "number") return element;
      const {lat, lon, ...rest} = element;
      return rest;
    });
}
