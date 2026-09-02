/**
 * sensitive-questions.mjs - the questions this system never drafts an answer to.
 *
 * The panel and /api/answers both promise that legal, visa, work-authorization,
 * salary and demographic questions are left for the candidate. Until now that
 * promise rested entirely on the planner honouring one prompt bullet and setting
 * needs_confirmation on those fields. A planner that returns
 * needs_confirmation:false instead - a refusal arriving as a confident sentence -
 * produced a fabricated answer about the candidate's immigration status or pay,
 * written into the report and re-read later by `apply` as though the candidate
 * had written it. A prompt instruction is not an enforcement point.
 *
 * This is the same defense-in-depth the live apply flow already applies to legal
 * consent checkboxes (lib/apply/session.ts: "the planner already flags these
 * needs_confirmation; this guarantees it even if it slips"), stated once and
 * tested, so the guarantee is code rather than a sentence in a prompt.
 *
 * The list leans deliberately wide. A false positive costs the candidate one
 * answer they were going to write themselves anyway. A false negative is an
 * invented answer about their immigration status sent to an employer, and it
 * looks exactly like a real one until after it has been sent.
 *
 * Shared by the route (which refuses to send these to the planner, and refuses
 * any generated value for one) and by the panel (which labels them and leaves
 * them out of the draft count). One implementation, so the two surfaces cannot
 * disagree about which questions are the candidate's own.
 *
 * Plain .mjs and no imports, same reason as questions.mjs: `web/`'s test runner
 * is `node --test tests/**\/*.test.mjs`.
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
      /(\bwork authoris|\bwork authoriz|\bemployment authoris|\bemployment authoriz|\bauthoris(?:ed|ation) to work|\bauthoriz(?:ed|ation) to work|\blegally (?:able|entitled|authoris|authoriz)|\bright to work\b|\beligib(?:le|ility) to work)/i,
  },
  {
    // Pay. "compensation" is included knowing it also catches a question about
    // designing someone else's comp plan; that answer is one the candidate can
    // write, and the alternative is an invented salary expectation.
    category: "salary",
    pattern:
      /\b(salary|salaries|compensation|remuneration|current pay|expected pay|desired pay|pay expectation|pay range|expected rate|desired rate|rate expectation|hourly rate|day rate|equity expectation|bonus expectation)\b/i,
  },
  {
    // Protected characteristics, plus the self-identification blocks that carry
    // them. Accommodation and medical questions sit here for the same reason.
    category: "demographic",
    pattern:
      /\b(gender|sex|race|racial|ethnicity|ethnic|disabilit(?:y|ies)|veterans?|sexual orientation|pronouns|marital status|religion|religious|date of birth|birth ?date|your age|age range|age group|how old are you|eeoc?|equal (?:employment )?opportunity|protected (?:veteran|class)|self-?identif|reasonable accommodation|medical condition|pregnan)/i,
  },
  {
    // Background and legal history.
    category: "legal",
    pattern:
      /\b(criminal|convicted|convictions?|felony|felonies|misdemeanou?rs?|background check|drug (?:test|screen)|security clearance|clearance level|non-?compete|non-?disclosure|nda|terminated for cause|arrested|lawsuits?|litigation)\b/i,
  },
  {
    // Consent and agreement. Mirrors the checkbox guard in lib/apply/session.ts:
    // an affirmative acceptance is the human's to give, never the system's.
    category: "consent",
    pattern:
      /\b(i (?:have )?read|i agree|i consent|i accept|consent to|privacy (?:notice|policy|statement)|terms (?:and conditions|of service|of use)|gdpr|data protection)\b/i,
  },
];

/**
 * Which sensitive category a question falls into, if any.
 *
 * @param {string} text The question as the employer wrote it.
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
 * Whether this question must never be auto-answered.
 *
 * @param {string} text The question as the employer wrote it.
 * @returns {boolean}
 */
export function isSensitiveQuestion(text) {
  return sensitiveCategory(text) !== null;
}
