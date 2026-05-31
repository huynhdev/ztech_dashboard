import Link from "next/link";
import { DashboardOverview } from "@/components/dashboard-overview";
import { Button } from "@/components/ui/button";
import { getIncomingCases } from "@/lib/cases";

export default async function Page() {
  const cases = await getIncomingCases();

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      {cases.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h2 className="text-sm font-medium">No data yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Upload a workbook to populate the dashboard with incoming cases.
          </p>
          <Button asChild size="sm">
            <Link href="/upload">Upload data</Link>
          </Button>
        </div>
      ) : (
        <DashboardOverview cases={cases} />
      )}
    </main>
  );
}
