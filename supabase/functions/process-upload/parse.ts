import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs"

export interface ParsedRow {
  pan: string
  patientName: string
  externalId: string | null
  lab: string
  doctorName: string
  route: string | null
  doctorRaw: string
  orderDate: string // YYYY-MM-DD
  productName: string
  category: string
  isMultiUnit: boolean
  status: string
  amount: number
  isRedo: boolean
}

export interface SkippedRow {
  reason: string
  raw: unknown
  // "header" marks the single diagnostic row emitted when no sheet matched the
  // template; "row" (or absent) marks an individual data row that was dropped.
  kind?: "header" | "row"
}

export interface ParseResult {
  rows: ParsedRow[]
  skipped: SkippedRow[]
}

// Each required field accepts one or more header aliases. Different exports label the
// same column differently — the analyst template uses "Lab"/"Order date"/"Product",
// while a raw ZTECH export uses "Client"/"Ordered"/"Products" — so a field counts as
// present when ANY of its aliases matches a header cell. Sheets are always matched by
// their columns, never by sheet name.
const HEADER_FIELDS: { label: string; aliases: string[] }[] = [
  { label: "pan", aliases: ["pan"] },
  { label: "patient", aliases: ["patient"] },
  { label: "lab", aliases: ["lab", "client"] },
  { label: "doctor", aliases: ["doctor"] },
  { label: "order date", aliases: ["order date", "ordered"] },
  { label: "product", aliases: ["product", "products"] },
  { label: "status", aliases: ["status"] },
  { label: "amount", aliases: ["amount"] },
]

function aliasesFor(label: string): string[] {
  return HEADER_FIELDS.find((f) => f.label === label)!.aliases
}

function norm(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
}

// Header match on a word boundary: "status" matches "status" or "status (current)"
// but NOT "status notes" shadowing a real "status" column elsewhere in the row.
function matches(cell: string, key: string): boolean {
  return cell === key || (cell.startsWith(key) && cell[key.length] === " ")
}

function matchesField(cell: string, aliases: string[]): boolean {
  return aliases.some((a) => matches(cell, a))
}

function toDateString(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear()
    const m = String(v.getUTCMonth() + 1).padStart(2, "0")
    const d = String(v.getUTCDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}($|[T ])/.test(v))
    return v.slice(0, 10)
  return null
}

// Real PANs are alphanumeric tray numbers ("A11"); analysts backfill empty Pan
// cells with a literal 0. Pan is the first dedupe_key segment, so blank vs 0
// must normalize identically or re-uploads duplicate the row.
function parsePan(v: unknown): string {
  const s = String(v ?? "").trim()
  return s === "0" ? "" : s
}

function parsePatient(raw: string): {
  name: string
  externalId: string | null
} {
  const m = raw.match(/^(.*?)\s*#\s*(\S+)\s*$/)
  return m
    ? { name: m[1].trim(), externalId: m[2].trim() }
    : { name: raw.trim(), externalId: null }
}

function parseDoctor(raw: string): { name: string; route: string | null } {
  const m = raw.match(/^(.*?)\s*-\s*RTE:\s*(\S+)\s*$/i)
  return m
    ? { name: m[1].trim(), route: m[2].trim() }
    : { name: raw.trim(), route: null }
}

function parseProduct(raw: string): {
  name: string
  category: string
  isMultiUnit: boolean
} {
  const name = raw.trim()
  const isMultiUnit = /\.\.\.\s*$/.test(name)
  const i = name.indexOf(" - ")
  const category = i >= 0 ? name.slice(0, i).trim() : name
  return { name, category, isMultiUnit }
}

// Locate the redo-marker column. Exports flag a redo case in a "REDO" column
// (value 1) or an "R" column (value 'R'). In the analyst DETAIL template those
// labels sit one row ABOVE the main column headers, so we also scan that row.
// Returns -1 for older files without the column (every row is then non-redo).
function findRedoCol(header: string[], above: string[]): number {
  const pick = (cells: string[]): number => {
    const redo = cells.indexOf("redo")
    if (redo >= 0) return redo
    return cells.indexOf("r")
  }
  const inHeader = pick(header)
  return inHeader >= 0 ? inHeader : pick(above)
}

function isRedoValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "number") return v !== 0
  const s = String(v).trim().toLowerCase()
  return s !== "" && s !== "0" && s !== "false" && s !== "no"
}

// Headers live in the first rows of a sheet; only this window is scanned when
// matching sheets against the template (and when reporting the closest miss).
const HEADER_SCAN_ROWS = 30

