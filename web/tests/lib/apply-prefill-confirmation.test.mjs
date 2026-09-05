import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolveLateSession } from "../../src/lib/apply/exit.mjs";
import { isSensitiveQuestion } from "../../src/lib/apply/sensitive-questions.mjs";

// Run the real provider callbacks with deterministic hooks and transport. The
// renderer-only JSX is omitted; no application form or browser is contacted.
const source = readFileSync(new URL("../../src/components/apply/apply-provider.tsx", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "")
  .replace(/export /g, "")
  .replace("return <Ctx.Provider value={value}>{children}</Ctx.Provider>;", "return value;");
const createProvider = new Function(
  "hooks", "fetch", "localStorage", "resolveLateSession", "isSensitiveQuestion",
  `const {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState}=hooks;\n${stripTypeScriptTypes(source)}\nreturn ApplyProvider;`,
);

function harness(prefillResponse, failedField = null) {
  let cursor = 0;
  const slots = [];
  const requests = [];
  const hooks = {
    createContext: () => ({}),
    useContext: () => null,
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
  };
  const fields = [{ id: "salary", label: "Expected salary", type: "text" }, { id: "why", label: "Why this role?", type: "text" }];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith("/session")) return Response.json({ id: "session-1", title: "Application", fields });
    if (url.endsWith("/prefill")) return prefillResponse();
    if (url.endsWith("/fill")) return Response.json({ steps: failedField ? [{ fieldId: failedField, ok: false }] : [] });
    if (url.endsWith("/drive")) return new Response('{"t":"done","filled":false}\n');
    throw new Error(`unexpected request: ${url}`);
  };
  const Provider = createProvider(hooks, fetch, { getItem: () => '{"cliId":"fixture"}' }, resolveLateSession, isSensitiveQuestion);
  const render = () => { cursor = 0; return Provider({ children: null }); };
  return { render, requests };
}

for (const [name, response] of [
  ["planner error", () => new Response('{"t":"error","m":"planner failed"}\n')],
  ["missing stream", () => ({ body: null })],
  ["network failure", () => { throw new Error("offline"); }],
  ["empty stream", () => new Response("")],
]) {
  test(`human salary confirmation survives prefill ${name}`, async () => {
    const h = harness(response);
    await h.render().open("https://example.test/apply");
    h.render().setHumanAnswer("salary", "120000");
    await h.render().prefill();
    assert.equal(h.render().answers.salary, "120000");
    await h.render().fill();
    const sent = h.requests.find((request) => request.url.endsWith("/fill")).body;
    assert.equal(sent.answers.salary, "120000");
    assert.deepEqual(sent.confirmedSensitiveFieldIds, ["salary"]);
  });
}

test("successful planner replacement revokes the previous human confirmation", async () => {
  const h = harness(() => new Response('{"t":"done","count":1,"answers":{"salary":{"value":"","needs_confirmation":true}}}\n'));
  await h.render().open("https://example.test/apply");
  h.render().setHumanAnswer("salary", "120000");
  await h.render().prefill();
  await h.render().fill();
  const sent = h.requests.find((request) => request.url.endsWith("/fill")).body;
  assert.deepEqual(sent.confirmedSensitiveFieldIds, []);
  assert.equal(sent.answers.salary, "");
});

test("a failed sensitive locator asks for manual completion without agent escalation", async () => {
  const h = harness(() => new Response(""), "salary");
  await h.render().open("https://example.test/apply");
  h.render().setHumanAnswer("salary", "120000");
  await h.render().fill();
  assert.equal(h.requests.filter((request) => request.url.endsWith("/drive")).length, 0);
  assert.ok(h.render().issues.some((issue) => issue.code === "sensitive-manual-fill"));
});

test("an ordinary failed locator still escalates without sharing the personal answer", async () => {
  const h = harness(() => new Response(""), "why");
  await h.render().open("https://example.test/apply");
  h.render().setHumanAnswer("salary", "120000");
  h.render().setHumanAnswer("why", "Relevant experience");
  await h.render().fill();
  const sent = h.requests.find((request) => request.url.endsWith("/drive")).body;
  assert.deepEqual(sent.answers, [{ fieldId: "why", value: "Relevant experience" }]);
});
