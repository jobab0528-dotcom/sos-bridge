// Quality-gate configuration for one dataset build (the --quality-gates JSON
// file). Thresholds are DATA decisions that need a person: they are not
// guessed in code. A required gate whose threshold is missing is reported as
// NOT_CONFIGURED (never PASSED) and the candidate is NOT accepted: the writer
// refuses to write it (lib/write-output.mjs).
//
// {
//   "schemaVersion": "1",
//   "regionCode": "KR",
//   "description": "who set these values, when and why",
//   "maxRejectedRatio": 0.01,
//   "allowIncompleteGeometry": [
//     {"object": "way/123", "reason": "why this exact object may be excluded"}
//   ],
//   "acknowledgeEmergencyOutsideDataBounds": [
//     {"object": "node/456", "reason": "who reviewed it and why it is outside this dataset"}
//   ]
// }
//
// maxRejectedRatio: rejected / (rejected + accepted objects), see generate.mjs.
// allowIncompleteGeometry: the ONLY way to build when a facility's geometry
// cannot be resolved (lib/integrity.mjs). Each entry names one object and why
// excluding it is acceptable (for example: verified upstream mapping error,
// object crosses the extract boundary). The object is excluded, never placed
// approximately. An entry that does not match an unresolved object stops the
// build (stale allowance), and an object carrying affirmative OSM emergency
// evidence can never be allowed.
// acknowledgeEmergencyOutsideDataBounds: the ONLY way to build when a hospital
// with affirmative OSM emergency evidence lies outside the region data bounds.
// Each entry names one object and the review reason; the object is excluded
// and listed (with coordinates and reason) in the report and manifest, and a
// PENDING_REVIEW publish gate is added. Stale entries stop the build. This
// acknowledgement does NOT apply to invalid coordinates or unresolved geometry
// of emergency objects: those always stop the build.

import {DatasetBuildError} from "./errors.mjs";

const KEYS = new Set(["schemaVersion", "regionCode", "description", "maxRejectedRatio", "allowIncompleteGeometry", "acknowledgeEmergencyOutsideDataBounds"]);
const OBJECT_LABEL = /^(node|way|relation)\/[1-9]\d{0,15}$/;
const MAX_ALLOWANCES = 1000;

function invalid(message){
  throw new DatasetBuildError("INVALID_QUALITY_GATES", message);
}

function isRecord(value){
  if(value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value){
  return Object.keys(value);
}

// Returns a normalized, frozen configuration. `undefined` means "no file":
// every configurable gate is NOT_CONFIGURED and no allowance exists.
export function normalizeQualityGates(config, regionCode){
  if(config === undefined || config === null){
    return Object.freeze({configured: false, maxRejectedRatio: null, allowIncompleteGeometry: new Map(), acknowledgeEmergencyOutsideDataBounds: new Map(), description: null});
  }
  if(!isRecord(config)) invalid("quality gates must be a JSON object");
  for(const key of ownKeys(config)){
    if(!KEYS.has(key)) invalid(`unknown key "${key}"`);
  }
  if(config.schemaVersion !== "1") invalid('schemaVersion must be "1"');
  if(config.regionCode !== regionCode) invalid(`regionCode must be "${regionCode}"`);
  if(Object.prototype.hasOwnProperty.call(config, "description") &&
    (typeof config.description !== "string" || config.description.length > 500)){
    invalid("description must be a string of at most 500 characters");
  }
  let maxRejectedRatio = null;
  if(Object.prototype.hasOwnProperty.call(config, "maxRejectedRatio")){
    const value = config.maxRejectedRatio;
    if(typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1){
      invalid("maxRejectedRatio must be a number from 0 to 1");
    }
    maxRejectedRatio = value;
  }
  const allowances = new Map();
  if(Object.prototype.hasOwnProperty.call(config, "allowIncompleteGeometry")){
    const list = config.allowIncompleteGeometry;
    if(!Array.isArray(list) || list.length > MAX_ALLOWANCES) invalid(`allowIncompleteGeometry must be an array of at most ${MAX_ALLOWANCES} entries`);
    for(const entry of list){
      if(!isRecord(entry) || ownKeys(entry).some((key) => key !== "object" && key !== "reason")){
        invalid("each allowance must be {object, reason}");
      }
      if(typeof entry.object !== "string" || !OBJECT_LABEL.test(entry.object)) invalid(`allowance object must look like "way/123", got ${JSON.stringify(entry.object)}`);
      if(entry.object.startsWith("node/")) invalid(`${entry.object}: a node facility has no referenced geometry to allow`);
      if(typeof entry.reason !== "string" || entry.reason.trim().length < 10 || entry.reason.length > 500){
        invalid(`${entry.object}: reason must be 10 to 500 characters`);
      }
      if(allowances.has(entry.object)) invalid(`${entry.object} is listed twice`);
      allowances.set(entry.object, entry.reason);
    }
  }
  const acknowledgements = new Map();
  if(Object.prototype.hasOwnProperty.call(config, "acknowledgeEmergencyOutsideDataBounds")){
    const list = config.acknowledgeEmergencyOutsideDataBounds;
    if(!Array.isArray(list) || list.length > MAX_ALLOWANCES) invalid(`acknowledgeEmergencyOutsideDataBounds must be an array of at most ${MAX_ALLOWANCES} entries`);
    for(const entry of list){
      if(!isRecord(entry) || ownKeys(entry).some((key) => key !== "object" && key !== "reason")){
        invalid("each acknowledgement must be {object, reason}");
      }
      if(typeof entry.object !== "string" || !OBJECT_LABEL.test(entry.object)) invalid(`acknowledgement object must look like "node/123", got ${JSON.stringify(entry.object)}`);
      if(typeof entry.reason !== "string" || entry.reason.trim().length < 10 || entry.reason.length > 500){
        invalid(`${entry.object}: reason must be 10 to 500 characters`);
      }
      if(acknowledgements.has(entry.object)) invalid(`${entry.object} is acknowledged twice`);
      acknowledgements.set(entry.object, entry.reason);
    }
  }
  return Object.freeze({
    configured: true,
    maxRejectedRatio,
    allowIncompleteGeometry: allowances,
    acknowledgeEmergencyOutsideDataBounds: acknowledgements,
    description: typeof config.description === "string" ? config.description : null
  });
}
