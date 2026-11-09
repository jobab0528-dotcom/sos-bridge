# Facility dataset analysis tools (S2-a v2)

Measurement tools for the independent review of S2-a. They are **not part of
the generator** (not imported by it, not in its provenance hash), use
synthetic data only, and need no network.

- `tile-strategy-measure.mjs` — review FINDING 4: compares tile strategies.
- `memory-measure.mjs <objects>` — peak memory of the OPL read + build path.

```sh
node --expose-gc --max-old-space-size=4096 scripts/facility-dataset-analysis/tile-strategy-measure.mjs
node --max-old-space-size=6144 scripts/facility-dataset-analysis/memory-measure.mjs 1000000
```

Numbers below: Node 22.23, Linux x64, 2 vCPU, 7 GiB RAM, 2026-10-28.
**Synthetic data only. Real KR density and record sizes are NOT VERIFIED.**

## FINDING 4: tile strategies

### Limits of the fixed 0.25 degree grid

- One tile file per 0.25 x 0.25 degree cell (about 28 x 22 km in Seoul) and
  a hard limit of 512 KiB per tile. With realistic clinic records (Korean and
  English name, address, phone, hours: about 314 bytes each in canonical
  JSON) a cell holds at most about 1,670 hospital records. The review's
  sparser records (about 125 bytes) fit about 4,200.
- Density is very uneven: one Seoul cell can hold tens of times the national
  average, so no single fixed size fits both Seoul and rural areas.
- The current behaviour (stop with `TILE_TOO_LARGE`, write nothing) is safe
  but makes a real KR build impossible once one cell is too dense.

### Measured (synthetic)

Scenario: N hospitals in the 0.25 degree cell holding central Seoul
(37.5547, 126.9707), 70 % in five clusters (sigma about 1 km) and 30 %
uniform, plus N/2 background clinics over the surrounding 1 x 1 degree box.
Fixed grids are built with the real generator (tile limit lifted to measure
sizes). The quadtree is a prototype over the same records and the same
canonical tile document: 0.25 degree base cells, split into four half-open
quadrants while a tile is over 384 KiB, at most 5 levels. "Requests" and
"download" are the hospital tiles one search at the hotspot center must
fetch (listed, non-empty tiles only).

#### 2,000 hospitals in the hotspot cell (+ 1,000 background)

| strategy | largest tile | tiles over 512 KiB | tile files | requests 1 / 5 / 10 / 50 km | download 10 km | download 50 km | build heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| fixed 0.25 | 628 KiB | 1 | 16 | 1 / 2 / 4 / 16 | 677 KiB | 868 KiB | 14 MiB |
| fixed 0.125 | 448 KiB | 0 | 64 | 1 / 2 / 9 / 64 | 648 KiB | 884 KiB | 14 MiB |
| fixed 0.0625 | 133 KiB | 0 | 250 | 2 / 6 / 19 / 234 | 557 KiB | 925 KiB | 17 MiB |
| adaptive quadtree (depth 2) | 133 KiB | 0 | 22 | 2 / 5 / 10 / 22 | 679 KiB | 870 KiB | 4 MiB |

#### 5,000 hospitals in the hotspot cell (+ 2,500 background)

| strategy | largest tile | tiles over 512 KiB | tile files | requests 1 / 5 / 10 / 50 km | download 10 km | download 50 km | build heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| fixed 0.25 | 1,575 KiB | 1 | 16 | 1 / 2 / 4 / 16 | 1,694 KiB | 2,166 KiB | 34 MiB |
| fixed 0.125 | 1,118 KiB | 1 | 64 | 1 / 2 / 9 / 64 | 1,627 KiB | 2,182 KiB | 26 MiB |
| fixed 0.0625 | 324 KiB | 0 | 256 | 2 / 6 / 20 / 240 | 1,383 KiB | 2,200 KiB | 21 MiB |
| adaptive quadtree (depth 2) | 324 KiB | 0 | 22 | 2 / 5 / 10 / 22 | 1,696 KiB | 2,168 KiB | 29 MiB |

#### 10,000 hospitals in the hotspot cell (+ 5,000 background)

| strategy | largest tile | tiles over 512 KiB | tile files | requests 1 / 5 / 10 / 50 km | download 10 km | download 50 km | build heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| fixed 0.25 | 3,145 KiB | 1 | 16 | 1 / 2 / 4 / 16 | 3,369 KiB | 4,329 KiB | 50 MiB |
| fixed 0.125 | 2,236 KiB | 1 | 64 | 1 / 2 / 9 / 64 | 3,230 KiB | 4,344 KiB | 44 MiB |
| fixed 0.0625 | 680 KiB | 2 | 256 | 2 / 6 / 20 / 240 | 2,751 KiB | 4,324 KiB | 53 MiB |
| adaptive quadtree (depth 3) | 383 KiB | 0 | 37 | 4 / 13 / 23 / 37 | 3,252 KiB | 4,336 KiB | 29 MiB |

#### 20,000 hospitals in the hotspot cell (+ 10,000 background)

