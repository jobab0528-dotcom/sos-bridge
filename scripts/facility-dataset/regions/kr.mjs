// KR (South Korea) pilot region definition for the static facility dataset.
//
// STATUS: PROVISIONAL. The service-area rings below are a hand-drawn,
// deliberately conservative inner approximation (mainland and Jeju only) for
// generator tests. They are NOT verified against an authoritative boundary and
// must be reviewed before any dataset is published. Under-coverage is the safe
// direction: a search point outside the rings simply keeps using the existing
// live Function. Over-coverage (for example including North Korea or Japanese
// islands such as Tsushima) would wrongly route searches to this dataset, so
// tests pin known outside points.
//
// Rings are [latitude, longitude] pairs.

export const KR_REGION = Object.freeze({
  regionCode: "KR",
  serviceAreaStatus: "provisional-unverified-conservative",
  serviceArea: Object.freeze({
    ringsLatLon: Object.freeze([
      // Mainland, kept south of the DMZ and away from the Korea Strait islands.
      Object.freeze([
        [37.72, 126.10], [37.72, 126.60], [37.86, 126.78], [38.12, 127.05],
        [38.18, 127.40], [38.18, 128.00], [38.45, 128.40], [38.45, 128.75],
        [37.00, 129.60], [36.10, 129.65], [35.30, 129.40], [35.00, 129.15],
        [34.70, 128.70], [34.55, 127.80], [34.25, 126.90], [34.25, 126.20],
        [34.70, 125.95], [35.60, 126.30], [36.60, 126.00], [37.30, 126.10]
      ].map((vertex) => Object.freeze(vertex))),
      // Jeju island.
      Object.freeze([
        [33.60, 126.10], [33.60, 127.00], [33.15, 127.00], [33.15, 126.10]
      ].map((vertex) => Object.freeze(vertex)))
    ])
  }),
  // Facilities inside these bounds are kept. Every service-area vertex must be
  // at least maxSearchRadiusMeters inside these bounds (checked by tests), so a
  // served search never reaches past the data edge of the grid. Whether the
  // real source extract covers this whole box is NOT VERIFIED (S2 check).
  dataBounds: Object.freeze({south: 32.5, west: 124.0, north: 39.0, east: 131.0}),
  maxSearchRadiusMeters: 50000,
  // 0.25 degree cells. PROVISIONAL until measured on the real KR extract.
  grid: Object.freeze({tileSizeE7: 2500000}),
  // Hard limit per tile file. PROVISIONAL until measured.
  tileMaxBytes: 524288
});

export const REGIONS = Object.freeze({KR: KR_REGION});
