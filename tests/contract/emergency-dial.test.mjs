// Contract: strict emergency dial safety (characterization).
// Runs the real index.html functions getEmergencyNumbersData,
// isEmergencyStatusDialable, getStrictEmergencyDialNumber and
// getCurrentEmergencyDialNumber (plus their real helpers) against the real
// 230-entry country data. Only lookup glue (getCountryById,
// getCountryLanguageCode, mapLocale) is stubbed.

import assert from "node:assert/strict";
import test from "node:test";
import {readRepoFile, mainAppScript, extractFunction, extractConst, loadCountries, evaluateInSandbox} from "./_source.mjs";

const appSource = mainAppScript(readRepoFile("index.html"));
const countries = loadCountries();
const ROLES = ["primary", "ambulance", "police", "fire"];
const DIALABLE_STATUSES = new Set(["verified", "verified-conditional"]);

function loadDialFunctions(){
  const sandbox = {countryRows: countries};
  evaluateInSandbox(
    `const languageOptions = countryRows.slice();
     let countryDataLoaded = true;
     let confirmedTripCountryCode = "";
     function getCountryById(id){ return languageOptions.find((item) => item.id === id) || null; }
     function getCountryLanguageCode(id){
       const option = id && typeof id === "object" ? id : getCountryById(id);
       return (option && option.languageCode) || (typeof id === "string" ? id : "") || "en";
     }
     const mapLocale = (id) => String(getCountryLanguageCode(id) || "en").toLowerCase();
     const emergencyVerificationNotice = "응급번호 확인 필요";
     ${extractConst(appSource, "legacyEmergencyNumbers")}
     ${extractFunction(appSource, "getEmergencyNumbersData")}
     ${extractFunction(appSource, "isEmergencyStatusDialable")}
     ${extractFunction(appSource, "emergencyAlternates")}
     ${extractFunction(appSource, "hasCompositeEmergencyNumber")}
     ${extractFunction(appSource, "emergencyDialNumberCandidates")}
     ${extractFunction(appSource, "normalizeEmergencyDialNumber")}
     ${extractFunction(appSource, "resolveEmergencyDialNumberValue")}
     ${extractFunction(appSource, "getStrictEmergencyDialNumber")}
     ${extractFunction(appSource, "normalizeConfirmedCountryCode")}
     ${extractFunction(appSource, "getConfirmedTripOption")}
     ${extractFunction(appSource, "getCurrentEmergencyDialNumber")}
     this.api = {
       getEmergencyNumbersData, isEmergencyStatusDialable, getStrictEmergencyDialNumber, getCurrentEmergencyDialNumber,
       setConfirmed(code){ confirmedTripCountryCode = code; },
       setDataLoaded(value){ countryDataLoaded = value; }
     };`,
    sandbox,
    "index.html"
  );
  return sandbox.api;
}

// Independent reading of the data: digits of every candidate in a field.
function ownCandidateDigits(value){
  return String(value || "")
    .split(/\s*(?:\/|,|;|\||또는|\bor\b)\s*/i)
    .map((part) => part.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, ""))
    .filter((part) => /\d/.test(part));
}

test("dialability follows emergencyNumbers.status for all 230 entries", () => {
  const api = loadDialFunctions();
  for(const entry of countries){
    const data = api.getEmergencyNumbersData(entry);
    assert.equal(data, entry.emergencyNumbers, `${entry.countryCode} uses its own emergencyNumbers object`);
    assert.equal(api.isEmergencyStatusDialable(data), DIALABLE_STATUSES.has(entry.emergencyNumbers.status), entry.countryCode);
  }
});

test("needs-verification entries never yield a strict dial number for any role", () => {
  const api = loadDialFunctions();
  const unverified = countries.filter((entry) => entry.emergencyNumbers.status === "needs-verification");
  assert.equal(unverified.length, 15);
  for(const entry of unverified){
    for(const role of [...ROLES, "alternate"]){
      assert.equal(api.getStrictEmergencyDialNumber(entry, role), "", `${entry.countryCode}.${role}`);
    }
  }
});

test("dialable entries only ever dial a number taken from their own data for that role", () => {
  const api = loadDialFunctions();
  let checked = 0;
  for(const entry of countries){
    if(!DIALABLE_STATUSES.has(entry.emergencyNumbers.status)) continue;
    for(const role of ROLES){
      const dialed = api.getStrictEmergencyDialNumber(entry, role);
      if(!dialed) continue;
      assert.ok(ownCandidateDigits(entry.emergencyNumbers[role]).includes(dialed),
        `${entry.countryCode}.${role} dialed ${dialed} is not in its own value "${entry.emergencyNumbers[role]}"`);
      checked += 1;
    }
    assert.notEqual(api.getStrictEmergencyDialNumber(entry, "primary"), "", `${entry.countryCode} dialable entry has a primary dial number`);
  }
  assert.ok(checked >= 215, "every dialable entry was exercised");
});

test("unknown roles never dial", () => {
  const api = loadDialFunctions();
  const france = countries.find((entry) => entry.countryCode === "FR");
  for(const role of ["", "coastguard", "default", "primary "]){
    assert.equal(api.getStrictEmergencyDialNumber(france, role), "", JSON.stringify(role));
  }
});

test("without a confirmed country no emergency number is returned (no default country)", () => {
  const api = loadDialFunctions();
  for(const code of ["", null, undefined, "ko", "KO", "XX", "CY-NORTH", "KOR", " "]){
    api.setConfirmed(code);
    for(const role of ROLES){
      assert.equal(api.getCurrentEmergencyDialNumber(role), "", `confirmed=${JSON.stringify(code)} role=${role}`);
    }
  }
});

test("a confirmed country dials only its own strict number", () => {
  const api = loadDialFunctions();
  for(const code of ["FR", "JP", "US", "KR", "TH"]){
    const entry = countries.find((item) => item.countryCode === code);
    api.setConfirmed(code);
    assert.equal(api.getCurrentEmergencyDialNumber("primary"), api.getStrictEmergencyDialNumber(entry, "primary"), code);
    assert.notEqual(api.getCurrentEmergencyDialNumber("primary"), "", code);
  }
});

test("when country data is not loaded, no emergency number is returned", () => {
  const api = loadDialFunctions();
  api.setConfirmed("FR");
  api.setDataLoaded(false);
  assert.equal(api.getCurrentEmergencyDialNumber("primary"), "");
});

test("characterization: the legacy language-keyed table is never dialable", () => {
  const api = loadDialFunctions();
  // An option without an emergencyNumbers object falls back to the legacy table
  // (e.g. "ko" -> "119"). It is reported as status "legacy", which must not dial.
  const withLegacyText = {id:"legacy-a", countryCode:"ZZ", languageCode:"ko", emergencyNumber:"119"};
  const viaLanguageTable = {id:"legacy-b", countryCode:"ZY", languageCode:"ko"};
  for(const option of [withLegacyText, viaLanguageTable]){
    const data = api.getEmergencyNumbersData(option);
    assert.equal(data.status, "legacy");
    assert.equal(data.primary, "119", "current legacy table content is recorded as-is");
    assert.equal(api.isEmergencyStatusDialable(data), false);
    for(const role of ROLES){
      assert.equal(api.getStrictEmergencyDialNumber(option, role), "", `${option.id}.${role}`);
    }
  }
});
