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
      '<div class="two" style="margin-top:12px">'+
        '<button id="run-representative-language-test" class="btn primary w-full" type="button">대표 언어별 테스트 실행</button>'+
        '<button id="run-all-country-region-test" class="btn outline w-full" type="button">전체 국가/지역 테스트 실행</button>'+
      '</div>'+
      '<div id="sos-dev-test-status" class="notice teal hidden" style="margin-top:12px"></div>'+
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
      age: "25",
      bloodType: "B",
      allergies: "땅콩 알레르기",
      medication: "Advil",
      medicalConditions: "천식",
      emergencyContact: "",
      travelInsurance: "",
      hotelAddress: ""
    };
  }

    function devTestTargets(mode){
    const countries = languageOptions.filter((country) => country && (country.languageCode || country.languageNameEn));
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
    return /\b(Medical Card|Not provided|Peanut allergy|medication entered by the user)\b/i.test(String(value || ""));
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
      return {...row, status: row.fallbackUsed === "사용" ? "통과 fallback" : "통과", problem: row.fallbackUsed === "사용" ? "fallback 언어로 표시됨" : "정상"};
    }catch(error){
      return {...baseRow, status: "실패", errorMessage: error && error.message ? error.message : "오류 메시지 발생", problem: error && error.message ? error.message : "오류 메시지 발생"};
    }
  }

    async function runAllLanguageTest(mode){
    const status = $("sos-dev-test-status");
    const targets = devTestTargets(mode);
    const rows = [];
    if(status){
      status.classList.remove("hidden");
      status.textContent = (mode === "all" ? "전체 국가/지역" : "대표 언어별") + " 테스트를 시작합니다. 0 / " + targets.length;
    }
    renderDevTestRows(rows);
    for(let i = 0; i < targets.length; i++){
      rows.push(await runSingleCountryLanguageTest(targets[i]));
      renderDevTestRows(rows);
      if(status) status.textContent = (mode === "all" ? "전체 국가/지역" : "대표 언어별") + " 테스트 진행 중: " + (i + 1) + " / " + targets.length;
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

    function runAllCountryRegionTests(){
      return runAllLanguageTest("all");
    }

    function bindAllLanguageTestButtons(){
      const representativeButton = $("run-representative-language-test");
      const allCountriesButton = $("run-all-country-region-test");

      if(representativeButton){
        representativeButton.addEventListener("click", runRepresentativeLanguageTests);
      }

      if(allCountriesButton){
        allCountriesButton.addEventListener("click", runAllCountryRegionTests);
      }
    }

    createAllLanguageTestPanel();
    bindAllLanguageTestButtons();
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
