import Link from "next/link";
import { format, isValid, parseISO, subMonths } from "date-fns";
import { DashboardOverview } from "@/components/dashboard-overview";
import { Button } from "@/components/ui/button";
import { getIncomingCases, getOrderDateBounds } from "@/lib/cases";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && isValid(parseISO(value));
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromParam, to: toParam } = await searchParams;
  const bounds = await getOrderDateBounds();

  if (!bounds) {
    return (
      <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h2 className="text-sm font-medium">No data yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Upload a workbook to populate the dashboard with incoming cases.
          </p>
          <Button asChild size="sm">
            <Link href="/upload">Upload data</Link>
          </Button>
        </div>
      </main>
    );
  }

  // The URL is the source of truth for the filter. When params are absent or
  // malformed, fall back to the last 2 months (two months ago through today).
  const today = new Date();
  const defaultFrom = format(subMonths(today, 2), "yyyy-MM-dd");
  const defaultTo = format(today, "yyyy-MM-dd");

  const from = isIsoDate(fromParam) ? fromParam : defaultFrom;
  const to = isIsoDate(toParam) ? toParam : defaultTo;

  const cases = await getIncomingCases({ from, to });

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <DashboardOverview cases={cases} from={from} to={to} />
    </main>
  );
}
