# Prevent Duplicate File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an admin from re-uploading an `.xlsx` workbook that has already been successfully ingested, by hashing the file in the browser and surfacing the duplicate in the upload dialog before upload.

**Architecture:** Add a `file_hash` column to `public.uploads`. The upload dialog computes a SHA-256 content hash the moment a file is added, queries `uploads` for a prior **completed** row with the same hash (global, across all admins), and marks the file as a duplicate in the file list — excluding it from the upload run. The hash is stored on the `uploads` insert; a cheap re-check inside the per-file upload routine guards the add→click window. The edge function is unchanged.

**Tech Stack:** Next.js 16 / React 19 (App Router), TypeScript, Supabase (Postgres + Realtime + browser client), Web Crypto API, Tailwind 4 + shadcn/ui, date-fns, lucide-react.

**Spec:** `docs/superpowers/specs/2026-05-31-prevent-duplicate-file-upload-design.md`

---

## Testing note (read first)

This project has **no app-level JS test runner** (no vitest/jest in `package.json`). The only automated tests are Deno tests for the edge-function parser (`supabase/functions/process-upload/parse.test.ts`, run with `deno test`). React components and `lib/` utils are verified via `yarn typecheck` + `yarn lint` + manual browser testing — that is the established pattern. This plan **follows that pattern** rather than introducing a test framework (YAGNI). The pure hash util gets a known-answer check via a one-off `node` command; the dialog gets manual end-to-end verification steps.

---

## File Structure

- **Create:** `supabase/migrations/<timestamp>_add_uploads_file_hash.sql` — adds `file_hash` column + partial index to `public.uploads`. No new grants/RLS (existing `uploads` SELECT grant + `"uploads admin read"` policy already cover the global check).
- **Modify (regenerate):** `types/database.ts` — regenerated via `yarn db:gen-types` so `uploads.file_hash` is typed. Never hand-edited.
- **Create:** `lib/hash.ts` — `sha256Hex(file: File): Promise<string>`, a zero-dependency Web Crypto helper. Single responsibility: bytes → hex digest.
- **Modify:** `components/upload-dialog.tsx` — add-time hashing + duplicate check, per-file check state, file-list rendering of check status, `file_hash` on insert, and a pre-insert re-check.

---

## Task 1: Migration — add `file_hash` column + partial index

**Files:**
- Create: `supabase/migrations/<timestamp>_add_uploads_file_hash.sql`
- Regenerate: `types/database.ts`

- [ ] **Step 1: Generate the migration timestamp**

The timestamp prefix must be greater than every existing migration and is UTC. Do NOT hand-write it.

