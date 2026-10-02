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
      if(parameterDepth === 0){
        parametersEnd = index;
        break;
      }
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

function proxyResponse(body, status = 200){
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(){ return JSON.stringify(body); }
  };
}

function rawFacility(type, id, latitude, longitude, extraTags = {}){
  return {
    type: "node",
    id,
    lat: latitude,
    lon: longitude,
    tags: {
      name: `${type}-${id}`,
      ...(type === "pharmacy" ? {amenity: "pharmacy"} : {amenity: "hospital"}),
      ...extraTags
    }
  };
}

function osmFacility(type, osmType, id, latitude, longitude, name, extraTags = {}){
  const element = {
    type: osmType,
    id,
    tags: {
      name,
      ...(type === "pharmacy" ? {amenity: "pharmacy"} : {amenity: "hospital"}),
      ...extraTags
    }
  };
  if(osmType === "node"){
    element.lat = latitude;
    element.lon = longitude;
  }else{
    element.center = {lat: latitude, lon: longitude};
  }
  return element;
}

const proxyFunctionNames = [
  "toRadians",
  "getDistanceKm",
  "tag",
  "formatAddress",
  "isObviouslyNonMedicalPlace",
  "isBlockedNonMedicalCategory",
  "isAllowedFacilityCategory",
  "normalizedOsmTagTokens",
  "getFacilityEmergencyMetadata",
  "facilityDistanceValue",
  "normalizedFacilityName",
  "facilityDedupeKeys",
  "isEmergencyHospitalRecommendation",
  "facilityEmergencyTier",
  "compareFacilityResults",
  "finalizeFacilityResults",
  "mapOverpass",
  "createFacilitySearchError",
  "normalizeFacilityProxyErrorCode",
  "validateFacilityProxySuccess",
  "fetchFacilityProxy",
  "finalizeFacilitySearchResults",
  "fetchNearbyFacilities"
];

