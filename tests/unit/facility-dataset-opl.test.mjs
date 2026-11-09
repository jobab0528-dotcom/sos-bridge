// S2-a v2 tests: OPL input (scripts/facility-dataset/lib/opl.mjs) and the
// CLI --input-format opl path. Synthetic data only; no network, no real OSM
// download. Review FINDING 3 (tag keys lost to the __proto__ setter) is
// covered by tests 4 to 6.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {parseOplLine, parseOplText, readOplFile, decodeOplString, OplParseError, OPL_DEFAULT_LIMITS, OPL_HARD_LIMITS} from "../../scripts/facility-dataset/lib/opl.mjs";
import {buildDataset} from "../../scripts/facility-dataset/lib/generate.mjs";
import {canonicalJson, sha256Hex} from "../../scripts/facility-dataset/lib/canonical-json.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {assertHeapFits, ESTIMATED_HEAP_BYTES_PER_OPL_BYTE} from "../../scripts/facility-dataset/lib/memory.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {ROOT, GENERATOR_DIR, FIXTURE_QUALITY_GATES_PATH, loadFixture, loadFixtureQualityGates, fileMap, seededRandom, shuffled} from "./facility-dataset-helpers.mjs";
import {encodeOplString, encodeOplElement, encodeOplDocument, oplRepresentableSubset} from "./facility-dataset-opl-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const OPL_FIXTURE = path.join(ROOT, "tests", "fixtures", "facility-dataset", "kr-synthetic.osm.opl");
const CLI = path.join(GENERATOR_DIR, "build-dataset.mjs");
const DATA_AS_OF = "2026-10-20T00:00:00Z";
// S1 golden (facility-dataset-generator.test.mjs): tiles built from the JSON fixture.
const S1_GOLDEN_CONTENT_SHA256 = "f50b7d279b628e6e0a06e06073c9afcf6455de8996df27f486d6ea1327887016";
const PASSING_GATES = {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0.5};

// The repository has no .gitattributes, so a Windows checkout with
// core.autocrlf=true holds the fixture with CRLF. Tests that compare text
// normalize it; the reader itself accepts both (test 8).
function readFixtureLf(){
  return fs.readFileSync(OPL_FIXTURE, "utf8").replace(/\r\n/g, "\n");
}

function build(elements, extra = {}){
  return buildDataset({elements}, {region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "opl-test", ...extra});
}

function expectOplError(code, fn, lineNumber){
  assert.throws(fn, (error) => error instanceof OplParseError && error.code === code &&
    (lineNumber === undefined || error.lineNumber === lineNumber), `${code}${lineNumber ? " at line " + lineNumber : ""}`);
}

