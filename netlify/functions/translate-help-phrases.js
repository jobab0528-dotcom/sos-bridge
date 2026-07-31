const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const RESPONSE_VERSION = "help-phrases-v2";
const SOURCE_LANGUAGE_CODE = "ko";
const HELP_PHRASE_KEYS = [
  "accident", "allergy", "ambulance", "dosage", "fever", "help", "hospital",
  "medication", "pain", "pharmacy", "pharmacyQ", "prescription", "stabbed", "stomach"
];
const HELP_PHRASE_KEY_SET = new Set(HELP_PHRASE_KEYS);
const PRESCRIPTION_SOURCE_KO = "처방전이 필요합니다.";
const PRESCRIPTION_STATEMENTS = {
  ar:"أحتاج إلى وصفة طبية.", bg:"Нуждая се от рецепта.", cs:"Potřebuji lékařský předpis.", da:"Jeg har brug for en recept.",
  de:"Ich brauche ein Rezept.", el:"Χρειάζομαι συνταγή.", en:"I need a prescription.", es:"Necesito una receta médica.",
  et:"Mul on vaja retsepti.", fi:"Tarvitsen reseptin.", fil:"Kailangan ko ng reseta.", tl:"Kailangan ko ng reseta.",
  fr:"J'ai besoin d'une ordonnance.", he:"אני זקוק/ה למרשם רפואי.", hi:"मुझे डॉक्टर की पर्ची चाहिए।", hr:"Trebam recept.",
  hu:"Receptre van szükségem.", id:"Saya memerlukan resep.", is:"Ég þarf lyfseðil.", it:"Ho bisogno di una prescrizione medica.",
  ja:"処方箋が必要です。", km:"ខ្ញុំត្រូវការវេជ្ជបញ្ជា។", ko:PRESCRIPTION_SOURCE_KO, lo:"ຂ້ອຍຕ້ອງການໃບສັ່ງຢາ.",
  lt:"Man reikia recepto.", lv:"Man ir nepieciešama recepte.", ms:"Saya memerlukan preskripsi.", mt:"Għandi bżonn riċetta tat-tabib.",
  my:"ဆရာဝန်ဆေးညွှန်း လိုအပ်ပါတယ်။", nl:"Ik heb een recept nodig.", no:"Jeg trenger resept.", pl:"Potrzebuję recepty.",
  pt:"Preciso de uma receita médica.", "pt-br":"Preciso de uma receita médica.", ro:"Am nevoie de o rețetă.", si:"මට වෛද්‍ය වට්ටෝරුවක් අවශ්‍යයි.",
  sk:"Potrebujem lekársky predpis.", sl:"Potrebujem recept.", sv:"Jag behöver ett recept.", th:"ฉันต้องการใบสั่งยา",
  tr:"Reçeteye ihtiyacım var.", vi:"Tôi cần đơn thuốc.", zh:"我需要处方。", "zh-tw":"我需要處方箋。"
};

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

function normalizeLanguageCode(value){
  const code = text(value).toLowerCase().replace(/_/g, "-");
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code) ? code : "";
}

