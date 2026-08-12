import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, findReportFile } from "@/lib/career-ops";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { evaluateRunOutcome } from "@/lib/run-outcome.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { normalizeJobUrl } from "@/lib/job-url.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

/**
 * What a kind's prepare() hands back to the request when it succeeds.
 *
 * Every field is optional and only the kind that produces one sets it: evaluate
 * returns the normalized posting URL (plus the mirror to actually fetch from),
 * pdf returns its resolved paths, and the rest return neither. The optionality
 * is real rather than defaulted — this replaced `let evalUrl = input; let
 * fetchUrl: string | undefined;`, two mutable bindings whose value for three of
 * the four kinds was a silent fallback nobody read.
 */
type PrepareResult =
  | { ok: true; input?: string; fetchUrl?: string; pdfPaths?: PdfPaths }
  | { ok: false; error: string };

/** What the prepare steps need from the request, injected so they stay small. */
type PrepareContext = { root: string; today: string };

/**
 * Everything /api/run needs to know about a worker kind, in one row per kind.
 *
 * This table is the whole of the route's kind-awareness. It grew out of what
 * used to be nine scattered `kind === "..."` conditionals, three of which spelled
 * the same `evaluate || pdf` pair for three unrelated reasons — a shape where the
 * only way to answer "what does pdf actually do differently?" was to read the
 * whole file. `kind` itself still reaches buildPrompt and claudeCliArgs verbatim;
 * the tool scope is theirs to decide, never this table's (#2185).
 */
type KindSpec = {
  /** Core file this kind actually runs — absent from a data-only CAREER_OPS_ROOT. */
  script?: string;
  /** Needs cv.md: an A-F score or a tailored CV is meaningless without one. */
  needsCv?: boolean;
  /** Mutates the tracker, so it holds a write token for the whole run. */
  holdsTrackerWrite?: boolean;
  /** Writes a report file, so the route can verify one actually landed. */
  persistsReport?: boolean;
  /** Agent emits its CV inline in a `<<cv-html>>` envelope the backend renders (#2185). */
  emitsCvEnvelope?: boolean;
  /** Agent-child budget before SIGTERM. Each row states its own reason. */
  killMs: number;
  /** Per-kind input validation/normalization; a failure becomes the route's 400. */
  prepare?: (input: string, ctx: PrepareContext) => PrepareResult;
};

/**
 * "evaluate" is the only kind whose input is a posting URL — pdf takes a report
 * number and fix-portal a company name, so neither is normalized. LinkedIn's
 * /jobs/view page is an authwall for a headless agent, so the agent reads a
 * public mirror while the report and tracker record the canonical link.
 */
function prepareEvaluate(input: string): PrepareResult {
  const normalized = normalizeJobUrl(input);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return { ok: true, input: normalized.url, fetchUrl: normalized.fetchUrl };
}

/**
 * Precompute deterministic scratch + final paths so the agent never chooses its
 * own filenames — the backend owns naming, writing (#2185) and rendering (#2172).
 * Nothing is cleared first: writeCvHtml rewrites the HTML from this run's freshly
 * parsed envelope before any render, and the agent is no longer told these paths,
 * so a stale file cannot survive into a render.
 */
function preparePdf(input: string, ctx: PrepareContext): PrepareResult {
  const pathsResult = resolvePdfPaths(input, ctx.today, ctx.root, findReportFile);
  if (!pathsResult.ok) return { ok: false, error: pathsResult.error };
  return { ok: true, pdfPaths: pathsResult.paths };
}

/**
 * fix-portal's prompt puts the company name straight into a shell command the
 * agent runs, and a company name can arrive from a public ATS listing rather than
 * the user's own typing. Refuse rather than sanitize: a silently rewritten name
 * would repair the wrong portal.
 */
function prepareFixPortal(input: string): PrepareResult {
  if (isShellSafeCompanyName(input)) return { ok: true };
  return {
    ok: false,
    error: "That company name has characters I can't safely pass to the portal checker. Rename it in portals.yml first.",
  };
}

