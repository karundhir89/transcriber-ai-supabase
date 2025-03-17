import "jsr:@supabase/functions-js/edge-runtime.d.ts";
//import { createClient } from "@supabase/supabase-js";
import { createClient } from 'jsr:@supabase/supabase-js@2'


const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const supabase = createClient(
  SUPABASE_URL,SUPABASE_ANON_KEY,
);

// API endpoints
const transcribe_and_split = SUPABASE_URL + "/functions/v1/split_transcribe";
const restructure_transcript = SUPABASE_URL + "/functions/v1/restructure_transcript";
const find_voicelog = SUPABASE_URL + "/functions/v1/find_voicelog";
const run_analysis = SUPABASE_URL + "/functions/v1/run_analysis";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control",
};

// Helper function to handle API calls
async function callApi(url: string, body: Record<string, any>) {
  try {
    console.log("Request to URL =>", url);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Attempt to parse the response as JSON
    let responseBody;
    try {
      responseBody = await response.json();
    } catch (jsonError) {
      throw new Error(`Failed to parse response JSON: ${jsonError}`);
    }

    if (!response.ok) {
      // Log and throw an error with details from the response
      console.error("API request failed:", responseBody);
      const errorDetails = responseBody?.details || "No additional details available.";
      throw new Error(
        `API request failed: ${response.status} - ${response.statusText}. Details: ${errorDetails}`
      );
    }

    return responseBody;
  } catch (error) {
    console.error("API Error:", error);
    throw error; // Re-throw the error to propagate it back to the caller
  }
}

// Function to update the Errors array in the database
async function logErrorToDatabase(file_name: string, errorMessage: string) {
  try {
    // Fetch the current errors array
    const { data, error: fetchError } = await supabase
      .from("Transcript2")
      .select("Errors")
      .eq("File_name", file_name)
      .single();

    if (fetchError) {
      console.error("Error fetching existing errors:", fetchError);
      throw new Error("Could not fetch existing errors.");
    }

    // Append the new error message to the existing array or create a new array
    const updatedErrors = Array.isArray(data?.Errors) ? [...data.Errors, errorMessage] : [errorMessage];

    // Update the table with the new errors array
    const { error: updateError } = await supabase
      .from("Transcript2")
      .update({ Errors: updatedErrors })
      .eq("File_name", file_name);

    if (updateError) {
      console.error("Error updating Errors array:", updateError);
      throw new Error("Could not update Errors array.");
    }

    console.log("Error logged to database successfully.");
  } catch (err) {
    console.error("Failed to log error to database:", err);
  }
}

// Function to save initial request details with unique file_name constraint
async function saveInitialRequest(file_name: string, call_type: string, agent: string, url: string) {

  try {
    const { data, error } = await supabase
      .from("Transcript2")
      .upsert(
          {
            File_name: file_name,
            URL: url,
            Call_type: call_type,
            Agent: agent,
            Errors: [], // Initialize an empty Errors array
          },
        { onConflict: "File_name" } // Ensure File_name is unique
      ).select();

    if (error) {
      console.error("Error saving initial request:", error);
      throw new Error("Failed to save initial request data.");
    }

    console.log("Initial request saved successfully.", file_name, data);
  } catch (err) {
    console.error("Failed to save initial request:", err);
    throw err; // Re-throw to stop further processing if saving fails
  }
}

// Function to process the request
async function processRequest(reqBody: any) {
  let { url, file_name, call_type, agent, language } = reqBody;

  if (!url || !file_name || !agent) {
    throw new Error("Missing required fields: 'url', 'file_name', or 'agent'.");
  }

  call_type = call_type || "Regular";
  language = language ?? true;

  // Save initial request details
  await saveInitialRequest(file_name, call_type, agent, url);

  let transcript = [];
  let voice_log = null;

  try {
    const transcribe_and_split_res = await callApi(transcribe_and_split, { URL: url, language: language, call_type: call_type });
    console.log("Transcribe and Split Response =>", file_name, transcribe_and_split_res);
    transcript = transcribe_and_split_res.transcription;

    const restructure_transcript_res = await callApi(restructure_transcript, { transcript, call_type, file_name });
    console.log("Restructure Transcript Response =>", file_name, restructure_transcript_res);
    // transcript = restructure_transcript_res.transcript;

    const find_voicelog_res = await callApi(find_voicelog, { file_name, call_type });
    console.log("Find Voicelog Response =>", file_name, find_voicelog_res);
    voice_log = find_voicelog_res.voiceLogs[0]?.ID;

    // Coerce voice_log to an integer if possible
    if (typeof voice_log === "string" && !isNaN(voice_log)) {
      voice_log = Number(voice_log);
    }

    // Validate voice_log
    if (!Number.isInteger(voice_log)) {
      console.log("Invalid voice_log, setting to null.", file_name);
      voice_log = null;
    }

    // Log error if voice_log is null
    if (voice_log === null) {
      const voicelog_response = find_voicelog_res.voicelog_response;
      logErrorToDatabase(file_name, voicelog_response);
    }

    // Update database with transcript and voice log
    const { error: updateError } = await supabase
      .from("Transcript2")
      .update({
        // Transcript: transcript,
        Voicelog_ID: voice_log,
      })
      .eq("File_name", file_name);

    if (updateError) {
      console.error("Database Update Error:", file_name, updateError);
      throw new Error(updateError.message || "Database update failed.");
    }

    const run_analysis_res = await callApi(run_analysis, { file_name, call_type });
    console.log("Run Analysis Response =>", file_name, run_analysis_res);

    return { completed_checks: run_analysis_res, transcript };
  } catch (error) {
    console.error("Processing Error:", file_name, error);
    // Log the error to the database
    await logErrorToDatabase(file_name, error.message || "An unexpected error occurred.");
    throw new Error(error.message || "An unexpected error occurred during processing.");
  }
}

// Deno server implementation
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { weweb, ...reqBody } = await req.json();

    if (weweb) {
      // Handle background processing
      processRequest(reqBody).catch((error) => console.error("Background process error:", error));
      return new Response(
        JSON.stringify({ status: true, message: "Request received, processing in background" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle synchronous processing
    const result = await processRequest(reqBody);
    return new Response(
      JSON.stringify({ status: true, message: "Process completed successfully", ...result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error during process:", error);
    return new Response(
      JSON.stringify({
        status: false,
        error: error.message || "An unexpected error occurred.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});