| strategy | largest tile | tiles over 512 KiB | tile files | requests 1 / 5 / 10 / 50 km | download 10 km | download 50 km | build heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| fixed 0.25 | 6,301 KiB | 1 | 16 | 1 / 2 / 4 / 16 | 6,782 KiB | 8,666 KiB | 144 MiB |
| fixed 0.125 | 4,544 KiB | 2 | 64 | 1 / 2 / 9 / 64 | 6,501 KiB | 8,681 KiB | 127 MiB |
| fixed 0.0625 | 1,376 KiB | 4 | 256 | 2 / 6 / 20 / 240 | 5,557 KiB | 8,581 KiB | 115 MiB |
| adaptive quadtree (depth 4) | 345 KiB | 0 | 61 | 5 / 23 / 40 / 61 | 5,875 KiB | 8,681 KiB | 85 MiB |

All strategies, all scenarios: **deterministic** (input shuffled, same
content hash) and **no record missed within the search radius** (300 random
searches of 0.5 to 50 km around the hotspot on the 20,000 scenario;
2,371,973 record-in-radius checks, 0 missing). "build heap" is a sampled
heap delta and only indicates order of magnitude.

### Comparison

| | fixed 0.25 | smaller fixed (0.125 / 0.0625) | adaptive quadtree |
|---|---|---|---|
| dense cells under 512 KiB | fails from about 1,700 records | 0.125 fails at 5,000; 0.0625 fails at 10,000 | passes up to 20,000 (depth 4 of 5) |
| files | fewest | 4x / 16x everywhere, also in empty-ish areas | only where dense (22 to 61 here) |
| requests per search | fewest, but huge files | 0.0625: up to 240 for 50 km | 5 to 61; grows only with local density |
| radius completeness | exact (conservative box) | exact | exact (same box, leaves intersecting it) |
| determinism | yes | yes | yes: split decision depends only on the records; ids are base tile + quadrant path |
| generator memory | baseline | about the same | about the same; parent tiles are serialized then discarded |
| client change | none | grid size in manifest only | client must read the leaf list from the manifest |

Download size per search in a very dense area is several MiB with **any**
tiling (it is the data inside the radius). Tiling cannot fix that; it needs
smaller records or radius-adaptive fetching in the client (S3 scope).

### Recommendation: adaptive quadtree (S2-b, blocking)

Not implemented in S2-a: it changes the manifest grid scheme, the tile
lookup (`lib/geo.mjs`), the cross-tile merge (`lib/read.mjs`), every
consumer test and the S3 client contract, which is well beyond this patch.
**Real KR data must not be built or published before S2-b is done.**

Design:

1. Base grid unchanged: 0.25 degree half-open cells in 1e-7 integer units.
2. Split rule: a tile whose canonical bytes exceed `splitTargetBytes`
   (384 KiB) is split into 4 half-open quadrants (index `2 * north + east`),
   recursively, at most `maxSplitDepth` 5 (0.0078125 degree, still an integer
   in 1e-7 units). A leaf over `tileMaxBytes` (512 KiB) at maximum depth
   stops the build (`TILE_TOO_LARGE`), as today.
3. Ids: `<latIndex>_<lonIndex>` for unsplit cells, `<latIndex>_<lonIndex>~<path>`
   (path of quadrant digits) for leaves; paths sorted lexicographically.
   Empty quadrants are not listed (same meaning as an unlisted tile today).
4. Manifest: `grid.scheme` `latlon-e7-quadtree-half-open`, `splitTargetBytes`,
   `maxSplitDepth`; each tile entry carries its integer bounds and depth.
   `manifestSchemaVersion` 2 (old readers must refuse it).
5. Lookup: base cells from the conservative search box (existing
   `tileIdsForSearch`), then every listed leaf whose bounds intersect the box.
   Merge and order stay `mergeTileElements` (per facility type).
6. Split per facility type independently (hospital and pharmacy densities
   differ).

Implementation steps: (a) quadtree builder in the generator behind the new
scheme, (b) `tileIdsForSearch` replacement in `lib/geo.mjs` that takes the
manifest tile list, (c) `staticCandidates` helper and all tile consumers,
(d) README and manifest schema, (e) tests below, (f) only then the first real
KR candidate build (S2-c), outside the repository, not published.

Test criteria for S2-b:

- property test: random points and radii (0.5 to 50 km), every record within
  the radius is in a fetched leaf (0 missing), for dense and sparse layouts;
- no leaf over 512 KiB; a leaf at max depth over the limit stops the build;
- same records in any input order give the same leaves, ids and hashes;
- quadrant membership on exact boundaries (half-open, integer arithmetic),
  including the +90 / +180 edge cells;
- hospital evidence order and pharmacy order preserved across leaves
  (existing contract and live-parity tests rerun on quadtree output);
- an unsplit dataset (all cells small) is byte-identical in tile content to
  the fixed 0.25 grid output, except for the manifest scheme;
- the manifest is refused by a reader that only knows schema 1;
- requests per search reported in the validation report (max and p95 over a
  fixed grid of sample points) so S2-c can judge CDN cost on real data.

## Memory (OPL read + build)

See `scripts/facility-dataset/README.md` "Memory and input limits" for the
table and the chosen limits. Synthetic only; the real KR subset is not
measured.
