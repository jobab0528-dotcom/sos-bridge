"use strict";

const SCHEMA_VERSION = "1";
const SEARCH_RADII_METERS = Object.freeze([5000, 10000, 20000, 50000]);
const ALLOWED_TYPES = new Set(["hospital", "pharmacy"]);
const ALLOWED_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "type",
  "latitude",
  "longitude",
  "maxRadiusMeters"
]);
const MAX_UPSTREAM_ATTEMPTS = 4;
const EARLY_EXIT_RAW_CANDIDATE_COUNT = 20;
const MAX_REQUEST_BODY_BYTES = 4096;
const OVERPASS_USER_AGENT = "SOS-Bridge/1.0";
const FACILITY_DIAGNOSTICS_ENABLED = process.env.FACILITY_DIAGNOSTICS === "1";

const PROVIDERS = Object.freeze([
  Object.freeze({id: "primary", url: "https://overpass-api.de/api/interpreter"}),
  Object.freeze({id: "secondary", url: "https://overpass.private.coffee/api/interpreter"})
]);

function positiveIntegerEnvironment(name, fallback, minimum, maximum){
  const raw = process.env[name];
  if(raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if(!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

// Production runtime compatibility remains a deployment gate. These limits are
// independently configurable so Netlify preview/runtime validation can tune them
// without changing the request contract.
const PROVIDER_TIMEOUT_MS = positiveIntegerEnvironment(
  "FACILITY_PROVIDER_TIMEOUT_MS",
  10000,
  1000,
  30000
);
const TOTAL_SEARCH_DEADLINE_MS = positiveIntegerEnvironment(
  "FACILITY_TOTAL_SEARCH_DEADLINE_MS",
  25000,
  3000,
  60000
);
// Server-side budget written into every Overpass query as [timeout:18].
const OVERPASS_QUERY_TIMEOUT_MS = 18000;
// Slack kept between the end of a primary attempt and the deadline-reserved
// secondary attempt (timer/abort latency and request setup), so the secondary
// always starts with its full reserve.
const FAILOVER_START_MARGIN_MS = 500;

// Per-attempt provider timeout. A primary attempt that can still fail over may
// use the part of the remaining deadline that is not reserved for one bounded
// secondary attempt (providerTimeoutMs plus the start margin), capped by the
// Overpass server budget and never below the base provider timeout.
// Defaults: 25s deadline -> primary 14.5s, secondary 10s (previously 10s + 10s).
function providerAttemptTimeoutMs(providerTimeoutMs, remainingMs, failoverAvailable){
  if(!failoverAvailable) return Math.min(providerTimeoutMs, remainingMs);
  const primaryShare = Math.min(OVERPASS_QUERY_TIMEOUT_MS, remainingMs - providerTimeoutMs - FAILOVER_START_MARGIN_MS);
  return Math.min(remainingMs, Math.max(providerTimeoutMs, primaryShare));
}

const jsonHeaders = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
});

function json(statusCode, body){
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function failureBody(code, retryable, attemptsUsed, diagnostics = {}){
  const body = {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    code,
    retryable: retryable === true,
    attemptsUsed
  };
  if(FACILITY_DIAGNOSTICS_ENABLED){
    if(diagnostics.provider === "primary" || diagnostics.provider === "secondary"){
      body.provider = diagnostics.provider;
    }
    if(Number.isInteger(diagnostics.upstreamStatus) &&
      diagnostics.upstreamStatus >= 100 && diagnostics.upstreamStatus <= 599){
      body.upstreamStatus = diagnostics.upstreamStatus;
      body.upstreamStatusClass = Math.floor(diagnostics.upstreamStatus / 100) + "xx";
    }
  }
  return body;
}

function invalidRequest(){
  return json(400, failureBody("FACILITY_INVALID_REQUEST", false, 0));
}

function isPlainObject(value){
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseRequest(event){
  const bodyText = typeof event.body === "string" ? event.body : "";
  if(!bodyText || Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BODY_BYTES) return null;

  let payload;
  try{
    payload = JSON.parse(bodyText);
  }catch(error){
    return null;
  }

  if(!isPlainObject(payload)) return null;
  const fields = Object.keys(payload);
  if(fields.length !== ALLOWED_REQUEST_FIELDS.size) return null;
  if(fields.some((field) => !ALLOWED_REQUEST_FIELDS.has(field))) return null;
  if(payload.schemaVersion !== SCHEMA_VERSION) return null;
  if(!ALLOWED_TYPES.has(payload.type)) return null;
  if(typeof payload.latitude !== "number" || !Number.isFinite(payload.latitude)) return null;
  if(payload.latitude < -90 || payload.latitude > 90) return null;
  if(typeof payload.longitude !== "number" || !Number.isFinite(payload.longitude)) return null;
  if(payload.longitude < -180 || payload.longitude > 180) return null;
  if(!SEARCH_RADII_METERS.includes(payload.maxRadiusMeters)) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    type: payload.type,
    latitude: payload.latitude,
    longitude: payload.longitude,
    maxRadiusMeters: payload.maxRadiusMeters
  };
}

function buildHospitalCoreQuery(latitude, longitude, radius){
  return `
    [out:json][timeout:18];
    (
      node(around:${radius},${latitude},${longitude})["amenity"~"hospital|clinic|doctors|doctor"];
      way(around:${radius},${latitude},${longitude})["amenity"~"hospital|clinic|doctors|doctor"];
      relation(around:${radius},${latitude},${longitude})["amenity"~"hospital|clinic|doctors|doctor"];

      node(around:${radius},${latitude},${longitude})["healthcare"~"hospital|clinic|doctor|doctors"];
      way(around:${radius},${latitude},${longitude})["healthcare"~"hospital|clinic|doctor|doctors"];
      relation(around:${radius},${latitude},${longitude})["healthcare"~"hospital|clinic|doctor|doctors"];
    );
    out center tags;
  `;
}

function buildHospitalExtendedQuery(latitude, longitude, radius){
  return `
    [out:json][timeout:18];
    (
      node(around:${radius},${latitude},${longitude})["healthcare"~"centre|center|yes"];
      way(around:${radius},${latitude},${longitude})["healthcare"~"centre|center|yes"];
      relation(around:${radius},${latitude},${longitude})["healthcare"~"centre|center|yes"];
    );
    out center tags;
  `;
}

function buildOverpassQuery(type, latitude, longitude, radius){
  if(type === "pharmacy"){
    return `
      [out:json][timeout:18];
      (
        node(around:${radius},${latitude},${longitude})["amenity"="pharmacy"];
        way(around:${radius},${latitude},${longitude})["amenity"="pharmacy"];
        relation(around:${radius},${latitude},${longitude})["amenity"="pharmacy"];
        node(around:${radius},${latitude},${longitude})["healthcare"="pharmacy"];
        way(around:${radius},${latitude},${longitude})["healthcare"="pharmacy"];
        relation(around:${radius},${latitude},${longitude})["healthcare"="pharmacy"];
      );
      out center tags;
    `;
  }

  return buildHospitalCoreQuery(latitude, longitude, radius);
}

function mergeOverpassElements(...elementGroups){
  const merged = [];
  const seen = new Set();

  for(const elements of elementGroups){
    if(!Array.isArray(elements)) continue;
    for(const element of elements){
      const hasIdentity = element && typeof element === "object" &&
        typeof element.type === "string" &&
        (typeof element.id === "string" || typeof element.id === "number");
      const identity = hasIdentity ? element.type + ":" + String(element.id) : "";
      if(identity && seen.has(identity)) continue;
      if(identity) seen.add(identity);
      merged.push(element);
    }
  }

  return merged;
}

function providerError(code, details = {}){
  const error = new Error(code);
  error.code = code;
  error.retryable = details.retryable === true;
  error.failoverEligible = details.failoverEligible === true;
  error.status = Number.isInteger(details.status) ? details.status : 0;
  error.providerId = details.providerId || "";
  return error;
}

function providerFailureDiagnostics(error){
  if(!error || typeof error !== "object") return {};
  return {
    provider: error.providerId,
    upstreamStatus: error.status
  };
}

function providerHttpError(status, providerId){
  if(status === 400){
    return providerError("FACILITY_QUERY_ERROR", {status, providerId});
  }
  if(status === 429){
    return providerError("FACILITY_RATE_LIMITED", {
      status,
      providerId,
      retryable: true,
      failoverEligible: true
    });
  }
  if([502, 503, 504].includes(status)){
    return providerError("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", {
      status,
      providerId,
      retryable: true,
      failoverEligible: true
    });
  }
  if(status >= 500){
    return providerError("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", {
      status,
      providerId,
      retryable: true
    });
  }
  return providerError("FACILITY_QUERY_ERROR", {status, providerId});
}

function publicFailureStatus(code){
  if(code === "FACILITY_INVALID_REQUEST") return 400;
  if(code === "FACILITY_RATE_LIMITED") return 429;
  if(code === "FACILITY_TIMEOUT") return 504;
  if(code === "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE") return 503;
  if(code === "FACILITY_QUERY_ERROR" || code === "FACILITY_INVALID_RESPONSE") return 502;
  return 503;
}

async function fetchProvider(provider, query, dependencies, deadlineAt, failoverAvailable = false){
  const remainingMs = deadlineAt - dependencies.now();
  if(remainingMs <= 0){
    throw providerError("FACILITY_TIMEOUT", {
      providerId: provider.id,
      retryable: true,
      failoverEligible: true
    });
  }

  const timeoutMs = Math.max(1, providerAttemptTimeoutMs(dependencies.providerTimeoutMs, remainingMs, failoverAvailable));
  const Controller = dependencies.AbortControllerImpl;
  const controller = typeof Controller === "function" ? new Controller() : null;
  let timeoutId;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = dependencies.setTimeoutImpl(() => {
      timedOut = true;
      if(controller) controller.abort();
      reject(providerError("FACILITY_TIMEOUT", {
        providerId: provider.id,
        retryable: true,
        failoverEligible: true
      }));
    }, timeoutMs);
  });

  try{
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": OVERPASS_USER_AGENT
      },
      body: "data=" + encodeURIComponent(query)
    };
    if(controller) options.signal = controller.signal;

    const requestPromise = Promise.resolve().then(async () => {
      const response = await dependencies.fetchImpl(provider.url, options);
      if(!response || typeof response.status !== "number" || typeof response.text !== "function"){
        throw providerError("FACILITY_INVALID_RESPONSE", {providerId: provider.id});
      }
      if(response.status < 200 || response.status >= 300){
        throw providerHttpError(response.status, provider.id);
      }

      let bodyText;
      try{
        bodyText = await response.text();
      }catch(error){
        throw providerError("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", {
          providerId: provider.id,
          retryable: true,
          failoverEligible: true
        });
      }

      let data;
      try{
        data = JSON.parse(bodyText);
      }catch(error){
        throw providerError("FACILITY_INVALID_RESPONSE", {providerId: provider.id});
      }
      if(!isPlainObject(data) || !Array.isArray(data.elements)){
        throw providerError("FACILITY_INVALID_RESPONSE", {providerId: provider.id});
      }

      return {providerId: provider.id, elements: data.elements};
    });

    return await Promise.race([requestPromise, timeoutPromise]);
  }catch(error){
    if(error && error.code) throw error;
    if(timedOut || (error && error.name === "AbortError")){
      throw providerError("FACILITY_TIMEOUT", {
        providerId: provider.id,
        retryable: true,
        failoverEligible: true
      });
    }
    throw providerError("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", {
      providerId: provider.id,
      retryable: true,
      failoverEligible: true
    });
  }finally{
    dependencies.clearTimeoutImpl(timeoutId);
  }
}

