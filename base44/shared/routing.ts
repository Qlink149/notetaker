// Routing: which transcription engine + params to use for a given language mix.
//
// Deepgram Nova-3 with the Hindi model (language=hi) is the best choice for
// Hindi/Gujarati/English code-switching meetings:
//   - Nova-3 has the best word-level timestamp precision (no whisper-1
//     timestamp hallucination on Indic audio).
//   - The hi model handles Hindi-English code-switching natively (per Deepgram:
//     "Hindi: Frequent English code switching... Nova-3 improves recognition
//     across Hinglish speech patterns").
//   - Gujarati (gu) is also a Nova-3 language; the hi model handles Gujarati
//     reasonably due to Indo-Aryan language family similarity.
//   - Processes the full file in a single URL-based request — no chunking,
//     no resumable processing, no 5-min timeout issues.
//   - Nova-3 Multilingual (multi) does NOT include Gujarati and misdetects
//     Hindi as Spanish, so we use the explicit hi model instead.
//
// The OpenAI (whisper-1) and Gemini engines remain as fallbacks via the
// benchmark tool — edit here in one place to change the production engine.

export interface RouteResult {
  engine: "deepgram" | "openai" | "gemini";
  params: { language?: string };
}

export function routeEngine(languageMode: string[] | null | undefined): RouteResult | null {
  return { engine: "deepgram", params: { language: "hi" } };
}