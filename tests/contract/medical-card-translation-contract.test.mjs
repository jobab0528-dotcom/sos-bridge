// Contract: medical card translation failure safety (ISSUE-011).
//
// Server: runs the real netlify/functions/translate-medical-card.js handler in
// a vm sandbox with a stubbed OpenAI fetch (no network, no cost).
// Client: runs the real index.html response/render functions
// (classifyMedicalTranslationResponse, normalizeMedicalTranslation,
// medicalTranslationStatusNoticeHtml, medicalPassCardHtml, medicalRowsHtml).

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {readRepoFile, mainAppScript, extractFunction, extractConst, evaluateInSandbox, forbidNetwork} from "./_source.mjs";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const SERVER_SOURCE = readRepoFile("netlify/functions/translate-medical-card.js");
const appSource = mainAppScript(readRepoFile("index.html"));
const restoreFetch = forbidNetwork();
test.after(restoreFetch);

const HANGUL = /[가-힯]/;

const CARD = Object.freeze({
  name:"홍길동",
  passportName:"HONG GILDONG",
  nationality:"대한민국",
  age:"34",
  bloodType:"A+",
  allergies:"땅콩, 갑각류",
  medication:"타이레놀, 지르텍",
  medicalConditions:"천식",
  emergencyContact:"+82 10-1234-5678",
  travelInsurance:"삼성화재 여행자보험",
  hotelAddress:"12 Rue de Rivoli, Paris"
});

const FRENCH_OK = Object.freeze({
  _cardTitle:"Carte médicale",
  _blankValue:"Non renseigné",
  _labels:{name:"Nom", passportName:"Nom du passeport", nationality:"Nationalité", age:"Âge", bloodType:"Groupe sanguin", allergies:"Allergies", medication:"Médicaments", medicalConditions:"Antécédents", emergencyContact:"Contact d'urgence", travelInsurance:"Assurance voyage", hotelAddress:"Adresse"},
  name:"Hong Gildong",
  passportName:"HONG GILDONG",
  nationality:"Corée du Sud",
  age:"34",
  bloodType:"A+",
  allergies:"Allergie aux arachides, Allergie aux crustacés",
  medication:"Tylenol, Zyrtec",
  medicalConditions:"Asthme",
  emergencyContact:"+82 10-1234-5678",
  travelInsurance:"Assurance voyage Samsung Fire",
  hotelAddress:"12 Rue de Rivoli, Paris"
});

// replies: array consumed per OpenAI call; each item is a model JSON object,
// a raw string, or {httpStatus} for an upstream error. The last item repeats.
async function translate({replies, targetLanguageCode = "fr", targetLanguage = "French", card = CARD, extraBody = {}}){
  const calls = [];
  const module = {exports:{}};
  const sandbox = {
    module, exports:module.exports, console:{log(){}, warn(){}, error(){}},
    process:{env:{OPENAI_API_KEY:"stub-not-a-real-key"}},
    fetch:async (url, options) => {
      assert.equal(url, OPENAI_URL, "only the stubbed OpenAI endpoint may be called");
      const request = JSON.parse(options.body);
      const userContent = JSON.parse(request.messages[1].content);
      calls.push(userContent.targetLanguageCode);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if(reply && typeof reply === "object" && reply.httpStatus){
        return {ok:false, status:reply.httpStatus, json:async () => ({error:{message:"stub upstream failure"}})};
      }
      const content = typeof reply === "string" ? reply : JSON.stringify(reply);
      return {ok:true, status:200, json:async () => ({choices:[{message:{content}}]})};
    }
  };
  vm.runInNewContext(SERVER_SOURCE, sandbox, {filename:"translate-medical-card.js"});
  const response = await sandbox.exports.handler({
    httpMethod:"POST",
    body:JSON.stringify({targetLanguage, targetLanguageCode, fields:card, ...extraBody})
  });
  return {statusCode:response.statusCode, body:JSON.parse(response.body), calls};
}

