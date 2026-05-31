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
- When adding tables, write a migration under `supabase/migrations/` and enable RLS with appropriate policies.
- After writing a migration: run `yarn db:migrate` to apply it locally, then `yarn db:gen-types` to regenerate `types/database.ts`. Use `yarn db:reset` to rebuild the local DB from scratch.
- Type Supabase queries against the generated `types/database.ts` — do not hand-write row types.
- Invoke the `supabase` skill for migrations, RLS policies, auth wiring, and Edge Functions.
