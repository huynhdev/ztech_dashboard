import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { parseWorkbook } from "./parse.ts";

function buildWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  // pivot-style sheet that MUST be ignored (no full header match)
  const pivot = XLSX.utils.aoa_to_sheet([
    ["Count of Product", "Column Labels"],
    ["Row Labels", new Date(Date.UTC(2026, 4, 11))],
    ["123 Dental", 1],
  ]);
  XLSX.utils.book_append_sheet(wb, pivot, "Sheet1");

  // detail sheet: title row + blanks + header at row index 3 + data rows
  const detail = XLSX.utils.aoa_to_sheet(
    [
      ["INCOMING CASE - ZTECH", null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null, null],
      ["No", "Pan", "Patient", "Lab", "Doctor", "Order date", "Product", "Status", "Amount"],
      [1, "Z172", "JILL SHELTON", "123 Dental", "Le, Tommy DDS - RTE: A", new Date(Date.UTC(2026, 4, 11)), "Zirconia - Multilayer Veneer...", "Shipped", 430.65],
      [2, "R209", "THUY DOAN #3653", "21 Dental Group", "Vo, Ngoc Lan DDS - RTE: JES", new Date(Date.UTC(2026, 4, 13)), "Implant - Abutment CUSTOM Titanium", "In Production", 0],
      [3, "", "", "", "", null, "", "", null], // missing patient/lab/date -> skipped
    ],
    { cellDates: true },
  );
  XLSX.utils.book_append_sheet(wb, detail, "MAY 11 - 17.2026");

  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

Deno.test("parses the detail sheet, ignores pivots, extracts entities", () => {
  const { rows, skipped } = parseWorkbook(buildWorkbook());

  assertEquals(rows.length, 2);
  assertEquals(skipped.length, 1);

  assertEquals(rows[0].pan, "Z172");
  assertEquals(rows[0].status, "Shipped");
  assertEquals(rows[0].doctorRaw, "Le, Tommy DDS - RTE: A");
  assertEquals(rows[0].productName, "Zirconia - Multilayer Veneer...");
  assertEquals(rows[0].lab, "123 Dental");
  assertEquals(rows[0].doctorName, "Le, Tommy DDS");
  assertEquals(rows[0].route, "A");
  assertEquals(rows[0].category, "Zirconia");
  assertEquals(rows[0].isMultiUnit, true);
  assertEquals(rows[0].orderDate, "2026-05-11");
  assertEquals(rows[0].amount, 430.65);

  assertEquals(rows[1].patientName, "THUY DOAN");
  assertEquals(rows[1].externalId, "3653");
  assertEquals(rows[1].route, "JES");
  assertEquals(rows[1].isMultiUnit, false);
  assertEquals(rows[1].amount, 0);
});

Deno.test("returns the no-detail-sheet sentinel when no sheet has the expected header", () => {
  const wb = XLSX.utils.book_new();
  const pivot = XLSX.utils.aoa_to_sheet([
    ["Count of Product", "Column Labels"],
    ["Row Labels", "Grand Total"],
    ["123 Dental", 1],
  ]);
  XLSX.utils.book_append_sheet(wb, pivot, "Sheet1");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

  const { rows, skipped } = parseWorkbook(bytes);
  assertEquals(rows.length, 0);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].reason, "no detail sheet found");
});
