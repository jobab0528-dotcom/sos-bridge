const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(statusCode, body){
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function text(value){
  return String(value || "").trim();
}

function cleanPhrases(raw){
  if(!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cleaned = {};
  Object.keys(raw).slice(0, 40).forEach((key) => {
    const safeKey = text(key).replace(/[^\w-]/g, "");
    const value = text(raw[key]);
    if(safeKey && value) cleaned[safeKey] = value.slice(0, 500);
  });
  return cleaned;
}

function buildPrompt(){
  return [
    "You translate short Korean emergency travel help phrases for local people, medical staff, or pharmacists.",
    "Return valid JSON only. Do not include Markdown or explanations.",
    "Preserve the exact phrase keys. Do not merge, drop, rename, or move values between keys.",
    "Translate only the provided Korean phrases into the requested target language.",
    "Do not add medical conclusions, severity, medicine ingredients, disease names, or extra action advice.",
    "Keep the wording simple, direct, polite, and easy to show on a phone screen.",
    "Required response shape: {\"translations\":{\"key\":\"translated phrase\"}}."
  ].join("\n");
}

function normalizeTranslations(parsed, keys){
  const source = parsed && (parsed.translations || parsed.phrases || parsed);
  const translations = {};
  keys.forEach((key) => {
    const value = text(source && source[key]);
    if(value) translations[key] = value;
  });
  return translations;
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  if(!process.env.OPENAI_API_KEY){
    return json(500, {error: "OPENAI_API_KEY is not configured"});
  }

  let payload;
  try{
    payload = JSON.parse(event.body || "{}");
  }catch(error){
    return json(400, {error: "Invalid JSON body"});
  }

  const targetLanguage = text(payload.targetLanguage);
  const targetLanguageCode = text(payload.targetLanguageCode);
  const travelCountry = text(payload.travelCountry);
  const phrases = cleanPhrases(payload.phrases);
  const keys = Object.keys(phrases);

  if(!keys.length){
    return json(400, {error: "phrases are required"});
  }

  if(!targetLanguage && !targetLanguageCode){
    return json(400, {error: "target language is required"});
  }

  try{
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: {type: "json_object"},
        messages: [
          {role: "system", content: buildPrompt()},
          {
            role: "user",
            content: JSON.stringify({
              targetLanguage,
              targetLanguageCode,
              travelCountry,
              phrases
            })
          }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));

    if(!response.ok){
      return json(response.status >= 500 ? 502 : response.status, {
        error: "Help phrase translation failed",
        detail: data.error && data.error.message ? data.error.message : "OpenAI API request failed"
      });
    }

    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "{}";
    const parsed = JSON.parse(content || "{}");
    const translations = normalizeTranslations(parsed, keys);

    if(keys.some((key) => !translations[key])){
      return json(502, {error: "Help phrase translation failed", detail: "Missing translated phrase"});
    }

    return json(200, {translations});
  }catch(error){
    return json(502, {
      error: "Help phrase translation failed",
      detail: error && error.message ? error.message : "Unknown error"
    });
  }
};
