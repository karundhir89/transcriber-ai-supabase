import "jsr:@supabase/functions-js/edge-runtime.d.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { URL } = await req.json();
  const API_KEY = Deno.env.get("OPEN_API_SECRET");

  // Helper function to create a delay for the specified time in milliseconds
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Async function to handle transcription using fetch API
  const handleTranscription = async () => {
    try {
      // Log the starting of the fetch process
      console.log("Starting to fetch audio from URL:", URL);

      // Fetch the audio file from the provided URL
      const response = await fetch(URL);

      if (!response.ok) {
        throw new Error(`Failed to fetch audio file: ${response.statusText}`);
      }

      // Convert fetched audio to a Blob
      const audioBlob = await response.blob();
      const audioFile = new File([audioBlob], "audio.wav", {
        type: "audio/wav",
      });

      // Initialize Form Data
      const formData = new FormData();
      formData.append("file", audioFile);
      formData.append("model", "whisper-1");
      formData.append("response_format", "srt");

      // Log the starting of the API call to OpenAI
      console.log("Starting API call to OpenAI with the fetched audio file.");

      // Make API call to OpenAI
      const openaiResponse = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
          },
          body: formData,
        }
      );

      if (!openaiResponse.ok) {
        const errorText = await openaiResponse.text();
        throw new Error(
          `OpenAI API response was not ok: ${openaiResponse.status} ${openaiResponse.statusText} - ${errorText}`
        );
      }

      // Wait for sufficient time to ensure the function catches the incoming file
      await delay(5000); // Waiting for 5 seconds

      // Get the SRT text response
      const srtText = await openaiResponse.text();

      // Split the SRT text into an array (each line as a separate entry)
      const srtArray = srtText.split("\n");

      // Log the successful transcription
      console.log("Transcription successful:");

      // Store the SRT array in the global variable 'Generated transcript (WeWeb)'
      // variables["03ac61ab-0edc-43d4-ae39-88e38e630410"] = srtArray;

      // Return the SRT array
      return srtArray;
    } catch (error) {
      // Enhanced error logging
      console.error("Error during transcription:", error.message);
      console.error("Stack Trace:", error.stack);
      console.error("Full Error Object:", error);
      return null;
    }
  };

  // Invoke the function to process the transcription and log the result
  const transcript = await handleTranscription();
  if (transcript === null) {
    return new Response(JSON.stringify({ status: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }

  return new Response(JSON.stringify({ status: true, transcript }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
