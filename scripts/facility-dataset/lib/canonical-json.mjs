// Canonical JSON serialization for the static facility dataset generator.
// Object keys are sorted by UTF-16 code unit order, arrays keep their order,
// and only JSON-safe values are accepted, so the same logical value always
// produces the same bytes (and therefore the same SHA-256).

import {createHash} from "node:crypto";

function isPlainObject(value){
  if(value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value, path){
  if(value === null) return "null";
  if(typeof value === "string") return JSON.stringify(value);
  if(typeof value === "boolean") return value ? "true" : "false";
  if(typeof value === "number"){
    if(!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if(Array.isArray(value)){
    return "[" + value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",") + "]";
  }
  if(isPlainObject(value)){
    const keys = Object.keys(value).sort();
    const parts = [];
    for(const key of keys){
      if(value[key] === undefined) throw new TypeError(`Undefined value at ${path}.${key}`);
      parts.push(JSON.stringify(key) + ":" + serialize(value[key], `${path}.${key}`));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`Unsupported value type at ${path}`);
}

export function canonicalJson(value){
  return serialize(value, "$");
}

// Canonical JSON plus a trailing newline, as UTF-8 bytes.
export function canonicalJsonBytes(value){
  return Buffer.from(canonicalJson(value) + "\n", "utf8");
}

export function sha256Hex(bytes){
  return createHash("sha256").update(bytes).digest("hex");
}

export {isPlainObject};
