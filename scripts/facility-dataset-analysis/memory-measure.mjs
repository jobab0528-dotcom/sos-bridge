#!/usr/bin/env node
// S2-a v2 analysis tool: peak memory of the OPL read + build path on
// SYNTHETIC input. Not part of the generator. Writes the synthetic OPL to a
// temporary directory OUTSIDE the repository and deletes it afterwards.
//
//   node --max-old-space-size=6144 scripts/facility-dataset-analysis/memory-measure.mjs <objects>
//
// Synthetic shape (like an `osmium tags-filter` facility extract with
// metadata): per facility unit one tagged node, or every 4th unit one tagged
// way over 4 untagged nodes, or every 40th unit a multipolygon relation over
// 2 untagged ways; spread over the KR data bounds. The tile limit is lifted
// so the run measures memory, not tile size (see tile-strategy-measure.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readOplFile} from "../facility-dataset/lib/opl.mjs";
import {buildDataset} from "../facility-dataset/lib/generate.mjs";
import {generatorInfo} from "../facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../facility-dataset/regions/kr.mjs";

const target = Number(process.argv[2] || 250000);
if(!Number.isSafeInteger(target) || target <= 0) throw new Error("usage: memory-measure.mjs <objects>");

function writeSyntheticOpl(file, targetObjects){
  const fd = fs.openSync(file, "w");
  let buffer = [];
  let objects = 0, nodeId = 1e9, wayId = 1e8, relId = 1e7, unit = 0;
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const name = (i) => `%d14c%%c2a4%%d2b8%%20%%bcd1%%c6d0%%20%${i}`;
  const meta = (v) => ` v${v} dV c${100000 + v} t2026-10-19T12:00:00Z i4242 usynthetic%20%mapper`;
  const tags = (i) => `Tamenity=${i % 5 ? "clinic" : "hospital"},healthcare=${i % 5 ? "clinic" : "hospital"},name=${name(i)},name:en=Synthetic%20%Clinic%20%${i},addr:street=%d14c%%c2a4%%d2b8%%b85c%,addr:housenumber=${i % 300},phone=+82-2-000-${String(i % 10000).padStart(4, "0")},opening_hours=Mo-Fr%20%09:00-18:00${i % 10 ? "" : ",emergency=yes"}`;
  while(objects < targetObjects){
    const lat = 33.3 + random() * 4.8, lon = 126.2 + random() * 3.2;
    unit += 1;
    if(unit % 40 === 0){
      const ways = [];
      for(let w = 0; w < 2; w += 1){
        const ids = [];
        for(let k = 0; k < 4; k += 1){
          ids.push(nodeId);
          buffer.push(`n${nodeId++}${meta(1)} T x${(lon + k * 0.0001 + w * 0.0003).toFixed(7)} y${(lat + (k % 2) * 0.0001).toFixed(7)}\n`);
          objects += 1;
        }
        buffer.push(`w${wayId}${meta(2)} T N${[...ids, ids[0]].map((x) => "n" + x).join(",")}\n`);
        ways.push(wayId++);
        objects += 1;
      }
      buffer.push(`r${relId++}${meta(3)} Ttype=multipolygon,${tags(unit).slice(1)} M${ways.map((w) => `w${w}@outer`).join(",")}\n`);
      objects += 1;
    }else if(unit % 4 === 0){
      const ids = [];
      for(let k = 0; k < 4; k += 1){
        ids.push(nodeId);
        buffer.push(`n${nodeId++}${meta(1)} T x${(lon + (k & 1) * 0.0002).toFixed(7)} y${(lat + (k >> 1) * 0.0002).toFixed(7)}\n`);
        objects += 1;
      }
      buffer.push(`w${wayId++}${meta(2)} ${tags(unit)} N${[...ids, ids[0]].map((x) => "n" + x).join(",")}\n`);
      objects += 1;
    }else{
      buffer.push(`n${unit}${meta(4)} ${unit % 7 ? tags(unit) : `Tamenity=pharmacy,name=${name(unit)}`} x${lon.toFixed(7)} y${lat.toFixed(7)}\n`);
      objects += 1;
    }
    if(buffer.length > 10000){ fs.writeSync(fd, buffer.join("")); buffer = []; }
  }
  fs.writeSync(fd, buffer.join(""));
  fs.closeSync(fd);
  return objects;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sos-memory-measure-"));
try{
  const file = path.join(directory, "synthetic.opl");
  writeSyntheticOpl(file, target);
  let peakHeap = 0;
  const timer = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 50);
  const started = Date.now();
  const {elements, stats} = await readOplFile(file, {maxInputBytes: 1024 * 1048576, maxElements: 8000000});
  const readSeconds = (Date.now() - started) / 1000;
  const result = buildDataset({elements}, {
    region: {...KR_REGION, tileMaxBytes: 64 * 1048576}, generator: generatorInfo(), dataAsOf: "2026-10-20T00:00:00Z",
    sourceLabel: "memory-measure", qualityGates: {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0.01}
  });
  clearInterval(timer);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  process.stdout.write(JSON.stringify({
    objects: stats.objectCount, oplBytes: stats.bytes,
    peakHeapMiB: Math.round(peakHeap / 1048576), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    heapBytesPerOplByte: Number((peakHeap / stats.bytes).toFixed(2)),
    readSeconds, totalSeconds: (Date.now() - started) / 1000, accepted: result.manifest.counts
  }) + "\n");
}finally{
  fs.rmSync(directory, {recursive: true, force: true});
}
