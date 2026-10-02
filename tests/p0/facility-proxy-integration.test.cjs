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
  "isEmergencyNarrowSpecialtyFacility",
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
     ${extractNamedFunction(indexSource, "isEmergencyHospitalRecommendation")}
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

// ---------- P1 hospital emergency relevance and ordering ----------
// Synthetic fixture coordinates only (no real user location). Distances are
// produced by the real getDistanceKm from latitude offsets north of the base.
const P1_BASE = {latitude:48.8566, longitude:2.3522};

function p1Element(id, distanceKm, tags){
  return {type:"node", id, lat:P1_BASE.latitude + distanceKm / 111.19492664455873, lon:P1_BASE.longitude, tags};
}

const P1_EMERGENCY_FIXTURE = [
  p1Element("A-er-hospital", 1.2, {name:"Hopital A", amenity:"hospital", emergency:"yes"}),
  p1Element("B-er-hospital", 2.0, {name:"Hopital B", amenity:"hospital", healthcare:"hospital", emergency:"yes"}),
  p1Element("C-general-hospital", 0.7, {name:"Hopital General C", amenity:"hospital"}),
  p1Element("D-dentist", 0.2, {name:"Cabinet D", amenity:"doctors", healthcare:"dentist"}),
  p1Element("D2-dental-hospital", 0.25, {name:"서울 치과병원", amenity:"hospital"}),
  p1Element("E-urology", 0.3, {name:"Centre E", amenity:"clinic", healthcare:"clinic", "healthcare:speciality":"urology"}),
  p1Element("F-cosmetic", 0.4, {name:"강남 성형외과", amenity:"hospital", "healthcare:speciality":"plastic_surgery"}),
  p1Element("G-large-er-hospital", 1.5, {name:"Grand Hopital G", amenity:"hospital", emergency:"yes", "healthcare:speciality":"general;emergency;plastic_surgery;dentistry"}),
  p1Element("H-dermatology", 0.5, {name:"맑은 피부과의원", amenity:"clinic"}),
  p1Element("I-family-clinic", 0.6, {name:"Family Clinic I", amenity:"clinic"}),
  p1Element("J-hospital-no-er", 0.9, {name:"Hospital J", amenity:"hospital", emergency:"no"}),
  // Generic name with all-narrow structured specialties: structured metadata wins (excluded).
  p1Element("K-university-hospital", 3.0, {name:"한국대학교병원", amenity:"hospital", "healthcare:speciality":"dentistry;plastic_surgery"}),
  p1Element("K2-university-hospital-mixed", 3.2, {name:"한국대학교병원", amenity:"hospital", "healthcare:speciality":"dentistry;plastic_surgery;internal_medicine"}),
  p1Element("L-ortho-derm-clinic", 0.35, {name:"튼튼 정형외과피부과의원", amenity:"clinic"}),
  p1Element("M-dental-medical-center", 0.45, {name:"ABC Dental Medical Center", amenity:"hospital", "healthcare:speciality":"dentistry"}),
  p1Element("N-general-medical-center", 2.6, {name:"General Medical Center", amenity:"hospital"}),
  // Generic emergency=yes on an all-dental facility cannot prove a general ED (excluded).
  p1Element("O-dental-emergency-yes", 0.8, {name:"Clinique O", amenity:"hospital", emergency:"yes", "healthcare:speciality":"dentistry"})
];

const P1_EMERGENCY_RECOMMENDATION = {
  type:"hospital",
  label:"응급실·응급의학과 우선 추천",
  reason:"응급 위험 신호가 있어 특정 진료과보다 가까운 응급실 또는 종합병원을 우선 추천합니다.",
  keywords:["응급","응급실","emergency"],
  avoidKeywords:["치과","dental"],
  emergencyContext:true
};
const P1_ORDINARY_RECOMMENDATION = {
  type:"hospital",
  label:"가까운 병원·의원 추천",
  reason:"증상 정보가 부족하거나 판단이 애매해 가까운 병원 또는 의원 상담을 추천합니다.",
  keywords:["clinic","hospital"],
  avoidKeywords:["치과"]
};

