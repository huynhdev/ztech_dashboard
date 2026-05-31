---
paths:
  - "lib/supabase/**"
  - "app/**"
  - "proxy.ts"
  - "supabase/**"
---

# Supabase & Auth

Pick the correct client for the context — never mix them:

- `@/lib/supabase/client` (`createBrowserClient`) — Client Components only.
- `@/lib/supabase/server` (`createServerClient` + `next/headers` cookies) — Server Components, Server Actions, Route Handlers. `createClient()` is async — `await` it.
- `@/lib/supabase/proxy` (`updateSession`) — used only by the root `proxy.ts` to refresh the session.

Rules:

- Validate sessions with `supabase.auth.getClaims()` (JWT-signature check, no network call). Use `getUser()` only when you must detect session revocation.
- Read env via `process.env.NEXT_PUBLIC_SUPABASE_URL!` and `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!`. Never hard-code URLs or keys.
- `proxy.ts` is the Next.js 16 proxy (formerly `middleware.ts`) — keep auth/session logic there, not duplicated per-route.
- All app data goes through Supabase. Do not reintroduce local JSON seed files as a data source.
- When adding tables, write a migration under `supabase/migrations/` that does three things as a unit: grant Data API privileges, enable RLS, and add policies. Supabase no longer auto-exposes new `public`-schema tables to the Data API (PostgREST/`supabase-js`) — explicit `GRANT`s are required (new default since 2026-05-30; applies to existing projects' new tables from 2026-10-30). Without them, client queries fail with permission-denied. See https://github.com/orgs/supabase/discussions/45329.

  ```sql
  GRANT SELECT ON public.your_table TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
  ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;
  -- then CREATE POLICY ... per role as needed
  ```

  Scope grants to what the table needs (e.g. read-only analytics tables may only need `SELECT` for `authenticated`). Sequences do not inherit table grants — grant `USAGE, SELECT` on any sequence a granted role must use. This applies to the `public` schema only; `storage`/`auth`/`realtime` are unaffected.
- Name migration files `<timestamp>_<description>.sql` where the timestamp is `YYYYMMDDHHMMSS` (UTC), e.g. `20260531000000_keepalive.sql`. The timestamp prefix orders migrations and must be greater than every existing one. **Always generate the timestamp by running this command first — do not hand-write or guess it:**

  ```bash
  date -u +"%Y%m%d%H%M%S"
  ```
- After writing a migration: run `yarn db:migrate` to apply it locally, then `yarn db:gen-types` to regenerate `types/database.ts`. Use `yarn db:reset` to rebuild the local DB from scratch.
- Type Supabase queries against the generated `types/database.ts` — do not hand-write row types.
- Invoke the `supabase` skill for migrations, RLS policies, auth wiring, and Edge Functions.
