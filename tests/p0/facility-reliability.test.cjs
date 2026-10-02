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
  const asyncStart = source.indexOf(`async function ${name}(`);
  const regularStart = source.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : regularStart;
  assert.notEqual(start, -1, `${name} declaration missing`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for(let index = parametersStart; index < source.length; index += 1){
    if(source[index] === "(") parameterDepth += 1;
    if(source[index] === ")"){
      parameterDepth -= 1;
      if(parameterDepth === 0){ parametersEnd = index; break; }
    }
  }
  const bodyStart = source.indexOf("{", parametersEnd);
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
    if(char === '"' || char === "'" || char === "`"){ quote = char; continue; }
    if(char === "{") depth += 1;
    if(char === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} closing brace missing`);
}

function response(body, status = 200){
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(){ return typeof body === "string" ? body : JSON.stringify(body); }
  };
}

function success(overrides = {}){
  return {
    ok: true,
    schemaVersion: "1",
    provider: "primary",
    attemptsUsed: 1,
    searchRadiusMeters: 5000,
    complete: true,
    elements: [],
    ...overrides
  };
}

function loadClient(fetchImpl, timeoutMs = 50, currentCheck = () => true){
  const sandbox = {fetch: fetchImpl, AbortController, setTimeout, clearTimeout, currentCheck};
  const names = [
    "createFacilitySearchError",
    "normalizeFacilityProxyErrorCode",
    "validateFacilityProxySuccess",
    "fetchFacilityProxy"
  ];
  vm.runInNewContext(
    `const FACILITY_PROXY_URL = "/.netlify/functions/nearby-facilities";
     const FACILITY_PROXY_MAX_RADIUS_METERS = 50000;
     const FACILITY_PROXY_REQUEST_TIMEOUT_MS = ${timeoutMs};
     const FACILITY_PROXY_ALLOWED_RADII = new Set([5000, 10000, 20000, 50000]);
     const FACILITY_PROXY_ERROR_CODES = new Set([
       "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", "FACILITY_QUERY_ERROR", "FACILITY_TIMEOUT",
       "FACILITY_INVALID_RESPONSE", "FACILITY_RATE_LIMITED", "FACILITY_INVALID_REQUEST"
     ]);
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(request){ return this.currentCheck(request); }
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     isFacilitySearchCurrent = function(request){ return this.currentCheck(request); };
     this.run = fetchFacilityProxy;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

async function rejectedCode(promise){
  try{
    await promise;
    assert.fail("expected rejection");
  }catch(error){
    return error.code;
  }
}

test("A hospital uses one same-origin proxy POST", async () => {
  const calls = [];
  const sandbox = loadClient(async (url, options) => {
    calls.push({url, options});
    return response(success());
  });
  const data = await sandbox.run("hospital", {latitude:35.6762, longitude:139.6503});
  assert.equal(data.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/nearby-facilities");
  assert.equal(calls[0].options.method, "POST");
});

test("B pharmacy type is preserved in the strict Function request", async () => {
  let payload;
  const sandbox = loadClient(async (url, options) => {
    payload = JSON.parse(options.body);
    return response(success());
  });
  await sandbox.run("pharmacy", {latitude:35.6762, longitude:139.6503});
  assert.equal(payload.type, "pharmacy");
  assert.equal(payload.schemaVersion, "1");
});

test("C Function service unavailable remains a service error", async () => {
  const sandbox = loadClient(async () => response({
    ok:false,
    schemaVersion:"1",
    code:"FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE",
    retryable:true,
    attemptsUsed:4
  }, 503));
  assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
});

test("D browser-to-Function timeout remains distinct", async () => {
  const sandbox = loadClient(async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, {once:true});
  }), 5);
  assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), "FACILITY_TIMEOUT");
});

test("E malformed Function JSON is FACILITY_INVALID_RESPONSE", async () => {
  const sandbox = loadClient(async () => response("<html>not json</html>"));
  assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), "FACILITY_INVALID_RESPONSE");
});

test("F explicit partial response metadata is accepted", async () => {
  const sandbox = loadClient(async () => response(success({
    attemptsUsed:3,
    complete:false,
    code:"FACILITY_PARTIAL_RESULTS",
    incompleteReason:"FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"
  })));
  const data = await sandbox.run("hospital", {latitude:1, longitude:2});
  assert.equal(data.complete, false);
  assert.equal(data.code, "FACILITY_PARTIAL_RESULTS");
});

test("G proxy request contains exactly five allowlisted fields", async () => {
  let payload;
  const sandbox = loadClient(async (url, options) => {
    payload = JSON.parse(options.body);
    return response(success());
  });
  await sandbox.run("hospital", {latitude:35.6762, longitude:139.6503}, {recommendation:{symptom:"private"}});
  assert.deepEqual(Object.keys(payload).sort(), ["latitude", "longitude", "maxRadiusMeters", "schemaVersion", "type"]);
  assert.equal("query" in payload, false);
  assert.equal("symptom" in payload, false);
});

function loadLocationClassifier(){
  const sandbox = {};
  vm.runInNewContext(
    `${extractNamedFunction(indexSource, "getFacilityLocationErrorState")}
     this.classify = getFacilityLocationErrorState;`,
    sandbox,
    {filename:INDEX_PATH}
  );
  return sandbox.classify;
}

test("H GPS permission denied stays distinct from facility service errors", () => {
  const state = loadLocationClassifier()({code:1});
  assert.equal(state.code, "LOCATION_PERMISSION_ERROR");
  assert.match(state.message, /위치 권한/);
});

test("I GPS timeout stays distinct from facility service errors", () => {
  const state = loadLocationClassifier()({code:3});
  assert.equal(state.code, "LOCATION_TIMEOUT");
  assert.match(state.message, /시간이 초과/);
});

