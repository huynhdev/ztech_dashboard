"use server"

import { revalidatePath } from "next/cache"

import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdmin } from "@/lib/supabase/auth"
import {
  createUserSchema,
  updateUserSchema,
  type CreateUserValues,
  type UpdateUserValues,
} from "@/lib/schemas/user"

export type UserActionState = {
  error?: string
}

export async function createUser(
  data: CreateUserValues
): Promise<UserActionState> {
  await requireAdmin()

  const parsed = createUserSchema.safeParse(data)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid form data" }
  }

  const admin = createAdminClient()
  // The handle_new_user trigger copies full_name from user_metadata into the
  // profiles row, so no follow-up profile insert is needed here.
  const { error } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { full_name: parsed.data.fullName },
  })

  if (error) {
    return { error: error.message }
  }

  revalidatePath("/users")
  return {}
}

export async function updateUser(
  data: UpdateUserValues
): Promise<UserActionState> {
  await requireAdmin()

  const parsed = updateUserSchema.safeParse(data)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid form data" }
  }

  const admin = createAdminClient()

  const attributes: { email: string; password?: string } = {
    email: parsed.data.email,
  }
  if (parsed.data.password) {
    attributes.password = parsed.data.password
  }

  const { error: authError } = await admin.auth.admin.updateUserById(
    parsed.data.id,
    attributes
  )
  if (authError) {
    return { error: authError.message }
  }

  // No update trigger exists on profiles, so sync the editable columns here.
  const { error: profileError } = await admin
    .from("profiles")
    .update({ full_name: parsed.data.fullName, email: parsed.data.email })
    .eq("id", parsed.data.id)
  if (profileError) {
    return { error: profileError.message }
  }

  revalidatePath("/users")
  return {}
}

export async function deleteUser(id: string): Promise<UserActionState> {
  await requireAdmin()

  const admin = createAdminClient()
  // Deleting the auth user cascades to the profiles row (ON DELETE CASCADE).
  const { error } = await admin.auth.admin.deleteUser(id)
  if (error) {
    return { error: error.message }
  }

  revalidatePath("/users")
  return {}
}