function tempDir(t, prefix){
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function runCli(args){
  return spawnSync(process.execPath, [CLI, ...args], {encoding: "utf8"});
}

function canonicalElements(elements){
  return elements.map((element) => canonicalJson(element));
}

test("1: OPL lines as osmium writes them become OSM JSON elements (libosmium 2.23.1 grammar)", () => {
  assert.deepEqual(parseOplLine("n1 v3 dV c12 t2026-10-19T12:00:00Z i5 u%d14c%user Tamenity=hospital,name=A x126.98 y37.55"), {
    type: "node", id: 1, tags: {amenity: "hospital", name: "A"}, lat: 37.55, lon: 126.98
  });
  // As written by the real libosmium writer (pyosmium 4.3.2): empty t and u.
  assert.deepEqual(parseOplLine("n-3 v0 dV c0 t i0 u T x-0.0000001 y-90"), {type: "node", id: -3, lat: -90, lon: -0.0000001});
  assert.deepEqual(parseOplLine("n4 T x y"), {type: "node", id: 4});
  assert.deepEqual(parseOplLine("n5 T x126.9 y"), {type: "node", id: 5}, "one coordinate is no location, like libosmium");
  assert.deepEqual(parseOplLine("w10\tTamenity=clinic  Nn1,n2,n1   "), {type: "way", id: 10, tags: {amenity: "clinic"}, nodes: [1, 2, 1]});
  assert.deepEqual(parseOplLine("w11 T N"), {type: "way", id: 11, nodes: []});
  assert.deepEqual(parseOplLine("r20 Ttype=multipolygon Mw10@outer,n1@a%20%b%2c%c%3d%d%40%e%25%,r21@"), {
    type: "relation", id: 20, tags: {type: "multipolygon"},
    members: [{type: "way", ref: 10, role: "outer"}, {type: "node", ref: 1, role: "a b,c=d@e%"}, {type: "relation", ref: 21, role: ""}]
  });
  assert.deepEqual(parseOplLine("r21 T M"), {type: "relation", id: 21, members: []});
  // Field order is free.
  assert.deepEqual(parseOplLine("n6 y37.5 x127 Ta=b v1"), {type: "node", id: 6, tags: {a: "b"}, lat: 37.5, lon: 127});
  assert.equal(parseOplLine(""), null);
  assert.equal(parseOplLine("# comment n1 T"), null);
});

test("2: escapes decode to the exact text, Hangul and emoji included", () => {
  for(const text of ["테스트 종합병원", "Test, A=B @ 100%", "🏥 응급실", "naïve café", "tab\there", "line\nbreak", "a b­c", ""]){
    assert.equal(decodeOplString(encodeOplString(text)), text, JSON.stringify(text));
  }
  assert.equal(encodeOplString("테"), "%d14c%");
  assert.equal(decodeOplString("%%"), "%", "libosmium: %% (value 0) is %");
  assert.equal(decodeOplString("%1F3E5%"), "🏥", "upper-case hex is accepted");
  expectOplError("OPL_BAD_ESCAPE", () => decodeOplString("a%20"));
  expectOplError("OPL_BAD_ESCAPE", () => decodeOplString("%zz%"));
  expectOplError("OPL_BAD_ESCAPE", () => decodeOplString("%123456789%"));
  expectOplError("OPL_BAD_ESCAPE", () => decodeOplString("%d800%"));
  expectOplError("OPL_BAD_ESCAPE", () => decodeOplString("%110000%"));
  expectOplError("OPL_CONTROL_CHARACTER", () => decodeOplString("a\u0001b"));
});

test("3: malformed OPL stops with the exact line number instead of guessing", () => {
  const cases = [
    ["x1 T", "OPL_UNKNOWN_TYPE"],
    [" n1 T", "OPL_UNKNOWN_TYPE"],
    ["c1 k0", "OPL_CHANGESET_UNSUPPORTED"],
    ["n T x1 y1", "OPL_EXPECTED_INTEGER"],
    ["n1.5 T", "OPL_EXPECTED_INTEGER"],
    ["n99999999999999999 T", "OPL_INTEGER_OUT_OF_RANGE"],
    ["n1 T Q1", "OPL_UNKNOWN_ATTRIBUTE"],
    ["w1 T x1", "OPL_UNKNOWN_ATTRIBUTE"],
    ["n1 T T", "OPL_DUPLICATE_ATTRIBUTE"],
    ["n1 Ta=1,a=2", "OPL_DUPLICATE_TAG_KEY"],
    ["n1 Ta", "OPL_BAD_TAG"],
    ["n1 Ta=b,", "OPL_BAD_TAG"],
    ["n1 Ta=b=c", "OPL_BAD_TAG"],
    ["n1 T x1e5 y1", "OPL_BAD_COORDINATE"],
    ["n1 T x.5 y1", "OPL_BAD_COORDINATE"],
    ["n1 T xabc y1", "OPL_BAD_COORDINATE"],
    ["n1 dD T x1 y1", "OPL_DELETED_OBJECT_UNSUPPORTED"],
    ["n1 dX T", "OPL_BAD_VISIBLE_FLAG"],
    ["n1 v-1 T", "OPL_EXPECTED_INTEGER"],
    ["n1 t2026-10-19 T", "OPL_BAD_TIMESTAMP"],
    ["n1 ua,b T", "OPL_BAD_USER"],
    ["w1 T Nn1x1y1,n2", "OPL_LOCATIONS_ON_WAYS_UNSUPPORTED"],
    ["w1 T N1,2", "OPL_BAD_WAY_NODE"],
    ["r1 T Mq1@a", "OPL_BAD_MEMBER"],
    ["r1 T Mw1", "OPL_BAD_MEMBER"],
    ["n1 Tname=%zz%", "OPL_BAD_ESCAPE"],
    ["n1 Tname=a\u0002b", "OPL_CONTROL_CHARACTER"],
    ["n1 T x1\ry1", "OPL_BARE_CR"]
  ];
  for(const [line, code] of cases){
    expectOplError(code, () => parseOplText(`n100 T x1 y1\n# ok\n${line}\n`), 3);
  }
  expectOplError("OPL_BYTE_ORDER_MARK", () => parseOplText("﻿n1 T x1 y1\n"), 1);
});

test("4: FINDING 3 regression: special tag keys survive the parser without loss or prototype change", () => {
  // The exact reproduction from the review.
  const reviewed = parseOplLine("n1 T__proto__=x,amenity=hospital x126.98 y37.55");
  assert.deepEqual(Object.keys(reviewed.tags), ["__proto__", "amenity"]);
  assert.equal(Object.getOwnPropertyDescriptor(reviewed.tags, "__proto__").value, "x");
  assert.equal(Object.getPrototypeOf(reviewed.tags), Object.prototype, "the setter was not invoked");

  const keys = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__defineGetter__", "isPrototypeOf"];
  const line = `n2 T${keys.map((key, index) => `${encodeOplString(key)}=v${index}`).join(",")},amenity=hospital x126.98 y37.55`;
  const element = parseOplLine(line);
  assert.deepEqual(Object.keys(element.tags), [...keys, "amenity"]);
  keys.forEach((key, index) => assert.equal(Object.getOwnPropertyDescriptor(element.tags, key).value, `v${index}`, key));
  // Also when the key itself is escaped (osmium escapes no character of these keys, but the reader must not care).
  assert.equal(Object.getOwnPropertyDescriptor(parseOplLine("n3 T%5f%%5f%proto%5f%%5f%=y").tags, "__proto__").value, "y");
});

test("5: FINDING 3 regression: no OSM tag can pollute or replace a prototype", () => {
  const snapshot = (value) => Object.getOwnPropertyNames(value).sort().join(",");
  const before = {object: snapshot(Object.prototype), array: snapshot(Array.prototype), fn: snapshot(Function.prototype)};
  const hostile = [
    "n1 T__proto__=polluted,constructor=x,prototype=y,amenity=hospital x126.98 y37.55",
    "n2 Tpolluted=1,__proto__.polluted=1,constructor.prototype.polluted=1,amenity=pharmacy x126.981 y37.551",
    "w3 T__proto__=a,toString=b,amenity=hospital Nn1,n2"
  ].join("\n");
  const {elements} = parseOplText(hostile);
  const result = build(elements, {qualityGates: PASSING_GATES});
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof ({}).toString, "function");
  assert.deepEqual({object: snapshot(Object.prototype), array: snapshot(Array.prototype), fn: snapshot(Function.prototype)}, before);
  for(const element of elements) assert.equal(Object.getPrototypeOf(element.tags), Object.prototype);
  // The generator keeps only PRESERVED_TAG_KEYS in tiles; the dropped keys
  // are counted (policy), not lost silently.
  assert.equal(result.report.tags.droppedTagEntryCount, 3 + 3 + 2);
  const tile = JSON.parse(fileMap(result).get(result.manifest.tiles.hospital[0].path).bytes.toString("utf8"));
  for(const record of tile.elements){
    assert.equal(Object.getPrototypeOf(record.tags), Object.prototype);
    assert.deepEqual(Object.keys(record.tags).filter((key) => ["__proto__", "constructor", "prototype", "toString"].includes(key)), []);
  }
});

