// Heap pre-check for OPL input. The generator keeps every parsed object in
// memory (way and relation geometry is resolved against the whole input), so
// peak heap grows with the input size. ESTIMATED_HEAP_BYTES_PER_OPL_BYTE is
// rounded up from synthetic measurements (README "Memory"). It refuses runs
// that cannot fit BEFORE reading; it is an estimate, not a guarantee. If V8
// still runs out of memory the process stops before anything is written
// (lib/write-output.mjs writes only after a complete build).

import v8 from "node:v8";
import {DatasetBuildError} from "./errors.mjs";

export const ESTIMATED_HEAP_BYTES_PER_OPL_BYTE = 12;

export function assertHeapFits(inputBytes, heapLimitBytes = v8.getHeapStatistics().heap_size_limit){
  const estimated = inputBytes * ESTIMATED_HEAP_BYTES_PER_OPL_BYTE;
  if(estimated > heapLimitBytes){
    throw new DatasetBuildError("INSUFFICIENT_HEAP",
      `input of ${inputBytes} bytes needs an estimated ${Math.ceil(estimated / 1048576)} MiB of heap; this process has ${Math.floor(heapLimitBytes / 1048576)} MiB (run node --max-old-space-size=<MiB>)`,
      {inputBytes, estimatedHeapBytes: estimated, heapLimitBytes});
  }
  return {estimatedHeapBytes: estimated, heapLimitBytes};
}
