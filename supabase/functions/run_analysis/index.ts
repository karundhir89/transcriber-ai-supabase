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

const API_KEY = Deno.env.get("OPEN_API_SECRET");

if (!API_KEY) {
  throw new Error("API key not found in environment variables.");
}

// Utility functions
const timestampToSeconds = (timestamp) => {
  const [timeRange] = timestamp.split(" --> ");
  const [hours, minutes, seconds] = timeRange.split(',')[0].split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

const pick = (object, ...keys) => {
  return keys.reduce((acc, key) => {
    if (object.hasOwnProperty(key)) acc[key] = object[key];
    return acc;
  }, {});
};

const sanitizeJsonObject = (jsonObject) => {
  return Object.fromEntries(
    Object.entries(jsonObject).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.trim().replace(/"/g, '\\"') : value,
    ])
  );
};

const findFirstIDAfterThresholdSeconds = (transcript, secondsCutoff) => {
  for (const entry of transcript) {
    if (timestampToSeconds(entry.timestamp) > secondsCutoff) {
      return entry.id;
    }
  }
  return null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { file_name, call_type } = await req.json();

    // Fetching prompt from database
    const { data: runAnalysisPrompt, error: runAnalysisPromptError } = await supabase
      .from('General_prompts')
      .select("prompt_name, prompt")
      .eq('prompt_name', "RUN_ANALYSIS")
      .eq("Call_type", call_type);

    if (runAnalysisPromptError) {
      console.error("Error fetching prompt:", runAnalysisPromptError.message);
      return new Response(
        JSON.stringify({ status: false, error: runAnalysisPromptError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Fetching transcript from database
    const { data: transcriptData, error: transcriptError } = await supabase
      .from('Transcript2')
      .select("id, Voicelog_ID, Transcript")
      .eq('File_name', file_name);

    if (transcriptError) {
      console.error("Error fetching transcript:", transcriptError.message);
      return new Response(
        JSON.stringify({ status: false, error: transcriptError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    if (!transcriptData || transcriptData.length === 0) {
      return new Response(
        JSON.stringify({ status: false, error: "No transcript data found." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    const { Voicelog_ID: voicelogId, Transcript: transcript, id: TranscriptId } = transcriptData[0];

    // Fetching requirements from database
    const { data: requirements, error: reqError } = await supabase
      .from('Requirements')
      .select("*")
      .eq("Call_type", call_type);

    if (reqError) {
      console.error("Error fetching requirements:", reqError.message);
      return new Response(
        JSON.stringify({ status: false, error: reqError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Fetching existing records from database
    const { data: records, error: recordsError } = await supabase
      .from('Record')
      .select("*")
      .eq('File_name', file_name);

    if (recordsError) {
      console.error("Error fetching records:", recordsError.message);
      return new Response(
        JSON.stringify({ status: false, error: recordsError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    const total_score = [{ Score: 0, Completed_checks: 0, Niet_vooldan_score: 0 }];

    // Processing transcript on requirements
    for (const item of requirements) {
      let filteredResults = [];

      if (item['Slice type'].trim() === "Until second #") {
        const secondsCutoff = item['Seconds cutoff'];
        const timestampResult = findFirstIDAfterThresholdSeconds(transcript, secondsCutoff);

        filteredResults = transcript
          .filter(entry => entry.id <= timestampResult)
          .map(entry => ({
            ID: entry.id,
            Timestamp: entry.timestamp,
            Text: entry.value,
          }));

      } else if (item['Slice type'].trim() === "Pre-voicelog") {
        filteredResults = transcript
          .filter(entry => entry.id < voicelogId)
          .map(entry => ({
            ID: entry.id,
            Timestamp: entry.timestamp,
            Text: entry.value,
          }));

      } else {
        filteredResults = transcript
          .filter(entry => entry.id >= voicelogId)
          .map(entry => ({
            ID: entry.id,
            Timestamp: entry.timestamp,
            Text: entry.value,
          }));
      }

      const requirementSubset = JSON.stringify(pick(sanitizeJsonObject(item), "Type_Element", "Feitelijke_Tekst", "Comment"));
      const final_prompt = runAnalysisPrompt[0]['prompt'] + requirementSubset;

      const gptPrompts = [
        { role: "system", content: final_prompt },
        { role: "user", content: JSON.stringify(filteredResults) }
      ];

      try {
        const request = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: gptPrompts,
          }),
        });

        const response = await request.json();
        const jsonString = JSON.parse(response?.choices[0]?.message?.content);
        console.log("json => ", jsonString);

        const recordExists = records.some((temp) => temp["Type_element"] === item["Type_Element"]);
        console.log("recordExists => ",recordExists);
        const newRecord = {
          File_name: file_name,
          Type_element: jsonString["elementen"][0]["Type_Element"],
          Naleving: jsonString["elementen"][0]["Naleving"],
          Tijdstempel: jsonString["elementen"][0]["Tijdstempel"],
          Feitelijke_Tekst: jsonString["elementen"][0]["Feitelijke_Tekst"],
          Opmerking: jsonString["elementen"][0]["Opmerking"]
        };

        // Updating or inserting record in database
        if (recordExists) {
          const { error: updateError } = await supabase
            .from('Record')
            .update(newRecord)
            .eq("File_name", file_name)
            .eq("Type_element", item["Type_Element"]);
          if (updateError) {
            console.error("Error updating record:", updateError.message);
            return new Response(
              JSON.stringify({ status: false, error: updateError.message }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
            );
          }
        } else {
          const { error: insertError } = await supabase.from('Record').insert(newRecord);
          if (insertError) {
            console.error("Error inserting record:", insertError.message);
            return new Response(
              JSON.stringify({ status: false, error: insertError.message }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
            );
          }
        }

        // Updating total score
        if (jsonString["elementen"][0]["Naleving"] === "Naleving") {
          total_score[0].Score += 1;
          total_score[0].Completed_checks += 1;
        } else {
          total_score[0].Completed_checks += 1;
          total_score[0].Niet_vooldan_score += 1;
        }
      } catch (err) {
        console.error("Error in GPT analysis:", err.message || err);
      }
    }

    // Update the Transcript2 table with the values from total_score
    const { error: updateError } = await supabase
      .from('Transcript2')
      .update({
        Score: total_score[0].Score,
        Completed_checks: total_score[0].Completed_checks,
        Niet_vooldan_score: total_score[0].Niet_vooldan_score
      })
      .eq('id', TranscriptId);

    if (updateError) {
      console.error("Error updating Transcript2:", updateError.message);
      return new Response(
        JSON.stringify({ status: false, error: updateError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    return new Response(JSON.stringify(total_score), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("Unexpected error:", err.message || err);
    return new Response(
      JSON.stringify({ status: false, error: err.message || err }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});