import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

export interface ParsedRow {
  pan: string;
  patientName: string;
  externalId: string | null;
  lab: string;
  doctorName: string;
  route: string | null;
  doctorRaw: string;
  orderDate: string; // YYYY-MM-DD
  productName: string;
  category: string;
  isMultiUnit: boolean;
  status: string;
  amount: number;
}

export interface SkippedRow {
  reason: string;
  raw: unknown;
  // "header" marks the single diagnostic row emitted when no sheet matched the
  // template; "row" (or absent) marks an individual data row that was dropped.
  kind?: "header" | "row";
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
}

const HEADER_KEYS = ["pan", "patient", "lab", "doctor", "order date", "product", "status", "amount"];

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

// Header match on a word boundary: "status" matches "status" or "status (current)"
// but NOT "status notes" shadowing a real "status" column elsewhere in the row.
function matches(cell: string, key: string): boolean {
  return cell === key || (cell.startsWith(key) && cell[key.length] === " ");
}

function toDateString(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}($|[T ])/.test(v)) return v.slice(0, 10);
  return null;
}

function parsePatient(raw: string): { name: string; externalId: string | null } {
  const m = raw.match(/^(.*?)\s*#\s*(\S+)\s*$/);
  return m ? { name: m[1].trim(), externalId: m[2].trim() } : { name: raw.trim(), externalId: null };
}

function parseDoctor(raw: string): { name: string; route: string | null } {
  const m = raw.match(/^(.*?)\s*-\s*RTE:\s*(\S+)\s*$/i);
  return m ? { name: m[1].trim(), route: m[2].trim() } : { name: raw.trim(), route: null };
}

function parseProduct(raw: string): { name: string; category: string; isMultiUnit: boolean } {
  const name = raw.trim();
  const isMultiUnit = /\.\.\.\s*$/.test(name);
  const i = name.indexOf(" - ");
  const category = i >= 0 ? name.slice(0, i).trim() : name;
  return { name, category, isMultiUnit };
}

export function parseWorkbook(bytes: Uint8Array): ParseResult {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });

  // Best partial header match across all sheets, used to explain the failure if
  // no sheet has the full set. Headers live near the top, so only the first rows
  // are considered candidates.
  let best: { sheet: string; missing: string[] } | null = null;

  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    }) as unknown[][];

    for (let i = 0; i < Math.min(matrix.length, 30); i++) {
      const cells = (matrix[i] ?? []).map(norm);
      const missing = HEADER_KEYS.filter((k) => !cells.some((c) => matches(c, k)));
      if (best === null || missing.length < best.missing.length) {
        best = { sheet: sheetName, missing };
      }
    }

    const headerIdx = matrix.findIndex((row) => {
      const cells = (row ?? []).map(norm);
      return HEADER_KEYS.every((k) => cells.some((c) => matches(c, k)));
    });
    if (headerIdx === -1) continue;

    const header = matrix[headerIdx].map(norm);
    const col = (key: string) => header.findIndex((c) => matches(c, key));
    const idx = {
      pan: col("pan"),
      patient: col("patient"),
      lab: col("lab"),
      doctor: col("doctor"),
      orderDate: col("order date"),
      product: col("product"),
      status: col("status"),
      amount: col("amount"),
    };

    const rows: ParsedRow[] = [];
    const skipped: SkippedRow[] = [];

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const r = matrix[i];
      if (!r || r.every((c) => c === null || String(c).trim() === "")) continue;

      const patientCell = String(r[idx.patient] ?? "").trim();
      const lab = String(r[idx.lab] ?? "").trim();
      const orderDate = toDateString(r[idx.orderDate]);
      if (!patientCell || !lab || !orderDate) {
        skipped.push({ reason: "missing patient/lab/order_date", raw: r });
        continue;
      }

      const { name: patientName, externalId } = parsePatient(patientCell);
      const doctorRaw = String(r[idx.doctor] ?? "").trim();
      const { name: doctorName, route } = parseDoctor(doctorRaw);
      const { name: productName, category, isMultiUnit } = parseProduct(String(r[idx.product] ?? "").trim());
      const amountNum = Number(r[idx.amount] ?? 0);

      rows.push({
        pan: String(r[idx.pan] ?? "").trim(),
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
      });
    }

    return { rows, skipped };
  }

  const detail =
    best && best.missing.length < HEADER_KEYS.length
      ? `Closest sheet "${best.sheet}" is missing column(s): ${best.missing.join(", ")}.`
      : "No sheet contained the expected column headers.";
  const reason = `No detail sheet found. ${detail} Expected columns: ${HEADER_KEYS.join(", ")}.`;
  return { rows: [], skipped: [{ reason, raw: wb.SheetNames, kind: "header" }] };
}
