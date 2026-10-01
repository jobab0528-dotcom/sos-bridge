// Unit tests: src/translation/status.js (Phase 1 / Step 1 common contract).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  TRANSLATION_SCHEMA_VERSION,
  TRANSLATION_STATUS,
  TRANSLATION_STATUSES,
  PROVENANCE_KIND,
  isTranslationStatus,
  normalizeLanguageCode,
  createTranslationResult,
  canShowAsLocal
} from "../../src/translation/status.js";

const MODULE_PATH = fileURLToPath(new URL("../../src/translation/status.js", import.meta.url));
const {VERIFIED, UNVERIFIED, FALLBACK, PARTIAL, FAILED, SOURCE_ONLY, PENDING} = TRANSLATION_STATUS;

function result(status, requested, delivered, extra = {}){
  return createTranslationResult({status, requestedLanguageCode:requested, deliveredLanguageCode:delivered, ...extra});
}

test("all required statuses exist, are deterministic and immutable", () => {
  const required = ["VERIFIED", "UNVERIFIED", "FALLBACK", "PARTIAL", "FAILED", "SOURCE_ONLY", "PENDING"];
  for(const name of required){
    assert.equal(TRANSLATION_STATUS[name], name);
    assert.ok(isTranslationStatus(name));
  }
  assert.deepEqual([...TRANSLATION_STATUSES].sort(), [...required].sort());
  assert.equal(TRANSLATION_SCHEMA_VERSION, "translation-v1");
  for(const frozen of [TRANSLATION_STATUS, TRANSLATION_STATUSES, PROVENANCE_KIND]){
    assert.ok(Object.isFrozen(frozen));
  }
  assert.throws(() => { TRANSLATION_STATUS.UNVERIFIED = "VERIFIED"; }, TypeError);
  assert.throws(() => { TRANSLATION_STATUS.REVIEWED = "REVIEWED"; }, TypeError);
  assert.throws(() => { PROVENANCE_KIND.MACHINE = "static-reviewed"; }, TypeError);
});

test("VERIFIED + fr/fr -> canShowAsLocal true", () => {
  assert.equal(canShowAsLocal(result(VERIFIED, "fr", "fr")), true);
});

test("VERIFIED + fr/en -> false", () => {
  assert.equal(canShowAsLocal(result(VERIFIED, "fr", "en")), false);
});

test("VERIFIED + zh-TW/zh -> false (no alias between variants)", () => {
  assert.equal(canShowAsLocal(result(VERIFIED, "zh-TW", "zh")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "zh", "zh-TW")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "zh-TW", "zh-Hant")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "pt-BR", "pt")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "fil", "tl")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "fr", "fr-FR")), false);
  assert.equal(canShowAsLocal(result(VERIFIED, "zh-TW", "zh-tw")), true, "tags compare case-insensitively");
  assert.equal(normalizeLanguageCode("zh-TW"), "zh-tw");
  assert.equal(normalizeLanguageCode("zh_TW"), "", "malformed tag is rejected, not rewritten");
});

test("UNVERIFIED + fr/fr -> false", () => {
  assert.equal(canShowAsLocal(result(UNVERIFIED, "fr", "fr")), false);
});

test("FALLBACK + fr/en -> false", () => {
  assert.equal(canShowAsLocal(result(FALLBACK, "fr", "en")), false);
  assert.equal(canShowAsLocal(result(FALLBACK, "fr", "fr")), false);
});

test("PARTIAL, FAILED, SOURCE_ONLY and PENDING -> false even with matching languages", () => {
  for(const status of [PARTIAL, FAILED, SOURCE_ONLY, PENDING]){
    assert.equal(canShowAsLocal(result(status, "fr", "fr")), false, status);
    assert.equal(canShowAsLocal(result(status, "fr", null)), false, status);
  }
});

test("null / undefined / empty inputs and empty language codes -> false", () => {
  for(const input of [null, undefined, "", 0, false, "VERIFIED", [], {}, []]){
    assert.equal(canShowAsLocal(input), false, JSON.stringify(input));
  }
  for(const [requested, delivered] of [["", ""], [null, null], [undefined, undefined], ["fr", ""], ["", "fr"], ["fr", null], [null, "fr"], ["  ", "  "]]){
    assert.equal(canShowAsLocal(result(VERIFIED, requested, delivered)), false, JSON.stringify([requested, delivered]));
  }
  assert.equal(canShowAsLocal({status:VERIFIED}), false);
});

