// Regression tests for independent-review FINDING 2: the CLI output guard
// must reject the repository root and every descendant (including directory
// names that merely start with ".."), symlinked or otherwise aliased paths
// into the repository, and anything whose containment cannot be established,
// without writing anything. Real output outside the repository keeps working.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {isPathInside, assertOutsideRepository, defaultCaseInsensitive, OutputGuardError} from "../../scripts/facility-dataset/lib/output-guard.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {ROOT, FIXTURE_PATH, GENERATOR_DIR} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const CLI = path.join(GENERATOR_DIR, "build-dataset.mjs");

function runCli(out, cwd = ROOT){
  return spawnSync(process.execPath, [CLI, "--input", FIXTURE_PATH, "--region", "KR", "--out", out], {cwd, encoding: "utf8"});
}

function listTree(directory){
  const entries = [];
  const walk = (current, prefix) => {
    for(const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))){
      if(entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries.push(relative);
      if(entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(current, entry.name), relative);
    }
  };
  walk(directory, "");
  return entries;
}

// Windows: creating a directory SYMLINK needs the "Create symbolic links"
// privilege (administrator) or Developer Mode, otherwise EPERM. A directory
// JUNCTION needs no privilege, so it is tried next. Returns the link kind, or
// null only when Windows refuses both for permission reasons.
const LINK_SKIP_REASON = "SKIPPED (environment, not a guard result): this Windows account may create neither " +
  "directory symlinks (EPERM: needs the Create-symbolic-links privilege or Developer Mode) nor junctions. " +
  "The same symlink, alias and dangling-link logic is covered without real links by tests 6 and 6b (mock file system); " +
  "the guard itself stays fail-closed.";

function createDirectoryLink(target, linkPath, fsApi = fs, platform = process.platform){
  try{
    fsApi.symlinkSync(target, linkPath, "dir");
    return "symlink";
  }catch(error){
    if(platform !== "win32" || !["EPERM", "EACCES"].includes(error && error.code)) throw error;
  }
  try{
    fsApi.symlinkSync(target, linkPath, "junction");
    return "junction";
  }catch(error){
    if(["EPERM", "EACCES"].includes(error && error.code)) return null;
    throw error;
  }
}

function expectGuard(code, fn){
  assert.throws(fn, (error) => error instanceof OutputGuardError && error.code === code, code);
}

test("1: the exact reported bypass (a repository child named ..audit-output) is rejected by the CLI with no writes", () => {
  const before = listTree(ROOT);
  for(const [out, cwd] of [
    ["..audit-output", ROOT],
    ["./..audit-output", ROOT],
    [path.join(ROOT, "..audit-output"), os.tmpdir()],
    [path.join(ROOT, "..audit-output", "nested"), os.tmpdir()],
    ["scripts/../..audit-output", ROOT],
    ["...", ROOT]
  ]){
    const result = runCli(out, cwd);
    assert.equal(result.status, 1, `${out} must be refused`);
    assert.equal(JSON.parse(result.stderr).code, "OUTPUT_INSIDE_REPOSITORY", out);
  }
  assert.deepEqual(listTree(ROOT), before, "no file, directory or staging artifact was created in the repository");
  // The guard runs before the input is even read.
  const early = spawnSync(process.execPath, [CLI, "--input", path.join(os.tmpdir(), "missing-input-for-guard-test.json"), "--region", "KR", "--out", "..audit-output"], {cwd: ROOT, encoding: "utf8"});
  assert.equal(early.status, 1);
  assert.equal(JSON.parse(early.stderr).code, "OUTPUT_INSIDE_REPOSITORY");
});

test("2: repository root, descendants, relative and absolute spellings are all rejected with no writes", () => {
  const before = listTree(ROOT);
  const cases = [
    [".", ROOT], ["./", ROOT], ["scripts", ROOT], ["tests/fixtures/out", ROOT], ["src/../tests/x", ROOT],
    [ROOT, os.tmpdir()], [ROOT + path.sep, os.tmpdir()], [path.join(ROOT, "scripts", "facility-dataset"), os.tmpdir()],
    [path.join(ROOT, "a", "..", "b"), os.tmpdir()], [path.relative(os.tmpdir(), path.join(ROOT, "new-dir")), os.tmpdir()]
  ];
  for(const [out, cwd] of cases){
    const result = runCli(out, cwd);
    assert.equal(result.status, 1, `${out} (cwd ${cwd})`);
    assert.equal(JSON.parse(result.stderr).code, "OUTPUT_INSIDE_REPOSITORY", out);
  }
  assert.deepEqual(listTree(ROOT), before);
});

