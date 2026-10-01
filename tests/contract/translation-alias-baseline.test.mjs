// Contract: translation language-alias safety.
//
// P1 FIXED: Traditional Chinese (zh-TW / zh-HK / zh-MO / zh-Hant) used to be
// aliased to Simplified Chinese "zh", so TW, HK and MO (all priority-62
// countries) were shown the Simplified static help-phrase pack under a
// Traditional Chinese label. Traditional Chinese now keeps its own identity:
// with no reviewed Traditional static pack in the repository, these countries
// take the existing safe dynamic path (Korean original + labeled English,
// unverified machine output hidden) instead of Simplified Chinese.
//
// All assertions execute the real index.html declarations in a vm sandbox;
// only DOM / network glue is stubbed.

import assert from "node:assert/strict";
import test from "node:test";
import {readRepoFile, mainAppScript, extractFunction, extractConst, loadCountries, evaluateInSandbox} from "./_source.mjs";

const appSource = mainAppScript(readRepoFile("index.html"));
const countries = loadCountries();
const TRADITIONAL_TAGS = ["zh-TW", "zh-tw", "zh-Hant", "zh-hant", "zh-HK", "zh-MO", "zh-Hant-TW", "zh_TW"];
const SIMPLIFIED_TAGS = ["zh", "zh-CN", "zh-cn", "zh-Hans", "zh-SG"];

function loadPhraseFunctions(){
  const sandbox = {helpPhraseRequests:[]};
  evaluateInSandbox(
    `let localLangId = "";
     function getCountryLanguageCode(id){ return id || "en"; }
     function getCountryById(){ return null; }
     ${extractConst(appSource, "langAliases")}
     ${extractConst(appSource, "PRESCRIPTION_SOURCE_KO")}
     ${extractConst(appSource, "PRESCRIPTION_STATEMENTS")}
     ${extractConst(appSource, "phrasePacks")}
     ${extractConst(appSource, "phraseTranslationFailureMessage")}
     ${extractConst(appSource, "medicalLabelPacks")}
     ${extractConst(appSource, "medicalPassportNameLabels")}
     ${extractConst(appSource, "medicalCardLocaleSettings")}
     ${extractFunction(appSource, "expandMedicalLabels")}
     const MEDICAL_CARD_I18N = Object.fromEntries(Object.entries(medicalCardLocaleSettings).map(([lang, cfg]) => [
       lang, {...cfg, labels: expandMedicalLabels(medicalLabelPacks[lang] || medicalLabelPacks.en, lang)}
     ]));
     ${extractFunction(appSource, "isTraditionalChineseLanguageCode")}
     ${extractFunction(appSource, "getBaseLang")}
     ${extractFunction(appSource, "getStaticPhrasePack")}
     ${extractFunction(appSource, "getMedicalI18n")}
     // Dynamic help-phrase glue (no DOM, no network): records would-be requests.
     const helpPhraseTranslationCache = Object.create(null);
     function getHelpPhraseRequestContext(keys, section){ return {keys:keys.slice(), section, languageCode:String(localLangId).toLowerCase()}; }
     function helpPhraseCacheKeyFromContext(context){ return JSON.stringify(context); }
     function isHelpPhraseCacheEntry(){ return false; }
     function isAppOffline(){ return false; }
     function $(){ return null; }
     function requestHelpPhraseTranslations(keys, section){ helpPhraseRequests.push({keys, section, languageCode:localLangId}); return Promise.resolve(false); }
     ${extractFunction(appSource, "getTranslatedPhrasePack")}
     ${extractFunction(appSource, "localTriagePhrase")}
     this.api = {
       langAliases, phrasePacks, MEDICAL_CARD_I18N,
       isTraditionalChineseLanguageCode, getBaseLang, getStaticPhrasePack, getMedicalI18n,
       getTranslatedPhrasePack, localTriagePhrase,
       setLocal(code){ localLangId = code; }
     };`,
    sandbox,
    "index.html"
  );
  return {...sandbox.api, requests:sandbox.helpPhraseRequests};
}

// Characters that exist only in Simplified Chinese (Traditional forms differ).
const SIMPLIFIED_ONLY_CHARACTERS = /[请帮护车药过发烧伤处医疗写]/;

test("langAliases no longer folds Traditional Chinese into Simplified zh", () => {
  const {langAliases} = loadPhraseFunctions();
  assert.equal(langAliases["zh-tw"], undefined);
  assert.equal(langAliases["zh-hant"], undefined);
  const traditionalToZh = Object.entries(langAliases)
    .filter(([key, value]) => /^zh-(?:tw|hk|mo|hant)/.test(key) && value === "zh");
  assert.deepEqual(traditionalToZh, []);
});

test("getBaseLang keeps Traditional Chinese identity (never returns zh)", () => {
  const {getBaseLang, isTraditionalChineseLanguageCode} = loadPhraseFunctions();
  for(const code of TRADITIONAL_TAGS){
    assert.ok(isTraditionalChineseLanguageCode(code), code);
    assert.notEqual(getBaseLang(code), "zh", code);
  }
  assert.equal(getBaseLang("zh-TW"), "zh-tw");
  assert.equal(getBaseLang("zh-Hant"), "zh-hant");
  assert.equal(getBaseLang("zh_TW"), "zh-tw");
});

