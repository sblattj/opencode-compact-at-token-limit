import assert from "node:assert/strict"
import test from "node:test"

import plugin, {
  ContextCapPlugin,
  DEFAULT_LIMIT,
  ENV_VAR,
  contextTokens,
  parseLimit,
  resolveLimit,
} from "../src/index.js"

const MODEL = { providerID: "test", modelID: "test-model" }

// A fake v1 plugin client: records summarize calls and log lines.
function fakeClient({ hostContextLimit = 0, summarize } = {}) {
  const calls = { summarize: [], logs: [] }
  const client = {
    session: {
      summarize(args) {
        calls.summarize.push(args)
        return summarize ? summarize(args) : new Promise(() => {})
      },
    },
    config: {
      providers: async () => ({
        data: {
          providers: [
            { id: MODEL.providerID, models: { [MODEL.modelID]: { limit: { context: hostContextLimit } } } },
          ],
        },
      }),
    },
    app: {
      log: async ({ body }) => {
        calls.logs.push(body)
        return {}
      },
    },
  }
  return { client, calls }
}

let nextID = 0
function step(sessionID, tokens, extra = {}) {
  nextID += 1
  return {
    type: "message.updated",
    properties: {
      info: {
        id: `msg_${String(nextID).padStart(6, "0")}`,
        sessionID,
        role: "assistant",
        finish: "tool-calls",
        ...MODEL,
        tokens,
        ...extra,
      },
    },
  }
}
const tokensOf = (input) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const compacted = (sessionID) => ({ type: "session.compacted", properties: { sessionID } })
const idle = (sessionID) => ({ type: "session.idle", properties: { sessionID } })

async function boot(options = {}, clientOptions = {}, env = {}) {
  const { client, calls } = fakeClient(clientOptions)
  const hooks = await ContextCapPlugin({ client, directory: "/tmp" }, { ...options, env })
  return { hooks, calls }
}

// ---------------------------------------------------------------- config

test("default limit is 200000", () => {
  assert.equal(DEFAULT_LIMIT, 200000)
  assert.deepEqual(resolveLimit({}, {}), { limit: 200000, source: "default" })
})

test("parseLimit accepts integers, numeric strings and k/m suffixes; 0 means off", () => {
  assert.equal(parseLimit(150000), 150000)
  assert.equal(parseLimit("150000"), 150000)
  assert.equal(parseLimit("150k"), 150000)
  assert.equal(parseLimit("1.5m"), 1500000)
  assert.equal(parseLimit(" 64K "), 64000)
  assert.equal(parseLimit(0), 0)
  assert.equal(parseLimit("0"), 0)
})

test("parseLimit rejects junk", () => {
  for (const bad of [-1, 1.5, NaN, Infinity, "", "abc", "12x", "-5k", null, undefined, {}, [], true]) {
    assert.equal(parseLimit(bad), undefined, `should reject ${JSON.stringify(bad)}`)
  }
})

test("precedence: plugin option > env var > default", () => {
  assert.deepEqual(resolveLimit({ limit: 50000 }, { [ENV_VAR]: "90k" }), { limit: 50000, source: "option" })
  assert.deepEqual(resolveLimit({}, { [ENV_VAR]: "90k" }), { limit: 90000, source: "env" })
  assert.deepEqual(resolveLimit({ limit: 0 }, { [ENV_VAR]: "90k" }), { limit: 0, source: "option" })
})

test("invalid option or env falls back to the next source, never to off", () => {
  assert.deepEqual(resolveLimit({ limit: "lots" }, { [ENV_VAR]: "90k" }), { limit: 90000, source: "env" })
  assert.deepEqual(resolveLimit({ limit: -3 }, { [ENV_VAR]: "nope" }), { limit: 200000, source: "default" })
})

test("the env var is OPENCODE_COMPACT_AT_TOKENS", () => {
  assert.equal(ENV_VAR, "OPENCODE_COMPACT_AT_TOKENS")
})

// ---------------------------------------------------------------- tokens

test("contextTokens prefers total, else sums input+output+reasoning+cache", () => {
  assert.equal(contextTokens({ tokens: { total: 1234, input: 1 } }), 1234)
  assert.equal(
    contextTokens({ tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 1000, write: 7 } } }),
    1130,
  )
  assert.equal(contextTokens({}), 0)
  assert.equal(contextTokens({ tokens: { input: -5 } }), 0)
})

