"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
  Loader2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { updateUserSchema, type UpdateUserValues } from "@/lib/schemas/user"
import { deleteUser, updateUser } from "@/app/(dashboard)/users/actions"
import type { UserRow } from "@/components/user-columns"

export function UserRowActions({ user }: { user: UserRow }) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const displayName = user.full_name ?? user.email

  const form = useForm<UpdateUserValues>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      id: user.id,
      fullName: user.full_name ?? "",
      email: user.email,
      password: "",
    },
  })

  function resetEdit() {
    form.reset({
      id: user.id,
      fullName: user.full_name ?? "",
      email: user.email,
      password: "",
    })
    setServerError(null)
  }

  function onEdit(values: UpdateUserValues) {
    setServerError(null)
    startTransition(async () => {
      const result = await updateUser(values)
      if (result.error) {
        setServerError(result.error)
        return
      }
      setEditOpen(false)
      router.refresh()
    })
  }

  function handleDelete() {
    setServerError(null)
    startTransition(async () => {
      const result = await deleteUser(user.id)
      if (result.error) {
        setServerError(result.error)
        return
      }
      setDeleteOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              <TrashIcon data-icon="inline-start" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v)
          if (!v) resetEdit()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update account details for {displayName}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onEdit)}>
            <FieldGroup>
              <Controller
                name="fullName"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`edit-name-${user.id}`}>
                      Full name
                    </FieldLabel>
                    <Input
                      {...field}
                      id={`edit-name-${user.id}`}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
              <Controller
                name="email"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`edit-email-${user.id}`}>
                      Email
                    </FieldLabel>
                    <Input
                      {...field}
                      id={`edit-email-${user.id}`}
                      type="email"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
              <Controller
                name="password"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`edit-password-${user.id}`}>
                      New Password
                    </FieldLabel>
                    <PasswordInput
                      {...field}
                      id={`edit-password-${user.id}`}
                      placeholder="Leave blank to keep current"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
            </FieldGroup>
            {serverError ? (
              <p className="mt-3 text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter className="mt-4">
              <Button
                variant="outline"
                type="button"
                onClick={() => setEditOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" className="w-32" disabled={isPending}>
                {isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  "Save Changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(v) => {
          setDeleteOpen(v)
          if (!v) setServerError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {displayName}? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {serverError ? (
            <p className="text-sm text-destructive">{serverError}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
              disabled={isPending}
            >
              {isPending ? <Loader2Icon className="animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
