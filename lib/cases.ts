import { createClient } from "@/lib/supabase/server";
import type { CaseRow } from "@/lib/data";

// Inclusive ISO (yyyy-MM-dd) bounds for the dashboard date filter. The page reads
// these from the URL searchParams so a filtered view is shareable/bookmarkable.
export type DateRangeFilter = { from?: string; to?: string };

// Server-only fetch of incoming cases, denormalized into the flat CaseRow shape
// the analytics functions in `@/lib/data` consume. Lab/doctor names and the
// product category are pulled in via embedded selects so the client never needs
// the lookup tables. When a date range is supplied the filter is pushed down to
// Postgres (`order_date` between from/to) rather than fetched-then-filtered.
export async function getIncomingCases(
  range?: DateRangeFilter,
): Promise<CaseRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("incoming_cases")
    .select(
      "order_date, amount, status, lab_id, doctor_id, patient_id, labs(name), doctors(name), products(category)",
    )
    .order("order_date", { ascending: true });

  if (range?.from) query = query.gte("order_date", range.from);
  if (range?.to) query = query.lte("order_date", range.to);

  const { data, error } = await query;

  if (error) {
    console.error(
      "[getIncomingCases] Supabase error:",
      error.message,
      error.code,
    );
    return [];
  }
  if (!data) return [];

  return data.map((c) => {
    // supabase-js types these many-to-one embeds as arrays, but a to-one embed
    // returns a single object (or null) at runtime; bridge via unknown.
    const lab = c.labs as unknown as { name: string } | null;
    const doctor = c.doctors as unknown as { name: string } | null;
    const product = c.products as unknown as { category: string | null } | null;
    return {
      orderDate: c.order_date,
      amount: c.amount,
      status: c.status,
      labId: c.lab_id,
      labName: lab?.name ?? "",
      doctorId: c.doctor_id,
      doctorName: doctor?.name ?? "",
      patientId: c.patient_id,
      category: product?.category ?? "",
    };
  });
}

// Earliest and latest order_date across all cases, used to seed the default
// dashboard window (and to tell "no data at all" apart from "no data in range").
// Two indexed limit-1 lookups rather than scanning every row.
export async function getOrderDateBounds(): Promise<{
  min: string;
  max: string;
} | null> {
  const supabase = await createClient();
  const [{ data: earliest }, { data: latest }] = await Promise.all([
    supabase
      .from("incoming_cases")
      .select("order_date")
      .order("order_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("incoming_cases")
      .select("order_date")
      .order("order_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!earliest || !latest) return null;
  return { min: earliest.order_date, max: latest.order_date };
}
