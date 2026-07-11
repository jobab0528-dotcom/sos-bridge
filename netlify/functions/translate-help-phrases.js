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

function baseLanguage(code){
  return text(code).split("-")[0].toLowerCase();
}

function addAttempt(attempts, languageName, languageCode, reason, fallbackUsed){
  const name = text(languageName);
  const code = text(languageCode);
  if(!name && !code) return;
  const normalizedName = name.toLowerCase();
  const normalizedCode = code.toLowerCase();
  if(attempts.some((item) => item.languageName.toLowerCase() === normalizedName && item.languageCode.toLowerCase() === normalizedCode && item.reason === reason)) return;
  attempts.push({
    languageName: name || code,
    languageCode: code || name,
    reason,
    fallbackUsed: Boolean(fallbackUsed)
  });
}

function fallbackReasonFor(languageName, languageCode){
  const label = text(languageName) || text(languageCode) || "Primary language";
  return `${label} translation failed or returned incomplete fields`;
}

function buildTranslationAttempts(payload, targetLanguage, targetLanguageCode){
  const selectedCountry = payload.selectedCountry && typeof payload.selectedCountry === "object" ? payload.selectedCountry : {};
  const attempts = [];
  const primaryFallbackReason = fallbackReasonFor(targetLanguage, targetLanguageCode);
  addAttempt(attempts, targetLanguage, targetLanguageCode, "Primary language translation", false);
  addAttempt(attempts, targetLanguage, targetLanguageCode, "Primary language retry", false);
  addAttempt(
    attempts,
    payload.fallbackLanguageNameEn || selectedCountry.fallbackLanguageNameEn,
    payload.fallbackLanguageCode || selectedCountry.fallbackLanguageCode,
    primaryFallbackReason,
    true
  );
  if(baseLanguage(targetLanguageCode) === "fil"){
    addAttempt(attempts, "Tagalog", "tl", "Filipino translation failed", true);
  }
  if(!attempts.some((item) => baseLanguage(item.languageCode) === "en")){
    addAttempt(attempts, "English", "en", primaryFallbackReason, true);
  }
  return attempts;
}

function localEnglishPhrase(key, value){
  const normalizedKey = text(key).toLowerCase();
  const normalizedValue = text(value);
  const known = {
    help: "Please help me.",
    hospital: "Please take me to a hospital.",
    pharmacy: "I need a pharmacy.",
    emergency: "This is an emergency.",
    pain: "I am in pain.",
    allergy: "I have an allergy.",
    medicine: "I am taking medication."
  };
  return known[normalizedKey] || normalizedValue || "Please help me.";
}

function buildLocalFallback(phrases, keys, reason){
  const translations = {};
  keys.forEach((key) => {
    translations[key] = localEnglishPhrase(key, phrases[key]);
  });
  return {
    translations,
    language: "English",
    languageCode: "en",
    usedLanguage: "English",
    usedLanguageCode: "en",
    fallbackUsed: true,
    fallbackReason: reason || "All translation attempts failed",
    attempts: ["Local English fallback"]
  };
}

function buildKoreanPassthrough(phrases){
  return {
    translations: {...phrases},
    language: "Korean",
    languageCode: "ko",
    usedLanguage: "Korean",
    usedLanguageCode: "ko",
    fallbackUsed: false,
    fallbackReason: "",
    attempts: ["Korean source passthrough"]
  };
}

async function translateOnce({attempt, travelCountry, phrases, keys}){
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
            targetLanguage: attempt.languageName,
            targetLanguageCode: attempt.languageCode,
            travelCountry,
            phrases
          })
        }
      ]
    })
  });

  const data = await response.json().catch(() => ({}));

  if(!response.ok){
    throw new Error(data.error && data.error.message ? data.error.message : "OpenAI API request failed");
  }

  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "{}";
  const parsed = JSON.parse(content || "{}");
  const translations = normalizeTranslations(parsed, keys);

  if(keys.some((key) => !translations[key])){
    throw new Error("Missing translated phrase");
  }

  return {
    translations,
    language: attempt.languageName,
    languageCode: attempt.languageCode,
    usedLanguage: attempt.languageName,
    usedLanguageCode: attempt.languageCode,
    fallbackUsed: attempt.fallbackUsed,
    fallbackReason: attempt.fallbackUsed ? attempt.reason : ""
  };
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
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

  if(baseLanguage(targetLanguageCode) === "ko"){
    return json(200, buildKoreanPassthrough(phrases));
  }

  if(!process.env.OPENAI_API_KEY){
    return json(500, {error: "OPENAI_API_KEY is not configured"});
  }

  const attempts = buildTranslationAttempts(payload, targetLanguage, targetLanguageCode);
  const attemptErrors = [];

  for(const attempt of attempts){
    try{
      const result = await translateOnce({attempt, travelCountry, phrases, keys});
      result.attempts = attempts.slice(0, attempts.indexOf(attempt) + 1).map((item) => item.reason);
      if(attemptErrors.length) result.fallbackReason = result.fallbackReason || attemptErrors[attemptErrors.length - 1].message;
      if(attemptErrors.length) result.attemptErrors = attemptErrors;
      return json(200, result);
    }catch(error){
      attemptErrors.push({
        language: attempt.languageName,
        languageCode: attempt.languageCode,
        reason: attempt.reason,
        message: error && error.message ? error.message : "Unknown error"
      });
    }
  }

  return json(200, {
    ...buildLocalFallback(phrases, keys, fallbackReasonFor(targetLanguage, targetLanguageCode)),
    attemptErrors
  });
};