function loadClient(){
  const sandbox = {};
  evaluateInSandbox(
    `let localLangId = "fr-country";
     const KO_LABELS = {name:"이름", passportName:"여권상 영문 이름", nationality:"국적", age:"나이", blood:"혈액형", allergy:"알레르기", medication:"복용 중인 약", condition:"기존 질환", contact:"비상 연락처", insurance:"여행자 보험", hotel:"숙소 주소"};
     const FR_LABELS = {name:"Nom", passportName:"Nom du passeport", nationality:"Nationalité", age:"Âge", blood:"Groupe sanguin", allergy:"Allergies", medication:"Médicaments", condition:"Antécédents", contact:"Contact d'urgence", insurance:"Assurance voyage", hotel:"Adresse"};
     function getMedicalI18n(id){ return id === "ko" ? {cardTitle:"여행자 의료카드", blankValue:"미입력", labels:KO_LABELS} : {cardTitle:"Carte médicale", blankValue:"Non renseigné", labels:FR_LABELS}; }
     function getMedicalLabels(id){ return getMedicalI18n(id).labels; }
     function getSelectedCountryForTranslation(){ return {fallbackLanguageCode:"", fallbackLanguageNameKo:"", fallbackLanguageNameEn:""}; }
     ${extractFunction(appSource, "escapeHtml")}
     ${extractFunction(appSource, "medicalFields")}
     ${extractConst(appSource, "medicalValueFields")}
     ${extractConst(appSource, "MEDICAL_TRANSLATION_VALUE_KEYS")}
     ${extractFunction(appSource, "getMedicalCardTitle")}
     ${extractFunction(appSource, "getMedicalMissingText")}
     ${extractFunction(appSource, "fallbackLanguageDisplayName")}
     ${extractFunction(appSource, "medicalFallbackNoticeHtml")}
     ${extractFunction(appSource, "normalizeMedicalLanguageTag")}
     ${extractFunction(appSource, "classifyMedicalTranslationResponse")}
     ${extractFunction(appSource, "normalizeMedicalTranslation")}
     ${extractFunction(appSource, "medicalRowsHtml")}
     ${extractFunction(appSource, "medicalPassCardHtml")}
     ${extractFunction(appSource, "medicalTranslationStatusNoticeHtml")}
     this.api = {classify:classifyMedicalTranslationResponse, normalize:normalizeMedicalTranslation,
       passCard:medicalPassCardHtml, rows:medicalRowsHtml, notice:medicalTranslationStatusNoticeHtml, getMedicalLabels};`,
    sandbox,
    "index.html"
  );
  return sandbox.api;
}

// Mirrors showLocalMedicalCard + the "done" branch of renderMedicalCardPreview.
function renderClient(client, httpOk, data, requested = "fr"){
  const outcome = client.classify(httpOk, data, requested);
  if(outcome.status === "FAILED") return {outcome, html:client.rows(client.getMedicalLabels("ko"), CARD, "KO")};
  const translation = client.normalize(data, CARD);
  translation.translationStatus = outcome.status;
  translation.failedItems = outcome.failedItems;
  if(outcome.status === "FALLBACK") translation.fallbackUsed = true;
  const html = client.notice(translation) + client.passCard(translation._labels || client.getMedicalLabels("fr"), translation, translation.usedLanguage || "Français", translation.failedItems);
  return {outcome, translation, html};
}

test("1: full translation -> SUCCESS with the requested language delivered", async () => {
  const {statusCode, body} = await translate({replies:[FRENCH_OK]});
  assert.equal(statusCode, 200);
  assert.equal(body.translationStatus, "SUCCESS");
  assert.equal(body.requestedLanguageCode, "fr");
  assert.equal(body.deliveredLanguageCode, "fr");
  assert.equal(body.languageMatched, true);
  assert.equal(body.languageVerified, false, "machine translation is never claimed as human-verified");
  assert.deepEqual(body.failedItems, []);
  assert.deepEqual([...body.translatedItems].sort(), ["allergies", "medicalConditions", "medication", "nationality", "travelInsurance"]);
  assert.equal(body.reviewNeeded, false);
  const {outcome} = renderClient(loadClient(), true, body);
  assert.equal(outcome.status, "SUCCESS");
});

