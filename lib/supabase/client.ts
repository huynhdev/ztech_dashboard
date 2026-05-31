import { createBrowserClient } from "@supabase/ssr"

export function createClient() {
  const client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      realtime: {
        // The socket can drop silently (e.g. background-tab heartbeat throttling) and
        // stop delivering postgres_changes with no error. When a heartbeat reports the
        // connection lost, force a reconnect so subscriptions resume. Per-channel
        // resubscribe + a polling fallback live in upload-dialog.tsx for the upload flow.
        heartbeatCallback: (status) => {
          if (status === "disconnected" || status === "timeout") {
            client.realtime.connect()
          }
        },
      },
    }
  )
  return client
}
