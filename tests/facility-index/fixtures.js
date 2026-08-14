"use strict";

const REFERENCE = Object.freeze({
  countryCode: "AA",
  latitude: 0,
  longitude: 0
});

const FIXTURE_IDS = Object.freeze({
  hospitalNear: "HOSPITAL_NEAR",
  hospitalFar: "HOSPITAL_FAR",
  emergencyHospital: "EMERGENCY_HOSPITAL",
  clinic: "CLINIC",
  pharmacyNear: "PHARMACY_NEAR",
  pharmacyFar: "PHARMACY_FAR",
  exactBoundary: "EXACT_RADIUS_BOUNDARY",
  outsideRadius: "OUTSIDE_RADIUS",
  rejectedCarRepair: "REJECTED_CAR_REPAIR",
  reviewRecord: "REVIEW_RECORD",
  inactiveRecord: "INACTIVE_RECORD",
  otherCountryHospital: "OTHER_COUNTRY_HOSPITAL",
  otherDatasetHospital: "OTHER_DATASET_HOSPITAL",
  tieDistanceA: "TIE_DISTANCE_A",
  tieDistanceB: "TIE_DISTANCE_B"
});

function pointAt(distanceMeters, bearingRadians) {
  return `ST_Project(
    ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
    ${distanceMeters},
    ${bearingRadians}
  )`;
}

function facilityRow({
  id,
  dataset = "TEST_DATASET_AA_V2",
  country = "AA",
  type = "hospital",
  facilityClass = "hospital",
  distance = 1000,
  bearing = 0,
  emergency = false,
  status = "accepted",
  active = true,
  name = id
}) {
  return `(
    '${id}', '${dataset}', '${country}', '${type}', '${facilityClass}',
    '${name}', NULL, NULL, ${pointAt(distance, bearing)}, ${emergency},
    ARRAY[]::TEXT[], NULL, NULL, 'synthetic', '${id}', NULL,
    '${status}', ${active}, '[]'::JSONB, NULL
  )`;
}

const FIXTURE_SQL = `
TRUNCATE TABLE
  facility_index.facilities,
  facility_index.facility_country_registry,
  facility_index.facility_dataset_versions;

INSERT INTO facility_index.facility_dataset_versions (
  dataset_version_id, country_code, source, source_version,
  data_as_of, published_at, status
) VALUES
  ('TEST_DATASET_AA_V1', 'AA', 'synthetic-test-only', 'aa-v1', '2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z', 'superseded'),
  ('TEST_DATASET_AA_V2', 'AA', 'synthetic-test-only', 'aa-v2', '2030-02-01T00:00:00Z', '2030-02-02T00:00:00Z', 'published'),
  ('TEST_DATASET_BB_V1', 'BB', 'synthetic-test-only', 'bb-v1', '2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z', 'published');

INSERT INTO facility_index.facility_country_registry (
  country_code, active_dataset_version_id, previous_dataset_version_id,
  facility_index_v2_enabled
) VALUES
  ('AA', 'TEST_DATASET_AA_V2', 'TEST_DATASET_AA_V1', TRUE),
  ('BB', 'TEST_DATASET_BB_V1', NULL, TRUE);

INSERT INTO facility_index.facilities (
  facility_id, dataset_version_id, country_code, facility_type,
  facility_class, name, name_local, name_english, location, emergency,
  specialties, address, phone, source_type, source_id,
  canonical_group_id, classification_status, is_active, quality_flags,
  source_updated_at
) VALUES
  ${facilityRow({id: FIXTURE_IDS.hospitalNear, distance: 1000, bearing: 0.1})},
  ${facilityRow({id: FIXTURE_IDS.hospitalFar, distance: 4000, bearing: 0.2})},
  ${facilityRow({id: FIXTURE_IDS.emergencyHospital, facilityClass: "emergency_hospital", distance: 3000, bearing: 0.3, emergency: true})},
  ${facilityRow({id: FIXTURE_IDS.clinic, facilityClass: "clinic", distance: 2000, bearing: 0.4})},
  ${facilityRow({id: FIXTURE_IDS.pharmacyNear, type: "pharmacy", facilityClass: "pharmacy", distance: 500, bearing: 0.5})},
  ${facilityRow({id: FIXTURE_IDS.pharmacyFar, type: "pharmacy", facilityClass: "pharmacy", distance: 2500, bearing: 0.6})},
  ${facilityRow({id: FIXTURE_IDS.exactBoundary, distance: 5000, bearing: 0.7})},
  ${facilityRow({id: FIXTURE_IDS.outsideRadius, distance: 5001, bearing: 0.8})},
  ${facilityRow({id: FIXTURE_IDS.rejectedCarRepair, distance: 600, bearing: 0.9, status: "rejected"})},
  ${facilityRow({id: FIXTURE_IDS.reviewRecord, distance: 700, bearing: 1.0, status: "review"})},
  ${facilityRow({id: FIXTURE_IDS.inactiveRecord, distance: 800, bearing: 1.1, active: false})},
  ${facilityRow({id: FIXTURE_IDS.otherCountryHospital, dataset: "TEST_DATASET_BB_V1", country: "BB", distance: 300, bearing: 1.2})},
  ${facilityRow({id: FIXTURE_IDS.otherDatasetHospital, dataset: "TEST_DATASET_AA_V1", distance: 200, bearing: 1.3})},
  ${facilityRow({id: FIXTURE_IDS.tieDistanceA, distance: 1500, bearing: 1.4})},
  ${facilityRow({id: FIXTURE_IDS.tieDistanceB, distance: 1500, bearing: 1.4})};
`;

const BULK_FIXTURE_SQL = `
INSERT INTO facility_index.facilities (
  facility_id, dataset_version_id, country_code, facility_type,
  facility_class, name, location, emergency, specialties, source_type,
  source_id, classification_status, is_active, quality_flags
)
SELECT
  'BULK_' || lpad(value::TEXT, 3, '0'),
  'TEST_DATASET_AA_V2',
  'AA',
  'hospital',
  'hospital',
  'Synthetic Bulk ' || value,
  ST_Project(
    ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
    50 + value,
    2.0
  ),
  FALSE,
  ARRAY[]::TEXT[],
  'synthetic-bulk',
  value::TEXT,
  'accepted',
  TRUE,
  '[]'::JSONB
FROM generate_series(1, 55) AS value;
`;

const DELETE_BULK_FIXTURE_SQL = `
DELETE FROM facility_index.facilities
WHERE dataset_version_id = 'TEST_DATASET_AA_V2'
  AND source_type = 'synthetic-bulk';
`;

module.exports = Object.freeze({
  BULK_FIXTURE_SQL,
  DELETE_BULK_FIXTURE_SQL,
  FIXTURE_IDS,
  FIXTURE_SQL,
  REFERENCE
});