// ---------------------------------------------------------------- module shape

test("default export is the v1 server entry and the same reference as the named export", () => {
  assert.equal(plugin.id, "opencode-compact-at-token-limit")
  assert.equal(plugin.server, ContextCapPlugin)
})

test("init logs the resolved limit and its source", async () => {
  const { calls } = await boot({ limit: 1000 })
  assert.ok(
    calls.logs.some((l) => l.level === "info" && /limit 1,?000 tokens \(option\)/.test(l.message)),
    JSON.stringify(calls.logs),
  )
})

// ---------------------------------------------------------------- forcing

test("below the limit: no summarize", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(999)) })
  assert.equal(calls.summarize.length, 0)
})

test("at the limit: summarize once with the step's provider and model, v1 shape", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  assert.equal(calls.summarize.length, 1)
  assert.deepEqual(calls.summarize[0], {
    path: { id: "ses_a" },
    body: { providerID: MODEL.providerID, modelID: MODEL.modelID },
  })
})

test("works in every session, no goal or command needed", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(5000)) })
  await hooks.event({ event: step("ses_b", tokensOf(5000)) })
  assert.deepEqual(
    calls.summarize.map((c) => c.path.id),
    ["ses_a", "ses_b"],
  )
})

test("limit 0 turns it off", async () => {
  const { hooks, calls } = await boot({ limit: 0 })
  await hooks.event({ event: step("ses_a", tokensOf(10_000_000)) })
  await hooks.event({ event: idle("ses_a") })
  assert.equal(calls.summarize.length, 0)
})

test("env var sets the limit when no option is given", async () => {
  const { hooks, calls } = await boot({}, {}, { [ENV_VAR]: "2k" })
  await hooks.event({ event: step("ses_a", tokensOf(1999)) })
  assert.equal(calls.summarize.length, 0)
  await hooks.event({ event: step("ses_a", tokensOf(2000)) })
  assert.equal(calls.summarize.length, 1)
})

test("summarize is not awaited: event returns while the host call is still pending", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  const result = await Promise.race([
    hooks.event({ event: step("ses_a", tokensOf(1000)) }).then(() => "returned"),
    new Promise((r) => setTimeout(() => r("hung"), 500)),
  ])
  assert.equal(result, "returned")
  assert.equal(calls.summarize.length, 1)
})

test("one pending request per session: further steps over the limit do not resend", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  await hooks.event({ event: step("ses_a", tokensOf(1100)) })
  assert.equal(calls.summarize.length, 1)
})

test("the same finished step delivered twice is judged once", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  const ev = step("ses_a", tokensOf(1000))
  await hooks.event({ event: ev })
  await hooks.event({ event: compacted("ses_a") })
  await hooks.event({ event: ev })
  assert.equal(calls.summarize.length, 1)
})

test("ignores unfinished steps, user messages, summaries and zero-usage steps", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(5000), { finish: undefined }) })
  await hooks.event({ event: step("ses_a", tokensOf(5000), { role: "user" }) })
  await hooks.event({ event: step("ses_a", tokensOf(5000), { summary: true }) })
  await hooks.event({ event: step("ses_a", tokensOf(5000), { mode: "compaction" }) })
  await hooks.event({ event: step("ses_a", tokensOf(5000), { agent: "compaction" }) })
  await hooks.event({ event: step("ses_a", tokensOf(0)) })
  assert.equal(calls.summarize.length, 0)
})

test("session.compacted clears the pending request and the next crossing forces again", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  await hooks.event({ event: compacted("ses_a") })
  await hooks.event({ event: step("ses_a", tokensOf(300)) })
  await hooks.event({ event: step("ses_a", tokensOf(1200)) })
  assert.equal(calls.summarize.length, 2)
})

test("a request with no compaction after 3 steps counts as failed and is retried", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) }) // request 1
  await hooks.event({ event: step("ses_a", tokensOf(1010)) }) // pending step 1
  await hooks.event({ event: step("ses_a", tokensOf(1020)) }) // pending step 2
  assert.equal(calls.summarize.length, 1)
  await hooks.event({ event: step("ses_a", tokensOf(1030)) }) // step 3: failure, request 2
  assert.equal(calls.summarize.length, 2)
})

