"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const FUNCTION_PATH = path.join(ROOT, "netlify/functions/nearby-facilities.js");
const functionSource = fs.readFileSync(FUNCTION_PATH, "utf8");

function loadFunction(consoleImpl = console, environment = {}){
  const module = {exports: {}};
  const sandbox = {
    module,
    exports: module.exports,
    process: {env: {...environment}},
    Buffer,
    AbortController,
    fetch: async () => { throw new Error("unexpected unmocked fetch"); },
    setTimeout,
    clearTimeout,
    console: consoleImpl
  };
  vm.runInNewContext(functionSource, sandbox, {filename: FUNCTION_PATH});
  return module.exports;
}

function validRequest(overrides = {}){
  return {
    schemaVersion: "1",
    type: "hospital",
    latitude: 35.6762,
    longitude: 139.6503,
    maxRadiusMeters: 50000,
    ...overrides
  };
}

function elements(count, type = "hospital"){
  return Array.from({length: count}, (_, index) => ({
    type: "node",
    id: index + 1,
    lat: 35.6762 + index / 100000,
    lon: 139.6503 + index / 100000,
    tags: type === "pharmacy" ? {amenity: "pharmacy"} : {amenity: "hospital"}
  }));
}

function upstreamResponse(status, body = {elements: []}){
  return {
    status,
    async text(){
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

async function invoke(handler, payload = validRequest()){
  const response = await handler({
    httpMethod: "POST",
    body: JSON.stringify(payload)
  });
  return {...response, json: JSON.parse(response.body)};
}

test("A valid hospital request returns primary JSON elements", async () => {
  const calls = [];
  const {createNearbyFacilitiesHandler} = loadFunction()._test;
  const handler = createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.provider, "primary");
  assert.equal(result.json.elements.length, 20);
  assert.match(decodeURIComponent(calls[0].options.body), /hospital\|clinic\|doctors\|doctor/);
});

test("B valid pharmacy request preserves pharmacy query meaning", async () => {
  const calls = [];
  const {createNearbyFacilitiesHandler} = loadFunction()._test;
  const handler = createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {elements: elements(20, "pharmacy")});
    }
  });
  const result = await invoke(handler, validRequest({type: "pharmacy"}));
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.elements.length, 20);
  const query = decodeURIComponent(calls[0].options.body);
  assert.match(query, /amenity"="pharmacy/);
  assert.match(query, /healthcare"="pharmacy/);
});

test("C invalid latitude is rejected before provider fetch", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const result = await invoke(handler, validRequest({latitude: 90.0001}));
  assert.equal(result.statusCode, 400);
  assert.equal(result.json.code, "FACILITY_INVALID_REQUEST");
  assert.equal(calls, 0);
});

test("D invalid longitude is rejected before provider fetch", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const result = await invoke(handler, validRequest({longitude: -180.0001}));
  assert.equal(result.statusCode, 400);
  assert.equal(result.json.attemptsUsed, 0);
  assert.equal(calls, 0);
});

test("E invalid facility type is rejected", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const result = await invoke(handler, validRequest({type: "doctor"}));
  assert.equal(result.statusCode, 400);
  assert.equal(result.json.code, "FACILITY_INVALID_REQUEST");
  assert.equal(calls, 0);
});

test("F maxRadius greater than 50km is rejected", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 100000}));
  assert.equal(result.statusCode, 400);
  assert.equal(calls, 0);
});

test("G raw query injection is rejected and never executed", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const result = await invoke(handler, {...validRequest(), rawQuery: "[out:json];node(0,0,1,1);out;"});
  assert.equal(result.statusCode, 400);
  assert.equal(result.json.code, "FACILITY_INVALID_REQUEST");
  assert.equal(calls, 0);
});

test("H primary 504 fails over once to secondary 200", async () => {
  const calls = [];
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("overpass-api.de")
        ? upstreamResponse(504, "<html>gateway timeout</html>")
        : upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.provider, "secondary");
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(calls.length, 2);
});

