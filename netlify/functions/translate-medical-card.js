const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const FIELD_KEYS = [
  "name",
  "passportName",
  "nationality",
  "age",
  "bloodType",
  "allergies",
  "medication",
  "medicalConditions",
  "emergencyContact",
  "travelInsurance",
  "hotelAddress"
];

const MEDICAL_CARD_I18N = {
  ko: {
    locale: "ko-KR",
    languageLabel: "한국어",
    cardTitle: "여행자 의료카드",
    labels: {name:"이름", passportName:"여권상 영문 이름", nationality:"국적", age:"나이", bloodType:"혈액형", allergies:"알레르기", medication:"복용 중인 약", medicalConditions:"기존 질환", emergencyContact:"비상 연락처", travelInsurance:"여행자 보험", hotelAddress:"숙소 주소"},
    blankValue: "미입력",
    noneValue: "없음",
    medicationUserEnteredSuffix: "사용자가 입력한 약",
    genericMedicineIngredientUnspecified: "성분 미기재",
    southKoreaNationality: "대한민국",
    genericMedicines: {cold:"감기약, 성분 미기재", pain:"진통제, 성분 미기재", bloodPressure:"혈압약, 성분 미기재", digestive:"소화제, 성분 미기재", fever:"해열제, 성분 미기재", antiInflammatory:"소염제, 성분 미기재"},
    allergiesMap: {peanut:"땅콩 알레르기", pollen:"꽃가루 알레르기", penicillin:"페니실린 알레르기"},
    conditionsMap: {asthma:"천식", hypertension:"고혈압", diabetes:"당뇨병"}
  },
  en: {
    locale: "en",
    languageLabel: "English",
    cardTitle: "Medical Card",
    labels: {name:"Name", passportName:"Passport name", nationality:"Nationality", age:"Age", bloodType:"Blood type", allergies:"Allergies", medication:"Medication", medicalConditions:"Medical conditions", emergencyContact:"Emergency contact", travelInsurance:"Travel insurance", hotelAddress:"Hotel address"},
    blankValue: "Not provided",
    noneValue: "None",
    medicationUserEnteredSuffix: "medication entered by the user",
    genericMedicineIngredientUnspecified: "ingredient not specified",
    southKoreaNationality: "South Korea",
    genericMedicines: {cold:"Cold medicine, ingredient not specified", pain:"Pain medication, ingredient not specified", bloodPressure:"Blood pressure medication, ingredient not specified", digestive:"Digestive medicine, ingredient not specified", fever:"Fever medication, ingredient not specified", antiInflammatory:"Anti-inflammatory medication, ingredient not specified"},
    allergiesMap: {peanut:"Peanut allergy", pollen:"Pollen allergy", penicillin:"Penicillin allergy"},
    conditionsMap: {asthma:"Asthma", hypertension:"High blood pressure", diabetes:"Diabetes"}
  },
  es: {
    locale: "es",
    languageLabel: "Español",
    cardTitle: "Tarjeta médica",
    labels: {name:"Nombre", passportName:"Nombre en pasaporte", nationality:"Nacionalidad", age:"Edad", bloodType:"Tipo de sangre", allergies:"Alergias", medication:"Medicamentos", medicalConditions:"Enfermedades previas", emergencyContact:"Contacto de emergencia", travelInsurance:"Seguro de viaje", hotelAddress:"Dirección del hotel"},
    blankValue: "No proporcionado",
    noneValue: "Ninguno",
    medicationUserEnteredSuffix: "medicamento indicado por el usuario",
    genericMedicineIngredientUnspecified: "ingrediente no especificado",
    southKoreaNationality: "Corea del Sur",
    genericMedicines: {cold:"Medicamento para el resfriado, ingrediente no especificado", pain:"Medicamento para el dolor, ingrediente no especificado", bloodPressure:"Medicamento para la presión arterial, ingrediente no especificado", digestive:"Medicamento digestivo, ingrediente no especificado", fever:"Medicamento para la fiebre, ingrediente no especificado", antiInflammatory:"Antiinflamatorio, ingrediente no especificado"},
    allergiesMap: {peanut:"Alergia al maní", pollen:"Alergia al polen", penicillin:"Alergia a la penicilina"},
    conditionsMap: {asthma:"Asma", hypertension:"Hipertensión", diabetes:"Diabetes"}
  },
  fr: {
    locale: "fr",
    languageLabel: "Français",
    cardTitle: "Carte médicale",
    labels: {name:"Nom", passportName:"Nom sur le passeport", nationality:"Nationalité", age:"Âge", bloodType:"Groupe sanguin", allergies:"Allergies", medication:"Médicaments", medicalConditions:"Antécédents médicaux", emergencyContact:"Contact d'urgence", travelInsurance:"Assurance voyage", hotelAddress:"Adresse de l'hôtel"},
    blankValue: "Non renseigné",
    noneValue: "Aucun",
    medicationUserEnteredSuffix: "médicament indiqué par l’utilisateur",
    genericMedicineIngredientUnspecified: "ingrédient non précisé",
    southKoreaNationality: "Corée du Sud",
    genericMedicines: {cold:"Médicament contre le rhume, ingrédient non précisé", pain:"Médicament contre la douleur, ingrédient non précisé", bloodPressure:"Médicament pour la tension artérielle, ingrédient non précisé", digestive:"Médicament digestif, ingrédient non précisé", fever:"Médicament contre la fièvre, ingrédient non précisé", antiInflammatory:"Anti-inflammatoire, ingrédient non précisé"},
    allergiesMap: {peanut:"Allergie aux arachides", pollen:"Allergie au pollen", penicillin:"Allergie à la pénicilline"},
    conditionsMap: {asthma:"Asthme", hypertension:"Hypertension", diabetes:"Diabète"}
  },
  it: {
    locale: "it",
    languageLabel: "Italiano",
    cardTitle: "Scheda medica",
    labels: {name:"Nome", passportName:"Nome sul passaporto", nationality:"Nazionalità", age:"Età", bloodType:"Gruppo sanguigno", allergies:"Allergie", medication:"Farmaci assunti", medicalConditions:"Patologie pregresse", emergencyContact:"Contatto di emergenza", travelInsurance:"Assicurazione viaggio", hotelAddress:"Indirizzo hotel"},
    blankValue: "Non indicato",
    noneValue: "Nessuno",
    medicationUserEnteredSuffix: "farmaco indicato dall'utente",
    genericMedicineIngredientUnspecified: "principio attivo non specificato",
    southKoreaNationality: "Corea del Sud",
    genericMedicines: {cold:"Farmaco per il raffreddore, principio attivo non specificato", pain:"Farmaco per il dolore, principio attivo non specificato", bloodPressure:"Farmaco per la pressione arteriosa, principio attivo non specificato", digestive:"Farmaco digestivo, principio attivo non specificato", fever:"Farmaco per la febbre, principio attivo non specificato", antiInflammatory:"Antinfiammatorio, principio attivo non specificato"},
    allergiesMap: {peanut:"Allergia alle arachidi", pollen:"Allergia al polline", penicillin:"Allergia alla penicillina"},
    conditionsMap: {asthma:"Asma", hypertension:"Ipertensione", diabetes:"Diabete"}
  },
  zh: {
    locale: "zh",
    languageLabel: "中文",
    cardTitle: "医疗卡",
    labels: {name:"姓名", passportName:"护照英文姓名", nationality:"国籍", age:"年龄", bloodType:"血型", allergies:"过敏", medication:"正在服用的药物", medicalConditions:"既往病史", emergencyContact:"紧急联系人", travelInsurance:"旅行保险", hotelAddress:"酒店地址"},
    blankValue: "未填写",
    noneValue: "无",
    medicationUserEnteredSuffix: "用户输入的药品",
    genericMedicineIngredientUnspecified: "成分未注明",
    southKoreaNationality: "韩国",
    genericMedicines: {cold:"感冒药，成分未注明", pain:"止痛药，成分未注明", bloodPressure:"血压药，成分未注明", digestive:"消化药，成分未注明", fever:"退烧药，成分未注明", antiInflammatory:"消炎药，成分未注明"},
    allergiesMap: {peanut:"花生过敏", pollen:"花粉过敏", penicillin:"青霉素过敏"},
    conditionsMap: {asthma:"哮喘", hypertension:"高血压", diabetes:"糖尿病"}
  },
  ja: {
    locale: "ja",
    languageLabel: "日本語",
    cardTitle: "医療カード",
    labels: {name:"氏名", passportName:"パスポート上の英字名", nationality:"国籍", age:"年齢", bloodType:"血液型", allergies:"アレルギー", medication:"服用中の薬", medicalConditions:"既往歴", emergencyContact:"緊急連絡先", travelInsurance:"旅行保険", hotelAddress:"宿泊先住所"},
    blankValue: "未入力",
    noneValue: "なし",
    medicationUserEnteredSuffix: "利用者が入力した薬",
    genericMedicineIngredientUnspecified: "成分は未記載",
    southKoreaNationality: "韓国",
    genericMedicines: {cold:"風邪薬、成分は未記載", pain:"痛み止め、成分は未記載", bloodPressure:"血圧の薬、成分は未記載", digestive:"胃腸薬、成分は未記載", fever:"解熱薬、成分は未記載", antiInflammatory:"抗炎症薬、成分は未記載"},
    allergiesMap: {peanut:"ピーナッツアレルギー", pollen:"花粉アレルギー", penicillin:"ペニシリンアレルギー"},
    conditionsMap: {asthma:"喘息", hypertension:"高血圧", diabetes:"糖尿病"}
  },
  ar: {
    locale: "ar",
    languageLabel: "العربية",
    cardTitle: "بطاقة طبية",
    labels: {name:"الاسم", passportName:"الاسم في جواز السفر", nationality:"الجنسية", age:"العمر", bloodType:"فصيلة الدم", allergies:"الحساسية", medication:"الأدوية الحالية", medicalConditions:"الحالات الطبية السابقة", emergencyContact:"جهة اتصال الطوارئ", travelInsurance:"تأمين السفر", hotelAddress:"عنوان الفندق"},
    blankValue: "غير مذكور",
    noneValue: "لا يوجد",
    medicationUserEnteredSuffix: "دواء أدخله المستخدم",
    genericMedicineIngredientUnspecified: "المكوّن غير محدد",
    southKoreaNationality: "كوريا الجنوبية",
    genericMedicines: {cold:"دواء للزكام، المكوّن غير محدد", pain:"دواء للألم، المكوّن غير محدد", bloodPressure:"دواء لضغط الدم، المكوّن غير محدد", digestive:"دواء للهضم، المكوّن غير محدد", fever:"دواء للحمى، المكوّن غير محدد", antiInflammatory:"دواء مضاد للالتهاب، المكوّن غير محدد"},
    allergiesMap: {peanut:"حساسية من الفول السوداني", pollen:"حساسية من حبوب اللقاح", penicillin:"حساسية من البنسلين"},
    conditionsMap: {asthma:"الربو", hypertension:"ارتفاع ضغط الدم", diabetes:"السكري"}
  },
  de: {
    locale: "de",
    languageLabel: "Deutsch",
    cardTitle: "Medizinische Karte",
    labels: {name:"Name", passportName:"Name im Reisepass", nationality:"Nationalität", age:"Alter", bloodType:"Blutgruppe", allergies:"Allergien", medication:"Medikamente", medicalConditions:"Vorerkrankungen", emergencyContact:"Notfallkontakt", travelInsurance:"Reiseversicherung", hotelAddress:"Hoteladresse"},
    blankValue: "Nicht angegeben",
    noneValue: "Keine",
    medicationUserEnteredSuffix: "vom Benutzer angegebenes Medikament",
    genericMedicineIngredientUnspecified: "Wirkstoff nicht angegeben",
    southKoreaNationality: "Südkorea",
    genericMedicines: {cold:"Erkältungsmedikament, Wirkstoff nicht angegeben", pain:"Schmerzmittel, Wirkstoff nicht angegeben", bloodPressure:"Blutdruckmedikament, Wirkstoff nicht angegeben", digestive:"Verdauungsmedikament, Wirkstoff nicht angegeben", fever:"Fiebermedikament, Wirkstoff nicht angegeben", antiInflammatory:"Entzündungshemmendes Medikament, Wirkstoff nicht angegeben"},
    allergiesMap: {peanut:"Erdnussallergie", pollen:"Pollenallergie", penicillin:"Penicillinallergie"},
    conditionsMap: {asthma:"Asthma", hypertension:"Bluthochdruck", diabetes:"Diabetes"}
  },
  vi: {
    locale: "vi",
    languageLabel: "Tiếng Việt",
    cardTitle: "Thẻ y tế",
    labels: {name:"Họ tên", passportName:"Tên trên hộ chiếu", nationality:"Quốc tịch", age:"Tuổi", bloodType:"Nhóm máu", allergies:"Dị ứng", medication:"Thuốc đang dùng", medicalConditions:"Bệnh nền", emergencyContact:"Liên hệ khẩn cấp", travelInsurance:"Bảo hiểm du lịch", hotelAddress:"Địa chỉ khách sạn"},
    blankValue: "Chưa cung cấp",
    noneValue: "Không có",
    medicationUserEnteredSuffix: "thuốc do người dùng nhập",
    genericMedicineIngredientUnspecified: "không rõ thành phần",
    southKoreaNationality: "Hàn Quốc",
    genericMedicines: {cold:"Thuốc cảm, không rõ thành phần", pain:"Thuốc giảm đau, không rõ thành phần", bloodPressure:"Thuốc huyết áp, không rõ thành phần", digestive:"Thuốc tiêu hóa, không rõ thành phần", fever:"Thuốc hạ sốt, không rõ thành phần", antiInflammatory:"Thuốc chống viêm, không rõ thành phần"},
    allergiesMap: {peanut:"Dị ứng đậu phộng", pollen:"Dị ứng phấn hoa", penicillin:"Dị ứng penicillin"},
    conditionsMap: {asthma:"Hen suyễn", hypertension:"Tăng huyết áp", diabetes:"Tiểu đường"}
  },
  th: {
    locale: "th",
    languageLabel: "ไทย",
    cardTitle: "บัตรข้อมูลทางการแพทย์",
    labels: {name:"ชื่อ", passportName:"ชื่อภาษาอังกฤษตามหนังสือเดินทาง", nationality:"สัญชาติ", age:"อายุ", bloodType:"กรุ๊ปเลือด", allergies:"อาการแพ้", medication:"ยาที่ใช้อยู่", medicalConditions:"โรคประจำตัว", emergencyContact:"ผู้ติดต่อฉุกเฉิน", travelInsurance:"ประกันการเดินทาง", hotelAddress:"ที่อยู่โรงแรม"},
    blankValue: "ไม่ได้ระบุ",
    noneValue: "ไม่มี",
    medicationUserEnteredSuffix: "ยาที่ผู้ใช้ระบุ",
    genericMedicineIngredientUnspecified: "ไม่ระบุส่วนประกอบ",
    southKoreaNationality: "เกาหลีใต้",
    genericMedicines: {cold:"ยาแก้หวัด ไม่ระบุส่วนประกอบ", pain:"ยาแก้ปวด ไม่ระบุส่วนประกอบ", bloodPressure:"ยาความดันโลหิต ไม่ระบุส่วนประกอบ", digestive:"ยาช่วยย่อย ไม่ระบุส่วนประกอบ", fever:"ยาลดไข้ ไม่ระบุส่วนประกอบ", antiInflammatory:"ยาต้านการอักเสบ ไม่ระบุส่วนประกอบ"},
    allergiesMap: {peanut:"แพ้ถั่วลิสง", pollen:"แพ้เกสรดอกไม้", penicillin:"แพ้เพนิซิลลิน"},
    conditionsMap: {asthma:"โรคหืด", hypertension:"ความดันโลหิตสูง", diabetes:"เบาหวาน"}
  },
  tr: {
    locale: "tr",
    languageLabel: "Türkçe",
    cardTitle: "Tıbbi Kart",
    labels: {name:"Ad", passportName:"Pasaporttaki ad", nationality:"Uyruk", age:"Yaş", bloodType:"Kan grubu", allergies:"Alerjiler", medication:"Kullanılan ilaçlar", medicalConditions:"Tıbbi durumlar", emergencyContact:"Acil durum kişisi", travelInsurance:"Seyahat sigortası", hotelAddress:"Otel adresi"},
    blankValue: "Belirtilmedi",
    noneValue: "Yok",
    medicationUserEnteredSuffix: "kullanıcının girdiği ilaç",
    genericMedicineIngredientUnspecified: "içeriği belirtilmemiş",
    southKoreaNationality: "Güney Kore",
    genericMedicines: {cold:"Soğuk algınlığı ilacı, içeriği belirtilmemiş", pain:"Ağrı kesici, içeriği belirtilmemiş", bloodPressure:"Tansiyon ilacı, içeriği belirtilmemiş", digestive:"Sindirim ilacı, içeriği belirtilmemiş", fever:"Ateş düşürücü, içeriği belirtilmemiş", antiInflammatory:"İltihap giderici ilaç, içeriği belirtilmemiş"},
    allergiesMap: {peanut:"Yer fıstığı alerjisi", pollen:"Polen alerjisi", penicillin:"Penisilin alerjisi"},
    conditionsMap: {asthma:"Astım", hypertension:"Yüksek tansiyon", diabetes:"Diyabet"}
  },
  pt: {
    locale: "pt",
    languageLabel: "Português",
    cardTitle: "Cartão médico",
    labels: {name:"Nome", passportName:"Nome no passaporte", nationality:"Nacionalidade", age:"Idade", bloodType:"Tipo sanguíneo", allergies:"Alergias", medication:"Medicamentos em uso", medicalConditions:"Condições médicas", emergencyContact:"Contato de emergência", travelInsurance:"Seguro viagem", hotelAddress:"Endereço do hotel"},
    blankValue: "Não informado",
    noneValue: "Nenhum",
    medicationUserEnteredSuffix: "medicamento informado pelo usuário",
    genericMedicineIngredientUnspecified: "ingrediente não especificado",
    southKoreaNationality: "Coreia do Sul",
    genericMedicines: {cold:"Remédio para resfriado, ingrediente não especificado", pain:"Medicamento para dor, ingrediente não especificado", bloodPressure:"Medicamento para pressão arterial, ingrediente não especificado", digestive:"Medicamento digestivo, ingrediente não especificado", fever:"Medicamento para febre, ingrediente não especificado", antiInflammatory:"Anti-inflamatório, ingrediente não especificado"},
    allergiesMap: {peanut:"Alergia a amendoim", pollen:"Alergia ao pólen", penicillin:"Alergia à penicilina"},
    conditionsMap: {asthma:"Asma", hypertension:"Hipertensão", diabetes:"Diabetes"}
  },
  nl: {
    locale: "nl",
    languageLabel: "Nederlands",
    cardTitle: "Medische kaart",
    labels: {name:"Naam", passportName:"Naam in paspoort", nationality:"Nationaliteit", age:"Leeftijd", bloodType:"Bloedgroep", allergies:"Allergieën", medication:"Medicatie", medicalConditions:"Medische aandoeningen", emergencyContact:"Noodcontact", travelInsurance:"Reisverzekering", hotelAddress:"Hoteladres"},
    blankValue: "Niet opgegeven",
    noneValue: "Geen",
    medicationUserEnteredSuffix: "door gebruiker ingevoerd medicijn",
    genericMedicineIngredientUnspecified: "bestanddeel niet vermeld",
    southKoreaNationality: "Zuid-Korea",
    genericMedicines: {cold:"Verkoudheidsmedicijn, bestanddeel niet vermeld", pain:"Pijnmedicatie, bestanddeel niet vermeld", bloodPressure:"Bloeddrukmedicatie, bestanddeel niet vermeld", digestive:"Spijsverteringsmedicijn, bestanddeel niet vermeld", fever:"Koortsmedicatie, bestanddeel niet vermeld", antiInflammatory:"Ontstekingsremmer, bestanddeel niet vermeld"},
    allergiesMap: {peanut:"Pinda-allergie", pollen:"Pollenallergie", penicillin:"Penicilline-allergie"},
    conditionsMap: {asthma:"Astma", hypertension:"Hoge bloeddruk", diabetes:"Diabetes"}
  },
  ms: {
    locale: "ms",
    languageLabel: "Bahasa Melayu",
    cardTitle: "Kad perubatan",
    labels: {name:"Nama", passportName:"Nama pada pasport", nationality:"Kewarganegaraan", age:"Umur", bloodType:"Jenis darah", allergies:"Alahan", medication:"Ubat yang diambil", medicalConditions:"Keadaan perubatan", emergencyContact:"Hubungan kecemasan", travelInsurance:"Insurans perjalanan", hotelAddress:"Alamat hotel"},
    blankValue: "Tidak diberikan",
    noneValue: "Tiada",
    medicationUserEnteredSuffix: "ubat yang dimasukkan pengguna",
    genericMedicineIngredientUnspecified: "bahan tidak dinyatakan",
    southKoreaNationality: "Korea Selatan",
    genericMedicines: {cold:"Ubat selesema, bahan tidak dinyatakan", pain:"Ubat sakit, bahan tidak dinyatakan", bloodPressure:"Ubat tekanan darah, bahan tidak dinyatakan", digestive:"Ubat pencernaan, bahan tidak dinyatakan", fever:"Ubat demam, bahan tidak dinyatakan", antiInflammatory:"Ubat antiradang, bahan tidak dinyatakan"},
    allergiesMap: {peanut:"Alahan kacang tanah", pollen:"Alahan debunga", penicillin:"Alahan penisilin"},
    conditionsMap: {asthma:"Asma", hypertension:"Tekanan darah tinggi", diabetes:"Diabetes"}
  },
  id: {
    locale: "id",
    languageLabel: "Bahasa Indonesia",
    cardTitle: "Kartu medis",
    labels: {name:"Nama", passportName:"Nama pada paspor", nationality:"Kewarganegaraan", age:"Usia", bloodType:"Golongan darah", allergies:"Alergi", medication:"Obat yang digunakan", medicalConditions:"Kondisi medis", emergencyContact:"Kontak darurat", travelInsurance:"Asuransi perjalanan", hotelAddress:"Alamat hotel"},
    blankValue: "Tidak diisi",
    noneValue: "Tidak ada",
    medicationUserEnteredSuffix: "obat yang dimasukkan pengguna",
    genericMedicineIngredientUnspecified: "kandungan tidak disebutkan",
    southKoreaNationality: "Korea Selatan",
    genericMedicines: {cold:"Obat flu, kandungan tidak disebutkan", pain:"Obat nyeri, kandungan tidak disebutkan", bloodPressure:"Obat tekanan darah, kandungan tidak disebutkan", digestive:"Obat pencernaan, kandungan tidak disebutkan", fever:"Obat demam, kandungan tidak disebutkan", antiInflammatory:"Obat antiinflamasi, kandungan tidak disebutkan"},
    allergiesMap: {peanut:"Alergi kacang tanah", pollen:"Alergi serbuk sari", penicillin:"Alergi penisilin"},
    conditionsMap: {asthma:"Asma", hypertension:"Tekanan darah tinggi", diabetes:"Diabetes"}
  },
  pl: {
    locale: "pl",
    languageLabel: "Polski",
    cardTitle: "Karta medyczna",
    labels: {name:"Imię i nazwisko", passportName:"Imię i nazwisko w paszporcie", nationality:"Narodowość", age:"Wiek", bloodType:"Grupa krwi", allergies:"Alergie", medication:"Przyjmowane leki", medicalConditions:"Choroby przewlekłe", emergencyContact:"Kontakt alarmowy", travelInsurance:"Ubezpieczenie podróżne", hotelAddress:"Adres hotelu"},
    blankValue: "Nie podano",
    noneValue: "Brak",
    medicationUserEnteredSuffix: "lek wpisany przez użytkownika",
    genericMedicineIngredientUnspecified: "składnik nieokreślony",
    southKoreaNationality: "Korea Południowa",
    genericMedicines: {cold:"Lek na przeziębienie, składnik nieokreślony", pain:"Lek przeciwbólowy, składnik nieokreślony", bloodPressure:"Lek na ciśnienie, składnik nieokreślony", digestive:"Lek na trawienie, składnik nieokreślony", fever:"Lek na gorączkę, składnik nieokreślony", antiInflammatory:"Lek przeciwzapalny, składnik nieokreślony"},
    allergiesMap: {peanut:"Alergia na orzeszki ziemne", pollen:"Alergia na pyłki", penicillin:"Alergia na penicylinę"},
    conditionsMap: {asthma:"Astma", hypertension:"Nadciśnienie", diabetes:"Cukrzyca"}
  },
  da: {
    locale: "da",
    languageLabel: "Dansk",
    cardTitle: "Medicinsk kort",
    labels: {name:"Navn", passportName:"Navn i pas", nationality:"Nationalitet", age:"Alder", bloodType:"Blodtype", allergies:"Allergier", medication:"Medicin", medicalConditions:"Medicinske tilstande", emergencyContact:"Nødkontakt", travelInsurance:"Rejseforsikring", hotelAddress:"Hoteladresse"},
    blankValue: "Ikke angivet",
    noneValue: "Ingen",
    medicationUserEnteredSuffix: "lægemiddel angivet af brugeren",
    genericMedicineIngredientUnspecified: "indholdsstof ikke angivet",
    southKoreaNationality: "Sydkorea",
    genericMedicines: {cold:"Forkølelsesmedicin, indholdsstof ikke angivet", pain:"Smertemedicin, indholdsstof ikke angivet", bloodPressure:"Blodtryksmedicin, indholdsstof ikke angivet", digestive:"Fordøjelsesmedicin, indholdsstof ikke angivet", fever:"Febermedicin, indholdsstof ikke angivet", antiInflammatory:"Antiinflammatorisk medicin, indholdsstof ikke angivet"},
    allergiesMap: {peanut:"Jordnøddeallergi", pollen:"Pollenallergi", penicillin:"Penicillinallergi"},
    conditionsMap: {asthma:"Astma", hypertension:"Forhøjet blodtryk", diabetes:"Diabetes"}
  },
  el: {
    locale: "el",
    languageLabel: "Ελληνικά",
    cardTitle: "Ιατρική κάρτα",
    labels: {name:"Όνομα", passportName:"Όνομα στο διαβατήριο", nationality:"Εθνικότητα", age:"Ηλικία", bloodType:"Ομάδα αίματος", allergies:"Αλλεργίες", medication:"Φάρμακα", medicalConditions:"Ιατρικές παθήσεις", emergencyContact:"Επαφή έκτακτης ανάγκης", travelInsurance:"Ταξιδιωτική ασφάλιση", hotelAddress:"Διεύθυνση ξενοδοχείου"},
    blankValue: "Δεν παρέχεται",
    noneValue: "Κανένα",
    medicationUserEnteredSuffix: "φάρμακο που καταχώρισε ο χρήστης",
    genericMedicineIngredientUnspecified: "μη καθορισμένο συστατικό",
    southKoreaNationality: "Νότια Κορέα",
    genericMedicines: {cold:"Φάρμακο για κρυολόγημα, μη καθορισμένο συστατικό", pain:"Φάρμακο για πόνο, μη καθορισμένο συστατικό", bloodPressure:"Φάρμακο για αρτηριακή πίεση, μη καθορισμένο συστατικό", digestive:"Φάρμακο για την πέψη, μη καθορισμένο συστατικό", fever:"Φάρμακο για πυρετό, μη καθορισμένο συστατικό", antiInflammatory:"Αντιφλεγμονώδες φάρμακο, μη καθορισμένο συστατικό"},
    allergiesMap: {peanut:"Αλλεργία στα φιστίκια", pollen:"Αλλεργία στη γύρη", penicillin:"Αλλεργία στην πενικιλίνη"},
    conditionsMap: {asthma:"Άσθμα", hypertension:"Υψηλή αρτηριακή πίεση", diabetes:"Διαβήτης"}
  }
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

function getConfig(code){
  const lang = baseLanguage(code || "en");
  return MEDICAL_CARD_I18N[lang] ? {lang, cfg: {...MEDICAL_CARD_I18N[lang], dynamicConfig: false}} : null;
}

function dynamicConfig(languageCode, languageName){
  return {
    lang: baseLanguage(languageCode || "en"),
    cfg: {
      locale: languageCode || "en",
      languageLabel: languageName || languageCode || "the selected local language",
      cardTitle: "",
      labels: {},
      blankValue: "",
      noneValue: "",
      medicationUserEnteredSuffix: "",
      genericMedicineIngredientUnspecified: "",
      southKoreaNationality: "",
      genericMedicines: {},
      allergiesMap: {},
      conditionsMap: {},
      dynamicConfig: true
    }
  };
}

function getAttemptConfig(languageCode, languageName){
  return getConfig(languageCode) || dynamicConfig(languageCode, languageName);
}

function cleanFields(fields = {}){
  const source = fields && typeof fields === "object" ? fields : {};
  const aliases = {
    medication: ["medications"],
    medicalConditions: ["conditions"],
    travelInsurance: ["insurance"],
    hotelAddress: ["accommodation"]
  };
  const cleaned = {};
  FIELD_KEYS.forEach((key) => {
    const aliasValue = (aliases[key] || []).map((alias) => source[alias]).find((value) => text(value));
    cleaned[key] = text(source[key] || aliasValue);
  });
  return cleaned;
}

function isEmpty(value){
  return !text(value);
}

function isNoneInput(value){
  return /^(없음|없다|없어요|무|해당없음|해당 없음|none|no|n\/a|na|nil)$/i.test(text(value));
}

function isSouthKoreaInput(value){
  return /^(대한민국|한국|korea|south korea|republic of korea|rok|korean|coreano|corean|korean person|corea del sur|corée du sud)$/i.test(text(value));
}

const medicationBrandPatterns = [
  {pattern: /타이레놀|tylenol/gi, display: "Tylenol"},
  {pattern: /애드빌|advil/gi, display: "Advil"},
  {pattern: /이지엔|ezn/gi, display: "EZN"},
  {pattern: /판콜|pankol|pancol/gi, display: "Pankol"},
  {pattern: /게보린|geborin/gi, display: "Geborin"}
];

const directIngredientPatterns = [
  {pattern: /아세트아미노펜|acetaminophen/gi, display: "Acetaminophen"},
  {pattern: /파라세타몰|paracetamol/gi, display: "Paracetamol"},
  {pattern: /이부프로펜|ibuprofen/gi, display: "Ibuprofen"},
  {pattern: /아스피린|aspirin/gi, display: "Aspirin"}
];

const genericMedicinePatterns = [
  {key: "cold", pattern: /^(감기약|cold medicine)$/i},
  {key: "pain", pattern: /^(진통제|painkiller|pain reliever|pain medication|analgesic)$/i},
  {key: "bloodPressure", pattern: /^(혈압약|고혈압약|blood pressure medication|blood pressure medicine)$/i},
  {key: "digestive", pattern: /^(소화제|digestive medicine|stomach medicine)$/i},
  {key: "fever", pattern: /^(해열제|fever medicine|fever medication)$/i},
  {key: "antiInflammatory", pattern: /^(소염제|anti-inflammatory|anti inflammatory drug|anti-inflammatory drug)$/i}
];

const allergyPatterns = [
  {key: "peanut", pattern: /땅콩|peanut|man[ií]|cacahuate|arachide/i},
  {key: "pollen", pattern: /꽃가루|pollen|polen|pollen|花粉/i},
  {key: "penicillin", pattern: /페니실린|penicillin|p[eé]nicilline|penicilina|青霉素|ペニシリン/i}
];

const conditionPatterns = [
  {key: "asthma", pattern: /^(천식|asthma|asma|asthme|哮喘|喘息)$/i},
  {key: "hypertension", pattern: /^(고혈압|hypertension|high blood pressure|hipertensi[oó]n|高血压|高血圧)$/i},
  {key: "diabetes", pattern: /^(당뇨|당뇨병|diabetes|diab[eè]te|糖尿病)$/i}
];

function normalizeKnownValue(value, patterns){
  const raw = text(value);
  for(const item of patterns){
    if(item.pattern.test(raw)){
      item.pattern.lastIndex = 0;
      return item;
    }
    item.pattern.lastIndex = 0;
  }
  return null;
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

function preserveDirectIngredient(value){
  let preserved = text(value);
  let matched = false;
  directIngredientPatterns.forEach((item) => {
    if(item.pattern.test(preserved)){
      matched = true;
      preserved = preserved.replace(item.pattern, item.display);
    }
    item.pattern.lastIndex = 0;
  });
  return matched ? preserved : "";
}

function medicationProductFor(name, cfg){
  const separator = baseLanguage(cfg.locale) === "ja" ? "、" : (baseLanguage(cfg.locale) === "zh" ? "，" : ", ");
  return `${name}${separator}${cfg.medicationUserEnteredSuffix}`;
}

function looksLikeUnsafeMedicationInference(value){
  return /(paracetamol|acetaminophen|ibuprofen|aspirin|painkiller|pain reliever|cold medicine|anti-inflammatory drug|acetaminof[eé]n|parac[eé]tamol|ibuprofeno|analg[eé]sico|medicamento para el resfriado|m[eé]dicament contre le rhume|antalgique|antipyr[eé]tique|風邪薬|감기약|진통제|해열제|혈압약|소화제|感冒药|止痛药|退烧药|Erkältungsmedikament|Schmerzmittel|Farmaco per il raffreddore|Remédio para resfriado)/i.test(text(value));
}

function looksLikeUnsafeConditionInference(value, originalValue){
  const translated = text(value);
  const original = text(originalValue);
  if(!translated) return false;
  const unsafe = /(severe|attack|heart attack|needs inhaler|requires immediate|urgent treatment|traitement imm[eé]diat|ataque|grave|응급|심각|치료 필요)/i.test(translated);
  return unsafe && !/(severe|attack|heart attack|needs inhaler|requires immediate|urgent treatment|심각|응급|치료 필요)/i.test(original);
}

function hasWrongLanguagePlaceholder(value, lang){
  if(lang === "en") return false;
  return /^(Not provided|No information provided|None|No|N\/A)$/i.test(text(value));
}

function hasStaticConfig(cfg){
  return !cfg.dynamicConfig;
}

function fallbackBlank(resultValue, cfg){
  return text(resultValue) || (hasStaticConfig(cfg) ? cfg.blankValue : "");
}

function fallbackNone(resultValue, cfg){
  return text(resultValue) || (hasStaticConfig(cfg) ? cfg.noneValue : "");
}

function valueOrFallback(resultValue, originalValue, lang, cfg){
  const raw = text(originalValue);
  if(isEmpty(raw)) return fallbackBlank(resultValue, cfg);
  if(isNoneInput(raw)) return fallbackNone(resultValue, cfg);
  const translated = text(resultValue);
  if(translated && !hasWrongLanguagePlaceholder(translated, lang)) return translated;
  return raw;
}

function normalizeName(result = {}, original, cfg){
  const koreanName = text(original.name);
  const passportName = text(original.passportName);
  if(!koreanName && !passportName) return fallbackBlank(result.name, cfg);
  if(passportName && koreanName) return `${passportName} (${koreanName})`;
  if(passportName) return passportName;
  const translatedName = text(result.name);
  if(translatedName && !looksLikeUnsafeMedicationInference(translatedName) && !translatedName.includes(koreanName)){
    return `${translatedName} (${koreanName})`;
  }
  return koreanName;
}

function normalizeNationality(resultValue, originalValue, lang, cfg){
  const raw = text(originalValue);
  if(isEmpty(raw)) return fallbackBlank(resultValue, cfg);
  if(isNoneInput(raw)) return fallbackNone(resultValue, cfg);
  const translated = text(resultValue);
  if(isSouthKoreaInput(raw)) return translated && !isSouthKoreaInput(translated) ? translated : (cfg.southKoreaNationality || translated || raw);
  if(isSouthKoreaInput(translated)) return cfg.southKoreaNationality;
  if(translated && !/^(coreano|corean|korean person)$/i.test(translated) && !hasWrongLanguagePlaceholder(translated, lang)) return translated;
  return raw;
}

function normalizeAllergy(resultValue, originalValue, lang, cfg){
  const raw = text(originalValue);
  if(isEmpty(raw)) return fallbackBlank(resultValue, cfg);
  if(isNoneInput(raw)) return fallbackNone(resultValue, cfg);
  const known = normalizeKnownValue(raw, allergyPatterns);
  const translated = text(resultValue);
  if(!hasStaticConfig(cfg) && translated && !hasWrongLanguagePlaceholder(translated, lang)) return translated;
  if(known && cfg.allergiesMap[known.key]) return cfg.allergiesMap[known.key];
  if(translated && !hasWrongLanguagePlaceholder(translated, lang)) return translated;
  return raw;
}

function normalizeMedication(resultValue, originalValue, cfg){
  const raw = text(originalValue);
  if(isEmpty(raw)) return fallbackBlank(resultValue, cfg);
  if(isNoneInput(raw)) return fallbackNone(resultValue, cfg);
  const translated = text(resultValue);
  const brand = preserveMedicationBrandName(raw);
  if(brand){
    if(translated && translated.toLowerCase().includes(brand.toLowerCase()) && !looksLikeUnsafeMedicationInference(translated)) return translated;
    return hasStaticConfig(cfg) ? medicationProductFor(brand, cfg) : brand;
  }
  const ingredient = preserveDirectIngredient(raw);
  if(ingredient) return ingredient;
  const generic = normalizeKnownValue(raw, genericMedicinePatterns);
  if(!hasStaticConfig(cfg) && translated && !looksLikeUnsafeMedicationInference(translated)) return translated;
  if(generic && cfg.genericMedicines[generic.key]) return cfg.genericMedicines[generic.key];
  if(translated && !looksLikeUnsafeMedicationInference(translated)) return translated;
  return hasStaticConfig(cfg) ? medicationProductFor(raw, cfg) : raw;
}

function normalizeCondition(resultValue, originalValue, lang, cfg){
  const raw = text(originalValue);
  if(isEmpty(raw)) return fallbackBlank(resultValue, cfg);
  if(isNoneInput(raw)) return fallbackNone(resultValue, cfg);
  const known = normalizeKnownValue(raw, conditionPatterns);
  const translated = text(resultValue);
  if(!hasStaticConfig(cfg) && translated && !hasWrongLanguagePlaceholder(translated, lang) && !looksLikeUnsafeConditionInference(translated, raw)) return translated;
  if(known && cfg.conditionsMap[known.key]) return cfg.conditionsMap[known.key];
  if(translated && !hasWrongLanguagePlaceholder(translated, lang) && !looksLikeUnsafeConditionInference(translated, raw)) return translated;
  return raw;
}

function normalizeResult(result = {}, original, lang, cfg){
  const responseLabels = result && (result._labels || result.labels);
  const cardTitle = text(result._cardTitle || result.cardTitle) || (hasStaticConfig(cfg) ? cfg.cardTitle : "");
  const blankValue = text(result._blankValue || result.blankValue) || (hasStaticConfig(cfg) ? cfg.blankValue : "");
  const labels = {};
  FIELD_KEYS.forEach((key) => {
    labels[key] = text(responseLabels && responseLabels[key]) || (hasStaticConfig(cfg) && cfg.labels && cfg.labels[key]) || key;
  });
  return {
    _cardTitle: cardTitle,
    _blankValue: blankValue,
    _labels: labels,
    name: normalizeName(result, original, cfg),
    passportName: text(original.passportName),
    nationality: normalizeNationality(result.nationality, original.nationality, lang, cfg),
    age: isEmpty(original.age) ? fallbackBlank(result.age, cfg) : text(original.age),
    bloodType: isEmpty(original.bloodType) ? fallbackBlank(result.bloodType, cfg) : text(original.bloodType),
    allergies: normalizeAllergy(result.allergies, original.allergies, lang, cfg),
    medication: normalizeMedication(result.medication, original.medication, cfg),
    medicalConditions: normalizeCondition(result.medicalConditions, original.medicalConditions, lang, cfg),
    emergencyContact: isEmpty(original.emergencyContact) ? fallbackBlank(result.emergencyContact, cfg) : text(original.emergencyContact),
    travelInsurance: valueOrFallback(result.travelInsurance, original.travelInsurance, lang, cfg),
    hotelAddress: valueOrFallback(result.hotelAddress, original.hotelAddress, lang, cfg)
  };
}

function hasEnglishFallbackLeak(normalized, lang){
  if(baseLanguage(lang) === "en") return false;
  const values = [
    normalized._cardTitle,
    normalized._blankValue,
    normalized.name,
    normalized.nationality,
    normalized.allergies,
    normalized.medication,
    normalized.medicalConditions,
    normalized.emergencyContact,
    normalized.travelInsurance,
    normalized.hotelAddress
  ].map(text).join("\n");
  return /\b(Medical Card|Not provided|Peanut allergy|medication entered by the user)\b/i.test(values);
}

function hasMissingDynamicOutput(normalized, cfg){
  if(hasStaticConfig(cfg)) return false;
  return !normalized._cardTitle ||
    !normalized._blankValue ||
    FIELD_KEYS.some((key) => !text(normalized[key]));
}

function addAttempt(attempts, languageName, languageCode, reason, fallbackUsed){
  const name = text(languageName);
  const code = text(languageCode);
  if(!name && !code) return;
  const normalizedCode = code.toLowerCase();
  const normalizedName = name.toLowerCase();
  if(attempts.some((item) => item.languageCode.toLowerCase() === normalizedCode && item.languageName.toLowerCase() === normalizedName && item.reason === reason)) return;
  attempts.push({languageName: name || code, languageCode: code || name, reason, fallbackUsed: Boolean(fallbackUsed)});
}

function buildTranslationAttempts(body, targetLanguage, targetLanguageCode){
  const selectedCountry = body.selectedCountry && typeof body.selectedCountry === "object" ? body.selectedCountry : {};
  const attempts = [];
  addAttempt(attempts, targetLanguage, targetLanguageCode, "Primary language translation", false);
  addAttempt(attempts, targetLanguage, targetLanguageCode, "Primary language retry", false);
  addAttempt(
    attempts,
    body.fallbackLanguageNameEn || selectedCountry.fallbackLanguageNameEn,
    body.fallbackLanguageCode || selectedCountry.fallbackLanguageCode,
    "Primary language translation failed",
    true
  );
  if(baseLanguage(targetLanguageCode) === "fil"){
    addAttempt(attempts, "Tagalog", "tl", "Filipino translation failed", true);
  }
  if(!attempts.some((item) => baseLanguage(item.languageCode) === "en")){
    addAttempt(attempts, "English", "en", "Fallback language translation failed", true);
  }
  return attempts;
}

async function translateOnce({attempt, fields, travelCountry}){
  const attemptConfig = getAttemptConfig(attempt.languageCode, attempt.languageName);
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
        {role: "system", content: systemPrompt(attemptConfig.cfg)},
        {
          role: "user",
          content: JSON.stringify({
            targetLanguage: attempt.languageName,
            targetLanguageCode: attempt.languageCode,
            travelCountry,
            fieldOrder: FIELD_KEYS,
            labelKeys: FIELD_KEYS,
            fields
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
  const normalized = normalizeResult(parsed, fields, attemptConfig.lang, attemptConfig.cfg);

  if(hasMissingDynamicOutput(normalized, attemptConfig.cfg)){
    throw new Error("Missing target-language medical card fields");
  }

  if(hasEnglishFallbackLeak(normalized, attemptConfig.lang)){
    throw new Error("Target-language validation failed");
  }

  return {
    ...normalized,
    language: attempt.languageName,
    languageCode: attempt.languageCode,
    usedLanguage: attempt.languageName,
    usedLanguageCode: attempt.languageCode,
    fallbackUsed: attempt.fallbackUsed,
    fallbackReason: attempt.fallbackUsed ? attempt.reason : "",
    attempts: [attempt.reason]
  };
}

function buildLocalFallback(fields, reason){
  const cfg = MEDICAL_CARD_I18N.en;
  const normalized = normalizeResult({}, fields, "en", {...cfg, dynamicConfig: false});
  return {
    ...normalized,
    language: "English",
    languageCode: "en",
    usedLanguage: "English",
    usedLanguageCode: "en",
    fallbackUsed: true,
    fallbackReason: reason || "All translation attempts failed",
    _originalKo: fields,
    attempts: ["Local English fallback"]
  };
}

function systemPrompt(cfg){
  return [
    "You translate a Korean travel medical card for local medical staff.",
    "Return JSON only. Do not include Markdown or explanations.",
    `Target locale: ${cfg.locale}. Target language label: ${cfg.languageLabel}.`,
    "Keep the exact JSON keys. Never move a value into another field.",
    "Only translate the user-provided values for the same field.",
    "Do not add, infer, interpret, summarize, or create allergies, medicine ingredients, medical conditions, severity, symptoms, or care instructions.",
    "For empty fields, return a natural 'not provided' expression in the target language. For explicit none/no values, return a natural 'none' expression in the target language.",
    "For nationality values meaning South Korea, return the country name in the target language, not a word meaning Korean person.",
    "Preserve medicine names and product names. Do not convert product names into cold medicine, painkiller, fever reducer, paracetamol, acetaminophen, ibuprofen, anti-inflammatory drug, or any ingredient unless the user directly entered that ingredient.",
    "If the medication is a generic expression such as 감기약, 진통제, 혈압약, or 소화제, translate the generic category and state that the ingredient is not specified in the target language.",
    "For allergies, make the allergy meaning explicit in the target language.",
    "For existing medical conditions, translate only the condition name. Do not add severity, current status, or action advice.",
    "If the target language is not English, do not return English fallback phrases such as Medical Card, Not provided, Peanut allergy, or medication entered by the user.",
    "Also return _cardTitle, _blankValue, and _labels with target-language field labels for the same keys.",
    "Required JSON keys: _cardTitle, _blankValue, _labels, name, passportName, nationality, age, bloodType, allergies, medication, medicalConditions, emergencyContact, travelInsurance, hotelAddress."
  ].join("\n");
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  const bodyText = event.body || "{}";
  let body;
  try{
    body = JSON.parse(bodyText);
  }catch(error){
    return json(400, {error: "Invalid JSON body"});
  }

  const targetLanguageCode = text(body.targetLanguageCode);
  const requestedTargetLanguage = text(body.targetLanguage);

  if(!process.env.OPENAI_API_KEY){
    return json(500, {error: "OPENAI_API_KEY is not configured"});
  }

  if(!targetLanguageCode && !requestedTargetLanguage){
    return json(400, {error: "target language is required"});
  }

  const fields = cleanFields(body.fields || body.medicalCard || {});
  const selectedCountry = body.selectedCountry && typeof body.selectedCountry === "object" ? body.selectedCountry : {};
  const targetLanguage = requestedTargetLanguage || text(selectedCountry.languageNameEn) || targetLanguageCode || "the selected local language";
  const travelCountry = text(body.travelCountry || body.countryNameKo || body.countryNameEn);
  const attempts = buildTranslationAttempts(body, targetLanguage, targetLanguageCode);
  const attemptErrors = [];

  for(const attempt of attempts){
    try{
      const result = await translateOnce({attempt, fields, travelCountry});
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
    ...buildLocalFallback(fields, attemptErrors.length ? attemptErrors[attemptErrors.length - 1].message : "All translation attempts failed"),
    attemptErrors
  });
};
