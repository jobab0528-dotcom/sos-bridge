# Static facility dataset generator (pilot steps S1, S2-a)

Builds a versioned, deterministic **candidate** dataset of hospitals and
pharmacies from OpenStreetMap data, for the planned static facility search
(Netlify CDN first, the existing `nearby-facilities` Function as fallback).

Scope so far: generator and tests only, run on small synthetic fixtures
(`tests/fixtures/facility-dataset/kr-synthetic.osm.json` and the same objects
as osmium OPL, `kr-synthetic.osm.opl`). Nothing here is wired into the app,
and no real dataset is generated or published. **Real KR data must not be
built or published until the S2-b tile-split work (below) is done and the KR
gate thresholds are decided.**

## Usage

```sh
node --max-old-space-size=4096 scripts/facility-dataset/build-dataset.mjs \
  --input <file> --region KR --out <directory OUTSIDE this repository> \
  --quality-gates <gates.json> \
  [--input-format json|opl] [--data-as-of 2026-10-20T00:00:00Z] \
  [--source-label "text"] [--source-url https://...] [--source-sha256 <hex>] \
  [--max-input-mb N] [--max-elements N]
```

- Input: OSM JSON (`{"elements": [...]}` with nodes, ways, relations), max
  64 MiB, read in one piece; or, with `--input-format opl`, osmium OPL text
  (see "OPL input"), streamed line by line.
