/**
 * sensitive-questions.mjs - the questions this system never answers for the user.
 *
 * Legal, visa, work-authorization, salary and demographic questions are the
 * candidate's own to answer. That has always been the rule, and until now it
 * rested entirely on the planner honouring one bullet in its prompt and setting
 * needs_confirmation on those fields. That is the planner agreeing to refuse.
 *
 * A planner that returns needs_confirmation:false instead - a refusal arriving
 * as a fluent, confident, entirely invented sentence about the candidate's
 * immigration status or pay - had its value used: typed into a real employer's
 * form, or written into a report and re-read before the next application. A
 * prompt instruction is not an enforcement point.
 *
 * So the rule is a predicate, tested, applied at every point where a generated
 * answer could reach a field. It is the same defense-in-depth the apply flow
 * already applied to legal consent checkboxes, generalized from one bespoke
 * regex at one call site to one policy every caller shares. Callers must not
 * re-implement it; a second copy is a second thing to forget.
 *
 * The list leans deliberately wide. A false positive costs the candidate one
 * answer they were going to write themselves anyway. A false negative is an
 * invented answer about their immigration status sent to an employer, and it
 * looks exactly like a real one until after it has been sent.
 *
 * Plain .mjs and no imports, same reason as extract-json-object.mjs: `web/`'s
 * test runner is `node --test tests/**\/*.test.mjs`, so a .ts file or one
 * reaching through the `@/` alias cannot be tested at all.
 */

/**
 * @typedef {"visa" | "work-authorization" | "salary" | "demographic" | "legal" | "consent"} SensitiveCategory
 */

/**
 * Category patterns, in the order they are tried.
 *
 * No `g` flag on any of them, deliberately: a `g` regex carries `lastIndex`
 * between `.test()` calls, so a shared module-level pattern would start matching
 * every other question. That failure is silent and intermittent, which is the
 * worst possible shape for a guard whose whole job is to never miss one.
 *
 * @type {Array<{category: SensitiveCategory, pattern: RegExp}>}
 */
export const SENSITIVE_PATTERNS = [
  {
    // Immigration status. "sponsor" carries the near-universal phrasing "will you
    // now or in the future require sponsorship for employment".
    category: "visa",
    pattern:
      /\b(visas?|sponsorship|sponsor|immigration|work permits?|h-?1-?b|tn visa|green card|citizenship|citizen of|nationality|residency status|permanent resident)\b/i,
  },
  {
    // Right to work. Written as prefixes rather than whole words because the
    // forms spell it a dozen ways ("authorised", "authorization", "authorized").
    category: "work-authorization",
    pattern:
      /(\bwork authoris|\bwork authoriz|\bemployment authoris|\bemployment authoriz|\bauthoris(?:ed|ation) to work|\bauthoriz(?:ed|ation) to work|\blegally (?:able|entitled|authoris|authoriz|permitted|allowed) to work|\b(?:entitled|permitted) to work|\bpermission to work\b|\bright to work\b|\bwork eligib(?:le|ility)\b|\beligib(?:le|ility) to work)/i,
  },
  {
    // Pay. "compensation" is included knowing it also catches a question about
    // designing someone else's comp plan; that answer is one the candidate can
    // write, and the alternative is an invented salary expectation.
    category: "salary",
    pattern:
      /\b(salary|salaries|compensation|remuneration|wage|wages|current pay|expected pay|desired pay|pay expectation|pay range|expected rate|desired rate|rate expectation|hourly rate|day rate|equity expectation|bonus expectation)\b/i,
  },
  {
    // Protected characteristics, plus the self-identification blocks that carry
    // them. Accommodation and medical questions sit here for the same reason.
    category: "demographic",
    pattern:
      /\b(gender|sex|race(?![\s\u2010-\u2015-]+conditions?\b)|racial|ethnicity|ethnic|hispanic|latino|latina|latinx|disabilit(?:y|ies)|veterans?|sexual orientation|pronouns|marital status|religion|religious|date of birth|birth ?date|your age|age range|age group|how old are you|eeoc?|equal (?:employment )?opportunity|protected (?:veteran|class)|self-?identif|reasonable accommodation|medical condition|pregnan)/i,
  },
  {
    // Background and legal history.
    category: "legal",
    pattern:
      /\b(criminal|convicted|convictions?|felony|felonies|misdemeanou?rs?|plead(?:ed)? guilty|guilty plea|background check|drug (?:test|screen)|security clearance|clearance level|non-?compete|non-?disclosure|nda|terminated for cause|arrested|lawsuits?|litigation)\b/i,
  },
  {
    // Consent and agreement. An affirmative acceptance is the human's to give,
    // never the system's. This category is what the apply flow's original
    // consent-checkbox regex covered, and it must stay a superset of it: a
    // checkbox labelled only "Terms *" was caught by that regex's bare `terms`.
    //
    // The lookbehind is what makes keeping that word affordable. This predicate
    // now runs on free-text questions too, and "In terms of impact, what are you
    // proudest of?" is an ordinary question that must stay draftable. Excluding
    // the one idiom keeps the label coverage without eating the question.
    category: "consent",
    pattern:
      /\b(i (?:have )?read|i agree|i consent|i accept|consent to|privacy (?:notice|policy|statement)|terms and conditions|(?<!\bin )terms\b|gdpr|data protection)\b/i,
  },
];