Run:
```bash
date -u +"%Y%m%d%H%M%S"
```
Use the printed value as `<timestamp>` in the filename below.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/<timestamp>_add_uploads_file_hash.sql`:
```sql
-- Add a SHA-256 content hash to uploads so the upload dialog can block
-- re-uploading a workbook that already completed ingestion. The check is global
-- (any admin's prior upload) and only considers completed uploads, so a partial
-- index covering exactly that predicate keeps the lookup cheap.
--
-- No new grants or RLS: public.uploads already grants SELECT to authenticated and
-- the "uploads admin read" policy lets an admin read every row, which is what the
-- global duplicate check relies on.
alter table public.uploads add column file_hash text;

create index uploads_file_hash_completed_idx
  on public.uploads (file_hash) where status = 'completed';
```

- [ ] **Step 3: Apply the migration locally**

Run:
```bash
yarn db:migrate
```
Expected: applies the new migration with no error (output lists the new migration filename).

- [ ] **Step 4: Regenerate database types**

Run:
```bash
yarn db:gen-types
```
Expected: `types/database.ts` is rewritten. Confirm `file_hash` now appears on the `uploads` row:
```bash
grep -n "file_hash" types/database.ts
```
Expected: at least one match (in the `uploads` `Row`/`Insert`/`Update` types).

- [ ] **Step 5: Typecheck**

Run:
```bash
yarn typecheck
```
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_add_uploads_file_hash.sql types/database.ts
git commit -m "feat(upload): add file_hash column + partial index to uploads"
```

---

## Task 2: `lib/hash.ts` — SHA-256 content hash util

**Files:**
- Create: `lib/hash.ts`

- [ ] **Step 1: Write the util**

Create `lib/hash.ts`:
```ts
// SHA-256 content hash of a file, hex-encoded. Used to detect a re-upload of a
// byte-identical workbook. Web Crypto has no streaming digest, so the whole file
// is read into memory — fine for the KB–low-MB .xlsx workbooks handled here.
// (MD5 is intentionally not used: crypto.subtle does not support it, and a
// content fingerprint does not need to be MD5.)
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
```

- [ ] **Step 2: Verify the digest + hex logic against a known vector**

There is no app test runner, so verify the exact `digest → hex` logic this util uses against the canonical SHA-256 of `"abc"` using the same Web Crypto API.

Run:
```bash
node --input-type=module -e '
import { webcrypto } from "node:crypto";
const buf = new TextEncoder().encode("abc");
const digest = await webcrypto.subtle.digest("SHA-256", buf);
const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
if (hex !== expected) { console.error("MISMATCH", hex); process.exit(1); }
console.log("OK", hex);
'
```
Expected: prints `OK ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.

- [ ] **Step 3: Typecheck + lint**

Run:
```bash
yarn typecheck && yarn lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/hash.ts
git commit -m "feat(upload): add sha256Hex content-hash util"
```

---

## Task 3: Wire add-time duplicate detection into the upload dialog

**Files:**
- Modify: `components/upload-dialog.tsx`

This is the largest task. Apply the edits in order; each `- [ ]` is one edit. Build + manual verification come at the end.

### 3a — Imports and a file-key helper

- [ ] **Step 1: Add imports**

At the top of `components/upload-dialog.tsx`, alongside the existing imports, add:
```ts
import { Loader2Icon } from "lucide-react"
import { format } from "date-fns"
import { sha256Hex } from "@/lib/hash"
import type { Tables } from "@/types/database"
```
(Add `Loader2Icon` to the existing `lucide-react` import line rather than duplicating the import.)

- [ ] **Step 2: Add a file-key helper**

Just above the `UploadDialog` component (near `deriveProgress`), add:
```ts
// Files are identified by name+size everywhere in this dialog: the dedupe in
// addFiles, the per-file check map, and the upload run all key off this.
const fileKey = (f: File) => f.name + f.size
```
Then replace the two inline `f.name + f.size` usages in `addFiles` (the `existing` Set) and the file-list `key={file.name + file.size}` with `fileKey(f)` / `fileKey(file)`.

### 3b — Per-file check state

- [ ] **Step 3: Add check state + a re-entry guard ref**

Inside `UploadDialog`, next to the existing `useState`/`useRef` hooks, add:
```ts
type CheckStatus = "checking" | "ok" | "duplicate"
type FileCheck = {
  status: CheckStatus
  hash?: string
  dup?: { email: string; uploadedAt: string }
}
```
(Define the two types at module scope, above the component, next to `FileProgress`.)

And inside the component:
```ts
const [checks, setChecks] = useState<Record<string, FileCheck>>({})
// React StrictMode invokes the setFiles updater twice in dev; this ref makes the
// per-file hash+query fire at most once per file across those double invocations.
const checkingRef = useRef<Set<string>>(new Set())
```

- [ ] **Step 4: Add the `checkFile` routine**

Inside `UploadDialog`, add (e.g. above `addFiles`):
```ts
async function checkFile(file: File) {
  const key = fileKey(file)
  if (checkingRef.current.has(key)) return
  checkingRef.current.add(key)
  setChecks((prev) => ({ ...prev, [key]: { status: "checking" } }))

  try {
    const hash = await sha256Hex(file)
    const supabase = createClient()
    const { data } = await supabase
      .from("uploads")
      .select("uploaded_at, profiles(email)")
      .eq("file_hash", hash)
      .eq("status", "completed")
      .limit(1)
      .maybeSingle()

    if (data) {
      // supabase-js types a to-one embed as an array; bridge via unknown the same
      // way lib/uploads.ts does, keeping the generated-profile anchor.
      const email =
        (data.profiles as unknown as Pick<Tables<"profiles">, "email"> | null)
          ?.email ?? "—"
      setChecks((prev) => ({
        ...prev,
        [key]: { status: "duplicate", hash, dup: { email, uploadedAt: data.uploaded_at } },
      }))
    } else {
      setChecks((prev) => ({ ...prev, [key]: { status: "ok", hash } }))
    }
  } catch {
    // Fail open: a transient hash/network error must never block a legitimate
    // upload. The pre-insert re-check in processFile is the second line of defense.
    setChecks((prev) => ({ ...prev, [key]: { status: "ok" } }))
  }
}
```

- [ ] **Step 5: Trigger `checkFile` for each newly added file**

Replace the existing `addFiles` body with:
```ts
function addFiles(incoming: FileList | null) {
  if (!incoming) return
  const valid = Array.from(incoming).filter((f) => /\.xlsx$/i.test(f.name))
  setFiles((prev) => {
    const existing = new Set(prev.map(fileKey))
    const next = [...prev]
    for (const f of valid) {
      const key = fileKey(f)
      if (existing.has(key)) continue
      existing.add(key)
      next.push(f)
      void checkFile(f)
    }
    return next
  })
}
```

### 3c — Reset

- [ ] **Step 6: Clear check state in `reset`**

In `reset()`, after the existing channel cleanup, add:
```ts
setChecks({})
checkingRef.current = new Set()
```

### 3d — Upload run: only `ok` files, reuse the hash, re-check

- [ ] **Step 7: Add a derived `readyFiles` for the button**

In the component body (after the hooks, before the early returns / JSX), add:
```ts
const readyFiles = files.filter((f) => checks[fileKey(f)]?.status === "ok")
```

- [ ] **Step 8: Upload only ready files**

In `handleUpload`, replace the guard `if (files.length === 0) return` with:
```ts
if (readyFiles.length === 0) return
```
and replace the final loop `for (const file of files)` with:
```ts
for (const file of readyFiles) {
  await processFile(file)
}
```

- [ ] **Step 9: Pass the precomputed hash + re-check before insert**

Inside `processFile`, after the initial `set({ ...status: "pending"... })` line and **before** the `uploads` insert, add:
```ts
const hash = checks[fileKey(file)]?.hash ?? null

// Guard the window between add-time check and this click: a matching file may
// have completed in between. Cheap, and only runs for files already marked ok.
if (hash) {
  const { data: dup } = await supabase
    .from("uploads")
    .select("id")
    .eq("file_hash", hash)
    .eq("status", "completed")
    .limit(1)
    .maybeSingle()
  if (dup) {
    set({ status: "failed", error: "Already uploaded" })
    settleOnce()
    return
  }
}
```
Then add `file_hash: hash` to the `uploads` insert object so it reads:
```ts
.insert({ id, file_name: file.name, file_path: path, status: "pending", uploaded_by: user.id, file_hash: hash })
```

### 3e — File-list rendering of check status

- [ ] **Step 10: Render per-file check status in the file list**

In the file-list `.map((file, i) => ...)` block, look up the check and render its status. Replace the existing inner content of each file row so the size line is swapped for the check status when relevant. The row currently renders the filename and a size line; update the secondary line:
```tsx
{files.map((file, i) => {
  const check = checks[fileKey(file)]
  return (
    <div
      key={fileKey(file)}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2",
        check?.status === "duplicate"
          ? "border-destructive/40 bg-destructive/5"
          : "bg-muted/50",
      )}
    >
      <FileSpreadsheetIcon className="shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-sm font-medium">{file.name}</p>
        {check?.status === "checking" ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            Checking for duplicates…
          </p>
        ) : check?.status === "duplicate" ? (
          <p className="text-xs text-destructive">
            Already uploaded · {check.dup?.email} ·{" "}
            {check.dup ? format(new Date(check.dup.uploadedAt), "MMM d, yyyy") : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {(file.size / 1024).toFixed(1)} KB
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => removeFile(i)}
      >
        <XIcon />
      </Button>
    </div>
  )
})}
```

### 3f — Upload button uses ready count

- [ ] **Step 11: Update the Upload button**

In `DialogFooter`, update the Upload button's `disabled` and label to use `readyFiles`:
```tsx
<Button onClick={handleUpload} disabled={readyFiles.length === 0 || uploading}>
  <UploadIcon data-icon="inline-start" />
  {uploading ? "Uploading…" : `Upload ${readyFiles.length > 0 ? `(${readyFiles.length})` : ""}`}
