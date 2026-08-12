# Add job URL: paste a link, get an evaluation

Date: 2026-08-11
Status: approved, not yet implemented

## Problem

The web dashboard has no way to evaluate a single posting you already found. Every
path into the pipeline goes through discovery: run a scan, triage the inbox,
shortlist, score. If someone sends you a LinkedIn link, your only options are the
terminal (`/career-ops auto-pipeline <url>`) or hand-editing `data/pipeline.md`.

The engine for this already exists. `/api/run` with `kind: "evaluate"` runs the real
`modes/oferta.md` and persists the canonical artifacts (A-F report plus tracker row)
through the same scripts the CLI uses. What is missing is an entry point.

## Constraint that shapes the design: LinkedIn

LinkedIn is the common case for a pasted link, and it is the one that breaks.
`https://www.linkedin.com/jobs/view/<id>/` served to a headless agent is an authwall
or a JavaScript shell, not a job description. An evaluation run against that page
produces a thin or fabricated report, which is worse than a failure because it lands
in the tracker looking legitimate.

LinkedIn's public guest endpoint returns the real posting body with no auth:

```
https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>
```

Verified live on 2026-08-11 against job id 4434693435, which returned the actual
Assembled posting HTML.

So the design separates two URLs that are usually the same thing: the link the agent
*reads*, and the link we *record*.

## Components

### 1. `web/src/lib/job-url.mjs` (new)

Pure, dependency-free, one export:

```js
normalizeJobUrl(raw) -> { ok: true, url, fetchUrl, kind } | { ok: false, error }
```

- `url` is canonical, and is what the report header's `**URL:**` and the tracker row
  record. It is the link the user clicks later.
- `fetchUrl` is what the agent reads. Identical to `url` for everything except
  LinkedIn.
- `kind` is `"linkedin"` or `"generic"`, used by the UI for its inline note.

Behaviour:

- Trims; prepends `https://` to a bare host; rejects anything that is not http(s) or
  does not parse.
- Strips tracking parameters: `utm_*`, `trk`, `refId`, `trackingId`,
  `originalSubdomain`.
- LinkedIn: extracts the numeric job id from `/jobs/view/<id>`,
  `/jobs/view/<slug>-<id>`, and `?currentJobId=<id>` (the collections view). Emits
  `url = https://www.linkedin.com/jobs/view/<id>/` and the guest `fetchUrl`.

The id is matched as `^\d+$`, so no user-controlled text is ever spliced into a
hostname. There is no redirect or SSRF surface beyond the URL the user pasted.

Why a plain `.mjs` under `src/lib/` rather than a `.ts`: `test-all.mjs` auto-discovers
`web/tests/lib/*.test.mjs` and runs it inside the required suite. A `.mjs` module with
a sibling test is gated by CI with no registration step, and it matches the existing
convention (`cv-envelope.mjs`, `pdf-paths.mjs`, `run-prompts.mjs`).

### 2. `web/src/lib/run-prompts.mjs` (modified)

`buildPrompt` accepts an optional `fetchUrl`.

- Absent, or equal to `input`: the emitted prompt is byte-identical to today's. The
  existing `#2185` freeze assertions in `test-all.mjs` keep passing unchanged.
- Different from `input`: the evaluate prompt gains one instruction telling the agent
  to read `fetchUrl` (described as the public mirror of the same posting) while
  recording `url` as the canonical `**URL:**` in the report header and in the tracker
  row.

The posting content itself remains untrusted data under the existing AGENTS.md rule.
Nothing about this change grants the agent a new tool or a new write path.

### 3. `web/src/app/api/run/route.ts` (modified)

For `kind: "evaluate"`, run `normalizeJobUrl` on `input` before building the prompt.
A URL that fails normalization returns 400 with the reason rather than spawning a CLI
that burns tokens on unusable input. The server is authoritative; the dialog runs the
same module client-side only for instant feedback.

### 4. UI

#### Prior art found during planning

