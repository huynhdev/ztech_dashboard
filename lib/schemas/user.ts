import { z } from "zod"

export const createUserSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  email: z
    .string()
    .min(1, "Email is required")
    .email("Please enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

export const updateUserSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().min(1, "Full name is required"),
  email: z
    .string()
    .min(1, "Email is required")
    .email("Please enter a valid email"),
  // Empty string means "keep the current password".
  password: z
    .union([
      z.string().min(8, "Password must be at least 8 characters"),
      z.literal(""),
    ])
    .optional(),
})

export type CreateUserValues = z.infer<typeof createUserSchema>
export type UpdateUserValues = z.infer<typeof updateUserSchema>