function p1Success(elements){
  return proxyResponse({ok:true, schemaVersion:"1", provider:"primary", attemptsUsed:1, searchRadiusMeters:5000, complete:true, elements});
}

async function p1Search(recommendation, elements = P1_EMERGENCY_FIXTURE){
  const sandbox = loadProxySandbox(async () => p1Success(elements));
  return sandbox.fetchNearbyFacilities("hospital", P1_BASE, recommendation);
}

function p1Ids(list){ return Array.from(list, (facility) => String(facility.osmId)); }
function p1Distances(list){ return Array.from(list, (facility) => facility.distanceKm); }
function p1AssertAscending(list, label){
  const distances = p1Distances(list);
  for(let index = 1; index < distances.length; index += 1){
    assert.ok(distances[index - 1] <= distances[index], `${label}: ${distances.join(", ")}`);
  }
}

test("P1 emergency search excludes standalone dentist, urology and cosmetic-only facilities", async () => {
  const ids = p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION));
  for(const excluded of ["D-dentist", "D2-dental-hospital", "E-urology", "F-cosmetic", "H-dermatology", "K-university-hospital", "M-dental-medical-center", "O-dental-emergency-yes"]){
    assert.equal(ids.includes(excluded), false, `${excluded} must not be an emergency recommendation`);
  }
});

test("P1 emergency search keeps emergency and general hospitals that also list specialty departments", async () => {
  const result = await p1Search(P1_EMERGENCY_RECOMMENDATION);
  const ids = p1Ids(result);
  for(const kept of ["A-er-hospital", "B-er-hospital", "G-large-er-hospital", "C-general-hospital", "K2-university-hospital-mixed", "N-general-medical-center", "L-ortho-derm-clinic"]){
    assert.ok(ids.includes(kept), `${kept} must remain eligible`);
  }
  const large = result.find((facility) => facility.osmId === "G-large-er-hospital");
  assert.equal(large.emergencyCareConfirmed, true);
  assert.equal(large.emergencyNarrowSpecialty, false);
});

test("P1 emergency search orders confirmed emergency tier, then hospital fallback, then other facilities, by distance inside each tier", async () => {
  const result = await p1Search(P1_EMERGENCY_RECOMMENDATION);
  assert.deepEqual(p1Ids(result), [
    "A-er-hospital", "G-large-er-hospital", "B-er-hospital",
    "C-general-hospital", "N-general-medical-center", "K2-university-hospital-mixed",
    "L-ortho-derm-clinic", "I-family-clinic", "J-hospital-no-er"
  ]);
  p1AssertAscending(result.slice(0, 3), "confirmed emergency tier");
  p1AssertAscending(result.slice(3, 6), "hospital fallback tier");
  p1AssertAscending(result.slice(6), "other facility tier");
});

test("P1 emergency ordering is deterministic for any provider order", async () => {
  const expected = p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION));
  const reversed = P1_EMERGENCY_FIXTURE.slice().reverse();
  const rotated = P1_EMERGENCY_FIXTURE.slice(5).concat(P1_EMERGENCY_FIXTURE.slice(0, 5));
  const interleaved = P1_EMERGENCY_FIXTURE.filter((_, index) => index % 2).concat(P1_EMERGENCY_FIXTURE.filter((_, index) => !(index % 2)));
  for(const order of [reversed, rotated, interleaved, P1_EMERGENCY_FIXTURE]){
    assert.deepEqual(p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION, order)), expected);
  }
});