test("6: JSON and OPL input of the same objects are semantically identical, special keys included", () => {
  const jsonText = JSON.stringify({elements: [
    {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "테스트 병원", emergency: "yes"}},
    {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "약국"}}
  ]}).replace('"amenity":"hospital"', '"__proto__":"x","constructor":"c","prototype":"p","amenity":"hospital"');
  const fromJson = JSON.parse(jsonText).elements;
  assert.deepEqual(Object.keys(fromJson[0].tags), ["__proto__", "constructor", "prototype", "amenity", "name", "emergency"]);
  const oplText = fromJson.map((element) => encodeOplElement(element)).join("\n") + "\n";
  const fromOpl = parseOplText(oplText).elements;
  assert.deepEqual(canonicalElements(fromOpl), canonicalElements(fromJson), "parsed objects, tag for tag");
  const a = build(fromJson, {qualityGates: PASSING_GATES});
  const b = build(fromOpl, {qualityGates: PASSING_GATES});
  assert.equal(b.manifest.source.canonicalInputSha256, a.manifest.source.canonicalInputSha256);
  assert.deepEqual(b.files.map((file) => [file.path, file.sha256]), a.files.map((file) => [file.path, file.sha256]));
  assert.deepEqual(b.report, a.report);
});

test("7: the committed OPL fixture is the osmium-style rendering of the JSON fixture and builds the S1 golden tiles", () => {
  const json = loadFixture();
  const subset = oplRepresentableSubset(json);
  const text = readFixtureLf();
  const header = text.split("\n")[0];
  assert.match(header, /^# SOS Bridge synthetic OPL fixture/);
  assert.equal(text, encodeOplDocument(subset, {
    header: [header],
    metadata: (element, index) => ({version: 1 + (index % 3), changeset: 1000 + index, timestamp: "2026-10-19T12:00:00Z", uid: 42, user: "synthetic user"})
  }), "fixture equals the independent test writer output");
  const parsed = parseOplText(text).elements;
  assert.deepEqual(canonicalElements(parsed), canonicalElements(subset));
  const fromOpl = build(parsed, {qualityGates: loadFixtureQualityGates(), sourceFormat: "osm-opl"});
  const fromJson = buildDataset(json, {region: KR_REGION, generator: generatorInfo(), sourceLabel: "opl-test", qualityGates: loadFixtureQualityGates()});
  assert.equal(fromOpl.manifest.contentSha256, S1_GOLDEN_CONTENT_SHA256);
  const tiles = (result) => result.files.filter((file) => /^(hospital|pharmacy)\//.test(file.path)).map((file) => [file.path, file.sha256]);
  assert.deepEqual(tiles(fromOpl), tiles(fromJson));
  assert.deepEqual(fromOpl.report.accepted, fromJson.report.accepted);
  assert.deepEqual(fromOpl.report.integrity, fromJson.report.integrity);
  assert.equal(fromOpl.manifest.source.format, "osm-opl");
});

test("8: Windows CRLF input gives the same objects and the same dataset as LF (text and streamed file)", async (t) => {
  const lf = readFixtureLf();
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(canonicalElements(parseOplText(crlf).elements), canonicalElements(parseOplText(lf).elements));
  const directory = tempDir(t, "sos-opl-crlf-");
  const file = path.join(directory, "crlf.opl");
  fs.writeFileSync(file, crlf);
  const streamed = await readOplFile(file);
  assert.deepEqual(canonicalElements(streamed.elements), canonicalElements(parseOplText(lf).elements));
  assert.equal(streamed.stats.sha256, sha256Hex(Buffer.from(crlf, "utf8")));
  const a = build(streamed.elements, {qualityGates: loadFixtureQualityGates()});
  const b = build(parseOplText(lf).elements, {qualityGates: loadFixtureQualityGates()});
  assert.deepEqual(a.files.map((f) => f.sha256), b.files.map((f) => f.sha256));
  // No final line ending is accepted too.
  assert.equal(parseOplText(lf.trimEnd()).elements.length, parseOplText(lf).elements.length);
});

test("9: streaming reader splits lines correctly across 1 MiB chunk boundaries and reports invalid UTF-8 by line", async (t) => {
  const directory = tempDir(t, "sos-opl-stream-");
  const lines = [];
  for(let index = 1; index <= 30000; index += 1){
    lines.push(encodeOplElement({type: "node", id: index, lat: 37 + index / 1e6, lon: 127, tags: {name: `병원 ${"가".repeat(index % 40)}`, amenity: index % 2 ? "clinic" : "pharmacy"}}));
  }
  const text = lines.join("\r\n") + "\r\n";
  assert.ok(Buffer.byteLength(text) > 3 * 1024 * 1024, "spans several chunks");
  const file = path.join(directory, "big.opl");
  fs.writeFileSync(file, text);
  const streamed = await readOplFile(file);
  assert.equal(streamed.stats.objectCount, 30000);
  assert.deepEqual(canonicalElements(streamed.elements), canonicalElements(parseOplText(text).elements));

  const bad = path.join(directory, "bad.opl");
  fs.writeFileSync(bad, Buffer.concat([Buffer.from("n1 T x1 y1\nn2 Tname="), Buffer.from([0xc3, 0x28]), Buffer.from(" x1 y1\n")]));
  await assert.rejects(readOplFile(bad), (error) => error.code === "OPL_INVALID_UTF8" && error.lineNumber === 2);
  const bom = path.join(directory, "bom.opl");
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("n1 T x1 y1\n")]));
  await assert.rejects(readOplFile(bom), (error) => error.code === "OPL_BYTE_ORDER_MARK" && error.lineNumber === 1);
});

