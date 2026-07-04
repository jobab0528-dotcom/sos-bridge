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

function normalizeResult(raw, context){
  const level = normalizeLevel(raw.level);
  const needsAmbulance = Boolean(raw.needsAmbulance || level === "emergency");
  const emergencyNumber = context.emergencyNumber || "현지 응급번호";
  const localLanguageName = context.localLanguageName || "현지어";

  return {
    level,
    title: String(raw.title || "AI 응급도 참고 안내 결과").replace(/진단/g, "판단"),
    summary: String(raw.summary || "입력된 증상과 여행 상황을 기준으로 의료 상담을 권장합니다.").replace(/진단/g, "판단"),
    category: String(raw.category || "ai-care"),
    reasons: asArray(raw.reasons, ["입력된 증상에서 확인이 필요한 위험 신호가 있는지 살펴야 합니다."]),
    steps: asArray(raw.steps, [
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
    localPhraseKo: String(raw.localPhraseKo || "도움이 필요합니다. 가까운 의료진이나 구급차를 불러 주세요."),
    localPhraseEn: String(raw.localPhraseEn || "I need help. Please call medical staff or an ambulance."),
    localPhraseLocal: String(raw.localPhraseLocal || raw.localPhraseNative || raw.localPhraseEn || "I need help. Please call medical staff or an ambulance."),
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
