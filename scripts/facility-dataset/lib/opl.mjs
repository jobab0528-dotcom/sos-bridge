// OPL ("Object Per Line") reader for the static facility dataset generator.
// Converts the text osmium writes (`osmium cat -f opl`, libosmium 2.23.1) into
// the OSM JSON element shape the generator already accepts:
//   node     {type, id, lat?, lon?, tags?}
//   way      {type, id, nodes: [id, ...], tags?}
//   relation {type, id, members: [{type, ref, role}, ...], tags?}
// `tags` is present only when the object has tags, exactly like OSM JSON from
// the OSM API or Overpass, so JSON and OPL input of the same objects give the
// same canonical elements.
//
// Grammar source: libosmium 2.23.1 (osmcode/libosmium commit 6d473abd2d3d,
// 2026-10-19), include/osmium/io/detail/opl_parser_functions.hpp (reader),
// opl_output_format.hpp (writer) and string_util.hpp (escaping):
// - one object per line; empty lines and lines starting with "#" are ignored;
// - a line starts with n|w|r (c = changeset) and the id, then fields
//   separated by one or more spaces or tabs, each a one-letter prefix plus a
//   value: v d c t i u T x y (node), v d c t i u T N (way), v d c t i u T M
//   (relation); field order is free, a repeated field is an error;
// - strings end at space, tab, "," or "="; "%<1-8 hex digits>%" is a Unicode
//   code point and "%%" (value 0) is "%"; the writer escapes everything outside
//   a safe set (including space , = @ % and every code point above U+05FF, so
//   Hangul is always escaped, e.g. %d14c%);
// - tags "key=value,key=value"; way nodes "n1,n2"; members "n1@role,w2@,r3@x".
//
// Deliberately STRICTER than libosmium (the run stops with the line number;
// accepting these would mean overwriting or guessing data): changeset lines,
// deleted objects (dD), locations on way nodes, a repeated tag key (OSM JSON
// cannot hold two values for one key), scientific-notation or leading-dot
// coordinates, ids outside the JavaScript safe-integer range, escapes that
// are not a Unicode scalar value, raw control characters, invalid UTF-8, a
// byte order mark and a bare "\r" inside a line.
//
// Tag keys are copied WITHOUT loss. Keys such as "__proto__", "constructor"
// and "prototype" are ordinary OSM keys: they are defined as own data
// properties (Object.defineProperty), never assigned, so they cannot be
// swallowed by the Object.prototype.__proto__ setter and cannot change any
// prototype. JSON.parse defines them the same way, so JSON and OPL input stay
// equivalent. Removing tags is the generator's job (PRESERVED_TAG_KEYS, counted
// in validation-report tags.droppedTagEntryCount), never the parser's.
//
// Object-level problems the generator already handles (invalid coordinates,
// negative ids, missing referenced objects, malformed tags) are passed through
// unchanged so the generator can count them or stop on them; they are never
// fixed or approximated here.
//
// Line endings: "\n" and "\r\n" (Windows). The osmium writer never emits a
// lone "\r" (it escapes control characters), so a lone "\r" is corruption.

import fs from "node:fs";
import {createHash} from "node:crypto";

const MIB = 1024 * 1024;

// Defaults are what a run gets without overrides. Sized from synthetic
// measurements (README "Memory": about 7.6 bytes of peak heap per OPL byte and
// about 1.5 KB of peak heap per object, Node 22 on Linux) so a default-sized
// run peaks near 3 GB RSS with node --max-old-space-size=4096. They are NOT a
// statement that real KR data fits; the real KR subset has not been measured.
export const OPL_DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 256 * MIB,
  maxLineBytes: 1 * MIB,
  maxElements: 1500000
});

// Absolute ceilings for explicit overrides (--max-input-mb, --max-elements):
// by the same measurements, roughly what a 16 GB workstation could attempt.
// They are input-validation bounds, NOT a memory guarantee and not tested at
// that size: whether a run fits is decided by the heap pre-check
// (lib/memory.mjs, estimate versus the V8 heap limit) and, finally, by V8. An
// out-of-memory crash never leaves a dataset version (lib/write-output.mjs).
export const OPL_HARD_LIMITS = Object.freeze({
  maxInputBytes: 1024 * MIB,
  maxLineBytes: 16 * MIB,
  maxElements: 8000000
});

export class OplParseError extends Error{
  constructor(code, message, lineNumber = 0){
    super(lineNumber ? `${code}: line ${lineNumber}: ${message}` : `${code}: ${message}`);
    this.name = "OplParseError";
    this.code = code;
    this.lineNumber = lineNumber;
  }
}