interface SheetMatch {
  sheet: string
  headerIdx: number
}

// Pass 1 of the two-pass parse: locate the detail sheet by reading ONLY the header
// window of every sheet (sheetRows bounds cell parsing; the shared-strings table is
// still decoded once). Real exports carry big pivot/raw sheets the importer never
// uses — fully parsing them burned ~2.5s CPU on a 2.5MB workbook and tripped the
// edge runtime's 2s budget ("CPU Time exceeded"), so they must never be read whole.
// `best` records the closest partial match, used to explain a failed run.
function findDetailSheet(bytes: Uint8Array): {
  found: SheetMatch | null
  best: { sheet: string; missing: string[] } | null
  sheetNames: string[]
} {
  const probe = XLSX.read(bytes, { type: "array", sheetRows: HEADER_SCAN_ROWS })
  const sheetNames = probe.SheetNames
  let best: { sheet: string; missing: string[] } | null = null

  for (const sheetName of probe.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(probe.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    }) as unknown[][]

    for (let i = 0; i < matrix.length; i++) {
      const cells = (matrix[i] ?? []).map(norm)
      const missing = HEADER_FIELDS.filter(
        (f) => !cells.some((c) => matchesField(c, f.aliases))
      ).map((f) => f.label)
      if (best === null || missing.length < best.missing.length) {
        best = { sheet: sheetName, missing }
      }
      if (missing.length === 0) {
        return { found: { sheet: sheetName, headerIdx: i }, best, sheetNames }
      }
    }
  }
  return { found: null, best, sheetNames }
}

export function parseWorkbook(bytes: Uint8Array): ParseResult {
  const { found, best, sheetNames } = findDetailSheet(bytes)

  if (found) {
    // Pass 2: full parse of the matched sheet only — every other sheet is skipped.
    const wb = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      sheets: [found.sheet],
    })
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[found.sheet], {
      header: 1,
      raw: true,
      defval: null,
    }) as unknown[][]
    const headerIdx = found.headerIdx

    const header = matrix[headerIdx].map(norm)
    const col = (label: string) =>
      header.findIndex((c) => matchesField(c, aliasesFor(label)))
    const idx = {
      pan: col("pan"),
      patient: col("patient"),
      lab: col("lab"),
      doctor: col("doctor"),
      orderDate: col("order date"),
      product: col("product"),
      status: col("status"),
      amount: col("amount"),
    }
    const redoCol = findRedoCol(
      header,
      headerIdx > 0 ? (matrix[headerIdx - 1] ?? []).map(norm) : []
    )

    const rows: ParsedRow[] = []
    const skipped: SkippedRow[] = []

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const r = matrix[i]
      if (!r || r.every((c) => c === null || String(c).trim() === "")) continue

      const patientCell = String(r[idx.patient] ?? "").trim()
      const lab = String(r[idx.lab] ?? "").trim()
      const orderDate = toDateString(r[idx.orderDate])
      if (!patientCell || !lab || !orderDate) {
        skipped.push({ reason: "missing patient/lab/order_date", raw: r })
        continue
      }

      const { name: patientName, externalId } = parsePatient(patientCell)
      const doctorRaw = String(r[idx.doctor] ?? "").trim()
      const { name: doctorName, route } = parseDoctor(doctorRaw)
      const {
        name: productName,
        category,
        isMultiUnit,
      } = parseProduct(String(r[idx.product] ?? "").trim())
      const amountNum = Number(r[idx.amount] ?? 0)

      rows.push({
        pan: parsePan(r[idx.pan]),
        patientName,
        externalId,
        lab,
        doctorName,
        route,
        doctorRaw,
        orderDate,
        productName,
        category,
        isMultiUnit,
        status: String(r[idx.status] ?? "").trim(),
        amount: Number.isFinite(amountNum) ? amountNum : 0,
        isRedo: redoCol >= 0 && isRedoValue(r[redoCol]),
      })
    }

    return { rows, skipped }
  }

  const detail =
    best && best.missing.length < HEADER_FIELDS.length
      ? `Closest sheet "${best.sheet}" is missing column(s): ${best.missing.join(", ")}.`
      : "No sheet contained the expected column headers."
  const reason = `No detail sheet found. ${detail} Expected columns: ${HEADER_FIELDS.map((f) => f.label).join(", ")}.`
  return { rows: [], skipped: [{ reason, raw: sheetNames, kind: "header" }] }
}
