const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const FALLBACK_PHRASES = {
  en: {help: "Please help me."},
  it: {help: "Mi aiuti, per favore."},
  ar: {help: "من فضلك ساعدني."},
  zh: {help: "請幫助我。"}
};

function json(statusCode, body){
  return {statusCode, headers, body: JSON.stringify(body)};
}

function text(value){
  return String(value || "").trim();
}

function baseLanguage(code){
  return String(code || "").split("-")[0].toLowerCase();
}

function fallbackCandidates(requestedCode, requestedLanguage){
  const candidates = [{code: requestedCode || "en", language: requestedLanguage || requestedCode || "English", reason: ""}];
  if(baseLanguage(requestedCode) === "ti" || /^tigrinya$/i.test(requestedLanguage)){
    candidates.push({code: "ar", language: "Arabic", reason: "Tigrinya translation failed; showing Eritrea fallback support language"});
  }
  candidates.push({code: "en", language: "English", reason: "fallback language failed; showing English"});

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = baseLanguage(candidate.code || candidate.language);
    if(!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localFallback(code, phrases){
  const lang = baseLanguage(code);
  const fallback = FALLBACK_PHRASES[lang] || FALLBACK_PHRASES.en;
  const result = {};
  Object.keys(phrases || {help: ""}).forEach((key) => {
    result[key] = fallback[key] || fallback.help || "Please help me.";
  });
  return result;
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  let body;
  try{
    body = JSON.parse(event.body || "{}");
  }catch(error){
    return json(400, {error: "Invalid JSON body"});
  }

  const targetLanguageCode = text(body.targetLanguageCode);
  const targetLanguage = text(body.targetLanguage);
  const phrases = body.phrases && typeof body.phrases === "object" ? body.phrases : {help: text(body.help || "Please help me.")};
  const attempts = fallbackCandidates(targetLanguageCode, targetLanguage);
  const attemptErrors = [];

  if(process.env.OPENAI_API_KEY){
    for(const attempt of attempts){
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
              {
                role: "system",
                content: [
                  "Translate short emergency help phrases for travelers.",
                  "Return JSON only with a translations object using the same keys.",
                  "Do not add medical diagnosis or treatment advice.",
                  `Target language: ${attempt.language || attempt.code}. Target language code: ${attempt.code}.`
                ].join("\n")
              },
              {
                role: "user",
                content: JSON.stringify({phrases})
              }
            ]
          })
        });
        const data = await response.json().catch(() => ({}));
        if(!response.ok){
          attemptErrors.push({language: attempt.language || attempt.code, languageCode: attempt.code, message: data.error && data.error.message ? data.error.message : "OpenAI API request failed"});
          continue;
        }
        const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "{}";
        const parsed = JSON.parse(content || "{}");
        const translations = parsed.translations && typeof parsed.translations === "object" ? parsed.translations : parsed;
        const help = text(translations.help || Object.values(translations)[0]);
        if(help){
          const fallbackUsed = baseLanguage(attempt.code) !== baseLanguage(targetLanguageCode);
          return json(200, {
            translations,
            help,
            usedLanguage: attempt.language || attempt.code,
            usedLanguageCode: attempt.code,
            fallbackUsed,
            fallbackReason: fallbackUsed ? attempt.reason || "primary language failed" : "",
            attemptErrors
          });
        }
        attemptErrors.push({language: attempt.language || attempt.code, languageCode: attempt.code, message: "Empty translation result"});
      }catch(error){
        attemptErrors.push({language: attempt.language || attempt.code, languageCode: attempt.code, message: error && error.message ? error.message : "Unknown error"});
      }
    }
  }

  const fallbackCode = baseLanguage(targetLanguageCode) === "ti" ? "ar" : "en";
  const translations = localFallback(fallbackCode, phrases);
  return json(200, {
    translations,
    help: translations.help || Object.values(translations)[0] || "Please help me.",
    usedLanguage: fallbackCode === "ar" ? "Arabic" : "English",
    usedLanguageCode: fallbackCode,
    fallbackUsed: baseLanguage(fallbackCode) !== baseLanguage(targetLanguageCode),
    fallbackReason: "help phrase fallback used",
    attemptErrors
  });
};
