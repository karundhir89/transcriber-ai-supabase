import "jsr:@supabase/functions-js/edge-runtime.d.ts";
//import { createClient } from "@supabase/supabase-js";
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control",
};

// Split parsed entries into batches of 10
const splitBatches = (parsedEntries: { id: number; timestamp: string; value: string }[]) => {
  const batches = [];
  for (let i = 0; i < parsedEntries.length; i += 10) {
    batches.push(parsedEntries.slice(i, i + 10));
  }
  return batches;
};

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

// Identify speakers with GPT-4
const identifySpeakers = async (batch: any[], API_KEY: string, prompt: string): Promise<any[]> => {
  let retries = 3; // Number of retries allowed
  while (retries > 0) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: `${prompt}\n${JSON.stringify(batch)}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GPT-4 API error: ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();
      const content = result.choices[0]?.message?.content;

      // Ensure the content is valid JSON
      try {
        return JSON.parse(content);
      } catch (jsonError) {
        console.error("Invalid JSON format in GPT response:", content);

        // Attempt to clean up the response
        const cleanedContent = content.replace(/```json|```/g, "").trim();
        try {
          return JSON.parse(cleanedContent);
        } catch (cleanedJsonError) {
          console.error("Failed to clean up GPT response:", cleanedContent);
          throw new Error(`Invalid JSON even after cleaning: ${cleanedJsonError.message}`);
        }
      }
    } catch (error) {
      console.error("Error during identifySpeakers:", error.message || error);
      retries--;

      if (retries === 0) {
        throw new Error(
          `Failed after multiple retries for batch: ${JSON.stringify(batch)}. Error: ${error.message}`
        );
      }

      console.log(`Retrying identifySpeakers... Attempts left: ${retries}`);
    }
  }
  return [];
};



// Main function for transcription and speaker identification
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Fetch prompt from the database
  const { transcript, call_type, file_name } = await req.json();

  if (!file_name || file_name == "") {
    return new Response(
      JSON.stringify({ status: false, error: "File name is missing or empty." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }

  if (!transcript || transcript.length === 0) {
    return new Response(
      JSON.stringify({ status: false, error: "Transcript data is missing or empty." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }

  if (!call_type || call_type == "") {
    return new Response(
      JSON.stringify({ status: false, error: "Call type is missing or empty." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }

  try {
    const { data: restructurePrompt, error: restructurePromptError } = await supabase
      .from('General_prompts')
      .select("prompt_name, prompt")
      .eq('prompt_name', "RESTRUCTURE_TRANSCRIPT")
      .eq('Call_type', call_type);

    if (restructurePromptError) {
      console.error("Database Error:", restructurePromptError.message);
      return new Response(
        JSON.stringify({ status: false, error: restructurePromptError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    if (!restructurePrompt || restructurePrompt.length === 0) {
      return new Response(
        JSON.stringify({ status: false, error: "Prompt for 'RESTRUCTURE_TRANSCRIPT' not found." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    const prompt = restructurePrompt[0]["prompt"];
    console.log("Prompt:", prompt);

    const API_KEY = Deno.env.get("OPEN_API_SECRET");
    if (!API_KEY) {
      return new Response(
        JSON.stringify({ status: false, error: "API_KEY is missing." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Split the transcript into batches
    const batches = splitBatches(transcript);
    console.log("batches ::", batches.length);
    
    // Process each batch concurrently with retry mechanism
    const speakerPromises = batches.map(async (batch) => {
      try {
        return await identifySpeakers(batch, API_KEY, prompt);
      } catch (error) {
        console.error("Error in batch processing:", error.message || error);
        throw error;
      }
    });

    console.log("speakerPromises ::", speakerPromises);

    // Wait for all promises to resolve
    const speakerResults = await Promise.all(speakerPromises);
    console.log("speakerResults ::", speakerResults);
    // Extract and flatten transcripts
    const speakerJson = speakerResults.map(item => item.transcript).flat();
    console.log("Speaker JSON:", speakerJson);
    
    // Update database with transcript and voice log
    const { error: updateError } = await supabase
      .from("Transcript2")
      .update({
        Transcript: speakerJson,
      })
      .eq("File_name", file_name);
    

    if (updateError) {
      console.error("Database Update Error:", file_name, updateError);
      throw new Error(updateError.message || "Database update failed.");
    }

    // Return the final combined response
    return new Response(
      JSON.stringify({ status: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } , status: 200}
    );
  } catch (error) {
    console.error("Error during processing:", error.message || error);

    // Log the error to the database
    await logErrorToDatabase(file_name, error.message || "An unexpected error occurred.");

    // Return error details directly from caught error
    return new Response(
      JSON.stringify({ status: false, error: error.message || "An unexpected error occurred." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
