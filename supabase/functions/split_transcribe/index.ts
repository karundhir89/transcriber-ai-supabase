import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// import { createClient } from "@supabase/supabase-js";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const supabase = createClient(
  SUPABASE_URL,SUPABASE_ANON_KEY,
);


export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control",
};

Deno.serve(async (req) => {
  try {
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    
    // Parse request JSON
    const params = await req.json();
    const url = params["URL"];
    const language = params["language"];
    const call_type = params["call_type"];
    if (!url) {
      return new Response(
        JSON.stringify({ error: "URL parameter is required" }),
        { headers: corsHeaders, status: 400 }
      );
    }
    if (language === null) {
      return new Response(
        JSON.stringify({ error: "language parameter is required" }),
        { headers: corsHeaders, status: 400 }
      );
    }

    if (call_type === null) {
      return new Response(
        JSON.stringify({ error: "call type parameter is required" }),
        { headers: corsHeaders, status: 400 }
      );
    }

    // Fetch prompt from database
    const { data: splitTranscribePrompt, error: splitTranscribePromptError } = await supabase
      .from("General_prompts")
      .select("prompt_name, prompt")
      .eq("prompt_name", "AUDIO_TRANSCRIBE")
      .eq("Call_type", call_type);

    if (splitTranscribePromptError) {
      console.error("Error fetching prompt:", splitTranscribePromptError);
      return new Response(
        JSON.stringify({ error: splitTranscribePromptError.message || "Database error" }),
        { headers: corsHeaders, status: 500 }
      );
    }

    if (!splitTranscribePrompt || splitTranscribePrompt.length === 0) {
      return new Response(
        JSON.stringify({ error: "Prompt not found in the database" }),
        { headers: corsHeaders, status: 404 }
      );
    }

    const prompt = splitTranscribePrompt[0]["prompt"];

    // Make the GET request to the specified API URL
    const apiUrl = Deno.env.get("MP3_CUT_LAMBDA_URL");

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, prompt, language }),
    });

    let data = await response.json();

    if (!response.ok) {
      console.error("API request failed:", data);

      console.log("going to call mp3 cutter .........")
      // Make the GET request to the mp3cutter API URL
      const mp3cutapiUrl = Deno.env.get("LAMBDA_URL");

      const mp3cutresponse = await fetch(mp3cutapiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, prompt, language }),
      });

      const mp3cutdata = await mp3cutresponse.json();
      data = mp3cutdata;
      if (!mp3cutresponse.ok) {
        return new Response(
          JSON.stringify({
            error: `mp3cutresponse API request failed with status: ${mp3cutresponse.status}`,
            details: mp3cutdata.error || "Unknown error",
          }),
          { headers: corsHeaders, status: mp3cutresponse.status }
        );
      }
    }

    // Return the response data
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({
        error: error.message || "An unexpected error occurred",
        details: error.stack || null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});


/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/split_transcribe' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