function cleanPhrases(raw){
  if(!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cleaned = {};
  Object.keys(raw).slice(0, 40).forEach((key) => {
    const safeKey = text(key).replace(/[^\w-]/g, "");
    const value = text(raw[key]);
    if(safeKey && HELP_PHRASE_KEY_SET.has(safeKey) && value) cleaned[safeKey] = value.slice(0, 500);
  });
  return cleaned;
}

function responseContract(options={}){
  const translations = options.translations && typeof options.translations === "object" && !Array.isArray(options.translations)
    ? options.translations
    : {};
  return {
    ok: false,
    status: options.status || "error",
    requestedLanguageCode: options.requestedLanguageCode || "",
    attemptedLanguageCode: options.attemptedLanguageCode || null,
    actualLanguageCode: null,
    languageVerified: false,
    translations,
    fallbackUsed: Boolean(options.fallbackUsed),
    fallbackLanguageCode: options.fallbackLanguageCode || null,
    fallbackReason: options.fallbackReason || null,
    reviewNeeded: Boolean(options.reviewNeeded),
    reviewReasons: Array.isArray(options.reviewReasons) ? options.reviewReasons : [],
    failedItems: Array.isArray(options.failedItems) ? options.failedItems : [],
    sourceLanguageCode: SOURCE_LANGUAGE_CODE,
    responseVersion: RESPONSE_VERSION
  };
}

function errorResponse(statusCode, requestedLanguageCode, failedItems, fallbackReason){
  return json(statusCode, responseContract({
    status: "error",
    requestedLanguageCode,
    failedItems,
    fallbackReason
  }));
}

function buildPrompt(){
  return [
    "You translate short Korean emergency travel help phrases for local people, medical staff, or pharmacists.",
    "Return valid JSON only. Do not include Markdown or explanations.",
    "Preserve the exact phrase keys. Do not merge, drop, rename, or move values between keys.",
    "Translate only the provided Korean phrases into the requested target language.",
    "For the prescription key, translate only the first-person declarative sentence meaning 'I need a prescription.' Do not turn it into a question and do not change the speaker.",
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

function prescriptionStatementForLanguageCode(languageCode){
  const normalized = text(languageCode).toLowerCase();
  return PRESCRIPTION_STATEMENTS[normalized] || PRESCRIPTION_STATEMENTS[baseLanguage(normalized)] || "";
}

function isQuestionLikePrescription(value){
  return /[?？¿؟]/.test(text(value));
}

function enforcePrescriptionStatement(translations, languageCode){
  if(!Object.prototype.hasOwnProperty.call(translations, "prescription")){
    return {reviewNeeded:false, reviewReasons:[]};
  }
  const expected = prescriptionStatementForLanguageCode(languageCode);
  if(expected){
    translations.prescription = expected;
    return {reviewNeeded:false, reviewReasons:[]};
  }
  if(isQuestionLikePrescription(translations.prescription)){
    return {
      reviewNeeded:true,
      reviewReasons:["PRESCRIPTION_DECLARATIVE_REVIEW_REQUIRED"]
    };
  }
  return {
    reviewNeeded:true,
    reviewReasons:["PRESCRIPTION_SEMANTIC_REVIEW_REQUIRED"]
  };
}

function addAttempt(attempts, languageName, languageCode, reason, fallbackUsed){
  const name = text(languageName);
  const code = normalizeLanguageCode(languageCode);
  if(!name && !code) return;
  if(!code || attempts.some((item) => item.languageCode === code)) return;
  attempts.push({
    languageName: name || code,
    languageCode: code,
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

  let data;
  try{
    data = await response.json();
  }catch(error){
    throw new Error("PROVIDER_RESPONSE_INVALID");
  }

  if(!response.ok){
    throw new Error("PROVIDER_REQUEST_FAILED");
  }

  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "{}";
  let parsed;
  try{
    parsed = JSON.parse(content || "{}");
  }catch(error){
    throw new Error("PROVIDER_RESPONSE_INVALID");
  }
  const translations = normalizeTranslations(parsed, keys);
  const prescriptionReview = enforcePrescriptionStatement(translations, attempt.languageCode);
  const failedItems = keys.filter((key) => !translations[key]);

  return {
    translations,
    failedItems,
    reviewNeeded: prescriptionReview.reviewNeeded,
    reviewReasons: prescriptionReview.reviewReasons
  };
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return errorResponse(405, "", [], "METHOD_NOT_ALLOWED");
  }

  let payload;
  try{
    payload = JSON.parse(event.body || "{}");
  }catch(error){
    return errorResponse(400, "", [], "INVALID_JSON_BODY");
  }

  const targetLanguage = text(payload.targetLanguage);
  const rawTargetLanguageCode = text(payload.targetLanguageCode);
  const targetLanguageCode = normalizeLanguageCode(rawTargetLanguageCode);
  const travelCountry = text(payload.travelCountry);
  const rawPhraseKeys = payload.phrases && typeof payload.phrases === "object" && !Array.isArray(payload.phrases)
    ? Object.keys(payload.phrases)
    : [];
  const phrases = cleanPhrases(payload.phrases);
  const keys = Object.keys(phrases);

  if(!rawPhraseKeys.length || !keys.length || rawPhraseKeys.some((key) => !HELP_PHRASE_KEY_SET.has(text(key)))){
    return errorResponse(400, targetLanguageCode, rawPhraseKeys.filter((key) => HELP_PHRASE_KEY_SET.has(text(key))), "INVALID_PHRASES");
  }

  if(!targetLanguageCode){
    return errorResponse(400, targetLanguageCode, keys, "INVALID_LANGUAGE_CODE");
  }

  if(baseLanguage(targetLanguageCode) === "ko"){
    return errorResponse(400, targetLanguageCode, keys, "SOURCE_LANGUAGE_NOT_ALLOWED");
  }

  if(!process.env.OPENAI_API_KEY){
    return errorResponse(500, targetLanguageCode, keys, "SERVER_NOT_CONFIGURED");
  }

  try{
    const attempts = buildTranslationAttempts(payload, targetLanguage, targetLanguageCode);
    let partialResult = null;

    for(const attempt of attempts){
      try{
        const result = await translateOnce({attempt, travelCountry, phrases, keys});
        const isPartial = result.failedItems.length > 0;
        const status = isPartial
          ? "partial"
          : result.reviewNeeded
            ? "review_required"
            : attempt.fallbackUsed
              ? "fallback"
              : "unverified";
        const fallbackReason = status === "partial"
          ? (attempt.fallbackUsed ? "FALLBACK_TRANSLATION_INCOMPLETE" : "TRANSLATION_INCOMPLETE")
          : status === "review_required"
            ? (attempt.fallbackUsed ? "FALLBACK_LANGUAGE_REVIEW_REQUIRED" : "REVIEW_REQUIRED")
            : status === "fallback"
              ? "FALLBACK_LANGUAGE_USED"
              : null;
        const body = responseContract({
          status,
          requestedLanguageCode: targetLanguageCode,
          attemptedLanguageCode: attempt.languageCode,
          translations: result.translations,
          fallbackUsed: attempt.fallbackUsed,
          fallbackLanguageCode: attempt.fallbackUsed ? attempt.languageCode : null,
          fallbackReason,
          reviewNeeded: result.reviewNeeded,
          reviewReasons: result.reviewReasons,
          failedItems: result.failedItems
        });
        if(!isPartial) return json(422, body);
        if(Object.keys(body.translations).length && (!partialResult || Object.keys(body.translations).length > Object.keys(partialResult.translations).length)){
          partialResult = body;
        }
      }catch(error){
        continue;
      }
    }

    if(partialResult) return json(422, partialResult);
    return errorResponse(502, targetLanguageCode, keys, "ALL_TRANSLATION_ATTEMPTS_FAILED");
  }catch(error){
    return errorResponse(500, targetLanguageCode, keys, "INTERNAL_PROCESSING_ERROR");
  }
};