async function fetchRadiusWithFailover(query, state, dependencies, deadlineAt){
  const providerIndexes = state.preferredProviderIndex === 1 ? [1] : [0, 1];
  let lastError = null;

  for(const providerIndex of providerIndexes){
    if(state.attemptsUsed >= MAX_UPSTREAM_ATTEMPTS) break;
    if(dependencies.now() >= deadlineAt){
      lastError = providerError("FACILITY_TIMEOUT", {retryable: true});
      break;
    }

    const provider = PROVIDERS[providerIndex];
    state.attemptsUsed += 1;
    const failoverAvailable = providerIndex === 0 && providerIndexes.includes(1) &&
      state.attemptsUsed < MAX_UPSTREAM_ATTEMPTS;
    try{
      const result = await fetchProvider(provider, query, dependencies, deadlineAt, failoverAvailable);
      state.preferredProviderIndex = providerIndex;
      return result;
    }catch(error){
      lastError = error;
      const canTrySecondary = providerIndex === 0 && error.failoverEligible === true &&
        state.attemptsUsed < MAX_UPSTREAM_ATTEMPTS && dependencies.now() < deadlineAt;
      if(canTrySecondary) continue;
      throw error;
    }
  }

  throw lastError || providerError("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", {retryable: true});
}

function successBody({providerId, attemptsUsed, radius, complete, elements, incompleteReason}){
  const body = {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    provider: providerId,
    attemptsUsed,
    searchRadiusMeters: radius,
    complete,
    elements
  };
  if(!complete){
    body.code = "FACILITY_PARTIAL_RESULTS";
    body.incompleteReason = incompleteReason || "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE";
  }
  return body;
}