test("I primary 429 fails over once to secondary 200", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? upstreamResponse(429) : upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.provider, "secondary");
  assert.equal(calls, 2);
});

test("J primary network failure fails over once to secondary 200", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => {
      calls += 1;
      if(calls === 1) throw new TypeError("network unavailable");
      return upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(calls, 2);
});

test("K primary timeout fails over once to secondary 200", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    providerTimeoutMs: 5,
    totalSearchDeadlineMs: 100,
    fetchImpl: async (url, options) => {
      calls += 1;
      if(calls === 1){
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, {once: true});
        });
      }
      return upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.provider, "secondary");
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(calls, 2);
});

test("V72 CORE primary and secondary timeout preserve FACILITY_TIMEOUT", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    providerTimeoutMs: 5,
    totalSearchDeadlineMs: 100,
    fetchImpl: async (url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, {once: true});
      });
    }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 504);
  assert.equal(result.json.code, "FACILITY_TIMEOUT");
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(calls, 2);
});

test("L primary 400 is a query error and secondary is not called", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(400); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 502);
  assert.equal(result.json.code, "FACILITY_QUERY_ERROR");
  assert.equal(result.json.retryable, false);
  assert.equal("provider" in result.json, false);
  assert.equal("upstreamStatus" in result.json, false);
  assert.equal("upstreamStatusClass" in result.json, false);
  assert.equal(calls, 1);
});

test("M primary 200 HTML is FACILITY_INVALID_RESPONSE", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200, "<html>not json</html>"); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 502);
  assert.equal(result.json.code, "FACILITY_INVALID_RESPONSE");
  assert.equal(calls, 1);
});

test("N primary 200 malformed JSON is FACILITY_INVALID_RESPONSE", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200, "{\"elements\":[}"); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 502);
  assert.equal(result.json.code, "FACILITY_INVALID_RESPONSE");
  assert.equal(calls, 1);
});

test("O two provider 504 responses become service unavailable", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(504, "<html>timeout</html>"); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 503);
  assert.equal(result.json.code, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(calls, 2);
});

test("P one invocation never exceeds four upstream attempts", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200, {elements: []}); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.complete, false);
  assert.equal(result.json.code, "FACILITY_PARTIAL_RESULTS");
  assert.equal(result.json.searchRadiusMeters, 10000);
  assert.equal(result.json.attemptsUsed, 4);
  assert.equal(calls, 4);
});

test("Q a wider-radius provider outage returns explicit partial results", async () => {
  let calls = 0;
  const firstRadiusElements = elements(5);
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => {
      calls += 1;
      if(calls === 1) return upstreamResponse(200, {elements: firstRadiusElements});
      return upstreamResponse(504, "<html>timeout</html>");
    }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.complete, false);
  assert.equal(result.json.code, "FACILITY_PARTIAL_RESULTS");
  assert.equal(result.json.incompleteReason, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(result.json.searchRadiusMeters, 5000);
  assert.equal(result.json.elements.length, 5);
  assert.equal(calls, 3);
});

test("R twenty raw candidates stop unnecessary wider-radius requests", async () => {
  const calls = [];
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler);
  assert.equal(result.json.complete, true);
  assert.equal(result.json.searchRadiusMeters, 5000);
  assert.equal(result.json.attemptsUsed, 1);
  assert.equal(calls.length, 1);
  const query = new URLSearchParams(calls[0].options.body).get("data");
  assert.match(query, /healthcare"~"hospital\|clinic\|doctor\|doctors/);
  assert.doesNotMatch(query, /healthcare"~"centre\|center\|yes/);
});