test("3: component-based containment: '..name' is inside, '..' is outside, prefixes are not containment", () => {
  const repo = path.resolve("/srv/repo");
  assert.equal(isPathInside(path.join(repo, "..audit-output"), repo), true);
  assert.equal(isPathInside(path.join(repo, "..."), repo), true);
  assert.equal(isPathInside(path.join(repo, "a", "..b"), repo), true);
  assert.equal(isPathInside(repo, repo), true);
  assert.equal(isPathInside(path.join(repo, ".."), repo), false);
  assert.equal(isPathInside(path.join(repo, "..", "sibling"), repo), false);
  assert.equal(isPathInside(repo + "2", repo), false, "string prefix is not containment");
  assert.equal(isPathInside(path.resolve("/srv/repository"), repo), false);
  assert.equal(isPathInside(path.resolve("/"), repo), false);
});

test("4: Windows path semantics (path.win32): drives, case variants, '..name', UNC", () => {
  const win = {pathApi: path.win32};
  assert.equal(defaultCaseInsensitive(path.win32), true);
  assert.equal(isPathInside("C:\\repo\\..audit-output", "C:\\repo", win), true);
  assert.equal(isPathInside("c:\\REPO\\Sub", "C:\\repo", win), true, "case variant");
  assert.equal(isPathInside("C:/repo/sub", "C:\\repo", win), true, "forward slashes");
  assert.equal(isPathInside("C:\\repo", "c:\\Repo\\", win), true);
  assert.equal(isPathInside("C:\\repo\\..\\other", "C:\\repo", win), false);
  assert.equal(isPathInside("C:\\repo2", "C:\\repo", win), false);
  assert.equal(isPathInside("D:\\repo\\sub", "C:\\repo", win), false, "another drive");
  assert.equal(isPathInside("\\\\server\\share\\repo\\..x", "\\\\server\\share\\repo", win), true);
  assert.equal(isPathInside("\\\\server\\share\\other", "\\\\server\\share\\repo", win), false);
  // Case-insensitive comparison is the default on Windows and macOS only.
  assert.equal(defaultCaseInsensitive(path.posix, "linux"), false);
  assert.equal(defaultCaseInsensitive(path.posix, "darwin"), true);
  assert.equal(isPathInside("/srv/REPO/x", "/srv/repo", {pathApi: path.posix, caseInsensitive: true}), true);
  assert.equal(isPathInside("/srv/REPO/x", "/srv/repo", {pathApi: path.posix, caseInsensitive: false}), false);
});

test("5a: checks that need no directory links (missing repository, invalid paths, real external output path)", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sos-guard-"));
  t.after(() => fs.rmSync(sandbox, {recursive: true, force: true}));
  const fakeRepo = path.join(sandbox, "repo");
  fs.mkdirSync(fakeRepo);
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(outside);
  const before = listTree(sandbox);
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(outside, "x"), path.join(sandbox, "missing-repo")));
  expectGuard("INVALID_OUTPUT_PATH", () => assertOutsideRepository("", fakeRepo));
  expectGuard("INVALID_OUTPUT_PATH", () => assertOutsideRepository("a\0b", fakeRepo));
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(fakeRepo, "..audit-output"), fakeRepo));
  // realpathSync.native, like the guard (on Windows it also expands 8.3 short names).
  assert.equal(assertOutsideRepository(path.join(outside, "new", "deeper"), fakeRepo), path.join(fs.realpathSync.native(outside), "new", "deeper"));
  assert.deepEqual(listTree(sandbox), before, "guard never writes");
});