test("J HTTP 200 complete empty elements remains NO RESULTS data", async () => {
  const sandbox = loadClient(async () => response(success({attemptsUsed:4, searchRadiusMeters:50000, elements:[]})));
  const data = await sandbox.run("hospital", {latitude:1, longitude:2});
  assert.equal(data.complete, true);
  assert.equal(data.elements.length, 0);
});

test("K frontend contains no public Overpass endpoint or raw query builder", () => {
  assert.doesNotMatch(indexSource, /overpass-api\.de|overpass\.private\.coffee/);
  assert.doesNotMatch(indexSource, /function\s+buildOverpassQuery|function\s+fetchOverpass/);
});

test("L invalid success schema is rejected before mapping", async () => {
  const sandbox = loadClient(async () => response(success({attemptsUsed:5})));
  assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), "FACILITY_INVALID_RESPONSE");
});

function loadGenerationSandbox(){
  const sandbox = {};
  const names = [
    "snapshotFacilityRecommendation",
    "beginFacilitySearch",
    "isFacilitySearchGenerationCurrent",
    "isFacilitySearchCurrent",
    "facilityResultsMatchRequest",
    "commitFacilitySearchResults"
  ];
  vm.runInNewContext(
    `let facilitySearchGeneration = 0;
     let activeFacilitySearchRequest = null;
     let facilityType = "hospital";
     let facilities = [];
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     this.begin = function(type){ facilityType=type; return beginFacilitySearch(type); };
     this.commit = commitFacilitySearchResults;
     this.getFacilities = () => facilities;`,
    sandbox,
    {filename:INDEX_PATH}
  );
  return sandbox;
}

function hostIds(list){ return Array.from(list, (item) => item.id); }

test("M late hospital generation cannot overwrite current pharmacy results", () => {
  const sandbox = loadGenerationSandbox();
  const stale = sandbox.begin("hospital");
  const current = sandbox.begin("pharmacy");
  assert.equal(sandbox.commit(current, [{id:"current-pharmacy", type:"pharmacy"}]), true);
  assert.equal(sandbox.commit(stale, [{id:"late-hospital", type:"hospital"}]), false);
  assert.deepEqual(hostIds(sandbox.getFacilities()), ["current-pharmacy"]);
});

test("N late pharmacy generation cannot overwrite current hospital results", () => {
  const sandbox = loadGenerationSandbox();
  const stale = sandbox.begin("pharmacy");
  const current = sandbox.begin("hospital");
  assert.equal(sandbox.commit(current, [{id:"current-hospital", type:"hospital"}]), true);
  assert.equal(sandbox.commit(stale, [{id:"late-pharmacy", type:"pharmacy"}]), false);
  assert.deepEqual(hostIds(sandbox.getFacilities()), ["current-hospital"]);
});

test("O JP selection does not replace actual GPS coordinates", () => {
  let applied = null;
  const element = {classList:{remove(){}}, innerHTML:""};
  const sandbox = {
    window:{isSecureContext:true},
    navigator:{geolocation:{getCurrentPosition(success){ success({coords:{latitude:37.5665, longitude:126.9780, accuracy:12}}); }}},
    tripCountryId:"ja",
    confirmedTripCountryCode:"JP",
    facilityRecommendation:null,
    activeService:"",
    facilityType:"hospital",
    facilities:[],
    facilitySearchErrorMessage:"",
    facilitySearchErrorCode:"",
    locationData:null,
    isLoading:false,
    isAppOffline(){ return false; },
    isFacilitySearchCurrent(){ return true; },
    t(){ return {}; },
    moveFacilityCardToScreen(){},
    showFlowScreen(){},
    renderServices(){},
    renderFacilityList(){},
    setStatus(){},
    showOfflineFeatureNotice(){},
    on(){},
    $(){ return element; },
    applyLocation(request, loc){ applied = {request, loc}; }
  };
  vm.runInNewContext(
    `${extractNamedFunction(indexSource, "getFacilityLocationErrorState")}
     ${extractNamedFunction(indexSource, "startGpsAfterConsent")}
     this.run = startGpsAfterConsent;`,
    sandbox,
    {filename:INDEX_PATH}
  );
  sandbox.run({type:"hospital", recommendation:null});
  assert.equal(applied.loc.latitude, 37.5665);
  assert.equal(applied.loc.longitude, 126.9780);
});

test("P one frontend search request cannot multiply provider attempts", async () => {
  let calls = 0;
  let payload;
  const sandbox = loadClient(async (url, options) => {
    calls += 1;
    payload = JSON.parse(options.body);
    return response(success({attemptsUsed:4, searchRadiusMeters:50000}));
  });
  const data = await sandbox.run("hospital", {latitude:37.5665, longitude:126.9780});
  assert.equal(calls, 1);
  assert.equal(payload.maxRadiusMeters, 50000);
  assert.equal(data.attemptsUsed, 4);
});

function retryOutcome(code, status = 0){
  return {code, status};
}

function retrySuccess(type, id){
  return {value:[{id, type}]};
}