- `--quality-gates` is required for a candidate to be written (see "Safety
  policy"). Without it the build runs, reports `NOT_CONFIGURED` and the CLI
  exits with `REQUIRED_GATE_NOT_CONFIGURED`, writing nothing.
- Failures print `{"ok": false, "code", "message", "details"?, "lineNumber"?}`
  to stderr and exit 1. Nothing is written on any failure.
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

## Safety policy (S2-a v2, independent review REQUEST CHANGES)

**Referenced geometry is fail-closed** (`lib/integrity.mjs`). A facility way
or relation is placed at the bounding-box center of everything it
references, which is only meaningful when every reference resolves. Any
facility (hospital or pharmacy selector scope) whose geometry does not fully
resolve stops the build with `REFERENTIAL_INTEGRITY_FAILED`:

| code | meaning |
|---|---|
| `MISSING_NODE` / `MISSING_WAY` / `MISSING_RELATION` | referenced object not in the input |
| `NODE_WITHOUT_VALID_LOCATION` | referenced node present but without valid coordinates |
| `MALFORMED_REFERENCED_OBJECT` | referenced object present but malformed (rejected in pass 1) |
| `RELATION_CYCLE` | a relation contains itself, directly or through others |
| `RELATION_DEPTH_EXCEEDED` | more than 8 nested relation levels |
| `EMPTY_RELATION` | relation without members or points |
| `GEOMETRY_TOO_LARGE` | more than 100,000 member points |
| `GEOMETRY_EXTENT_TOO_LARGE` | outline wider or taller than 0.05 degrees (no single facility is) |

Sub-relations are resolved recursively (S1 silently ignored them).
Repeated references to the same member are legal in OSM; they are visited
once and counted (`geometry.duplicateMemberReferences`). The error `details`
list every affected object (first 1,000), each with its problems (code,
`missingType`, `missingRef`, `via` path), counts per code and the number of
allowed exclusions.

Why fail-closed: the input is meant to be a complete reference closure
(`osmium tags-filter` adds referenced objects by default), so a missing
reference means the extract or the export step is broken, or the object
crosses the extract boundary. The generator cannot tell which from the data
alone, so it does not guess. **Intended exclusions are explicit**: an object
listed in the gates file `allowIncompleteGeometry` with a written reason is
excluded (never placed approximately), counted under
`rejected.byReason.incomplete_geometry` and listed with its reason in
`validation-report.json` `integrity.allowedExclusions`. An allowance that
matches no unresolved object stops the build (`STALE_GEOMETRY_ALLOWANCE`).

**Emergency evidence is never dropped silently.** A hospital-scope object
with affirmative OSM emergency evidence (same rule as hospital tile order,
`lib/evidence.mjs`) that would be rejected for invalid coordinates or
unresolved geometry stops the build (`EMERGENCY_EVIDENCE_REJECTED`);
allowances cannot exclude it. A hospital tagged `emergency=no` carries no
evidence and keeps the S1 behaviour (counted rejection).

**Emergency evidence outside the data bounds (S2-a v3, review risk A).** Such
an object used to be only counted under `outside_data_bounds`. Now the build
stops with `EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS` (details: object, latitude,
longitude) unless that exact object is listed in the gates file
`acknowledgeEmergencyOutsideDataBounds` with a written review reason. An
acknowledged object is excluded and listed with its coordinates and reason
in `validation-report.json` and `manifest.json`
(`emergencyEvidenceExclusions`); the publish gate
`emergency_evidence_exclusions_review` (PENDING_REVIEW) is added, so the
candidate is never presented as reviewed for publishing. Stale entries stop
the build (`STALE_EMERGENCY_ACKNOWLEDGEMENT`). The acknowledgement applies to
`outside_data_bounds` only, never to invalid coordinates or unresolved
geometry.

**Oversized or unresolved emergency geometry (review risk B): manual review,
no override.** One emergency-tagged hospital whose geometry does not resolve
or is wider than 0.05 degrees (`GEOMETRY_EXTENT_TOO_LARGE`) stops the whole
build (`EMERGENCY_EVIDENCE_REJECTED`), and nothing in the gates file can
release it. This is deliberate: the alternatives are dropping a hospital
with emergency evidence or placing it at a guessed point. Process when it
happens:

1. Read the error `details` (object id, problem code, `via` path, extent).
   Nothing has been written.
2. Inspect the object and its members in the source extract (`osmium getid`)
   and on openstreetmap.org. Do not edit coordinates or tags in the
   extracted data, do not add an allowance, do not raise the 0.05 degree
   threshold, and do not mark anything as verified emergency care.
3. If it is an OpenStreetMap mapping error, it can only be corrected in
   OpenStreetMap itself, by normal editing with verifiable sources (not to
   make a build pass); then wait for a new extract and rebuild from scratch.
   If the extract or export step lost members, fix that step and rebuild.
4. While the build is blocked, no new static dataset is produced; the app
   keeps using the existing live search, so users are not left without a
   search.
5. If the object is correct as mapped (a genuinely larger facility), the
   threshold or policy can change only through a separate, reviewed code
   change with evidence. **S2-c STOP criterion:** a real KR build blocked by
   `EMERGENCY_EVIDENCE_REJECTED` or `EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS`
   stops S2-c until this review is done and documented.

**Validation order and empty tag values (S2-a v4).** An empty tag value
(`name=`) is valid OSM data and is accepted; the client treats it as absent,
as for the live Function. Selector scope and emergency evidence are judged
from the string-valued tags first, then position, referential integrity and
data bounds are checked, and malformed tags (empty key, value over 255
characters, non-string value) are rejected LAST. A malformed tag therefore
never hides a facility from those checks (S2-a v3 rejected such objects
first, so an emergency hospital outside the bounds or a hospital way with a
missing node was dropped silently). A hospital with emergency evidence that
is rejected for malformed tags or a malformed object shape stops the build
(`EMERGENCY_EVIDENCE_REJECTED`, reason `malformed_tags` / `malformed_element`).
Residual: an object whose selector tag itself is not a string (JSON only;
OPL values are always strings) cannot be identified as a facility and is a
counted `malformed_tags` rejection.

**Object-level data errors stay counted rejections** (S1 behaviour):
invalid coordinates of a facility node, malformed tags, malformed elements,
objects outside `dataBounds`. They are governed by the `max_rejected_ratio`
gate.

**Gates** (`validation-report.json` `gates`, `acceptance`; summary in
`manifest.json` `acceptance`). Each gate has `stage`, `status`, `threshold`
and `observed`:

| gate | stage | status |
|---|---|---|
| `non_empty_hospital`, `non_empty_pharmacy` | build | PASSED (else `EMPTY_DATASET`) |
| `referential_integrity` | build | PASSED (else the build stops) |
| `emergency_evidence_preserved` | build | PASSED (else the build stops); observed counts acknowledged outside-bounds exclusions |
| `max_rejected_ratio` | build | PASSED / NOT_CONFIGURED (FAILED stops the build) |
| `tile_max_bytes`, `tile_membership`, `data_bounds` | build | PASSED (else the build stops) |
| `service_area_review`, `count_delta_vs_previous_version`, `known_facility_sample`, `nonmedical_contamination_sample` | publish | PENDING_REVIEW |
| `emergency_evidence_exclusions_review` (only when an emergency object was acknowledged and excluded) | publish | PENDING_REVIEW |

- `PASSED` only means a configured check was evaluated. A gate without a
  threshold is `NOT_CONFIGURED`, never `PASSED`.
- `acceptance.status` is `BUILD_GATES_PASSED` only when every build gate
  passed; otherwise `NOT_ACCEPTED` and `lib/write-output.mjs` refuses to
  write (`REQUIRED_GATE_NOT_CONFIGURED`). Publish gates need people or a
  previous version; `publishable` is always `false` here.
- `rejected ratio` = rejected objects / (rejected + accepted objects).

Gates file (`--quality-gates`, `lib/quality-gates.mjs`; unknown keys refused):

```json
{
  "schemaVersion": "1",
  "regionCode": "KR",
  "description": "who set these values, when and why",
  "maxRejectedRatio": 0.01,
  "allowIncompleteGeometry": [{"object": "way/123", "reason": "why this exact object may be excluded"}],
  "acknowledgeEmergencyOutsideDataBounds": [{"object": "node/456", "reason": "who reviewed it and why it is outside this dataset"}]
}
```

The KR thresholds are **not set** (a data decision, not a code default).
`tests/fixtures/facility-dataset/kr-synthetic.quality-gates.json` holds
synthetic test values only (it allows the fixture's deliberately broken
`way/2003`).

**Atomic output** (`lib/write-output.mjs`): every file is written to a
staging directory, read back and checked against its SHA-256, then the
directory is renamed to the version name. On a handled failure the staging
directory, and an output root created by this run, are removed. A killed
process (for example out of memory) may leave a `.staging-*` directory, never
a version directory; the CLI lists such leftovers as
`staleStagingDirectories`.

## OPL input (S2-a)

```sh
node --max-old-space-size=4096 scripts/facility-dataset/build-dataset.mjs \
  --input complete.opl --input-format opl --region KR --out <outside the repo> \
  --quality-gates <gates.json> \
  --data-as-of <osmosis_replication_timestamp from osmium fileinfo> \
  --source-url https://download.geofabrik.de/asia/south-korea-latest.osm.pbf \
  --source-sha256 <sha256 of that .osm.pbf> [--max-input-mb N] [--max-elements N]
```

- `lib/opl.mjs` follows the libosmium 2.23.1 OPL reader/writer source
  (commit 6d473abd2d3d): `n|w|r<id>` then space/tab separated fields
  `v d c t i u T x y` (node), `... T N` (way), `... T M` (relation); tags
  `key=value,...`; way nodes `n<id>,...`; members `<n|w|r><id>@<role>,...`;
  `%<hex>%` escapes (`%%` is `%`; osmium escapes Hangul, e.g. `%d14c%`);
  empty and `#` lines ignored. Metadata fields are validated and discarded.
- Cross-checked against libosmium itself (pyosmium 4.3.2 = libosmium 2.23.1,
  run outside the repository): the reader gives the same objects as libosmium
  for the fixture and for a libosmium-written file with special keys, roles
  and escapes; the test writer produces byte-identical lines. One deliberate
  difference: a node with an out-of-range coordinate keeps its value (the
  generator then rejects it as `invalid_coordinates`, like the JSON path);
  libosmium drops such a location.
- Stricter than libosmium on purpose (the run stops with a line number):
  changeset lines, deleted objects, `locations_on_ways` way node lists,
  repeated tag keys, scientific-notation or leading-dot coordinates, ids
  beyond 2^53, escapes that are not a Unicode scalar value, raw control
  characters, invalid UTF-8, a byte order mark, a bare `\r`.
- **Tag keys are kept without loss**: every key, including `__proto__`,
  `constructor` and `prototype`, is defined as an own data property, exactly
  like `JSON.parse` does; no tag can change a prototype. Removing tags is the
  generator's policy (`PRESERVED_TAG_KEYS`), counted in
  `tags.droppedTagEntryCount`; the parser never drops a tag.
- `\n` and `\r\n` line endings are both accepted (Windows).
- OPL has no header, so `--data-as-of` is required. `--source-url` /
  `--source-sha256` are recorded in `manifest.source.upstream`;
  `manifest.source.format` is `osm-opl` (or `osm-json`).

## Memory and input limits

The OPL file is streamed, but every parsed object stays in memory: way and
relation geometry is resolved against the whole input, and the generator
keeps a canonical string per object for duplicate checks plus the tiles.

Measured on synthetic OPL shaped like a facility extract (Node 22.23, Linux,
read + build only; reproduce with `scripts/facility-dataset-analysis/memory-measure.mjs`):

| objects | OPL size | peak heap | peak RSS | time |
|---:|---:|---:|---:|---:|
| 250,002 | 49 MiB | 464 MiB | 673 MiB | 12 s |
| 500,004 | 98 MiB | 750 MiB | 1,127 MiB | 27 s |
| 1,000,008 | 197 MiB | 1,497 MiB | 2,072 MiB | 69 s |
| 2,000,002 | 394 MiB | 2,983 MiB | 4,089 MiB | 217 s |

About 7.6 bytes of heap per OPL byte (9.5 for the smallest run) and about
1.5 KB of heap per object.

| limit | default | hard ceiling (override) |
|---|---:|---:|
| OPL input (`--max-input-mb`) | 256 MiB | 1,024 MiB |
| one line | 1 MiB | 16 MiB |
| objects (`--max-elements`) | 1,500,000 | 8,000,000 |
| JSON input | 64 MiB | 64 MiB |

The OPL size limit is enforced twice and independently: from `fs.stat`
before reading, and by counting the bytes actually read (a file can grow
after stat; stat can report 0 for special files). A line over the line limit
stops the read while it is still growing, also without a final newline. The
CLI heap pre-check (`lib/memory.mjs`, input bytes x 12 versus the V8 heap
limit) runs before the input is opened.

- Defaults: sized so a default-sized run peaks near 3 GB RSS with
  `--max-old-space-size=4096`.
- Hard ceilings: input-validation bounds (roughly what a 16 GB machine could
  attempt by the same measurements), **not tested at that size and not a
  memory guarantee**.
- Heap pre-check (`lib/memory.mjs`): before reading, an OPL input of N bytes
  needs an estimated 12 x N bytes of heap; if that exceeds the V8 heap limit
  the run stops with `INSUFFICIENT_HEAP` and asks for
  `--max-old-space-size`. An estimate only; if V8 still runs out of memory,
  the process dies before writing anything (no version directory).
- **The real KR subset has not been measured.** Synthetic numbers do not show
  that real KR data fits.

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
  means zero objects of that type there. A tile over 512 KiB stops the build
  (`TILE_TOO_LARGE`): safe, but dense city cells can exceed it, which blocks
  real KR data until S2-b (below).
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

## Tile size: S2-b blocking work (review FINDING 4)

Synthetic measurements (`scripts/facility-dataset-analysis/README.md`) show
that a fixed 0.25 degree tile exceeds 512 KiB at about 1,700 hospital records
of realistic size, and that a smaller fixed grid either still fails in dense
cells (0.125 degree) or multiplies files and requests everywhere (0.0625
degree: up to 240 requests for one 50 km search). The recommended fix is a
deterministic **adaptive quadtree** (0.25 degree base cells split into
half-open quadrants while a tile is over 384 KiB, at most 5 levels). It
changes the manifest grid scheme, the tile lookup and the client merge, so it
is **not implemented in S2-a** and is tracked as the separate S2-b step.
Until then, real KR data must not be built or published.

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
- S2-a: the OPL path has not been run on real osmium output from a KR
  extract; the generator has not been run on Windows (see the S2-a report).
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
