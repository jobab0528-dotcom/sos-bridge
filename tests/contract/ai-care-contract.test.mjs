// Contract: AI Care server response contract.
// Runs the real netlify/functions/ai-care.js handler in a vm sandbox with a
// stubbed OpenAI fetch (no network, no cost) and fixes the shape and safety
// invariants of the JSON the server returns - independent of the UI tests in
// tests/p0/ai-care-language-safety.test.cjs.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {readRepoFile, forbidNetwork} from "./_source.mjs";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const AI_CARE_SOURCE = readRepoFile("netlify/functions/ai-care.js");
const DEFAULT_ENGLISH = "I need help. Please call medical staff or an ambulance.";
const restoreFetch = forbidNetwork();
test.after(restoreFetch);

function comparable(value){
  return String(value || "").toLowerCase().replace(/[\s.,!?;:'"’“”()\-]+/g, "");
}

async function callHandler({model, event, env = {OPENAI_API_KEY:"stub-not-a-real-key"}, upstreamStatus = 200}){
  const fetchCalls = [];
  const module = {exports:{}};
  const sandbox = {
    module,
    exports:module.exports,
    console:{log(){}, warn(){}, error(){}},
    process:{env},
    fetch:async (url, options) => {
      fetchCalls.push({url, options});
      assert.equal(url, OPENAI_URL, "only the (stubbed) OpenAI endpoint may be called");
      const content = typeof model === "string" ? model : JSON.stringify(model);
      return {
        ok:upstreamStatus >= 200 && upstreamStatus < 300,
        status:upstreamStatus,
        json:async () => upstreamStatus >= 300 ? {error:{message:"stub upstream error"}} : {choices:[{message:{content}}]}
      };
    }
  };
  vm.runInNewContext(AI_CARE_SOURCE, sandbox, {filename:"netlify/functions/ai-care.js"});
  const response = await sandbox.exports.handler(event);
  return {statusCode:response.statusCode, headers:response.headers, body:JSON.parse(response.body), fetchCalls};
}

function postEvent(payload){
  return {httpMethod:"POST", body:JSON.stringify({symptom:"배가 너무 아파요", emergencyNumber:"112", ...payload})};
}

const LOCAL_PHRASE_FIELDS = {
  localPhraseKo:"string",
  localPhraseLocal:"string",
  localPhraseRequestedLanguageCode:"string",
  localPhraseStatus:"string",
  localPhraseVerified:"boolean",
  localPhraseReviewNeeded:"boolean",
  localPhraseReviewReason:"string",
  localPhraseFallbackUsed:"boolean",
  localPhraseEn:"string",
  localPhraseEnLanguageCode:"string",
  localPhraseEnIsDefault:"boolean"
};

function assertLocalPhraseContract(body, requestedLanguage, label){
  for(const [field, type] of Object.entries(LOCAL_PHRASE_FIELDS)){
    assert.equal(typeof body[field], type, `${label}: ${field} is ${type}`);
  }
  assert.equal(body.localPhraseLanguageCode, null, `${label}: server never claims an actual local language`);
  assert.equal(body.localPhraseVerified, false, `${label}: server never self-verifies`);
  assert.equal(body.localPhraseReviewNeeded, true, `${label}: review always needed`);
  assert.equal(body.localPhraseFallbackUsed, false, `${label}: no substitution into the local slot`);
  assert.ok(["UNVERIFIED", "FAILED"].includes(body.localPhraseStatus), `${label}: status ${body.localPhraseStatus}`);
  assert.equal(body.localPhraseStatus, body.localPhraseLocal ? "UNVERIFIED" : "FAILED", `${label}: status matches presence`);
  assert.equal(body.localPhraseRequestedLanguageCode, requestedLanguage, `${label}: requested language echoed`);
  assert.equal(body.localPhraseEnLanguageCode, "en", `${label}: English keeps English identity`);
  assert.ok(body.localPhraseEn.trim(), `${label}: English reference phrase present`);
  if(!requestedLanguage.toLowerCase().startsWith("en") && body.localPhraseLocal){
    assert.notEqual(comparable(body.localPhraseLocal), comparable(body.localPhraseEn), `${label}: English not promoted to local`);
    assert.notEqual(comparable(body.localPhraseLocal), comparable(DEFAULT_ENGLISH), `${label}: default English not promoted to local`);
  }
}

const MODEL_VARIANTS = {
  "local missing":{level:"urgent", localPhraseEn:"My stomach hurts."},
  "local identical to English":{level:"urgent", localPhraseEn:"My stomach hurts.", localPhraseLocal:"My stomach hurts."},
  "local equals default English":{level:"urgent", localPhraseLocal:DEFAULT_ENGLISH},
  "local via localPhraseNative":{level:"urgent", localPhraseEn:"My stomach hurts.", localPhraseNative:"J'ai mal au ventre."},
  "plausible local phrase":{level:"urgent", localPhraseEn:"My stomach hurts.", localPhraseLocal:"J'ai très mal au ventre."},
  "empty model object":{},
  "model tries to self-verify":{
    level:"urgent", localPhraseEn:"My stomach hurts.", localPhraseLocal:"J'ai très mal au ventre.",
    localPhraseVerified:true, localPhraseStatus:"VERIFIED_LOCAL", localPhraseLanguageCode:"fr",
    localPhraseReviewNeeded:false, localPhraseFallbackUsed:true
  }
};

for(const requestedLanguage of ["fr", "ja", "zh-TW", "fil", "en", "ko"]){
  for(const [variant, model] of Object.entries(MODEL_VARIANTS)){
    test(`server contract holds: lang=${requestedLanguage}, ${variant}`, async () => {
      const result = await callHandler({model, event:postEvent({localLanguage:requestedLanguage})});
      assert.equal(result.statusCode, 200);
      assert.equal(result.fetchCalls.length, 1);
      assert.equal(result.headers["Cache-Control"], "no-store");
      assertLocalPhraseContract(result.body, requestedLanguage, `${requestedLanguage}/${variant}`);
    });
  }
}

test("model-supplied verification flags are ignored, never passed through", async () => {
  const {body} = await callHandler({model:MODEL_VARIANTS["model tries to self-verify"], event:postEvent({localLanguage:"fr"})});
  assert.equal(body.localPhraseVerified, false);
  assert.equal(body.localPhraseStatus, "UNVERIFIED");
  assert.equal(body.localPhraseLanguageCode, null);
  assert.equal(body.localPhraseReviewNeeded, true);
  assert.equal(body.localPhraseFallbackUsed, false);
});

test("core triage fields keep their types and conservative defaults", async () => {
  const {body} = await callHandler({model:{level:"not-a-level", recommendedAction:"bogus"}, event:postEvent({localLanguage:"fr"})});
  assert.equal(body.level, "urgent", "unknown urgency is treated conservatively");
  assert.equal(body.recommendedAction, "hospital");
  for(const field of ["reasons", "steps", "avoid", "monitor", "questions"]){
    assert.ok(Array.isArray(body[field]) && body[field].length > 0, `${field} is a non-empty array`);
  }
  for(const field of ["title", "summary", "recommendedDepartment"]){
    assert.equal(typeof body[field], "string", field);
  }
  assert.equal(typeof body.needsAmbulance, "boolean");
});

test("emergency model output keeps emergency guidance", async () => {
  const {body} = await callHandler({model:{level:"emergency", needsAmbulance:true, localPhraseEn:"Call an ambulance."}, event:postEvent({localLanguage:"fr"})});
  assert.equal(body.level, "emergency");
  assert.equal(body.needsAmbulance, true);
  assert.equal(body.recommendedAction, "emergency");
  assert.equal(body.recommendedDepartment, "응급의학과");
});

test("error paths: method, input, configuration and upstream failures", async () => {
  const notPost = await callHandler({model:{}, event:{httpMethod:"GET"}});
  assert.equal(notPost.statusCode, 405);
  assert.equal(notPost.fetchCalls.length, 0);

  const badJson = await callHandler({model:{}, event:{httpMethod:"POST", body:"{not json"}});
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.fetchCalls.length, 0);

  const noSymptom = await callHandler({model:{}, event:{httpMethod:"POST", body:JSON.stringify({localLanguage:"fr"})}});
  assert.equal(noSymptom.statusCode, 400);
  assert.equal(noSymptom.fetchCalls.length, 0);

  const noKey = await callHandler({model:{}, env:{}, event:postEvent({localLanguage:"fr"})});
  assert.equal(noKey.statusCode, 500);
  assert.equal(noKey.fetchCalls.length, 0, "no upstream call without a configured key");

  const malformed = await callHandler({model:"not json at all", event:postEvent({localLanguage:"fr"})});
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.body.error, "AI Care request failed");

  const upstream = await callHandler({model:{}, upstreamStatus:503, event:postEvent({localLanguage:"fr"})});
  assert.equal(upstream.statusCode, 502);
  assert.equal(upstream.body.error, "AI Care request failed");
});
