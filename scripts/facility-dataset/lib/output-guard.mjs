// Output containment guard: the generator must never write inside the
// repository, because netlify.toml publishes the repository root.
//
// Checks, all fail-closed:
// 1. Lexical: resolved path components (not string prefixes). A first
//    relative component of exactly ".." means outside; a directory merely
//    NAMED "..something" is inside. Case-insensitive on Windows and macOS.
// 2. Canonical: the nearest existing ancestor of the output path is resolved
//    with realpath (symlinks, Windows junctions, short names), then the
//    lexical check is repeated on the canonical paths.
// 3. Identity: every canonical ancestor of the output path is compared with
//    the repository root by device and inode, which also catches
//    case-insensitive or otherwise aliased file systems.
// Anything that cannot be established (unreadable ancestor, dangling symlink,
// missing inode numbers) is refused. The guard itself never writes.

import fs from "node:fs";
import path from "node:path";

export class OutputGuardError extends Error{
  constructor(code, message){
    super(`${code}: ${message}`);
    this.name = "OutputGuardError";
    this.code = code;
  }
}

export function defaultCaseInsensitive(pathApi = path, platform = process.platform){
  return pathApi === path.win32 || platform === "win32" || platform === "darwin";
}

// True when `child` is `parent` or any descendant of it.
export function isPathInside(child, parent, options = {}){
  const pathApi = options.pathApi || path;
  const caseInsensitive = options.caseInsensitive === undefined
    ? defaultCaseInsensitive(pathApi)
    : options.caseInsensitive;
  let resolvedChild = pathApi.resolve(child);
  let resolvedParent = pathApi.resolve(parent);
  if(caseInsensitive){
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  const relative = pathApi.relative(resolvedParent, resolvedChild);
  if(relative === "") return true;
  if(pathApi.isAbsolute(relative)) return false; // another drive or root
  const firstComponent = relative.split(pathApi.sep)[0];
  return firstComponent !== "..";
}

function refuse(code, message){
  throw new OutputGuardError(code, message);
}

function sameIdentity(a, b){
  return a.dev === b.dev && a.ino === b.ino;
}

// Throws unless `outPath` is verifiably outside `repositoryRoot`.
export function assertOutsideRepository(outPath, repositoryRoot, fsApi = fs){
  if(typeof outPath !== "string" || outPath === "" || outPath.includes("\0")){
    refuse("INVALID_OUTPUT_PATH", "output path must be a non-empty path");
  }
  const resolvedOut = path.resolve(outPath);
  const resolvedRepository = path.resolve(repositoryRoot);
  if(isPathInside(resolvedOut, resolvedRepository)){
    refuse("OUTPUT_INSIDE_REPOSITORY", "refusing to write inside the repository (it is the Netlify publish directory)");
  }

  let realRepository;
  let repositoryStat;
  try{
    realRepository = fsApi.realpathSync.native ? fsApi.realpathSync.native(resolvedRepository) : fsApi.realpathSync(resolvedRepository);
    repositoryStat = fsApi.statSync(realRepository, {bigint: true});
  }catch(error){
    refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "repository root cannot be resolved");
  }
  if(!repositoryStat || repositoryStat.ino === 0n){
    refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "file system does not report directory identity");
  }

  // Nearest existing ancestor (lstat: a dangling symlink counts as existing).
  let ancestor = resolvedOut;
  const missing = [];
  for(;;){
    let exists = true;
    try{
      fsApi.lstatSync(ancestor);
    }catch(error){
      if(error && error.code === "ENOENT") exists = false;
      else refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "an output path ancestor cannot be inspected");
    }
    if(exists) break;
    const parent = path.dirname(ancestor);
    if(parent === ancestor) refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "no existing ancestor");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  let realAncestor;
  try{
    realAncestor = fsApi.realpathSync.native ? fsApi.realpathSync.native(ancestor) : fsApi.realpathSync(ancestor);
  }catch(error){
    refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "an output path ancestor cannot be resolved (dangling link?)");
  }
  const canonicalOut = path.join(realAncestor, ...missing);
  if(isPathInside(canonicalOut, realRepository)){
    refuse("OUTPUT_INSIDE_REPOSITORY", "output resolves inside the repository");
  }

  for(let current = realAncestor; ; current = path.dirname(current)){
    let stat;
    try{
      stat = fsApi.statSync(current, {bigint: true});
    }catch(error){
      refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "an output path ancestor cannot be inspected");
    }
    if(stat.ino === 0n) refuse("OUTPUT_CONTAINMENT_UNVERIFIABLE", "file system does not report directory identity");
    if(sameIdentity(stat, repositoryStat)){
      refuse("OUTPUT_INSIDE_REPOSITORY", "output is inside the repository (same directory identity)");
    }
    if(path.dirname(current) === current) break;
  }
  return canonicalOut;
}
