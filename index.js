/**
 * Host half of `dsh-session-notify`.
 *
 * Listens for session lifecycle events from the harness core and makes pending
 * notifications available to the browser half through an in-memory queue that
 * the client drains over the exact HTTP route registered here.
 *
 * Two event kinds trigger a macOS-style toast:
 *
 *  - `turn/end` — a session's turn finished (the agent completed its work).
 *  - `approval/asked` — a tool call is waiting for the user to allow or reject
 *    it (the "等待审批" card), and `ask_user_question` tool calls — the session
 *    is waiting for user interaction.
 *
 * Legacy interaction event names (`interaction` / `ask-user` / `session/held`)
 * remain supported for older harnesses.
 *
 * @module dsh-session-notify/host
 */

/** Required Host service: the browser HTTP carrier this plugin registers on. */
export const inject = ['webServer']

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Exact path of the notification drain route. */
export const ROUTE_PATH = '/dsh-session-notify/notifications'

/** Maximum number of notifications retained in the host queue. */
const MAX_QUEUE = 200

/** Polling interval (ms) for checking session events. */
const POLL_INTERVAL_MS = 3000

/** Title cache lifetime (ms) — titles change slowly, events do not. */
const TITLE_TTL_MS = 60_000

/** Where the harness keeps per-session projections (they hold the title). */
const PROJECTION_DIR = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'storages',
  'session_projcache',
  'sessions',
)

/**
 * A pending notification awaiting delivery to the browser half.
 * @typedef {object} PendingNotification
 * @property {string} id - unique notification id
 * @property {string} sessionId - the DSH session id
 * @property {string} sessionTitle - human-readable session title
 * @property {string} kind - 'turn-end' | 'interaction' | 'approval'
 * @property {string} message - user-facing message
 * @property {number} timestamp - epoch ms when the notification was raised
 */

/**
 * Build the queue + event observers and wire them to the host context.
 *
 * @param ctx - host composition context.
 * @returns undefined; mounted effects are owned by `ctx.effect`.
 */
