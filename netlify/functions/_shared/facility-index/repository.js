"use strict";

const {
  FacilityRepositoryError,
  validateCriteria,
  validateExecutor
} = require("./contract");
const {
  ACTIVE_DATASET_SQL,
  NEARBY_FACILITIES_SQL
} = require("./sql");

function requireRows(result) {
  if (!result || !Array.isArray(result.rows)) {
    throw new FacilityRepositoryError(
      "FACILITY_QUERY_FAILED",
      "The facility executor returned an invalid result."
    );
  }
  return result.rows;
}

function mapFacility(row) {
  const distanceMeters = Number(row.distanceMeters);
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new FacilityRepositoryError(
      "FACILITY_QUERY_FAILED",
      "The facility query returned an invalid distance."
    );
  }

  return Object.freeze({
    facilityId: String(row.facilityId),
    type: row.type,
    facilityClass: row.facilityClass,
    name: row.name === null || row.name === undefined ? null : String(row.name),
    nameLocal: row.nameLocal === null || row.nameLocal === undefined ? null : String(row.nameLocal),
    nameEnglish: row.nameEnglish === null || row.nameEnglish === undefined ? null : String(row.nameEnglish),
    distanceMeters,
    emergency: row.emergency === true,
    specialties: Object.freeze(Array.isArray(row.specialties) ? row.specialties.map(String) : []),
    address: row.address === null || row.address === undefined ? null : String(row.address),
    phone: row.phone === null || row.phone === undefined ? null : String(row.phone)
  });
}

async function findNearbyFacilities(criteria, executor) {
  const normalized = validateCriteria(criteria);
  const database = validateExecutor(executor);

  const datasetRows = requireRows(await database.query(
    ACTIVE_DATASET_SQL,
    [normalized.countryCode]
  ));

  if (datasetRows.length !== 1 || !datasetRows[0].datasetVersionId) {
    throw new FacilityRepositoryError(
      "FACILITY_COUNTRY_NOT_READY",
      "No enabled published Facility Index dataset is available for the country."
    );
  }

  const dataset = datasetRows[0];
  const facilityRows = requireRows(await database.query(
    NEARBY_FACILITIES_SQL,
    [
      dataset.datasetVersionId,
      normalized.countryCode,
      normalized.type,
      normalized.longitude,
      normalized.latitude,
      normalized.radiusMeters,
      normalized.priorityMode,
      normalized.limit
    ]
  ));

  return Object.freeze({
    datasetVersionId: String(dataset.datasetVersionId),
    dataAsOf: dataset.dataAsOf === null || dataset.dataAsOf === undefined
      ? null
      : String(dataset.dataAsOf),
    facilities: Object.freeze(facilityRows.map(mapFacility))
  });
}

module.exports = Object.freeze({
  findNearbyFacilities
});
