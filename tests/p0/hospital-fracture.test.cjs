"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const INDEX_PATH = path.join(ROOT, "index.html");
const LEGACY_APP_PATH = path.join(ROOT, "src", "app", "legacy-app.js");
// Production front-end source: the HTML shell plus the app script it loads.
const indexSource = fs.readFileSync(INDEX_PATH, "utf8") + "\n" + fs.readFileSync(LEGACY_APP_PATH, "utf8");

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

function loadRecommendationFunction(){
  const sandbox = {};
  vm.runInNewContext(
    `${extractNamedFunction(indexSource, "hasAnyText")}
     ${extractNamedFunction(indexSource, "makeHospitalRecommendation")}
     ${extractNamedFunction(indexSource, "getBodyPartHospitalRecommendation")}
     this.recommend = getBodyPartHospitalRecommendation;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox.recommend;
}

test("fractured leg keeps the orthopedics and surgery recommendation", () => {
  const recommend = loadRecommendationFunction();
  const result = recommend("다리가 부러졌어", {category:"injury", recommended:"hospital"});
  assert.equal(result.label, "정형외과·외과 추천");
  assert.doesNotMatch(result.label, /안과|치과|피부과|산부인과/);
});

function loadSymptomToHospitalRecommendation(){
  const sandbox = {};
  vm.runInNewContext(
    `${extractNamedFunction(indexSource, "analyzeSymptoms")}
     ${extractNamedFunction(indexSource, "hasAnyText")}
     ${extractNamedFunction(indexSource, "makeHospitalRecommendation")}
     ${extractNamedFunction(indexSource, "getHospitalRecommendationFromTriage")}
     ${extractNamedFunction(indexSource, "getBodyPartHospitalRecommendation")}
     ${extractNamedFunction(indexSource, "isEmergencyHospitalRecommendation")}
     this.recommendFromInput = (input) => {
       const triage = analyzeSymptoms(input);
       const recommendation = getBodyPartHospitalRecommendation(input, triage);
       return {triage, recommendation, emergencySearch:isEmergencyHospitalRecommendation(recommendation)};
     };`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox.recommendFromInput;
}

test("traffic accident input stays on the emergency-room hospital recommendation path", () => {
  const recommendFromInput = loadSymptomToHospitalRecommendation();
  for(const input of ["교통사고 당했어", "교통사고를 당했어요", "교통사고로 다리 다쳤어"]){
    const {triage, recommendation, emergencySearch} = recommendFromInput(input);
    assert.equal(triage.category, "vehicle-trauma", input);
    assert.equal(triage.recommended, "emergency", input);
    assert.equal(recommendation.label, "응급실·응급의학과 우선 추천", input);
    assert.equal(recommendation.emergencyContext, true, input);
    assert.equal(emergencySearch, true, input);
  }
  const fracture = recommendFromInput("다리가 부러졌어");
  assert.equal(fracture.recommendation.label, "정형외과·외과 추천");
  assert.equal(fracture.emergencySearch, false);
});