`web/src/components/quick-evaluate.tsx` already performs the core action: paste a URL,
`startJob({ kind: "evaluate" })`. It is not reachable in practice. It renders only on
the home page and only when `doctorState().phase === "in-between"`, meaning setup is
incomplete (`today-dashboard.tsx:113`). An established install never sees it. Its
validation is a bare `^https?://` test, with no LinkedIn handling.

So the UI work is: extract the shared behaviour, give it a real home on the Pipeline
page, and fix the gating that hides it. No parallel implementation.

#### `web/src/components/jobs/add-job-urls.ts` (new)

A hook holding the logic both surfaces need: parse pasted text into one or more URLs,
normalize each through `normalizeJobUrl`, report per-line errors, flag duplicates, and
expose `evaluateAll()` / `addAllToInbox()`. Neither surface owns this logic.

#### `web/src/components/pipeline/add-job-dialog.tsx` (new)

Trigger: an "Add job URL" button in the Pipeline header beside the search box, on
every tab. Also a secondary link inside the empty-inbox card, so a cold-start user has
a path that is not "run a scan".

Dialog:

- One textarea. Multiple URLs separated by newlines or spaces each become their own
  job.
- Per-URL validation as you type, via `normalizeJobUrl`. A LinkedIn URL shows a quiet
  note that the public version will be read.
- Duplicate warning, costing nothing: matched against inbox URLs (already in
  `PipelineView` props) and past `evaluate` jobs (already in the `useJobs` localStorage
  history). It warns; it does not block.
- Primary action **Evaluate now**: one `startJob({ kind: "evaluate", input, ... })` per
  URL. The existing job store streams progress, and the existing `co-job-done` event
  refreshes the tracker snapshot.
- Secondary action **Add to inbox** (free, no tokens): posts to `/api/explore/add`.
  Company is best-effort from the ATS slug in the URL, falling back to the host.

#### `web/src/components/quick-evaluate.tsx` (modified)

Refactored onto the same hook, so its single-URL pill gains LinkedIn normalization and
the shared validation. Separately, its render condition on the home page changes from
`inBetween` to always: an established user is precisely the person with a pipeline to
paste into, and the current gate makes the component dead code for them.

## Data flow

```
paste -> normalizeJobUrl (client, validation only)
      -> POST /api/run { kind: "evaluate", input: url }
      -> normalizeJobUrl (server, authoritative) -> { url, fetchUrl }
      -> buildPrompt({ kind: "evaluate", input: url, fetchUrl })
      -> agent reads fetchUrl, writes reports/{num}-{slug}-{date}.md
         and batch/tracker-additions/{num}-{slug}.tsv, runs merge-tracker.mjs
      -> stream "done" -> co-job-done -> Pipeline refetches
```

## Error handling

- Unparseable or non-http(s) input: inline error in the dialog, 400 from the route.
  No job is created.
- LinkedIn guest endpoint unreachable or empty: the agent reports it and the run fails
  through the route's existing honesty gate. A run that writes no report is already
  surfaced as an error rather than banked as a score, so this needs no new handling.
- Non-LinkedIn sites behind their own authwall (Indeed, Glassdoor): pass through
  unchanged and fail honestly. Out of scope.

## Testing

- `web/tests/lib/job-url.test.mjs` (new): LinkedIn `/jobs/view/<id>`, slug-plus-id, and
  `currentJobId` forms; tracking-parameter stripping; bare host; rejects for
  `javascript:`, `file:`, and unparseable text; non-LinkedIn passthrough leaves
  `fetchUrl === url`.
- `web/tests/lib/run-prompts.test.mjs` (extended): prompt is byte-identical when
  `fetchUrl` is absent or equal to `input`; when it differs, the prompt contains both
  URLs and the instruction to record the canonical one.

Both are picked up automatically by `test-all.mjs`.

## Out of scope

- Writing to `data/scan-history.tsv` when a pasted URL is evaluated.
- PDF generation, which already has its own trigger.
- Authwall workarounds for any site other than LinkedIn.
- Fetching a posting's title or company before evaluation to prettify the job card.
