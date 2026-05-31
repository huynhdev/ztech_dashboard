# Ztech Dental Lab Dashboard

Analytics dashboard for a dental lab. Visualizes incoming cases, revenue, volume, and category breakdowns; ranks top labs and doctors; manages users and data uploads.

## Commands

```bash
yarn dev        # Dev server on http://localhost:6001 (Turbopack)
yarn build      # Production build
yarn start      # Start production server
yarn lint       # ESLint
yarn format     # Prettier format (**/*.{ts,tsx})
yarn typecheck  # tsc --noEmit

yarn db:migrate    # Apply pending Supabase migrations (local)
yarn db:reset      # Reset local database (re-runs migrations + seed)
yarn db:gen-types  # Generate TypeScript types → types/database.ts
```

## Architecture

- **Framework**: Next.js 16, React 19, TypeScript, App Router
- **UI**: shadcn/ui (style `radix-nova`, base color `neutral`), Tailwind CSS 4
- **Charts**: Recharts
- **Tables**: TanStack React Table (`@tanstack/react-table`)
- **Dates**: date-fns
- **Database**: Supabase (PostgreSQL) — all app data is read from / written to Supabase
- **Auth**: Supabase Auth (SSR) — scaffolding in place, login form not yet wired (see `app/login/page.tsx` TODO)

## Supabase / Auth Pattern

Three Supabase clients in `lib/supabase/`:

- `client.ts` — browser client (`createBrowserClient`) for Client Components
- `server.ts` — server client (`createServerClient` + `next/headers` cookies) for Server Components / Server Actions
- `proxy.ts` — session refresh used by Next.js proxy (middleware)

`proxy.ts` at the repo root is the Next.js 16 **proxy** (formerly `middleware.ts`); it calls `updateSession` from `lib/supabase/proxy.ts`. Session validation uses `supabase.auth.getClaims()` (JWT-signature check, no network call). Use `getUser()` instead only when you need to detect session revocation.

Env vars (`.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Local Supabase runs on port 54326.

## File Conventions

- Routes in `app/` (App Router). Authenticated pages live under the `app/(dashboard)/` route group; `app/login/` is public.
- Feature components in `components/` (e.g. `kpi-cards.tsx`, `revenue-chart.tsx`, `data-table.tsx`, `app-sidebar.tsx`). Table column defs live in `*-columns.tsx`.
- shadcn/ui primitives in `components/ui/`.
- Hooks in `hooks/`, utilities in `lib/`.
- Path aliases (`components.json`): `@/components`, `@/lib`, `@/components/ui`, `@/hooks`, `@/lib/utils`.

## Design System

Neutral/grayscale theme — colors defined as `oklch` CSS variables in `app/globals.css` (`:root` light, `.dark` dark). No custom brand palette yet; `--primary` is near-black. Dark mode via `next-themes`. Use the existing CSS variables (`bg-primary`, `text-muted-foreground`, `--chart-1..5`) rather than hard-coded colors.

## Skills

Use these skills (via the Skill tool) when working on relevant tasks:

| Skill                              | When to Use                                              |
| ---------------------------------- | -------------------------------------------------------- |
| `ui-ux-pro-max`                    | Building UI components, pages, layouts, design decisions |
| `frontend-design`                  | Creating polished, production-grade frontend interfaces  |
| `shadcn`                           | Search shadcn/ui component examples and usage patterns   |
| `supabase`                         | Wiring auth, DB migrations, RLS policies, Edge Functions |
| `supabase-postgres-best-practices` | Optimizing Postgres queries and schema                   |