test("P1 ordinary hospital search keeps every facility in strict distance order", async () => {
  const result = await p1Search(P1_ORDINARY_RECOMMENDATION);
  assert.equal(result.length, P1_EMERGENCY_FIXTURE.length);
  assert.deepEqual(p1Ids(result), [
    "D-dentist", "D2-dental-hospital", "E-urology", "L-ortho-derm-clinic", "F-cosmetic", "M-dental-medical-center",
    "H-dermatology", "I-family-clinic", "C-general-hospital", "O-dental-emergency-yes", "J-hospital-no-er",
    "A-er-hospital", "G-large-er-hospital", "B-er-hospital", "N-general-medical-center", "K-university-hospital",
    "K2-university-hospital-mixed"
  ]);
  p1AssertAscending(result, "ordinary search");
  const withoutRecommendation = await p1Search(null);
  p1AssertAscending(withoutRecommendation, "no recommendation");
});

test("P1 v2 structured specialty metadata takes precedence over generic names and generic emergency tags", async () => {
  const fixtures = [
    // [element, emergency-eligible, expected tier when eligible]
    [p1Element("R1", 0.5, {name:"ABC Dental Medical Center", amenity:"hospital", "healthcare:speciality":"dentistry"}), false],
    [p1Element("R2", 0.6, {name:"한국대학교병원", amenity:"hospital", "healthcare:speciality":"dentistry;plastic_surgery"}), false],
    [p1Element("R3", 0.7, {name:"한국대학교병원", amenity:"hospital", "healthcare:speciality":"dentistry;plastic_surgery;internal_medicine"}), true],
    [p1Element("R4", 0.8, {name:"General Medical Center", amenity:"hospital"}), true],
    [p1Element("R5", 0.9, {name:"Grand Hopital", amenity:"hospital", emergency:"yes", "healthcare:speciality":"general;emergency;plastic_surgery;dentistry"}), true],
    [p1Element("R6", 1.0, {name:"Clinique R6", amenity:"hospital", emergency:"yes", "healthcare:speciality":"dentistry"}), false]
  ];
  const emergency = await p1Search(P1_EMERGENCY_RECOMMENDATION, fixtures.map(([element]) => element));
  assert.deepEqual(p1Ids(emergency), ["R5", "R3", "R4"]);
  assert.equal(emergency[0].emergencyCareConfirmed, true);

  const ordinary = await p1Search(P1_ORDINARY_RECOMMENDATION, fixtures.map(([element]) => element));
  assert.deepEqual(p1Ids(ordinary), ["R1", "R2", "R3", "R4", "R5", "R6"], "ordinary search keeps every facility");
  const byId = Object.fromEntries(ordinary.map((facility) => [String(facility.osmId), facility]));
  for(const [element, eligible] of fixtures){
    assert.equal(byId[element.id].emergencyNarrowSpecialty, !eligible, element.id);
  }
  // emergency=yes on an all-dental facility keeps the existing metadata flag but is still narrow.
  assert.equal(byId.R6.emergencyCareConfirmed, true);
  assert.equal(byId.R6.emergencyNarrowSpecialty, true);
});

test("P1 v2 without specialty metadata a narrow name is not rescued by generic hospital wording", async () => {
  const elements = [
    p1Element("U1", 0.3, {name:"ABC Dental Medical Center", amenity:"hospital"}),
    p1Element("U2", 0.4, {name:"한국대학교치과병원", amenity:"hospital"}),
    p1Element("U3", 0.5, {name:"강남 성형외과 의료원", amenity:"hospital"}),
    p1Element("U4", 0.6, {name:"Seoul General Hospital", amenity:"hospital"}),
    p1Element("U5", 0.7, {name:"서울 종합병원 치과센터", amenity:"hospital"}),
    p1Element("U6", 0.8, {name:"Ville Medical Centre", amenity:"hospital"})
  ];
  assert.deepEqual(p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION, elements)), ["U4", "U5", "U6"]);
});

