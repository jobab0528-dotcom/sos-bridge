"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const MIGRATION_PATH = path.join(
  REPOSITORY_ROOT,
  "db",
  "migrations",
  "001_facility_index_foundation.sql"
);
const CONTAINER_NAME = "sos-bridge-b1-postgis";
const DATABASE_NAME = "sos_bridge_b1";
const DATABASE_USER = "sos_bridge_b1";
const EXPECTED_IMAGE_DIGEST = "postgis/postgis@sha256:93edcf470afb105e34d83bab74296537f63e773eda55026bd1bebbb5326c8a96";

function dockerPath() {
  const candidates = [
    process.env.SOS_BRIDGE_B1_DOCKER_PATH,
    process.env.LOCALAPPDATA && path.join(
      process.env.LOCALAPPDATA,
      "Programs",
      "DockerDesktop",
      "resources",
      "bin",
      "docker.exe"
    ),
    "docker"
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "docker" || fs.existsSync(candidate));
}

function requirePassword() {
  const password = process.env.SOS_BRIDGE_B1_DB_PASSWORD;
  if (!password) throw new Error("B1_DB_PASSWORD_REQUIRED");
  return password;
}

function runDocker(args, options = {}) {
  const executable = dockerPath();
  if (!executable) throw new Error("DOCKER_CLI_NOT_FOUND");

  const result = spawnSync(executable, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    input: options.input,
    env: options.env || process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`DOCKER_COMMAND_FAILED:${result.status}:${detail}`);
  }
  return String(result.stdout || "");
}

function assertEnvironment() {
  const container = JSON.parse(runDocker(["inspect", "--type", "container", CONTAINER_NAME]))[0];
  if (!container || container.State.Status !== "running") {
    throw new Error("B1_CONTAINER_NOT_RUNNING");
  }

  const image = JSON.parse(runDocker(["image", "inspect", container.Image]))[0];
  if (!image || !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(EXPECTED_IMAGE_DIGEST)) {
    throw new Error("B1_IMAGE_DIGEST_MISMATCH");
  }

  const bindings = container.NetworkSettings.Ports["5432/tcp"];
  if (!Array.isArray(bindings) || bindings.length !== 1 ||
      bindings[0].HostIp !== "127.0.0.1" || bindings[0].HostPort !== "55432") {
    throw new Error("B1_CONTAINER_BINDING_MISMATCH");
  }
}

function runPsql(sql, variables = {}) {
  const password = requirePassword();
  const args = [
    "exec",
    "-i",
    "-e",
    "PGPASSWORD",
    CONTAINER_NAME,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    DATABASE_USER,
    "-d",
    DATABASE_NAME,
    "-At"
  ];

  for (const [name, value] of Object.entries(variables)) {
    args.push(`--set=${name}=${String(value)}`);
  }

  return runDocker(args, {
    input: sql,
    env: Object.assign({}, process.env, {PGPASSWORD: password})
  }).trim();
}

function applyMigration() {
  assertEnvironment();
  runPsql(fs.readFileSync(MIGRATION_PATH, "utf8"));
}

function parameterizedForPsql(sqlText) {
  return sqlText.replace(/\$(\d+)/g, (_match, number) => `:'p${number}'`);
}

function queryRows(sqlText, params = []) {
  const variables = {};
  params.forEach((value, index) => {
    variables[`p${index + 1}`] = value;
  });

  const query = parameterizedForPsql(sqlText);
  const wrapped = `
SELECT COALESCE(json_agg(row_to_json(query_result)), '[]'::json)
FROM (
${query}
) AS query_result;
`;
  const output = runPsql(wrapped, variables);
  return output ? JSON.parse(output) : [];
}

function createExecutor() {
  return Object.freeze({
    async query(sqlText, params) {
      return {rows: queryRows(sqlText, params)};
    }
  });
}

module.exports = Object.freeze({
  EXPECTED_IMAGE_DIGEST,
  MIGRATION_PATH,
  applyMigration,
  assertEnvironment,
  createExecutor,
  queryRows,
  runPsql
});
