// Real-host A/B smoke for opencode-compact-at-token-limit.
//
// The real `~/.opencode/bin/opencode` (1.19.0), the production plugin loader, the
// real POST /session/:id/summarize, the host's compaction loop and real SQLite
// rows. Nothing is faked except the model: a mock OpenAI-compatible endpoint on
// localhost, so no real model is called and no tokens are spent.
//
// Both arms run the SAME scripted conversation against the SAME kind of fresh
// isolated tree. They differ only in the plugin option `limit`:
//   CAP      limit 3000      a mid-conversation step crosses it: the plugin forces
//                            a compaction and the host really compacts
//   CONTROL  limit 10000000  above all usage: plugin loaded, logging steps, silent
//
// The mock model has `limit.context: 0`, so the host's own overflow check is off
// and any summary row is the plugin's. OPENCODE_DISABLE_AUTOCOMPACT is NOT set
// (left in, it would switch the host check off for every reason, not just this one).
//
// Zero npm dependencies. Usage: node scripts/smoke-live-compaction.mjs
import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PLUGIN_SPEC = path.join(repoRoot, "src", "index.js")
const OPENCODE_BIN = path.join(homedir(), ".opencode", "bin", "opencode")
const EXPECTED_HOST_VERSION = "1.19.0"
const PLUGIN_SERVICE = "opencode-compact-at-token-limit"
const SCRATCH = "/tmp/cap-smoke"

const PROVIDER_ID = "test"
const MODEL_ID = "test-model"

const CAP_LIMIT = 3000
const CONTROL_LIMIT = 10_000_000
// Prompt tokens the mock reports per scripted work step. The first two are under
// CAP_LIMIT, the third crosses it, the rest stay over. Completion adds 10 each.
const STEP_USAGE = [500, 1500, 4000, 4200, 4400, 4600]
const COMPLETION_TOKENS = 10
const FINAL_USAGE = 4800
const AFTER_COMPACTION_USAGE = 300
const SUMMARY_USAGE = 4900
const MODEL_LATENCY_MS = 700
const PROMPT_TIMEOUT_MS = 120_000
const SUMMARY_WAIT_MS = 120_000
const QUIET_WAIT_MS = 8_000
const LOG_FLUSH_WAIT_MS = 15_000
const WHOLE_RUN_LIMIT_MS = 12 * 60_000
const SUMMARIZER_TEXT = "context summarization agent" // the compaction agent's system prompt
const TITLE_TEXT = "title generator"

mkdirSync(SCRATCH, { recursive: true })
const logFile = path.join(SCRATCH, "run.log")
writeFileSync(logFile, "")
console.log(`LOG FILE ${logFile}`)
const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Own-PID bookkeeping: only these children are ever signalled
// ---------------------------------------------------------------------------
const liveChildren = new Set()
process.on("exit", () => {
  for (const child of liveChildren) child.kill("SIGKILL")
})
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130))
setTimeout(() => {
  console.log(`SMOKE FAIL (whole run exceeded ${WHOLE_RUN_LIMIT_MS} ms)`)
  process.exit(2)
}, WHOLE_RUN_LIMIT_MS).unref()

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
const results = []
function verdict(label, ok, detail) {
  results.push({ label, ok })
  const line = `${label}: ${ok ? "PASS" : "FAIL"} (${detail})`
  console.log(line)
  log(line)
}

