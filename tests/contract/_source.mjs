// Shared helpers for tests/contract/*.test.mjs (not a test file itself).
// Reads production sources as text and extracts declarations so the real
// code can be executed inside node:vm sandboxes. Production files are never
// modified. The scanner skips strings, template literals, comments and regex
// literals, so it does not depend on line numbers or whitespace.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readRepoFile(relativePath){
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

export function repoFileExists(relativePath){
  return fs.existsSync(path.join(ROOT, relativePath));
}

const REGEX_PREFIX_CHARS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "yield", "await"]);

function regexAllowedAt(source, index){
  let cursor = index - 1;
  while(cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if(cursor < 0) return true;
  const previous = source[cursor];
  if(REGEX_PREFIX_CHARS.has(previous)) return true;
  if(/[A-Za-z_$]/.test(previous)){
    let start = cursor;
    while(start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1;
    return REGEX_PREFIX_WORDS.has(source.slice(start, cursor + 1));
  }
  return false;
}

// Returns the index just after the token that starts at `index` when that
// token is a string, template, comment or regex literal; otherwise -1.
function skipNonCode(source, index){
  const char = source[index];
  const next = source[index + 1];
  if(char === "/" && next === "/"){
    const end = source.indexOf("\n", index);
    return end === -1 ? source.length : end;
  }
  if(char === "/" && next === "*"){
    const end = source.indexOf("*/", index + 2);
    if(end === -1) throw new Error("Unterminated block comment");
    return end + 2;
  }
  if(char === '"' || char === "'"){
    for(let cursor = index + 1; cursor < source.length; cursor += 1){
      if(source[cursor] === "\\"){ cursor += 1; continue; }
      if(source[cursor] === char) return cursor + 1;
    }
    throw new Error("Unterminated string literal");
  }
  if(char === "`"){
    for(let cursor = index + 1; cursor < source.length; cursor += 1){
      if(source[cursor] === "\\"){ cursor += 1; continue; }
      if(source[cursor] === "`") return cursor + 1;
      if(source[cursor] === "$" && source[cursor + 1] === "{"){
        cursor = findMatchingClose(source, cursor + 1);
      }
    }
    throw new Error("Unterminated template literal");
  }
  if(char === "/" && regexAllowedAt(source, index)){
    let inClass = false;
    for(let cursor = index + 1; cursor < source.length; cursor += 1){
      const current = source[cursor];
      if(current === "\\"){ cursor += 1; continue; }
      if(current === "\n") return -1;
      if(current === "[") inClass = true;
      else if(current === "]") inClass = false;
      else if(current === "/" && !inClass){
        let end = cursor + 1;
        while(end < source.length && /[a-z]/i.test(source[end])) end += 1;
        return end;
      }
    }
    return -1;
  }
  return -1;
}

const PAIRS = {"(": ")", "{": "}", "[": "]"};

// `openIndex` must point at "(", "{" or "["; returns the index of its match.
export function findMatchingClose(source, openIndex){
  const stack = [PAIRS[source[openIndex]]];
  if(!stack[0]) throw new Error(`No opening bracket at ${openIndex}`);
  for(let index = openIndex + 1; index < source.length; index += 1){
    const skipped = skipNonCode(source, index);
    if(skipped !== -1){ index = skipped - 1; continue; }
    const char = source[index];
    if(PAIRS[char]) stack.push(PAIRS[char]);
    else if(char === ")" || char === "}" || char === "]"){
      if(stack.pop() !== char) throw new Error(`Unbalanced "${char}" at ${index}`);
      if(!stack.length) return index;
    }
  }
  throw new Error("Unbalanced brackets: reached end of source");
}

function findDeclaration(source, pattern, label){
  const matches = [...source.matchAll(pattern)];
  if(!matches.length) throw new Error(`${label} declaration missing`);
  // When a name is declared twice, the later declaration is the effective one.
  return matches[matches.length - 1].index;
}

export function extractFunction(source, name){
  const start = findDeclaration(source, new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "g"), name);
  const declarationStart = source.indexOf("function", start);
  const paramsOpen = source.indexOf("(", declarationStart);
  const paramsClose = findMatchingClose(source, paramsOpen);
  const bodyOpen = source.indexOf("{", paramsClose);
  const bodyClose = findMatchingClose(source, bodyOpen);
  return source.slice(declarationStart, bodyClose + 1);
}

export function extractConst(source, name){
  const start = findDeclaration(source, new RegExp(`(?:^|\\n)\\s*const\\s+${name}\\s*=`, "g"), name);
  const declarationStart = source.indexOf("const", start);
  let valueStart = source.indexOf("=", declarationStart) + 1;
  while(/\s/.test(source[valueStart])) valueStart += 1;
  if(source[valueStart] === '"' || source[valueStart] === "'" || source[valueStart] === "`"){
    const literalEnd = skipNonCode(source, valueStart);
    return `const ${name} = ${source.slice(valueStart, literalEnd)};`;
  }
  if(!PAIRS[source[valueStart]]) throw new Error(`${name} is not an object/array/string literal`);
  const valueEnd = findMatchingClose(source, valueStart);
  return `const ${name} = ${source.slice(valueStart, valueEnd + 1)};`;
}

// The main application script loaded by index.html: an inline IIFE or a local
// external classic script (src/app/legacy-app.js). Exactly one must exist.
export function mainAppScript(indexSource){
  const inlineScripts = [...indexSource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const externalScripts = [...indexSource.matchAll(/<script\b[^>]*\bsrc="\.\/([^"?#]+\.js)"[^>]*><\/script>/g)]
    .map((match) => match[1])
    .filter((relativePath) => repoFileExists(relativePath))
    .map((relativePath) => readRepoFile(relativePath));
  const mains = [...inlineScripts, ...externalScripts].filter((script) => script.includes("PRIORITY_COUNTRY_CODES"));
  if(mains.length !== 1) throw new Error(`expected exactly one main application script loaded by index.html, found ${mains.length}`);
  return mains[0];
}

export function loadCountries(){
  const sandbox = {window:{}};
  vm.runInNewContext(readRepoFile("countries.js"), sandbox, {filename:"countries.js"});
  const countries = sandbox.window.SOS_BRIDGE_COUNTRIES;
  if(!Array.isArray(countries)) throw new Error("countries.js did not define window.SOS_BRIDGE_COUNTRIES");
  // Copy into this realm so deepEqual is not affected by vm-realm prototypes.
  return JSON.parse(JSON.stringify(countries));
}

export function evaluateInSandbox(code, sandbox, filename){
  vm.runInNewContext(code, sandbox, {filename});
  return sandbox;
}

// Any accidental real network call inside a contract test fails loudly.
export function forbidNetwork(){
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`Real network call attempted in contract test: ${url}`);
  };
  return () => { globalThis.fetch = original; };
}
