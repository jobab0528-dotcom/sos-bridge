"use strict";

const assert = require("node:assert/strict");
const {before, test} = require("node:test");
const {
  assertEnvironment,
  queryRows,
  runPsql
} = require("./test-db");

before(() => {
  assertEnvironment();
});

test("facility_index schema exists", () => {
  const rows = queryRows("SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name = 'facility_index'");
  assert.deepEqual(rows.map((row) => row.name), ["facility_index"]);
});

test("all three foundation tables exist", () => {
  const rows = queryRows(`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'facility_index'
    ORDER BY table_name
  `);
  assert.deepEqual(rows.map((row) => row.name), [
    "facilities",
    "facility_country_registry",
    "facility_dataset_versions"
  ]);
});

test("PostGIS extension exists", () => {
  const rows = queryRows("SELECT extversion AS version FROM pg_extension WHERE extname = 'postgis'");
  assert.equal(rows.length, 1);
  assert.match(rows[0].version, /^3\.6\./);
});

test("location is geography Point with SRID 4326", () => {
  const rows = queryRows(`
    SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'facility_index'
      AND relation.relname = 'facilities'
      AND attribute.attname = 'location'
  `);
  assert.deepEqual(rows, [{type: "geography(Point,4326)"}]);
});

test("location has a GiST spatial index", () => {
  const rows = queryRows(`
    SELECT access_method.amname AS method
    FROM pg_index AS index_definition
    JOIN pg_class AS index_relation ON index_relation.oid = index_definition.indexrelid
    JOIN pg_class AS table_relation ON table_relation.oid = index_definition.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = 'facility_index'
      AND table_relation.relname = 'facilities'
      AND index_relation.relname = 'facilities_location_gist_idx'
  `);
  assert.deepEqual(rows, [{method: "gist"}]);
});

test("foundation check constraints exist", () => {
  const rows = queryRows(`
    SELECT constraint_name AS name
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'facility_index'
      AND constraint_type = 'CHECK'
    ORDER BY constraint_name
  `);
  const names = new Set(rows.map((row) => row.name));
  for (const expected of [
    "facility_dataset_versions_country_code_check",
    "facility_dataset_versions_status_check",
    "facilities_type_check",
    "facilities_class_type_consistency_check",
    "facilities_emergency_type_check",
    "facilities_classification_status_check"
  ]) {
    assert.equal(names.has(expected), true, expected);
  }
});

test("invalid country code is rejected", () => {
  assert.throws(() => runPsql(`
    INSERT INTO facility_index.facility_dataset_versions
      (dataset_version_id, country_code, source, source_version, status)
    VALUES ('SCHEMA_BAD_COUNTRY', 'a1', 'synthetic-test-only', 'bad-country', 'candidate');
  `), /DOCKER_COMMAND_FAILED/);
});

test("invalid facility type is rejected", () => {
  assert.throws(() => runPsql(`
    BEGIN;
    INSERT INTO facility_index.facility_dataset_versions
      (dataset_version_id, country_code, source, source_version, status)
    VALUES ('SCHEMA_TYPE_DATASET', 'ZZ', 'synthetic-test-only', 'type-test', 'candidate');
    INSERT INTO facility_index.facilities
      (facility_id, dataset_version_id, country_code, facility_type, facility_class,
       location, source_type, source_id, classification_status)
    VALUES
      ('SCHEMA_BAD_TYPE', 'SCHEMA_TYPE_DATASET', 'ZZ', 'restaurant', 'hospital',
       ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
       'synthetic', 'bad-type', 'accepted');
    ROLLBACK;
  `), /DOCKER_COMMAND_FAILED/);
});

test("pharmacy emergency row is rejected", () => {
  assert.throws(() => runPsql(`
    BEGIN;
    INSERT INTO facility_index.facility_dataset_versions
      (dataset_version_id, country_code, source, source_version, status)
    VALUES ('SCHEMA_EMERGENCY_DATASET', 'ZZ', 'synthetic-test-only', 'emergency-test', 'candidate');
    INSERT INTO facility_index.facilities
      (facility_id, dataset_version_id, country_code, facility_type, facility_class,
       location, emergency, source_type, source_id, classification_status)
    VALUES
      ('SCHEMA_BAD_EMERGENCY', 'SCHEMA_EMERGENCY_DATASET', 'ZZ', 'pharmacy', 'pharmacy',
       ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, TRUE,
       'synthetic', 'bad-emergency', 'accepted');
    ROLLBACK;
  `), /DOCKER_COMMAND_FAILED/);
});

test("facilities enforce dataset and country foreign key", () => {
  const rows = queryRows(`
    SELECT pg_get_constraintdef(constraint_definition.oid) AS definition
    FROM pg_constraint AS constraint_definition
    JOIN pg_class AS relation ON relation.oid = constraint_definition.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'facility_index'
      AND relation.relname = 'facilities'
      AND constraint_definition.conname = 'facilities_dataset_country_fk'
  `);
  assert.equal(rows.length, 1);
  assert.match(rows[0].definition, /dataset_version_id, country_code/);
});

test("registry active and previous pointers enforce country-scoped foreign keys", () => {
  const rows = queryRows(`
    SELECT constraint_definition.conname AS name,
           pg_get_constraintdef(constraint_definition.oid) AS definition
    FROM pg_constraint AS constraint_definition
    JOIN pg_class AS relation ON relation.oid = constraint_definition.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'facility_index'
      AND relation.relname = 'facility_country_registry'
      AND constraint_definition.contype = 'f'
    ORDER BY constraint_definition.conname
  `);
  assert.deepEqual(rows.map((row) => row.name), [
    "facility_country_registry_active_dataset_fk",
    "facility_country_registry_previous_dataset_fk"
  ]);
  for (const row of rows) assert.match(row.definition, /country_code/);
});
