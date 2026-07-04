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

function normalizeResult(result = {}, original){
  return {
    name: text(result.name) || original.name,
    nationality: text(result.nationality) || original.nationality,
    age: original.age,
    bloodType: original.bloodType,
    allergies: text(result.allergies) || original.allergies,
    medication: text(result.medication) || original.medication,
    medicalConditions: text(result.medicalConditions) || original.medicalConditions,
    emergencyContact: original.emergencyContact,
    travelInsurance: text(result.travelInsurance) || original.travelInsurance,
    hotelAddress: text(result.hotelAddress) || original.hotelAddress
  };
}

function systemPrompt(){
  return [
    "You translate a Korean travel medical card for local medical staff.",
    "Return JSON only. Do not include Markdown or explanations.",
    "Only translate the user-provided medical card values into the requested target language.",
    "Do not add, infer, interpret, summarize, or create any allergy, medicine, condition, symptom, or personal detail.",
    "Keep age numbers, blood type, phone numbers, dates, and emergency contact numbers unchanged.",
    "For ambiguous wording, translate as literally as possible while keeping it understandable for medical staff.",
    "Do not provide medical advice or clinical interpretation.",
    "Required JSON keys: name, nationality, age, bloodType, allergies, medication, medicalConditions, emergencyContact, travelInsurance, hotelAddress."
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

    return json(200, normalizeResult(parsed, fields));
  }catch(error){
    return json(502, {
      error: "Medical card translation failed",
      detail: error && error.message ? error.message : "Unknown error"
    });
  }
};