function loadProxySandbox(fetchImpl){
  const sandbox = {
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(
    `const MAX_FACILITY_RESULTS = 50;
     const FACILITY_PROXY_URL = "/.netlify/functions/nearby-facilities";
     const FACILITY_PROXY_MAX_RADIUS_METERS = 50000;
     const FACILITY_PROXY_REQUEST_TIMEOUT_MS = 100;
     const FACILITY_PROXY_ALLOWED_RADII = new Set([5000, 10000, 20000, 50000]);
     const FACILITY_PROXY_ERROR_CODES = new Set([
       "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", "FACILITY_QUERY_ERROR", "FACILITY_TIMEOUT",
       "FACILITY_INVALID_RESPONSE", "FACILITY_RATE_LIMITED", "FACILITY_INVALID_REQUEST"
     ]);
     let currentRequest = null;
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(request){ return !request || request === currentRequest; }
     function setStatus(){}
     function renderFacilityList(){}
     function rankFacilitiesForRecommendation(list){ return list.slice(); }
     ${proxyFunctionNames.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     isFacilitySearchCurrent = function(request){ return !request || request === currentRequest; };
     renderFacilityList = function(){};
     setStatus = function(){};
     this.setCurrentRequest = (request) => { currentRequest = request; };
     this.fetchFacilityProxy = fetchFacilityProxy;
     this.fetchNearbyFacilities = fetchNearbyFacilities;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

function runDirections(facility, mode, origin = null){
  const opened = [];
  const sandbox = {URLSearchParams, facility, mode, origin, opened, lastStatus: ""};
  vm.runInNewContext(
    `let locationData = this.origin;
     const openedCalls = this.opened;
     const window = {open(url, target, features){ openedCalls.push({url, target, features}); }};
     function isAppOffline(){ return false; }
     function showOfflineFeatureNotice(){}
     function setStatus(message){ this.lastStatus = message; }
     ${extractNamedFunction(indexSource, "openDirections")}
     openDirections(this.facility, this.mode);`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

function renderFacilities(facilities, type, recommendation = null){
  const elements = {
    facilityList: {innerHTML: ""},
    facilityTitle: {textContent: ""}
  };
  const sandbox = {
    document: {querySelectorAll(){ return []; }}
  };
  const rankingNames = [
    "facilityDistanceValue",
    "normalizedFacilityName",
    "facilityDedupeKeys",
    "isEmergencyHospitalRecommendation",
    "facilityEmergencyTier",
    "compareFacilityResults",
    "finalizeFacilityResults",
    "renderFacilityList"
  ];
  vm.runInNewContext(
    `const MAX_FACILITY_RESULTS = 50;
     const FACILITY_PARTIAL_RESULTS_MESSAGE = "일부 범위의 검색 결과만 표시하고 있습니다. 검색 서비스 응답이 원활하지 않아 더 넓은 범위까지 확인하지 못했습니다.";
     let facilities = this.inputFacilities;
     let facilityType = this.inputType;
     let facilityRecommendation = this.inputRecommendation;
     let activeFacilitySearchRequest = {type:facilityType, generation:1};
     let facilitySearchErrorMessage = "";
     let isLoading = false;
     let locationData = {latitude:35.6762, longitude:139.6503, source:"gps"};
     function $(id){ return this.elements[id] || {classList:{remove(){}}, innerHTML:"", textContent:""}; }
     function t(){ return {hospital:"병원", pharmacy:"약국", userGps:"사용자 GPS", travelPlace:"여행지", basisLocation:"기준 위치", address:"주소", openingHours:"운영시간", phone:"전화"}; }
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(){ return true; }
     function facilityResultsMatchRequest(){ return true; }
     function on(){}
     function requestGps(){}
     function renderOfflineFacilityState(){}
     function safe(fn){ return fn(); }
     function openDirections(){}
     function escapeHtml(value){ return String(value || ""); }
     ${rankingNames.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     renderFacilityList();`,
    Object.assign(sandbox, {
      inputFacilities: facilities,
      inputType: type,
      inputRecommendation: recommendation,
      elements
    }),
    {filename: INDEX_PATH}
  );
  return elements.facilityList.innerHTML;
}

function renderFacilityFailure(type, errorCode){
  const elements = {
    facilityList: {innerHTML: ""},
    facilityTitle: {textContent: ""}
  };
  const sandbox = {
    URL,
    elements,
    handlers: Object.create(null),
    opened: [],
    inputType: type,
    inputErrorCode: errorCode
  };
  vm.runInNewContext(
    `const MAX_FACILITY_RESULTS = 50;
     const FACILITY_PARTIAL_RESULTS_MESSAGE = "partial";
     let facilities = [];
     let facilityType = this.inputType;
     let facilityRecommendation = null;
     let facilitySearchGeneration = 1;
     let activeFacilitySearchRequest = {type:facilityType, generation:1};
     let facilitySearchErrorMessage = "SOS Bridge 시설 검색을 현재 사용할 수 없습니다.";
     let facilitySearchErrorCode = this.inputErrorCode;
     let isLoading = false;
     let locationData = {latitude:37.5665, longitude:126.9780, source:"gps"};
     let gpsCalls = 0;
     const eventHandlers = this.handlers;
     const openedCalls = this.opened;
     const window = {open(url, target, features){ openedCalls.push({url, target, features}); }};
     function $(id){ return this.elements[id] || {innerHTML:"", textContent:""}; }
     function t(){ return {}; }
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(request){
       return !!(request && request === activeFacilitySearchRequest && request.type === facilityType);
     }
     function facilityResultsMatchRequest(){ return true; }
     function on(id, event, handler){ eventHandlers[id + ":" + event] = handler; }
     function requestGps(){ gpsCalls += 1; }
     function renderOfflineFacilityState(){}
     function escapeHtml(value){ return String(value || ""); }
     function finalizeFacilityResults(value){ return value; }
     function openDirections(){}
     ${extractNamedFunction(indexSource, "isFacilityExternalFallbackEligible")}
     ${extractNamedFunction(indexSource, "buildFacilityGoogleMapsFallbackUrl")}
     ${extractNamedFunction(indexSource, "openFacilityGoogleMapsFallback")}
     ${extractNamedFunction(indexSource, "renderFacilityList")}
     renderFacilityList();
     this.click = (id) => {
       const handler = eventHandlers[id + ":click"];
       if(handler) handler();
     };
     this.invalidateWithPharmacy = () => {
       facilityType = "pharmacy";
       activeFacilitySearchRequest = {type:"pharmacy", generation:2};
       facilitySearchGeneration = 2;
     };
     this.getGpsCalls = () => gpsCalls;`,
    sandbox,
    {filename: INDEX_PATH}
  );
  return sandbox;
}

function loadApplyLocationSandbox(errorCode){
  const elements = {
    facilityCard: {classList: {remove(){}}},
    facilityList: {innerHTML: ""}
  };
  const sandbox = {setTimeout(callback){ callback(); return 1; }};
  vm.runInNewContext(
    `let facilityType = "hospital";
     let facilityRecommendation = null;
     let locationData = null;
     let facilities = [];
     let facilitySearchErrorMessage = "";
      let facilitySearchErrorCode = "";
      let isLoading = false;
      let currentFlowScreen = "screen-hospital-results";
      const FACILITY_AUTO_RETRY_DELAY_MS = 0;
      const FACILITY_PARTIAL_RESULTS_MESSAGE = "일부 범위의 검색 결과만 표시하고 있습니다. 검색 서비스 응답이 원활하지 않아 더 넓은 범위까지 확인하지 못했습니다.";
     function isFacilitySearchCurrent(){ return true; }
     function isAppOffline(){ return false; }
     function moveFacilityCardToScreen(){}
     function showFlowScreen(){}
     function renderFacilityList(){}
     function setStatus(message){ this.lastStatus = message; }
     function t(){ return {userGps:"사용자 GPS", travelPlace:"여행지"}; }
     function $(id){ return this.elements[id] || {classList:{remove(){}}, innerHTML:""}; }
     function showDebug(){}
     function renderOfflineFacilityState(){}
     function showOfflineFeatureNotice(){}
     function commitFacilitySearchResults(){ return false; }
      async function fetchNearbyFacilities(){ const error = new Error(this.errorCode); error.code = this.errorCode; throw error; }
      ${extractNamedFunction(indexSource, "isFacilityAutoRetryEligible")}
      ${extractNamedFunction(indexSource, "isFacilitySearchResultContextCurrent")}
      ${extractNamedFunction(indexSource, "waitForFacilityAutoRetry")}
      ${extractNamedFunction(indexSource, "fetchNearbyFacilitiesWithSingleAutoRetry")}
      ${extractNamedFunction(indexSource, "snapshotFacilityLocation")}
     ${extractNamedFunction(indexSource, "applyLocation")}
     this.run = applyLocation;
     this.getError = () => ({code:facilitySearchErrorCode, message:facilitySearchErrorMessage});`,
    Object.assign(sandbox, {elements, errorCode, lastStatus: ""}),
    {filename: INDEX_PATH}
  );
  return sandbox;
}

test("U hospital Function success maps, ranks, and renders through existing safety code", async () => {
  const calls = [];
  const sandbox = loadProxySandbox(async (url, options) => {
    calls.push({url, options});
    return proxyResponse({
      ok: true,
      schemaVersion: "1",
      provider: "primary",
      attemptsUsed: 1,
      searchRadiusMeters: 5000,
      complete: true,
      elements: [rawFacility("hospital", 1, 35.6763, 139.6503)]
    });
  });
  const result = await sandbox.fetchNearbyFacilities("hospital", {latitude:35.6762, longitude:139.6503});
  assert.equal(result[0].type, "hospital");
  assert.equal(result[0].isHospital, true);
  assert.match(renderFacilities(result, "hospital"), /hospital-1/);
  assert.equal(calls[0].url, "/.netlify/functions/nearby-facilities");
});

test("V pharmacy Function success maps and renders a pharmacy", async () => {
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok: true,
    schemaVersion: "1",
    provider: "primary",
    attemptsUsed: 1,
    searchRadiusMeters: 5000,
    complete: true,
    elements: [rawFacility("pharmacy", 2, 35.6764, 139.6503)]
  }));
  const result = await sandbox.fetchNearbyFacilities("pharmacy", {latitude:35.6762, longitude:139.6503});
  assert.equal(result[0].type, "pharmacy");
  assert.match(renderFacilities(result, "pharmacy"), /pharmacy-2/);
});

test("W service unavailable UI does not blame the user's internet", async () => {
  const sandbox = loadApplyLocationSandbox("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  await sandbox.run({type:"hospital", recommendation:null}, {latitude:35.6762, longitude:139.6503, source:"gps"}, "위치 확인");
  const state = sandbox.getError();
  assert.equal(state.code, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.match(state.message, /검색 서비스가 일시적으로 원활하지 않습니다/);
  assert.doesNotMatch(state.message, /사용자.*인터넷|인터넷 연결 문제/);
});

test("X complete false renders a visible non-blocking partial-results notice", async () => {
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok: true,
    schemaVersion: "1",
    provider: "primary",
    attemptsUsed: 3,
    searchRadiusMeters: 5000,
    complete: false,
    code: "FACILITY_PARTIAL_RESULTS",
    incompleteReason: "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE",
    elements: [rawFacility("hospital", 3, 35.6763, 139.6503)]
  }));
  const result = await sandbox.fetchNearbyFacilities("hospital", {latitude:35.6762, longitude:139.6503});
  const html = renderFacilities(result, "hospital");
  assert.equal(result.complete, false);
  assert.match(html, /부분 검색 결과/);
  assert.match(html, /더 넓은 범위까지 확인하지 못했습니다/);
});

test("Y HTTP 200 with an empty complete result renders NO RESULTS, not a service failure", async () => {
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok: true,
    schemaVersion: "1",
    provider: "primary",
    attemptsUsed: 4,
    searchRadiusMeters: 50000,
    complete: true,
    elements: []
  }));
  const result = await sandbox.fetchNearbyFacilities("hospital", {latitude:35.6762, longitude:139.6503});
  const html = renderFacilities(result, "hospital");
  assert.equal(result.length, 0);
  assert.equal(result.complete, true);
  assert.match(html, /현재 확인한 검색 범위에서 검색 결과가 없습니다/);
  assert.doesNotMatch(html, /일시적으로 원활하지 않습니다|부분 검색 결과|facilityGoogleMapsFallbackBtn/);
});

function deferred(){
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}

async function staleProxyFixture(firstType, secondType){
  const pendingResponse = deferred();
  const sandbox = loadProxySandbox(async () => pendingResponse.promise);
  const firstRequest = {type:firstType, generation:1};
  const secondRequest = {type:secondType, generation:2};
  sandbox.setCurrentRequest(firstRequest);
  const pending = sandbox.fetchNearbyFacilities(firstType, {latitude:35.6762, longitude:139.6503}, null, firstRequest);
  sandbox.setCurrentRequest(secondRequest);
  pendingResponse.resolve(proxyResponse({
    ok: true,
    schemaVersion: "1",
    provider: "secondary",
    attemptsUsed: 2,
    searchRadiusMeters: 5000,
    complete: true,
    elements: [rawFacility(firstType, 99, 35.6763, 139.6503)]
  }));
  assert.equal(await pending, null);
}

test("Z late generation 1 hospital Function response is discarded after pharmacy generation 2", async () => {
  await staleProxyFixture("hospital", "pharmacy");
});

test("AA late generation 1 pharmacy Function response is discarded after hospital generation 2", async () => {
  await staleProxyFixture("pharmacy", "hospital");
});

test("AB AI Care emergency context still prioritizes the confirmed emergency tier", async () => {
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok: true,
    schemaVersion: "1",
    provider: "primary",
    attemptsUsed: 1,
    searchRadiusMeters: 5000,
    complete: true,
    elements: [
      rawFacility("hospital", "near-clinic", 35.6763, 139.6503, {amenity:"clinic"}),
      rawFacility("hospital", "far-emergency", 35.6862, 139.6503, {amenity:"hospital", emergency:"yes"})
    ]
  }));
  const recommendation = {
    type:"hospital",
    emergencyContext:true,
    triageContext:{level:"emergency", needsAmbulance:true}
  };
  const result = await sandbox.fetchNearbyFacilities(
    "hospital",
    {latitude:35.6762, longitude:139.6503},
    recommendation
  );
  assert.equal(result[0].osmId, "far-emergency");
  assert.equal(result[0].emergencyCareConfirmed, true);
  assert.equal(result[1].osmId, "near-clinic");
});

test("AC global fixtures map and render multilingual node way and relation facilities", async () => {
  const fixtures = [
    {region:"Seoul", type:"hospital", osmType:"node", name:"서울중앙병원", lat:37.5665, lon:126.9780, tags:{amenity:"hospital"}},
    {region:"Tokyo", type:"hospital", osmType:"way", name:"東京みらい診療所", lat:35.6762, lon:139.6503, tags:{amenity:"clinic"}},
    {region:"Bangkok", type:"pharmacy", osmType:"relation", name:"ร้านขายยากลาง", lat:13.7563, lon:100.5018, tags:{amenity:"pharmacy"}},
    {region:"Paris", type:"hospital", osmType:"node", name:"Hôpital Central", lat:48.8566, lon:2.3522, tags:{amenity:"hospital"}},
    {region:"New York", type:"hospital", osmType:"way", name:"Midtown Clinic", lat:40.7128, lon:-74.0060, tags:{healthcare:"clinic", amenity:"clinic"}},
    {region:"Sydney", type:"pharmacy", osmType:"relation", name:"Harbour Pharmacy", lat:-33.8688, lon:151.2093, tags:{healthcare:"pharmacy", amenity:"pharmacy"}},
    {region:"São Paulo", type:"hospital", osmType:"node", name:"Centro Cardíaco São Paulo", lat:-23.5505, lon:-46.6333, tags:{amenity:"hospital"}},
    {region:"Cairo", type:"hospital", osmType:"relation", name:"مستشفى القاهرة", lat:30.0444, lon:31.2357, tags:{amenity:"hospital", emergency:"yes"}}
  ];

  for(const [index, fixture] of fixtures.entries()){
    const element = osmFacility(
      fixture.type, fixture.osmType, index + 1,
      fixture.lat, fixture.lon, fixture.name, fixture.tags
    );
    const sandbox = loadProxySandbox(async () => proxyResponse({
      ok:true,
      schemaVersion:"1",
      provider:"primary",
      attemptsUsed:1,
      searchRadiusMeters:5000,
      complete:true,
      elements:[element]
    }));
    const result = await sandbox.fetchNearbyFacilities(
      fixture.type,
      {latitude:fixture.lat + 0.001, longitude:fixture.lon + 0.001}
    );
    assert.equal(result.length, 1, fixture.region);
    assert.equal(result[0].nameKo, fixture.name, fixture.region);
    assert.equal(result[0].type, fixture.type, fixture.region);
    assert.equal(result[0].osmType, fixture.osmType, fixture.region);
    assert.equal(result[0].latitude, fixture.lat, fixture.region);
    assert.equal(result[0].longitude, fixture.lon, fixture.region);
    assert.equal(Number.isFinite(result[0].distanceKm), true, fixture.region);
    assert.equal(renderFacilities(result, fixture.type).includes(fixture.name), true, fixture.region);
  }
});

test("AD zero-valued valid OSM coordinates remain searchable", async () => {
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok:true,
    schemaVersion:"1",
    provider:"primary",
    attemptsUsed:1,
    searchRadiusMeters:5000,
    complete:true,
    elements:[
      osmFacility("hospital", "node", "zero-lat", 0, 30.001, "Equator Hospital"),
      osmFacility("hospital", "relation", "zero-lon", 1, 0, "Prime Meridian Clinic", {amenity:"clinic"})
    ]
  }));
  const result = await sandbox.fetchNearbyFacilities("hospital", {latitude:0, longitude:0});
  assert.equal(result.length, 2);
  assert.equal(result.some((facility) => facility.latitude === 0), true);
  assert.equal(result.some((facility) => facility.longitude === 0), true);
});

test("AE integrated safety fixture preserves medical facilities and filters contamination", async () => {
  const elements = [
    osmFacility("hospital", "node", "hospital", 35.1, 139.1, "Normal Hospital"),
    osmFacility("hospital", "way", "clinic", 35.2, 139.2, "Normal Clinic", {amenity:"clinic"}),
    osmFacility("hospital", "relation", "emergency", 35.3, 139.3, "Emergency Hospital", {emergency:"yes"}),
    osmFacility("hospital", "node", "open-24", 35.4, 139.4, "24 Hour Hospital", {opening_hours:"24/7"}),
    osmFacility("hospital", "node", "cardiac", 35.5, 139.5, "Cardiac Center"),
    osmFacility("hospital", "node", "cardiology", 35.6, 139.6, "Cardiology Clinic", {amenity:"clinic"}),
    osmFacility("hospital", "node", "car", 35.7, 139.7, "Car Repair", {amenity:"clinic"}),
    osmFacility("hospital", "node", "auto", 35.8, 139.8, "Auto Repair", {amenity:"clinic"}),
    osmFacility("hospital", "node", "motor", 35.9, 139.9, "Motor Garage", {amenity:"clinic"}),
    osmFacility("hospital", "node", "alternative", 36.0, 140.0, "전통 대체요법원", {amenity:"", healthcare:"alternative"}),
    osmFacility("hospital", "node", "mistagged", 36.1, 140.1, "Mis-tagged Workshop", {amenity:"clinic", shop:"car_repair"})
  ];
  const sandbox = loadProxySandbox(async () => proxyResponse({
    ok:true,
    schemaVersion:"1",
    provider:"primary",
    attemptsUsed:1,
    searchRadiusMeters:5000,
    complete:true,
    elements
  }));
  const result = await sandbox.fetchNearbyFacilities("hospital", {latitude:35, longitude:139});
  const ids = result.map((facility) => facility.osmId);
  assert.deepEqual(Array.from(ids).sort(), ["cardiac", "cardiology", "clinic", "emergency", "hospital", "open-24"]);
  assert.equal(result.find((facility) => facility.osmId === "emergency").emergencyCareConfirmed, true);
  assert.equal(result.find((facility) => facility.osmId === "open-24").isOpen24Hours, true);
  assert.equal(result.find((facility) => facility.osmId === "open-24").emergencyCareConfirmed, false);
});

test("AF hospital and pharmacy directions preserve coordinates and all travel modes", () => {
  const fixtures = [
    {facility:{type:"hospital", nameKo:"東京病院", latitude:35.6895, longitude:139.6917}, mode:"walking", expected:"walking"},
    {facility:{type:"pharmacy", nameKo:"صيدلية دبي", latitude:25.2048, longitude:55.2708}, mode:"transit", expected:"transit"},
    {facility:{type:"hospital", nameKo:"โรงพยาบาลกลาง", latitude:13.7563, longitude:100.5018}, mode:"car", expected:"driving"}
  ];
  for(const fixture of fixtures){
    const sandbox = runDirections(fixture.facility, fixture.mode, {latitude:37.5665, longitude:126.9780});
    assert.equal(sandbox.opened.length, 1);
    const url = new URL(sandbox.opened[0].url);
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
    assert.equal(url.searchParams.get("destination"),
      Number(fixture.facility.latitude).toFixed(6) + "," + Number(fixture.facility.longitude).toFixed(6));
    assert.equal(url.searchParams.get("origin"), "37.566500,126.978000");
    assert.equal(url.searchParams.get("travelmode"), fixture.expected);
  }
});

test("AG directions do not open without valid facility coordinates", () => {
  const sandbox = runDirections({type:"hospital", nameKo:"좌표 없는 시설", latitude:null, longitude:200}, "walking");
  assert.equal(sandbox.opened.length, 0);
  assert.match(sandbox.lastStatus, /유효한 시설 좌표/);
});

for(const errorCode of ["FACILITY_TIMEOUT", "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"]){
  test(`TRACK A hospital ${errorCode} renders a user-click-only external fallback`, () => {
    const sandbox = renderFacilityFailure("hospital", errorCode);
    const html = sandbox.elements.facilityList.innerHTML;
    assert.match(html, /SOS Bridge 시설 검색을 현재 사용할 수 없습니다/);
    assert.match(html, /현재 위치로 다시 시도/);
    assert.match(html, /Google Maps에서 주변 병원 찾기/);
    assert.doesNotMatch(html, /주변 약국 찾기/);
    assert.match(html, /Google Maps 외부 서비스/);
    assert.match(html, /권한·설정에 따라 현재 위치를 사용할 수 있습니다/);
    assert.equal(sandbox.opened.length, 0);
    assert.equal(sandbox.getGpsCalls(), 0);

    sandbox.click("facilityGoogleMapsFallbackBtn");
    assert.equal(sandbox.opened.length, 1);
    const opened = sandbox.opened[0];
    const url = new URL(opened.url);
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/search/");
    assert.equal(url.searchParams.get("api"), "1");
    assert.equal(url.searchParams.get("query"), "hospital");
    assert.doesNotMatch(opened.url, /37\.5665|126\.9780/);
    assert.equal(opened.target, "_blank");
    assert.match(opened.features, /noopener/);
    assert.match(opened.features, /noreferrer/);
    assert.equal(sandbox.getGpsCalls(), 0);
  });
}

for(const errorCode of ["FACILITY_TIMEOUT", "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"]){
  test(`TRACK A pharmacy ${errorCode} remains isolated and opens only a pharmacy search`, () => {
    const sandbox = renderFacilityFailure("pharmacy", errorCode);
    const html = sandbox.elements.facilityList.innerHTML;
    assert.match(html, /Google Maps에서 주변 약국 찾기/);
    assert.doesNotMatch(html, /주변 병원 찾기/);
    assert.equal(sandbox.opened.length, 0);

    sandbox.click("facilityGoogleMapsFallbackBtn");
    assert.equal(sandbox.opened.length, 1);
    const url = new URL(sandbox.opened[0].url);
    assert.equal(url.searchParams.get("api"), "1");
    assert.equal(url.searchParams.get("query"), "pharmacy");
    assert.doesNotMatch(sandbox.opened[0].url, /37\.5665|126\.9780/);
    assert.equal(sandbox.getGpsCalls(), 0);
  });
}

test("TRACK A non-transient facility errors do not expose the external fallback", () => {
  const sandbox = renderFacilityFailure("hospital", "FACILITY_QUERY_ERROR");
  assert.doesNotMatch(sandbox.elements.facilityList.innerHTML, /facilityGoogleMapsFallbackBtn|Google Maps에서 주변 병원 찾기/);
  sandbox.click("facilityGoogleMapsFallbackBtn");
  assert.equal(sandbox.opened.length, 0);
});

test("TRACK A stale hospital fallback handler cannot navigate after pharmacy becomes current", () => {
  const sandbox = renderFacilityFailure("hospital", "FACILITY_TIMEOUT");
  sandbox.invalidateWithPharmacy();
  sandbox.click("facilityGoogleMapsFallbackBtn");
  assert.equal(sandbox.opened.length, 0);
  assert.equal(sandbox.getGpsCalls(), 0);
});

test("TRACK A privacy notice identifies user-selected facility search links and Google location handling", () => {
  const privacySource = fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8");
  assert.match(privacySource, /사용자가 길찾기 또는 외부 병원·약국 검색 링크를 직접 선택한 경우 Google Maps로 이동합니다/);
  assert.match(privacySource, /자체 권한·설정에 따라 현재 위치를 사용할 수 있습니다/);
});

test("P0 client source keeps discovery on the strict same-origin five-field contract", () => {
  const proxySource = extractNamedFunction(indexSource, "fetchFacilityProxy");
  const validationSource = extractNamedFunction(indexSource, "validateFacilityProxySuccess");
  const finalizerSource = extractNamedFunction(indexSource, "finalizeFacilityResults");
  assert.match(indexSource, /const FACILITY_PROXY_URL = "\/\.netlify\/functions\/nearby-facilities"/);
  assert.match(proxySource, /method:"POST"/);
  assert.match(proxySource, /schemaVersion:"1"[\s\S]*type:[\s\S]*latitude:[\s\S]*longitude:[\s\S]*maxRadiusMeters:/);
  assert.doesNotMatch(proxySource, /symptom|specialty|medicalCard|healthInformation/);
  assert.match(validationSource, /data\.ok === true[\s\S]*data\.schemaVersion === "1"[\s\S]*typeof data\.complete === "boolean"/);
  assert.match(finalizerSource, /slice\(0, MAX_FACILITY_RESULTS\)/);
  assert.match(indexSource, /const MAX_FACILITY_RESULTS = 50/);
  assert.doesNotMatch(indexSource, /overpass-api\.de|overpass\.private\.coffee|function\s+buildOverpassQuery/);
});