/**
 * Which sensitive category a question or field label falls into, if any.
 *
 * @param {string} text The question or label as the employer wrote it.
 * @returns {SensitiveCategory | null} The category, or null when nothing matches.
 */
export function sensitiveCategory(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(s)) return category;
  }
  return null;
}

/**
 * Whether this question or field must never be auto-answered.
 *
 * @param {string} text The question or label as the employer wrote it.
 * @returns {boolean}
 */
export function isSensitiveQuestion(text) {
  return sensitiveCategory(text) !== null;
}

/**
 * Keep only planner answers for fields that the server actually extracted, and
 * force every sensitive answer back to the human-confirmation shape. The
 * planner output is untrusted data: field ids and labels from the request must
 * never decide whether a value is safe to use.
 *
 * @param {Array<{id: string, label?: string}>} fields The authoritative session fields.
 * @param {Record<string, unknown>} answers Raw planner output.
 * @returns {Record<string, object>} Safe planner output for the proxy UI.
 */
export function sanitizePrefillAnswers(fields, answers) {
  const byId = new Map(
    (Array.isArray(fields) ? fields : [])
      .filter((f) => f && typeof f.id === "string")
      .map((f) => [f.id, f]),
  );
  const safe = {};
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return safe;

  for (const [id, raw] of Object.entries(answers)) {
    const field = byId.get(id);
    if (!field || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = typeof raw.value === "string" ? raw.value : "";
    safe[id] = isSensitiveQuestion(field.label || "")
      ? { ...raw, value: "", needs_confirmation: true }
      : { ...raw, value };
  }
  return safe;
}

/**
 * Prepare answers for deterministic filling from the same authoritative field
 * list. Sensitive values are returned as skipped records unless the proxy has
 * recorded a direct human edit; unknown ids never reach a locator.
 *
 * @param {Array<{id: string, label?: string}>} fields The authoritative session fields.
 * @param {Record<string, unknown>} answers Client answer values keyed by field id.
 * @param {readonly string[]} confirmedSensitiveFieldIds Explicit human confirmations.
 * @returns {{answers: Record<string, string>, skipped: Array<{fieldId: string, label: string}>}}
 */
export function prepareFillAnswers(fields, answers, confirmedSensitiveFieldIds = []) {
  const byId = new Map(
    (Array.isArray(fields) ? fields : [])
      .filter((f) => f && typeof f.id === "string")
      .map((f) => [f.id, f]),
  );
  const confirmed = new Set(
    (Array.isArray(confirmedSensitiveFieldIds) ? confirmedSensitiveFieldIds : []).filter((id) => typeof id === "string"),
  );
  const allowed = {};
  const skipped = [];
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { answers: allowed, skipped };

  for (const [id, raw] of Object.entries(answers)) {
    const field = byId.get(id);
    const value = (raw ?? "").toString();
    if (!field || value === "") continue;
    if (isSensitiveQuestion(field.label || "") && !confirmed.has(id)) {
      skipped.push({ fieldId: id, label: field.label || id });
      continue;
    }
    allowed[id] = value;
  }
  return { answers: allowed, skipped };
}

/**
 * Convert client-side agent answers into the only form the browser-driving
 * agent accepts. The field id is authoritative; the client-provided label is
 * intentionally ignored. Sensitive fields and uploads never enter the agent's
 * prompt, even if a caller relabels one as an ordinary question.
 *
 * @param {Array<{id: string, label?: string, type?: string}>} fields The session fields.
 * @param {Array<{fieldId?: string, label?: string, value?: string}>} answers Client answers.
 * @returns {Array<{label: string, value: string}>} Answers safe to show the agent.
 */
export function canonicalDriveAnswers(fields, answers = []) {
  const byId = new Map(
    (Array.isArray(fields) ? fields : [])
      .filter((f) => f && typeof f.id === "string")
      .map((f) => [f.id, f]),
  );
  const safe = [];
  const seen = new Set();
  if (!Array.isArray(answers)) return safe;

  for (const answer of answers) {
    if (!answer || typeof answer !== "object") continue;
    const id = typeof answer.fieldId === "string" ? answer.fieldId : "";
    const field = byId.get(id);
    const value = typeof answer.value === "string" ? answer.value : "";
    if (!field || field.type === "file" || isSensitiveQuestion(field.label || "") || !value.trim() || seen.has(id)) continue;
    seen.add(id);
    safe.push({ label: field.label || field.id, value });
  }
  return safe;
}