test("2: every attempt fails upstream -> FAILED (502) with no translated card fields", async () => {
  const {statusCode, body, calls} = await translate({replies:[{httpStatus:500}]});
  assert.ok(calls.length >= 2, "all attempts were tried");
  assert.equal(statusCode, 502);
  assert.equal(body.translationStatus, "FAILED");
  assert.equal(body.retryable, true);
  assert.equal(body.deliveredLanguageCode, null);
  assert.deepEqual(body.translatedItems, []);
  assert.deepEqual([...body.failedItems].sort(), ["allergies", "medicalConditions", "medication", "nationality", "travelInsurance"]);
  for(const key of ["fields", "_labels", "_cardTitle", "allergies", "medication", "nationality", "usedLanguageCode"]){
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, `failure body has no ${key}`);
  }
});

test("2b: an attempt whose values all stay Korean is rejected, never returned as a translation", async () => {
  const untranslated = {...FRENCH_OK, nationality:"대한민국", allergies:"땅콩, 갑각류", medication:"타이레놀, 지르텍", medicalConditions:"천식", travelInsurance:"삼성화재 여행자보험"};
  // Hungarian has no static dictionary: both Hungarian attempts are rejected.
  const {body} = await translate({replies:[untranslated], targetLanguageCode:"hu", targetLanguage:"Hungarian"});
  const hungarianErrors = body.attemptErrors.filter((item) => item.languageCode === "hu");
  assert.equal(hungarianErrors.length, 2);
  assert.ok(hungarianErrors.every((item) => item.message === "No medical card field was translated"));
  // The final English attempt only succeeds through the static English dictionary,
  // so it is reported as FALLBACK with the untranslated fields flagged - never SUCCESS.
  assert.notEqual(body.translationStatus, "SUCCESS");
  assert.equal(body.translationStatus, "FALLBACK");
  assert.equal(body.deliveredLanguageCode, "en");
  assert.ok(body.failedItems.length > 0);
  // With no static dictionary to fall back on at all, the result is a total failure.
  const failed = await translate({replies:[untranslated, untranslated, {httpStatus:500}], targetLanguageCode:"hu", targetLanguage:"Hungarian"});
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.translationStatus, "FAILED");
});

test("3: some fields translated, some not -> PARTIAL with failed fields listed and originals kept", async () => {
  const partial = {...FRENCH_OK, travelInsurance:"삼성화재 여행자보험", allergies:"Allergie aux arachides, 갑각류"};
  const {statusCode, body} = await translate({replies:[partial]});
  assert.equal(statusCode, 200);
  assert.equal(body.translationStatus, "PARTIAL");
  assert.deepEqual([...body.failedItems].sort(), ["allergies", "travelInsurance"]);
  assert.equal(body.travelInsurance.includes("삼성화재 여행자보험"), true, "failed field keeps the original text");
  assert.equal(body.reviewNeeded, true);
  assert.ok(body.reviewReasons.includes("FIELD_NOT_TRANSLATED:travelInsurance"));

  const {outcome, html} = renderClient(loadClient(), true, body, "fr");
  assert.equal(outcome.status, "PARTIAL");
  assert.match(html, /일부 항목은 번역되지 않아 입력한 원문 그대로 표시합니다: 알레르기, 여행자 보험/);
  assert.equal((html.match(/번역되지 않음 · 입력한 원문 그대로 표시/g) || []).length, 2);
});

test("4: total failure can no longer come back as an HTTP 200 'success' card", async () => {
  for(const replies of [[{httpStatus:500}], ["not json"], [{httpStatus:429}, "not json", {httpStatus:503}]]){
    const {statusCode, body} = await translate({replies});
    assert.notEqual(statusCode, 200, JSON.stringify(replies));
    assert.equal(body.translationStatus, "FAILED");
  }
  // An empty model reply leaves only what the static French dictionary can map:
  // reported as PARTIAL with the untranslated fields listed, not as SUCCESS.
  const empty = await translate({replies:[{}]});
  assert.equal(empty.body.translationStatus, "PARTIAL");
  assert.ok(empty.body.failedItems.includes("travelInsurance"));
});

