import { createClient } from "@/lib/supabase/server";
import type { CaseRow } from "@/lib/data";

// Server-only fetch of every incoming case, denormalized into the flat CaseRow
// shape the analytics functions in `@/lib/data` consume. Lab/doctor names and the
// product category are pulled in via embedded selects so the client never needs
// the lookup tables. The dashboard aggregates these rows in-memory (see
// `components/dashboard-overview`), mirroring the previous JSON-backed behavior.
export async function getIncomingCases(): Promise<CaseRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("incoming_cases")
    .select(
      "order_date, amount, status, lab_id, doctor_id, patient_id, labs(name), doctors(name), products(category)",
    )
    .order("order_date", { ascending: true });

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