// ---------------------------------------------------------------------------
// Mock provider (OpenAI-compatible SSE). Prompt tokens ride in `usage`, so the
// host records a growing context per step.
// ---------------------------------------------------------------------------
const sse = (value) => (value === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(value)}\n\n`)
const chunk = ({ delta = {}, finish, usage }) => ({
  id: "chatcmpl-smoke",
  object: "chat.completion.chunk",
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  ...(usage ? { usage } : {}),
})
const usageBlock = (promptTokens) => ({
  prompt_tokens: promptTokens,
  completion_tokens: COMPLETION_TOKENS,
  total_tokens: promptTokens + COMPLETION_TOKENS,
})
const toolTurn = (callID, name, args, promptTokens) => [
  chunk({ delta: { role: "assistant" } }),
  chunk({ delta: { tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }] } }),
  chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }),
  chunk({ finish: "tool_calls", usage: usageBlock(promptTokens) }),
  "[DONE]",
]
const textTurn = (text, promptTokens) => [
  chunk({ delta: { role: "assistant" } }),
  chunk({ delta: { content: text } }),
  chunk({ finish: "stop", usage: usageBlock(promptTokens) }),
  "[DONE]",
]
function conversationText(messages) {
  const parts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content
    if (typeof content === "string") parts.push(content)
    else if (Array.isArray(content)) for (const part of content) if (typeof part?.text === "string") parts.push(part.text)
  }
  return parts.join("\n")
}

/**
 * The scripted conversation, identical for both arms. State-driven: scripted work
 * steps are keyed on the call ids that already have a tool result, so a retry never
 * replays a step. Tool-less requests are the host's own title and compaction calls.
 */
function makeScript() {
  const state = { work: [], compactionHits: 0, titles: 0, postCompaction: 0 }
  const respond = (body) => {
    const tools = Array.isArray(body?.tools) ? body.tools : []
    const text = conversationText(body?.messages)
    if (tools.length === 0) {
      if (text.includes(SUMMARIZER_TEXT)) {
        state.compactionHits += 1
        return textTurn("SMOKE-SUMMARY: the earlier steps ran.", SUMMARY_USAGE)
      }
      if (text.includes(TITLE_TEXT)) {
        state.titles += 1
        return textTurn("Smoke title", 100)
      }
      return textTurn("ok", 100)
    }
    // A work request. Once a summary landed in the history the context is small.
    if (text.includes("SMOKE-SUMMARY")) {
      state.postCompaction += 1
      return textTurn("Done after compaction.", AFTER_COMPACTION_USAGE)
    }
    const done = new Set(
      (Array.isArray(body?.messages) ? body.messages : []).filter((m) => m?.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id),
    )
    for (let index = 0; index < STEP_USAGE.length; index++) {
      const callID = `call_s${index + 1}`
      if (done.has(callID)) continue
      state.work.push(STEP_USAGE[index])
      return toolTurn(callID, "bash", { command: `echo step-${index + 1}`, description: "smoke step" }, STEP_USAGE[index])
    }
    state.work.push(FINAL_USAGE)
    return textTurn("Scripted steps done.", FINAL_USAGE)
  }
  return { state, respond }
}

async function startMock(respond) {
  const server = createServer((req, res) => {
    const parts = []
    req.on("data", (part) => parts.push(part))
    req.on("end", () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")
      } catch {
        body = {}
      }
      if (!String(req.url || "").includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      const lines = respond(body)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      setTimeout(() => {
        for (const line of lines) res.write(sse(line))
        res.end()
      }, MODEL_LATENCY_MS)
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// Isolated tree and env, built from scratch (never layered on process.env)
// ---------------------------------------------------------------------------
function makeTree(name) {
  const root = path.join(SCRATCH, name)
  rmSync(root, { recursive: true, force: true })
  const tree = {
    name,
    root,
    home: path.join(root, "home"),
    cfg: path.join(root, "cfg"),
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
    cwd: path.join(root, "project"),
    configFile: path.join(root, "opencode-arm.json"),
  }
  for (const dir of [tree.home, tree.cfg, tree.data, tree.state, tree.cache, tree.cwd]) mkdirSync(dir, { recursive: true })
  tree.logDir = path.join(tree.data, "opencode", "log")
  return tree
}

function armEnv(tree) {
  return {
    PATH: process.env.PATH,
    HOME: tree.home,
    OPENCODE_TEST_HOME: tree.home,
    XDG_CONFIG_HOME: tree.cfg,
    XDG_STATE_HOME: tree.state,
    XDG_DATA_HOME: tree.data,
    XDG_CACHE_HOME: tree.cache,
    OPENCODE_CONFIG: tree.configFile,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    // Same benign isolation the reference harness uses; none of them touches compaction.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    // OPENCODE_DISABLE_AUTOCOMPACT deliberately absent.
  }
}

function writeConfig(tree, { baseURL, limit }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [[PLUGIN_SPEC, { limit }]],
    provider: {
      [PROVIDER_ID]: {
        name: "Test",
        id: PROVIDER_ID,
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          [MODEL_ID]: {
            id: MODEL_ID,
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 0, output: 10_000 }, // context 0: the host never compacts on its own
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL },
      },
    },
    model: `${PROVIDER_ID}/${MODEL_ID}`,
    permission: "allow",
    formatter: false,
    lsp: false,
  }
  writeFileSync(tree.configFile, `${JSON.stringify(config, null, 2)}\n`)
}

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function startServe(tree) {
  const port = await freePort()
  const serveLog = path.join(tree.root, "serve.log")
  const child = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: tree.cwd,
    env: armEnv(tree),
    stdio: ["ignore", "pipe", "pipe"],
  })
  liveChildren.add(child)
  log(`serve pid ${child.pid} port ${port} log ${serveLog}`)
  let output = ""
  const record = (part) => {
    output += String(part)
    appendFileSync(serveLog, String(part))
  }
  child.stdout.on("data", record)
  child.stderr.on("data", record)
  const exited = new Promise((resolve) =>
    child.on("close", () => {
      liveChildren.delete(child)
      resolve("closed")
    }),
  )
  const stop = async () => {
    if (!liveChildren.has(child)) return
    child.kill("SIGTERM")
    const raced = await Promise.race([exited, sleep(5000).then(() => "timeout")])
    if (raced === "timeout") child.kill("SIGKILL")
    await exited
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && liveChildren.has(child)) {
    const match = output.match(/listening on (http:\/\/\S+)/)
    if (match) {
      const baseUrl = match[1].trim()
      if (!baseUrl.endsWith(`:${port}`)) {
        await stop()
        throw new Error(`serve bound ${baseUrl}, not the isolated port ${port}`)
      }
      return { baseUrl, stop, serveLog, output: () => output }
    }
    await sleep(100)
  }
  await stop()
  throw new Error(`opencode serve never reported a URL. Log: ${serveLog}`)
}

function hostApi(baseUrl, directory) {
  const call = async (method, route, { body, timeoutMs = 60_000 } = {}) => {
    const target = new URL(route, baseUrl)
    target.searchParams.set("directory", directory)
    const response = await fetch(target, {
      method,
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let parsed = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {}
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 600)}`)
    return parsed
  }
  return { get: (route, options) => call("GET", route, options), post: (route, options) => call("POST", route, options) }
}

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------
const tokenTotal = (tokens) => {
  if (!tokens) return 0
  if (tokens.total > 0) return tokens.total
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
}
const isSummary = (info) => info?.summary === true || info?.agent === "compaction" || info?.mode === "compaction"

