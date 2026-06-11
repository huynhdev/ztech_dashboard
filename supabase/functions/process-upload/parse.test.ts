import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

Deno.test("normalizes placeholder PANs (0 or blank) to empty string", () => {
  const wb = XLSX.utils.book_new();
  const detail = XLSX.utils.aoa_to_sheet(
    [
      ["No", "Pan", "Patient", "Lab", "Doctor", "Order date", "Product", "Status", "Amount"],
      [1, 0, "L TUYET", "iSmiles Dentistry", "Dang, Nina Nhan DDS", new Date(Date.UTC(2026, 2, 2)), "Zirconia - Full Contour", "Shipped", 0],
      [2, "0", "TONY THAI", "Tustin Blue", "Vu, Diana DDS", new Date(Date.UTC(2026, 2, 3)), "Zirconia - Full Contour", "Shipped", 0],
      [3, null, "PARTS", "Mehta Dental Group", "Mehta, R DDS", new Date(Date.UTC(2026, 3, 8)), "Parts", "Shipped", 53.29],
      [4, "A11", "THAO TRAN", "SGTD Global", "Tran, T DDS", new Date(Date.UTC(2026, 2, 2)), "Zirconia - Full Contour", "Shipped", 246.41],
    ],
    { cellDates: true },
  );
  XLSX.utils.book_append_sheet(wb, detail, "MAR.2026 DETAIL");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

  const { rows } = parseWorkbook(bytes);
  assertEquals(rows.length, 4);
  assertEquals(rows[0].pan, ""); // numeric 0 placeholder
  assertEquals(rows[1].pan, ""); // string "0" placeholder
  assertEquals(rows[2].pan, ""); // genuinely blank
  assertEquals(rows[3].pan, "A11"); // real PAN untouched
});

Deno.test("parses a raw ZTECH export via column aliases (Client/Ordered/Products)", () => {
  const wb = XLSX.utils.book_new();
  const detail = XLSX.utils.aoa_to_sheet(
    [
      [
        "Invoice", "Client", "Doctor", "Patient", "Pan", "Products", "Units",
        "Ordered", "Due", "Appt", "Completed", "Shipped", "Status", "Amount",
      ],
      [
        44553, "123 Dental", "Le, Tommy DDS - RTE: A", "DANIEL DANG", "Z134",
        "Zirconia - Full Contour", 1, new Date(Date.UTC(2026, 2, 19)),
        new Date(Date.UTC(2026, 2, 27)), null, null, null, "Shipped", 58.59,
      ],
    ],
    { cellDates: true },
  );
  XLSX.utils.book_append_sheet(wb, detail, "ZTECH");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

  const { rows, skipped } = parseWorkbook(bytes);
  assertEquals(skipped.length, 0);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].pan, "Z134");
  assertEquals(rows[0].lab, "123 Dental");
  assertEquals(rows[0].orderDate, "2026-03-19");
  assertEquals(rows[0].productName, "Zirconia - Full Contour");
  assertEquals(rows[0].category, "Zirconia");
  assertEquals(rows[0].doctorName, "Le, Tommy DDS");
  assertEquals(rows[0].route, "A");
  assertEquals(rows[0].status, "Shipped");
  assertEquals(rows[0].amount, 58.59);
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
  assertEquals(skipped[0].kind, "header");
  assertStringIncludes(skipped[0].reason, "No detail sheet found");
  assertStringIncludes(skipped[0].reason, "No sheet contained the expected column headers");
  assertStringIncludes(skipped[0].reason, "Expected columns:");
});

Deno.test("names the missing columns when a sheet is close to the template", () => {
  const wb = XLSX.utils.book_new();
  // Header row matches everything except "doctor" and "amount".
  const detail = XLSX.utils.aoa_to_sheet([
    ["No", "Pan", "Patient", "Lab", "Order date", "Product", "Status"],
    [1, "Z172", "JILL SHELTON", "123 Dental", new Date(Date.UTC(2026, 4, 11)), "Crown", "Shipped"],
  ]);
  XLSX.utils.book_append_sheet(wb, detail, "Cases");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

  const { rows, skipped } = parseWorkbook(bytes);
  assertEquals(rows.length, 0);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].kind, "header");
  assertStringIncludes(skipped[0].reason, 'Closest sheet "Cases" is missing column(s): doctor, amount');
});
