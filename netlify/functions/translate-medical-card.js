const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(statusCode, body){
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

function text(value){
  return String(value || "").trim();
}

function cleanFields(fields = {}){
  return {
    name: text(fields.name),
    passportName: text(fields.passportName),
    nationality: text(fields.nationality),
    age: text(fields.age),
    bloodType: text(fields.bloodType),
    allergies: text(fields.allergies),
    medication: text(fields.medication),
    medicalConditions: text(fields.medicalConditions),
    emergencyContact: text(fields.emergencyContact),
    travelInsurance: text(fields.travelInsurance),
    hotelAddress: text(fields.hotelAddress)
  };
}

function baseLanguage(code){
  return String(code || "").split("-")[0].toLowerCase() || "en";
}

const notProvidedText = {
  ko:"미입력",
  en:"Not provided",
  fr:"Non renseigné",
  es:"No proporcionado",
  ja:"未入力",
  vi:"Chưa cung cấp",
  zh:"未填写",
  de:"Nicht angegeben",
  it:"Non fornito",
  tr:"Belirtilmedi",
  th:"ไม่ได้ระบุ",
  pt:"Não informado",
  nl:"Niet opgegeven",
  ms:"Tidak diberikan",
  id:"Tidak diisi",
  ar:"غير مذكور",
  pl:"Nie podano",
  da:"Ikke angivet",
  el:"Δεν παρέχεται"
};

const noneText = {
  ko:"없음",
  en:"None",
  fr:"Aucun",
  es:"Ninguno",
  ja:"なし",
  vi:"Không có",
  zh:"无",
  de:"Keine",
  it:"Nessuno",
  tr:"Yok",
  th:"ไม่มี",
  pt:"Nenhum",
  nl:"Geen",
  ms:"Tiada",
  id:"Tidak ada",
  ar:"لا يوجد",
  pl:"Brak",
  da:"Ingen",
  el:"Κανένα"
};

function isEmpty(value){
  return !text(value);
}

function isNoneInput(value){
  return /^(없음|없어요|무|해당없음|해당 없음|none|no|n\/a|na)$/i.test(text(value));
}

function missingFor(lang){
  return notProvidedText[lang] || notProvidedText.en;
}

function noneFor(lang){
  return noneText[lang] || noneText.en;
}

function valueOrFallback(resultValue, originalValue, lang){
  if(isEmpty(originalValue)) return missingFor(lang);
  if(isNoneInput(originalValue)) return noneFor(lang);
  return text(resultValue) || text(originalValue);
}

function safeMedication(resultValue, originalValue, lang){
  const raw = text(originalValue);
  if(isEmpty(raw)) return missingFor(lang);
  if(isNoneInput(raw)) return noneFor(lang);
  if(raw === "감기약"){
    if(lang === "fr") return "Médicament contre le rhume, ingrédient non précisé";
    if(lang === "en") return "Cold medicine, ingredient not specified";
  }
  const translated = text(resultValue) || raw;
  if(raw === "감기약" && /(paracetamol|ibuprofen|acetaminophen|aspirin)/i.test(translated)){
    return lang === "fr" ? "Médicament contre le rhume, ingrédient non précisé" : "Cold medicine, ingredient not specified";
  }
  return translated;
}

function safeAllergy(resultValue, originalValue, lang){
  const raw = text(originalValue);
  if(isEmpty(raw)) return missingFor(lang);
  if(isNoneInput(raw)) return noneFor(lang);
  if(raw === "꽃가루"){
    if(lang === "fr") return "Allergie au pollen";
    if(lang === "en") return "Pollen allergy";
  }
  return text(resultValue) || raw;
}

function normalizeName(result = {}, original){
  const koreanName = text(original.name);
  const passportName = text(original.passportName);
  if(passportName && koreanName) return `${passportName} (${koreanName})`;
  if(passportName) return passportName;
  const translatedName = text(result.name);
  if(translatedName && koreanName && !translatedName.includes(koreanName)) return `${translatedName} (${koreanName})`;
  return translatedName || koreanName;
}

function normalizeResult(result = {}, original, lang){
  return {
    name: normalizeName(result, original) || missingFor(lang),
    passportName: original.passportName,
    nationality: valueOrFallback(result.nationality, original.nationality, lang),
    age: original.age || missingFor(lang),
    bloodType: original.bloodType || missingFor(lang),
    allergies: safeAllergy(result.allergies, original.allergies, lang),
    medication: safeMedication(result.medication, original.medication, lang),
    medicalConditions: valueOrFallback(result.medicalConditions, original.medicalConditions, lang),
    emergencyContact: original.emergencyContact || missingFor(lang),
    travelInsurance: valueOrFallback(result.travelInsurance, original.travelInsurance, lang),
    hotelAddress: valueOrFallback(result.hotelAddress, original.hotelAddress, lang)
  };
}

function systemPrompt(){
  return [
    "You translate a Korean travel medical card for local medical staff.",
    "Return JSON only. Do not include Markdown or explanations.",
    "Only translate the user-provided medical card values into the requested target language.",
    "Do not add, infer, interpret, summarize, or create any allergy, medicine, condition, symptom, or personal detail.",
    "For the name field, use passportName first when provided. If passportName is empty and name is Korean Hangul, romanize the name for local staff and include the Korean original in parentheses, for example Cho Hyun-jun (조현준).",
    "Keep age numbers, blood type, phone numbers, dates, and emergency contact numbers unchanged.",
    "If a field is empty, return the target-language equivalent of Not provided or No information provided.",
    "If a user entered 없음/none/no, return the target-language equivalent of None.",
    "Do not guess medicine ingredients. If the user entered 감기약, translate it as cold medicine and explicitly say ingredient not specified in the target language. Do not output paracetamol, ibuprofen, acetaminophen, or other ingredient names unless the user directly entered that ingredient.",
    "If allergies is 꽃가루, translate it as pollen allergy or the target-language equivalent of pollen allergy.",
    "For ambiguous wording, translate as literally as possible while keeping it understandable for medical staff.",
    "Do not provide medical advice or clinical interpretation.",
    "Required JSON keys: name, passportName, nationality, age, bloodType, allergies, medication, medicalConditions, emergencyContact, travelInsurance, hotelAddress."
  ].join("\n");
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  if(!process.env.OPENAI_API_KEY){
    return json(500, {error: "OPENAI_API_KEY is not configured"});
  }

  let body;
  try{
    body = JSON.parse(event.body || "{}");
  }catch(error){
    return json(400, {error: "Invalid JSON body"});
  }

  const fields = cleanFields(body.fields || {});
  const targetLanguage = text(body.targetLanguage) || "English";
  const targetLanguageCode = text(body.targetLanguageCode);
  const lang = baseLanguage(targetLanguageCode);
  const travelCountry = text(body.travelCountry);

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
          {role: "system", content: systemPrompt()},
          {
            role: "user",
            content: JSON.stringify({
              targetLanguage,
              targetLanguageCode,
              travelCountry,
              fields
            })
          }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));

    if(!response.ok){
      return json(response.status >= 500 ? 502 : response.status, {
        error: "Medical card translation failed",
        detail: data.error && data.error.message ? data.error.message : "OpenAI API request failed"
      });
    }

    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "{}";
    const parsed = JSON.parse(content || "{}");

    return json(200, normalizeResult(parsed, fields, lang));
  }catch(error){
    return json(502, {
      error: "Medical card translation failed",
      detail: error && error.message ? error.message : "Unknown error"
    });
  }
};