async function sessionRows(api, sessionID) {
  const messages = await api.get(`/session/${sessionID}/message?limit=500`)
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    id: m.info.id,
    role: m.info.role,
    summary: m.info.role === "assistant" && isSummary(m.info),
    finish: m.info.finish,
    tokens: tokenTotal(m.info.tokens),
  }))
}

async function sqliteSummaryCount(tree, sessionID) {
  const database = [path.join(tree.data, "opencode", "opencode.db")].find((p) => existsSync(p))
  if (!database) return { database: null, count: null }
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-json",
        database,
        `select count(*) as n from message where session_id = '${sessionID}' and json_extract(data,'$.role') = 'assistant' and (json_extract(data,'$.summary') = 1 or json_extract(data,'$.agent') = 'compaction' or json_extract(data,'$.mode') = 'compaction')`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    return { database, count: JSON.parse(stdout)[0].n }
  } catch (error) {
    return { database, count: null, error: error.message }
  }
}

// The host's log line carries only `message="..."` (the plugin's `service` is not
// printed), so a plugin line is recognised by its message shape, which always
// starts with a session id or "limit N tokens" / "forced compaction off".
const PLUGIN_LINE = /message="?(ses_\w+ (step context|forcing compaction|compacted|forced compaction|over the limit)|limit [\d,]+ tokens \(|forced compaction off)/
const isPluginLine = (line) => line.includes(PLUGIN_SERVICE) || PLUGIN_LINE.test(line)

/** Plugin log lines from the host's isolated log dir; falls back to serve output. */
function pluginLogLines(tree, serveOutput) {
  const lines = []
  let source = "none"
  if (existsSync(tree.logDir)) {
    for (const file of readdirSync(tree.logDir).sort()) {
      if (!file.endsWith(".log")) continue
      for (const line of readFileSync(path.join(tree.logDir, file), "utf8").split("\n")) {
        if (isPluginLine(line)) lines.push(line)
      }
    }
    if (lines.length) source = `${tree.logDir}/*.log`
  }
  if (!lines.length) {
    for (const line of serveOutput.split("\n")) if (isPluginLine(line)) lines.push(line)
    if (lines.length) source = "serve stdout/stderr"
  }
  return { lines, source }
}

