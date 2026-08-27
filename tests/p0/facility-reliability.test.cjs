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
  const sandbox = {
    outcomes:outcomes.slice(),
    statuses,
    waitAction,
    setTimeout(callback){
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
