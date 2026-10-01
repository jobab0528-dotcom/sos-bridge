// Contract: translation language-alias baseline (characterization).
//
// KNOWN P1: langAliases maps "zh-tw" and "zh-hant" to "zh". Countries whose
// language is Traditional Chinese (TW, HK, MO - all in the priority 62) are
// therefore served the Simplified Chinese static help-phrase pack.
// Step 0 records this behaviour; it does NOT fix it.
//
// When the P1 is fixed, invert the "KNOWN P1 characterization" assertions
// (expect zh-TW to resolve to a Traditional/zh-TW pack or to no static pack)
// and convert the test.todo below into a real test.

import assert from "node:assert/strict";
import test from "node:test";
import {readRepoFile, mainAppScript, extractFunction, extractConst, loadCountries, evaluateInSandbox} from "./_source.mjs";

const appSource = mainAppScript(readRepoFile("index.html"));
const countries = loadCountries();

function loadAliasFunctions(){
  const sandbox = {};
  evaluateInSandbox(
    `let localLangId = "";
     function getCountryLanguageCode(id){ return id || "en"; }
     ${extractConst(appSource, "langAliases")}
     ${extractConst(appSource, "PRESCRIPTION_SOURCE_KO")}
     ${extractConst(appSource, "PRESCRIPTION_STATEMENTS")}
     ${extractConst(appSource, "phrasePacks")}
     ${extractFunction(appSource, "getBaseLang")}
     ${extractFunction(appSource, "getStaticPhrasePack")}
     this.api = {langAliases, phrasePacks, getBaseLang, getStaticPhrasePack};`,
    sandbox,
    "index.html"
  );
  return sandbox.api;
}

test("KNOWN P1 characterization: langAliases maps zh-tw and zh-hant to zh", () => {
  const {langAliases} = loadAliasFunctions();
  assert.equal(langAliases["zh-tw"], "zh");
  assert.equal(langAliases["zh-hant"], "zh");
});

test("KNOWN P1 characterization: zh-TW resolves to the Simplified Chinese static pack", () => {
  const {getBaseLang, getStaticPhrasePack, phrasePacks} = loadAliasFunctions();
  for(const code of ["zh-TW", "zh-tw", "zh-Hant"]){
    assert.equal(getBaseLang(code), "zh", code);
    assert.equal(getStaticPhrasePack(code), phrasePacks.zh, code);
  }
  assert.equal(phrasePacks["zh-TW"], undefined, "no Traditional Chinese static pack exists today");
});

test("KNOWN P1 characterization: affected priority countries are TW, HK and MO", () => {
  const {getBaseLang} = loadAliasFunctions();
  const affected = countries
    .filter((entry) => String(entry.languageCode).toLowerCase() === "zh-tw")
    .map((entry) => entry.countryCode)
    .sort();
  assert.deepEqual(affected, ["HK", "MO", "TW"]);
  for(const code of affected){
    const entry = countries.find((item) => item.countryCode === code);
    assert.equal(getBaseLang(entry.languageCode), "zh", code);
  }
});

test("characterization: other current aliases (recorded, not judged here)", () => {
  const {langAliases, getBaseLang} = loadAliasFunctions();
  assert.equal(langAliases["pt-br"], "pt");
  assert.equal(getBaseLang("pt-BR"), "pt");
  assert.equal(getBaseLang("fr"), "fr");
  assert.equal(getBaseLang("fil"), "fil", "Filipino is not aliased to English");
  assert.equal(getBaseLang("en-GB"), "en");
});

test.todo("P1 target: zh-TW / zh-Hant must not resolve to the Simplified Chinese (zh) static pack");