test("P1 v3 dentist and alternative-medicine facility identity is never rescued by a specialty token", async () => {
  const elements = [
    p1Element("DA", 0.2, {name:"Practice DA", amenity:"doctors", healthcare:"dentist", "healthcare:speciality":"general"}),
    p1Element("DB", 0.3, {name:"Practice DB", amenity:"dentist", healthcare:"clinic", "healthcare:speciality":"general"}),
    p1Element("DC", 0.4, {name:"Practice DC", amenity:"clinic", healthcare:"dentist", "healthcare:speciality":"dentistry;general"}),
    p1Element("DD", 0.5, {name:"Practice DD", amenity:"hospital", healthcare:"dentist", emergency:"yes", "healthcare:speciality":"general"}),
    p1Element("AL", 0.6, {name:"Practice AL", amenity:"clinic", healthcare:"alternative", "healthcare:speciality":"general"}),
    p1Element("GP", 0.7, {name:"Practice GP", amenity:"clinic", healthcare:"clinic", "healthcare:speciality":"general"}),
    p1Element("ER", 0.8, {name:"Practice ER", amenity:"hospital", emergency:"yes"})
  ];
  assert.deepEqual(p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION, elements)), ["ER", "GP"]);
  assert.deepEqual(p1Ids(await p1Search(P1_ORDINARY_RECOMMENDATION, elements)), ["DA", "DB", "DC", "DD", "AL", "GP", "ER"]);
});

test("P1 v3 documented traditional and alternative medicine specialty values are excluded from emergency results", async () => {
  const elements = [
    p1Element("T1", 0.2, {name:"Clinic T1", amenity:"clinic", "healthcare:speciality":"acupuncture"}),
    p1Element("T2", 0.3, {name:"Clinic T2", amenity:"clinic", "healthcare:speciality":"traditional_chinese_medicine;herbalism"}),
    p1Element("T3", 0.4, {name:"Clinic T3", amenity:"doctors", "healthcare:speciality":"tuina"}),
    p1Element("T4", 0.5, {name:"경희 한의원", amenity:"clinic"}),
    p1Element("T5", 0.6, {name:"Hospital T5", amenity:"hospital", "healthcare:speciality":"general;acupuncture"}),
    p1Element("T6", 0.7, {name:"Clinic T6", amenity:"clinic", "healthcare:speciality":"internal"})
  ];
  assert.deepEqual(p1Ids(await p1Search(P1_EMERGENCY_RECOMMENDATION, elements)), ["T5", "T6"]);
  assert.deepEqual(p1Ids(await p1Search(P1_ORDINARY_RECOMMENDATION, elements)), ["T1", "T2", "T3", "T4", "T5", "T6"]);
});

function renderFacilitiesWithOrderLabels(facilities, type, recommendation){
  const elements = {facilityList:{innerHTML:""}, facilityTitle:{textContent:""}};
  const labels = {pill:{textContent:"거리순"}, hospitalHeader:{textContent:"거리순 병원 결과를 확인하세요."}};
  const sandbox = {
    document:{
      querySelectorAll(){ return []; },
      querySelector(selector){
        if(selector === "#facilityCard > .between > .distance") return labels.pill;
        if(selector === "#screen-hospital-results > .flow-screen-header p.small") return labels.hospitalHeader;
        return null;
      }
    },
    inputFacilities:facilities,
    inputType:type,
    inputRecommendation:recommendation,
    elements
  };
  const names = [
    "facilityDistanceValue", "normalizedFacilityName", "facilityDedupeKeys", "isEmergencyHospitalRecommendation",
    "facilityEmergencyTier", "compareFacilityResults", "finalizeFacilityResults", "renderFacilityList"
  ];
  vm.runInNewContext(
    `const MAX_FACILITY_RESULTS = 50;
     const FACILITY_PARTIAL_RESULTS_MESSAGE = "partial";
     let facilities = this.inputFacilities;
     let facilityType = this.inputType;
     let facilityRecommendation = this.inputRecommendation;
     let activeFacilitySearchRequest = {type:facilityType, generation:1};
     let facilitySearchErrorMessage = "";
     let isLoading = false;
     let locationData = {latitude:${P1_BASE.latitude}, longitude:${P1_BASE.longitude}, source:"gps"};
     function $(id){ return this.elements[id] || {classList:{remove(){}}, innerHTML:"", textContent:""}; }
     function t(){ return {hospital:"병원", pharmacy:"약국", userGps:"사용자 GPS", travelPlace:"여행지"}; }
     function isAppOffline(){ return false; }
     function isFacilitySearchCurrent(){ return true; }
     function facilityResultsMatchRequest(){ return true; }
     function on(){}
     function requestGps(){}
     function renderOfflineFacilityState(){}
     function safe(fn){ return fn(); }
     function openDirections(){}
     function escapeHtml(value){ return String(value || ""); }
     ${names.map((name) => extractNamedFunction(indexSource, name)).join("\n")}
     renderFacilityList();`,
    sandbox,
    {filename: INDEX_PATH}
  );
  const renderedIds = [...elements.facilityList.innerHTML.matchAll(/data-facility-card="([^"]+)"/g)].map((match) => match[1]);
  return {html:elements.facilityList.innerHTML, pill:labels.pill.textContent, header:labels.hospitalHeader.textContent, renderedIds};
}

