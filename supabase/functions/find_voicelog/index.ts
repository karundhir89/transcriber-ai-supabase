// Setup type definitions and imports
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
//import { createClient } from "@supabase/supabase-js";
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const API_KEY = Deno.env.get("OPEN_API_SECRET");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { file_name, call_type } = await req.json();

  if (!file_name || file_name == "") {
    return new Response(
      JSON.stringify({ status: false, error: "File name is missing or empty." }),
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

    // Fetch Transcript from the database
    let { data: transcript, error: transcriptError } = await supabase
      .from("Transcript2")
      .select("Transcript")
      .eq("File_name", file_name);

    if (transcriptError) {
      console.error("Database Error:", transcriptError.message);
      return new Response(
        JSON.stringify({ status: false, error: transcriptError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    if (!transcript || transcript.length === 0) {
      return new Response(
        JSON.stringify({ status: false, error: "No transcript found for 'file_name' : "+file_name }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }
    
    // Fetch prompt from the database
    const { data: findVoicelogPrompt, error: findVoicelogPromptError } = await supabase
      .from("General_prompts")
      .select("prompt_name, prompt")
      .eq("prompt_name", "FIND_VOICELOGS")
      .eq("Call_type", call_type);


    if (findVoicelogPromptError) {
      console.error("Database Error:", findVoicelogPromptError.message);
      return new Response(
        JSON.stringify({ status: false, error: findVoicelogPromptError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    if (!findVoicelogPrompt || findVoicelogPrompt.length === 0) {
      return new Response(
        JSON.stringify({ status: false, error: "No prompt found for 'FIND_VOICELOGS'." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    const prompt = findVoicelogPrompt[0]["prompt"];

    transcript = transcript[0]["Transcript"];

    const chatGptPrompts = [
      {
        role: "user",
        content: prompt + JSON.stringify(transcript),
      },
    ];

    console.log("GPT prompt for find voicelog :-", chatGptPrompts);

    // Fetch response from OpenAI API
    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },  
        messages: chatGptPrompts,
      }),
    });

    if (!openAiResponse.ok) {
      const errorText = await openAiResponse.text();
      console.error("OpenAI API Error:", errorText);
      return new Response(
        JSON.stringify({
          status: false,
          error: `OpenAI API Error: ${openAiResponse.status} ${openAiResponse.statusText} - ${errorText}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    const responseData = await openAiResponse.json();
    console.log("GPT response for find voicelog :-", responseData);

    const content = JSON.parse(responseData?.["choices"]?.[0]?.["message"]?.["content"] ?? "[]");
    console.log("content => ",content);
    const contentArray = Array.isArray(content) ? content : [content];
    const flatContentArray = contentArray.flatMap((obj) => obj.result || []);

    const filteredResults = flatContentArray.filter(
      (obj) =>
        obj.hasOwnProperty("ID") &&
        obj.hasOwnProperty("Voicelog_gevonden") &&
        obj.hasOwnProperty("Rationale")
    );

    return new Response(
      JSON.stringify({ status: true, voiceLogs: filteredResults, voicelog_response: responseData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected Error:", error.message || error);
    return new Response(
      JSON.stringify({ status: false, error: error.message || "An unexpected error occurred." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});