const KINDS: Record<string, KindSpec> = {
  // killMs 600s: no post-agent phase at all (merge-tracker.mjs runs inside the
  // agent's own turn), so the whole budget goes to the agent — a real evaluation
  // doing web research routinely runs past 4m45s, and a shorter timer was killing
  // it before it could finish (and misreporting the result, see the close handler).
  evaluate: { script: "modes/oferta.md", needsCv: true, holdsTrackerWrite: true, persistsReport: true, killMs: 600_000, prepare: prepareEvaluate },
  // killMs 600s: the agent only tailors content now (rendering moved to the
  // backend, #2172), and the render+mark phase starts only AFTER this timer's
  // window with no timeout of its own — 600s here leaves ~200s of the route's
  // 800s maxDuration for it, ample for a Chromium render even with a cold
  // Playwright launch. Same number as evaluate, different reason.
  pdf: { script: "generate-pdf.mjs", needsCv: true, holdsTrackerWrite: true, emitsCvEnvelope: true, killMs: 600_000, prepare: preparePdf },
  // killMs 285s: an ATS slug probe plus a one-line YAML edit — nothing long-running.
  "fix-portal": { script: "verify-portals.mjs", killMs: 285_000, prepare: prepareFixPortal },
  // killMs 285s: read-only reporting, with no persistence phase to protect.
  research: { killMs: 285_000 },
};

/**
 * A kind none of the tables know about.
 *
 * buildPrompt deliberately falls through to the evaluate prompt for an unknown
 * kind and toolScopeFor hands it the read-only scope, so the route tolerates one
 * rather than rejecting it. This row keeps that tolerance and gives it the
 * conservative profile it already had: no script requirement, no CV gate, no
 * prepare step, no write token, no report check, and the short timer.
 */