test("P1 result label states emergency priority only when the order is emergency-first", async () => {
  const emergency = await p1Search(P1_EMERGENCY_RECOMMENDATION);
  const emergencyView = renderFacilitiesWithOrderLabels(emergency, "hospital", P1_EMERGENCY_RECOMMENDATION);
  assert.equal(emergencyView.pill, "응급 우선·거리순");
  assert.equal(emergencyView.header, "응급 우선·거리순 병원 결과를 확인하세요.");
  assert.ok(emergencyView.html.includes("※ 정렬: ① 지도 데이터에 응급 진료 표시가 있는 병원 ② 응급 여부 정보가 없는 병원 ③ 기타 의료기관(응급 진료 없음으로 표시된 병원 포함) 순서이며, 같은 단계 안에서는 가까운 순입니다. 응급 표시는 지도 데이터 기준이며 실제 응급실 운영을 보장하지 않습니다. 지도 데이터에서 치과·비뇨의학과·성형외과·피부과·안과·한방·대체의학 등 전문 진료 기관으로 식별된 곳은 응급 추천 목록에서 제외했습니다."));
  assert.equal((emergencyView.html.match(/>지도상 응급 표시<\/span>/g) || []).length, 3);
  // The data only shows emergency metadata on the map; never claim a verified emergency room.
  assert.doesNotMatch(emergencyView.html, /응급실 확인|응급실이 확인된/);

  const ordinary = await p1Search(P1_ORDINARY_RECOMMENDATION);
  const ordinaryView = renderFacilitiesWithOrderLabels(ordinary, "hospital", P1_ORDINARY_RECOMMENDATION);
  assert.equal(ordinaryView.pill, "거리순");
  assert.equal(ordinaryView.header, "거리순 병원 결과를 확인하세요.");
  assert.doesNotMatch(ordinaryView.html, /응급 우선|지도상 응급 표시|응급실 확인|응급실이 확인된/);

  const pharmacyView = renderFacilitiesWithOrderLabels([{id:"p1", type:"pharmacy", nameKo:"약국", nameEn:"Pharmacy", latitude:48.86, longitude:2.35, distanceKm:0.4}], "pharmacy", null);
  assert.equal(pharmacyView.pill, "거리순");
  assert.equal(pharmacyView.header, "거리순 병원 결과를 확인하세요.", "pharmacy never rewrites the hospital screen header");
});

test("P1 the rendered card order is exactly the committed result order", async () => {
  for(const recommendation of [P1_EMERGENCY_RECOMMENDATION, P1_ORDINARY_RECOMMENDATION]){
    const committed = await p1Search(recommendation);
    const view = renderFacilitiesWithOrderLabels(committed, "hospital", recommendation);
    assert.deepEqual(view.renderedIds, Array.from(committed, (facility) => facility.id));
  }
});
