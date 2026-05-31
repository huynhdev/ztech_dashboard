"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"
import { loginSchema, type LoginFormValues } from "@/lib/schemas/login"

export type LoginState = {
  error?: string
}

export async function login(data: LoginFormValues): Promise<LoginState> {
  const parsed = loginSchema.safeParse(data)
  if (!parsed.success) {
    return { error: "Invalid form data" }
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    return { error: "Invalid email or password" }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "Authentication failed" }
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  if (profile?.role !== "admin") {
    await supabase.auth.signOut()
    return { error: "You are not authorized to access this dashboard" }
  }

  revalidatePath("/", "layout")
  redirect("/")
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}