function loadAutoRetrySandbox(type, outcomes, waitAction = "none"){
  const statuses = [];
  const delays = [];
  const sandbox = {
    outcomes:outcomes.slice(),
    statuses,
    delays,
    waitAction,
    setTimeout(callback, delayMs){
      delays.push(delayMs);
      if(typeof sandbox.applyWaitAction === "function") sandbox.applyWaitAction();
      callback();
      return 1;
    }
  };
  const names = [
    "isFacilityAutoRetryEligible",
    "isFacilitySearchResultContextCurrent",
    "waitForFacilityAutoRetry",
    "fetchNearbyFacilitiesWithSingleAutoRetry"
  ];
  vm.runInNewContext(
    `const FACILITY_AUTO_RETRY_DELAY_MS = 0;
     const FACILITY_RATE_LIMIT_RETRY_DELAY_MS = 1500;
     let calls = 0;
     let currentType = this.inputType;
     let currentFlowScreen = currentType === "pharmacy" ? "screen-pharmacy-results" : "screen-hospital-results";
     let activeRequest = {type:currentType, generation:1, autoRetrying:false};
     let visibleResults = [];
     const originalRequest = activeRequest;
     const plannedOutcomes = this.outcomes;
     const observedStatuses = this.statuses;
     function isFacilitySearchCurrent(request){ return request === activeRequest && request.type === currentType; }
     function setStatus(message){ observedStatuses.push(message); }
     function renderFacilityList(){}
     async function fetchNearbyFacilities(){
       calls += 1;
       const outcome = plannedOutcomes.shift();
       if(outcome && outcome.code){
         const error = new Error(outcome.code);
         error.code = outcome.code;
         error.status = outcome.status || 0;
         if(typeof outcome.retryable === "boolean") error.retryable = outcome.retryable;
         throw error;
       }
       return outcome && outcome.value;
     }
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     this.applyWaitAction = () => {
       if(this.waitAction === "home") currentFlowScreen = "screen-home";
       if(this.waitAction === "new-hospital"){
         activeRequest = {type:"hospital", generation:2, autoRetrying:false};
         currentType = "hospital";
         currentFlowScreen = "screen-hospital-results";
       }
       if(this.waitAction === "pharmacy"){
         activeRequest = {type:"pharmacy", generation:2, autoRetrying:false};
         currentType = "pharmacy";
         currentFlowScreen = "screen-pharmacy-results";
         visibleResults = [{id:"current-pharmacy", type:"pharmacy"}];
       }
     };
     this.run = () => fetchNearbyFacilitiesWithSingleAutoRetry(
       originalRequest.type,
       {latitude:35.6762, longitude:139.6503, source:"gps"},
       null,
       originalRequest
     );
     this.getCalls = () => calls;
     this.getVisibleResults = () => visibleResults;`,
    Object.assign(sandbox, {inputType:type}),
    {filename:INDEX_PATH}
  );
  return sandbox;
}

test("AUTO A hospital timeout retries once and succeeds with exactly two Function calls", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_TIMEOUT"),
    retrySuccess("hospital", "retry-success")
  ]);
  const result = await sandbox.run();
  assert.equal(sandbox.getCalls(), 2);
  assert.deepEqual(hostIds(result), ["retry-success"]);
  assert.equal(sandbox.statuses.includes("병원 정보를 다시 확인하고 있습니다..."), true);
});

test("AUTO B two hospital timeouts stop after two Function calls and expose the final error", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_TIMEOUT"),
    retryOutcome("FACILITY_TIMEOUT")
  ]);
  await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_TIMEOUT");
  assert.equal(sandbox.getCalls(), 2);
});

test("AUTO C HTTP 400 and 422 invalid requests are never retried", async () => {
  for(const status of [400, 422]){
    const sandbox = loadAutoRetrySandbox("hospital", [
      retryOutcome("FACILITY_INVALID_REQUEST", status),
      retrySuccess("hospital", "must-not-run")
    ]);
    await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_INVALID_REQUEST");
    assert.equal(sandbox.getCalls(), 1);
  }
});

test("AUTO D GPS permission denial performs zero Function calls", () => {
  let functionCalls = 0;
  const elements = {facilityCard:{classList:{remove(){}}}, facilityList:{innerHTML:""}};
  const sandbox = {
    window:{isSecureContext:true},
    navigator:{geolocation:{getCurrentPosition(success, failure){ failure({code:1}); }}},
    elements
  };
  vm.runInNewContext(
    `let facilityRecommendation = null;
     let activeService = "";
     let facilityType = "hospital";
     let facilities = [];
     let facilitySearchErrorMessage = "";
     let facilitySearchErrorCode = "";
     let locationData = null;
     let isLoading = false;
     function isFacilitySearchCurrent(){ return true; }
     function isAppOffline(){ return false; }
     function t(){ return {}; }
     function moveFacilityCardToScreen(){}
     function showFlowScreen(){}
     function renderServices(){}
     function renderFacilityList(){}
     function setStatus(){}
     function showOfflineFeatureNotice(){}
     function on(){}
     function requestGps(){}
     function $(id){ return this.elements[id]; }
     function applyLocation(){ this.functionCalls += 1; }
     ${extractNamedFunction(indexSource, "getFacilityLocationErrorState")}
     ${extractNamedFunction(indexSource, "startGpsAfterConsent")}
     startGpsAfterConsent({type:"hospital", recommendation:null});`,
    Object.assign(sandbox, {functionCalls}),
    {filename:INDEX_PATH}
  );
  assert.equal(sandbox.functionCalls, 0);
});

test("AUTO E successful pharmacy search remains a single Function call with no retry", async () => {
  const sandbox = loadAutoRetrySandbox("pharmacy", [retrySuccess("pharmacy", "pharmacy-success")]);
  const result = await sandbox.run();
  assert.equal(sandbox.getCalls(), 1);
  assert.deepEqual(hostIds(result), ["pharmacy-success"]);
  assert.equal(sandbox.statuses.length, 0);
});

test("AUTO F a new search generation during retry wait cancels the delayed retry", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"),
    retrySuccess("hospital", "stale-retry")
  ], "new-hospital");
  assert.equal(await sandbox.run(), null);
  assert.equal(sandbox.getCalls(), 1);
});

