"use strict";

const SCHEMA_VERSION = "2";
const FACILITY_TYPES = Object.freeze(["hospital", "pharmacy"]);
const PRIORITY_MODES = Object.freeze(["distance", "emergency-first"]);
const ALLOWED_RADII_METERS = Object.freeze([5000, 10000, 20000, 50000]);
const MAX_RESULT_LIMIT = 50;
const DEFAULT_RESULT_LIMIT = 50;
const DEFAULT_PRIORITY_MODE = "distance";
const CRITERIA_KEYS = Object.freeze([
  "countryCode",
  "type",
  "latitude",
  "longitude",
  "radiusMeters",
  "priorityMode",
  "limit"
]);

class FacilityRepositoryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "FacilityRepositoryError";
    this.code = code;
  }
}

function invalid(message) {
  throw new FacilityRepositoryError("FACILITY_INVALID_REQUEST", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateExecutor(executor) {
  if (!executor || typeof executor !== "object" || typeof executor.query !== "function") {
    throw new FacilityRepositoryError(
      "FACILITY_DB_UNAVAILABLE",
      "A DB-independent executor with query(sqlText, params) is required."
    );
  }
  return executor;
}

function validateCriteria(input) {
  if (!isPlainObject(input)) invalid("Criteria must be a plain object.");

  const keys = Object.keys(input);
  if (keys.some((key) => !CRITERIA_KEYS.includes(key))) {
    invalid("Criteria contains an unsupported field.");
  }

  const countryCode = input.countryCode;
  const type = input.type;
  const latitude = input.latitude;
  const longitude = input.longitude;
  const radiusMeters = input.radiusMeters;
  const priorityMode = input.priorityMode === undefined
    ? DEFAULT_PRIORITY_MODE
    : input.priorityMode;
  const limit = input.limit === undefined ? DEFAULT_RESULT_LIMIT : input.limit;

  if (typeof countryCode !== "string" || !/^[A-Z]{2}$/.test(countryCode)) {
    invalid("countryCode must be an uppercase alpha-2 code.");
  }
  if (!FACILITY_TYPES.includes(type)) invalid("type must be hospital or pharmacy.");
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    invalid("latitude is out of range.");
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    invalid("longitude is out of range.");
  }
  if (!ALLOWED_RADII_METERS.includes(radiusMeters)) {
    invalid("radiusMeters is not allowed.");
  }
  if (!PRIORITY_MODES.includes(priorityMode)) invalid("priorityMode is not allowed.");
  if (type === "pharmacy" && priorityMode === "emergency-first") {
    invalid("Pharmacy searches cannot use emergency-first ordering.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    invalid("limit must be an integer from 1 through 50.");
  }

  return Object.freeze({
    countryCode,
    type,
    latitude,
    longitude,
    radiusMeters,
    priorityMode,
    limit
  });
}

module.exports = Object.freeze({
  ALLOWED_RADII_METERS,
  CRITERIA_KEYS,
  DEFAULT_PRIORITY_MODE,
  DEFAULT_RESULT_LIMIT,
  FACILITY_TYPES,
  FacilityRepositoryError,
  MAX_RESULT_LIMIT,
  PRIORITY_MODES,
  SCHEMA_VERSION,
  validateCriteria,
  validateExecutor
});