const OBJECT_TYPES = Object.freeze({n: "node", w: "way", r: "relation"});
const FIELDS = Object.freeze({
  node: Object.freeze(["v", "d", "c", "t", "i", "u", "T", "x", "y"]),
  way: Object.freeze(["v", "d", "c", "t", "i", "u", "T", "N"]),
  relation: Object.freeze(["v", "d", "c", "t", "i", "u", "T", "M"])
});
const INTEGER = /^-?\d+$/;
const UNSIGNED_INTEGER = /^\d+$/;
// Plain decimal, as the osmium writer prints coordinates (at most 7
// decimals); up to 20 decimals are accepted like libosmium and rounded later.
const COORDINATE = /^-?\d{1,10}(?:\.\d{1,20})?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX_DIGIT = /^[0-9a-fA-F]$/;
const UTF8 = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});

function fail(code, message, lineNumber){
  throw new OplParseError(code, message, lineNumber);
}

function hasOwn(object, key){
  return Object.prototype.hasOwnProperty.call(object, key);
}

// Own, enumerable, writable data property: same result as JSON.parse for any
// key, including "__proto__".
function defineOwn(object, key, value){
  Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});
}

function parseInteger(text, what, lineNumber, unsigned = false){
  if(!(unsigned ? UNSIGNED_INTEGER : INTEGER).test(text)) fail("OPL_EXPECTED_INTEGER", `${what}: "${text}"`, lineNumber);
  const value = Number(text);
  if(!Number.isSafeInteger(value)) fail("OPL_INTEGER_OUT_OF_RANGE", `${what}: "${text}"`, lineNumber);
  return value;
}

// Decodes one OPL string section (a key, value, role or user name). `text`
// holds no unescaped separator: callers split on them first.
export function decodeOplString(text, lineNumber = 0){
  let result = "";
  let index = 0;
  while(index < text.length){
    const character = text[index];
    if(character !== "%"){
      const code = character.codePointAt(0);
      if(code < 0x20 || code === 0x7f) fail("OPL_CONTROL_CHARACTER", `raw control character U+${code.toString(16).padStart(4, "0")}`, lineNumber);
      result += character;
      index += 1;
      continue;
    }
    // libosmium opl_parse_escaped: up to 8 hex digits, then "%".
    let end = index + 1;
    while(end < text.length && text[end] !== "%" && end - index <= 8){
      if(!HEX_DIGIT.test(text[end])) fail("OPL_BAD_ESCAPE", `not a hex digit in "${text}"`, lineNumber);
      end += 1;
    }
    if(end >= text.length || text[end] !== "%") fail("OPL_BAD_ESCAPE", `unterminated or too long escape in "${text}"`, lineNumber);
    const hex = text.slice(index + 1, end);
    const value = hex === "" ? 0 : parseInt(hex, 16);
    if(value === 0){
      result += "%";
    }else{
      if(value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)){
        fail("OPL_BAD_ESCAPE", `%${hex}% is not a Unicode scalar value`, lineNumber);
      }
      result += String.fromCodePoint(value);
    }
    index = end + 1;
  }
  return result;
}

function parseTags(text, lineNumber){
  const tags = {};
  for(const entry of text.split(",")){
    const parts = entry.split("=");
    if(parts.length !== 2) fail("OPL_BAD_TAG", `expected key=value, got "${entry}"`, lineNumber);
    const key = decodeOplString(parts[0], lineNumber);
    const value = decodeOplString(parts[1], lineNumber);
    if(hasOwn(tags, key)) fail("OPL_DUPLICATE_TAG_KEY", `tag key "${key}" appears twice`, lineNumber);
    defineOwn(tags, key, value);
  }
  return tags;
}

function parseWayNodes(text, lineNumber){
  if(text === "") return [];
  return text.split(",").map((entry) => {
    const match = /^n(-?\d+)(.*)$/.exec(entry);
    if(!match) fail("OPL_BAD_WAY_NODE", `expected n<id>, got "${entry}"`, lineNumber);
    if(match[2] !== ""){
      if(/^x/.test(match[2])) fail("OPL_LOCATIONS_ON_WAYS_UNSUPPORTED", `way node with location "${entry}"`, lineNumber);
      fail("OPL_BAD_WAY_NODE", `unexpected characters in "${entry}"`, lineNumber);
    }
    return parseInteger(match[1], "way node id", lineNumber);
  });
}

function parseMembers(text, lineNumber){
  if(text === "") return [];
  return text.split(",").map((entry) => {
    const match = /^([nwr])(-?\d+)@(.*)$/.exec(entry);
    if(!match) fail("OPL_BAD_MEMBER", `expected <n|w|r><id>@<role>, got "${entry}"`, lineNumber);
    if(match[3].includes("=")) fail("OPL_BAD_MEMBER", `unescaped "=" in role of "${entry}"`, lineNumber);
    return {
      type: OBJECT_TYPES[match[1]],
      ref: parseInteger(match[2], "member id", lineNumber),
      role: decodeOplString(match[3], lineNumber)
    };
  });
}

