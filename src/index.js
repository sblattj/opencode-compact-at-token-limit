// opencode-compact-at-token-limit
//
// Forces a session compaction when the context reaches a token limit
// (default 200000). It does nothing else: no tools, no commands, no state on disk.
//
// The mechanism is taken from the forced compaction in
// sblattj/opencode-goal-pro-max-complete-plugin (v1.5.3, src/goal-plugin.js),
// with one change: it watches every session, not only sessions with a goal.
//
//   1. On every finished assistant step (message.updated with `finish`), read the
//      context that step ran with: tokens.total, else input + output + reasoning
//      + cache.read + cache.write.
//   2. If it is at or over the limit, ask the host to compact:
//      POST /session/{id}/summarize with the step's provider and model. The host
//      answers only when the whole run ends, so the call is never awaited.
//   3. session.compacted is the only proof a compaction happened. It clears the
//      pending request and resets the measured context.
//
// Guards, all from the source plugin:
//   - one pending request per session;
//   - a request with no compaction after 3 more steps counts as a failure, and
//     after 3 failures forcing stops until the next session.compacted;
//   - if the first step after 2 compactions in a row is still over the limit,
//     forcing holds until a step comes in under the limit (stops a compaction loop);
//   - when the host's own overflow check is alive for the model (limit.context > 0),
//     the crossing step is left to the host, so both do not compact at once;
//   - session.idle is a backstop for a turn that ended over the limit with no
//     request sent.

export const DEFAULT_LIMIT = 200000
export const ENV_VAR = "OPENCODE_COMPACT_AT_TOKENS"
const PLUGIN_ID = "opencode-compact-at-token-limit"

const RETRY_STEPS = 3
const MAX_FAILURES = 3
const MAX_STRIKES = 2
const MAX_SESSIONS = 1000
const HOST_DEADLINE_MS = 5000

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const nonNegativeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0

/**
 * A token count from a plugin option or env var: a non-negative integer, a
 * numeric string, or a string with a k/m suffix ("150k", "1.5m"). 0 means off.
 * Anything else is undefined.
 */
export function parseLimit(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (typeof value !== "string") return undefined
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim())
  if (!match) return undefined
  const scale = { k: 1e3, m: 1e6 }[match[2]?.toLowerCase()] ?? 1
  const tokens = Number(match[1]) * scale
  return Number.isSafeInteger(tokens) ? tokens : undefined
}

/**
 * Plugin option `limit` wins, then the OPENCODE_COMPACT_AT_TOKENS env var, then
 * 200000. An invalid value is skipped, so a typo never turns forcing off.
 */
export function resolveLimit(options = {}, env = {}) {
  const fromOption = parseLimit(options?.limit)
  if (fromOption !== undefined) return { limit: fromOption, source: "option" }
  const fromEnv = parseLimit(env?.[ENV_VAR])
  if (fromEnv !== undefined) return { limit: fromEnv, source: "env" }
  return { limit: DEFAULT_LIMIT, source: "default" }
}

/** The context a message ran with, as the host reports it. */
export function contextTokens(info) {
  const tokens = isPlainObject(info?.tokens) ? info.tokens : {}
  const total = nonNegativeInteger(tokens.total)
  if (total > 0) return total
  const cache = isPlainObject(tokens.cache) ? tokens.cache : {}
  return (
    nonNegativeInteger(tokens.input) +
    nonNegativeInteger(tokens.output) +
    nonNegativeInteger(tokens.reasoning) +
    nonNegativeInteger(cache.read) +
    nonNegativeInteger(cache.write)
  )
}

// A summary carries the full pre-compaction tokens, so it says nothing about
// the context after the compaction.
function isSummaryMessage(info) {
  return info?.summary === true || info?.agent === "compaction" || info?.mode === "compaction"
}

function eventSessionID(event) {
  const props = isPlainObject(event?.properties) ? event.properties : {}
  const id = props.sessionID ?? props.info?.id ?? props.info?.sessionID
  return typeof id === "string" && id ? id : ""
}

function freshSession() {
  return {
    latestTokens: 0,
    latestStep: null, // { providerID, modelID } of the latest measured step
    lastStepID: "",
    pending: null, // { id, steps }
    failures: 0,
    strikes: 0,
    held: false,
    epoch: 0, // compactions seen
    checkedEpoch: 0,
    graceEpoch: 0,
  }
}