test("V72 insufficient CORE uses one EXTENDED query and dedupes merged elements", async () => {
  const calls = [];
  const coreElements = elements(2);
  const extendedElements = [
    {...coreElements[1], tags: {healthcare: "yes"}},
    {
      type: "node",
      id: 3,
      lat: 35.6765,
      lon: 139.6505,
      tags: {healthcare: "centre"}
    }
  ];
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {
        elements: calls.length === 1 ? coreElements : extendedElements
      });
    }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.complete, true);
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(result.json.elements.length, 3);
  assert.deepEqual(
    result.json.elements.map((element) => `${element.type}:${element.id}`),
    ["node:1", "node:2", "node:3"]
  );
  assert.equal(calls.length, 2);
  const coreQuery = new URLSearchParams(calls[0].options.body).get("data");
  const extendedQuery = new URLSearchParams(calls[1].options.body).get("data");
  assert.doesNotMatch(coreQuery, /centre\|center\|yes/);
  assert.match(extendedQuery, /centre\|center\|yes/);
});

test("S exact coordinates are never passed to a logger", async () => {
  const logged = [];
  const consoleSpy = {
    log: (...args) => logged.push(args),
    warn: (...args) => logged.push(args),
    error: (...args) => logged.push(args)
  };
  const handler = loadFunction(consoleSpy)._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => upstreamResponse(200, {elements: elements(20)})
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(logged, []);
  assert.doesNotMatch(functionSource, /console\.(?:log|warn|error)\s*\(/);
});

test("T the request body is never logged", async () => {
  const logged = [];
  const consoleSpy = {
    log: (...args) => logged.push(args),
    warn: (...args) => logged.push(args),
    error: (...args) => logged.push(args)
  };
  const handler = loadFunction(consoleSpy)._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => upstreamResponse(200, {elements: elements(20)})
  });
  const result = await invoke(handler, validRequest({type: "pharmacy"}));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(logged, []);
  assert.doesNotMatch(functionSource, /console\.log\s*\(\s*event(?:\.body)?\s*\)/);
});

function normalizedOverpassQuery(query){
  return String(query).trim().split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

test("FACILITY_QUERY_CONTRACT hospital CORE query uses only explicit medical selectors", () => {
  const {buildOverpassQuery} = loadFunction()._test;
  const actual = normalizedOverpassQuery(buildOverpassQuery("hospital", 35.6762, 139.6503, 5000));
  const expected = [
    "[out:json][timeout:18];",
    "(",
    "node(around:5000,35.6762,139.6503)[\"amenity\"~\"hospital|clinic|doctors|doctor\"];",
    "way(around:5000,35.6762,139.6503)[\"amenity\"~\"hospital|clinic|doctors|doctor\"];",
    "relation(around:5000,35.6762,139.6503)[\"amenity\"~\"hospital|clinic|doctors|doctor\"];",
    "node(around:5000,35.6762,139.6503)[\"healthcare\"~\"hospital|clinic|doctor|doctors\"];",
    "way(around:5000,35.6762,139.6503)[\"healthcare\"~\"hospital|clinic|doctor|doctors\"];",
    "relation(around:5000,35.6762,139.6503)[\"healthcare\"~\"hospital|clinic|doctor|doctors\"];",
    ");",
    "out center tags;"
  ].join("\n");
  assert.equal(actual, expected);
  assert.doesNotMatch(actual, /healthcare"~"[^\n]*(?:yes|centre|center)/);
});

test("FACILITY_QUERY_CONTRACT hospital EXTENDED query contains only deferred healthcare selectors", () => {
  const {buildHospitalExtendedQuery} = loadFunction()._test;
  const actual = normalizedOverpassQuery(buildHospitalExtendedQuery(35.6762, 139.6503, 5000));
  const expected = [
    "[out:json][timeout:18];",
    "(",
    "node(around:5000,35.6762,139.6503)[\"healthcare\"~\"centre|center|yes\"];",
    "way(around:5000,35.6762,139.6503)[\"healthcare\"~\"centre|center|yes\"];",
    "relation(around:5000,35.6762,139.6503)[\"healthcare\"~\"centre|center|yes\"];",
    ");",
    "out center tags;"
  ].join("\n");
  assert.equal(actual, expected);
  assert.doesNotMatch(actual, /amenity/);
  assert.doesNotMatch(actual, /hospital\|clinic\|doctor\|doctors/);
});

test("FACILITY_QUERY_CONTRACT pharmacy query preserves the exact selector grammar", () => {
  const {buildOverpassQuery} = loadFunction()._test;
  const actual = normalizedOverpassQuery(buildOverpassQuery("pharmacy", 35.6762, 139.6503, 5000));
  const expected = [
    "[out:json][timeout:18];",
    "(",
    "node(around:5000,35.6762,139.6503)[\"amenity\"=\"pharmacy\"];",
    "way(around:5000,35.6762,139.6503)[\"amenity\"=\"pharmacy\"];",
    "relation(around:5000,35.6762,139.6503)[\"amenity\"=\"pharmacy\"];",
    "node(around:5000,35.6762,139.6503)[\"healthcare\"=\"pharmacy\"];",
    "way(around:5000,35.6762,139.6503)[\"healthcare\"=\"pharmacy\"];",
    "relation(around:5000,35.6762,139.6503)[\"healthcare\"=\"pharmacy\"];",
    ");",
    "out center tags;"
  ].join("\n");
  assert.equal(actual, expected);
});

test("FACILITY_QUERY_CONTRACT form transport decodes to the generated query", async () => {
  const calls = [];
  const {buildOverpassQuery, createNearbyFacilitiesHandler} = loadFunction()._test;
  const request = validRequest({maxRadiusMeters: 5000});
  const handler = createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler, request);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0].options.headers)),
    {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "SOS-Bridge/1.0"
    }
  );
  const userAgent = calls[0].options.headers["User-Agent"];
  const rawQuery = buildOverpassQuery("hospital", request.latitude, request.longitude, 5000);
  assert.doesNotMatch(userAgent, new RegExp(String(request.latitude).replace(".", "\\.")));
  assert.doesNotMatch(userAgent, new RegExp(String(request.longitude).replace(".", "\\.")));
  assert.equal(userAgent.includes(calls[0].options.body), false);
  assert.equal(userAgent.includes(rawQuery), false);
  assert.doesNotMatch(userAgent, /hospital|pharmacy|clinic|doctor|healthcare|amenity/i);
  assert.equal(
    new URLSearchParams(calls[0].options.body).get("data"),
    rawQuery
  );
});