export function apply(ctx, config = {}) {
  /**
   * Only notify for sessions the user can actually see and open. Subagent
   * sessions (`header.origin === "subagent"`, or a delegation depth > 0) are
   * agent-internal delegations with no sidebar entry, so a toast pointing at
   * one is a dead end. `config.includeSubagents: true` opts back in.
   */
  const includeSubagents = config?.includeSubagents === true  /** FIFO queue of pending notifications. */
  const queue = []
  /** Set of recently delivered ids to suppress duplicate toasts. */
  const delivered = new Set()
  /** Map of sessionId -> last processed event sequence number. */
  const lastSeq = new Map()
  /** Whether the poller is running. */
  let running = false
  /** Whether a single poll tick is currently in flight (re-entrancy guard). */
  let polling = false
  /** Timer id for the poller. */
  let timerId = null
  /** Last scan diagnostics, surfaced by the debug endpoint. */
  const scanStats = { lastScanAt: 0, liveSessions: 0, lastError: undefined, pollMode: 'unknown' }
  /** sessionId -> display title, harvested from persistence snapshots (cached). */
  let titleById = new Map()
  /** When the title map was last refreshed. */
  let titleRefreshedAt = 0
  /** sessionId -> { title, at } resolved from the projection cache. */
  const titleCache = new Map()

  /**
   * Log through the host logger when it exists.
   */
  function log(level, message, detail) {
    const logger = ctx.logger
    const write = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : console[level]?.bind(console)
    if (typeof write !== 'function') return
    if (detail === undefined) write(message)
    else write(message, detail)
  }

  /**
   * Read one session's display title from the harness projection cache.
   *
   * The projection JSON keeps the sidebar's rendered title at
   * `record.rows.title.val` — the only place a human-readable name exists;
   * the session event log and the persistence registry carry no title.
   *
   * @param sessionId - session id.
   * @returns the title, or undefined when the projection has none.
   */
  async function titleFromProjection(sessionId) {
    try {
      const raw = await readFile(join(PROJECTION_DIR, `${sessionId}.json`), 'utf8')
      const title = JSON.parse(raw)?.record?.rows?.title?.val
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      // missing/unreadable projection: fall through to the caches
    }
    return undefined
  }

  /**
   * Resolve a session's display name, cached for a minute.
   * @param sessionId - session id.
   * @returns the best available name (title, else the id).
   */
  async function resolveTitle(sessionId) {
    const cached = titleCache.get(sessionId)
    if (cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
    let title = await titleFromProjection(sessionId)
    if (!title) title = titleById.get(sessionId)
    // Never surface a raw session id to the user; an unnamed session gets a
    // neutral placeholder instead (the id stays available for navigation).
    if (!title) title = '未命名会话'
    titleCache.set(sessionId, { title, at: Date.now() })
    if (titleCache.size > 500) {
      for (const key of titleCache.keys()) {
        titleCache.delete(key)
        if (titleCache.size <= 500) break
      }
    }
    return title
  }

  /**
   * Enqueue a notification.
   * @param {PendingNotification} n
   */
  function enqueue(n) {
    if (delivered.has(n.id)) return
    queue.push(n)
    if (queue.length > MAX_QUEUE) queue.shift()
    delivered.add(n.id)
    if (delivered.size > MAX_QUEUE * 2) {
      for (const id of delivered) {
        delivered.delete(id)
        if (delivered.size <= MAX_QUEUE * 2) break
      }
    }
    log('debug', `[session-notify] enqueued: ${n.kind} - ${n.message}`)
  }

  /**
   * Get session title from session object.
   * @param {object} session - session handle.
   * @returns {string} session title or id.
   */
  function getSessionTitle(session) {
    if (!session || typeof session !== 'object') return 'unknown'
    return session.title || session.name || session.id || 'unknown'
  }

  /**
   * Whether a live session is an agent-internal delegation rather than a
   * user-visible top-level session (no sidebar row, no way to open it).
   * @param session - live harness session.
   * @returns true for subagent sessions.
   */
  function isSubagentSession(session) {
    try {
      const header = session && session.header
      if (!header || typeof header !== 'object') return false
      if (header.origin === 'subagent') return true
      const depth = Number(header.delegationDepth)
      return Number.isFinite(depth) && depth > 0
    } catch {
      return false
    }
  }

  /**
   * Check one session for new events and raise notifications.
   * @param {object} session - session handle from the harness session service.
   * @param {object|string} [snapshot] - persistence row, for a better title.
   */
  async function checkSession(session, snapshot) {
    if (!session || typeof session !== 'object') return
    const sessionId = session.id || session.sessionId || (typeof snapshot === 'string' ? snapshot : snapshot?.id || snapshot?.sessionId)
    if (!sessionId) return

    // Get the current sequence number
    const seq = Number(session.seq)
    if (!Number.isFinite(seq) || seq <= 0) return

    // First sight of a session: adopt its current head instead of replaying its
    // whole history (a resumed session would otherwise notify every past turn).
    if (!lastSeq.has(sessionId)) {
      lastSeq.set(sessionId, seq)
      return
    }

    const prevSeq = lastSeq.get(sessionId)
    if (prevSeq >= seq) return

    // Resolve the human-readable name from the projection cache (the only
    // place a session title exists), never settling for the raw id first.
    const snapTitle = snapshot && typeof snapshot === 'object'
      ? snapshot.title || snapshot.name
      : undefined
    const sessionTitle = snapTitle || await resolveTitle(sessionId)

    // Check new events from prevSeq to seq-1
    for (let i = prevSeq; i < seq; i++) {
      let event
      try {
        event = typeof session.eventAt === 'function' ? session.eventAt(i) : undefined
      } catch (err) {
        log('debug', `[session-notify] failed to read event ${i} for session ${sessionId}: ${err.message}`)
        continue
      }
      if (!event || typeof event !== 'object') continue

      const eventType = event.type || event.kind
      const message = event.message || event.text || ''

      if (eventType === 'turn/end') {
        enqueue({
          id: `turn-end:${sessionId}:${i}`,
          sessionId,
          sessionTitle,
          kind: 'turn-end',
          message: message || `会话「${sessionTitle}」的回合已完成`,
          timestamp: Date.now(),
        })
      } else if (eventType === 'approval/asked') {
        // A tool is waiting for the user to allow or reject it. The event data
        // carries the tool name and an optional asker-supplied reason, which is
        // exactly what the approval card in the UI shows.
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        const toolName = typeof data.toolName === 'string' && data.toolName !== '' ? data.toolName : '工具'
        const rawReason = typeof data.reason === 'string' ? data.reason.trim() : ''
        const reason = rawReason.length > 80 ? `${rawReason.slice(0, 80)}…` : rawReason
        enqueue({
          id: `approval:${sessionId}:${String(data.id ?? i)}`,
          sessionId,
          sessionTitle,
          kind: 'approval',
          message: `会话「${sessionTitle}」等待审批：${toolName}${reason === '' ? '' : `（${reason}）`}`,
          timestamp: Date.now(),
        })
      } else if (eventType === 'tool/call') {
        // `ask_user_question` blocks the turn until the user answers, so it is
        // an interaction the user must see even though no dedicated event exists.
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        if (data.name === 'ask_user_question') {
          enqueue({
            id: `ask-user:${sessionId}:${String(data.callId ?? i)}`,
            sessionId,
            sessionTitle,
            kind: 'interaction',
            message: `会话「${sessionTitle}」需要您回答一个问题`,
            timestamp: Date.now(),
          })
        }
      } else if (eventType === 'interaction' || eventType === 'ask-user' || eventType === 'session/held') {
        enqueue({
          id: `interaction:${sessionId}:${i}`,
          sessionId,
          sessionTitle,
          kind: 'interaction',
          message: message || `会话「${sessionTitle}」需要与您交互`,
          timestamp: Date.now(),
        })
      }
    }

    // Update last processed sequence
    lastSeq.set(sessionId, seq)
  }

  /**
   * Refresh the session-id -> title map from persistence snapshots (throttled;
   * titles are display metadata that lives outside the session event log).
   */
  async function refreshTitles(force = false) {
    const now = Date.now()
    if (!force && now - titleRefreshedAt < 30_000) return
    titleRefreshedAt = now
    try {
      const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
      if (!persistence || typeof persistence.list !== 'function') return
      const rows = await persistence.list()
      const next = new Map()
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = typeof row === 'string' ? row : row?.id ?? row?.sessionId
        if (typeof id !== 'string' || id === '') continue
        const title = row && typeof row === 'object' ? row.title || row.name : undefined
        if (typeof title === 'string' && title !== '') next.set(id, title)
      }
      if (next.size > 0) titleById = next
    } catch {
      // Titles are cosmetic; keep the previous map on failure.
    }
  }

  /**
   * Poll all sessions for new events.
   *
   * `sessions.list()` is the authoritative enumeration of LIVE sessions — the
   * only ones whose event stream is readable — so it is preferred over the
   * persistence registry (which also lists released sessions and returns a
   * promise). Falls back to `persistence.list()` + `get()` on compositions
   * whose session service exposes no `list()`.
   */
  async function pollSessions() {
    if (polling) return
    polling = true
    try {
      let sessions
      try {
        sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      } catch (err) {
        log('debug', `[session-notify] failed to get sessions service: ${err.message}`)
        return
      }

      // Preferred path: the session service enumerates its live sessions.
      if (sessions && typeof sessions.list === 'function') {
        let live
        try {
          live = sessions.list()
        } catch (err) {
          log('debug', `[session-notify] sessions.list() failed: ${err.message}`)
          return
        }
        const arr = Array.isArray(live) ? live : []
        scanStats.pollMode = 'sessions.list'
        scanStats.lastScanAt = Date.now()
        scanStats.liveSessions = arr.length
        scanStats.lastError = undefined
        await refreshTitles()
        for (const session of arr) {
          if (!includeSubagents && isSubagentSession(session)) continue
          await checkSession(session)
        }
        return
      }

      // Fallback: persistence registry + store lookup.
      let snapshots
      try {
        const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
        if (!persistence || typeof persistence.list !== 'function') return
        snapshots = await persistence.list()
      } catch (err) {
        log('debug', `[session-notify] failed to list sessions: ${err.message}`)
        return
      }
      if (!Array.isArray(snapshots) || !sessions || typeof sessions.get !== 'function') return

      let liveChecked = 0
      for (const snapshot of snapshots) {
        const sessionId = typeof snapshot === 'string' ? snapshot : snapshot?.id || snapshot?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') continue

        let session
        try {
          session = sessions.get(sessionId)
        } catch {
          continue
        }
        if (!session) continue // released by the host; nothing to scan
        if (!includeSubagents && isSubagentSession(session)) continue
        liveChecked += 1
        await checkSession(session, snapshot)
      }
      scanStats.pollMode = 'persistence+get'
      scanStats.lastScanAt = Date.now()
      scanStats.liveSessions = liveChecked
      scanStats.lastError = undefined
    } finally {
      polling = false
    }
  }

  // Start the poller
  ctx.effect(() => {
    if (running) return
    running = true
    log('info', '[session-notify] starting session poller')
    pollSessions()
    timerId = setInterval(pollSessions, POLL_INTERVAL_MS)
    return () => {
      if (timerId) {
        clearInterval(timerId)
        timerId = null
      }
      running = false
      log('info', '[session-notify] stopped session poller')
    }
  }, 'session-notify: session poller')

  // Expose the read-only drain endpoint for the browser half.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (request, response) => {
          const batch = queue.splice(0, queue.length)
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify({ notifications: batch }))
        },
      }),
    'session-notify: notifications drain route',
  )

  // Expose a test endpoint to trigger a test notification.
  //   /dsh-session-notify/test?kind=turn-end
  //   /dsh-session-notify/test?kind=interaction
  //   /dsh-session-notify/test?kind=approval
  //   /dsh-session-notify/test?sessionId=<live session id>&title=<label>
  //   /dsh-session-notify/test?repeat=30   (re-enqueue every 2s for 30s)
  let repeatTimer = null
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-notify/test',
        handler: async (request, response) => {
          const url = request.url || ''
          const params = new URL(url, 'http://x').searchParams
          const requestedKind = params.get('kind')
          const kindParam = requestedKind === 'interaction' || requestedKind === 'approval' ? requestedKind : 'turn-end'
          const repeatSeconds = Math.min(Math.max(Number(params.get('repeat')) || 0, 0), 60)

          // Default to the most recently active live session so a click can be
          // verified to switch the main view; fall back to a synthetic id.
          let sessionId = params.get('sessionId') || ''
          let sessionTitle = params.get('title') || ''
          if (sessionId === '') {
            try {
              const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
              const live = sessions && typeof sessions.list === 'function' ? sessions.list() : []
              const visible = (Array.isArray(live) ? live : []).filter((s) => includeSubagents || !isSubagentSession(s))
              const target = visible.length > 0 ? visible[visible.length - 1] : undefined
              sessionId = target && target.id ? target.id : 'test-session'
            } catch {
              sessionId = 'test-session'
            }
          }
          // Always prefer the real display name; never show the raw id in a title.
          if (sessionId !== 'test-session') sessionTitle = sessionTitle || await resolveTitle(sessionId)
          if (sessionTitle === '') sessionTitle = '测试会话'

          const fire = () =>
            enqueue({
              id: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
              sessionId,
              sessionTitle: sessionTitle || sessionId,
              kind: kindParam,
              message: kindParam === 'turn-end'
                ? '这是一条测试通知：会话回合已完成'
                : kindParam === 'approval'
                  ? `这是一条测试通知：会话「${sessionTitle || sessionId}」等待审批：bash`
                  : '这是一条测试通知：会话需要与您交互',
              timestamp: Date.now(),
            })

          fire()
          if (repeatSeconds > 0) {
            if (repeatTimer !== null) clearInterval(repeatTimer)
            const startedAt = Date.now()
            repeatTimer = setInterval(() => {
              if (Date.now() - startedAt >= repeatSeconds * 1000) {
                clearInterval(repeatTimer)
                repeatTimer = null
                return
              }
              fire()
            }, 2000)
          }

          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify({ ok: true, message: 'Test notification enqueued', repeatSeconds }))
        },
      }),
    'session-notify: test endpoint',
  )

  // Client self-check reporting: the browser half posts the bundle version, the
  // availability of the session-switch service, and click outcomes so `/debug`
  // can show what the browser really sees.
  const clientStatus = {}
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-notify/client-status',
        handler: (request, response) => {
          try {
            const params = new URL(request.url || '/', 'http://x').searchParams
            for (const key of ['v', 'uiWorkspace', 'openSession', 'err', 'click', 'sessionId', 'clickErr', 'at']) {
              const value = params.get(key)
              if (value !== null) clientStatus[key] = value.slice(0, 300)
            }
            clientStatus.receivedAt = Date.now()
          } catch {
            // ignore malformed reports
          }
          response.writeHead(204, { 'cache-control': 'no-store' })
          response.end()
        },
      }),
    'session-notify: client status route',
  )


  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-notify/sessions',
        handler: async (request, response) => {
          let rows = []
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
            const live = sessions && typeof sessions.list === 'function' ? sessions.list() : []
            const visible = (Array.isArray(live) ? live : []).filter((s) => includeSubagents || !isSubagentSession(s))
            rows = await Promise.all(visible.map(async (s) => ({
              id: s.id,
              title: await resolveTitle(s.id),
              seq: s.seq,
            })))
          } catch {
            // leave rows empty
          }
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify({ sessions: rows }))
        },
      }),
    'session-notify: live sessions endpoint',
  )

  // Expose a debug endpoint to check plugin status
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-notify/debug',
        handler: (request, response) => {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify({
            plugin: 'dsh-session-notify',
            status: 'loaded',
            queueSize: queue.length,
            deliveredCount: delivered.size,
            lastSeq: lastSeq.size,
            pollMode: scanStats.pollMode,
            lastScanAt: scanStats.lastScanAt,
            liveSessions: scanStats.liveSessions,
            client: clientStatus,
            route: ROUTE_PATH,
            test: '/dsh-session-notify/test',
            debug: '/dsh-session-notify/debug',
          }))
        },
      }),
    'session-notify: debug endpoint',
  )

  log('info', `[session-notify] plugin loaded, route: ${ROUTE_PATH}, test: /dsh-session-notify/test, debug: /dsh-session-notify/debug`)
}

export default { inject, apply }