test("5: English labels + Korean values are never shown as a successful local card", async () => {
  const client = loadClient();
  // Legacy-shaped body (the old local English fallback): 200, English, Korean values, no status.
  const legacy = {
    _cardTitle:"Medical Card", _labels:{allergies:"Allergies"}, usedLanguage:"English", usedLanguageCode:"en",
    fallbackUsed:true, nationality:"대한민국", allergies:"땅콩, 갑각류", medication:"타이레놀"
  };
  const legacyResult = renderClient(client, true, legacy);
  assert.equal(legacyResult.outcome.status, "FAILED", "a response without an explicit status is a failure");
  assert.doesNotMatch(legacyResult.html, /Medical Card|Allergies/, "rendered as Korean original, not as an English card");
  assert.match(legacyResult.html, /땅콩, 갑각류/);

  // Server: French fails, English fallback returns Korean values. What the static
  // English dictionary maps is shown as English (FALLBACK) and every Korean value
  // left over is flagged - the card is never a local-language success.
  const {statusCode, body} = await translate({replies:[{httpStatus:500}, {httpStatus:500}, {...FRENCH_OK, _cardTitle:"Medical Card", _blankValue:"Not provided", nationality:"대한민국", allergies:"땅콩, 갑각류", medication:"타이레놀, 지르텍", medicalConditions:"천식", travelInsurance:"삼성화재 여행자보험"}]});
  assert.equal(statusCode, 200);
  assert.equal(body.translationStatus, "FALLBACK");
  assert.ok(body.failedItems.includes("travelInsurance"));
  const rendered = renderClient(client, true, body);
  assert.equal(rendered.outcome.status, "FALLBACK");
  assert.match(rendered.html, /대표 현지어 변환이 어려워 영어로 표시합니다/);
  assert.match(rendered.html, /일부 항목은 번역되지 않아 입력한 원문 그대로 표시합니다/);
  assert.match(rendered.html, /medical-pass-lang">English</);
  assert.doesNotMatch(rendered.html, /Français/);
});

test("6: requested language != delivered language -> never SUCCESS", async () => {
  const english = {...FRENCH_OK, _cardTitle:"Medical Card", _blankValue:"Not provided", nationality:"South Korea", allergies:"Peanut allergy, Shellfish allergy", medicalConditions:"Asthma", travelInsurance:"Samsung Fire travel insurance"};
  const {statusCode, body} = await translate({replies:[{httpStatus:500}, {httpStatus:500}, english]});
  assert.equal(statusCode, 200);
  assert.equal(body.deliveredLanguageCode, "en");
  assert.equal(body.languageMatched, false);
  assert.equal(body.translationStatus, "FALLBACK");
  assert.equal(body.fallbackUsed, true);
  assert.ok(body.reviewReasons.includes("DELIVERED_LANGUAGE_DIFFERS_FROM_REQUESTED"));

  const client = loadClient();
  const forged = {...body, translationStatus:"SUCCESS"};
  assert.equal(client.classify(true, forged, "fr").status, "FALLBACK", "client re-checks language identity");
  assert.equal(client.classify(true, {...forged, deliveredLanguageCode:"zh", usedLanguageCode:"zh"}, "zh-TW").status, "FALLBACK", "zh is not zh-TW");
  assert.equal(client.classify(true, {...forged, deliveredLanguageCode:"zh-tw", usedLanguageCode:"zh-tw"}, "zh-TW").status, "SUCCESS");
  const rendered = renderClient(client, true, body);
  assert.match(rendered.html, /대표 현지어 변환이 어려워 영어로 표시합니다/);
});

test("7-11: field safety - passport name, blood type, phone, medication names, multiple allergies", async () => {
  const altered = {...FRENCH_OK,
    passportName:"Hong Gil-dong", bloodType:"A positif", emergencyContact:"+82 (0)10 1234 5678",
    medication:"Paracétamol, Cétirizine", allergies:"Allergie aux arachides, Allergie aux crustacés"};
  const {body} = await translate({replies:[altered]});
  assert.equal(body.passportName, "HONG GILDONG", "7: passport English name unchanged");
  assert.equal(body.bloodType, "A+", "8: blood type unchanged");
  assert.equal(body.emergencyContact, "+82 10-1234-5678", "9: phone number unchanged");
  assert.match(body.medication, /Tylenol/, "10: brand name kept");
  assert.doesNotMatch(body.medication, /Paracétamol/, "10: brand not converted to an ingredient");
  assert.match(body.allergies, /arachides/, "11: first allergy kept");
  assert.match(body.allergies, /crustacés/, "11: second allergy kept");
  assert.match(body.allergies, /땅콩, 갑각류/, "11: original list kept alongside");
  assert.equal(body.age, "34");
  assert.equal(body.hotelAddress, "12 Rue de Rivoli, Paris");
  assert.ok(body.preservedItems.includes("passportName") && body.preservedItems.includes("emergencyContact"));
});

test("12: undefined / null / [object Object] / JSON fragments never reach the card", () => {
  const client = loadClient();
  const hostile = {
    translationStatus:"SUCCESS", deliveredLanguageCode:"fr", usedLanguageCode:"fr", usedLanguage:"Français",
    _labels:{allergies:{text:"x"}}, nationality:{value:"Corée"}, allergies:["a", "b"], medication:null,
    medicalConditions:undefined, travelInsurance:42, hotelAddress:{"x":1}, name:"Hong"
  };
  const {html} = renderClient(client, true, hostile);
  assert.doesNotMatch(html, /\[object Object\]|undefined|null|\{"|"\}/);
  assert.match(html, /대한민국/, "non-string translated value falls back to the Korean original");
});

test("13: on failure the Korean original is preserved and shown as Korean", async () => {
  const client = loadClient();
  const {body} = await translate({replies:[{httpStatus:503}]});
  const {outcome, html} = renderClient(client, false, body);
  assert.equal(outcome.status, "FAILED");
  for(const value of Object.values(CARD)){
    assert.ok(html.includes(value.replace(/'/g, "&#39;")), `original kept: ${value}`);
  }
  assert.match(html, /<span class="check">KO<\/span>/);
  assert.doesNotMatch(html, /medical-pass-card|Carte médicale/);
});

test("14: retryable failures keep the retry path; non-retryable ones do not", async () => {
  const client = loadClient();
  const {body} = await translate({replies:[{httpStatus:500}]});
  assert.deepEqual({...client.classify(false, body, "fr")}, {status:"FAILED", retryable:true, failedItems:client.classify(false, body, "fr").failedItems});
  assert.equal(client.classify(false, {}, "fr").retryable, true, "network/unknown errors stay retryable");
  assert.equal(client.classify(false, {translationStatus:"FAILED", retryable:false}, "fr").retryable, false);

  // Real renderMedicalCardPreview() + bindMedicalCardPreviewControls() with a tiny DOM stub.
  const view = loadRenderer();
  view.setState({status:"error", retryable:true, message:"현지어 번역에 실패했습니다. 아래는 번역되지 않은 한국어 원문입니다."});
  view.render();
  assert.match(view.html(), /id="medicalTranslationRetryBtn"/);
  assert.match(view.html(), /현지어 번역에 실패했습니다/);
  view.click("medicalTranslationRetryBtn");
  assert.equal(view.retries(), 1, "retry button re-requests the translation");

  view.setState({status:"error", retryable:false, message:"x"});
  view.render();
  assert.doesNotMatch(view.html(), /medicalTranslationRetryBtn/);
  view.setState({status:"error", retryable:true, message:"x", offline:true});
  view.render();
  assert.doesNotMatch(view.html(), /medicalTranslationRetryBtn/, "no retry button while offline");
});

test("render path: loading and idle states show the Korean original, not a local-language card", () => {
  const view = loadRenderer();
  for(const status of ["loading", "idle"]){
    view.setState({status, retryable:true, message:""});
    view.render();
    const html = view.html();
    assert.doesNotMatch(html, /medical-pass-card/, `${status}: no local pass card`);
    assert.match(html, /<span class="check">KO<\/span>/, `${status}: rows are marked KO`);
    assert.match(html, /땅콩, 갑각류/);
  }
});

function loadRenderer(){
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {id, innerHTML:"", listeners:{}, addEventListener(type, fn){ this.listeners[type] = fn; }});
  const sandbox = {elements, element, CARD:{...CARD}, retryCount:0};
  evaluateInSandbox(
    `let localLangId = "fr-country";
     let medicalCardView = "local";
     let hasTripCountrySelection = true;
     let tripCountryName = "프랑스";
     let medicalCardTranslation = null;
     let medicalCardTranslationStatus = "idle";
     let medicalCardTranslationMessage = "";
     let medicalCardTranslationRetryable = true;
     let offline = false;
     const KO_LABELS = {name:"이름", passportName:"여권상 영문 이름", nationality:"국적", age:"나이", blood:"혈액형", allergy:"알레르기", medication:"복용 중인 약", condition:"기존 질환", contact:"비상 연락처", insurance:"여행자 보험", hotel:"숙소 주소"};
     function $(id){ return element(id); }
     function safe(fn){ return fn(); }
     function isAppOffline(){ return offline; }
     function getMedicalCardPayload(){ return CARD; }
     function getLocalOption(){ return {native:"Français"}; }
     function getTripOption(){ return {countryKo:"프랑스"}; }
     function getMedicalLabels(id){ return KO_LABELS; }
     function getMedicalI18n(){ return {cardTitle:"Carte médicale", blankValue:"Non renseigné", labels:KO_LABELS}; }
     function getSelectedCountryForTranslation(){ return {fallbackLanguageCode:""}; }
     function showLocalMedicalCard(){ retryCount += 1; }
     ${extractFunction(appSource, "escapeHtml")}
     ${extractFunction(appSource, "medicalFields")}
     ${extractConst(appSource, "medicalValueFields")}
     ${extractFunction(appSource, "getMedicalCardTitle")}
     ${extractFunction(appSource, "getMedicalMissingText")}
     ${extractFunction(appSource, "fallbackLanguageDisplayName")}
     ${extractFunction(appSource, "medicalFallbackNoticeHtml")}
     ${extractFunction(appSource, "medicalTranslationStatusNoticeHtml")}
     ${extractFunction(appSource, "medicalRowsHtml")}
     ${extractFunction(appSource, "medicalPassCardHtml")}
     ${extractFunction(appSource, "romanizationNoticeHtml")}
     ${extractFunction(appSource, "bindMedicalCardPreviewControls")}
     ${extractFunction(appSource, "renderMedicalCardPreview")}
     this.view = {
       setState(next){ medicalCardTranslationStatus = next.status; medicalCardTranslationRetryable = next.retryable; medicalCardTranslationMessage = next.message; offline = Boolean(next.offline); medicalCardTranslation = next.translation || null; },
       render(){ for(const key of Object.keys(elements)) delete elements[key]; renderMedicalCardPreview(); },
       html(){ return element("medicalCardPreview").innerHTML; },
       click(id){ const target = elements[id]; if(target && target.listeners.click) target.listeners.click(); },
       retries(){ return retryCount; }
     };`,
    sandbox,
    "index.html"
  );
  // The stub only creates elements that the code asks for; mark the retry button
  // as present only when it is actually rendered.
  const view = sandbox.view;
  return {
    ...view,
    render(){
      view.render();
      if(!/id="medicalTranslationRetryBtn"/.test(view.html())) delete sandbox.elements.medicalTranslationRetryBtn;
    },
    click(id){
      if(id === "medicalTranslationRetryBtn" && !/id="medicalTranslationRetryBtn"/.test(view.html())) return;
      view.click(id);
    },
    retries(){ return sandbox.retryCount; }
  };
}

test("Traditional Chinese identity is kept: zh-TW request is not satisfied by zh", async () => {
  const {body} = await translate({replies:[{httpStatus:500}, {httpStatus:500}, {...FRENCH_OK}], targetLanguageCode:"zh-TW", targetLanguage:"Traditional Chinese",
    extraBody:{fallbackLanguageCode:"zh", fallbackLanguageNameEn:"Chinese"}});
  assert.notEqual(body.translationStatus, "SUCCESS");
  if(body.translationStatus !== "FAILED"){
    assert.equal(body.languageMatched, false);
    assert.equal(body.translationStatus, "FALLBACK");
  }
});
