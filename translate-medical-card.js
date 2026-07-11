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

function asArray(value, fallback = []){
  if(Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if(typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}

function asNumber(value, fallback){
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}

function normalizeLevel(value){
  return ["emergency", "urgent", "mild", "info"].includes(value) ? value : "urgent";
}

function normalizeAction(value){
  return ["emergency", "hospital", "pharmacy", "self-care"].includes(value) ? value : "hospital";
}

function sanitizeCareInstruction(item){
  const value = String(item || "").trim();
  if(!value) return "";

  if(/(항히스타민|진통제|해열제|소염제|소화제|일반\s*의약품|약|medicine|medication|drug|pill).*(복용하세요|복용해도|드세요|먹으세요|take|use)/i.test(value)){
    return "약 복용이 필요하다고 생각되면 현지 의료진 또는 약사에게 먼저 상담하세요.";
  }

  if(/(복용하세요|복용해도\s*됩니다|일반\s*의약품을\s*복용|take\s+.*(medicine|medication|drug|pill|mg))/i.test(value)){
    return "증상이 지속되면 현지 의료진 또는 약사에게 상담하세요.";
  }

  if(/(차갑게|냉찜질|얼음찜질).*(붓기|부기).*(줄이|가라앉|완화)|붓기.*줄이세요|부기.*줄이세요/i.test(value)){
    return "붓기나 통증이 지속되거나 심해지면 현지 의료진에게 상담하세요.";
  }

  return value;
}

function sanitizeCareInstructions(items){
  return asArray(items).map(sanitizeCareInstruction).filter(Boolean);
}

function isGenericLocalPhraseKo(value){
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if(!normalized) return true;
  return /^(현지\s*)?의료진에게 보여줄 문장$|^현지어 도움 문장$|^도움 문장$|^local phrase$/i.test(normalized);
}

function normalizeLocalPhraseKo(value, context){
  const phrase = String(value || "").trim();
  if(phrase && !isGenericLocalPhraseKo(phrase)) return phrase;
  return String(context.symptom || "").trim() || "도움이 필요합니다. 가까운 의료진이나 구급차를 불러 주세요.";
}

function isHeadacheSymptomKo(value){
  const normalized = String(value || "").replace(/\s+/g, "").replace(/[.!?。]/g, "");
  return normalized === "머리가아픕니다";
}

function normalizeLocalPhraseLocal(value, context){
  const localLanguage = String(context.localLanguage || "").toLowerCase().split("-")[0];
  if(localLanguage === "ms" && isHeadacheSymptomKo(context.symptom)){
    return "Saya sakit kepala.";
  }
  return String(value || "I need help. Please call medical staff or an ambulance.").trim();
}

function normalizeResult(raw, context){
  const level = normalizeLevel(raw.level);
  const needsAmbulance = Boolean(raw.needsAmbulance || level === "emergency");
  const emergencyNumber = context.emergencyNumber || "현지 응급번호";
  const localLanguageName = context.localLanguageName || "현지어";
  const sanitizedSteps = sanitizeCareInstructions(raw.steps);
  const localPhraseKo = normalizeLocalPhraseKo(raw.localPhraseKo, context);

  return {
    level,
    title: String(raw.title || "AI 응급도 참고 안내 결과").replace(/진단/g, "판단"),
    summary: String(raw.summary || "입력된 증상과 여행 상황을 기준으로 의료 상담을 권장합니다.").replace(/진단/g, "판단"),
    category: String(raw.category || "ai-care"),
    reasons: asArray(raw.reasons, ["입력된 증상에서 확인이 필요한 위험 신호가 있는지 살펴야 합니다."]),
    steps: sanitizedSteps.length ? sanitizedSteps : asArray(raw.steps, [
      needsAmbulance ? `즉시 ${emergencyNumber}로 연락하거나 주변 사람에게 도움을 요청하세요.` : "증상이 시작된 시간과 변화 양상을 기록하세요.",
      "여권, 복용 중인 약, 알레르기 정보를 준비하세요.",
      "증상이 악화되면 가까운 의료기관을 방문하세요."
    ]),
    avoid: asArray(raw.avoid, [
      "증상이 심한데 혼자 이동하지 마세요.",
      "출처가 불분명한 약을 여러 개 함께 복용하지 마세요."
    ]),
    monitor: asArray(raw.monitor, ["호흡곤란", "의식 저하", "심한 통증", "출혈", "고열"]),
    questions: asArray(raw.questions, ["언제 시작됐나요?", "통증은 어느 부위인가요?", "복용 중인 약이나 알레르기가 있나요?"]),
    localPhraseKo,
    localPhraseEn: String(raw.localPhraseEn || "I need help. Please call medical staff or an ambulance."),
    localPhraseLocal: normalizeLocalPhraseLocal(raw.localPhraseLocal || raw.localPhraseNative || raw.localPhraseEn, context),
    recommendedAction: normalizeAction(raw.recommendedAction || (needsAmbulance ? "emergency" : "hospital")),
    recommendedDepartment: String(raw.recommendedDepartment || (needsAmbulance ? "응급의학과" : "가까운 병원 또는 클리닉")),
    needsAmbulance,
    confidence: asNumber(raw.confidence, 82),
    severityScore: asNumber(raw.severityScore, needsAmbulance ? 90 : 65),
    localLanguageName
  };
}

function buildPrompt(){
  return [
    "You are an AI emergency-severity guidance assistant for Korean travelers overseas.",
    "Return valid JSON only. Do not include Markdown.",
    "The service is not a substitute for medical professionals. Avoid language that sounds like a confirmed medical conclusion.",
    "Use Korean for user-facing guidance, except localPhraseEn and localPhraseLocal.",
    "Focus on AI 응급도 참고 안내, 위험 신호, 지금 해야 할 일, 하지 말아야 할 행동, 추천 진료과, and 현지 의료진에게 보여줄 문장.",
    "If red flags appear, set level to emergency, needsAmbulance to true, and tell the traveler to contact the local emergency number immediately.",
    "Do not directly instruct the traveler to take medication, use over-the-counter medicine, or perform treatment steps. Tell them to consult local medical staff or a pharmacist instead.",
    "Do not claim that cooling, icing, or other care will reduce swelling or treat symptoms. If symptoms continue or worsen, advise medical consultation.",
    "localPhraseKo must be the actual Korean sentence to show to medical staff based on the user's symptom. Do not return a label such as '의료진에게 보여줄 문장'.",
    "JSON fields required: level, title, summary, category, reasons, steps, avoid, monitor, questions, localPhraseKo, localPhraseEn, localPhraseLocal, recommendedAction, recommendedDepartment, needsAmbulance, confidence, severityScore.",
    "level must be one of emergency, urgent, mild, info.",
    "recommendedAction must be one of emergency, hospital, pharmacy, self-care."
  ].join("\n");
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

  const context = {
    symptom: String(payload.symptom || "").trim(),
    travelCountry: String(payload.travelCountry || "").trim(),
    travelCity: String(payload.travelCity || "").trim(),
    userLanguage: String(payload.userLanguage || "ko").trim(),
    localLanguage: String(payload.localLanguage || "").trim(),
    localLanguageName: String(payload.localLanguageName || "").trim(),
    emergencyNumber: String(payload.emergencyNumber || "").trim()
  };

  if(!context.symptom){
    return json(400, {error: "symptom is required"});
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
        temperature: 0.2,
        response_format: {type: "json_object"},
        messages: [
          {role: "system", content: buildPrompt()},
          {
            role: "user",
            content: JSON.stringify({
              request: "Create AI emergency-severity guidance JSON for the SOS Bridge app.",
              travelerContext: context,
              localPhraseInstruction: `Translate the local phrase into ${context.localLanguageName || context.localLanguage || "the local language"} for local medical staff.`
            })
          }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));

    if(!response.ok){
      return json(response.status >= 500 ? 502 : response.status, {
        error: "AI Care request failed",
        detail: data.error && data.error.message ? data.error.message : "OpenAI API request failed"
      });
    }

    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    const parsed = JSON.parse(content || "{}");

    return json(200, normalizeResult(parsed, context));
  }catch(error){
    return json(502, {
      error: "AI Care request failed",
      detail: error && error.message ? error.message : "Unknown error"
    });
  }
};
