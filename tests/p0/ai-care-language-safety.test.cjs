"use strict";

// P0 regression: AI Care must never present English (or any unverified text)
// as the requested local language. Runs the real ai-care Function handler with a
// stubbed OpenAI fetch (no network, no cost) and the real index.html response
// and render functions extracted into a vm sandbox.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const INDEX_PATH = path.join(ROOT, "index.html");
const LEGACY_APP_PATH = path.join(ROOT, "src", "app", "legacy-app.js");
const AI_CARE_PATH = path.join(ROOT, "netlify", "functions", "ai-care.js");
// Production front-end source: the HTML shell plus the app script it loads.
const indexSource = fs.readFileSync(INDEX_PATH, "utf8") + "\n" + fs.readFileSync(LEGACY_APP_PATH, "utf8");
const aiCareSource = fs.readFileSync(AI_CARE_PATH, "utf8");
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function extractNamedFunction(source, name){
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} declaration missing`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = bodyStart; index < source.length; index += 1){
    const char = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(char === "\\") escaped = true;
      else if(char === quote) quote = "";
      continue;
    }
    if(char === '"' || char === "'" || char === "`"){
      quote = char;
      continue;
    }
    if(char === "{") depth += 1;
    if(char === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} closing brace missing`);
}

// escapeHtml is a one-line declaration whose regex literal contains quote
// characters, which the brace scanner above cannot skip; take the whole line.
function extractSingleLineFunction(source, name){
  const match = source.match(new RegExp(`^function ${name}\\(.*$`, "m"));
  assert.ok(match, `${name} declaration missing`);
  return match[0];
}

// ---------- backend: real handler, stubbed OpenAI ----------

async function runAiCareHandler(modelContent, payloadOverrides = {}){
  const fetchCalls = [];
  const module = {exports:{}};
  const sandbox = {
    module,
    exports:module.exports,
    console:{log(){}, warn(){}, error(){}},
    process:{env:{OPENAI_API_KEY:"test-stub-not-a-real-key"}},
    fetch:async (url) => {
      fetchCalls.push(url);
      assert.equal(url, OPENAI_URL, "only the OpenAI endpoint may be requested (stubbed)");
      const content = typeof modelContent === "string" ? modelContent : JSON.stringify(modelContent);
      return {ok:true, status:200, json:async () => ({choices:[{message:{content}}]})};
    }
  };
  vm.runInNewContext(aiCareSource, sandbox, {filename: AI_CARE_PATH});
  const payload = Object.assign({
    symptom:"배가 너무 아파요",
    travelCountry:"프랑스",
    localLanguage:"fr",
    localLanguageName:"French",
    emergencyNumber:"112"
  }, payloadOverrides);
  const response = await sandbox.exports.handler({httpMethod:"POST", body:JSON.stringify(payload)});
  assert.equal(fetchCalls.length, 1, "exactly one stubbed model call");
  return {statusCode:response.statusCode, body:JSON.parse(response.body)};
}

// ---------- frontend: real index.html functions ----------

const FRENCH_STATIC_PACK = {
  help:"Aidez-moi, s'il vous plaît.",
  ambulance:"Appelez une ambulance, s'il vous plaît.",
  hospital:"Je dois aller à l'hôpital."
};

function loadFrontend(options = {}){
  const base = options.base || "fr";
  const staticPack = Object.prototype.hasOwnProperty.call(options, "staticPack") ? options.staticPack : FRENCH_STATIC_PACK;
  const sandbox = {staticPack, base};
  vm.runInNewContext(
    `const localLangId = "fr-country";
     const phrasePacks = {ko:{help:"도와주세요."}};
     const phraseTranslationFailureMessage = "현지어 문장을 불러오지 못했습니다.";
     function getBaseLang(){ return base; }
     function getTranslatedPhrasePack(){
       return staticPack
         ? {pack:staticPack, status:"static", response:null, errorCode:null}
         : {pack:null, status:"idle", response:null, errorCode:null};
     }
     ${extractSingleLineFunction(indexSource, "escapeHtml")}
     ${extractNamedFunction(indexSource, "isGenericAiCareKoreanPhrase")}
     ${extractNamedFunction(indexSource, "normalizeAiCareKoreanPhrase")}
     ${extractNamedFunction(indexSource, "normalizeAiCareLanguageCode")}
     ${extractNamedFunction(indexSource, "resolveAiCareLocalPhrase")}
     ${extractNamedFunction(indexSource, "buildAiCareTriageFromResponse")}
     ${extractNamedFunction(indexSource, "aiCareEnglishReferenceHtml")}
     ${extractNamedFunction(indexSource, "aiCarePhraseSectionHtml")}
     ${extractNamedFunction(indexSource, "localTriagePhrase")}
     ${extractNamedFunction(indexSource, "analyzeSymptoms")}
     this.buildTriage = buildAiCareTriageFromResponse;
     this.localTriagePhrase = localTriagePhrase;
     this.sectionHtml = aiCarePhraseSectionHtml;
     this.analyzeSymptoms = analyzeSymptoms;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

// Mirrors renderTriage(): localTriagePhrase -> aiCarePhraseSectionHtml.
function renderPhrase(frontend, triage, localLanguageLabel = "Français"){
  const result = frontend.localTriagePhrase(triage.phrase);
  assert.equal(result.helpPhraseResult, undefined, "static-pack test harness should not hit dynamic help phrases");
  return frontend.sectionHtml(triage.phrase, result, localLanguageLabel);
}

function localBlocks(html){
  return [...html.matchAll(/data-phrase-language="local"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[1]);
}

function englishBlocks(html){
  return [...html.matchAll(/data-phrase-language="en"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[1]);
}

function assertNotPresentedAsLocal(html, englishText){
  assert.equal(localBlocks(html).length, 0, "no local-language block may be rendered");
  assert.doesNotMatch(html, /현지 의료진에게 보여줄 문장 · Français/, "French local heading must not be shown");
  assert.doesNotMatch(html, /<span class="check">현지<\/span>/, "'현지' badge must not be shown");
  assert.match(html, /현지어 문장을 확인하지 못했습니다/, "fail-closed notice must be shown");
  if(englishText){
    const escaped = englishText.replace(/'/g, "&#39;");
    const beforeEnglishSection = html.split('data-phrase-language="en"')[0];
    assert.equal(beforeEnglishSection.includes(escaped), false, "English text may only appear inside the English-labeled section");
  }
}

async function frenchChain(modelContent){
  const server = await runAiCareHandler(modelContent);
  assert.equal(server.statusCode, 200);
  const frontend = loadFrontend();
  const triage = frontend.buildTriage(server.body, "배가 너무 아파요", "fr");
  return {server:server.body, triage, html:renderPhrase(frontend, triage)};
}

const BASE_MODEL = {
  level:"urgent",
  title:"복통 참고 안내",
  summary:"복통이 있어 의료기관 상담을 권장합니다.",
  category:"abdominal",
  reasons:["지속되는 복통"],
  steps:["통증이 시작된 시간을 기록하세요.", "가까운 의료기관을 방문하세요."],
  avoid:["혼자 이동하지 마세요."],
  monitor:["고열"],
  questions:["언제 시작됐나요?"],
  localPhraseKo:"배가 너무 아파요.",
  recommendedAction:"hospital",
  recommendedDepartment:"내과",
  needsAmbulance:false,
  confidence:70,
  severityScore:55
};

// ---------- required test 1 ----------
test("1: missing localPhraseLocal with English localPhraseEn is not shown as French", async () => {
  const {server, triage, html} = await frenchChain({...BASE_MODEL, localPhraseEn:"My stomach hurts."});
  assert.equal(server.localPhraseLocal, "", "English must not be promoted into localPhraseLocal");
  assert.equal(server.localPhraseVerified, false);
  assert.equal(server.localPhraseStatus, "FAILED");
  assert.equal(server.localPhraseEn, "My stomach hurts.");
  assert.equal(server.localPhraseRequestedLanguageCode, "fr");
  assert.equal(triage.phrase.local, "");
  assert.equal(triage.phrase.reviewNeeded, true);
  assertNotPresentedAsLocal(html, "My stomach hurts.");
});

// ---------- required test 2 ----------
test("2: localPhraseLocal that is English is not shown as French (identical to English)", async () => {
  const {server, html} = await frenchChain({...BASE_MODEL, localPhraseEn:"My stomach hurts.", localPhraseLocal:"My stomach hurts."});
  assert.equal(server.localPhraseLocal, "");
  assert.equal(server.localPhraseStatus, "FAILED");
  assert.equal(server.localPhraseFailureReason, "LOCAL_PHRASE_IDENTICAL_TO_ENGLISH");
  assertNotPresentedAsLocal(html, "My stomach hurts.");
});

test("2b: English localPhraseLocal without a matching localPhraseEn stays UNVERIFIED and hidden", async () => {
  const {server, html} = await frenchChain({...BASE_MODEL, localPhraseEn:"", localPhraseLocal:"My stomach hurts."});
  assert.equal(server.localPhraseStatus, "UNVERIFIED");
  assert.equal(server.localPhraseVerified, false);
  assertNotPresentedAsLocal(html);
  assert.equal(html.includes("My stomach hurts."), false, "unverified model text must not be displayed at all");
});

// ---------- required test 3 ----------
test("3: hardcoded English fallback is never shown as French", async () => {
  const {server, triage, html} = await frenchChain({});
  const defaultEnglish = "I need help. Please call medical staff or an ambulance.";
  assert.equal(server.localPhraseLocal, "");
  assert.equal(server.localPhraseStatus, "FAILED");
  assert.equal(server.localPhraseEn, defaultEnglish);
  assert.equal(server.localPhraseEnIsDefault, true);
  assert.equal(triage.phrase.enIsDefault, true);
  assertNotPresentedAsLocal(html, defaultEnglish);
});

// ---------- required test 4 ----------
test("4: server never self-verifies; a French-looking phrase stays UNVERIFIED and hidden", async () => {
  const {server, html} = await frenchChain({...BASE_MODEL, localPhraseEn:"My stomach hurts a lot.", localPhraseLocal:"J'ai très mal au ventre."});
  assert.equal(server.localPhraseLocal, "J'ai très mal au ventre.");
  assert.equal(server.localPhraseStatus, "UNVERIFIED");
  assert.equal(server.localPhraseVerified, false);
  assert.equal(server.localPhraseLanguageCode, null, "actual language is unknown, so no language code is claimed");
  assertNotPresentedAsLocal(html);
  assert.equal(html.includes("J&#39;ai très mal au ventre."), false);
});

test("4b: client shows a local phrase only for an explicit VERIFIED_LOCAL contract in the requested language", () => {
  const frontend = loadFrontend();
  const verified = {
    ...BASE_MODEL,
    localPhraseLocal:"J'ai très mal au ventre.",
    localPhraseEn:"My stomach hurts a lot.",
    localPhraseVerified:true,
    localPhraseStatus:"VERIFIED_LOCAL",
    localPhraseLanguageCode:"fr"
  };
  const shown = renderPhrase(frontend, frontend.buildTriage(verified, "배가 너무 아파요", "fr"));
  assert.match(shown, /현지 의료진에게 보여줄 문장 · Français/);
  assert.deepEqual(localBlocks(shown).map((block) => block.includes("J&#39;ai très mal au ventre.")), [true]);
  assert.equal(englishBlocks(shown).length, 0);

  const mismatchedLanguage = renderPhrase(frontend, frontend.buildTriage({...verified, localPhraseLanguageCode:"en"}, "배", "fr"));
  assertNotPresentedAsLocal(mismatchedLanguage);
  const flagOnly = renderPhrase(frontend, frontend.buildTriage({...verified, localPhraseStatus:undefined}, "배", "fr"));
  assertNotPresentedAsLocal(flagOnly);
  const legacyUnflagged = renderPhrase(frontend, frontend.buildTriage({...BASE_MODEL, localPhraseLocal:"J'ai très mal au ventre."}, "배", "fr"));
  assertNotPresentedAsLocal(legacyUnflagged);
});

// ---------- required test 5 ----------
test("5: English fallback is labeled as English and separated from the French badge", async () => {
  const {html} = await frenchChain({...BASE_MODEL, localPhraseEn:"My stomach hurts."});
  const english = englishBlocks(html);
  assert.equal(english.length, 1);
  assert.match(english[0], /<span lang="en"[^>]*>My stomach hurts\.<\/span>/);
  assert.match(html, /영어로 보여줄 문장 · English \(현지어 아님\)/);
  assert.doesNotMatch(html, /Français/);
});

test("5b: English-speaking destination still labels unverified AI English as English, not local", async () => {
  const server = await runAiCareHandler({...BASE_MODEL, localPhraseEn:"My stomach hurts.", localPhraseLocal:"My stomach hurts."}, {localLanguage:"en", localLanguageName:"English", travelCountry:"영국"});
  assert.equal(server.body.localPhraseStatus, "UNVERIFIED");
  const frontend = loadFrontend({base:"en", staticPack:null});
  const html = renderPhrase(frontend, frontend.buildTriage(server.body, "배가 너무 아파요", "en"), "English");
  assert.equal(localBlocks(html).length, 0);
  assert.equal(englishBlocks(html).length, 1);
});

// ---------- required test 6 ----------
test("6: AI Care core data is preserved by the patch", async () => {
  const {server, triage} = await frenchChain({...BASE_MODEL, localPhraseEn:"My stomach hurts."});
  assert.equal(server.level, "urgent");
  assert.equal(server.summary, BASE_MODEL.summary);
  assert.deepEqual(server.steps, BASE_MODEL.steps);
  assert.equal(server.recommendedDepartment, "내과");
  assert.equal(server.recommendedAction, "hospital");
  assert.equal(triage.level, "urgent");
  assert.equal(triage.summary, BASE_MODEL.summary);
  assert.deepEqual(Array.from(triage.steps), BASE_MODEL.steps);
  assert.equal(triage.recommendedDepartment, "내과");
  assert.equal(triage.recommended, "hospital");
  assert.equal(triage.phrase.ko, "배가 너무 아파요.");
  assert.equal(triage.source, "openai");
});

// ---------- required test 7 ----------
test("7: malformed model response still fails to 502 and the rule fallback keeps working", async () => {
  const server = await runAiCareHandler("this is not json");
  assert.equal(server.statusCode, 502);
  assert.equal(server.body.error, "AI Care request failed");

  const frontend = loadFrontend();
  const fallback = frontend.analyzeSymptoms("배가 너무 아파요");
  assert.ok(fallback.steps.length > 0);
  assert.ok(["urgent", "emergency", "mild", "info"].includes(fallback.level));
  const html = renderPhrase(frontend, fallback);
  const local = localBlocks(html);
  assert.equal(local.length, 1, "rule fallback uses the reviewed static French pack");
  assert.match(local[0], /Aidez-moi/);
  assert.equal(local[0].includes(fallback.phrase.en), false, "English rule text is not shown as French");
});

test("7b: rule fallback without a static pack fails closed instead of showing English as local", () => {
  const frontend = loadFrontend({staticPack:{help:"", ambulance:"", hospital:""}});
  const fallback = frontend.analyzeSymptoms("배가 너무 아파요");
  const html = renderPhrase(frontend, fallback);
  assert.equal(localBlocks(html).length, 0);
  assert.equal(html.includes(fallback.phrase.en), false);
});

// ---------- required test 8 ----------
test("8: red-flag emergency guidance is preserved while the local phrase stays fail-closed", async () => {
  const model = {
    ...BASE_MODEL,
    level:"emergency",
    needsAmbulance:true,
    recommendedAction:"emergency",
    recommendedDepartment:"응급의학과",
    steps:["즉시 112로 연락하세요.", "주변 사람에게 도움을 요청하세요."],
    localPhraseEn:"I was stabbed. Please call an ambulance."
  };
  const {server, triage, html} = await frenchChain(model);
  assert.equal(server.level, "emergency");
  assert.equal(server.needsAmbulance, true);
  assert.equal(server.recommendedAction, "emergency");
  assert.deepEqual(server.steps, model.steps);
  assert.equal(triage.level, "emergency");
  assert.equal(triage.needsAmbulance, true);
  assert.equal(triage.recommended, "emergency");
  assert.equal(triage.recommendedDepartment, "응급의학과");
  assertNotPresentedAsLocal(html, "I was stabbed. Please call an ambulance.");

  const frontend = loadFrontend();
  const ruleEmergency = frontend.analyzeSymptoms("칼에 찔렸어요");
  assert.equal(ruleEmergency.level, "emergency");
  assert.equal(ruleEmergency.needsAmbulance, true);
});
