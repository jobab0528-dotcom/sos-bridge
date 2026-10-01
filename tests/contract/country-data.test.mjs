// Contract: country/region data and the priority-62 list.
// Executes the real countries.js in a vm sandbox and reads the real
// PRIORITY_COUNTRY_CODES literal from index.html (evaluated, not grepped).
// Field names and status values below were taken from the current data,
// not assumed: every one of the 230 entries carries exactly these keys.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {readRepoFile, mainAppScript, extractConst, loadCountries} from "./_source.mjs";

const countries = loadCountries();
const byCode = new Map(countries.map((entry) => [entry.countryCode, entry]));

const EMERGENCY_FIELDS = ["primary", "police", "ambulance", "fire", "notesKo", "sourceName", "sourceUrl", "lastVerified", "status"];
const DIALABLE_STATUSES = ["verified", "verified-conditional"];
const KNOWN_STATUSES = [...DIALABLE_STATUSES, "needs-verification"];

function priorityCodes(){
  const literal = extractConst(mainAppScript(readRepoFile("index.html")), "PRIORITY_COUNTRY_CODES");
  const sandbox = {};
  vm.runInNewContext(`${literal}; this.codes = PRIORITY_COUNTRY_CODES;`, sandbox);
  return Array.from(sandbox.codes);
}

test("countries.js defines 230 country/region entries", () => {
  assert.equal(countries.length, 230);
});

test("countryCode is present and unique for every entry; id is unique", () => {
  const codes = countries.map((entry) => entry.countryCode);
  assert.ok(codes.every((code) => typeof code === "string" && code.trim() !== ""), "every entry has a countryCode");
  assert.equal(new Set(codes).size, codes.length, "no duplicate countryCode");
  const ids = countries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate id");
});

test("every entry has an emergencyNumbers object with the current schema fields", () => {
  for(const entry of countries){
    const numbers = entry.emergencyNumbers;
    assert.ok(numbers && typeof numbers === "object" && !Array.isArray(numbers), `${entry.countryCode} emergencyNumbers object`);
    for(const field of EMERGENCY_FIELDS){
      assert.ok(Object.prototype.hasOwnProperty.call(numbers, field), `${entry.countryCode}.emergencyNumbers.${field} present`);
    }
  }
});

test("emergency status values are limited to the statuses that exist today", () => {
  const counts = {};
  for(const entry of countries){
    const status = entry.emergencyNumbers.status;
    assert.ok(KNOWN_STATUSES.includes(status), `${entry.countryCode} has known status (got ${status})`);
    counts[status] = (counts[status] || 0) + 1;
  }
  // Characterization of the current data baseline (Phase 0 audit values).
  assert.deepEqual(counts, {"verified":210, "verified-conditional":5, "needs-verification":15});
});

test("dialable entries carry a number, a source and a lastVerified date", () => {
  for(const entry of countries){
    const numbers = entry.emergencyNumbers;
    if(!DIALABLE_STATUSES.includes(numbers.status)) continue;
    assert.match(String(numbers.primary), /\d/, `${entry.countryCode} dialable entry has a primary number`);
    assert.ok(String(numbers.sourceName).trim(), `${entry.countryCode} dialable entry has sourceName`);
    assert.match(String(numbers.sourceUrl), /^https:\/\//, `${entry.countryCode} dialable entry has an https sourceUrl`);
    assert.match(String(numbers.lastVerified), /^\d{4}-\d{2}-\d{2}$/, `${entry.countryCode} dialable entry has lastVerified`);
  }
});

test("needs-verification entries expose no emergency number", () => {
  for(const entry of countries){
    const numbers = entry.emergencyNumbers;
    if(numbers.status !== "needs-verification") continue;
    for(const role of ["primary", "police", "ambulance", "fire"]){
      assert.equal(String(numbers[role]).trim(), "", `${entry.countryCode}.${role} is empty while unverified`);
    }
  }
});

test("PRIORITY_COUNTRY_CODES has exactly 62 unique codes, all present in countries.js", () => {
  const codes = priorityCodes();
  assert.equal(codes.length, 62);
  assert.equal(new Set(codes).size, 62, "no duplicate priority code");
  const missing = codes.filter((code) => !byCode.has(code));
  assert.deepEqual(missing, [], "every priority code exists in countries.js");
});

test("every priority country has a dialable emergency status", () => {
  const notDialable = priorityCodes()
    .filter((code) => !DIALABLE_STATUSES.includes(byCode.get(code).emergencyNumbers.status));
  assert.deepEqual(notDialable, []);
});