test("5b: real directory links (symlink, or junction on Windows) into the repository and dangling links are refused", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sos-guard-"));
  const created = [];
  // One cleanup hook: remove the links themselves first, then the sandbox,
  // so cleanup can never follow a link into the real repository.
  t.after(() => {
    for(const linkPath of created){
      try{ fs.unlinkSync(linkPath); }catch(error){ if(error.code !== "ENOENT") fs.rmdirSync(linkPath); }
    }
    fs.rmSync(sandbox, {recursive: true, force: true});
  });
  const fakeRepo = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(fakeRepo, "inner"), {recursive: true});
  fs.writeFileSync(path.join(fakeRepo, "index.html"), "x");
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(outside);
  // Only the CREATION of links may be skipped (Windows without the symlink
  // privilege and without junction support). Every guard assertion below
  // still fails the test when the guard misbehaves.
  // The dangling link is made by linking to a directory and then removing
  // that directory, which works the same for symlinks and junctions.
  const vanishing = path.join(sandbox, "vanishing-target");
  fs.mkdirSync(vanishing);
  const links = [
    [fakeRepo, path.join(sandbox, "link-to-repo")],
    [path.join(fakeRepo, "inner"), path.join(outside, "link-to-inner")],
    [vanishing, path.join(sandbox, "dangling")],
    [ROOT, path.join(sandbox, "link-to-real-repo")]
  ];
  for(const [target, linkPath] of links){
    const kind = createDirectoryLink(target, linkPath);
    if(kind === null){
      t.skip(LINK_SKIP_REASON);
      return;
    }
    created.push(linkPath);
  }
  fs.rmdirSync(vanishing);
  const before = listTree(sandbox);
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(sandbox, "link-to-repo"), fakeRepo));
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(sandbox, "link-to-repo", "..audit-output", "x"), fakeRepo));
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(outside, "link-to-inner", "new"), fakeRepo));
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(fakeRepo, "..audit-output"), path.join(sandbox, "link-to-repo")));
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(sandbox, "dangling", "x"), fakeRepo));
  assert.deepEqual(listTree(sandbox), before, "guard never writes");

  // Through the real CLI against the real repository: a link to it is refused.
  const treeBefore = listTree(ROOT);
  const result = runCli(path.join(sandbox, "link-to-real-repo", "..audit-output"), os.tmpdir());
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "OUTPUT_INSIDE_REPOSITORY");
  assert.deepEqual(listTree(ROOT), treeBefore);
});

test("5c: link-creation fallback is narrow: only Windows permission errors lead to a skip", () => {
  const error = (code) => Object.assign(new Error(code), {code});
  const fakeFs = (failures) => ({
    symlinkSync: (target, linkPath, type) => { if(failures[type]) throw error(failures[type]); }
  });
  assert.equal(createDirectoryLink("t", "l", fakeFs({}), "linux"), "symlink");
  assert.equal(createDirectoryLink("t", "l", fakeFs({dir: "EPERM"}), "win32"), "junction");
  assert.equal(createDirectoryLink("t", "l", fakeFs({dir: "EPERM", junction: "EPERM"}), "win32"), null);
  assert.throws(() => createDirectoryLink("t", "l", fakeFs({dir: "EPERM"}), "linux"), /EPERM/, "no skip outside Windows");
  assert.throws(() => createDirectoryLink("t", "l", fakeFs({dir: "EEXIST"}), "win32"), /EEXIST/, "other errors are failures");
  assert.throws(() => createDirectoryLink("t", "l", fakeFs({dir: "EPERM", junction: "EEXIST"}), "win32"), /EEXIST/);
});

