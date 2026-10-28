// Generator provenance: a SHA-256 over the generator's own source files, so a
// manifest records exactly which code produced it. Line endings are
// normalized to LF first, so a Windows checkout (CRLF) and a Linux checkout of
// the same commit produce the same value.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {sha256Hex} from "./canonical-json.mjs";
import {GENERATOR_NAME, GENERATOR_VERSION} from "./generate.mjs";

export const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory, relativeBase = ""){
  const files = [];
  for(const entry of fs.readdirSync(directory, {withFileTypes: true})){
    const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if(entry.isDirectory()) files.push(...sourceFiles(absolute, relative));
    else if(entry.isFile() && entry.name.endsWith(".mjs")) files.push({relative, absolute});
  }
  return files;
}

export function generatorSourceSha256(root = GENERATOR_ROOT){
  const files = sourceFiles(root).sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  const parts = files.map((file) => {
    const text = fs.readFileSync(file.absolute, "utf8").replace(/\r\n/g, "\n");
    return `${file.relative}\u0000${text}\u0000`;
  });
  return sha256Hex(Buffer.from(parts.join(""), "utf8"));
}

export function generatorInfo(root = GENERATOR_ROOT){
  return {name: GENERATOR_NAME, version: GENERATOR_VERSION, sourceSha256: generatorSourceSha256(root)};
}