const withoutPrefix = (line) => {
  const match = line.match(/message="?(.*?)"?$/)
  return match ? match[1] : line
}
const stepContexts = (lines) =>
  lines
    .map((line) => line.match(/step context ([\d,]+) \/ limit/))
    .filter(Boolean)
    .map((match) => Number(match[1].replaceAll(",", "")))

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------
async function runArm(name, limit) {
  const tree = makeTree(name)
  const script = makeScript()
  const mock = await startMock(script.respond)
  let serve
  const out = { name, limit, script: script.state, tree }
  try {
    writeConfig(tree, { baseURL: mock.baseURL, limit })

    // `opencode debug config` into a FILE (a pipe truncates at 64 KiB).
    const configDump = path.join(tree.root, "debug-config.json")
    await new Promise((resolve, reject) => {
      const fd = spawn("sh", ["-c", `"$0" debug config > "$1" 2> "$1.err"`, OPENCODE_BIN, configDump], {
        cwd: tree.cwd,
        env: armEnv(tree),
        stdio: "ignore",
      })
      fd.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`debug config exit ${code}; see ${configDump}.err`))))
    })
    const dumped = JSON.parse(readFileSync(configDump, "utf8"))
    out.plugins = dumped.plugin
    out.pluginOrigins = dumped.plugin_origins
    console.log(`${name} plugin: ${JSON.stringify(dumped.plugin)}`)
    console.log(`${name} plugin_origins: ${JSON.stringify(dumped.plugin_origins)}`)

    serve = await startServe(tree)
    const api = hostApi(serve.baseUrl, tree.cwd)
    const resolved = await api.get("/config/providers")
    out.resolvedLimit = (resolved?.providers ?? []).find((p) => p.id === PROVIDER_ID)?.models?.[MODEL_ID]?.limit
    console.log(`${name} host-resolved model limit: ${JSON.stringify(out.resolvedLimit)}`)

    const session = await api.post("/session", { body: { title: `cap smoke ${name}` } })
    out.sessionID = session.id
    log(`arm ${name} session ${session.id}`)

    // Blocks until the run ends; the compaction runs after the steps finish.
    const prompt = await api
      .post(`/session/${session.id}/message`, {
        body: { model: { providerID: PROVIDER_ID, modelID: MODEL_ID }, agent: "build", parts: [{ type: "text", text: "run the scripted steps" }] },
        timeoutMs: PROMPT_TIMEOUT_MS,
      })
      .then(() => "ok", (error) => `error: ${error.message}`)
    out.prompt = prompt
    log(`arm ${name} prompt returned: ${prompt}`)

    const waitFor = async (predicate, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await predicate()) return true
        await sleep(500)
      }
      return false
    }
    if (name === "CAP") {
      out.summaryLanded = await waitFor(async () => (await sessionRows(api, session.id)).some((r) => r.summary), SUMMARY_WAIT_MS)
    } else {
      await sleep(QUIET_WAIT_MS) // let any (wrongly) forced compaction show itself
    }
    // Let the host log flush: wait for the last plugin line this arm must have.
    const marker = name === "CAP" ? " compacted\"" : "step context"
    const end = Date.now() + LOG_FLUSH_WAIT_MS
    let logs = pluginLogLines(tree, serve.output())
    while (Date.now() < end && !logs.lines.some((l) => l.includes(marker))) {
      await sleep(500)
      logs = pluginLogLines(tree, serve.output())
    }
    await sleep(2000)
    out.logs = pluginLogLines(tree, serve.output())
    out.rows = await sessionRows(api, session.id)
    out.sqlite = await sqliteSummaryCount(tree, session.id)
  } finally {
    if (serve) await serve.stop()
    await mock.close()
  }
  // After the serve stops the log is fully flushed: re-read.
  out.logs = pluginLogLines(tree, serve ? serve.output() : "")
  return out
}

