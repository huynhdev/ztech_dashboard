import { getUploads } from "@/lib/data"
import { DataTable } from "@/components/data-table"
import { uploadColumns } from "@/components/upload-columns"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { UploadDialog } from "@/components/upload-dialog"

export default async function UploadPage() {
  const uploads = await getUploads()

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload History</CardTitle>
          <CardDescription>
            Excel files uploaded to the system. {uploads.length} total uploads.
          </CardDescription>
          <CardAction>
            <UploadDialog />
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={uploadColumns} data={uploads} />
        </CardContent>
      </Card>
    </main>
  )
}