function withinDeadline(promise, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

export const ContextCapPlugin = async (input = {}, options = {}) => {
  const client = input?.client
  const env = isPlainObject(options?.env) ? options.env : process.env
  const { limit, source } = resolveLimit(options, env)
  const sessions = new Map()
  let requestCounter = 0

  const log = (level, message) => {
    try {
      const call = client?.app?.log?.({ body: { service: PLUGIN_ID, level, message } })
      Promise.resolve(call).catch(() => {})
    } catch {
      // Logging is advisory.
    }
  }

  const sessionState = (sessionID) => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = freshSession()
      sessions.set(sessionID, state)
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    }
    return state
  }

  const allowed = (state) =>
    limit > 0 && !state.pending && !state.held && state.failures < MAX_FAILURES

  const recordFailure = (sessionID, state, reason) => {
    state.pending = null
    state.failures += 1
    log("info", `${sessionID} forced compaction did not land (${reason}); failure ${state.failures}/${MAX_FAILURES}`)
    if (state.failures === MAX_FAILURES) {
      log("warn", `${sessionID} forced compaction failed 3 times; not forcing again until the next compaction`)
    }
  }

  // Is the host's own overflow check alive for this model? It is off when the
  // model reports limit.context 0. Unknown reads as off.
  const hostCompactsModel = async ({ providerID, modelID }) => {
    try {
      const response = await withinDeadline(Promise.resolve(client?.config?.providers?.()), HOST_DEADLINE_MS)
      const data = isPlainObject(response?.data) ? response.data : response
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const provider = providers.find((entry) => entry?.id === providerID)
      return nonNegativeInteger(provider?.models?.[modelID]?.limit?.context) > 0
    } catch {
      return false
    }
  }

  const requestCompaction = (sessionID, state, tokens) => {
    const { providerID, modelID } = state.latestStep ?? {}
    if (typeof client?.session?.summarize !== "function" || !providerID || !modelID) return false
    requestCounter += 1
    const request = { id: requestCounter, steps: 0 }
    state.pending = request
    log("info", `${sessionID} forcing compaction at ${tokens.toLocaleString()} tokens (limit ${limit.toLocaleString()})`)
    const failed = (reason) => {
      const live = sessions.get(sessionID)
      if (live?.pending === request) recordFailure(sessionID, live, reason)
    }
    let call
    try {
      call = client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID } })
    } catch (error) {
      failed(error?.message || String(error))
      return true
    }
    // Never awaited: the host answers when the whole run ends. Only
    // session.compacted proves success; an error answer is a failure now.
    Promise.resolve(call).then(
      (response) => {
        if (isPlainObject(response) && response.error) {
          failed(`host answered ${response.error?.name || "an error"}`)
        }
      },
      (error) => failed(error?.message || String(error)),
    )
    return true
  }

  const onFinishedStep = async (info) => {
    const sessionID = typeof info.sessionID === "string" ? info.sessionID : ""
    if (!sessionID || limit <= 0) return
    if (info.role !== "assistant" || !info.finish || isSummaryMessage(info)) return
    const tokens = contextTokens(info)
    if (tokens <= 0) return
    const state = sessionState(sessionID)
    if (typeof info.id === "string" && info.id) {
      if (state.lastStepID === info.id) return
      state.lastStepID = info.id
    }
    state.latestTokens = tokens
    state.latestStep = { providerID: info.providerID, modelID: info.modelID }
    log("info", `${sessionID} step context ${tokens.toLocaleString()} / limit ${limit.toLocaleString()}`)

    if (tokens < limit) {
      state.strikes = 0
      state.held = false
      state.graceEpoch = 0
    } else if (state.checkedEpoch !== state.epoch) {
      state.strikes += 1
      if (state.strikes >= MAX_STRIKES && !state.held) {
        state.held = true
        log(
          "warn",
          `${sessionID} forced compaction is not lowering the context (${tokens.toLocaleString()} tokens right after compacting); holding until a step is below ${limit.toLocaleString()}`,
        )
      }
    }
    state.checkedEpoch = state.epoch

    if (state.pending) {
      state.pending.steps += 1
      if (state.pending.steps < RETRY_STEPS) return
      recordFailure(sessionID, state, `no compaction after ${state.pending.steps} steps`)
    }
    if (tokens >= limit && allowed(state)) {
      const graceEpoch = state.epoch + 1
      if (state.graceEpoch !== graceEpoch && (await hostCompactsModel(state.latestStep))) {
        state.graceEpoch = graceEpoch
        log("info", `${sessionID} over the limit; leaving this step to the host's own compaction`)
        return
      }
      // The host lookup above yields, and session.idle can send a request meanwhile.
      if (!allowed(state)) return
      requestCompaction(sessionID, state, tokens)
    }
  }

  const event = async ({ event } = {}) => {
    try {
      if (!isPlainObject(event)) return
      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (isPlainObject(info)) await onFinishedStep(info)
        return
      }
      const sessionID = eventSessionID(event)
      if (!sessionID) return
      if (event.type === "session.compacted") {
        const state = sessionState(sessionID)
        state.pending = null
        state.failures = 0
        state.epoch += 1
        state.latestTokens = 0
        log("info", `${sessionID} compacted`)
        return
      }
      if (event.type === "session.idle") {
        const state = sessions.get(sessionID)
        if (state && state.latestTokens >= limit && allowed(state)) {
          requestCompaction(sessionID, state, state.latestTokens)
        }
        return
      }
      if (event.type === "session.deleted") sessions.delete(sessionID)
    } catch (error) {
      log("error", `event handler failed: ${error?.message || error}`)
    }
  }

  log(
    "info",
    limit > 0
      ? `limit ${limit.toLocaleString()} tokens (${source})`
      : `forced compaction off (limit 0, ${source})`,
  )
  return { event }
}

export default {
  id: PLUGIN_ID,
  server: ContextCapPlugin,
}
