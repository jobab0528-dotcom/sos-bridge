BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS facility_index;

CREATE TABLE IF NOT EXISTS facility_index.facility_dataset_versions (
  dataset_version_id TEXT PRIMARY KEY,
  country_code CHAR(2) NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  data_as_of TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL,
  CONSTRAINT facility_dataset_versions_country_code_check
    CHECK (country_code::TEXT ~ '^[A-Z]{2}$'),
  CONSTRAINT facility_dataset_versions_source_check
    CHECK (length(btrim(source)) > 0),
  CONSTRAINT facility_dataset_versions_source_version_check
    CHECK (length(btrim(source_version)) > 0),
  CONSTRAINT facility_dataset_versions_status_check
    CHECK (status IN ('candidate', 'published', 'superseded')),
  CONSTRAINT facility_dataset_versions_source_identity_key
    UNIQUE (country_code, source, source_version),
  CONSTRAINT facility_dataset_versions_id_country_key
    UNIQUE (dataset_version_id, country_code)
);

CREATE TABLE IF NOT EXISTS facility_index.facility_country_registry (
  country_code CHAR(2) PRIMARY KEY,
  active_dataset_version_id TEXT NULL,
  previous_dataset_version_id TEXT NULL,
  facility_index_v2_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT facility_country_registry_country_code_check
    CHECK (country_code::TEXT ~ '^[A-Z]{2}$'),
  CONSTRAINT facility_country_registry_distinct_versions_check
    CHECK (
      active_dataset_version_id IS NULL
      OR previous_dataset_version_id IS NULL
      OR active_dataset_version_id <> previous_dataset_version_id
    ),
  CONSTRAINT facility_country_registry_active_dataset_fk
    FOREIGN KEY (active_dataset_version_id, country_code)
    REFERENCES facility_index.facility_dataset_versions (dataset_version_id, country_code),
  CONSTRAINT facility_country_registry_previous_dataset_fk
    FOREIGN KEY (previous_dataset_version_id, country_code)
    REFERENCES facility_index.facility_dataset_versions (dataset_version_id, country_code)
);

CREATE TABLE IF NOT EXISTS facility_index.facilities (
  facility_id TEXT PRIMARY KEY,
  dataset_version_id TEXT NOT NULL,
  country_code CHAR(2) NOT NULL,
  facility_type TEXT NOT NULL,
  facility_class TEXT NOT NULL,
  name TEXT NULL,
  name_local TEXT NULL,
  name_english TEXT NULL,
  location geography(Point, 4326) NOT NULL,
  emergency BOOLEAN NOT NULL DEFAULT FALSE,
  specialties TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  address TEXT NULL,
  phone TEXT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  canonical_group_id TEXT NULL,
  classification_status TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  quality_flags JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_updated_at TIMESTAMPTZ NULL,
  CONSTRAINT facilities_country_code_check
    CHECK (country_code::TEXT ~ '^[A-Z]{2}$'),
  CONSTRAINT facilities_type_check
    CHECK (facility_type IN ('hospital', 'pharmacy')),
  CONSTRAINT facilities_class_check
    CHECK (facility_class IN ('emergency_hospital', 'hospital', 'clinic', 'pharmacy')),
  CONSTRAINT facilities_class_type_consistency_check
    CHECK (
      (facility_type = 'pharmacy' AND facility_class = 'pharmacy')
      OR
      (facility_type = 'hospital' AND facility_class IN ('emergency_hospital', 'hospital', 'clinic'))
    ),
  CONSTRAINT facilities_emergency_type_check
    CHECK (NOT emergency OR facility_type = 'hospital'),
  CONSTRAINT facilities_emergency_class_check
    CHECK (facility_class <> 'emergency_hospital' OR emergency),
  CONSTRAINT facilities_classification_status_check
    CHECK (classification_status IN ('accepted', 'rejected', 'review')),
  CONSTRAINT facilities_source_identity_check
    CHECK (length(btrim(source_type)) > 0 AND length(btrim(source_id)) > 0),
  CONSTRAINT facilities_quality_flags_array_check
    CHECK (jsonb_typeof(quality_flags) = 'array'),
  CONSTRAINT facilities_dataset_country_fk
    FOREIGN KEY (dataset_version_id, country_code)
    REFERENCES facility_index.facility_dataset_versions (dataset_version_id, country_code),
  CONSTRAINT facilities_source_identity_key
    UNIQUE (dataset_version_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS facilities_location_gist_idx
  ON facility_index.facilities
  USING GIST (location);

CREATE INDEX IF NOT EXISTS facilities_active_lookup_idx
  ON facility_index.facilities (dataset_version_id, country_code, facility_type)
  WHERE classification_status = 'accepted' AND is_active = TRUE;

COMMIT;