</Button>
```

### 3g — Build, lint, and manual verification

- [ ] **Step 12: Typecheck + lint**

Run:
```bash
yarn typecheck && yarn lint
```
Expected: PASS. (Watch for: the `Tables` import unused if mistyped, `format`/`Loader2Icon` unused, or a `Promise`-returns-in-render lint warning — fix any that appear.)

- [ ] **Step 13: Manual end-to-end verification**

Ensure local Supabase + dev server are running (`yarn dev`, app on http://localhost:6001), and you are signed in as an admin.

Verify each scenario in the Upload dialog:
1. **New file uploads + stores hash.** Add a fresh `.xlsx`, confirm it shows size (status `ok`), upload it, wait for "Completed". Then confirm the hash was stored:
   ```bash
   npx supabase@latest --workdir . db query "select file_name, status, left(file_hash, 12) as hash from public.uploads order by uploaded_at desc limit 3;" 2>/dev/null \
     || echo "If db query is unavailable, check the uploads row via Supabase Studio (http://localhost:54323)."
   ```
   Expected: the just-uploaded row has a non-null `file_hash` and `status = completed`.
2. **Duplicate is blocked at add time.** Re-open the dialog, add the **same** file again. Expected: the row shows the destructive line "Already uploaded · {email} · {date}", and the Upload button count does **not** include it.
3. **Renamed identical file is blocked.** Copy that file to a new name, add it. Expected: still flagged duplicate (hash matches).
4. **Retry after failure is allowed.** Find/produce a file whose prior upload `status = failed` (or temporarily set a row to `failed` in Studio), then add a byte-identical file. Expected: shows `ok` (not duplicate) and is uploadable.
5. **Edited file is allowed.** Open the workbook, change a cell, re-save (new bytes), add it. Expected: shows `ok` and uploads; row-level `dedupe_key` still prevents duplicate case rows.

- [ ] **Step 14: Commit**

```bash
git add components/upload-dialog.tsx
git commit -m "feat(upload): block re-upload of already-uploaded files via content hash"
```

---

## Done criteria

- `uploads.file_hash` exists with the partial index; `types/database.ts` regenerated.
- `lib/hash.ts` exists and its hex logic matches the canonical SHA-256 vector.
- The dialog hashes each added file, flags global completed-duplicates before upload, excludes them from the run, stores the hash on insert, and re-checks before inserting.
- Failed/pending prior uploads do not block a retry; edited files are allowed.
- `yarn typecheck` and `yarn lint` pass.
