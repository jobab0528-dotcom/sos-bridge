(function(){
  try{
  console.log("developer-test.js started", window.location.search);
  const isAllLanguageTest =
    new URLSearchParams(window.location.search).get("sosTest") === "all-languages";

  console.log("developer-test.js query check:", {
    search: window.location.search,
    isAllLanguageTest
  });

  if(!isAllLanguageTest) return;

  function renderAllLanguageDeveloperTestPanel(){
    try{
    console.log("renderAllLanguageDeveloperTestPanel running");

    const context = window.SOS_BRIDGE_DEV_TEST_CONTEXT || {};
    const languageOptions = Array.isArray(context.languageOptions) && context.languageOptions.length
      ? context.languageOptions
      : (Array.isArray(window.SOS_BRIDGE_COUNTRIES) ? window.SOS_BRIDGE_COUNTRIES : []);
    const priorityLanguageOptions = Array.isArray(context.priorityLanguageOptions) && context.priorityLanguageOptions.length
      ? context.priorityLanguageOptions
      : languageOptions;
    const phrasePacks = context.phrasePacks || {ko: {help: "도와주세요."}};
    const escapeHtml = typeof context.escapeHtml === "function"
      ? context.escapeHtml
      : (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));

    const $ = (id) => document.getElementById(id);

    function createAllLanguageTestPanel(){
    if($("sos-dev-test-panel")) return;
    const panel = document.createElement("section");
    panel.id = "sos-dev-test-panel";
    panel.className = "container card";
    panel.style.display = "block";
    panel.style.position = "relative";
    panel.style.zIndex = "20";
    panel.style.background = "#fff";
    panel.style.border = "1px solid #cbd5e1";
    panel.style.padding = "16px";
    panel.style.margin = "16px auto";
    panel.innerHTML =
      '<p class="eyebrow" style="margin-bottom:6px">Developer Test</p>'+
      '<h2 style="margin-top:0">전세계 국가/지역 번역 테스트</h2>'+
      '<p class="small muted" style="line-height:1.6">현재 앱에 등록된 국가/지역의 대표 언어를 기준으로 현지어 도움 문장과 여행자 의료카드 현지어 보기를 자동 점검합니다.</p>'+
      '<div class="notice amber small">전체 국가/지역 테스트는 API 호출이 많아 시간이 오래 걸릴 수 있습니다. 빠른 확인은 대표 언어별 테스트를 먼저 실행하세요.</div>'+
      '<div class="grid" style="margin-top:12px">'+
        '<button id="run-priority-country-test" class="btn primary w-full" type="button">우선 지원 62개 테스트 실행</button>'+
        '<button id="run-representative-language-test" class="btn outline w-full" type="button">대표 언어별 테스트 실행</button>'+
        '<button id="run-all-country-region-test" class="btn outline w-full" type="button">전체 국가/지역 테스트 실행</button>'+
      '</div>'+
      '<div id="sos-dev-test-status" class="notice teal hidden" style="margin-top:12px"></div>'+
      '<div id="sos-ai-care-audit-mount"></div>'+
      '<div style="overflow:auto;margin-top:12px">'+
        '<table style="width:100%;border-collapse:collapse;min-width:1180px;font-size:12px">'+
          '<thead>'+
            '<tr style="background:#f8fafc;color:var(--navy);text-align:left">'+
              '<th style="padding:9px;border:1px solid var(--border)">상태</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">국가/지역</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">영어명</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">대표 언어</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">languageCode</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">의료카드 제목</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">미입력 표시</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">알레르기 결과</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">복용약 결과</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">기존 질환 결과</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">도움 문장 결과</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">사용 언어</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">fallback 사용 여부</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">fallback 사유</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">오류 메시지</th>'+
              '<th style="padding:9px;border:1px solid var(--border)">문제 설명</th>'+
            '</tr>'+
          '</thead>'+
          '<tbody id="sos-dev-test-rows"></tbody>'+
        '</table>'+
      '</div>';

    document.body.prepend(panel);
    console.log("Developer test panel inserted", document.getElementById("sos-dev-test-panel"));
  }

    function devTestCountryPayload(country){
    return {
      countryNameKo: country.countryNameKo || country.countryKo || "",
      countryNameEn: country.countryNameEn || country.country || "",
      languageNameKo: country.languageNameKo || country.languageKo || country.native || "",
      languageNameEn: country.languageNameEn || country.native || "",
      languageCode: country.languageCode || "",
      fallbackLanguageNameKo: country.fallbackLanguageNameKo || "",
      fallbackLanguageNameEn: country.fallbackLanguageNameEn || "",
      fallbackLanguageCode: country.fallbackLanguageCode || "",
      fallbackNotice: country.fallbackNotice || ""
    };
  }

    function devTestMedicalFields(){
    return {
      name: "홍길동",
      passportName: "HONG GIL DONG",
      nationality: "대한민국",
      age: "22",
      bloodType: "B+",
      allergies: "꽃가루, 땅콩",
      medication: "타이레놀",
      medicalConditions: "천식, 당뇨",
      emergencyContact: "+82-10-1234-5678",
      travelInsurance: "",
      hotelAddress: ""
    };
  }

    function devTestTargets(mode){
    const source = mode === "priority" ? priorityLanguageOptions : languageOptions;
    const countries = source.filter((country) => country && (country.languageCode || country.languageNameEn));
    if(mode === "priority") return countries;
    if(mode === "all") return countries;
    const seen = new Set();
    return countries.filter((country) => {
      const key = String(country.languageCode || country.languageNameEn || "").toLowerCase();
      if(!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

    function hasEnglishFallbackForDevTest(value, languageCode, languageNameEn){
    const isEnglish = String(languageCode || "").toLowerCase().split("-")[0] === "en" || /^english$/i.test(String(languageNameEn || "").trim());
    if(isEnglish) return false;
    return /\b(Medical Card|Not provided|No information provided|Peanut allergy|Pollen allergy|medication entered by the user|user-entered medication|medicine entered by user|medication provided by user)\b/i.test(String(value || "")) || hasMedicationPlaceholderForDevTest(value);
  }

    function hasMedicationPlaceholderForDevTest(value){
    return /(사용자가 입력한 약|사용자 입력 약품|이용자가 입력한 약|사용자 제공 약|利用者が入力した薬|ユーザーが入力した薬|用户输入的药品|使用者輸入的藥品|user-entered medication|medicine entered by user|medication entered by the user|medication provided by user|m[eé]dicament indiqu[eé] par l[’']utilisateur|medicamento indicado por el usuario|vom Benutzer angegebenes Medikament|farmaco indicato dall['’]utente|medicamento informado pelo usuário|door gebruiker ingevoerd medicijn|obat yang dimasukkan pengguna|ubat yang dimasukkan pengguna|lek wpisany przez użytkownika|lægemiddel angivet af brugeren|kullanıcının girdiği ilaç|دواء أدخله المستخدم)/i.test(String(value || ""));
  }

    function devTestCell(value){
    return '<td style="padding:8px;border:1px solid var(--border);vertical-align:top">'+escapeHtml(value || "")+'</td>';
  }

    function renderDevTestRows(rows){
    const tbody = $("sos-dev-test-rows");
    if(!tbody) return;
    tbody.innerHTML = rows.map((row) => {
      const statusColor = row.status === "통과" || row.status === "통과 fallback" ? "#047857" : row.status === "확인 필요" ? "#b45309" : "#b91c1c";
      return '<tr>'+
        '<td style="padding:8px;border:1px solid var(--border);vertical-align:top;font-weight:950;color:'+statusColor+'">'+escapeHtml(row.status)+'</td>'+
        devTestCell(row.countryKo)+
        devTestCell(row.countryEn)+
        devTestCell(row.languageName)+
        devTestCell(row.languageCode)+
        devTestCell(row.cardTitle)+
        devTestCell(row.blankValue)+
        devTestCell(row.allergies)+
        devTestCell(row.medication)+
        devTestCell(row.medicalConditions)+
        devTestCell(row.helpPhrase)+
        devTestCell(row.usedLanguage)+
        devTestCell(row.fallbackUsed)+
        devTestCell(row.fallbackReason)+
        devTestCell(row.errorMessage)+
        devTestCell(row.problem)+
      '</tr>';
    }).join("");
  }

    function devTestBaseLanguage(code){
    return String(code || "").toLowerCase().split("-")[0];
  }

    function devTestRequiredMissing(row){
    const missing = [];
    if(!row.cardTitle) missing.push("의료카드 제목 없음");
    if(!row.blankValue) missing.push("미입력 표시 없음");
    if(!row.allergies) missing.push("알레르기 결과 없음");
    if(!row.medication) missing.push("복용약 결과 없음");
    if(!row.medicalConditions) missing.push("기존 질환 결과 없음");
    if(!row.helpPhrase) missing.push("도움 문장 결과 없음");
    return missing;
  }

    function devTestQualityProblems(row){
    const problems = [];
    if(hasMedicationPlaceholderForDevTest(row.medication)) problems.push("복용약 placeholder 문구 포함");
    if(!String(row.allergies || "").includes("꽃가루")) problems.push("알레르기 원문 꽃가루 누락");
    if(!String(row.allergies || "").includes("땅콩")) problems.push("알레르기 원문 땅콩 누락");
    if(!String(row.medication || "").includes("타이레놀")) problems.push("복용약 원문 타이레놀 누락");
    if(!String(row.medicalConditions || "").includes("천식")) problems.push("기존질환 원문 천식 누락");
    if(!String(row.medicalConditions || "").includes("당뇨")) problems.push("기존질환 원문 당뇨 누락");
    return problems;
  }

    function devTestFallbackReason(selectedCountry){
    const label = String(selectedCountry.languageNameEn || selectedCountry.languageNameKo || selectedCountry.languageCode || "Primary language").trim();
    return label + " translation failed or returned incomplete fields";
  }

    function devTestEnglishFallbackCountry(selectedCountry){
    return {
      ...selectedCountry,
      languageNameKo: "영어",
      languageNameEn: "English",
      languageCode: "en",
      fallbackLanguageNameKo: "",
      fallbackLanguageNameEn: "",
      fallbackLanguageCode: ""
    };
  }

    function devTestRowFromResponses(baseRow, medicalData, helpData, forcedFallbackReason){
    const helpPhrase = String((helpData.translations && helpData.translations.help) || helpData.help || "").trim();
    const anyFallbackUsed = Boolean(medicalData.fallbackUsed || helpData.fallbackUsed || forcedFallbackReason);
    const fallbackReasons = [];
    if(medicalData.fallbackReason) fallbackReasons.push("의료카드: " + medicalData.fallbackReason);
    if(helpData.fallbackReason) fallbackReasons.push("도움 문장: " + helpData.fallbackReason);
    if(forcedFallbackReason && !fallbackReasons.length) fallbackReasons.push("공통 fallback: " + forcedFallbackReason);
    return {
      ...baseRow,
      cardTitle: String(medicalData._cardTitle || medicalData.cardTitle || "").trim(),
      blankValue: String(medicalData._blankValue || medicalData.emergencyContact || medicalData.travelInsurance || "").trim(),
      allergies: String(medicalData.allergies || "").trim(),
      medication: String(medicalData.medication || "").trim(),
      medicalConditions: String(medicalData.medicalConditions || "").trim(),
      helpPhrase,
      usedLanguage: String(medicalData.usedLanguage || medicalData.language || (forcedFallbackReason ? "English" : "")).trim(),
      usedLanguageCode: String(medicalData.usedLanguageCode || medicalData.languageCode || (forcedFallbackReason ? "en" : "")).trim(),
      fallbackUsed: anyFallbackUsed ? "사용" : "미사용",
      fallbackReason: fallbackReasons.join(" / "),
      errorMessage: [medicalData, helpData].flatMap((data) => Array.isArray(data.attemptErrors) ? data.attemptErrors.map((item) => item.language + ": " + item.message) : []).join(" / "),
      problem: ""
    };
  }

    async function runSingleCountryLanguageTest(country){
    const selectedCountry = devTestCountryPayload(country);
    const languageName = selectedCountry.languageNameEn || selectedCountry.languageNameKo;
    const languageCode = selectedCountry.languageCode;
    const baseRow = {
      status: "실패",
      countryKo: selectedCountry.countryNameKo,
      countryEn: selectedCountry.countryNameEn,
      languageName: selectedCountry.languageNameKo ? selectedCountry.languageNameKo + " / " + selectedCountry.languageNameEn : selectedCountry.languageNameEn,
      languageCode,
      cardTitle: "",
      blankValue: "",
      allergies: "",
      medication: "",
      medicalConditions: "",
      helpPhrase: "",
      usedLanguage: "",
      usedLanguageCode: "",
      fallbackUsed: "",
      fallbackReason: "",
      errorMessage: "",
      problem: ""
    };

    if(!languageName || !languageCode){
      return {...baseRow, problem: "targetLanguage 또는 languageCode 누락"};
    }

    const fields = devTestMedicalFields();
    async function requestMedicalCardAndHelpPhraseForCountry(requestCountry, forcedFallbackReason){
      const medicalRes = await fetch("/.netlify/functions/translate-medical-card", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          countryNameKo: requestCountry.countryNameKo,
          countryNameEn: requestCountry.countryNameEn,
          targetLanguage: requestCountry.languageNameEn,
          targetLanguageCode: requestCountry.languageCode,
          fallbackLanguageNameEn: requestCountry.fallbackLanguageNameEn || "",
          fallbackLanguageCode: requestCountry.fallbackLanguageCode || "",
          selectedCountry: requestCountry,
          medicalCard: {
            name: fields.name,
            passportName: fields.passportName,
            nationality: fields.nationality,
            age: fields.age,
            bloodType: fields.bloodType,
            allergies: fields.allergies,
            medications: fields.medication,
            conditions: fields.medicalConditions,
            emergencyContact: fields.emergencyContact,
            insurance: fields.travelInsurance,
            accommodation: fields.hotelAddress
          },
          fields
        })
      });
      const medicalData = await medicalRes.json().catch(() => ({}));
      if(!medicalRes.ok) throw new Error(medicalData.detail || medicalData.error || "translate-medical-card 실패");

      const helpPhraseKo = phrasePacks.ko && phrasePacks.ko.help ? phrasePacks.ko.help : "도와주세요.";
      const helpRes = await fetch("/.netlify/functions/translate-help-phrases", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          targetLanguage: requestCountry.languageNameEn,
          targetLanguageCode: requestCountry.languageCode,
          fallbackLanguageNameEn: requestCountry.fallbackLanguageNameEn || "",
          fallbackLanguageCode: requestCountry.fallbackLanguageCode || "",
          selectedCountry: requestCountry,
          travelCountry: requestCountry.countryNameKo || requestCountry.countryNameEn,
          phrases: {help: helpPhraseKo}
        })
      });
      const helpData = await helpRes.json().catch(() => ({}));
      if(!helpRes.ok) throw new Error(helpData.detail || helpData.error || "translate-help-phrases 실패");

      return devTestRowFromResponses(baseRow, medicalData, helpData, forcedFallbackReason);
    }

    async function requestEnglishFallback(reason){
      const fallbackCountry = devTestEnglishFallbackCountry(selectedCountry);
      const fallbackRow = await requestMedicalCardAndHelpPhraseForCountry(fallbackCountry, reason);
      return {
        ...fallbackRow,
        fallbackUsed: "사용",
        fallbackReason: fallbackRow.fallbackReason || "공통 fallback: " + reason,
        usedLanguage: fallbackRow.usedLanguage || "English",
        usedLanguageCode: fallbackRow.usedLanguageCode || "en"
      };
    }

    try{
      const fallbackReason = devTestFallbackReason(selectedCountry);
      let row;
      try{
        row = await requestMedicalCardAndHelpPhraseForCountry(selectedCountry, "");
      }catch(primaryError){
        if(devTestBaseLanguage(selectedCountry.languageCode) === "en"){
          throw primaryError;
        }
        row = await requestEnglishFallback(fallbackReason);
      }

      let missing = devTestRequiredMissing(row);
      if(missing.length && devTestBaseLanguage(selectedCountry.languageCode) !== "en"){
        const fallbackRow = await requestEnglishFallback(fallbackReason);
        const fallbackMissing = devTestRequiredMissing(fallbackRow);
        if(!fallbackMissing.length){
          row = fallbackRow;
          missing = [];
        }else{
          row = {
            ...row,
            fallbackUsed: "사용",
            fallbackReason: row.fallbackReason || "공통 fallback: " + fallbackReason,
            errorMessage: [row.errorMessage, "English fallback incomplete: " + fallbackMissing.join(", ")].filter(Boolean).join(" / ")
          };
          missing = fallbackMissing;
        }
      }

      const combined = [row.cardTitle, row.blankValue, row.allergies, row.medication, row.medicalConditions, row.helpPhrase].join("\n");
      const hasEnglishLeak = row.fallbackUsed !== "사용" && hasEnglishFallbackForDevTest(combined, row.usedLanguageCode || selectedCountry.languageCode, row.usedLanguage || selectedCountry.languageNameEn);
      if(missing.length){
        return {...row, status: "실패", problem: missing.join(", ")};
      }
      if(hasEnglishLeak){
        return {...row, status: "확인 필요", problem: "비영어권 결과에 영어 fallback 표현이 남아 있음"};
      }
      const qualityProblems = devTestQualityProblems(row);
      if(qualityProblems.length){
        return {...row, status: "실패", problem: qualityProblems.join(", ")};
      }
      return {...row, status: row.fallbackUsed === "사용" ? "통과 fallback" : "통과", problem: row.fallbackUsed === "사용" ? "fallback 언어로 표시됨" : "정상"};
    }catch(error){
      return {...baseRow, status: "실패", errorMessage: error && error.message ? error.message : "오류 메시지 발생", problem: error && error.message ? error.message : "오류 메시지 발생"};
    }
  }

    async function runAllLanguageTest(mode){
    const status = $("sos-dev-test-status");
    const targets = devTestTargets(mode);
    const modeLabel = mode === "priority" ? "우선 지원 국가/지역" : mode === "all" ? "전체 국가/지역" : "대표 언어별";
    const rows = [];
    if(status){
      status.classList.remove("hidden");
      status.textContent = modeLabel + " 테스트를 시작합니다. 0 / " + targets.length;
    }
    renderDevTestRows(rows);
    for(let i = 0; i < targets.length; i++){
      rows.push(await runSingleCountryLanguageTest(targets[i]));
      renderDevTestRows(rows);
      if(status) status.textContent = modeLabel + " 테스트 진행 중: " + (i + 1) + " / " + targets.length;
    }
    if(status){
      const failed = rows.filter((row) => row.status === "실패").length;
      const review = rows.filter((row) => row.status === "확인 필요").length;
      const fallbackPassed = rows.filter((row) => row.status === "통과 fallback").length;
      status.textContent = "테스트 완료: 총 " + rows.length + "개 · 통과 fallback " + fallbackPassed + "개 · 확인 필요 " + review + "개 · 실패 " + failed + "개";
    }
  }

    function runRepresentativeLanguageTests(){
      return runAllLanguageTest("representative");
    }

    function runPriorityCountryTests(){
      return runAllLanguageTest("priority");
    }

    function runAllCountryRegionTests(){
      return runAllLanguageTest("all");
    }

    const prescriptionSourceKo = String(context.prescriptionSourceKo || "처방전이 필요합니다.");
    const prescriptionStatements = context.prescriptionStatements && typeof context.prescriptionStatements === "object"
      ? context.prescriptionStatements
      : {};
    const prescriptionHumanReviewCodes = new Set(["he", "hi", "km", "lo", "mt", "my", "si"]);

    function prescriptionAuditTargets(){
      const seen = new Set();
      return priorityLanguageOptions.filter((country) => {
        const code = String(country && country.languageCode || "").trim().toLowerCase();
        if(!code || seen.has(code)) return false;
        seen.add(code);
        return true;
      });
    }

    function prescriptionStatementForAudit(languageCode){
      const normalized = String(languageCode || "").trim().toLowerCase();
      return String(prescriptionStatements[normalized] || prescriptionStatements[normalized.split("-")[0]] || "").trim();
    }

    function evaluatePrescriptionPhrase(country){
      const languageCode = String(country && country.languageCode || "").trim().toLowerCase();
      const localPhraseLocal = prescriptionStatementForAudit(languageCode);
      const blockReasons = [];
      const reviewReasons = [];
      if(prescriptionSourceKo !== "처방전이 필요합니다.") blockReasons.push("한국어 원문이 지정된 선언문과 다름");
      if(!localPhraseLocal) blockReasons.push("대표 언어 문장이 없음");
      if(/[?？¿؟]/.test(localPhraseLocal)) blockReasons.push("의문문 문장부호가 남아 있음");
      if(languageCode === "ko" && localPhraseLocal !== "처방전이 필요합니다.") blockReasons.push("한국어 문장 불일치");
      if(languageCode === "en" && localPhraseLocal !== "I need a prescription.") blockReasons.push("영어 문장 불일치");
      if(prescriptionHumanReviewCodes.has(languageCode)) reviewReasons.push("의료 현장 표현의 자연스러움 원어민 검수 권장");
      return {
        country: [country.countryNameKo || country.countryKo, country.countryNameEn || country.country].filter(Boolean).join(" / "),
        languageName: [country.languageNameKo || country.languageKo, country.languageNameEn].filter(Boolean).join(" / "),
        languageCode,
        title: "처방전 필요",
        localPhraseKo: prescriptionSourceKo,
        localPhraseLocal,
        status: blockReasons.length ? "BLOCK" : reviewReasons.length ? "HUMAN_REVIEW" : "PASS",
        reason: blockReasons.concat(reviewReasons).join(" / ") || "1인칭 선언문 정적 검증 통과"
      };
    }

    function renderPrescriptionAuditRows(rows){
      const tbody = $("sos-prescription-audit-rows");
      if(!tbody) return;
      tbody.innerHTML = rows.map((row) => {
        const color = row.status === "PASS" ? "#047857" : row.status === "HUMAN_REVIEW" ? "#b45309" : "#b91c1c";
        return '<tr>'+
          '<td style="padding:8px;border:1px solid var(--border);font-weight:950;color:'+color+'">'+escapeHtml(row.status)+'</td>'+
          devTestCell(row.country)+devTestCell(row.languageName)+devTestCell(row.languageCode)+devTestCell(row.title)+
          devTestCell(row.localPhraseKo)+devTestCell(row.localPhraseLocal)+devTestCell(row.reason)+
        '</tr>';
      }).join("");
    }

    function runPrescriptionPhraseMockAudit(){
      const rows = prescriptionAuditTargets().map(evaluatePrescriptionPhrase);
      renderPrescriptionAuditRows(rows);
      const passed = rows.filter((row) => row.status === "PASS").length;
      const review = rows.filter((row) => row.status === "HUMAN_REVIEW").length;
      const blocked = rows.filter((row) => row.status === "BLOCK").length;
      const summary = $("sos-prescription-audit-summary");
      if(summary) summary.textContent = "처방전 문장 모의 검사: 총 "+rows.length+"개 · PASS "+passed+"개 · HUMAN_REVIEW "+review+"개 · BLOCK "+blocked+"개";
      return rows;
    }

    function createPrescriptionPhraseAuditPanel(){
      if($("sos-prescription-audit-panel")) return;
      const panel = $("sos-dev-test-panel");
      if(!panel) return;
      panel.insertAdjacentHTML("beforeend",
        '<section id="sos-prescription-audit-panel" class="card" style="margin-top:18px">'+
          '<p class="eyebrow" style="margin-bottom:6px">Pharmacy Phrase QA</p>'+
          '<h2 style="margin-top:0">처방전 문장 의미 검사</h2>'+
          '<p class="small muted" style="line-height:1.6">62개 우선 국가의 고유 대표 언어를 API 호출 없이 검사합니다. 제목·한국어 원문·현지어 문장과 PASS / HUMAN_REVIEW / BLOCK 판정을 함께 표시합니다.</p>'+
          '<button id="run-prescription-phrase-mock-test" class="btn outline w-full" type="button">처방전 문장 모의 검사 실행</button>'+
          '<div id="sos-prescription-audit-summary" class="notice teal small" style="margin-top:12px">처방전 문장 모의 검사: 아직 실행하지 않음</div>'+
          '<div style="overflow:auto;margin-top:12px">'+
            '<table style="width:100%;border-collapse:collapse;min-width:1040px;font-size:12px">'+
              '<thead><tr style="background:#f8fafc;color:var(--navy);text-align:left">'+
                '<th style="padding:9px;border:1px solid var(--border)">판정</th><th style="padding:9px;border:1px solid var(--border)">국가</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">언어명</th><th style="padding:9px;border:1px solid var(--border)">languageCode</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">제목</th><th style="padding:9px;border:1px solid var(--border)">localPhraseKo</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">localPhraseLocal</th><th style="padding:9px;border:1px solid var(--border)">이유</th>'+
              '</tr></thead><tbody id="sos-prescription-audit-rows"></tbody>'+
            '</table>'+
          '</div>'+
        '</section>'
      );
    }

    function bindPrescriptionPhraseAuditButton(){
      const button = $("run-prescription-phrase-mock-test");
      if(button) button.addEventListener("click", runPrescriptionPhraseMockAudit);
    }

    window.SOS_BRIDGE_PRESCRIPTION_AUDIT_DEV = {
      targets: prescriptionAuditTargets,
      evaluate: evaluatePrescriptionPhrase,
      runMock: runPrescriptionPhraseMockAudit
    };

    const emergencyAuditCodes = ["ZA","LA","SA","MM","ID","KH","PE"];
    const emergencyExpected = {
      ZA:{primary:"112", ambulance:"10177"},
      LA:{primary:"1195", ambulance:"1195", alternates:["0305257239","1623","02056668825"]},
      SA:{primary:"911", ambulance:"997"},
      MM:{primary:"192", ambulance:"192", warning:true},
      ID:{primary:"119", ambulance:"119", alternates:["118"]},
      KH:{primary:"119", ambulance:"119", status:"verified-conditional", scope:true, warning:true},
      PE:{primary:"106", ambulance:"106", scope:true}
    };
    const emergencyNormalize = typeof context.normalizeEmergencyDialNumber === "function"
      ? context.normalizeEmergencyDialNumber
      : (value) => {
        const text = String(value || "").trim();
        if(!text || /\s*(?:\/|,|;|\||또는|\bor\b)\s*/i.test(text)) return "";
        const number = text.replace(/[^\d+]/g, "");
        return /^\+?\d+$/.test(number) ? number : "";
      };
    const emergencyDialNumber = typeof context.getEmergencyDialNumber === "function"
      ? context.getEmergencyDialNumber
      : (country, type, alternateIndex=0) => {
        const data = country && country.emergencyNumbers || {};
        const value = type === "alternate"
          ? (Array.isArray(data.alternates) && data.alternates[alternateIndex] && data.alternates[alternateIndex].number)
          : data[type];
        return emergencyNormalize(value);
      };

    function emergencyAuditTargets(){
      return emergencyAuditCodes.map((code) => languageOptions.find((country) => String(country && country.countryCode || "").toUpperCase() === code)).filter(Boolean);
    }

    function evaluateEmergencyNumberData(country){
      const code = String(country && country.countryCode || "").toUpperCase();
      const data = country && country.emergencyNumbers || {};
      const expected = emergencyExpected[code] || {};
      const reasons = [];
      const primaryDial = emergencyDialNumber(country, "primary");
      const ambulanceDial = emergencyDialNumber(country, "ambulance");
      const alternateDialers = (Array.isArray(data.alternates) ? data.alternates : []).map((item, index) => emergencyDialNumber(country, "alternate", index));
      const allDialers = [primaryDial, ambulanceDial].concat(alternateDialers).filter(Boolean);
      const dataText = JSON.stringify(data);

      if(primaryDial !== expected.primary) reasons.push("primary 불일치");
      if(ambulanceDial !== expected.ambulance) reasons.push("ambulance 불일치");
      (expected.alternates || []).forEach((number) => {
        if(!alternateDialers.includes(number)) reasons.push("alternate 누락: "+number);
      });
      if(expected.warning && !String(data.warningKo || "").trim()) reasons.push("warningKo 없음");
      if(expected.scope && !String(data.scopeKo || "").trim()) reasons.push("scopeKo 없음");
      if(expected.status && data.status !== expected.status) reasons.push("status 불일치");
      if(code === "ID" && String(country.emergencyNumber || "") !== "119") reasons.push("legacy emergencyNumber가 119가 아님");
      if(code === "PE" && !(Array.isArray(data.serviceAreas) && data.serviceAreas.length)) reasons.push("SAMU 지원 지역 없음");
      if(code === "LA" && /1624/.test(dataText)) reasons.push("금지 번호 1624 존재");
      if(code === "KH" && !/프놈펜/.test(String(data.scopeKo || ""))) reasons.push("프놈펜 이용 범위 안내 없음");
      if(code === "KH" && /전국(?:에서)?\s*(?:공통|동일|항상)|nationwide\s+(?:service|coverage|availability)/i.test(dataText)) reasons.push("이용 범위 보장 문구 존재");
      if(/undefined|null/.test([data.primary,data.ambulance].join(" "))) reasons.push("undefined/null 문구 존재");
      if(allDialers.some((number) => !/^\+?\d+$/.test(number))) reasons.push("tel 번호에 설명 문자 존재");
      if(allDialers.some((number) => /[\/,;|]/.test(number))) reasons.push("tel 번호에 복수 번호 구분자 존재");
      if(emergencyNormalize("112 / 10177") !== "") reasons.push("복수 번호 정규화 차단 실패");
      if(emergencyNormalize("030 525 7239") !== "0305257239") reasons.push("공백 번호 정규화 실패");
      if(emergencyNormalize("112(휴대전화)") !== "112") reasons.push("설명 포함 단일 번호 정규화 실패");

      return {
        code,
        country:country.countryNameKo || country.countryKo || code,
        primary:data.primary || "",
        ambulance:data.ambulance || "",
        alternates:(Array.isArray(data.alternates) ? data.alternates : []).map((item) => (item.labelKo || "보조")+" "+item.number).join(" / "),
        primaryDial,
        ambulanceDial,
        status:data.status || "",
        condition:[data.scopeKo,data.warningKo].filter(Boolean).join(" "),
        result:reasons.length ? "BLOCK" : "PASS",
        reason:reasons.join(" / ") || "역할별 번호·조건·tel 계약 통과"
      };
    }

    function renderEmergencyNumberAuditRows(rows){
      const tbody = $("sos-emergency-number-audit-rows");
      if(!tbody) return;
      tbody.innerHTML = rows.map((row) => {
        const color = row.result === "PASS" ? "#047857" : "#b91c1c";
        return '<tr>'+
          '<td style="padding:8px;border:1px solid var(--border);font-weight:950;color:'+color+'">'+escapeHtml(row.result)+'</td>'+
          devTestCell(row.code)+devTestCell(row.country)+devTestCell(row.primary)+devTestCell(row.ambulance)+devTestCell(row.alternates)+
          devTestCell(row.primaryDial)+devTestCell(row.ambulanceDial)+devTestCell(row.status)+devTestCell(row.condition)+devTestCell(row.reason)+
        '</tr>';
      }).join("");
    }

    function runEmergencyNumberMockAudit(){
      const rows = emergencyAuditTargets().map(evaluateEmergencyNumberData);
      renderEmergencyNumberAuditRows(rows);
      const blocked = rows.filter((row) => row.result === "BLOCK").length;
      const summary = $("sos-emergency-number-audit-summary");
      if(summary) summary.textContent = "응급번호 정적 검사: 총 "+rows.length+"개 · PASS "+(rows.length-blocked)+"개 · BLOCK "+blocked+"개 · 실제 전화 0회";
      return rows;
    }

    function createEmergencyNumberAuditPanel(){
      const panel = $("sos-dev-test-panel");
      if(!panel || $("sos-emergency-number-audit-panel")) return;
      panel.insertAdjacentHTML("beforeend",
        '<section id="sos-emergency-number-audit-panel" class="card" style="margin-top:18px">'+
          '<p class="eyebrow" style="margin-bottom:6px">Emergency Number QA</p>'+
          '<h2 style="margin-top:0">7개국 의료 응급번호 역할 검사</h2>'+
          '<p class="small muted" style="line-height:1.6">countries.js의 역할별 번호와 tel 정규화 반환값만 검사합니다. 실제 전화 앱이나 외부 API를 열지 않습니다.</p>'+
          '<button id="run-emergency-number-mock-test" class="btn outline w-full" type="button">응급번호 정적 검사 실행</button>'+
          '<div id="sos-emergency-number-audit-summary" class="notice teal small" style="margin-top:12px">응급번호 정적 검사: 아직 실행하지 않음</div>'+
          '<div style="overflow:auto;margin-top:12px">'+
            '<table style="width:100%;border-collapse:collapse;min-width:1380px;font-size:12px">'+
              '<thead><tr style="background:#f8fafc;color:var(--navy);text-align:left">'+
                '<th style="padding:9px;border:1px solid var(--border)">판정</th><th style="padding:9px;border:1px solid var(--border)">코드</th><th style="padding:9px;border:1px solid var(--border)">국가</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">primary</th><th style="padding:9px;border:1px solid var(--border)">ambulance</th><th style="padding:9px;border:1px solid var(--border)">alternates</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">primary tel</th><th style="padding:9px;border:1px solid var(--border)">ambulance tel</th><th style="padding:9px;border:1px solid var(--border)">상태</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">조건·주의</th><th style="padding:9px;border:1px solid var(--border)">결과</th>'+
              '</tr></thead><tbody id="sos-emergency-number-audit-rows"></tbody>'+
            '</table>'+
          '</div>'+
        '</section>'
      );
    }

    function bindEmergencyNumberAuditButton(){
      const button = $("run-emergency-number-mock-test");
      if(button) button.addEventListener("click", runEmergencyNumberMockAudit);
    }

    window.SOS_BRIDGE_EMERGENCY_NUMBER_AUDIT_DEV = {
      targets: emergencyAuditTargets,
      evaluate: evaluateEmergencyNumberData,
      runMock: runEmergencyNumberMockAudit
    };

    const countryListCardAuditCodes = ["FR","ZA","SA","LV","AR","ID","LA","MM","KH","PE","LK","IE","GB"];
    const countryListCardExpected = {
      FR:{number:"15", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      ZA:{number:"10177", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      SA:{number:"997", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      LV:{number:"113", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      AR:{number:"107", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      ID:{number:"119", label:"의료", additional:"추가 연락처", status:"정식"},
      LA:{number:"1195", label:"구급차", additional:"추가 연락처", status:"조건부", conditional:true},
      MM:{number:"192", label:"구급차", additional:"", status:"조건부", conditional:true},
      KH:{number:"119", label:"구급차", additional:"", status:"조건부", conditional:true},
      PE:{number:"106", label:"SAMU", additional:"", status:"조건부", conditional:true},
      LK:{number:"1990", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      IE:{number:"112", label:"구급차", additional:"추가 긴급번호", status:"정식"},
      GB:{number:"999", label:"구급차", additional:"추가 긴급번호", status:"정식"}
    };
    const countryListDisplay = typeof context.getCountryListEmergencyDisplay === "function"
      ? context.getCountryListEmergencyDisplay
      : () => ({main:"응급번호 확인 필요", number:"", label:"", additionalBadgeLabel:"", statusLabel:"확인 필요", compactNotice:""});
    const countryListDial = typeof context.getCountryEmergencyDialNumber === "function"
      ? context.getCountryEmergencyDialNumber
      : (country) => countryListDisplay(country).number;

    function countryListCardAuditTargets(){
      return countryListCardAuditCodes.map((code) => languageOptions.find((country) => String(country && country.countryCode || "").toUpperCase() === code)).filter(Boolean);
    }

    function evaluateCountryListCard(country){
      const code = String(country && country.countryCode || "").toUpperCase();
      const expected = countryListCardExpected[code] || {};
      const display = countryListDisplay(country);
      const dial = countryListDial(country, "ambulance");
      const reasons = [];
      const badgeCount = 1 + (display.additionalBadgeLabel ? 1 : 0);
      const numericTokens = String(display.main || "").match(/\d+/g) || [];
      const displayText = JSON.stringify(display);

      if(display.number !== expected.number) reasons.push("대표 번호 불일치");
      if(display.number !== dial) reasons.push("목록 번호와 ambulance resolver 불일치");
      if(expected.label && display.label !== expected.label) reasons.push("번호 라벨 불일치");
      if(display.additionalBadgeLabel !== expected.additional) reasons.push("추가 번호 badge 불일치");
      if(display.statusLabel !== expected.status) reasons.push("상태 badge 불일치");
      if(Boolean(display.conditional) !== Boolean(expected.conditional)) reasons.push("조건부 상태 불일치");
      if(/[\/,;|()]/.test(String(display.number || ""))) reasons.push("대표 번호에 복합 문자열 존재");
      if(/undefined|null/.test(String(display.number))) reasons.push("대표 번호에 undefined/null 존재");
      if(/\d/.test(String(display.additionalBadgeLabel || ""))) reasons.push("추가 번호 badge에 숫자 존재");
      if(numericTokens.length > 1) reasons.push("목록 main에 두 번째 번호 존재");
      if(badgeCount > 2) reasons.push("badge 2개 초과");
      if(String(display.compactNotice || "").length > 12) reasons.push("compactNotice 길이 초과");
      if(/scopeKo|warningKo|serviceAreas|sourceUrl|lastVerified/.test(displayText)) reasons.push("상세 데이터가 목록 formatter에 포함됨");

      return {
        result:reasons.length ? "BLOCK" : "PASS",
        code,
        country:country.countryNameKo || country.countryKo || code,
        label:display.label || "",
        number:display.number || "응급번호 확인 필요",
        additional:display.additionalBadgeLabel || "없음",
        compactNotice:display.compactNotice || "없음",
        status:display.statusLabel || "",
        dial:dial || "없음",
        reason:reasons.join(" / ") || "단일 대표 번호·badge·resolver 계약 통과"
      };
    }

    function renderCountryListCardAuditRows(rows){
      const tbody = $("sos-country-list-card-audit-rows");
      if(!tbody) return;
      tbody.innerHTML = rows.map((row) => {
        const color = row.result === "PASS" ? "#047857" : "#b91c1c";
        return '<tr>'+
          '<td style="padding:8px;border:1px solid var(--border);font-weight:950;color:'+color+'">'+escapeHtml(row.result)+'</td>'+
          devTestCell(row.code)+devTestCell(row.country)+devTestCell(row.label)+devTestCell(row.number)+devTestCell(row.additional)+
          devTestCell(row.compactNotice)+devTestCell(row.status)+devTestCell(row.dial)+devTestCell(row.reason)+
        '</tr>';
      }).join("");
    }

    function runCountryListCardAudit(){
      const rows = countryListCardAuditTargets().map(evaluateCountryListCard);
      renderCountryListCardAuditRows(rows);
      const blocked = rows.filter((row) => row.result === "BLOCK").length;
      const summary = $("sos-country-list-card-audit-summary");
      if(summary) summary.textContent = "국가 목록 카드 검사: 총 "+rows.length+"개 · PASS "+(rows.length-blocked)+"개 · BLOCK "+blocked+"개 · 실제 전화 0회";
      return rows;
    }

    const popularCountryAuditCodes = Array.isArray(context.popularCountryCodes)
      ? context.popularCountryCodes.slice()
      : ["JP","US","TH","VN","CN","FR","GB","AU"];

    function rectsOverlap(first, second){
      if(!first || !second) return false;
      return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
        * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)) > 0.25;
    }

    function runPopularCountryCompactAudit(){
      const input = $("languageSearch");
      const toggle = $("toggleAllCountriesBtn");
      const scroll = $("countrySelectScroll");
      const popularGrid = $("countryQuickGrid");
      const popularState = $("popularCountrySection");
      const detailedGrid = $("languageGrid");
      const panel = $("screen-country-select");
      const appShell = $("languagePage");
      const devPanel = $("sos-dev-test-panel");
      const originalDevPanelDisplay = devPanel ? devPanel.style.display : "";
      const originalQuery = input ? input.value : "";
      const originalExpanded = toggle ? toggle.getAttribute("aria-expanded") : "false";
      const reasons = [];

      if(devPanel) devPanel.style.display = "none";

      if(input) input.value = "";
      if(toggle) toggle.setAttribute("aria-expanded", "false");
      if(input) input.dispatchEvent(new Event("input", {bubbles:true}));

      const compactCards = popularGrid ? [...popularGrid.querySelectorAll('[data-card-variant="compact"]')] : [];
      const compactCodes = compactCards.map((card) => card.getAttribute("data-country-code"));
      const gridColumns = popularGrid ? getComputedStyle(popularGrid).gridTemplateColumns.split(" ").filter(Boolean) : [];
      const compactRects = compactCards.map((card) => card.getBoundingClientRect());
      const panelRect = panel ? panel.getBoundingClientRect() : null;
      const popularStateRect = popularState ? popularState.getBoundingClientRect() : null;
      const popularGridRect = popularGrid ? popularGrid.getBoundingClientRect() : null;
      const toggleRect = toggle ? toggle.getBoundingClientRect() : null;
      const appShellRect = appShell ? appShell.getBoundingClientRect() : null;
      const visualViewportHeight = Number(window.visualViewport?.height) || window.innerHeight || 0;
      const viewportBand = document.documentElement.dataset.viewportHeightBand || "";
      const compactRows = new Set(compactRects.map((rect) => Math.round(rect.top))).size;
      const compactOverlap = compactRects.some((rect, index) => compactRects.slice(index + 1).some((other) => rectsOverlap(rect, other)));
      const compactButtonOverlap = toggleRect ? compactRects.some((rect) => rectsOverlap(rect, toggleRect)) : true;
      const lastCompactBottom = compactRects.length ? Math.max(...compactRects.map((rect) => rect.bottom)) : Infinity;
      const textOutside = compactCards.some((card) => {
        const cardRect = card.getBoundingClientRect();
        return [...card.querySelectorAll(".country-card__name-ko,.country-card__name-en")].some((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < cardRect.left - 0.5 || rect.right > cardRect.right + 0.5 || rect.top < cardRect.top - 0.5 || rect.bottom > cardRect.bottom + 0.5;
        });
      });

      if(JSON.stringify(compactCodes) !== JSON.stringify(popularCountryAuditCodes)) reasons.push("인기 국가 코드 또는 순서 불일치");
      if(compactCards.length !== 8) reasons.push("compact 카드 8개 아님");
      if(gridColumns.length !== 2) reasons.push("초기 grid 2열 아님");
      if(compactRows !== 4) reasons.push("초기 grid 4행 아님");
      if(compactCards.some((card) => card.querySelector(".country-option-card__emergency,[data-list-emergency-number]"))) reasons.push("compact 카드에 응급번호 DOM 존재");
      if(compactCards.some((card) => card.querySelector(".country-option-card__status,.support-badge"))) reasons.push("compact 카드에 상태 badge 존재");
      if(compactCards.some((card) => card.querySelector(".country-option-card__meta,.country-option-card__meta-badge"))) reasons.push("compact 카드에 추가 번호 badge 존재");
      if(compactCards.some((card) => !card.querySelector(".country-card__flag") || !card.querySelector(".country-card__name-ko") || !card.querySelector(".country-card__name-en") || !card.getAttribute("data-country-code"))) reasons.push("compact 필수 국가 정보 누락");
      if(compactOverlap) reasons.push("compact 카드 겹침");
      if(compactButtonOverlap) reasons.push("compact 카드와 전체 목록 버튼 겹침");
      if(textOutside) reasons.push("compact 카드 텍스트 이탈");
      if(scroll && scroll.scrollHeight > scroll.clientHeight + 1) reasons.push("초기 화면 내부 스크롤 필요");
      if(popularGrid && popularGrid.scrollHeight > popularGrid.clientHeight + 1) reasons.push("popular grid 내부 스크롤 필요");
      if(popularState && popularState.scrollHeight > popularState.clientHeight + 1) reasons.push("popular state 내부 스크롤 필요");
      if(panel && panel.scrollHeight > panel.clientHeight + 1) reasons.push("국가 선택 panel 높이 초과");
      if(document.body.scrollHeight > document.body.clientHeight + 1 || document.documentElement.scrollHeight > document.documentElement.clientHeight + 1) reasons.push("body vertical scroll range 존재");
      if(!toggle || toggle.hidden || !toggleRect || toggleRect.width <= 0 || toggleRect.height < 44) reasons.push("전체 목록 버튼 크기 또는 표시 상태 오류");
      if(toggleRect && panelRect && toggleRect.bottom > panelRect.bottom + 0.5) reasons.push("전체 목록 버튼 panel 하단 초과");
      if(toggleRect && visualViewportHeight && toggleRect.bottom > visualViewportHeight + 0.5) reasons.push("전체 목록 버튼 visual viewport 하단 초과");
      if(toggleRect && lastCompactBottom >= toggleRect.top - 0.5) reasons.push("마지막 카드와 전체 목록 버튼 간격 없음");
      if(appShellRect && visualViewportHeight && appShellRect.height > visualViewportHeight + 1) reasons.push("app shell이 visual viewport보다 큼");
      if(visualViewportHeight && visualViewportHeight < 680 && viewportBand !== "short") reasons.push("short viewport band 미적용");
      if(document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1) reasons.push("가로 overflow 존재");

      if(input){
        input.value = "FR";
        input.dispatchEvent(new Event("input", {bubbles:true}));
      }
      const searchCards = detailedGrid ? [...detailedGrid.querySelectorAll('[data-card-variant="detailed"]')] : [];
      if(searchCards.length !== 1 || searchCards[0].getAttribute("data-country-code") !== "FR") reasons.push("검색 detailed 카드 회귀");
      if(searchCards.length && (!searchCards[0].querySelector(".country-option-card__emergency-number") || !searchCards[0].querySelector(".country-option-card__status"))) reasons.push("검색 detailed 정보 누락");
      if(scroll && !["auto","scroll"].includes(getComputedStyle(scroll).overflowY)) reasons.push("검색 결과 내부 스크롤 비활성");
      if(toggle && !toggle.hidden) reasons.push("검색 중 전체 목록 버튼 미숨김");

      if(input){
        input.value = "";
        input.dispatchEvent(new Event("input", {bubbles:true}));
      }
      const restoredCards = popularGrid ? [...popularGrid.querySelectorAll('[data-card-variant="compact"]')] : [];
      if(restoredCards.length !== 8 || (scroll && scroll.scrollTop !== 0) || (toggle && toggle.hidden)) reasons.push("검색 해제 후 compact 또는 버튼 복원 실패");

      if(toggle) toggle.click();
      const fullCards = detailedGrid ? [...detailedGrid.querySelectorAll('[data-card-variant="detailed"]')] : [];
      if(fullCards.length !== 62) reasons.push("전체 목록 detailed 카드 62개 아님");
      if(scroll && scroll.scrollHeight <= scroll.clientHeight + 1) reasons.push("전체 목록 내부 스크롤 미동작");
      if(popularGrid && getComputedStyle(popularGrid).display !== "none") reasons.push("전체 목록에서 popular grid 미숨김");
      if(toggle) toggle.click();

      if(input) input.value = originalQuery;
      if(toggle) toggle.setAttribute("aria-expanded", originalExpanded || "false");
      if(input) input.dispatchEvent(new Event("input", {bubbles:true}));
      if(devPanel) devPanel.style.display = originalDevPanelDisplay;

      const result = {
        result:reasons.length ? "BLOCK" : "PASS",
        compactCount:compactCards.length,
        codes:compactCodes,
        columns:gridColumns.length,
        rows:compactRows,
        compactOverlap:Number(compactOverlap),
        compactButtonOverlap:Number(compactButtonOverlap),
        textOutside:Number(textOutside),
        initialScrollNeeded:scroll ? Number(scroll.scrollHeight > scroll.clientHeight + 1) : 1,
        panelScrollNeeded:panel ? Number(panel.scrollHeight > panel.clientHeight + 1) : 1,
        popularGridScrollNeeded:popularGrid ? Number(popularGrid.scrollHeight > popularGrid.clientHeight + 1) : 1,
        popularStateScrollNeeded:popularState ? Number(popularState.scrollHeight > popularState.clientHeight + 1) : 1,
        toggleRect:toggleRect ? {top:toggleRect.top,bottom:toggleRect.bottom,width:toggleRect.width,height:toggleRect.height} : null,
        panelRect:panelRect ? {top:panelRect.top,bottom:panelRect.bottom,height:panelRect.height} : null,
        popularStateRect:popularStateRect ? {top:popularStateRect.top,bottom:popularStateRect.bottom,height:popularStateRect.height} : null,
        popularGridRect:popularGridRect ? {top:popularGridRect.top,bottom:popularGridRect.bottom,height:popularGridRect.height} : null,
        visualViewportHeight,
        appShellHeight:appShellRect ? appShellRect.height : 0,
        viewportBand,
        searchDetailedCount:searchCards.length,
        restoredCompactCount:restoredCards.length,
        fullDetailedCount:fullCards.length,
        reasons
      };
      const summary = $("sos-popular-country-audit-summary");
      if(summary) summary.textContent = "인기 국가 compact 검사: "+result.result+" · 카드 "+result.compactCount+"개 · "+result.columns+"열×"+result.rows+"행 · 카드/버튼 겹침 "+result.compactButtonOverlap+" · panel 스크롤 "+result.panelScrollNeeded+" · band "+result.viewportBand+" · 검색 detailed "+result.searchDetailedCount+"개 · 전체 detailed "+result.fullDetailedCount+"개 · 실제 전화 0회"+(result.reasons.length ? " · 사유: "+result.reasons.join(" / ") : "");
      return result;
    }

    const compoundEmergencySeparatorPattern = /\s*(?:\/|,|;|\||또는|\bor\b)\s*/i;
    const emergencyDialNumberCandidates = typeof context.emergencyDialNumberCandidates === "function"
      ? context.emergencyDialNumberCandidates
      : (value) => [String(value || "").trim()].filter(Boolean);
    const resolveEmergencyDialNumberValue = typeof context.resolveEmergencyDialNumberValue === "function"
      ? context.resolveEmergencyDialNumberValue
      : context.normalizeEmergencyDialNumber;

    function emergencyNumberFieldEntries(country){
      const data = context.getEmergencyNumbersData(country) || {};
      const rows = [
        {path:"emergencyNumber", value:country && country.emergencyNumber},
        {path:"emergencyNumbers.primary", value:data.primary},
        {path:"emergencyNumbers.ambulance", value:data.ambulance},
        {path:"emergencyNumbers.police", value:data.police},
        {path:"emergencyNumbers.fire", value:data.fire}
      ];
      const alternates = Array.isArray(data.alternates) ? data.alternates : [];
      alternates.forEach((entry, index) => rows.push({
        path:"emergencyNumbers.alternates["+index+"].number",
        value:entry && entry.number
      }));
      return rows.filter((row) => typeof row.value === "string" && /\d/.test(row.value));
    }

    function previousSingleNumberCountryDial(country, type="ambulance"){
      const data = context.getEmergencyNumbersData(country) || {};
      const values = type === "ambulance"
        ? [data.ambulance, data.primary, country && country.emergencyNumber]
        : [data.primary, data.ambulance, country && country.emergencyNumber];
      for(const value of values){
        const normalized = context.normalizeEmergencyDialNumber(value);
        if(normalized) return normalized;
      }
      return "";
    }

    function runCompoundEmergencyNumberAudit(){
      const priorityCodes = new Set(context.priorityCountryCodes || []);
      const compoundRows = [];
      const validButUnavailable = [];
      const representativeDelimiterErrors = [];
      const listResolverMismatches = [];
      const singleNumberRegressions = [];
      const spacedNumberSplitErrors = [];

      languageOptions.forEach((country) => {
        const code = String(country && country.countryCode || "").toUpperCase();
        const data = context.getEmergencyNumbersData(country) || {};
        const display = countryListDisplay(country);
        const dial = countryListDial(country, "ambulance");
        const fields = emergencyNumberFieldEntries(country);

        fields.forEach((field) => {
          if(compoundEmergencySeparatorPattern.test(field.value)){
            compoundRows.push({
              code,
              priority:priorityCodes.has(code),
              path:field.path,
              original:field.value,
              fieldRepresentative:resolveEmergencyDialNumberValue(field.value),
              countryRepresentative:dial
            });
          }else if(/\s/.test(field.value)){
            const candidates = emergencyDialNumberCandidates(field.value);
            if(candidates.length !== 1 || resolveEmergencyDialNumberValue(field.value) !== context.normalizeEmergencyDialNumber(field.value)){
              spacedNumberSplitErrors.push(code+":"+field.path);
            }
          }
        });

        const hasValidCandidate = [data.ambulance, data.primary, country && country.emergencyNumber]
          .some((value) => Boolean(resolveEmergencyDialNumberValue(value)));
        if(data.status !== "needs-verification" && hasValidCandidate && !display.number) validButUnavailable.push(code);
        if(compoundEmergencySeparatorPattern.test(String(display.number || ""))) representativeDelimiterErrors.push(code);
        if(display.number !== dial) listResolverMismatches.push(code);

        const previousDial = previousSingleNumberCountryDial(country, "ambulance");
        if(previousDial && previousDial !== dial) singleNumberRegressions.push(code+":"+previousDial+"→"+dial);
      });

      const byCode = (code) => languageOptions.find((country) => String(country && country.countryCode || "").toUpperCase() === code);
      const required = [
        {code:"IE", number:"112", original:"112 / 999"},
        {code:"GB", number:"999", original:"999 / 112"},
        {code:"LK", number:"1990", original:"011 2691111 / 1990"}
      ].map((target) => {
        const country = byCode(target.code);
        const data = context.getEmergencyNumbersData(country) || {};
        const display = countryListDisplay(country);
        const dial = countryListDial(country, "ambulance");
        const detailOriginal = String(data.ambulance || country && country.emergencyNumber || "");
        return {
          code:target.code,
          pass:display.number === target.number && dial === target.number && display.additionalBadgeLabel === "추가 긴급번호" && detailOriginal === target.original,
          display:display.number,
          dial,
          detailOriginal,
          additional:display.additionalBadgeLabel
        };
      });

      const parserFixtureFailures = [
        {raw:"030 525 7239", expected:"0305257239", count:1},
        {raw:"011 2691111", expected:"0112691111", count:1},
        {raw:"020 5666 8825", expected:"02056668825", count:1},
        {raw:"+44 999", expected:"+44999", count:1},
        {raw:"112 / 999", expected:"112", count:2},
        {raw:"999 or 112", expected:"999", count:2},
        {raw:"112, 999", expected:"112", count:2},
        {raw:"112 또는 999", expected:"112", count:2}
      ].filter((fixture) => resolveEmergencyDialNumberValue(fixture.raw) !== fixture.expected || emergencyDialNumberCandidates(fixture.raw).length !== fixture.count);

      const blocked = validButUnavailable.length + representativeDelimiterErrors.length + listResolverMismatches.length + singleNumberRegressions.length + spacedNumberSplitErrors.length + parserFixtureFailures.length + required.filter((row) => !row.pass).length;
      const result = {
        result:blocked ? "BLOCK" : "PASS",
        compoundFieldCount:compoundRows.length,
        compoundCountryCount:new Set(compoundRows.map((row) => row.code)).size,
        priorityCompoundCountries:[...new Set(compoundRows.filter((row) => row.priority).map((row) => row.code))],
        validButUnavailable,
        priorityValidButUnavailable:validButUnavailable.filter((code) => priorityCodes.has(code)),
        representativeDelimiterErrors,
        priorityRepresentativeDelimiterErrors:representativeDelimiterErrors.filter((code) => priorityCodes.has(code)),
        listResolverMismatches,
        priorityListResolverMismatches:listResolverMismatches.filter((code) => priorityCodes.has(code)),
        singleNumberRegressions,
        spacedNumberSplitErrors,
        parserFixtureFailures,
        required,
        rows:compoundRows,
        actualCalls:0
      };

      const summary = $("sos-compound-number-audit-summary");
      if(summary){
        summary.textContent = "복합 응급번호 전수 검사: "+result.result+" · "+result.compoundCountryCount+"개국 / "+result.compoundFieldCount+"개 필드 · 확인 필요 오류 "+validButUnavailable.length+" · 목록/resolver 불일치 "+listResolverMismatches.length+" · 대표번호 구분자 오류 "+representativeDelimiterErrors.length+" · 기존 단일번호 회귀 "+singleNumberRegressions.length+" · 공백 분리 오류 "+spacedNumberSplitErrors.length+" · parser fixture 실패 "+parserFixtureFailures.length+" · 필수국가 실패 "+required.filter((row) => !row.pass).length+" · 실제 전화 0회";
      }
      const tbody = $("sos-compound-number-audit-rows");
      if(tbody){
        tbody.innerHTML = compoundRows.map((row) => '<tr>'+devTestCell(row.code)+devTestCell(row.priority ? "우선 62" : "전체 230")+devTestCell(row.path)+devTestCell(row.original)+devTestCell(row.fieldRepresentative)+devTestCell(row.countryRepresentative)+'</tr>').join("");
      }
      return result;
    }

    function createCountryListCardAuditPanel(){
      const panel = $("sos-dev-test-panel");
      if(!panel || $("sos-country-list-card-audit-panel")) return;
      panel.insertAdjacentHTML("beforeend",
        '<section id="sos-country-list-card-audit-panel" class="card" style="margin-top:18px">'+
          '<p class="eyebrow" style="margin-bottom:6px">Country List Card QA</p>'+
          '<h2 style="margin-top:0">국가 목록 대표번호·badge 검사</h2>'+
          '<p class="small muted" style="line-height:1.6">13개 주요 국가의 목록 formatter와 ambulance resolver 반환값을 API·전화 실행 없이 비교합니다.</p>'+
          '<button id="run-country-list-card-audit" class="btn outline w-full" type="button">국가 목록 카드 정적 검사 실행</button>'+
          '<div id="sos-country-list-card-audit-summary" class="notice teal small" style="margin-top:12px">국가 목록 카드 검사: 아직 실행하지 않음</div>'+
          '<div style="overflow:auto;margin-top:12px">'+
            '<table style="width:100%;border-collapse:collapse;min-width:1180px;font-size:12px">'+
              '<thead><tr style="background:#f8fafc;color:var(--navy);text-align:left">'+
                '<th style="padding:9px;border:1px solid var(--border)">판정</th><th style="padding:9px;border:1px solid var(--border)">코드</th><th style="padding:9px;border:1px solid var(--border)">국가</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">라벨</th><th style="padding:9px;border:1px solid var(--border)">대표 번호</th><th style="padding:9px;border:1px solid var(--border)">추가 badge</th>'+
                '<th style="padding:9px;border:1px solid var(--border)">compactNotice</th><th style="padding:9px;border:1px solid var(--border)">상태</th><th style="padding:9px;border:1px solid var(--border)">resolver</th><th style="padding:9px;border:1px solid var(--border)">결과</th>'+
              '</tr></thead><tbody id="sos-country-list-card-audit-rows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">'+
            '<h3 style="margin:0">인기 국가 compact 카드 검사</h3>'+
            '<p class="small muted" style="line-height:1.6">초기 8개 카드, 2열 grid, compact 정보 밀도와 검색·전체 목록 detailed 복원을 검사합니다.</p>'+
            '<button id="run-popular-country-audit" class="btn outline w-full" type="button">인기 국가 compact 검사 실행</button>'+
            '<div id="sos-popular-country-audit-summary" class="notice teal small" style="margin-top:12px">인기 국가 compact 검사: 아직 실행하지 않음</div>'+
          '</div>'+
          '<div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">'+
            '<h3 style="margin:0">복합 응급번호 전수 검사</h3>'+
            '<p class="small muted" style="line-height:1.6">230개 국가의 응급번호 필드를 검사하고 목록 대표번호와 실제 resolver를 비교합니다. 실제 전화는 실행하지 않습니다.</p>'+
            '<button id="run-compound-number-audit" class="btn outline w-full" type="button">복합 응급번호 전수 검사 실행</button>'+
            '<div id="sos-compound-number-audit-summary" class="notice teal small" style="margin-top:12px">복합 응급번호 전수 검사: 아직 실행하지 않음</div>'+
            '<div style="overflow:auto;margin-top:12px">'+
              '<table style="width:100%;border-collapse:collapse;min-width:920px;font-size:12px">'+
                '<thead><tr style="background:#f8fafc;color:var(--navy);text-align:left"><th style="padding:9px;border:1px solid var(--border)">코드</th><th style="padding:9px;border:1px solid var(--border)">범위</th><th style="padding:9px;border:1px solid var(--border)">필드</th><th style="padding:9px;border:1px solid var(--border)">원본</th><th style="padding:9px;border:1px solid var(--border)">필드 첫 번호</th><th style="padding:9px;border:1px solid var(--border)">목록/resolver 번호</th></tr></thead>'+
                '<tbody id="sos-compound-number-audit-rows"></tbody>'+
              '</table>'+
            '</div>'+
          '</div>'+
        '</section>'
      );
    }

    function bindCountryListCardAuditButton(){
      const button = $("run-country-list-card-audit");
      if(button) button.addEventListener("click", runCountryListCardAudit);
      const compoundButton = $("run-compound-number-audit");
      if(compoundButton) compoundButton.addEventListener("click", runCompoundEmergencyNumberAudit);
      const popularButton = $("run-popular-country-audit");
      if(popularButton) popularButton.addEventListener("click", runPopularCountryCompactAudit);
    }

    window.SOS_BRIDGE_COUNTRY_LIST_CARD_AUDIT_DEV = {
      targets:countryListCardAuditTargets,
      evaluate:evaluateCountryListCard,
      runMock:runCountryListCardAudit,
      runCompound:runCompoundEmergencyNumberAudit,
      runPopular:runPopularCountryCompactAudit
    };

    window.SOS_BRIDGE_POPULAR_COUNTRY_AUDIT_DEV = {
      codes:popularCountryAuditCodes.slice(),
      runMock:runPopularCountryCompactAudit
    };

    window.SOS_BRIDGE_COMPOUND_NUMBER_AUDIT_DEV = {
      fields:emergencyNumberFieldEntries,
      previousDial:previousSingleNumberCountryDial,
      runMock:runCompoundEmergencyNumberAudit
    };

    const aiCareAuditStorageKey = "sosBridgeAiCareSemanticAudit:v1";
    let aiCareAuditRows = [];

    const aiCareAuditScenarios = [
      {
        id: "A",
        input: "가벼운 두통이 있고 휴식하면 조금 좋아집니다.",
        expectedUrgency: "low",
        shouldRequestAmbulance: false,
        expectedSymptom: "headache"
      },
      {
        id: "B",
        input: "배가 아프고 구토가 있습니다.",
        expectedUrgency: "urgent",
        shouldRequestAmbulance: false,
        expectedSymptom: "abdominal"
      },
      {
        id: "C",
        input: "가슴이 아프고 숨쉬기 어렵습니다.",
        expectedUrgency: "emergency",
        shouldRequestAmbulance: true,
        expectedSymptom: "chest-breathing"
      }
    ];
    const aiCarePilotLiveLanguageCodes = ["ko", "en", "ja", "fr", "mn"];

    function aiCareRepresentativeTargets(){
      const seen = new Set();
      return languageOptions.filter((country) => {
        const code = String(country && country.languageCode || "").trim().toLowerCase();
        if(!code || seen.has(code)) return false;
        seen.add(code);
        return true;
      });
    }

    function aiCarePilotLiveTargets(){
      const representativeTargets = aiCareRepresentativeTargets();
      return aiCarePilotLiveLanguageCodes.map((code) => {
        const target = representativeTargets.find((country) => String(country.languageCode || "").toLowerCase() === code);
        return target || {
          countryNameKo: code,
          countryNameEn: code,
          languageNameKo: code,
          languageNameEn: code,
          languageCode: code
        };
      });
    }

    function aiCareSelectedScenarios(){
      const select = $("sos-ai-care-audit-scenario");
      const selectedId = select ? String(select.value || "all") : "all";
      if(selectedId === "all") return aiCareAuditScenarios;
      return aiCareAuditScenarios.filter((scenario) => scenario.id === selectedId);
    }

    function aiCareCountryLabel(country){
      return [country.countryNameKo || country.countryKo, country.countryNameEn || country.country].filter(Boolean).join(" / ");
    }

    function aiCareNormalizeText(value){
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function aiCareHasHangul(value){
      return /[가-힣]/.test(String(value || ""));
    }

    function aiCareLooksEnglish(value){
      const text = String(value || "");
      return /\b(please help|please call|call an ambulance|i need|i have|i am having|medical staff|show me a|nearby hospital|difficulty breathing|chest pain|stomach pain|headache)\b/i.test(text);
    }

    function aiCareHasAmbulanceSignal(value){
      return /(구급차|응급차|응급번호|119|救急車|ambulance|emergency number|emergency services|ambulans|ambulance|ambulancia|Krankenwagen|karetka|รถพยาบาล|救護車|救护车|xe cứu thương|الإسعاف|امبولانس)/i.test(String(value || ""));
    }

    function aiCareHasHospitalSignal(value){
      return /(병원|의료기관|진료|病院|医院|醫院|hospital|doctor|medical care|clinic|hôpital|médical|hospital|médico|Krankenhaus|bệnh viện|โรงพยาบาล|مستشفى)/i.test(String(value || ""));
    }

    function aiCareHasRestOnlySignal(value){
      return /(휴식|쉬면|rest|observe|watch and wait|repos|descanso|ruhen|พักผ่อน)/i.test(String(value || ""));
    }

    function aiCareHasLabelPhrase(value){
      return /^(현지\s*)?의료진에게 보여줄 문장$|^현지어 도움 문장$|^도움 문장$|^local phrase$/i.test(aiCareNormalizeText(value));
    }

    function aiCareSymptomMismatch(scenario, localText, koText){
      const combined = [localText, koText].join(" ");
      if(scenario.expectedSymptom === "headache"){
        if(/(복통|배가|腹痛|お腹|stomach|abdominal|chest|가슴|胸|호흡곤란|숨쉬기)/i.test(combined)) return "두통 입력인데 다른 증상 표현이 섞임";
      }
      if(scenario.expectedSymptom === "abdominal"){
        if(/(두통|머리|headache|頭痛|頭|胸痛|가슴|chest pain|숨쉬기 어렵)/i.test(combined)) return "복통·구토 입력인데 다른 증상 표현이 섞임";
      }
      if(scenario.expectedSymptom === "chest-breathing"){
        if(/(두통|머리|headache|腹痛|복통|stomach pain)/i.test(combined)) return "흉통·호흡곤란 입력인데 다른 증상 표현이 섞임";
      }
      return "";
    }

    function aiCareNormalizeUrgency(value){
      const normalized = String(value || "").trim().toLowerCase();
      if(["mild", "low", "self-care", "selfcare"].includes(normalized)) return "low";
      if(["urgent", "hospital"].includes(normalized)) return "urgent";
      if(["emergency"].includes(normalized)) return "emergency";
      return "";
    }

    function aiCareUrgencyRank(value){
      const normalized = aiCareNormalizeUrgency(value);
      if(normalized === "low") return 1;
      if(normalized === "urgent") return 2;
      if(normalized === "emergency") return 3;
      return 0;
    }

    function aiCareCompareUrgency(scenario, data){
      const expected = aiCareNormalizeUrgency(scenario && scenario.expectedUrgency);
      const actual = aiCareNormalizeUrgency(data && data.level);
      if(!actual){
        return {
          urgencyMatch: "확인 필요",
          blockReason: "응급도 결과가 비어 있음"
        };
      }
      if(!expected || expected === actual){
        return {urgencyMatch: "일치"};
      }
      const expectedRank = aiCareUrgencyRank(expected);
      const actualRank = aiCareUrgencyRank(actual);
      if(actualRank > expectedRank){
        return {
          urgencyMatch: "불일치",
          reviewReason: "동일한 시나리오가 기대 긴급도보다 높게 판정됨"
        };
      }
      return {
        urgencyMatch: "불일치",
        blockReason: "동일한 시나리오가 기대 긴급도보다 낮게 판정됨"
      };
    }

    function aiCareEvaluateResult(country, scenario, data, meta){
      const localText = aiCareNormalizeText(data && (data.localPhraseLocal || data.localPhraseNative || data.localPhraseEn));
      const koText = aiCareNormalizeText(data && data.localPhraseKo);
      const localLanguageCode = String(country.languageCode || "").toLowerCase();
      const reasons = [];
      const reviewReasons = [];
      const localHasAmbulance = aiCareHasAmbulanceSignal(localText);
      const koHasAmbulance = aiCareHasAmbulanceSignal(koText);
      const urgencyComparison = aiCareCompareUrgency(scenario, data || {});
      const baseLevel = meta && meta.baseLevel || data && data.baseLevel || "";
      const baseRecommendedDepartment = meta && meta.baseRecommendedDepartment || data && data.baseRecommendedDepartment || "";
      const resultLevel = data && data.level || "";
      const resultRecommendedDepartment = data && data.recommendedDepartment || "";

      if(data && data.localPhraseReviewNeeded){
        reviewReasons.push(data.localPhraseReviewReason || "현지 문장 검증 필요");
      }
      if(baseLevel && resultLevel && aiCareNormalizeUrgency(baseLevel) !== aiCareNormalizeUrgency(resultLevel)){
        reasons.push("언어별 level 차이 발생");
      }
      if(baseRecommendedDepartment && resultRecommendedDepartment && String(baseRecommendedDepartment).trim() !== String(resultRecommendedDepartment).trim()){
        reasons.push("언어별 recommendedDepartment 차이 발생");
      }
      if(urgencyComparison.blockReason) reasons.push(urgencyComparison.blockReason);
      if(urgencyComparison.reviewReason) reviewReasons.push(urgencyComparison.reviewReason);
      if(!localText) reasons.push("현지 문장이 비어 있음");
      if(!koText) reasons.push("한국어 뜻이 비어 있음");
      if(aiCareHasLabelPhrase(koText)) reasons.push("한국어 뜻에 라벨 문구가 들어감");
      if(localHasAmbulance !== koHasAmbulance) reasons.push("현지 문장과 한국어 뜻의 구급차 요청 의미가 다름");
      if(!scenario.shouldRequestAmbulance && localHasAmbulance) reasons.push("비응급 입력인데 현지 문장이 구급차 요청을 포함함");
      if(scenario.shouldRequestAmbulance && !localHasAmbulance && !koHasAmbulance) reasons.push("응급 입력인데 구급차 또는 응급번호 요청이 누락됨");
      if(scenario.shouldRequestAmbulance && aiCareHasRestOnlySignal(localText) && !localHasAmbulance) reasons.push("응급 입력인데 휴식·관찰 중심 문장으로 보임");
      const symptomMismatch = aiCareSymptomMismatch(scenario, localText, koText);
      if(symptomMismatch) reasons.push(symptomMismatch);
      if(localLanguageCode !== "ko" && aiCareHasHangul(localText)) reasons.push("현지 문장에 한국어 fallback이 섞임");
      if(localLanguageCode !== "en" && aiCareLooksEnglish(localText)) reasons.push("현지 문장에 영어 fallback이 섞임");

      const hardBlockReasons = reviewReasons.length
        ? reasons.filter((reason) => !/fallback/.test(reason))
        : reasons;
      const status = hardBlockReasons.length ? "BLOCK" : reviewReasons.length ? "HUMAN_REVIEW" : reasons.length ? "BLOCK" : "PASS";
      const reasonText = reasons.concat(reviewReasons.map((reason) => "검증 필요: " + reason)).join(" / ");
      return {
        country: aiCareCountryLabel(country),
        languageCode: country.languageCode || "",
        languageName: [country.languageNameKo, country.languageNameEn].filter(Boolean).join(" / "),
        scenarioId: scenario.id,
        input: scenario.input,
        level: data && data.level || "",
        recommendedDepartment: data && data.recommendedDepartment || "",
        sharedAssessmentId: meta && meta.sharedAssessmentId || data && (data.sharedAssessmentId || data.assessmentId) || "",
        baseLevel,
        baseRecommendedDepartment,
        translationOnly: meta && meta.translationOnly || data && data.translationOnly ? "예" : "아니오",
        localPhraseLocal: localText,
        reviewNeeded: data && (data.localPhraseReviewNeeded || data.translationReviewNeeded) ? "true" : "false",
        localPhraseKo: koText,
        semanticMatch: reasons.some((reason) => /의미|증상|fallback|라벨/.test(reason)) ? "불일치" : "일치",
        urgencyMatch: urgencyComparison.urgencyMatch === "일치" && reasons.some((reason) => /구급차|응급|휴식/.test(reason)) ? "불일치" : urgencyComparison.urgencyMatch,
        status,
        reason: reasonText || "현지 문장과 한국어 뜻의 핵심 의미가 일치함",
        apiCallCount: meta && meta.apiCallCount || 0,
        error: meta && meta.error || ""
      };
    }

    function aiCareAssessmentRequestBody(scenario){
      return {
        symptom: scenario.input,
        travelCountry: "",
        travelCity: "",
        userLanguage: "ko",
        emergencyNumber: "",
        assessmentOnly: true
      };
    }

    function aiCareTranslationRequestBody(country, scenario, assessment){
      return {
        symptom: scenario.input,
        travelCountry: country.countryNameKo || country.countryKo || country.countryNameEn || country.country || "",
        travelCity: "",
        userLanguage: "ko",
        localLanguage: country.languageCode || "en",
        languageCode: country.languageCode || "en",
        localLanguageName: country.languageNameEn || country.native || "",
        emergencyNumber: country.emergencyNumber || "",
        translationOnly: true,
        assessment: {
          localPhraseKo: assessment.localPhraseKo || "",
          assessmentId: assessment.sharedAssessmentId || assessment.assessmentId || ""
        }
      };
    }

    async function aiCareFetchJson(body){
      const res = await fetch("/.netlify/functions/ai-care", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.detail || data.error || "ai-care 실패");
      return data;
    }

    async function aiCareRunSharedAssessment(scenario){
      const data = await aiCareFetchJson(aiCareAssessmentRequestBody(scenario));
      if(!data || !data.localPhraseKo || !data.level){
        throw new Error("한국어 기준 판단 결과가 비어 있음");
      }
      return data;
    }

    function aiCareFailedAuditRow(country, scenario, message, meta){
      return {
        country: aiCareCountryLabel(country),
        languageCode: country.languageCode || "",
        languageName: [country.languageNameKo, country.languageNameEn].filter(Boolean).join(" / "),
        scenarioId: scenario.id,
        input: scenario.input,
        level: "",
        recommendedDepartment: "",
        sharedAssessmentId: meta && meta.sharedAssessmentId || "",
        baseLevel: meta && meta.baseLevel || "",
        baseRecommendedDepartment: meta && meta.baseRecommendedDepartment || "",
        translationOnly: meta && meta.translationOnly ? "예" : "아니오",
        localPhraseLocal: "",
        reviewNeeded: "false",
        localPhraseKo: "",
        semanticMatch: "불일치",
        urgencyMatch: "확인 필요",
        status: "BLOCK",
        reason: message || "AI Care 호출 실패 또는 빈 응답",
        apiCallCount: meta && meta.apiCallCount || 0,
        error: meta && meta.error || ""
      };
    }

    async function aiCareRunTranslationAudit(country, scenario, assessment){
      try{
        const translationData = await aiCareFetchJson(aiCareTranslationRequestBody(country, scenario, assessment));
        const data = {
          ...assessment,
          localPhraseLocal: translationData.localPhraseLocal || "",
          localPhraseKo: assessment.localPhraseKo || translationData.localPhraseKo || "",
          localPhraseReviewNeeded: Boolean(translationData.localPhraseReviewNeeded || translationData.translationReviewNeeded),
          translationReviewNeeded: Boolean(translationData.localPhraseReviewNeeded || translationData.translationReviewNeeded),
          localPhraseReviewReason: translationData.localPhraseReviewReason || "",
          translationOnly: true,
          sharedAssessmentId: assessment.sharedAssessmentId || assessment.assessmentId || "",
          baseLevel: assessment.level || "",
          baseRecommendedDepartment: assessment.recommendedDepartment || ""
        };
        return aiCareEvaluateResult(country, scenario, data, {
          apiCallCount: 1,
          sharedAssessmentId: assessment.sharedAssessmentId || assessment.assessmentId || "",
          baseLevel: assessment.level || "",
          baseRecommendedDepartment: assessment.recommendedDepartment || "",
          translationOnly: true
        });
      }catch(error){
        return aiCareFailedAuditRow(country, scenario, "AI Care 번역 단계 호출 실패 또는 빈 응답", {
          apiCallCount: 1,
          sharedAssessmentId: assessment && (assessment.sharedAssessmentId || assessment.assessmentId) || "",
          baseLevel: assessment && assessment.level || "",
          baseRecommendedDepartment: assessment && assessment.recommendedDepartment || "",
          translationOnly: true,
          error: error && error.message ? error.message : "오류"
        });
      }
    }

    function aiCareSaveRows(){
      try{
        localStorage.setItem(aiCareAuditStorageKey, JSON.stringify(aiCareAuditRows));
      }catch(error){}
    }

    function aiCareLoadRows(){
      try{
        const parsed = JSON.parse(localStorage.getItem(aiCareAuditStorageKey) || "[]");
        aiCareAuditRows = Array.isArray(parsed) ? parsed : [];
      }catch(error){
        aiCareAuditRows = [];
      }
    }

    function renderAiCareAuditRows(){
      const tbody = $("sos-ai-care-audit-rows");
      if(!tbody) return;
      tbody.innerHTML = aiCareAuditRows.map((row) => {
        const color = row.status === "PASS" ? "#047857" : row.status === "HUMAN_REVIEW" ? "#b45309" : "#b91c1c";
        return '<tr>'+
          devTestCell(row.languageName)+
          devTestCell(row.languageCode)+
          devTestCell(row.input)+
          devTestCell(row.level)+
          devTestCell(row.recommendedDepartment)+
          devTestCell(row.sharedAssessmentId)+
          devTestCell(row.baseLevel)+
          devTestCell(row.baseRecommendedDepartment)+
          devTestCell(row.translationOnly)+
          devTestCell(row.localPhraseLocal)+
          devTestCell(row.reviewNeeded)+
          devTestCell(row.localPhraseKo)+
          devTestCell(row.semanticMatch)+
          devTestCell(row.urgencyMatch)+
          '<td style="padding:8px;border:1px solid var(--border);vertical-align:top;font-weight:950;color:'+color+'">'+escapeHtml(row.status)+'</td>'+
          devTestCell(row.reason)+
          '<td style="padding:8px;border:1px solid var(--border);vertical-align:top"><button class="btn outline" type="button" data-ai-care-rerun="'+escapeHtml(row.languageCode || "")+'">이 언어 재검사</button></td>'+
        '</tr>';
      }).join("");
      renderAiCareAuditSummary();
    }

    function aiCareAuditSummary(){
      const total = aiCareAuditRows.length;
      const pass = aiCareAuditRows.filter((row) => row.status === "PASS").length;
      const review = aiCareAuditRows.filter((row) => row.status === "HUMAN_REVIEW").length;
      const block = aiCareAuditRows.filter((row) => row.status === "BLOCK").length;
      return "AI Care 의미 감사 결과: 총 " + total + "개 · PASS " + pass + "개 · HUMAN_REVIEW " + review + "개 · BLOCK " + block + "개";
    }

    function renderAiCareAuditSummary(){
      const summary = $("sos-ai-care-audit-summary");
      if(!summary) return;
      summary.textContent = aiCareAuditSummary();
    }

    function updateAiCareAuditStatus(message){
      const status = $("sos-ai-care-audit-status");
      if(!status) return;
      status.classList.remove("hidden");
      status.textContent = message;
    }

    function runAiCareMockSemanticAudit(){
      const japan = languageOptions.find((country) => String(country.languageCode || "").toLowerCase() === "ja") || {
        countryNameKo: "일본",
        countryNameEn: "Japan",
        languageNameKo: "일본어",
        languageNameEn: "Japanese",
        languageCode: "ja"
      };
      const english = languageOptions.find((country) => String(country.languageCode || "").toLowerCase() === "en") || {
        countryNameKo: "미국",
        countryNameEn: "United States",
        languageNameKo: "영어",
        languageNameEn: "English",
        languageCode: "en"
      };
      const selectedScenarios = aiCareSelectedScenarios();
      const mockByScenario = {
        A: () => aiCareEvaluateResult(japan, aiCareAuditScenarios[0], {
          level: "mild",
          recommendedDepartment: "약국 상담 또는 가까운 클리닉",
          sharedAssessmentId: "mock-A",
          baseLevel: "mild",
          baseRecommendedDepartment: "약국 상담 또는 가까운 클리닉",
          translationOnly: true,
          localPhraseLocal: "軽い頭痛があり、休むと少し良くなります。",
          localPhraseKo: "가벼운 두통이 있고 휴식하면 조금 좋아집니다."
        }, {apiCallCount: 0, sharedAssessmentId: "mock-A", baseLevel: "mild", baseRecommendedDepartment: "약국 상담 또는 가까운 클리닉", translationOnly: true}),
        B: () => aiCareEvaluateResult(japan, aiCareAuditScenarios[1], {
          level: "urgent",
          recommendedDepartment: "내과·소화기내과",
          sharedAssessmentId: "mock-B",
          baseLevel: "urgent",
          baseRecommendedDepartment: "내과·소화기내과",
          translationOnly: true,
          localPhraseLocal: "腹痛と嘔吐があります。診察が必要です。",
          localPhraseKo: "복통과 동반 증상이 있어 병원 진료가 필요합니다."
        }, {apiCallCount: 0, sharedAssessmentId: "mock-B", baseLevel: "urgent", baseRecommendedDepartment: "내과·소화기내과", translationOnly: true}),
        C: () => aiCareEvaluateResult(english, aiCareAuditScenarios[2], {
          level: "emergency",
          recommendedDepartment: "응급의학과",
          sharedAssessmentId: "mock-C",
          baseLevel: "emergency",
          baseRecommendedDepartment: "응급의학과",
          translationOnly: true,
          localPhraseLocal: "I have chest pain and difficulty breathing. Please call an ambulance.",
          localPhraseKo: "가슴이 아프고 숨쉬기 어렵습니다. 구급차를 불러 주세요."
        }, {apiCallCount: 0, sharedAssessmentId: "mock-C", baseLevel: "emergency", baseRecommendedDepartment: "응급의학과", translationOnly: true})
      };
      aiCareAuditRows = selectedScenarios.map((scenario) => mockByScenario[scenario.id]()).filter(Boolean);
      aiCareSaveRows();
      renderAiCareAuditRows();
      updateAiCareAuditStatus(aiCareAuditSummary() + " · 모의 테스트는 API를 호출하지 않았습니다.");
    }

    async function runAiCareSemanticAuditForTargets(targets, options){
      const settings = options || {};
      const scenarios = settings.scenarios || aiCareSelectedScenarios();
      const totalRows = targets.length * scenarios.length;
      const totalCalls = scenarios.length * (targets.length + 1);
      let completed = 0;
      let apiCalls = 0;
      if(settings.preserveExisting){
        const replaceCodes = new Set(targets.map((country) => String(country.languageCode || "").toLowerCase()));
        aiCareAuditRows = aiCareAuditRows.filter((row) => !replaceCodes.has(String(row.languageCode || "").toLowerCase()));
      }else{
        aiCareAuditRows = [];
      }
      renderAiCareAuditRows();
      updateAiCareAuditStatus("AI Care 의미 감사 시작: 0 / " + totalRows + " · 예상 API 호출 " + totalCalls + "회 · 실제 API 호출 0회");
      for(const scenario of scenarios){
        let assessment = null;
        try{
          assessment = await aiCareRunSharedAssessment(scenario);
          apiCalls += 1;
        }catch(error){
          apiCalls += 1;
          for(const country of targets){
            completed += 1;
            aiCareAuditRows.push(aiCareFailedAuditRow(country, scenario, "한국어 기준 판단 단계 실패 또는 빈 응답", {
              apiCallCount: 0,
              error: error && error.message ? error.message : "오류"
            }));
          }
          aiCareSaveRows();
          renderAiCareAuditRows();
          updateAiCareAuditStatus("AI Care 의미 감사 진행 중: " + completed + " / " + totalRows + " · 실제 API 호출 " + apiCalls + "회");
          continue;
        }

        for(const country of targets){
          const row = await aiCareRunTranslationAudit(country, scenario, assessment);
          apiCalls += row.apiCallCount || 0;
          completed += 1;
          aiCareAuditRows.push(row);
          aiCareSaveRows();
          renderAiCareAuditRows();
          updateAiCareAuditStatus("AI Care 의미 감사 진행 중: " + completed + " / " + totalRows + " · 실제 API 호출 " + apiCalls + "회");
        }
      }
      updateAiCareAuditStatus(aiCareAuditSummary() + " · 실제 API 호출 " + apiCalls + "회");
    }

    function runAiCareRepresentativeAudit(){
      const targets = aiCareRepresentativeTargets();
      const scenarios = aiCareSelectedScenarios();
      const expectedCalls = scenarios.length * (targets.length + 1);
      const confirmed = window.confirm ? window.confirm("AI Care live 감사는 실제 API를 호출합니다. 예상 호출 수: " + expectedCalls + "회. 계속할까요?") : false;
      if(!confirmed){
        updateAiCareAuditStatus("live API 감사 실행을 취소했습니다. 모의 테스트는 API를 호출하지 않습니다.");
        return Promise.resolve();
      }
      return runAiCareSemanticAuditForTargets(targets);
    }

    function aiCareBuildPilotRow(country, scenario, assessment, translationData, meta){
      const sharedAssessmentId = assessment.sharedAssessmentId || assessment.assessmentId || "";
      const responseAssessmentId = translationData && translationData.sharedAssessmentId || sharedAssessmentId;
      const data = {
        ...assessment,
        localPhraseLocal: translationData && translationData.localPhraseLocal || "",
        localPhraseKo: assessment.localPhraseKo || translationData && translationData.localPhraseKo || "",
        localPhraseReviewNeeded: Boolean(translationData && (translationData.localPhraseReviewNeeded || translationData.translationReviewNeeded)),
        translationReviewNeeded: Boolean(translationData && (translationData.localPhraseReviewNeeded || translationData.translationReviewNeeded)),
        localPhraseReviewReason: translationData && translationData.localPhraseReviewReason || "",
        translationOnly: Boolean(meta && meta.translationOnly),
        sharedAssessmentId,
        baseLevel: assessment.level || "",
        baseRecommendedDepartment: assessment.recommendedDepartment || ""
      };
      const row = aiCareEvaluateResult(country, scenario, data, {
        apiCallCount: meta && meta.apiCallCount || 0,
        sharedAssessmentId,
        baseLevel: assessment.level || "",
        baseRecommendedDepartment: assessment.recommendedDepartment || "",
        translationOnly: Boolean(meta && meta.translationOnly),
        error: meta && meta.error || ""
      });
      const issues = [];
      const reviewIssues = [];
      if(row.level !== "urgent") issues.push("level이 기대값 urgent와 다름");
      if(row.recommendedDepartment !== "내과·소화기내과") issues.push("recommendedDepartment가 기대값과 다름");
      if(responseAssessmentId !== sharedAssessmentId) issues.push("sharedAssessmentId가 기준 판단과 다름");
      if(!String(row.localPhraseLocal || "").trim()) issues.push("현지 문장이 비어 있음");
      if(data.localPhraseReviewNeeded || data.translationReviewNeeded) reviewIssues.push("reviewNeeded=true");
      if(meta && meta.error) issues.push("API 실패 또는 응답 오류");
      const previousReason = row.reason && row.reason !== "현지 문장과 한국어 뜻의 핵심 의미가 일치함" ? row.reason : "";
      const combinedReason = [previousReason].concat(issues, reviewIssues.map((reason) => "검증 필요: " + reason)).filter(Boolean).join(" / ");
      return {
        ...row,
        status: issues.length ? "BLOCK" : reviewIssues.length ? "HUMAN_REVIEW" : row.status,
        reason: combinedReason || row.reason,
        translationOnly: meta && meta.koSkipped ? "아니오(ko 생략)" : row.translationOnly
      };
    }

    async function runAiCareFiveLanguageLivePilot(){
      const scenario = aiCareAuditScenarios.find((item) => item.id === "B") || aiCareAuditScenarios[1];
      const targets = aiCarePilotLiveTargets();
      const expectedCalls = 5;
      const confirmed = window.confirm ? window.confirm("AI Care 대표 5개 언어 실전 테스트는 실제 API를 호출합니다. 예상 OpenAI 호출 수: " + expectedCalls + "회(판단 1회 + 번역 4회). 계속할까요?") : false;
      if(!confirmed){
        updateAiCareAuditStatus("대표 5개 언어 실전 테스트 실행을 취소했습니다.");
        return Promise.resolve();
      }
      aiCareAuditRows = [];
      renderAiCareAuditRows();
      updateAiCareAuditStatus("대표 5개 언어 실전 테스트 시작: 한국어 판단 1회 생성 중 · 실제 OpenAI 호출 0회");
      let assessment;
      let apiCalls = 0;
      try{
        assessment = await aiCareRunSharedAssessment(scenario);
        apiCalls += 1;
      }catch(error){
        apiCalls += 1;
        aiCareAuditRows = targets.map((country) => aiCareFailedAuditRow(country, scenario, "한국어 기준 판단 단계 실패 또는 빈 응답", {
          apiCallCount: 0,
          error: error && error.message ? error.message : "오류"
        }));
        aiCareSaveRows();
        renderAiCareAuditRows();
        updateAiCareAuditStatus(aiCareAuditSummary() + " · 실제 OpenAI 호출 " + apiCalls + "회");
        return;
      }
      for(const country of targets){
        const code = String(country.languageCode || "").toLowerCase();
        if(code === "ko"){
          aiCareAuditRows.push(aiCareBuildPilotRow(country, scenario, assessment, {
            localPhraseLocal: assessment.localPhraseKo || "",
            localPhraseKo: assessment.localPhraseKo || "",
            sharedAssessmentId: assessment.sharedAssessmentId || assessment.assessmentId || ""
          }, {apiCallCount: 0, koSkipped: true}));
        }else{
          try{
            const translationData = await aiCareFetchJson(aiCareTranslationRequestBody(country, scenario, assessment));
            apiCalls += 1;
            aiCareAuditRows.push(aiCareBuildPilotRow(country, scenario, assessment, translationData, {
              apiCallCount: 1,
              translationOnly: true
            }));
          }catch(error){
            apiCalls += 1;
            aiCareAuditRows.push(aiCareFailedAuditRow(country, scenario, "AI Care 번역 단계 호출 실패 또는 빈 응답", {
              apiCallCount: 1,
              sharedAssessmentId: assessment.sharedAssessmentId || assessment.assessmentId || "",
              baseLevel: assessment.level || "",
              baseRecommendedDepartment: assessment.recommendedDepartment || "",
              translationOnly: true,
              error: error && error.message ? error.message : "오류"
            }));
          }
        }
        aiCareSaveRows();
        renderAiCareAuditRows();
        updateAiCareAuditStatus("대표 5개 언어 실전 테스트 진행 중: " + aiCareAuditRows.length + " / " + targets.length + " · 실제 OpenAI 호출 " + apiCalls + "회");
      }
      updateAiCareAuditStatus(aiCareAuditSummary() + " · 실제 OpenAI 호출 " + apiCalls + "회 · 기대 호출 수 5회");
    }

    function runAiCareSingleLanguageAudit(languageCode){
      const code = String(languageCode || "").toLowerCase();
      const target = aiCareRepresentativeTargets().find((country) => String(country.languageCode || "").toLowerCase() === code);
      if(!target){
        updateAiCareAuditStatus("재검사 대상 언어를 찾지 못했습니다: " + languageCode);
        return Promise.resolve();
      }
      return runAiCareSemanticAuditForTargets([target], {preserveExisting: true});
    }

    function downloadAiCareAuditJson(){
      const blob = new Blob([JSON.stringify({
        generatedAt: new Date().toISOString(),
        scenarios: aiCareAuditScenarios,
        rows: aiCareAuditRows
      }, null, 2)], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "sos-bridge-ai-care-semantic-audit.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function createAiCareSemanticAuditPanel(){
      const panel = $("sos-dev-test-panel");
      if(!panel || $("sos-ai-care-audit-panel")) return;
      const mount = $("sos-ai-care-audit-mount") || panel;
      const representativeCount = aiCareRepresentativeTargets().length;
      mount.insertAdjacentHTML("beforeend",
        '<section id="sos-ai-care-audit-panel" class="card" style="margin-top:18px">'+
          '<p class="eyebrow" style="margin-bottom:6px">AI Care QA</p>'+
          '<h2 style="margin-top:0">AI Care 현지 문장 의미 일치 감사</h2>'+
          '<p class="small muted" style="line-height:1.6">현지 문장과 한국어 뜻의 의미·긴급도가 서로 맞는지 개발자 URL에서만 점검합니다. 일반 사용자 화면에는 표시되지 않습니다.</p>'+
          '<label class="small" for="sos-ai-care-audit-scenario" style="display:block;margin-top:10px;font-weight:900">시나리오 선택</label>'+
          '<select id="sos-ai-care-audit-scenario" class="input" style="margin-top:6px">'+
            '<option value="all">전체 시나리오 A+B+C</option>'+
            '<option value="A">A. 가벼운 두통이 있고 휴식하면 조금 좋아집니다.</option>'+
            '<option value="B">B. 배가 아프고 구토가 있습니다.</option>'+
            '<option value="C">C. 가슴이 아프고 숨쉬기 어렵습니다.</option>'+
          '</select>'+
          '<div class="notice amber small" style="margin-top:12px">대표 언어는 ' + representativeCount + '개입니다. 전체 시나리오 실행 시 예상 API 호출은 ' + ((representativeCount + 1) * aiCareAuditScenarios.length) + '회입니다. 각 시나리오는 한국어 기준 판단 1회를 재사용하고, 언어별로 현지 문장 번역만 실행합니다. 승인 없이 자동 실행되지 않습니다.</div>'+
          '<div class="two" style="margin-top:12px">'+
            '<button id="run-ai-care-semantic-mock-test" class="btn outline w-full" type="button">AI Care 의미 감사 모의 테스트 실행</button>'+
            '<button id="run-ai-care-semantic-live-test" class="btn primary w-full" type="button">대표 언어 73개 테스트 실행</button>'+
          '</div>'+
          '<button id="run-ai-care-five-language-live-pilot" class="btn outline w-full" type="button" style="margin-top:10px">대표 5개 언어 실전 테스트 실행</button>'+
          '<button id="download-ai-care-semantic-audit-json" class="btn outline w-full" type="button" style="margin-top:10px">전체 결과 JSON 다운로드</button>'+
          '<div id="sos-ai-care-audit-summary" class="notice teal small" style="margin-top:12px">AI Care 의미 감사 결과: 총 0개 · PASS 0개 · HUMAN_REVIEW 0개 · BLOCK 0개</div>'+
          '<div id="sos-ai-care-audit-status" class="notice teal hidden" style="margin-top:12px"></div>'+
          '<div style="overflow:auto;margin-top:12px">'+
            '<table style="width:100%;border-collapse:collapse;min-width:1720px;font-size:12px">'+
              '<thead>'+
                '<tr style="background:#f8fafc;color:var(--navy);text-align:left">'+
                  '<th style="padding:9px;border:1px solid var(--border)">언어명</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">languageCode</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">입력 증상</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">응급도</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">추천 진료과</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">sharedAssessmentId</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">baseLevel</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">baseRecommendedDepartment</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">translationOnly</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">localPhraseLocal</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">reviewNeeded</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">localPhraseKo</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">의미 일치</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">긴급도 일치</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">판정</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">이유</th>'+
                  '<th style="padding:9px;border:1px solid var(--border)">재검사</th>'+
                '</tr>'+
              '</thead>'+
              '<tbody id="sos-ai-care-audit-rows"></tbody>'+
            '</table>'+
          '</div>'+
        '</section>'
      );
      aiCareLoadRows();
      renderAiCareAuditRows();
      if(aiCareAuditRows.length) updateAiCareAuditStatus(aiCareAuditSummary() + " · 저장된 이전 결과를 불러왔습니다.");
    }

    function bindAiCareSemanticAuditButtons(){
      const mockButton = $("run-ai-care-semantic-mock-test");
      const liveButton = $("run-ai-care-semantic-live-test");
      const pilotButton = $("run-ai-care-five-language-live-pilot");
      const downloadButton = $("download-ai-care-semantic-audit-json");
      const rows = $("sos-ai-care-audit-rows");

      if(mockButton) mockButton.addEventListener("click", runAiCareMockSemanticAudit);
      if(liveButton) liveButton.addEventListener("click", runAiCareRepresentativeAudit);
      if(pilotButton) pilotButton.addEventListener("click", runAiCareFiveLanguageLivePilot);
      if(downloadButton) downloadButton.addEventListener("click", downloadAiCareAuditJson);
      if(rows){
        rows.addEventListener("click", (event) => {
          const button = event.target && event.target.closest ? event.target.closest("[data-ai-care-rerun]") : null;
          if(button) runAiCareSingleLanguageAudit(button.getAttribute("data-ai-care-rerun"));
        });
      }
    }

    window.SOS_BRIDGE_AI_CARE_AUDIT_DEV = {
      scenarios: aiCareAuditScenarios,
      evaluate: aiCareEvaluateResult,
      runMock: runAiCareMockSemanticAudit,
      representativeTargets: aiCareRepresentativeTargets
    };

    function bindAllLanguageTestButtons(){
      const priorityButton = $("run-priority-country-test");
      const representativeButton = $("run-representative-language-test");
      const allCountriesButton = $("run-all-country-region-test");

      if(priorityButton){
        priorityButton.addEventListener("click", runPriorityCountryTests);
      }

      if(representativeButton){
        representativeButton.addEventListener("click", runRepresentativeLanguageTests);
      }

      if(allCountriesButton){
        allCountriesButton.addEventListener("click", runAllCountryRegionTests);
      }
    }

    createAllLanguageTestPanel();
    createPrescriptionPhraseAuditPanel();
    createEmergencyNumberAuditPanel();
    createCountryListCardAuditPanel();
    createAiCareSemanticAuditPanel();
    bindAllLanguageTestButtons();
    bindPrescriptionPhraseAuditButton();
    bindEmergencyNumberAuditButton();
    bindCountryListCardAuditButton();
    bindAiCareSemanticAuditButtons();
    }catch(error){
      console.error("developer-test.js runtime error", error);
      alert("developer-test.js 실행 오류: " + error.message);
    }
  }

  window.renderAllLanguageDeveloperTestPanel = renderAllLanguageDeveloperTestPanel;
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", renderAllLanguageDeveloperTestPanel, {once: true});
  }else{
    renderAllLanguageDeveloperTestPanel();
  }
  }catch(error){
    console.error("developer-test.js runtime error", error);
    alert("developer-test.js 실행 오류: " + error.message);
  }
})();
