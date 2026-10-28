# Static facility dataset generator (pilot step S1)

Builds a versioned, deterministic **candidate** dataset of hospitals and
pharmacies from OpenStreetMap data, for the planned static facility search
(Netlify CDN first, the existing `nearby-facilities` Function as fallback).

S1 scope: generator and tests only, run on a small synthetic fixture
(`tests/fixtures/facility-dataset/kr-synthetic.osm.json`). Nothing here is
wired into the app, and no real dataset is generated or published.

## Usage

```sh
node scripts/facility-dataset/build-dataset.mjs \
  --input <osm.json> --region KR --out <directory OUTSIDE this repository> \
  [--data-as-of 2026-10-20T00:00:00Z] [--source-label "text"]
```

- Input: OSM JSON (`{"elements": [...]}` with nodes, ways, relations), max 64 MiB.
  Reading a country PBF is a later step (S2); its tooling is not decided yet.
- `--out` inside the repository is refused: `netlify.toml` publishes the whole
  repository root (`publish = "."`), so anything written there would be
  deployed once committed. The guard (`lib/output-guard.mjs`) compares
  resolved path components (a child directory named `..audit-output` is
  inside), resolves symlinks/junctions of the nearest existing ancestor,
  compares directory identity (device + inode) to catch case-insensitive or
  aliased paths, and refuses when containment cannot be established (dangling
  link, unreadable ancestor, no inode numbers). Rejected paths cause no writes.
- Versions are immutable: an existing `<out>/<datasetVersionId>/` is never
  overwritten.
- The dataset timestamp (`dataAsOf`) comes from `osm3s.timestamp_osm_base` or
  `--data-as-of`, never from the clock. If both are present they must match.

## Output

```
<datasetVersionId>/               e.g. kr-osm-20261020T000000Z-<12 hex>
  manifest.json                   status "candidate", checksums, coverage, license
  validation-report.json          counts, rejections by reason, tile stats, gates
  ATTRIBUTION.txt                 OSM / ODbL notice
  hospital/<latIndex>_<lonIndex>.json
  pharmacy/<latIndex>_<lonIndex>.json
```

- All JSON is canonical (sorted keys, no whitespace, trailing newline), so the
  same input always gives the same bytes and SHA-256.
- Tile elements use the Overpass response shape (`node`: `lat`/`lon`;
  `way`/`relation`: `center`) so the client can pass them to the existing
  `mapOverpass` -> `finalizeFacilityResults` pipeline unchanged.
- Element order depends on the facility type (`lib/evidence.mjs`,
  `recordComparatorFor`), inside each tile and when tiles are merged
  (`mergeTileElements(tiles, facilityType)`; mixing types is refused):
  - hospital: evidence first (hospital with affirmative OSM emergency-related
    tags, then other hospital, then everything else), then OSM type and id.
    The existing client keeps the FIRST record wherever records collapse by
    name+point (mapOverpass) or at equal distance (finalizeFacilityResults),
    so this order makes the stronger hospital/emergency record survive.
  - pharmacy: OSM type, then id (Overpass order), exactly as the live
    Function returns pharmacy results and as S1 v1 stored them. Emergency
    evidence must not reorder pharmacies: an object tagged both as a pharmacy
    and as an emergency hospital would otherwise replace a plain pharmacy
    record of the same place (different id, phone, hours, emergency fields).
  No tag is added or changed; the rank is never stored.
- Objects are selected with the same tag selectors as the Function. Only the
  tag keys the client reads are kept (`PRESERVED_TAG_KEYS`). Contract tests
  fail if the Function selectors or the client tag reads drift.
- Tiles are half-open 0.25 degree cells. A tile id not listed in the manifest
  means zero objects of that type there.
- Dataset selection uses the **search coordinates only**
  (`selectDatasetForSearch`): the point must be inside `coverage.serviceArea`
  and the search box inside `coverage.dataBounds`. The traveler's selected
  country is not an input. Anything else falls back to the live Function.
- The KR service area is a **provisional, unverified, deliberately
  conservative** outline (mainland and Jeju only).

## Static vs live Function: when results match

Static candidates are every selected object within the search radius. They
equal the live Function's candidates at its `searchRadiusMeters` only when the
live Function ran every selector for that radius: always for pharmacy; for
hospital only when the extended query (`healthcare~centre|center|yes`) ran at
the final radius. The live Function skips it when the core query alone
reaches 20 raw candidates, and it never searches hospitals beyond 10 km. In
those cases the static path intentionally returns more (it is not truncated
to mimic the live limits). Evidence: `tests/unit/facility-dataset-live-parity.test.mjs`
(real Function with a stub provider plus the real client pipeline).

## Known limitations (S1)

- Distance-dependent collapse: when a weaker record (for example a clinic
  node) and a stronger one (a hospital way with emergency tags) share a client
  dedupe key but are at different points, the existing client keeps whichever
  is CLOSER to the search point. Ordering cannot change that; it needs a
  client change (S3). The validation report counts these pairs
  (`clientCollapse.mixedEvidencePairsDistanceDependent`) so S2 can measure
  them on real data.
- The live Function returns Overpass order, so on the live path a clinic node
  can still displace an emergency hospital way of the same place (unchanged,
  out of S1 scope).
- Static radius filtering uses the node position or way/relation center;
  Overpass `around` also matches outlines that reach the radius.
- All evidence is from synthetic fixtures, not real OpenStreetMap data.
- Windows: a real directory symlink needs the Create-symbolic-links privilege
  or Developer Mode. The guard test then falls back to a junction, and is
  skipped (with the reason printed) only if Windows refuses both for
  permission reasons. The same logic is covered by mock file-system tests
  that need no privilege. Not yet run on a real Windows or macOS machine.

## Emergency semantics

OSM `emergency`-related tags are copied verbatim. They are community map
annotations and do **not** verify that an emergency department exists, is
open, is staffed or can accept patients. The manifest states this, and the
dataset contains no derived "verified" or "confirmed" fields.

## OpenStreetMap / ODbL requirements

Checked on 2026-10-23 against https://www.openstreetmap.org/copyright and
https://osmfoundation.org/wiki/Licence/Attribution_Guidelines (last edited
2026-09-10).

- The generated dataset is a Derivative Database of OpenStreetMap data,
  licensed under the ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/).
  If it (or a further derivative) is distributed, it must be offered under the
  same license (share-alike).
- Credit OpenStreetMap and make clear the data is under the ODbL. For data, put
  the notice where users look (readme) or in the data/metadata: this generator
  writes it to `manifest.json` (`license`), every tile (`license`) and
  `ATTRIBUTION.txt`.
- Attribution text used: "© OpenStreetMap contributors", linking to
  https://www.openstreetmap.org/copyright.
- Before S3 shows static results in the app, the facility results UI must also
  credit OpenStreetMap with that link (not implemented in S1).
- Combining OSM with another dataset (for example public emergency-facility
  designations) needs its own license review first.