test("AUTO G hospital retry cannot mix results after pharmacy becomes current", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_TIMEOUT"),
    retrySuccess("hospital", "late-hospital")
  ], "pharmacy");
  assert.equal(await sandbox.run(), null);
  assert.equal(sandbox.getCalls(), 1);
  assert.deepEqual(hostIds(sandbox.getVisibleResults()), ["current-pharmacy"]);
});

test("AUTO H leaving the results screen during retry wait cancels the delayed retry", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_TIMEOUT"),
    retrySuccess("hospital", "must-not-render-at-home")
  ], "home");
  assert.equal(await sandbox.run(), null);
  assert.equal(sandbox.getCalls(), 1);
});

test("AUTO I a successful empty hospital result is data, not a retry trigger", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [{value:[]}]);
  assert.deepEqual(hostIds(await sandbox.run()), []);
  assert.equal(sandbox.getCalls(), 1);
});

test("AUTO J a pharmacy transient failure is exposed after one Function call without automatic retry", async () => {
  const sandbox = loadAutoRetrySandbox("pharmacy", [
    retryOutcome("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"),
    retrySuccess("pharmacy", "must-not-run")
  ]);
  await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(sandbox.getCalls(), 1);
});

test("AUTO K two hospital temporary-unavailable outcomes stop after exactly two Function calls", async () => {
  const sandbox = loadAutoRetrySandbox("hospital", [
    retryOutcome("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"),
    retryOutcome("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"),
    retrySuccess("hospital", "must-not-run")
  ]);
  await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(sandbox.getCalls(), 2);
});

