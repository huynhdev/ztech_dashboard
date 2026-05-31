import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

export type Profile = Database["public"]["Tables"]["profiles"]["Row"]

export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient()

  const { data } = await supabase.auth.getClaims()
  const userId = data?.claims?.sub
  if (!userId) return null

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single()

  return profile
}

export async function requireAdmin(): Promise<Profile> {
  const profile = await getProfile()
  if (!profile || profile.role !== "admin") {
    redirect("/login")
  }
  return profile
}