test("FACILITY_HEADER_CONTRACT secondary request uses the same identifying app User-Agent", async () => {
  const calls = [];
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return calls.length === 1
        ? upstreamResponse(504, "unavailable")
        : upstreamResponse(200, {elements: elements(20)});
    }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["User-Agent"], "SOS-Bridge/1.0");
  assert.equal(calls[1].options.headers["User-Agent"], "SOS-Bridge/1.0");
  assert.equal(
    calls[1].options.headers["Content-Type"],
    "application/x-www-form-urlencoded;charset=UTF-8"
  );
});

test("FACILITY_HEADER_CONTRACT pharmacy form body remains unchanged", async () => {
  const calls = [];
  const {buildOverpassQuery, createNearbyFacilitiesHandler} = loadFunction()._test;
  const handler = createNearbyFacilitiesHandler({
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return upstreamResponse(200, {elements: elements(20, "pharmacy")});
    }
  });
  const result = await invoke(handler, validRequest({type: "pharmacy", maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["User-Agent"], "SOS-Bridge/1.0");
  assert.equal(
    calls[0].options.headers["Content-Type"],
    "application/x-www-form-urlencoded;charset=UTF-8"
  );
  assert.equal(
    new URLSearchParams(calls[0].options.body).get("data"),
    buildOverpassQuery("pharmacy", 35.6762, 139.6503, 5000)
  );
});

test("FACILITY_PROVIDER_DIAGNOSTICS defaults OFF in production responses", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(403, "blocked"); }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 502);
  assert.deepEqual(Object.keys(result.json), [
    "ok", "schemaVersion", "code", "retryable", "attemptsUsed"
  ]);
  assert.equal(result.json.code, "FACILITY_QUERY_ERROR");
  assert.equal(result.json.retryable, false);
  assert.equal(result.json.attemptsUsed, 1);
  assert.equal("provider" in result.json, false);
  assert.equal("upstreamStatus" in result.json, false);
  assert.equal("upstreamStatusClass" in result.json, false);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result.json), /35\.6762|139\.6503|\[out:json\]|overpass-api|private\.coffee/);
});