test("Traditional Chinese requests never use the Simplified static phrase pack", () => {
  const {getStaticPhrasePack, phrasePacks} = loadPhraseFunctions();
  for(const code of TRADITIONAL_TAGS){
    const pack = getStaticPhrasePack(code);
    assert.notEqual(pack, phrasePacks.zh, code);
    assert.equal(pack, null, `${code}: no reviewed Traditional static pack exists, so none is returned`);
  }
});

test("TW, HK and MO (priority 62) take the safe dynamic path, not Simplified Chinese", () => {
  const api = loadPhraseFunctions();
  const traditionalCountries = countries
    .filter((entry) => api.isTraditionalChineseLanguageCode(entry.languageCode))
    .map((entry) => entry.countryCode)
    .sort();
  assert.deepEqual(traditionalCountries, ["HK", "MO", "TW"]);
  for(const code of traditionalCountries){
    const entry = countries.find((item) => item.countryCode === code);
    api.setLocal(entry.languageCode);
    for(const section of ["local", "pharmacy", "emergency", "triage"]){
      const translated = api.getTranslatedPhrasePack(["help", "ambulance", "hospital"], section);
      assert.notEqual(translated.status, "static", `${code}/${section}`);
      assert.equal(translated.pack, null, `${code}/${section}: no pack is presented as local`);
    }
  }
  assert.ok(api.requests.every((request) => /^zh-tw$/i.test(request.languageCode)), "dynamic requests keep zh-TW");
});

test("AI Care / rule-fallback phrase for zh-TW falls back to Korean original, not Simplified", () => {
  const api = loadPhraseFunctions();
  api.setLocal("zh-TW");
  const phrase = {ko:"도움이 필요합니다.", en:"I need help."};
  const result = api.localTriagePhrase(phrase);
  assert.equal(result.untranslated, true);
  assert.equal(result.text, "도움이 필요합니다.");
  assert.doesNotMatch(result.text, SIMPLIFIED_ONLY_CHARACTERS);
  assert.ok(result.helpPhraseResult, "routes to the dynamic help-phrase renderer (KO + labeled EN)");
  assert.notEqual(result.helpPhraseResult.status, "static");
  assert.equal(result.helpPhraseResult.pack, null);
});

test("medical card labels for zh-TW are not the Simplified Chinese labels", () => {
  const api = loadPhraseFunctions();
  const simplified = api.getMedicalI18n("zh");
  for(const code of ["zh-TW", "zh-Hant", "zh-HK"]){
    const config = api.getMedicalI18n(code);
    assert.notEqual(config.cardTitle, simplified.cardTitle, code);
    assert.notEqual(config.blankValue, simplified.blankValue, code);
    assert.notEqual(config.languageLabel, simplified.languageLabel, code);
    assert.doesNotMatch(`${config.cardTitle} ${config.blankValue}`, SIMPLIFIED_ONLY_CHARACTERS, code);
    assert.equal(config.locale, code, `${code}: requested locale is preserved`);
  }
});

test("Simplified Chinese (zh, zh-CN) keeps the existing static pack and labels", () => {
  const api = loadPhraseFunctions();
  for(const code of SIMPLIFIED_TAGS){
    assert.equal(api.isTraditionalChineseLanguageCode(code), false, code);
    assert.equal(api.getBaseLang(code), "zh", code);
    assert.equal(api.getStaticPhrasePack(code), api.phrasePacks.zh, code);
    api.setLocal(code);
    assert.equal(api.getTranslatedPhrasePack(["help"], "local").status, "static", code);
  }
  assert.equal(api.getMedicalI18n("zh").cardTitle, api.MEDICAL_CARD_I18N.zh.cardTitle);
  const china = countries.find((entry) => entry.countryCode === "CN");
  assert.equal(api.getStaticPhrasePack(china.languageCode), api.phrasePacks.zh);
});

test("unrelated aliases are unchanged", () => {
  const {langAliases, getBaseLang, getStaticPhrasePack, phrasePacks} = loadPhraseFunctions();
  assert.equal(langAliases["pt-br"], "pt");
  assert.equal(getBaseLang("pt-BR"), "pt");
  assert.equal(getBaseLang("en-GB"), "en");
  assert.equal(getBaseLang("es-MX"), "es");
  assert.equal(getBaseLang("de-AT"), "de");
  assert.equal(getBaseLang("ar-SA"), "ar");
  assert.equal(getBaseLang("fr"), "fr");
  assert.equal(getBaseLang("ja"), "ja");
  assert.equal(getBaseLang("fil"), "fil", "Filipino is not aliased to English");
  assert.equal(getStaticPhrasePack("en-GB"), phrasePacks.en);
  assert.equal(getStaticPhrasePack("pt-BR"), phrasePacks.pt);
  assert.equal(getStaticPhrasePack("fil"), null);
});