const UNKNOWN_KIND: KindSpec = { killMs: 285_000 };

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // hasOwn, not `KINDS[kind] ?? UNKNOWN_KIND`: `kind` is client-supplied, and a
  // plain object literal answers `KINDS["constructor"]` with a function rather
  // than undefined — which would slip past `??` and read every flag off it.
  const k = Object.hasOwn(KINDS, kind) ? KINDS[kind] : UNKNOWN_KIND;
  /** Every per-kind gate below rejects the same way; only the reason differs. */
  const reject = (error: string) =>
    new Response(JSON.stringify({ error }), { status: 400, headers: { "Content-Type": "application/json" } });

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  if (k.script && !fs.existsSync(path.join(careerOpsRoot(), k.script))) {
    return reject(`This needs a complete career-ops checkout (${k.script}). CAREER_OPS_ROOT has data only — point it at a full checkout.`);
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if (k.needsCv && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return reject("Add your CV first so I can score this against you. Drop it on the home page.");
  }

  const today = new Date().toISOString().slice(0, 10);

  // The one per-kind input gate: shell-safety for fix-portal, path resolution for
  // pdf, URL normalization for evaluate, nothing for research. See each prepare
  // function above for why its kind needs what it needs.
  const prepared: PrepareResult = k.prepare ? k.prepare(input, { root: careerOpsRoot(), today }) : { ok: true };
  if (!prepared.ok) return reject(prepared.error);
  const { pdfPaths, fetchUrl } = prepared;

  // prepare() only returns an input when it rewrote one (evaluate); every other
  // kind sends what the client typed, untouched.
  const prompt = buildPrompt({ kind, input: prepared.input ?? input, memory: readMemory(), today, fetchUrl });

  const isClaude = cliId === "claude";
  // Which tools each kind gets, and the whole claude argv, live in
  // claude-invocation.mjs — see its header for the policy and for why it is asserted on
  // built values rather than on this file's source. NEVER auto-submits; that
  // remains a prompt-level guarantee.
  // Non-Claude CLIs get no tool flags from spec.args() at all, so their agents
  // stay unrestricted here. That gap is route-wide (it applies to 'evaluate' too),
  // not specific to pdf, and each CLI needs its own mechanism researched — tracked
  // as #2507 rather than half-fixed here. On those CLIs the backend is the only
  // INTENDED writer — the agent is not asked to write — but that is mitigation, not
  // enforcement: the capability is still there for an injected posting to reach.
  const args = isClaude ? claudeCliArgs({ kind, prompt }) : spec.args(prompt);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = k.persistsReport === true;
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = k.holdsTrackerWrite ? acquireTrackerWrite() : null;

  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  // Decode once on the stream, not per chunk. Buffer#toString() decodes each chunk
  // independently, so a chunk boundary falling inside a multi-byte UTF-8 sequence
  // yields a replacement character and mis-decodes the bytes after it. Those bytes
  // are the CV now (#2185) — the agent's HTML flows through cvFilter to
  // writeCvHtml and on to the renderer — and no structural check would catch it,
  // because the envelope markers and </html> are ASCII and still match. Setting
  // the encoding makes Node hold partial sequences across chunks.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const enc = new TextEncoder();

  // `closed` + kill timer in the OUTER scope so cancel() (client disconnect) can
  // flip `closed` before the child's late handlers run, and send() is try/catch'd —
  // otherwise a late enqueue onto a closed controller throws uncaught (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  // pdf-kind's render+mark work (renderPdf, below) keeps running detached even
  // after the agent child closes — and even after a client disconnect fires
  // cancel(). Track its promise so cancel() can defer releasing writeToken
  // until that work actually settles, instead of releasing the tracker-delete
  // guard while mark-pdf-ready.mjs is still actively writing applications.md.
  let pdfRenderPromise: Promise<void> | null = null;
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (writeToken !== null && !writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let stderrBuf = "";
      // Widened over time: auth/login/quota failures are the most common real error
      // and a narrow regex missed them (silent false "success").
      const STDERR_FAILURE = /error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|not authenticated/i;
      const flagStderrLine = (line: string) => {
        if (!line.trim() || !STDERR_FAILURE.test(line)) return;
        sawError = true;
        send({ type: "error", msg: line.trim().slice(0, 200) });
      };
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      // Per-kind, with the reason stated on its own row in KINDS above.
      killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, k.killMs);
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();
          try { controller.close(); } catch { /* */ }
        }
      };
      // pdf's CV arrives inline in a <<cv-html>> envelope instead of being written
      // by the agent (#2185). The filter keeps every byte for the backend while
      // holding the 15-25 KB body out of the run log, which is the agent's
      // narration — see cv-envelope.mjs.
      const cvFilter = k.emitsCvEnvelope ? createCvEnvelopeFilter() : null;
      const sendAgentText = (text: string) => {
        const visible = cvFilter ? cvFilter.push(text) : text;
        if (visible) send({ type: "text", text: visible });
      };
      /** Surface non-fatal issues in the run log rather than only a server log. */
      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };
      /** Persist the emitted CV; streams the reason and returns false on failure. */
      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
        if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
        return written.ok;
      };

      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        if (!isClaude) {
          emittedText = true;
          // MERGE HAZARD (#2102): once that PR parses non-Claude stdout as JSONL,
          // this must move onto the PARSED text or the envelope silently stops
          // being filtered and collected for codex. git reports no conflict.
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
                send({ type: "tool", name: e.content_block.name });
              } else if (e?.type === "content_block_delta" && e.delta?.text) {
                emittedText = true;
                sendAgentText(e.delta.text);
              }
            } else if (ev.type === "system" && ev.subtype === "init") {
              send({ type: "status", label: "Agent ready" });
            } else if (ev.type === "result") {
              // Capture the per-run cost; the authoritative "done" is sent on close
              // (so the honesty gate decides done-vs-error first). Tokens = the same
              // formula /api/usage uses: input + output + cache-creation.
              const u = ev.usage || {};
              lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // Match on COMPLETE lines. A chunk boundary can fall mid-word, so testing a
        // raw chunk both misses an error split across two of them and can match a
        // fragment that is not the word it looks like. sawError feeds pdfRunOutcome,
        // where a false positive fails a run whose PDF rendered fine, so the
        // boundary has to be settled before the regex sees it.
        stderrBuf += chunk;
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          flagStderrLine(line);
        }
      });
      // Render + mark-tracker-ready live in pdf-render.mjs (plain, dependency-
      // injected, unit-tested) so the render-then-mark orchestration isn't
      // buried untested inside this transport-layer closure. Runs generate-
      // pdf.mjs and mark-pdf-ready.mjs as plain Node child processes — no agent
      // CLI or its sandbox involved — so a browser launch never depends on an
      // interactive approval nobody is present to grant in a headless/web-
      // triggered run (#2172). The tracker is marked ✅ only after a CONFIRMED
      // successful render, not optimistically — same honesty-gate discipline as
      // the evaluate path below.
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        send({ type: "status", label: "Rendering PDF…" });
        // renderAndMarkPdf is designed to resolve, never throw — but this is
        // the one place nothing else awaits or catches this promise (cancel()
        // only attaches a .finally for the write-token release), so an
        // unexpected exception here must still close the stream instead of
        // leaving it — and the write-token — open until process shutdown.
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            pdfPaths: paths,
            format,
            reportNum: input,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          // Non-fatal issues (a defaulted page format, a tracker row not marked) still
          // surface here rather than only in a server log nobody sees.
          sendWarnings(result.warnings);
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // A client disconnect can fire cancel() (which kills `child`) before
        // this event finally arrives — killing a process doesn't make its
        // 'close' event disappear, just delays it. Without this guard a pdf
        // run could still start a brand-new render (and re-touch the tracker)
        // after the stream — and its writeToken guard — is already gone.
        if (closed) return;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputError = (): string | null => {
          if (!emittedText && !sawError && !cleanExit) return "The CLI exited with an error. Is it installed and authenticated?";
          if (!emittedText && !sawError) return "The CLI produced no output. Is it installed and authenticated? (career-ops is best on Claude Code.)";
          return null;
        };

        if (k.emitsCvEnvelope) {
          // Release any text the filter was still holding, so the log keeps the
          // agent's closing narration and its VERDICT line.
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          // The artifact check moved from the filesystem to the stream (#2185):
          // whether pdfPaths.html exists says nothing now that the backend is its
          // only writer. pdfRunOutcome owns the decision and the message.
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (!pdfPaths || envelope?.ok !== true) {
            // Unreachable: pdfRunOutcome validated both via hasPaths/envelope.ok.
            // Kept for narrowing, but it must REPORT rather than fall through to a
            // bare close() — a stream that ends with neither error nor done is the
            // one outcome this handler exists to prevent.
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save. Please report this." });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              // Tracked so cancel() can defer releasing writeToken until this
              // settles; close() happens once rendering finishes, not here.
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
              return;
            }
            // saveCv already streamed the specific reason.
          }
          return close();
        }

        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score. The
        // five arms and the reason for each live in run-outcome.mjs, unit-tested
        // beside pdfRunOutcome's suite rather than buried in this transport closure.
        const outcome = evaluateRunOutcome({
          noOutputMessage: noOutputError(),
          persists,
          wroteReport: countReports() > reportsBefore,
          cleanExit,
          sawError,
        });
        if (!outcome.ok) {
          send({ type: "error", msg: outcome.message });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (pdfRenderPromise) {
        // Render/mark keeps running after this client disconnects — wait for
        // it to settle before releasing the guard, so a concurrent tracker
        // delete can't race mark-pdf-ready.mjs's still-in-flight write.
        pdfRenderPromise.finally(releaseWriteTokenOnce);
      } else {
        releaseWriteTokenOnce();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
