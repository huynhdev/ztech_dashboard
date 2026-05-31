import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  chunkRanges,
  isComplete,
  isFinalShard,
  shardIndexForCursor,
  shardName,
} from "./chunking.ts"

Deno.test("shardName zero-pads to a fixed width", () => {
  assertEquals(shardName(0), "parsed-00000.json")
  assertEquals(shardName(7), "parsed-00007.json")
  assertEquals(shardName(1234), "parsed-01234.json")
})

Deno.test("chunkRanges: exact multiple of chunkSize", () => {
  assertEquals(chunkRanges(400, 200), [
    { index: 0, start: 0, end: 200 },
    { index: 1, start: 200, end: 400 },
  ])
})

Deno.test("chunkRanges: short final chunk", () => {
  assertEquals(chunkRanges(450, 200), [
    { index: 0, start: 0, end: 200 },
    { index: 1, start: 200, end: 400 },
    { index: 2, start: 400, end: 450 },
  ])
})

Deno.test("chunkRanges: fewer rows than chunkSize → single chunk", () => {
  assertEquals(chunkRanges(5, 200), [{ index: 0, start: 0, end: 5 }])
})

Deno.test("chunkRanges: zero rows → no chunks", () => {
  assertEquals(chunkRanges(0, 200), [])
})

Deno.test("chunkRanges: rejects non-positive chunkSize", () => {
  assertThrows(() => chunkRanges(10, 0))
})

Deno.test("shardIndexForCursor maps a cursor to its shard", () => {
  assertEquals(shardIndexForCursor(0, 200), 0)
  assertEquals(shardIndexForCursor(199, 200), 0)
  assertEquals(shardIndexForCursor(200, 200), 1)
  assertEquals(shardIndexForCursor(400, 200), 2)
})

Deno.test("isComplete is true once cursor reaches total", () => {
  assertEquals(isComplete(0, 450), false)
  assertEquals(isComplete(400, 450), false)
  assertEquals(isComplete(450, 450), true)
  assertEquals(isComplete(600, 450), true)
})

Deno.test("isFinalShard identifies the last shard from the cursor", () => {
  // 450 rows, size 200 → shards 0,1,2 ; final shard index = 2
  assertEquals(isFinalShard(0, 450, 200), false)
  assertEquals(isFinalShard(200, 450, 200), false)
  assertEquals(isFinalShard(400, 450, 200), true)
  // exact multiple: 400 rows → shards 0,1 ; final = 1
  assertEquals(isFinalShard(200, 400, 200), true)
})