test("FACILITY_PROVIDER_DIAGNOSTICS exposes only safe HTTP metadata when explicitly ON", async () => {
  let calls = 0;
  const handler = loadFunction(console, {FACILITY_DIAGNOSTICS: "1"})._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(403, "blocked"); }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 502);
  assert.deepEqual(Object.keys(result.json), [
    "ok", "schemaVersion", "code", "retryable", "attemptsUsed",
    "provider", "upstreamStatus", "upstreamStatusClass"
  ]);
  assert.equal(result.json.provider, "primary");
  assert.equal(result.json.upstreamStatus, 403);
  assert.equal(result.json.upstreamStatusClass, "4xx");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result.json), /35\.6762|139\.6503|\[out:json\]|around:|data=|overpass-api|private\.coffee|blocked/);
});

test("FACILITY_PROVIDER_DIAGNOSTICS reports the terminal secondary status without changing failover", async () => {
  let calls = 0;
  const handler = loadFunction(console, {FACILITY_DIAGNOSTICS: "1"})._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => {
      calls += 1;
      return upstreamResponse(calls === 1 ? 504 : 503, "unavailable");
    }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 503);
  assert.equal(result.json.code, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(result.json.retryable, true);
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(result.json.provider, "secondary");
  assert.equal(result.json.upstreamStatus, 503);
  assert.equal(result.json.upstreamStatusClass, "5xx");
  assert.equal(calls, 2);
});

test("FACILITY_PROVIDER_DIAGNOSTICS omits an upstream status for network failures", async () => {
  let calls = 0;
  const handler = loadFunction(console, {FACILITY_DIAGNOSTICS: "1"})._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; throw new Error("network"); }
  });
  const result = await invoke(handler, validRequest({maxRadiusMeters: 5000}));
  assert.equal(result.statusCode, 503);
  assert.equal(result.json.code, "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.equal(result.json.retryable, true);
  assert.equal(result.json.attemptsUsed, 2);
  assert.equal(result.json.provider, "secondary");
  assert.equal("upstreamStatus" in result.json, false);
  assert.equal("upstreamStatusClass" in result.json, false);
  assert.equal(calls, 2);
});

test("P0 invalid method is rejected before provider fetch", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const response = await handler({httpMethod:"GET", body:""});
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 405);
  assert.equal(body.code, "FACILITY_INVALID_REQUEST");
  assert.equal(body.attemptsUsed, 0);
  assert.equal(calls, 0);
});

test("P0 malformed JSON body and unsupported schema are rejected", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200); }
  });
  const malformed = await handler({httpMethod:"POST", body:"{"});
  const wrongSchema = await invoke(handler, validRequest({schemaVersion:"2"}));
  assert.equal(malformed.statusCode, 400);
  assert.equal(JSON.parse(malformed.body).code, "FACILITY_INVALID_REQUEST");
  assert.equal(wrongSchema.statusCode, 400);
  assert.equal(wrongSchema.json.code, "FACILITY_INVALID_REQUEST");
  assert.equal(calls, 0);
});

test("P0 terminal provider rate limit preserves the safe public rate-limit code", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(429, "rate limited"); }
  });
  const result = await invoke(handler);
  assert.equal(result.statusCode, 429);
  assert.equal(result.json.code, "FACILITY_RATE_LIMITED");
  assert.equal(result.json.retryable, true);
  assert.equal(calls, 2);
});

test("P0 pharmacy complete zero result remains successful data", async () => {
  let calls = 0;
  const handler = loadFunction()._test.createNearbyFacilitiesHandler({
    fetchImpl: async () => { calls += 1; return upstreamResponse(200, {elements:[]}); }
  });
  const result = await invoke(handler, validRequest({type:"pharmacy"}));
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.complete, true);
  assert.equal(result.json.searchRadiusMeters, 50000);
  assert.deepEqual(result.json.elements, []);
  assert.equal(calls, 4);
});