test("10: input, line and object limits stop the run; defaults and hard ceilings are explicit", async (t) => {
  assert.deepEqual(OPL_DEFAULT_LIMITS, {maxInputBytes: 256 * 1048576, maxLineBytes: 1048576, maxElements: 1500000});
  assert.deepEqual(OPL_HARD_LIMITS, {maxInputBytes: 1024 * 1048576, maxLineBytes: 16 * 1048576, maxElements: 8000000});
  const directory = tempDir(t, "sos-opl-limits-");
  const file = path.join(directory, "x.opl");
  fs.writeFileSync(file, "n1 T x1 y1\nn2 T x1 y1\nn3 T x1 y1\n");
  await assert.rejects(readOplFile(file, {maxInputBytes: 10}), (error) => error.code === "OPL_INPUT_TOO_LARGE");
  await assert.rejects(readOplFile(file, {maxElements: 2}), (error) => error.code === "OPL_TOO_MANY_ELEMENTS" && error.lineNumber === 3);
  await assert.rejects(readOplFile(file, {maxLineBytes: 5}), (error) => error.code === "OPL_LINE_TOO_LONG" && error.lineNumber === 1);
  await assert.rejects(readOplFile(file, {maxElements: OPL_HARD_LIMITS.maxElements + 1}), (error) => error.code === "OPL_INVALID_LIMIT");
  expectOplError("OPL_TOO_MANY_ELEMENTS", () => parseOplText("n1 T\nn2 T\n", {maxElements: 1}), 2);
  // Heap pre-check: estimate = bytes x factor, compared with the V8 heap limit.
  assert.equal(ESTIMATED_HEAP_BYTES_PER_OPL_BYTE, 12);
  assert.throws(() => assertHeapFits(200 * 1048576, 2048 * 1048576), (error) => error.code === "INSUFFICIENT_HEAP");
  assert.equal(assertHeapFits(100 * 1048576, 2048 * 1048576).estimatedHeapBytes, 1200 * 1048576);
});