async function searchFacilities(request, dependencies){
  const state = {attemptsUsed: 0, preferredProviderIndex: 0};
  const deadlineAt = dependencies.now() + dependencies.totalSearchDeadlineMs;
  const radii = SEARCH_RADII_METERS.filter((radius) => radius <= request.maxRadiusMeters);
  let lastSuccess = null;

  for(const radius of radii){
    if(state.attemptsUsed >= MAX_UPSTREAM_ATTEMPTS || dependencies.now() >= deadlineAt){
      if(lastSuccess){
        return {
          statusCode: 200,
          body: successBody({
            ...lastSuccess,
            attemptsUsed: state.attemptsUsed,
            complete: false,
            incompleteReason: dependencies.now() >= deadlineAt
              ? "FACILITY_TIMEOUT"
              : "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE"
          })
        };
      }
      const code = dependencies.now() >= deadlineAt
        ? "FACILITY_TIMEOUT"
        : "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE";
      return {
        statusCode: publicFailureStatus(code),
        body: failureBody(code, true, state.attemptsUsed)
      };
    }

    const query = buildOverpassQuery(request.type, request.latitude, request.longitude, radius);
    try{
      const result = await fetchRadiusWithFailover(query, state, dependencies, deadlineAt);
      lastSuccess = {
        providerId: result.providerId,
        radius,
        elements: request.type === "hospital"
          ? mergeOverpassElements(lastSuccess && lastSuccess.elements, result.elements)
          : result.elements
      };

      const policyComplete = lastSuccess.elements.length >= EARLY_EXIT_RAW_CANDIDATE_COUNT ||
        (request.type === "pharmacy" && radius === radii[radii.length - 1]);
      if(policyComplete){
        return {
          statusCode: 200,
          body: successBody({
            ...lastSuccess,
            attemptsUsed: state.attemptsUsed,
            complete: true
          })
        };
      }

      if(request.type === "hospital"){
        const extendedQuery = buildHospitalExtendedQuery(
          request.latitude,
          request.longitude,
          radius
        );
        const extendedResult = await fetchRadiusWithFailover(
          extendedQuery,
          state,
          dependencies,
          deadlineAt
        );
        lastSuccess = {
          providerId: extendedResult.providerId,
          radius,
          elements: mergeOverpassElements(lastSuccess.elements, extendedResult.elements)
        };

        const extendedPolicyComplete =
          lastSuccess.elements.length >= EARLY_EXIT_RAW_CANDIDATE_COUNT ||
          radius === radii[radii.length - 1];
        if(extendedPolicyComplete){
          return {
            statusCode: 200,
            body: successBody({
              ...lastSuccess,
              attemptsUsed: state.attemptsUsed,
              complete: true
            })
          };
        }
      }
    }catch(error){
      if(lastSuccess){
        return {
          statusCode: 200,
          body: successBody({
            ...lastSuccess,
            attemptsUsed: state.attemptsUsed,
            complete: false,
            incompleteReason: error.code
          })
        };
      }
      const code = error && error.code || "FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE";
      return {
        statusCode: publicFailureStatus(code),
        body: failureBody(
          code,
          !!(error && error.retryable),
          state.attemptsUsed,
          providerFailureDiagnostics(error)
        )
      };
    }
  }

  if(lastSuccess){
    return {
      statusCode: 200,
      body: successBody({
        ...lastSuccess,
        attemptsUsed: state.attemptsUsed,
        complete: true
      })
    };
  }
  return {
    statusCode: 503,
    body: failureBody("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true, state.attemptsUsed)
  };
}

function createNearbyFacilitiesHandler(options = {}){
  const dependencies = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    AbortControllerImpl: options.AbortControllerImpl || globalThis.AbortController,
    now: options.now || Date.now,
    setTimeoutImpl: options.setTimeoutImpl || setTimeout,
    clearTimeoutImpl: options.clearTimeoutImpl || clearTimeout,
    providerTimeoutMs: options.providerTimeoutMs || PROVIDER_TIMEOUT_MS,
    totalSearchDeadlineMs: options.totalSearchDeadlineMs || TOTAL_SEARCH_DEADLINE_MS
  };

  return async (event = {}) => {
    if(event.httpMethod !== "POST"){
      return json(405, failureBody("FACILITY_INVALID_REQUEST", false, 0));
    }

    const request = parseRequest(event);
    if(!request) return invalidRequest();
    if(typeof dependencies.fetchImpl !== "function"){
      return json(503, failureBody("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true, 0));
    }

    try{
      const result = await searchFacilities(request, dependencies);
      return json(result.statusCode, result.body);
    }catch(error){
      return json(503, failureBody("FACILITY_SERVICE_TEMPORARILY_UNAVAILABLE", true, 0));
    }
  };
}

exports.handler = createNearbyFacilitiesHandler();
exports._test = Object.freeze({
  ALLOWED_REQUEST_FIELDS,
  EARLY_EXIT_RAW_CANDIDATE_COUNT,
  FAILOVER_START_MARGIN_MS,
  MAX_UPSTREAM_ATTEMPTS,
  OVERPASS_QUERY_TIMEOUT_MS,
  PROVIDERS,
  PROVIDER_TIMEOUT_MS,
  SEARCH_RADII_METERS,
  TOTAL_SEARCH_DEADLINE_MS,
  buildHospitalCoreQuery,
  buildHospitalExtendedQuery,
  buildOverpassQuery,
  createNearbyFacilitiesHandler,
  mergeOverpassElements,
  parseRequest,
  providerAttemptTimeoutMs
});
