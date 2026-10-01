// SOS Bridge — common translation status contract (Phase 1 / Step 1).
//
// Pure module: no DOM, window, document, storage or network access, and no
// imports. Not yet wired into help phrases, the medical card or AI Care.
//
// Safety rule: a translation may be presented as the requested local language
// only when canShowAsLocal() returns true. The presence of a string is never
// evidence of a verified translation, and this module never upgrades a status
// to VERIFIED on its own (no provenance, reviewer or machine source is
// treated as verification here).

export const TRANSLATION_SCHEMA_VERSION = "translation-v1";

export const TRANSLATION_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  UNVERIFIED: "UNVERIFIED",
  FALLBACK: "FALLBACK",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  SOURCE_ONLY: "SOURCE_ONLY",
  PENDING: "PENDING"
});

export const TRANSLATION_STATUSES = Object.freeze(Object.values(TRANSLATION_STATUS));

// Descriptive provenance labels only. Choosing a label does not change the
// status; deciding what may become VERIFIED is a later, explicit step.
export const PROVENANCE_KIND = Object.freeze({
  STATIC_REVIEWED: "static-reviewed",
  STATIC_UNREVIEWED: "static-unreviewed",
  MACHINE: "machine",
  AI: "ai",
  SOURCE: "source"
});

const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export function isTranslationStatus(value){
  return typeof value === "string" && TRANSLATION_STATUSES.includes(value);
}

// Normalizes a language tag for comparison: trims and lower-cases (BCP 47
// tags are case-insensitive). No alias is applied and no subtag is dropped,
// so "zh-TW" and "zh" stay different, as do "pt-BR"/"pt" and "fil"/"tl".
// Anything that is not a well-formed tag becomes "".
export function normalizeLanguageCode(value){
  if(typeof value !== "string") return "";
  const tag = value.trim().toLowerCase();
  return LANGUAGE_TAG_PATTERN.test(tag) ? tag : "";
}

function normalizeProvenance(provenance){
  if(!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  const copy = {};
  for(const [key, value] of Object.entries(provenance)){
    if(typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null){
      copy[key] = value;
    }
  }
  return Object.freeze(copy);
}

function normalizeItems(items){
  const copy = {};
  if(items && typeof items === "object" && !Array.isArray(items)){
    for(const [key, item] of Object.entries(items)){
      if(!item || typeof item !== "object" || Array.isArray(item)) continue;
      copy[key] = Object.freeze({
        text: typeof item.text === "string" ? item.text : "",
        status: isTranslationStatus(item.status) ? item.status : TRANSLATION_STATUS.UNVERIFIED
      });
    }
  }
  return Object.freeze(copy);
}

function normalizeStringList(list){
  if(!Array.isArray(list)) return Object.freeze([]);
  return Object.freeze(list.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()));
}

// Builds an immutable translation-v1 result. The status is taken exactly as
// given (an unknown status throws); it is never inferred from text,
// provenance or language codes.
export function createTranslationResult(input = {}){
  const source = input && typeof input === "object" ? input : {};
  if(!isTranslationStatus(source.status)){
    throw new TypeError(`Unknown translation status: ${String(source.status)}`);
  }
  const delivered = normalizeLanguageCode(source.deliveredLanguageCode);
  return Object.freeze({
    schemaVersion: TRANSLATION_SCHEMA_VERSION,
    requestedLanguageCode: normalizeLanguageCode(source.requestedLanguageCode),
    deliveredLanguageCode: delivered || null,
    status: source.status,
    provenance: normalizeProvenance(source.provenance),
    items: normalizeItems(source.items),
    failedItems: normalizeStringList(source.failedItems),
    reasons: normalizeStringList(source.reasons)
  });
}

// The single display rule for local-language text:
//   status is exactly VERIFIED, and
//   requested and delivered language codes are both well-formed, non-empty
//   and identical after normalization (no alias).
// Every other input, including null/undefined/empty values and any status
// string other than the exact constant, returns false.
export function canShowAsLocal(result){
  if(!result || typeof result !== "object" || Array.isArray(result)) return false;
  if(result.status !== TRANSLATION_STATUS.VERIFIED) return false;
  const requested = normalizeLanguageCode(result.requestedLanguageCode);
  const delivered = normalizeLanguageCode(result.deliveredLanguageCode);
  if(!requested || !delivered) return false;
  return requested === delivered;
}