test("arbitrary or model-supplied status strings are never treated as VERIFIED", () => {
  const forged = [
    {status:"verified", requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:"Verified", requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:" VERIFIED", requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:"VERIFIED_LOCAL", requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:true, requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:"OK", verified:true, localPhraseVerified:true, requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:["VERIFIED"], requestedLanguageCode:"fr", deliveredLanguageCode:"fr"},
    {status:{toString(){ return "VERIFIED"; }}, requestedLanguageCode:"fr", deliveredLanguageCode:"fr"}
  ];
  for(const value of forged){
    assert.equal(canShowAsLocal(value), false, JSON.stringify(value.status));
  }
  for(const status of ["verified", "VERIFIED_LOCAL", "", null, undefined, "REVIEWED"]){
    assert.throws(() => createTranslationResult({status, requestedLanguageCode:"fr", deliveredLanguageCode:"fr"}), TypeError, String(status));
  }
});

test("provenance is carried but never upgrades a status to VERIFIED", () => {
  for(const provenance of [
    {kind:PROVENANCE_KIND.STATIC_REVIEWED, reviewRef:"QA_v11#12", reviewedAt:"2026-07-08"},
    {kind:PROVENANCE_KIND.MACHINE},
    {kind:PROVENANCE_KIND.AI, reviewer:"human"}
  ]){
    const built = result(UNVERIFIED, "fr", "fr", {provenance});
    assert.equal(built.status, UNVERIFIED);
    assert.equal(canShowAsLocal(built), false);
    assert.equal(built.provenance.kind, provenance.kind);
    assert.ok(Object.isFrozen(built.provenance));
  }
  assert.equal(result(UNVERIFIED, "fr", "fr").provenance, null);
  assert.deepEqual(Object.values(PROVENANCE_KIND).sort(), ["ai", "machine", "source", "static-reviewed", "static-unreviewed"]);
});

test("createTranslationResult builds an immutable translation-v1 model", () => {
  const built = createTranslationResult({
    status:PARTIAL,
    requestedLanguageCode:" FR ",
    deliveredLanguageCode:"fr",
    items:{help:{text:"Aidez-moi.", status:VERIFIED}, ambulance:{text:"Appelez", status:"verified"}, broken:"not an object"},
    failedItems:["hospital", "", 3],
    reasons:["  provider timeout ", null]
  });
  assert.equal(built.schemaVersion, "translation-v1");
  assert.equal(built.requestedLanguageCode, "fr");
  assert.equal(built.deliveredLanguageCode, "fr");
  assert.equal(built.status, PARTIAL);
  assert.deepEqual(Object.keys(built.items), ["help", "ambulance"]);
  assert.equal(built.items.help.status, VERIFIED);
  assert.equal(built.items.ambulance.status, UNVERIFIED, "unknown item status falls back to UNVERIFIED, never VERIFIED");
  assert.deepEqual([...built.failedItems], ["hospital"]);
  assert.deepEqual([...built.reasons], ["provider timeout"]);
  for(const part of [built, built.items, built.items.help, built.failedItems, built.reasons]){
    assert.ok(Object.isFrozen(part));
  }
  assert.throws(() => { built.status = VERIFIED; }, TypeError);
  assert.equal(canShowAsLocal(built), false, "PARTIAL with verified items is still not shown as local as a whole");
  const missing = createTranslationResult({status:FAILED});
  assert.equal(missing.requestedLanguageCode, "");
  assert.equal(missing.deliveredLanguageCode, null);
  assert.deepEqual({...missing.items}, {});
});

test("the module has no imports and no DOM, storage or network dependency", async () => {
  const code = fs.readFileSync(MODULE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\s/m, "no import statements");
  assert.doesNotMatch(code, /\bimport\s*\(/, "no dynamic import");
  assert.doesNotMatch(code, /\b(?:window|document|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|WebSocket|require)\b/);

  const saved = {};
  const guarded = ["window", "document", "localStorage", "fetch", "navigator"];
  for(const name of guarded){
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable:true, get(){ throw new Error(`${name} accessed`); }});
  }
  try{
    const fresh = await import(`../../src/translation/status.js?isolation=${Date.now()}`);
    const built = fresh.createTranslationResult({status:fresh.TRANSLATION_STATUS.VERIFIED, requestedLanguageCode:"ja", deliveredLanguageCode:"ja"});
    assert.equal(fresh.canShowAsLocal(built), true);
  }finally{
    for(const name of guarded){
      if(saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});
