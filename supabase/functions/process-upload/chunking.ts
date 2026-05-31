// Pure chunk math for the two-step ingest. No I/O — unit-tested in chunking.test.ts.

// Fixed-width shard names so storage listings sort naturally. Shards are addressed
// by computed name (not by listing), so widths beyond this just grow the prefix —
// names stay unique and correct. 5 digits covers ~20M rows at CHUNK_SIZE 200.
export const SHARD_PAD = 5

export function shardName(index: number): string {
  return `parsed-${String(index).padStart(SHARD_PAD, "0")}.json`
}

export interface ChunkRange {
  index: number
  start: number // inclusive
  end: number // exclusive
}

// The slices parseStep writes, one shard per range.
export function chunkRanges(
  totalRows: number,
  chunkSize: number
): ChunkRange[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0")
  const ranges: ChunkRange[] = []
  let index = 0
  for (let start = 0; start < totalRows; start += chunkSize, index++) {
    ranges.push({ index, start, end: Math.min(start + chunkSize, totalRows) })
  }
  return ranges
}

export function shardIndexForCursor(cursor: number, chunkSize: number): number {
  return Math.floor(cursor / chunkSize)
}

export function isComplete(cursor: number, totalRows: number): boolean {
  return cursor >= totalRows
}

export function isFinalShard(
  cursor: number,
  totalRows: number,
  chunkSize: number
): boolean {
  return (
    shardIndexForCursor(cursor, chunkSize) ===
    shardIndexForCursor(totalRows - 1, chunkSize)
  )
}
