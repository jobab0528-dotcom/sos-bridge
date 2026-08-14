"use strict";

const ACTIVE_DATASET_SQL = `
SELECT
  registry.active_dataset_version_id AS "datasetVersionId",
  dataset.data_as_of AS "dataAsOf"
FROM facility_index.facility_country_registry AS registry
JOIN facility_index.facility_dataset_versions AS dataset
  ON dataset.dataset_version_id = registry.active_dataset_version_id
 AND dataset.country_code = registry.country_code
WHERE registry.country_code = $1
  AND registry.facility_index_v2_enabled = TRUE
  AND dataset.status = 'published'
LIMIT 1`;

const NEARBY_FACILITIES_SQL = `
WITH reference_point AS (
  SELECT ST_SetSRID(
    ST_MakePoint($4::double precision, $5::double precision),
    4326
  )::geography AS location
), eligible AS (
  SELECT
    facility.facility_id,
    facility.facility_type,
    facility.facility_class,
    facility.name,
    facility.name_local,
    facility.name_english,
    facility.emergency,
    facility.specialties,
    facility.address,
    facility.phone,
    ST_Distance(facility.location, reference_point.location) AS distance_meters
  FROM facility_index.facilities AS facility
  CROSS JOIN reference_point
  WHERE facility.dataset_version_id = $1
    AND facility.country_code = $2
    AND facility.facility_type = $3
    AND facility.classification_status = 'accepted'
    AND facility.is_active = TRUE
    AND ST_DWithin(
      facility.location,
      reference_point.location,
      $6::double precision
    )
)
SELECT
  facility_id AS "facilityId",
  facility_type AS "type",
  facility_class AS "facilityClass",
  name,
  name_local AS "nameLocal",
  name_english AS "nameEnglish",
  distance_meters AS "distanceMeters",
  emergency,
  specialties,
  address,
  phone
FROM eligible
ORDER BY
  CASE
    WHEN $7::text = 'emergency-first' THEN
      CASE
        WHEN facility_class = 'emergency_hospital' AND emergency = TRUE THEN 0
        WHEN facility_class = 'hospital' THEN 1
        ELSE 2
      END
    ELSE 0
  END ASC,
  distance_meters ASC,
  facility_id ASC
LIMIT $8::integer`;

module.exports = Object.freeze({
  ACTIVE_DATASET_SQL,
  NEARBY_FACILITIES_SQL
});