test("after 3 failed requests forcing stops until the next session.compacted", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  for (let i = 0; i < 20; i += 1) await hooks.event({ event: step("ses_a", tokensOf(1000 + i)) })
  assert.equal(calls.summarize.length, 3)
  assert.ok(calls.logs.some((l) => l.level === "warn" && /failed 3 times/.test(l.message)))
  await hooks.event({ event: compacted("ses_a") })
  await hooks.event({ event: step("ses_a", tokensOf(1500)) })
  assert.equal(calls.summarize.length, 4)
})

test("a rejected or { error } summarize counts as a failure right away", async () => {
  const { hooks, calls } = await boot({ limit: 1000 }, { summarize: async () => ({ error: { name: "BadRequest" } }) })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  await new Promise((r) => setTimeout(r, 10))
  await hooks.event({ event: step("ses_a", tokensOf(1001)) })
  assert.equal(calls.summarize.length, 2)
  const rejecting = await boot({ limit: 1000 }, { summarize: async () => Promise.reject(new Error("boom")) })
  await rejecting.hooks.event({ event: step("ses_a", tokensOf(1000)) })
  await new Promise((r) => setTimeout(r, 10))
  await rejecting.hooks.event({ event: step("ses_a", tokensOf(1001)) })
  assert.equal(rejecting.calls.summarize.length, 2)
})

test("a summarize that throws synchronously never breaks the event hook", async () => {
  const { hooks, calls } = await boot(
    { limit: 1000 },
    {
      summarize: () => {
        throw new Error("sync boom")
      },
    },
  )
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  assert.equal(calls.summarize.length, 1)
})

test("compaction that does not lower the context holds forcing after 2 strikes", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) }) // request 1
  await hooks.event({ event: compacted("ses_a") })
  await hooks.event({ event: step("ses_a", tokensOf(1500)) }) // strike 1, request 2
  await hooks.event({ event: compacted("ses_a") })
  await hooks.event({ event: step("ses_a", tokensOf(1500)) }) // strike 2: held
  await hooks.event({ event: step("ses_a", tokensOf(1600)) })
  assert.equal(calls.summarize.length, 2)
  assert.ok(calls.logs.some((l) => l.level === "warn" && /not lowering the context/.test(l.message)))
  // A step back under the limit releases the hold.
  await hooks.event({ event: step("ses_a", tokensOf(500)) })
  await hooks.event({ event: step("ses_a", tokensOf(1700)) })
  assert.equal(calls.summarize.length, 3)
})

test("host grace: when the host's own overflow check is alive, the crossing step is left to the host", async () => {
  const { hooks, calls } = await boot({ limit: 1000 }, { hostContextLimit: 128000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  assert.equal(calls.summarize.length, 0, "first crossing step goes to the host")
  await hooks.event({ event: step("ses_a", tokensOf(1100)) })
  assert.equal(calls.summarize.length, 1, "host passed, so the plugin forces")
})

test("idle backstop: a turn that ended over the limit with no request sent forces at idle", async () => {
  const { hooks, calls } = await boot({ limit: 1000 }, { hostContextLimit: 128000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) }) // grace step, no request
  await hooks.event({ event: idle("ses_a") })
  assert.equal(calls.summarize.length, 1)
})

test("idle below the limit does nothing", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(10)) })
  await hooks.event({ event: idle("ses_a") })
  assert.equal(calls.summarize.length, 0)
})

test("logs the measured context per step (the live-run observable)", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(400)) })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  const lines = calls.logs.map((l) => l.message)
  assert.ok(lines.some((m) => /ses_a step context 400 \/ limit 1,?000/.test(m)), lines.join("\n"))
  assert.ok(lines.some((m) => /ses_a forcing compaction at 1,?000 tokens \(limit 1,?000\)/.test(m)), lines.join("\n"))
})

test("session.deleted forgets the session", async () => {
  const { hooks, calls } = await boot({ limit: 1000 })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_a" } } } })
  await hooks.event({ event: step("ses_a", tokensOf(1000)) })
  assert.equal(calls.summarize.length, 2)
})

test("malformed events never throw", async () => {
  const { hooks } = await boot({ limit: 1000 })
  for (const event of [undefined, null, {}, { type: "message.updated" }, { type: "message.updated", properties: {} }, { type: "session.compacted" }]) {
    await hooks.event({ event })
  }
  await hooks.event(undefined)
})