test("11: shuffled OPL lines give byte-identical output (determinism)", () => {
  const lines = readFixtureLf().trimEnd().split("\n");
  const first = build(parseOplText(lines.join("\n")).elements, {qualityGates: loadFixtureQualityGates()});
  for(const seed of [1, 2, 3]){
    const other = build(parseOplText(shuffled(lines, seededRandom(seed)).join("\n")).elements, {qualityGates: loadFixtureQualityGates()});
    assert.deepEqual(other.files.map((file) => [file.path, file.sha256]), first.files.map((file) => [file.path, file.sha256]));
  }
});

test("12: through OPL, hospital emergency evidence is kept verbatim and first, pharmacy order stays OSM type/id", () => {
  const elements = parseOplText([
    "n30 Tamenity=clinic,name=A x126.98 y37.55",
    "n31 Tamenity=hospital,name=B,emergency=yes,emergency:department=yes x126.98 y37.55",
    "w40 Tamenity=hospital,healthcare:speciality=emergency;general,name=C Nn50,n51",
    "n50 T x126.981 y37.551",
    "n51 T x126.982 y37.552",
    "n60 Tamenity=pharmacy,healthcare=hospital,emergency=yes,name=D x126.98 y37.55",
    "n59 Tamenity=pharmacy,name=E x126.98 y37.55"
  ].join("\n")).elements;
  const result = build(elements, {qualityGates: PASSING_GATES});
  const files = fileMap(result);
  const hospital = JSON.parse(files.get(result.manifest.tiles.hospital[0].path).bytes.toString("utf8")).elements;
  assert.deepEqual(hospital.map((record) => `${record.type}/${record.id}`), ["node/31", "node/60", "way/40", "node/30"]);
  assert.deepEqual(hospital[0].tags, {amenity: "hospital", emergency: "yes", "emergency:department": "yes", name: "B"});
  assert.equal(hospital[2].tags["healthcare:speciality"], "emergency;general");
  const pharmacy = JSON.parse(files.get(result.manifest.tiles.pharmacy[0].path).bytes.toString("utf8")).elements;
  assert.deepEqual(pharmacy.map((record) => record.id), [59, 60]);
});

