import { getUsers } from "@/lib/data"
import { DataTable } from "@/components/data-table"
import { userColumns } from "@/components/user-columns"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AddUserDialog } from "@/components/add-user-dialog"

export default function UsersPage() {
  const users = getUsers()

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Manage system users. {users.length} total users.
          </CardDescription>
          <CardAction>
            <AddUserDialog />
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={userColumns} data={users} />
        </CardContent>
      </Card>
    </main>
  )
}
