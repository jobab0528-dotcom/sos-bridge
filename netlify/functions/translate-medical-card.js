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

const coldMedicineText = {
  ko:"감기약, 성분 미기재",
  en:"Cold medicine, ingredient not specified",
  fr:"Médicament contre le rhume, ingrédient non précisé",
  es:"Medicamento para el resfriado, ingrediente no especificado",
  ja:"風邪薬、成分は不明",
  vi:"Thuốc cảm, không rõ thành phần",
  zh:"感冒药，未注明成分",
  de:"Erkältungsmedikament, Wirkstoff nicht angegeben",
  it:"Medicinale per il raffreddore, principio attivo non specificato",
  tr:"Soğuk algınlığı ilacı, içeriği belirtilmemiş",
  th:"ยาแก้หวัด ไม่ระบุส่วนประกอบ",
  pt:"Remédio para resfriado, ingrediente não especificado",
  nl:"Verkoudheidsmedicijn, bestanddeel niet vermeld",
  ms:"Ubat selesema, bahan tidak dinyatakan",
  id:"Obat flu, kandungan tidak disebutkan",
  ar:"دواء للزكام، المكوّن غير محدد",
  pl:"Lek na przeziębienie, składnik nieokreślony",
  da:"Forkølelsesmedicin, indholdsstof ikke angivet",
  el:"Φάρμακο για κρυολόγημα, μη καθορισμένο συστατικό"
};

const pollenAllergyText = {
  ko:"꽃가루 알레르기",
  en:"Pollen allergy",
  fr:"Allergie au pollen",
  es:"Alergia al polen",
  ja:"花粉アレルギー",
  vi:"Dị ứng phấn hoa",
  zh:"花粉过敏",
  de:"Pollenallergie",
  it:"Allergia al polline",
  tr:"Polen alerjisi",
  th:"ภูมิแพ้เกสรดอกไม้",
  pt:"Alergia ao pólen",
  nl:"Pollenallergie",
  ms:"Alahan debunga",
  id:"Alergi serbuk sari",
  ar:"حساسية من حبوب اللقاح",
  pl:"Alergia na pyłki",
  da:"Pollenallergi",
  el:"Αλλεργία στη γύρη"
};

const medicationEnteredText = {
  ko:"사용자가 입력한 약",
  en:"medication entered by the user",
  fr:"médicament indiqué par l’utilisateur",
  es:"medicamento indicado por el usuario",
  ja:"利用者が入力した薬",
  vi:"thuốc do người dùng nhập",
  zh:"用户输入的药品",
  de:"vom Benutzer angegebenes Medikament",
  it:"farmaco indicato dall'utente",
  tr:"kullanıcının girdiği ilaç",
  th:"ยาที่ผู้ใช้ระบุ",
  pt:"medicamento informado pelo usuário",
  nl:"door gebruiker ingevoerd medicijn",
  ms:"ubat yang dimasukkan pengguna",
  id:"obat yang dimasukkan pengguna",
  ar:"دواء أدخله المستخدم",
  pl:"lek wpisany przez użytkownika",
  da:"lægemiddel angivet af brugeren",
  el:"φάρμακο που καταχώρισε ο χρήστης"
};

const medicationBrandPatterns = [
  {pattern: /타이레놀|tylenol/gi, display: "Tylenol"},
  {pattern: /애드빌|advil/gi, display: "Advil"},
  {pattern: /이지엔|ezn/gi, display: "EZN"},
  {pattern: /판콜|pankol|pancol/gi, display: "Pankol"}
];

function isEmpty(value){
  return !text(value);
}

function isNoneInput(value){
  return /^(없음|없어요|무|해당없음|해당 없음|none|no|n\/a|na)$/i.test(text(value));
}

function isColdMedicineInput(value){
  return /감기약/.test(text(value));
}

function isPollenAllergyInput(value){
  return /꽃가루/.test(text(value));
}

