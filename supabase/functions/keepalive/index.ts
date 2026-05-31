import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_KEY = "ztech-keepalive-2026";

Deno.serve(async (req: Request) => {
  // Verify API key
  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      secretKeys["default"]
    );

    const { data, error } = await supabase
      .from("keepalive")
      .upsert({ id: 1, pinged_at: new Date().toISOString() })
      .select("pinged_at")
      .single();

    if (error) {
      console.error("Keepalive upsert failed:", error.message);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, pinged_at: data.pinged_at }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Keepalive unexpected error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