test("13: CLI --input-format opl writes an accepted candidate with source provenance, and refuses bad runs without writing", (t) => {
  const out = tempDir(t, "sos-opl-cli-");
  const base = ["--input", OPL_FIXTURE, "--input-format", "opl", "--region", "KR", "--quality-gates", FIXTURE_QUALITY_GATES_PATH];
  const url = "https://download.geofabrik.de/asia/south-korea-latest.osm.pbf";
  const pbfSha = "a".repeat(64);
  const ok = runCli([...base, "--out", out, "--data-as-of", DATA_AS_OF, "--source-url", url, "--source-sha256", pbfSha]);
  assert.equal(ok.status, 0, ok.stderr);
  const summary = JSON.parse(ok.stdout);
  assert.equal(summary.inputFormat, "opl");
  assert.equal(summary.acceptance, "BUILD_GATES_PASSED");
  assert.equal(summary.publishable, false);
  assert.equal(summary.contentSha256, S1_GOLDEN_CONTENT_SHA256);
  const manifest = JSON.parse(fs.readFileSync(path.join(summary.outputDirectory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.source.upstream, {url, sha256: pbfSha});
  assert.equal(manifest.source.format, "osm-opl");
  assert.equal(manifest.source.rawInputSha256, sha256Hex(fs.readFileSync(OPL_FIXTURE)));

  const refusals = [
    [[...base, "--out", path.join(out, "a")], "MISSING_DATA_AS_OF"],
    [[...base, "--out", path.join(out, "b"), "--data-as-of", DATA_AS_OF, "--source-url", url], "INVALID_ARGUMENTS"],
    [[...base, "--out", path.join(out, "c"), "--data-as-of", DATA_AS_OF, "--source-url", "http://x.invalid/a", "--source-sha256", pbfSha], "INVALID_UPSTREAM"],
    [[...base, "--out", path.join(out, "d"), "--data-as-of", DATA_AS_OF, "--max-elements", "10"], "OPL_TOO_MANY_ELEMENTS"],
    [[...base, "--out", path.join(out, "e"), "--data-as-of", DATA_AS_OF, "--max-input-mb", "0"], "INVALID_ARGUMENTS"],
    [[...base, "--out", path.join(out, "f"), "--data-as-of", DATA_AS_OF, "--max-input-mb", "1025"], "INVALID_ARGUMENTS"],
    [["--input", OPL_FIXTURE, "--region", "KR", "--out", path.join(out, "g"), "--max-elements", "5"], "INVALID_ARGUMENTS"]
  ];
  for(const [args, code] of refusals){
    const result = runCli(args);
    assert.equal(result.status, 1, code);
    assert.equal(JSON.parse(result.stderr).code, code);
    assert.equal(fs.existsSync(args[args.indexOf("--out") + 1]), false, `${code}: nothing written`);
  }
  const badOpl = path.join(out, "bad.opl");
  fs.writeFileSync(badOpl, "n1 Tamenity=hospital x1 y1\nn2 Ta=b,a=c x1 y1\n");
  const parsed = runCli(["--input", badOpl, "--input-format", "opl", "--region", "KR", "--out", path.join(out, "h"), "--data-as-of", DATA_AS_OF, "--quality-gates", FIXTURE_QUALITY_GATES_PATH]);
  assert.equal(parsed.status, 1);
  assert.deepEqual([JSON.parse(parsed.stderr).code, JSON.parse(parsed.stderr).lineNumber], ["OPL_DUPLICATE_TAG_KEY", 2]);
  assert.equal(fs.existsSync(path.join(out, "h")), false);
});