test("6: identity check catches aliases that path strings cannot (case-insensitive or aliased file systems), and missing inode numbers fail closed", () => {
  // Simulated file system: the output's ancestor is a differently spelled
  // alias of the repository directory (same device and inode).
  const repo = path.resolve("/virtual/Repo");
  const alias = path.resolve("/virtual/repo-alias");
  const stats = new Map([
    [repo, {dev: 1n, ino: 42n}],
    [alias, {dev: 1n, ino: 42n}],
    [path.resolve("/virtual"), {dev: 1n, ino: 2n}],
    [path.resolve("/"), {dev: 1n, ino: 1n}]
  ]);
  const enoent = () => Object.assign(new Error("ENOENT"), {code: "ENOENT"});
  const fakeFs = (overrides = {}) => ({
    realpathSync: Object.assign((value) => { if(!stats.has(value)) throw enoent(); return value; }, {native: undefined}),
    lstatSync: (value) => { if(!stats.has(value)) throw enoent(); return {}; },
    statSync: (value) => { if(!stats.has(value)) throw enoent(); return (overrides[value] || stats.get(value)); }
  });
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(alias, "out"), repo, fakeFs()));
  assert.equal(assertOutsideRepository(path.join(path.resolve("/virtual"), "elsewhere"), repo, fakeFs()), path.join(path.resolve("/virtual"), "elsewhere"));
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(path.resolve("/virtual"), "x"), repo, fakeFs({[repo]: {dev: 1n, ino: 0n}})));
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(path.resolve("/virtual"), "x"), repo, fakeFs({[path.resolve("/virtual")]: {dev: 1n, ino: 0n}})));
  // An ancestor that exists but cannot be inspected is not treated as missing.
  const locked = path.resolve("/virtual/locked");
  const permissionDenied = fakeFs();
  const plainLstat = permissionDenied.lstatSync;
  permissionDenied.lstatSync = (value) => {
    if(value === locked) throw Object.assign(new Error("EACCES"), {code: "EACCES"});
    return plainLstat(value);
  };
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(locked, "x"), repo, permissionDenied));
  // Canonical-path check on its own: a link that resolves into the repository
  // on a file system whose inode numbers are not stable across calls.
  const link = path.resolve("/virtual/link");
  let counter = 100n;
  const unstable = {
    realpathSync: Object.assign((value) => {
      if(value === link) return path.join(repo, "sub");
      if(value === repo || value === path.resolve("/virtual") || value === path.resolve("/")) return value;
      throw enoent();
    }, {native: undefined}),
    lstatSync: (value) => { if([link, repo, path.resolve("/virtual"), path.resolve("/")].includes(value)) return {}; throw enoent(); },
    statSync: () => ({dev: 1n, ino: counter++})
  };
  expectGuard("OUTPUT_INSIDE_REPOSITORY", () => assertOutsideRepository(path.join(link, "out"), repo, unstable));
});

test("6b: mock file system: a dangling link (lstat ok, realpath fails) fails closed; a real outside path passes", () => {
  const root = path.resolve("/");
  const base = path.resolve("/virtual");
  const repo = path.join(base, "repo");
  const dangling = path.join(base, "dangling");
  const enoent = () => Object.assign(new Error("ENOENT"), {code: "ENOENT"});
  const existing = new Set([root, base, repo, dangling]);
  const mock = {
    realpathSync: Object.assign((value) => { if(value === dangling || !existing.has(value)) throw enoent(); return value; }, {native: undefined}),
    lstatSync: (value) => { if(!existing.has(value)) throw enoent(); return {}; },
    statSync: (value) => { if(!existing.has(value) || value === dangling) throw enoent(); return {dev: 1n, ino: BigInt([...existing].indexOf(value) + 10)}; }
  };
  expectGuard("OUTPUT_CONTAINMENT_UNVERIFIABLE", () => assertOutsideRepository(path.join(dangling, "x"), repo, mock));
  assert.equal(assertOutsideRepository(path.join(base, "other", "x"), repo, mock), path.join(base, "other", "x"));
});

test("7: real output outside the repository still works and existing versions are never overwritten", (t) => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sos-guard-ok-"));
  t.after(() => fs.rmSync(outRoot, {recursive: true, force: true}));
  // A sibling directory whose name starts with ".." OUTSIDE the repository is fine.
  const dotted = path.join(outRoot, "..dotted-but-outside");
  const first = runCli(dotted, os.tmpdir());
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  assert.ok(fs.existsSync(path.join(dotted, summary.datasetVersionId, "manifest.json")));
  const second = runCli(dotted, os.tmpdir());
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stderr).code, "OUTPUT_EXISTS");
  assert.deepEqual(fs.readdirSync(dotted), [summary.datasetVersionId], "no staging directory left behind");
});