function parseCoordinate(text, lineNumber){
  if(!COORDINATE.test(text)) fail("OPL_BAD_COORDINATE", `"${text}"`, lineNumber);
  return Number(text);
}

// Parses one line (without its line ending). Returns an OSM JSON element, or
// null for an empty or comment line.
export function parseOplLine(line, lineNumber = 0){
  if(line === "" || line[0] === "#") return null;
  if(line.charCodeAt(0) === 0xfeff) fail("OPL_BYTE_ORDER_MARK", "byte order mark", lineNumber);
  if(line.includes("\r")) fail("OPL_BARE_CR", "carriage return inside a line", lineNumber);
  if(line[0] === "c") fail("OPL_CHANGESET_UNSUPPORTED", "changeset lines are not facility data", lineNumber);
  const type = OBJECT_TYPES[line[0]];
  if(!type) fail("OPL_UNKNOWN_TYPE", `line starts with "${line[0]}"`, lineNumber);

  const sections = line.slice(1).split(/[ \t]+/);
  if(sections[sections.length - 1] === "") sections.pop(); // trailing spaces
  const id = parseInteger(sections[0], `${type} id`, lineNumber);
  const seen = new Set();
  const element = {type, id};
  let lon;
  let lat;
  let hasX = false;
  let hasY = false;
  for(const section of sections.slice(1)){
    const field = section[0];
    const value = section.slice(1);
    if(!FIELDS[type].includes(field)) fail("OPL_UNKNOWN_ATTRIBUTE", `"${field}" on a ${type}`, lineNumber);
    if(seen.has(field)) fail("OPL_DUPLICATE_ATTRIBUTE", `"${field}"`, lineNumber);
    seen.add(field);
    switch(field){
      case "v": parseInteger(value, "version", lineNumber, true); break;
      case "c": parseInteger(value, "changeset", lineNumber, true); break;
      case "i": parseInteger(value, "uid", lineNumber, true); break;
      case "u":
        // libosmium ends the user name at "," or "=" and then expects a space.
        if(/[,=]/.test(value)) fail("OPL_BAD_USER", `unescaped separator in "${value}"`, lineNumber);
        decodeOplString(value, lineNumber);
        break;
      case "d":
        if(value === "D") fail("OPL_DELETED_OBJECT_UNSUPPORTED", "deleted object", lineNumber);
        if(value !== "V") fail("OPL_BAD_VISIBLE_FLAG", `"${value}"`, lineNumber);
        break;
      case "t":
        if(value !== ""){
          if(!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) fail("OPL_BAD_TIMESTAMP", `"${value}"`, lineNumber);
        }
        break;
      case "T":
        if(value !== "") element.tags = parseTags(value, lineNumber);
        break;
      case "x":
        hasX = true;
        if(value !== "") lon = parseCoordinate(value, lineNumber);
        break;
      case "y":
        hasY = true;
        if(value !== "") lat = parseCoordinate(value, lineNumber);
        break;
      case "N": element.nodes = parseWayNodes(value, lineNumber); break;
      case "M": element.members = parseMembers(value, lineNumber); break;
      default: fail("OPL_UNKNOWN_ATTRIBUTE", `"${field}"`, lineNumber);
    }
  }
  // libosmium sets a location only when both coordinates are present.
  if(type === "node" && hasX && hasY && lon !== undefined && lat !== undefined){
    element.lat = lat;
    element.lon = lon;
  }
  if(type === "way" && !element.nodes) element.nodes = [];
  if(type === "relation" && !element.members) element.members = [];
  return element;
}

function normalizedLimits(limits){
  const result = {...OPL_DEFAULT_LIMITS, ...(limits || {})};
  for(const key of Object.keys(OPL_DEFAULT_LIMITS)){
    if(!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > OPL_HARD_LIMITS[key]){
      throw new OplParseError("OPL_INVALID_LIMIT", `${key} must be an integer from 1 to ${OPL_HARD_LIMITS[key]}`);
    }
  }
  return result;
}

function createCollector(limits){
  const elements = [];
  const byType = {node: 0, way: 0, relation: 0};
  let lineCount = 0;
  return {
    elements,
    byType,
    get lineCount(){ return lineCount; },
    line(text){
      lineCount += 1;
      const element = parseOplLine(text, lineCount);
      if(!element) return;
      if(elements.length >= limits.maxElements){
        fail("OPL_TOO_MANY_ELEMENTS", `more than ${limits.maxElements} objects`, lineCount);
      }
      byType[element.type] += 1;
      elements.push(element);
    }
  };
}