function preserveMedicationBrandName(value){
  let preserved = text(value);
  let matched = false;
  medicationBrandPatterns.forEach((item) => {
    if(item.pattern.test(preserved)){
      matched = true;
      preserved = preserved.replace(item.pattern, item.display);
    }
    item.pattern.lastIndex = 0;
  });
  return matched ? preserved : "";
}

function userEnteredRestrictedIngredient(value){
  return /(paracetamol|acetaminophen|ibuprofen|aspirin|파라세타몰|아세트아미노펜|이부프로펜|아스피린)/i.test(text(value));
}

function looksLikeUnsafeMedicationInference(value){
  return /(paracetamol|acetaminophen|ibuprofen|aspirin|pain reliever|fever reducer|cold medicine|analg[eé]sico|antipir[eé]tico|antalgique|antipyr[eé]tique|진통제|해열제|medicamento para el resfriado|m[eé]dicament contre le rhume|風邪薬|감기약|thuốc cảm|感冒药|Erkältungsmedikament|medicinale per il raffreddore|remédio para resfriado)/i.test(text(value));
}

function missingFor(lang){
  return notProvidedText[lang] || notProvidedText.en;
}

function noneFor(lang){
  return noneText[lang] || noneText.en;
}

function coldMedicineFor(lang){
  return coldMedicineText[lang] || coldMedicineText.en;
}

function pollenAllergyFor(lang){
  return pollenAllergyText[lang] || pollenAllergyText.en;
}

function medicationEnteredFor(lang){
  return medicationEnteredText[lang] || medicationEnteredText.en;
}

function medicationProductFor(name, lang){
  return `${name}, ${medicationEnteredFor(lang)}`;
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
  if(isColdMedicineInput(raw)) return coldMedicineFor(lang);
  const preservedBrand = preserveMedicationBrandName(raw);
  if(preservedBrand) return medicationProductFor(preservedBrand, lang);
  const translated = text(resultValue) || raw;
  if(looksLikeUnsafeMedicationInference(translated) && !userEnteredRestrictedIngredient(raw)){
    return medicationProductFor(raw, lang);
  }
  return translated;
}

function safeAllergy(resultValue, originalValue, lang){
  const raw = text(originalValue);
  if(isEmpty(raw)) return missingFor(lang);
  if(isNoneInput(raw)) return noneFor(lang);
  if(isPollenAllergyInput(raw)) return pollenAllergyFor(lang);
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
    "Every translated value must be in the requested target language. Do not answer in English unless the requested target language is English.",
    "Do not add, infer, interpret, summarize, or create any allergy, medicine, condition, symptom, or personal detail.",
    "For the name field, use passportName first when provided. If passportName is empty and name is Korean Hangul, romanize the name for local staff and include the Korean original in parentheses, for example Cho Hyun-jun (조현준).",
    "Keep age numbers, blood type, phone numbers, dates, and emergency contact numbers unchanged.",
    "If a field is empty, return the target-language equivalent of Not provided or No information provided.",
    "If a user entered 없음/none/no, return the target-language equivalent of None.",
    "Preserve specific medicine names and product names. If the user entered 타이레놀, return Tylenol plus the target-language equivalent of medication entered by the user. If the user entered 애드빌, 이지엔, or 판콜, preserve the product name as Advil, EZN, or Pankol when appropriate.",
    "Do not convert medicine product names into cold medicine, pain reliever, fever reducer, paracetamol, acetaminophen, ibuprofen, aspirin, or any ingredient name unless the user directly entered that ingredient.",
    "Do not guess medicine ingredients. If the user entered 감기약 as a general expression, translate it as cold medicine and explicitly say ingredient not specified in the target language. For Spanish use Medicamento para el resfriado, ingrediente no especificado. For French use Médicament contre le rhume, ingrédient non précisé. For Japanese use 風邪薬、成分は不明.",
    "If allergies is 꽃가루, translate it as pollen allergy or the target-language equivalent of pollen allergy, not just pollen. For French use Allergie au pollen. For Japanese use 花粉アレルギー.",
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
