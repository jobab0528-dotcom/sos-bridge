"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const INDEX_PATH = path.join(ROOT, "index.html");
const indexSource = fs.readFileSync(INDEX_PATH, "utf8");

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
