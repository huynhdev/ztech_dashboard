import { createClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

/**
 * Server-only Supabase client authenticated with the secret key, which bypasses
 * RLS. Use this exclusively for privileged operations that the user's session
 * cannot perform — creating, updating, or deleting auth users from the Users
 * page. NEVER import this into a Client Component; the secret key must never
 * reach the browser.
 */
export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set — required for admin user operations"
    )
  }

  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    secretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
