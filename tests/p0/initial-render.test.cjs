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

function startupHarness(storedValue){
  const calls = [];
  let stored = storedValue;
  const sandbox = {
    window:{
      localStorage:{
        getItem(){ return stored; },
        removeItem(){ calls.push("removeStoredCountry"); stored = null; }
      }
    },
    console:{warn(){}},
    calls
  };
  vm.runInNewContext(
    `const SELECTED_COUNTRY_STORAGE_KEY = "sosBridgeSelectedCountryCode";
     const countryDataLoaded = true;
     const languageOptions = [
       {id:"ko", countryCode:"KR"},
       {id:"ja", countryCode:"JP"}
     ];
     let confirmedTripCountryCode = "";
     function selectTripCountry(id, options){ calls.push(["selectTripCountry", id, options.render]); }
     function showApp(){ calls.push("showApp"); }
     function renderAll(){ calls.push("renderAll"); }
     ${extractNamedFunction(indexSource, "clearStoredSelectedCountryCode")}
     ${extractNamedFunction(indexSource, "getStoredSelectedCountryCode")}
     ${extractNamedFunction(indexSource, "restoreStoredSelectedCountry")}
     ${extractNamedFunction(indexSource, "renderInitialAppState")}
     this.restore = restoreStoredSelectedCountry;
     this.renderInitial = renderInitialAppState;
     this.confirmed = () => confirmedTripCountryCode;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

test("initial markup shields both application screens before bootstrap", () => {
  assert.match(indexSource, /body\.app-booting #languagePage,body\.app-booting #appPage\{visibility:hidden;pointer-events:none\}/);
  assert.match(indexSource, /<body class="sos-modern-ui app-booting" aria-busy="true">/);
  assert.match(indexSource, /<main id="languagePage" class="page">/);
  assert.match(indexSource, /<main id="appPage" class="page hidden content-pad">/);
});

test("app script runs as a classic parser-blocking script after countries.js and before the trailing inline scripts", () => {
  const shellSource = fs.readFileSync(INDEX_PATH, "utf8");
  const appSource = fs.readFileSync(LEGACY_APP_PATH, "utf8");
  const scripts = [...shellSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({attributes:match[1].trim(), body:match[2]}));
  assert.equal(scripts.length, 4);
  assert.equal(scripts[0].attributes, 'src="./countries.js"');
  assert.equal(scripts[1].attributes, 'src="./src/app/legacy-app.js"');
  assert.equal(scripts[1].body, "");
  assert.equal(scripts[2].attributes, "");
  assert.match(scripts[2].body, /navigator\.serviceWorker\.register\("\.\/service-worker\.js"\)/);
  assert.equal(scripts[3].attributes, "");
  assert.match(scripts[3].body, /sosTest/);
  assert.ok(scripts.every((script) => !script.body.includes("PRIORITY_COUNTRY_CODES")), "no inline copy of the app script remains");
  assert.match(appSource, /^\(function\(\)\{\r?\n"use strict";\r?\n/);
  assert.match(appSource, /\r?\n\}\)\(\);\r?\n$/);
  assert.doesNotMatch(appSource, /<\/?script\b/i);
  assert.doesNotMatch(appSource, /^\s*(?:import|export)\b/m);
});

test("missing stored country resolves to the country-selection render", () => {
  const app = startupHarness(null);
  const restored = app.restore();
  app.renderInitial(restored);
  assert.equal(restored, false);
  assert.deepEqual(app.calls, ["renderAll"]);
});

test("valid stored country resolves before the first meaningful app render", () => {
  const app = startupHarness(" jp ");
  const restored = app.restore();
  app.renderInitial(restored);
  assert.equal(restored, true);
  assert.equal(app.confirmed(), "JP");
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls)), [["selectTripCountry", "ja", false], "showApp"]);
});

test("invalid stored country is cleared and falls back safely", () => {
  const app = startupHarness("ZZ");
  const restored = app.restore();
  app.renderInitial(restored);
  assert.equal(restored, false);
  assert.deepEqual(app.calls, ["removeStoredCountry", "renderAll"]);
});

test("bootstrap resolves state before releasing the guard and always releases in finally", () => {
  const initSource = extractNamedFunction(indexSource, "init");
  const restoreIndex = initSource.indexOf("const restoredSelectedCountry = restoreStoredSelectedCountry()");
  const renderIndex = initSource.indexOf("renderInitialAppState(restoredSelectedCountry)");
  const finallyIndex = initSource.indexOf("finally");
  const releaseIndex = initSource.indexOf("finishAppBootstrap()", finallyIndex);
  assert.ok(restoreIndex >= 0 && renderIndex > restoreIndex);
  assert.ok(finallyIndex > renderIndex && releaseIndex > finallyIndex);
  const releaseSource = extractNamedFunction(indexSource, "finishAppBootstrap");
  assert.match(releaseSource, /classList\.remove\("app-booting"\)/);
  assert.match(releaseSource, /removeAttribute\("aria-busy"\)/);
});

test("home symptom subtitle is the exact approved text", () => {
  const descriptionsStart = indexSource.indexOf("const serviceDescriptions = {");
  assert.notEqual(descriptionsStart, -1);
  const descriptionsEnd = indexSource.indexOf("};", descriptionsStart);
  const descriptions = indexSource.slice(descriptionsStart, descriptionsEnd + 2);
  assert.match(descriptions, /symptom: "위험 신호와 다음 행동 안내"/);
  assert.doesNotMatch(descriptions, /위험 신호와 다음 행동을 참고용으로 정리/);
  assert.doesNotMatch(descriptions, /위험 신호·다음 행동 안내/);
});