// In-memory variant for tests and small inputs. Same rules as readOplFile.
export function parseOplText(text, limits){
  const effective = normalizedLimits(limits);
  if(typeof text !== "string") throw new OplParseError("OPL_INVALID_INPUT", "text must be a string");
  if(Buffer.byteLength(text, "utf8") > effective.maxInputBytes){
    throw new OplParseError("OPL_INPUT_TOO_LARGE", `input is larger than ${effective.maxInputBytes} bytes`);
  }
  const collector = createCollector(effective);
  const lines = text.split("\n");
  if(lines[lines.length - 1] === "") lines.pop();
  for(let index = 0; index < lines.length; index += 1){
    let line = lines[index];
    if(line.endsWith("\r")) line = line.slice(0, -1);
    if(Buffer.byteLength(line, "utf8") > effective.maxLineBytes){
      fail("OPL_LINE_TOO_LONG", `line is longer than ${effective.maxLineBytes} bytes`, index + 1);
    }
    collector.line(line);
  }
  return {elements: collector.elements, stats: {lineCount: collector.lineCount, objectCount: collector.elements.length, byType: collector.byType}};
}

function decodeLine(bytes, lineNumber){
  try{
    return UTF8.decode(bytes);
  }catch(error){
    fail("OPL_INVALID_UTF8", "invalid UTF-8", lineNumber);
  }
}

// Streams an OPL file (1 MiB chunks) without holding its text in memory. The
// parsed elements are kept (the generator needs all of them at once). Also
// returns the SHA-256 and size of the exact bytes read.
// Size is enforced twice and independently: from fs.stat BEFORE reading, and
// by counting the bytes actually read (a file can grow after stat, and stat
// may report 0 for special files). `fsApi` ({statSync, createReadStream})
// exists for fault-injection tests; production uses node:fs.
export async function readOplFile(filePath, limits, fsApi = fs){
  const effective = normalizedLimits(limits);
  const stat = fsApi.statSync(filePath);
  if(!stat.isFile()) throw new OplParseError("OPL_INVALID_INPUT", "input is not a regular file");
  if(stat.size > effective.maxInputBytes){
    throw new OplParseError("OPL_INPUT_TOO_LARGE", `input is ${stat.size} bytes (limit ${effective.maxInputBytes})`);
  }
  const hash = createHash("sha256");
  const collector = createCollector(effective);
  let bytesRead = 0;
  let pending = [];
  let pendingBytes = 0;

  const finishLine = (lineBuffer) => {
    const lineNumber = collector.lineCount + 1;
    let end = lineBuffer.length;
    if(end > 0 && lineBuffer[end - 1] === 0x0d) end -= 1;
    const body = lineBuffer.subarray(0, end);
    if(body.length > effective.maxLineBytes){
      fail("OPL_LINE_TOO_LONG", `line is longer than ${effective.maxLineBytes} bytes`, lineNumber);
    }
    if(lineNumber === 1 && body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf){
      fail("OPL_BYTE_ORDER_MARK", "byte order mark", lineNumber);
    }
    if(body.includes(0x0d)) fail("OPL_BARE_CR", "carriage return inside a line", lineNumber);
    collector.line(decodeLine(body, lineNumber));
  };

  const stream = fsApi.createReadStream(filePath, {highWaterMark: MIB});
  try{
    for await (const chunk of stream){
      bytesRead += chunk.length;
      if(bytesRead > effective.maxInputBytes){
        throw new OplParseError("OPL_INPUT_TOO_LARGE", `input grew beyond ${effective.maxInputBytes} bytes while reading`);
      }
      hash.update(chunk);
      let start = 0;
      for(let newline = chunk.indexOf(0x0a, start); newline !== -1; newline = chunk.indexOf(0x0a, start)){
        const piece = chunk.subarray(start, newline);
        if(pendingBytes + piece.length > effective.maxLineBytes + 1){
          fail("OPL_LINE_TOO_LONG", `line is longer than ${effective.maxLineBytes} bytes`, collector.lineCount + 1);
        }
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        pendingBytes = 0;
        finishLine(line);
        start = newline + 1;
      }
      if(start < chunk.length){
        const rest = chunk.subarray(start);
        pendingBytes += rest.length;
        if(pendingBytes > effective.maxLineBytes + 1){
          fail("OPL_LINE_TOO_LONG", `line is longer than ${effective.maxLineBytes} bytes`, collector.lineCount + 1);
        }
        pending.push(Buffer.from(rest));
      }
    }
  }finally{
    stream.destroy();
  }
  if(pending.length) finishLine(Buffer.concat(pending));
  return {
    elements: collector.elements,
    stats: {
      lineCount: collector.lineCount,
      objectCount: collector.elements.length,
      byType: collector.byType,
      bytes: bytesRead,
      sha256: hash.digest("hex")
    }
  };
}