const facilityStyleSource = (indexSource.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const facilityRenderSource = extractNamedFunction(indexSource, "renderFacilityList");
const facilityRetrySource = extractNamedFunction(indexSource, "fetchNearbyFacilitiesWithSingleAutoRetry");

function assertFacilityWidthContract(){
  assert.match(facilityStyleSource, /#facilityCard,#facilityList,#facilityList>\.grid,\.facility,\.facility-top\{width:100%;max-width:100%;min-width:0\}/);
  assert.match(facilityStyleSource, /\.facility-top>div:first-child\{flex:1 1 auto;min-width:0\}/);
  assert.match(facilityStyleSource, /\.facility h3,\.facility p\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(facilityStyleSource, /\.facility-top>\.distance\{flex:0 0 auto\}/);
}

function facilityInnerWidth(viewportWidth){
  return viewportWidth - (12 * 2) - (14 * 2) - (18 * 2);
}

test("LAYOUT H first success uses a fully shrinkable facility result hierarchy", () => {
  assertFacilityWidthContract();
  assert.match(facilityRenderSource, /<div class="grid">/);
  assert.match(facilityRenderSource, /<div class="facility"/);
  assert.match(facilityRenderSource, /<div class="facility-top">/);
});

test("LAYOUT I retry success returns through the same renderer without retry-specific positioning", () => {
  assert.match(extractNamedFunction(indexSource, "applyLocation"), /commitFacilitySearchResults[\s\S]*renderFacilityList/);
  assert.doesNotMatch(facilityRetrySource, /innerHTML|style\.(?:left|right|width)|classList|transform/);
});

test("LAYOUT J result width containment supports document scrollWidth no greater than clientWidth", () => {
  assertFacilityWidthContract();
  assert.match(facilityStyleSource, /\.sos-modern-ui\.flow-app-active \.app-flow-screen\{[\s\S]*?overflow-x:hidden;/);
  assert.doesNotMatch(facilityStyleSource, /\.facility\{[^}]*width:\s*[3-9]\d{2}px/);
});

test("LAYOUT K automatic retry does not mutate horizontal scroll or offsets", () => {
  assert.doesNotMatch(facilityRetrySource, /scrollLeft|scrollTo|translate|style\.(?:left|right)/);
  assert.match(extractNamedFunction(indexSource, "flowScrollTop"), /left:0/);
});

test("LAYOUT L 390px and 393px viewports retain positive card content width without clipping", () => {
  assertFacilityWidthContract();
  for(const [width, height] of [[390, 844], [393, 852]]){
    assert.ok(facilityInnerWidth(width) >= 302);
    assert.ok(height > width);
  }
});

test("LAYOUT M 320-430px mobile viewports satisfy the same overflow containment contract", () => {
  assertFacilityWidthContract();
  for(const [width, height] of [[320, 568], [360, 640], [375, 667], [390, 844], [393, 852], [430, 932]]){
    assert.ok(facilityInnerWidth(width) >= 232);
    assert.ok(height > width);
  }
});

test("LAYOUT N Track A fallback action and external notice remain shrinkable", () => {
  assert.match(facilityStyleSource, /\.facility-fallback-actions,\.facility-fallback-action,\.facility-external-notice\{width:100%;max-width:100%;min-width:0\}/);
  assert.match(facilityStyleSource, /\.facility-fallback-action\{white-space:normal;overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(facilityStyleSource, /\.facility-external-notice\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(facilityRenderSource, /facility-fallback-action/);
  assert.doesNotMatch(facilityRenderSource, /style="[^"]*width:\s*[3-9]\d{2}px/);
});

test("P0 client preserves an explicit rate-limit state", async () => {
  const sandbox = loadClient(async () => response({
    ok:false,
    schemaVersion:"1",
    code:"FACILITY_RATE_LIMITED",
    retryable:true,
    attemptsUsed:2
  }, 429));
  assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), "FACILITY_RATE_LIMITED");
});

function loadFacilityOrdering(){
  const sandbox = {};
  const names = [
    "facilityDistanceValue",
    "normalizedFacilityName",
    "facilityDedupeKeys",
    "isEmergencyHospitalRecommendation",
    "facilityEmergencyTier",
    "compareFacilityResults",
    "isSameFacilitySite",
    "finalizeFacilityResults"
  ];
  vm.runInNewContext(
    `const MAX_FACILITY_RESULTS = 50;
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     this.finalize = finalizeFacilityResults;`,
    sandbox,
    {filename:INDEX_PATH}
  );
  return sandbox.finalize;
}

function orderedIds(list){ return Array.from(list, (item) => item.id); }

test("P0 non-emergency results preserve distance ordering", () => {
  const finalize = loadFacilityOrdering();
  const result = finalize([
    {id:"far", type:"hospital", nameKo:"먼 병원", latitude:37.58, longitude:127.02, distanceKm:4.2},
    {id:"near", type:"hospital", nameKo:"가까운 의원", latitude:37.57, longitude:127.01, distanceKm:0.8}
  ]);
  assert.deepEqual(orderedIds(result), ["near", "far"]);
});

test("P0 emergency results preserve confirmed emergency-facility priority", () => {
  const finalize = loadFacilityOrdering();
  const result = finalize([
    {id:"near-clinic", type:"hospital", nameKo:"가까운 의원", latitude:37.57, longitude:127.01, distanceKm:0.2, isClinic:true},
    {id:"far-emergency", type:"hospital", nameKo:"응급 병원", latitude:37.58, longitude:127.02, distanceKm:3.5, isHospital:true, emergencyCareConfirmed:true}
  ], {type:"hospital", emergencyContext:true});
  assert.deepEqual(orderedIds(result), ["far-emergency", "near-clinic"]);
});

// ---------- P1 first-search reliability through the real HTTP response path ----------
// Runs the real fetchFacilityProxy + retry decision with scripted Function
// replies (no network). Synthetic coordinates only.
function loadHttpRetrySandbox(type, replies, waitAction = "none"){
  const calls = [];
  const delays = [];
  const sandbox = {
    inputType:type,
    replies:replies.slice(),
    calls,
    delays,
    waitAction,
    AbortController,
    clearTimeout(){},
    setTimeout(callback, delayMs){
      if(delayMs === 60000) return 0;
      delays.push(delayMs);
      if(typeof sandbox.applyWaitAction === "function") sandbox.applyWaitAction();
      callback();
      return 0;
    }
  };
  const names = [
    "createFacilitySearchError",
    "normalizeFacilityProxyErrorCode",
    "validateFacilityProxySuccess",
    "fetchFacilityProxy",
    "isFacilityAutoRetryEligible",
    "isFacilitySearchResultContextCurrent",
    "waitForFacilityAutoRetry",
    "fetchNearbyFacilitiesWithSingleAutoRetry"
  ];
  vm.runInNewContext(
    `const FACILITY_PROXY_URL = "/.netlify/functions/nearby-facilities";
     const FACILITY_PROXY_MAX_RADIUS_METERS = 50000;
     const FACILITY_PROXY_REQUEST_TIMEOUT_MS = 60000;
     const FACILITY_PROXY_ALLOWED_RADII = new Set([5000, 10000, 20000, 50000]);
     const FACILITY_PROXY_ERROR_CODES = new Set([
       "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", "FACILITY_QUERY_ERROR", "FACILITY_TIMEOUT",
       "FACILITY_INVALID_RESPONSE", "FACILITY_RATE_LIMITED", "FACILITY_INVALID_REQUEST"
     ]);
     const FACILITY_AUTO_RETRY_DELAY_MS = 250;
     const FACILITY_RATE_LIMIT_RETRY_DELAY_MS = 1500;
     let currentType = this.inputType;
     let currentFlowScreen = currentType === "pharmacy" ? "screen-pharmacy-results" : "screen-hospital-results";
     let activeRequest = {type:currentType, generation:1, autoRetrying:false};
     const originalRequest = activeRequest;
     const replyQueue = this.replies;
     const callLog = this.calls;
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(request){ return request === activeRequest && request.type === currentType; }
     function setStatus(){}
     function renderFacilityList(){}
     async function fetch(url, options){
       callLog.push({url, body:JSON.parse(options.body)});
       const reply = replyQueue.shift();
       if(!reply) throw new Error("unexpected extra Function call");
       if(reply.networkError) throw new TypeError("Failed to fetch");
       return {
         ok:reply.status >= 200 && reply.status < 300,
         status:reply.status,
         async text(){ return typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body); }
       };
     }
     async function fetchNearbyFacilities(type, loc, recommendation, searchRequest){
       const data = await fetchFacilityProxy(type, loc, searchRequest);
       if(data === null) return null;
       return Object.assign(data.elements.slice(), {complete:data.complete, code:data.code || ""});
     }
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     this.applyWaitAction = () => {
       if(this.waitAction === "home") currentFlowScreen = "screen-home";
       if(this.waitAction === "new-hospital"){
         activeRequest = {type:"hospital", generation:2, autoRetrying:false};
         currentFlowScreen = "screen-hospital-results";
       }
       if(this.waitAction === "pharmacy"){
         activeRequest = {type:"pharmacy", generation:2, autoRetrying:false};
         currentType = "pharmacy";
         currentFlowScreen = "screen-pharmacy-results";
       }
     };
     this.run = () => fetchNearbyFacilitiesWithSingleAutoRetry(
       originalRequest.type,
       {latitude:48.8566, longitude:2.3522, source:"gps"},
       null,
       originalRequest
     );`,
    sandbox,
    {filename:INDEX_PATH}
  );
  return sandbox;
}

function functionFailure(status, code, retryable){
  return {status, body:{ok:false, schemaVersion:"1", code, retryable, attemptsUsed:4}};
}
function functionSuccess(elements, overrides = {}){
  return {status:200, body:success({elements, ...overrides})};
}
const GATEWAY_HTML = "<html><body>Gateway error</body></html>";
const ONE_ELEMENT = [{type:"node", id:1, lat:48.857, lon:2.352, tags:{amenity:"hospital", name:"P1"}}];

test("P1 RETRY a retryable 429 rate limit is retried once after a short backoff and succeeds", async () => {
  const sandbox = loadHttpRetrySandbox("hospital", [
    functionFailure(429, "FACILITY_RATE_LIMITED", true),
    functionSuccess(ONE_ELEMENT)
  ]);
  const result = await sandbox.run();
  assert.equal(sandbox.calls.length, 2);
  assert.equal(result.length, 1);
  assert.deepEqual(Array.from(sandbox.delays), [1500]);
});

test("P1 RETRY non-JSON gateway 502/503/504 responses are transient and retried once", async () => {
  for(const status of [502, 503, 504]){
    const sandbox = loadHttpRetrySandbox("hospital", [{status, body:GATEWAY_HTML}, functionSuccess(ONE_ELEMENT)]);
    const result = await sandbox.run();
    assert.equal(sandbox.calls.length, 2, `status ${status}`);
    assert.equal(result.length, 1, `status ${status}`);
    assert.deepEqual(Array.from(sandbox.delays), [250], `status ${status}`);
  }
});

test("P1 RETRY a browser-to-Function transport failure is retried once", async () => {
  const sandbox = loadHttpRetrySandbox("hospital", [{networkError:true}, functionSuccess(ONE_ELEMENT)]);
  assert.equal((await sandbox.run()).length, 1);
  assert.equal(sandbox.calls.length, 2);
});

test("P1 RETRY two transient failures stop at exactly two Function calls with the final safe error", async () => {
  const cases = [
    [[functionFailure(429, "FACILITY_RATE_LIMITED", true), functionFailure(429, "FACILITY_RATE_LIMITED", true)], "FACILITY_RATE_LIMITED"],
    [[{status:502, body:GATEWAY_HTML}, {status:504, body:GATEWAY_HTML}], "FACILITY_TIMEOUT"],
    [[{networkError:true}, functionFailure(503, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true)], "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"],
    // v4: a TIMEOUT that did not exhaust both providers (attemptsUsed 1) is still retried once.
    [[{status:504, body:{ok:false, schemaVersion:"1", code:"FACILITY_TIMEOUT", retryable:true, attemptsUsed:1}}, functionFailure(429, "FACILITY_RATE_LIMITED", true)], "FACILITY_RATE_LIMITED"]
  ];
  for(const [replies, finalCode] of cases){
    const sandbox = loadHttpRetrySandbox("hospital", replies.concat([functionSuccess(ONE_ELEMENT)]));
    await assert.rejects(sandbox.run(), (error) => error.code === finalCode);
    assert.equal(sandbox.calls.length, 2, finalCode);
    assert.equal(sandbox.replies.length, 1, "the queued third reply is never requested");
  }
});

test("P1 RETRY non-retryable outcomes are surfaced after one Function call", async () => {
  const cases = [
    [functionFailure(400, "FACILITY_INVALID_REQUEST", false), "FACILITY_INVALID_REQUEST"],
    [functionFailure(422, "FACILITY_INVALID_REQUEST", false), "FACILITY_INVALID_REQUEST"],
    [functionFailure(502, "FACILITY_QUERY_ERROR", false), "FACILITY_QUERY_ERROR"],
    [functionFailure(502, "FACILITY_INVALID_RESPONSE", false), "FACILITY_INVALID_RESPONSE"],
    [functionFailure(503, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", false), "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"],
    [{status:200, body:GATEWAY_HTML}, "FACILITY_INVALID_RESPONSE"],
    [{status:200, body:{ok:true, schemaVersion:"2", elements:[]}}, "FACILITY_INVALID_RESPONSE"]
  ];
  for(const [reply, code] of cases){
    const sandbox = loadHttpRetrySandbox("hospital", [reply, functionSuccess(ONE_ELEMENT)]);
    await assert.rejects(sandbox.run(), (error) => error.code === code);
    assert.equal(sandbox.calls.length, 1, `${reply.status} ${code}`);
    assert.equal(sandbox.delays.length, 0);
  }
});

test("P1 RETRY successful empty and partial hospital results are data, not retry triggers", async () => {
  const empty = loadHttpRetrySandbox("hospital", [functionSuccess([]), functionSuccess(ONE_ELEMENT)]);
  const emptyResult = await empty.run();
  assert.equal(emptyResult.length, 0);
  assert.equal(emptyResult.complete, true);
  assert.equal(empty.calls.length, 1);

  const partial = loadHttpRetrySandbox("hospital", [
    functionSuccess(ONE_ELEMENT, {complete:false, code:"FACILITY_PARTIAL_RESULTS", incompleteReason:"FACILITY_TIMEOUT", searchRadiusMeters:10000}),
    functionSuccess([])
  ]);
  const partialResult = await partial.run();
  assert.equal(partialResult.length, 1, "valid partial results survive a later expansion failure");
  assert.equal(partialResult.complete, false);
  assert.equal(partialResult.code, "FACILITY_PARTIAL_RESULTS");
  assert.equal(partial.calls.length, 1);
});

test("P1 RETRY pharmacy keeps its single-call behavior for every transient class", async () => {
  const transientReplies = [
    functionFailure(429, "FACILITY_RATE_LIMITED", true),
    {status:502, body:GATEWAY_HTML},
    {status:504, body:GATEWAY_HTML},
    {networkError:true},
    functionFailure(503, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true)
  ];
  for(const reply of transientReplies){
    const sandbox = loadHttpRetrySandbox("pharmacy", [reply, functionSuccess(ONE_ELEMENT)]);
    await assert.rejects(sandbox.run());
    assert.equal(sandbox.calls.length, 1);
    assert.equal(sandbox.calls[0].body.type, "pharmacy");
  }
  const success = loadHttpRetrySandbox("pharmacy", [functionSuccess(ONE_ELEMENT)]);
  assert.equal((await success.run()).length, 1);
  assert.equal(success.calls.length, 1);
});

test("P1 RETRY a new generation, leaving the screen, or a pharmacy search during backoff cancels the retry", async () => {
  for(const waitAction of ["new-hospital", "home", "pharmacy"]){
    const sandbox = loadHttpRetrySandbox("hospital", [
      functionFailure(429, "FACILITY_RATE_LIMITED", true),
      functionSuccess(ONE_ELEMENT)
    ], waitAction);
    assert.equal(await sandbox.run(), null, waitAction);
    assert.equal(sandbox.calls.length, 1, waitAction);
  }
});

test("P1 RETRY client maps non-JSON gateway statuses to transient codes and keeps the Function retryable flag", async () => {
  const expected = {429:"FACILITY_RATE_LIMITED", 502:"FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", 503:"FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", 504:"FACILITY_TIMEOUT", 200:"FACILITY_INVALID_RESPONSE", 500:"FACILITY_INVALID_RESPONSE"};
  for(const [status, code] of Object.entries(expected)){
    const sandbox = loadClient(async () => response(GATEWAY_HTML, Number(status)));
    assert.equal(await rejectedCode(sandbox.run("hospital", {latitude:1, longitude:2})), code, `status ${status}`);
  }
  const flagged = loadClient(async () => response({ok:false, schemaVersion:"1", code:"FACILITY_RATE_LIMITED", retryable:true, attemptsUsed:2}, 429));
  await assert.rejects(flagged.run("hospital", {latitude:1, longitude:2}), (error) => error.code === "FACILITY_RATE_LIMITED" && error.retryable === true && error.status === 429);
});

test("P1 ORDER equal distance and name fall back to a stable id tie-break in both modes", () => {
  const finalize = loadFacilityOrdering();
  const twins = [
    {id:"twin-b", type:"hospital", nameKo:"같은 병원", latitude:1, longitude:1, distanceKm:1, isHospital:true},
    {id:"twin-a", type:"hospital", nameKo:"같은 병원", latitude:2, longitude:2, distanceKm:1, isHospital:true}
  ];
  for(const recommendation of [null, {type:"hospital", emergencyContext:true}]){
    assert.deepEqual(orderedIds(finalize(twins, recommendation)), ["twin-a", "twin-b"]);
    assert.deepEqual(orderedIds(finalize(twins.slice().reverse(), recommendation)), ["twin-a", "twin-b"]);
  }
});

test("P1 ORDER narrow specialty-only facilities are removed only from emergency results", () => {
  const finalize = loadFacilityOrdering();
  const list = [
    {id:"dentist", type:"hospital", nameKo:"치과", latitude:1, longitude:1, distanceKm:0.1, isClinic:true, emergencyNarrowSpecialty:true},
    {id:"hospital-no-er", type:"hospital", nameKo:"병원 무응급", latitude:2, longitude:2, distanceKm:0.5, isHospital:true, emergencyStatus:"explicit-no"},
    {id:"hospital", type:"hospital", nameKo:"병원", latitude:3, longitude:3, distanceKm:0.9, isHospital:true},
    {id:"er", type:"hospital", nameKo:"응급 병원", latitude:4, longitude:4, distanceKm:2.5, isHospital:true, emergencyCareConfirmed:true},
    {id:"dental-er", type:"hospital", nameKo:"치과 응급", latitude:5, longitude:5, distanceKm:0.3, isHospital:true, emergencyCareConfirmed:true, emergencyNarrowSpecialty:true}
  ];
  assert.deepEqual(orderedIds(finalize(list, {type:"hospital", emergencyContext:true})), ["er", "hospital", "hospital-no-er"]);
  assert.deepEqual(orderedIds(finalize(list, {type:"hospital", triageContext:{level:"emergency"}})), ["er", "hospital", "hospital-no-er"]);
  assert.deepEqual(orderedIds(finalize(list, {type:"hospital"})), ["dentist", "dental-er", "hospital-no-er", "hospital", "er"]);
  assert.deepEqual(orderedIds(finalize(list)), ["dentist", "dental-er", "hospital-no-er", "hospital", "er"]);
});

// ---------- V4 exhausted-provider timeout is not repeated by the browser ----------
const PREVIEW_TIMEOUT_BODY = {ok:false, schemaVersion:"1", code:"FACILITY_TIMEOUT", retryable:true, attemptsUsed:2};
const PREVIEW_TIMEOUT_MESSAGE = "병원 검색 서비스 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요. 주변에 시설이 없다는 의미가 아닙니다. 긴급한 경우 현지 응급기관이나 숙소에 도움을 요청하세요.";

test("V4 RETRY the verified Preview FACILITY_TIMEOUT (attemptsUsed 2) is not repeated as an identical second Function call", async () => {
  const sandbox = loadHttpRetrySandbox("hospital", [
    {status:504, body:PREVIEW_TIMEOUT_BODY},
    {status:504, body:PREVIEW_TIMEOUT_BODY}
  ]);
  await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_TIMEOUT" && error.attemptsUsed === 2);
  assert.equal(sandbox.calls.length, 1);
  assert.equal(sandbox.delays.length, 0);
  assert.equal(sandbox.replies.length, 1, "the second Preview request is no longer made");
});

test("V4 RETRY timeouts that did not exhaust the provider path keep one automatic retry", async () => {
  const cases = [
    ["Function TIMEOUT after one provider attempt", {status:504, body:{...PREVIEW_TIMEOUT_BODY, attemptsUsed:1}}],
    ["non-JSON gateway 504", {status:504, body:GATEWAY_HTML}],
    ["Function TIMEOUT body without attemptsUsed", {status:504, body:{ok:false, schemaVersion:"1", code:"FACILITY_TIMEOUT", retryable:true}}]
  ];
  for(const [label, first] of cases){
    const sandbox = loadHttpRetrySandbox("hospital", [first, functionSuccess(ONE_ELEMENT)]);
    assert.equal((await sandbox.run()).length, 1, label);
    assert.equal(sandbox.calls.length, 2, label);
  }
});

test("V4 RETRY rate limit and service-unavailable stay bounded at two calls even when all providers were tried", async () => {
  for(const reply of [functionFailure(429, "FACILITY_RATE_LIMITED", true), functionFailure(503, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true)]){
    const sandbox = loadHttpRetrySandbox("hospital", [reply, reply, functionSuccess(ONE_ELEMENT)]);
    await assert.rejects(sandbox.run(), (error) => error.code === reply.body.code);
    assert.equal(sandbox.calls.length, 2, reply.body.code);
  }
});

test("V4 RETRY pharmacy exhausted timeout stays a single call", async () => {
  const sandbox = loadHttpRetrySandbox("pharmacy", [{status:504, body:PREVIEW_TIMEOUT_BODY}, functionSuccess(ONE_ELEMENT)]);
  await assert.rejects(sandbox.run(), (error) => error.code === "FACILITY_TIMEOUT");
  assert.equal(sandbox.calls.length, 1);
});

function loadHttpApplyLocationSandbox(replies){
  const calls = [];
  const sandbox = {
    replies:replies.slice(),
    calls,
    AbortController,
    clearTimeout(){},
    setTimeout(callback, delayMs){ if(delayMs === 60000) return 0; callback(); return 0; },
    elements:{facilityCard:{classList:{remove(){}}}, facilityList:{innerHTML:""}}
  };
  const names = [
    "createFacilitySearchError", "normalizeFacilityProxyErrorCode", "validateFacilityProxySuccess", "fetchFacilityProxy",
    "isFacilityAutoRetryEligible", "isFacilitySearchResultContextCurrent", "waitForFacilityAutoRetry",
    "fetchNearbyFacilitiesWithSingleAutoRetry", "snapshotFacilityLocation", "applyLocation"
  ];
  vm.runInNewContext(
    `const FACILITY_PROXY_URL = "/.netlify/functions/nearby-facilities";
     const FACILITY_PROXY_MAX_RADIUS_METERS = 50000;
     const FACILITY_PROXY_REQUEST_TIMEOUT_MS = 60000;
     const FACILITY_PROXY_ALLOWED_RADII = new Set([5000, 10000, 20000, 50000]);
     const FACILITY_PROXY_ERROR_CODES = new Set([
       "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", "FACILITY_QUERY_ERROR", "FACILITY_TIMEOUT",
       "FACILITY_INVALID_RESPONSE", "FACILITY_RATE_LIMITED", "FACILITY_INVALID_REQUEST"
     ]);
     const FACILITY_AUTO_RETRY_DELAY_MS = 250;
     const FACILITY_RATE_LIMIT_RETRY_DELAY_MS = 1500;
     const FACILITY_PARTIAL_RESULTS_MESSAGE = "partial";
     let facilityType = "hospital", facilityRecommendation = null, locationData = null, facilities = [];
     let facilitySearchErrorMessage = "", facilitySearchErrorCode = "", isLoading = false;
     let currentFlowScreen = "screen-hospital-results";
     const request = {type:"hospital", generation:1, recommendation:null};
     const replyQueue = this.replies;
     const callLog = this.calls;
     function isFacilitySearchCurrent(value){ return value === request; }
     function isAppOffline(){ return false; }
     function moveFacilityCardToScreen(){}
     function showFlowScreen(){}
     function renderFacilityList(){}
     function setStatus(){}
     function t(){ return {userGps:"GPS", travelPlace:"여행지"}; }
     function $(id){ return this.elements[id] || {classList:{remove(){}}}; }
     function showDebug(){}
     function renderOfflineFacilityState(){}
     function showOfflineFeatureNotice(){}
     function commitFacilitySearchResults(){ return true; }
     async function fetch(url, options){
       callLog.push(url);
       const reply = replyQueue.shift();
       return {ok:reply.status < 300, status:reply.status, async text(){ return JSON.stringify(reply.body); }};
     }
     async function fetchNearbyFacilities(type, loc, recommendation, searchRequest){
       const data = await fetchFacilityProxy(type, loc, searchRequest);
       return data && data.elements.slice();
     }
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     this.run = () => applyLocation(request, {latitude:48.8566, longitude:2.3522, source:"gps"}, "GPS OK.");
     this.state = () => ({code:facilitySearchErrorCode, message:facilitySearchErrorMessage, isLoading});`,
    sandbox,
    {filename:INDEX_PATH}
  );
  return sandbox;
}

test("V4 RETRY one click on the verified Preview timeout ends with the exact safe message after one Function call", async () => {
  const sandbox = loadHttpApplyLocationSandbox([{status:504, body:PREVIEW_TIMEOUT_BODY}, {status:504, body:PREVIEW_TIMEOUT_BODY}]);
  await sandbox.run();
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.state())), {code:"FACILITY_TIMEOUT", message:PREVIEW_TIMEOUT_MESSAGE, isLoading:false});
  assert.equal(sandbox.calls.length, 1);
});