function report(out) {
  const { name, limit } = out
  const contexts = stepContexts(out.logs.lines)
  const summaries = out.rows.filter((r) => r.summary)
  console.log(`--- ${name} arm (limit ${limit.toLocaleString("en-US")}) ---`)
  console.log(`${name} log source: ${out.logs.source}`)
  for (const line of out.logs.lines) console.log(`${name} log: ${withoutPrefix(line)}`)
  console.log(`${name} measured step-context sequence: ${JSON.stringify(contexts)}`)
  console.log(`${name} DB assistant rows: ${JSON.stringify(out.rows.filter((r) => r.role === "assistant").map((r) => `${r.summary ? "SUMMARY" : "step"}[${r.tokens}${r.finish ? `,${r.finish}` : ""}]`))}`)
  console.log(`${name} summary rows: API ${summaries.length}, sqlite ${out.sqlite.count} (${out.sqlite.database ?? "no db"})`)
  console.log(`${name} mock: work requests ${JSON.stringify(out.script.work)}, compaction requests ${out.script.compactionHits}, post-compaction work ${out.script.postCompaction}`)

  const lines = out.logs.lines.map(withoutPrefix)
  const initPattern = `limit ${limit.toLocaleString("en-US")} tokens (option)`
  const forcingIdx = lines.findIndex((l) => l.includes("forcing compaction"))
  const compactedIdx = lines.findIndex((l) => /^ses_\w+ compacted$/.test(l))
  const forcingCount = lines.filter((l) => l.includes("forcing compaction")).length

  verdict(
    `${name} one plugin, ours`,
    Array.isArray(out.plugins) && out.plugins.length === 1 && String(JSON.stringify(out.plugins[0])).includes(PLUGIN_SPEC),
    JSON.stringify(out.plugins),
  )
  verdict(`${name} host resolved limit.context=0`, out.resolvedLimit?.context === 0, JSON.stringify(out.resolvedLimit))
  verdict(`${name} prompt completed`, out.prompt === "ok", out.prompt)
  verdict(`${name} loaded`, lines.some((l) => l.includes(initPattern)), `init line "${initPattern}" ${lines.some((l) => l.includes(initPattern)) ? "seen" : "NOT seen"}`)

  if (name === "CAP") {
    const firstOver = contexts.findIndex((c) => c >= limit)
    const below = contexts.slice(0, Math.max(firstOver, 0)).filter((c) => c < limit)
    verdict("CAP step below limit then step at/above", firstOver > 0 && below.length >= 1, `sequence ${JSON.stringify(contexts)}, first >= ${limit} at index ${firstOver}, ${below.length} step(s) before it below the limit`)
    verdict("CAP forcing compaction logged", forcingIdx >= 0, forcingIdx >= 0 ? lines[forcingIdx] : "no 'forcing compaction' line")
    verdict("CAP host compacted (session.compacted seen via plugin)", compactedIdx >= 0 && forcingIdx >= 0 && compactedIdx > forcingIdx, compactedIdx >= 0 ? `${lines[compactedIdx]} (log line ${compactedIdx} after forcing at ${forcingIdx})` : "no 'compacted' line")
    verdict("CAP summary row exists", summaries.length >= 1 && (out.sqlite.count === null || out.sqlite.count >= 1), `API ${summaries.length}, sqlite ${out.sqlite.count}`)
    verdict("CAP mock saw a compaction request", out.script.compactionHits >= 1, `compaction requests ${out.script.compactionHits}`)
  } else {
    verdict("CONTROL step context lines present", contexts.length >= 1, `sequence ${JSON.stringify(contexts)}`)
    verdict("CONTROL every step below limit", contexts.length >= 1 && contexts.every((c) => c < limit), `max ${Math.max(0, ...contexts)} vs limit ${limit}`)
    verdict("CONTROL zero forcing compaction lines", forcingCount === 0, `${forcingCount} line(s)`)
    verdict("CONTROL zero summary rows", summaries.length === 0 && (out.sqlite.count === null || out.sqlite.count === 0), `API ${summaries.length}, sqlite ${out.sqlite.count}`)
    verdict("CONTROL mock saw no compaction request", out.script.compactionHits === 0, `compaction requests ${out.script.compactionHits}`)
    verdict("CONTROL usage matched CAP's crossing (peak >= CAP limit)", Math.max(0, ...contexts) >= CAP_LIMIT, `peak ${Math.max(0, ...contexts)} >= ${CAP_LIMIT}`)
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`opencode-compact-at-token-limit live smoke; plugin ${PLUGIN_SPEC}; scratch ${SCRATCH}`)
  const { stdout } = await execFileAsync(OPENCODE_BIN, ["--version"], { env: { PATH: process.env.PATH } }).catch(() => ({ stdout: "MISSING" }))
  const version = stdout.trim()
  verdict("host version", version === EXPECTED_HOST_VERSION, `${OPENCODE_BIN} reports ${version}, expected ${EXPECTED_HOST_VERSION}`)
  if (version !== EXPECTED_HOST_VERSION) return
  console.log(`scripted work usage (prompt tokens): ${JSON.stringify(STEP_USAGE)} then ${FINAL_USAGE}; CAP limit ${CAP_LIMIT}, CONTROL limit ${CONTROL_LIMIT}`)

  for (const [name, limit] of [["CAP", CAP_LIMIT], ["CONTROL", CONTROL_LIMIT]]) {
    try {
      report(await runArm(name, limit))
    } catch (error) {
      log(`arm ${name} aborted: ${error.stack}`)
      verdict(`${name} arm ran`, false, error.message)
    }
  }
}

try {
  await main()
} catch (error) {
  verdict("smoke driver", false, error.stack ?? error.message)
} finally {
  for (const child of liveChildren) child.kill("SIGKILL")
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `SMOKE FAIL (${failed.length} of ${results.length} assertions failed: ${failed.map((r) => r.label).join("; ")})` : `SMOKE PASS (${results.length} assertions)`)
process.exit(failed.length ? 1 : 0)
