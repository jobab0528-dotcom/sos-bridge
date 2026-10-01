// Unit tests: src/shared/ui-state.js (Phase 1 / Step 1 common contract).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  UI_STATE,
  UI_STATES,
  DEFAULT_RETRYABLE,
  isUiState,
  createUiResult,
  isUiResult
} from "../../src/shared/ui-state.js";

const MODULE_PATH = fileURLToPath(new URL("../../src/shared/ui-state.js", import.meta.url));

const REQUIRED_STATES = [
  "LOADING", "SUCCESS", "EMPTY", "PARTIAL", "FAILED", "OFFLINE", "PERMISSION_DENIED",
  "TIMEOUT", "STALE", "UNVERIFIED", "FALLBACK_USED", "NOT_CONFIGURED", "INVALID_INPUT"
];

test("1: every required state exists with a deterministic string value", () => {
  for(const name of REQUIRED_STATES){
    assert.equal(UI_STATE[name], name, `UI_STATE.${name}`);
    assert.ok(isUiState(name), name);
  }
  assert.deepEqual([...UI_STATES].sort(), [...REQUIRED_STATES].sort());
  assert.equal(new Set(UI_STATES).size, UI_STATES.length, "no duplicate values");
  for(const name of REQUIRED_STATES){
    assert.equal(typeof DEFAULT_RETRYABLE[name], "boolean", `default retry policy for ${name}`);
  }
});

test("2: state constants cannot be mutated", () => {
  assert.ok(Object.isFrozen(UI_STATE));
  assert.ok(Object.isFrozen(UI_STATES));
  assert.ok(Object.isFrozen(DEFAULT_RETRYABLE));
  assert.throws(() => { UI_STATE.SUCCESS = "FAILED"; }, TypeError);
  assert.throws(() => { UI_STATE.NEW_STATE = "NEW_STATE"; }, TypeError);
  assert.throws(() => { delete UI_STATE.LOADING; }, TypeError);
  assert.throws(() => { UI_STATES.push("SUCCESS"); }, TypeError);
  assert.throws(() => { DEFAULT_RETRYABLE.FAILED = false; }, TypeError);
  assert.equal(UI_STATE.SUCCESS, "SUCCESS");
});

test("3: a valid state produces an immutable result with the contract shape", () => {
  for(const state of UI_STATES){
    const result = createUiResult(state);
    assert.equal(result.state, state);
    assert.ok(isUiResult(result), state);
    assert.ok(Object.isFrozen(result), `${state} result frozen`);
    assert.ok(Object.isFrozen(result.reasons), `${state} reasons frozen`);
    assert.throws(() => { result.state = UI_STATE.SUCCESS; }, TypeError);
  }
  const withData = createUiResult(UI_STATE.PARTIAL, {data:{count:3}, reasons:["provider timeout"], retryable:true});
  assert.deepEqual({...withData}, {state:"PARTIAL", data:{count:3}, reasons:["provider timeout"], retryable:true});
});

test("4: an invalid state throws and is never coerced into SUCCESS or another state", () => {
  for(const bad of [undefined, null, "", "success", "Success", "OK", "VERIFIED", " SUCCESS", 0, 1, true, {}, [], Symbol.for("SUCCESS")]){
    assert.throws(() => createUiResult(bad), TypeError, String(typeof bad === "symbol" ? "symbol" : JSON.stringify(bad)));
    assert.equal(isUiState(bad), false);
  }
  assert.equal(isUiResult({state:"success", reasons:[], retryable:false}), false);
  assert.equal(isUiResult({state:"SUCCESS", reasons:"none", retryable:false}), false);
  assert.equal(isUiResult(null), false);
});

test("5: reasons default safely to an empty, clean, frozen list", () => {
  assert.deepEqual([...createUiResult(UI_STATE.FAILED).reasons], []);
  for(const bad of [undefined, null, "timeout", 42, {0:"x"}]){
    assert.deepEqual([...createUiResult(UI_STATE.FAILED, {reasons:bad}).reasons], [], JSON.stringify(bad));
  }
  const cleaned = createUiResult(UI_STATE.FAILED, {reasons:["  timeout  ", "", "   ", 7, null, {}, "offline"]});
  assert.deepEqual([...cleaned.reasons], ["timeout", "offline"]);
  const source = ["timeout"];
  const result = createUiResult(UI_STATE.FAILED, {reasons:source});
  source.push("mutated later");
  assert.deepEqual([...result.reasons], ["timeout"], "input array is copied");
});

test("6: retryable is always a boolean; only an explicit boolean overrides the default", () => {
  assert.equal(createUiResult(UI_STATE.TIMEOUT).retryable, true);
  assert.equal(createUiResult(UI_STATE.SUCCESS).retryable, false);
  assert.equal(createUiResult(UI_STATE.NOT_CONFIGURED).retryable, false);
  assert.equal(createUiResult(UI_STATE.INVALID_INPUT).retryable, false);
  assert.equal(createUiResult(UI_STATE.TIMEOUT, {retryable:false}).retryable, false);
  assert.equal(createUiResult(UI_STATE.SUCCESS, {retryable:true}).retryable, true);
  for(const notBoolean of ["true", "false", 1, 0, null, {}, []]){
    const result = createUiResult(UI_STATE.FAILED, {retryable:notBoolean});
    assert.equal(result.retryable, DEFAULT_RETRYABLE.FAILED, JSON.stringify(notBoolean));
    assert.equal(typeof result.retryable, "boolean");
  }
});

test("7: data is optional and absent when not provided", () => {
  const empty = createUiResult(UI_STATE.EMPTY);
  assert.equal(Object.prototype.hasOwnProperty.call(empty, "data"), false);
  assert.equal(empty.data, undefined);
  assert.ok(isUiResult(empty));
  assert.equal(createUiResult(UI_STATE.SUCCESS, {data:null}).data, null, "explicit null is kept");
  assert.equal(createUiResult(UI_STATE.SUCCESS, {data:0}).data, 0, "falsy data is kept");
  assert.ok(isUiResult(createUiResult(UI_STATE.LOADING, null)), "null options are tolerated");
});

test("8: the module has no imports and no DOM, storage or network dependency", async () => {
  const code = fs.readFileSync(MODULE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\s/m, "no import statements");
  assert.doesNotMatch(code, /\bimport\s*\(/, "no dynamic import");
  assert.doesNotMatch(code, /\b(?:window|document|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|WebSocket|require)\b/);

  const saved = {};
  const guarded = ["window", "document", "localStorage", "fetch", "navigator"];
  for(const name of guarded){
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable:true, get(){ throw new Error(`${name} accessed`); }});
  }
  try{
    const fresh = await import(`../../src/shared/ui-state.js?isolation=${Date.now()}`);
    assert.ok(fresh.isUiResult(fresh.createUiResult(fresh.UI_STATE.OFFLINE, {reasons:["offline"]})));
  }finally{
    for(const name of guarded){
      if(saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});
