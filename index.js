/**
 * Host half of the `dsh-task-delete` bundle.
 *
 * The Client half adds a "delete task" row to every Workspace task's "..." menu.
 * This half performs the irreversible removal on the local machine even when
 * the task is still running or open:
 *
 *   1. stop its work (archive admission / cancel / wait idle / flush),
 *   2. delete the session log directories (all format generations),
 *   3. delete the persisted projection-cache records,
 *   4. delete hidden subagent children (their logs are task-owned data),
 *   5. announce `api-session/removed` so the Web UI drops the rows immediately.
 *
 * If a file is still locked by the live process after the stop, deletion is
 * retried; anything still locked is recorded in
 * `<DSH_HOME>/task-delete-pending.json` and removed by the next plugin start.
 *
 * It never deletes shared attachment objects (content-addressed and possibly
 * referenced by other tasks).
 */
import { mkdir, readdir, readFile, rename, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Services required before the deletion route can be mounted. */
export const inject = ['webServer', 'connection', 'sessions', 'agents', 'sessionPersistence']

/** Route the Client half POSTs a JSON `{ sessionId }` body to. */
export const DELETE_ROUTE = '/task-delete/delete'

const MAX_BODY_BYTES = 16 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const PENDING_JOURNAL_FILE = 'task-delete-pending.json'
const REMOVE_RETRY_DELAYS_MS = [0, 60, 120, 200, 320, 500, 800]
const STOP_IDLE_TIMEOUT_MS = 4000
const CACHE_SWEEP_DELAY_MS = 1500
const STARTUP_SWEEP_DELAY_MS = 1500

class TaskDeleteError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code Stable machine-readable failure key.
   * @param {string} message Display message.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'TaskDeleteError'
    this.status = status
    this.code = code
  }
}

/** Serialize journal writes so concurrent deletions never lose an entry. */
let journalChain = Promise.resolve()

/**
 * Mount the deletion route and the deferred-cleanup sweep.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 */
export function apply(ctx) {
  /** @type {Set<string>} Roots currently being deleted, to reject double clicks. */
  const inflight = new Set()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DELETE_ROUTE,
    handler: (req, res) => {
      void handleRequest(ctx, inflight, req, res)
    },
  }), 'dsh-task-delete: delete route')

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void sweepPendingDeletions(resolveDshHome(), ctx.get('workspaceRegistry'))
        .then((result) => {
          // A deferred task can be listed again from its surviving log on the
          // next start; after the sweep deletes it, drop those rows from the UI.
          for (const id of result.sessionIds) {
            try {
              ctx.emit('api-session/removed', id)
            } catch {
              // Best-effort UI cleanup only.
            }
          }
        })
        .catch((error) => ctx.logger?.warn?.('dsh-task-delete: pending cleanup failed', error))
    }, STARTUP_SWEEP_DELAY_MS)
    timer.unref?.()
    return () => {
      clearTimeout(timer)
    }
  }, 'dsh-task-delete: deferred cleanup')
}

/**
 * One HTTP request entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Set<string>} inflight Deletion roots currently running.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {import('node:http').ServerResponse} res Response.
 */
async function handleRequest(ctx, inflight, req, res) {
  try {
    // Reuse Connection's Host/Origin fence and browser authentication instead of
    // re-deriving trusted authorities here. An unauthenticated caller gets the
    // rejection status it would get from `/api`.
    const rejection = ctx.connection.requestRejection({ headers: req.headers })
    if (rejection !== undefined) {
      throw new TaskDeleteError(rejection, 'unauthorized', '请求未通过本机连接认证。')
    }
    if (req.method !== 'POST') {
      throw new TaskDeleteError(405, 'method-not-allowed', '仅支持 POST 请求。')
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      throw new TaskDeleteError(415, 'json-required', '请求必须是 application/json。')
    }
    let body
    try {
      body = JSON.parse(await readJsonBody(req, MAX_BODY_BYTES))
    } catch (error) {
      if (error instanceof TaskDeleteError) throw error
      throw new TaskDeleteError(400, 'invalid-json', '请求内容不是合法的 JSON。')
    }
    const sessionId = body !== null && typeof body === 'object' && typeof body.sessionId === 'string'
      ? body.sessionId
      : ''
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new TaskDeleteError(400, 'invalid-session-id', '任务 ID 不合法。')
    }
    if (inflight.has(sessionId)) {
      throw new TaskDeleteError(409, 'delete-in-progress', '这个任务正在删除中。')
    }
    inflight.add(sessionId)
    try {
      const result = await deleteTask(ctx, sessionId)
      writeJson(res, 200, { ok: true, ...result })
    } finally {
      inflight.delete(sessionId)
    }
  } catch (error) {
    const status = error instanceof TaskDeleteError ? error.status : 500
    const code = error instanceof TaskDeleteError ? error.code : 'delete-failed'
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof TaskDeleteError)) {
      ctx.logger?.warn?.('dsh-task-delete: deletion failed')
      ctx.logger?.warn?.(error)
    }
    writeJson(res, status, { ok: false, error: { code, message } })
  }
}

/**
 * Erase one Workspace task and its hidden subagent descendants, stopping live
 * work first.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId Root task id.
 * @returns {Promise<Record<string, unknown>>} Deletion report.
 */
async function deleteTask(ctx, sessionId) {
  const persistence = ctx.sessionPersistence
  const snapshots = await persistence.list()
  /** @type {Map<string, any>} */
  const byId = new Map()
  for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot)
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new TaskDeleteError(404, 'not-found', '这个任务不存在，或已经被删除。')
  }
  if (target.header.origin === 'subagent') {
    throw new TaskDeleteError(409, 'subagent-session', '子智能体会话不是工作区任务，不能在这里删除。')
  }

  // Find hidden subagent children. Ordinary forks are separate Workspace tasks
  // and are intentionally NOT deleted with their source.
  /** @type {Map<string, any[]>} */
  const subagentChildren = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (parent === undefined || snapshot.header.origin !== 'subagent') continue
    const key = String(parent)
    const bucket = subagentChildren.get(key)
    if (bucket === undefined) subagentChildren.set(key, [snapshot])
    else bucket.push(snapshot)
  }
  const doomed = []
  const stack = [target]
  while (stack.length > 0) {
    const snapshot = stack.pop()
    doomed.push(snapshot)
    for (const child of subagentChildren.get(String(snapshot.header.id)) ?? []) stack.push(child)
  }
  const removedSessionIds = [...new Set(doomed.map((snapshot) => String(snapshot.header.id)))]

  const home = resolveDshHome()
  const roots = sessionRoots(persistence, home)
  const materializedIds = new Set(doomed.filter((snapshot) => isMaterialized(snapshot)).map((snapshot) => String(snapshot.header.id)))

  // Preflight discovery happens before any side effect: a wrong persistence
  // root must never turn into a silent partial deletion.
  const artifacts = await collectSessionArtifacts({ ids: removedSessionIds, materializedIds, home, roots })

  /** @type {string[]} */
  const warnings = []
  await stopSessionWork(ctx, removedSessionIds, sessionId, warnings)
  const removedReminders = await removeTaskReminders(ctx, removedSessionIds, warnings)

  const removal = await removeCollectedArtifacts({ ...artifacts, ids: removedSessionIds, home, roots, warnings })
  scheduleCacheSweep(home, removedSessionIds)

  // The archive we used as the stop gate is now stale data; drop it so no
  // archived-id residue remains for a session that no longer exists.
  const registry = ctx.get('workspaceRegistry')
  try {
    await registry?.unarchiveSession?.(sessionId)
  } catch (error) {
    warnings.push(`无法清理任务的归档标记：${error instanceof Error ? error.message : String(error)}`)
  }

  for (const id of removedSessionIds) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      warnings.push(`无法通知界面移除任务 ${id}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    sessionId,
    removedSessionIds,
    removedDirectories: removal.removedDirectories.length,
    removedCacheEntries: removal.removedCacheEntries.length,
    removedReminders,
    deferredCleanup: removal.pendingDirs.length + removal.pendingCaches.length > 0,
    warnings,
  }
}

/**
 * Stop every family of live work for the doomed tasks, then wait for the live
 * agents to go idle and flush committed events.
 *
 * The Workspace archive admission is the shipped stop switch: it cancels the
 * running turn, stops owned jobs and subagents, and stops reminders. It also
 * durably gates any late wake-up while the files are being removed. When the
 * task was already archived (no stop dispatch in that path), or no Workspace
 * registry is mounted, the stop event is dispatched directly and each live
 * agent is cancelled explicitly.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {readonly string[]} ids Doomed session ids.
 * @param {string} rootId Root task id.
 * @param {string[]} warnings Warning sink.
 */
async function stopSessionWork(ctx, ids, rootId, warnings) {
  const registry = ctx.get('workspaceRegistry')
  const alreadyArchived = registry !== undefined
    && Array.isArray(registry.archivedSessionIds)
    && registry.archivedSessionIds.includes(rootId)

  let stoppedByArchive = false
  if (registry !== undefined && !alreadyArchived) {
    try {
      await registry.archiveSession(rootId, { stopActivity: true })
      stoppedByArchive = true
    } catch (error) {
      warnings.push(`无法通过归档流程停止任务工作：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!stoppedByArchive) {
    try {
      if (typeof ctx.parallel === 'function') {
        await ctx.parallel('workspace/session-stop', { sessionId: rootId })
      }
    } catch (error) {
      warnings.push(`无法停止任务运行中的工作：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @type {any[]} */
  const agents = []
  for (const id of ids) {
    const agent = ctx.agents.get(id)
    if (agent !== undefined) agents.push(agent)
  }
  for (const agent of agents) {
    try {
      await agent.cancel?.({ kind: 'user' })
    } catch (error) {
      warnings.push(`无法取消任务 ${String(agent.id)} 的运行：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (agents.length > 0) {
    const idle = Promise.all(agents.map(async (agent) => {
      try {
        await agent.whenIdle?.()
      } catch {
        // A concurrent teardown may reject the waiter; the flush below still runs.
      }
    }))
    await Promise.race([idle, delay(STOP_IDLE_TIMEOUT_MS)])
  }

  for (const id of ids) {
    const session = ctx.sessions.get(id)
    if (session === undefined) continue
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      warnings.push(`无法刷新任务 ${id} 的待写事件：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Delete every Automation-tasks reminder bound to the doomed sessions.
 *
 * The Schedule service owns those rows; deleting them through `delete()` also
 * drops their saved delivery records and stops future deliveries. Reminders are
 * removed after the task's work has been stopped (so no delivery is in flight)
 * and before its session log is removed (so the binding is still intact).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {readonly string[]} ids Doomed session ids.
 * @param {string[]} warnings Warning sink.
 * @returns {Promise<number>} Number of reminder rows deleted.
 */
async function removeTaskReminders(ctx, ids, warnings) {
  const schedule = ctx.get('schedule')
  if (schedule === undefined || typeof schedule.catalog !== 'function' || typeof schedule.delete !== 'function') {
    return 0
  }
  let entries
  try {
    entries = await schedule.catalog()
  } catch (error) {
    warnings.push(`无法读取任务的定时提醒：${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
  const targets = new Set(ids)
  const owned = Array.isArray(entries)
    ? entries.filter((entry) => entry !== null && typeof entry === 'object' && targets.has(String(entry.sessionId)))
    : []
  if (owned.length === 0) return 0

  let removed = 0
  for (const entry of owned) {
    try {
      const result = await schedule.delete({ sessionId: entry.sessionId, id: entry.id })
      if (result !== null && typeof result === 'object' && result.deleted === true) {
        removed += 1
      } else {
        warnings.push(`定时提醒 ${String(entry.id)} 未能删除（${result?.code ?? 'unknown'}）。`)
      }
    } catch (error) {
      warnings.push(`删除定时提醒 ${String(entry.id)} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // The Schedule service normally announces its own change; this payload-free
  // invalidation is harmless if it already did and repairs a composition where
  // it did not.
  try {
    ctx.emit('schedule/changed')
  } catch {
    // Best-effort UI refresh only.
  }
  return removed
}

/**
 * Locate the artifacts of the given tasks without changing anything.
 * @param {{ ids: readonly string[], materializedIds: ReadonlySet<string>, home: string, roots: readonly string[] }} input
 * @returns {Promise<{ ids: string[], logDirs: string[], cacheFiles: string[] }>}
 */
export async function collectSessionArtifacts({ ids, materializedIds, home, roots }) {
  const uniqueIds = [...new Set(ids)]
  const logDirs = []
  const missingMaterialized = []
  for (const id of uniqueIds) {
    const dirs = await findSessionDirs(roots, id)
    if (dirs.length === 0 && materializedIds.has(id)) missingMaterialized.push(id)
    logDirs.push(...dirs)
  }
  if (missingMaterialized.length > 0) {
    throw new TaskDeleteError(
      500,
      'session-files-missing',
      `没有找到这些任务的日志目录：${missingMaterialized.join('、')}。为避免误删，操作已取消。`,
    )
  }
  const cacheFiles = await findProjectionCacheFiles(home, uniqueIds)
  return { ids: uniqueIds, logDirs, cacheFiles }
}

/**
 * Remove collected artifacts, retrying transient locks, and journal anything
 * still locked for removal on the next start.
 * @param {{ ids: readonly string[], logDirs: readonly string[], cacheFiles: readonly string[], home: string, roots: readonly string[], warnings: string[] }} input
 * @returns {Promise<{ removedDirectories: string[], removedCacheEntries: string[], pendingDirs: string[], pendingCaches: string[] }>}
 */
export async function removeCollectedArtifacts({ ids, logDirs, cacheFiles, home, roots, warnings }) {
  const removedDirectories = []
  const pendingDirs = []
  for (const dir of logDirs) {
    const outcome = await removeWithRetry(dir)
    if (outcome.ok) removedDirectories.push(dir)
    else {
      pendingDirs.push(dir)
      warnings.push(`任务文件仍被占用，已登记在重启后清理：${dir}（${outcome.message}）`)
    }
  }
  await pruneEmptyProjectDirectories(roots, removedDirectories)

  const removedCacheEntries = []
  const pendingCaches = []
  for (const file of cacheFiles) {
    const outcome = await removeWithRetry(file)
    if (outcome.ok) removedCacheEntries.push(file)
    else {
      pendingCaches.push(file)
      warnings.push(`缓存文件仍被占用，已登记在重启后清理：${file}（${outcome.message}）`)
    }
  }

  if (pendingDirs.length > 0 || pendingCaches.length > 0) {
    try {
      await enqueueJournal(home, { dirs: pendingDirs, caches: pendingCaches, sessionIds: [...ids] })
    } catch (error) {
      warnings.push(`无法写入待清理清单：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { removedDirectories, removedCacheEntries, pendingDirs, pendingCaches }
}

/**
 * Remove one path with bounded retries for transient Windows lock errors.
 * @param {string} target Absolute file or directory path.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function removeWithRetry(target) {
  let lastMessage = 'unknown error'
  for (const wait of REMOVE_RETRY_DELAYS_MS) {
    if (wait > 0) await delay(wait)
    try {
      await rm(target, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, message: lastMessage }
}

/**
 * Locate every on-disk log directory belonging to one session id.
 *
 * The JSONL backend's documented layout is `<root>/<project-dir>/<escaped-id>/`.
 * Generated DSH ids only use path-safe characters, so the directory name equals
 * the id. A flat `<root>/<id>` layout is also accepted.
 *
 * @param {readonly string[]} roots Candidate persistence roots.
 * @param {string} id Session id.
 * @returns {Promise<string[]>} Existing session directories.
 */
export async function findSessionDirs(roots, id) {
  if (!SESSION_ID_PATTERN.test(id)) return []
  const found = new Set()
  for (const root of roots) {
    const absoluteRoot = resolve(root)
    let entries
    try {
      entries = await readdir(absoluteRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === id) {
        found.add(join(absoluteRoot, id))
        continue
      }
      const candidate = join(absoluteRoot, entry.name, id)
      try {
        if ((await stat(candidate)).isDirectory()) found.add(candidate)
      } catch {
        // Not a session directory in this project directory.
      }
    }
  }
  return [...found]
}

/**
 * Find persisted projection-cache records for the given session ids.
 * @param {string} home Resolved DSH home directory.
 * @param {readonly string[]} ids Session ids.
 * @returns {Promise<string[]>} Matching files.
 */
export async function findProjectionCacheFiles(home, ids) {
  const wanted = new Set(ids.map((id) => `${id}.json`))
  const found = []
  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && wanted.has(entry.name)) found.push(full)
    }
  }
  await walk(join(resolve(home), 'storages'), 0)
  return found
}

/**
 * Candidate session-log roots, most specific first.
 * @param {any} persistence Live session-persistence service.
 * @param {string} home Resolved DSH home directory.
 * @returns {string[]} Absolute, de-duplicated roots.
 */
export function sessionRoots(persistence, home) {
  const roots = []
  for (const candidate of [persistence?.config?.root, persistence?.storageRoot, persistence?.root]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') roots.push(resolve(candidate))
  }
  roots.push(join(resolve(home), 'sessions'))
  return [...new Set(roots)]
}

/**
 * Resolve the DSH home directory the same way the launcher does.
 * @returns {string} Absolute home directory.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') return resolve(dirname(profileDir))
  return join(homedir(), '.dsh')
}

/**
 * Whether a persistence snapshot should have a log directory on disk.
 * A created-but-never-appended session may legitimately have no file yet.
 * @param {any} snapshot Persistence snapshot.
 * @returns {boolean} Whether materialized data is expected.
 */
export function isMaterialized(snapshot) {
  return snapshot.formatStatus !== undefined
    || snapshot.sizeBytes !== undefined
    || (snapshot.eventCount ?? 0) > 0
}

/**
 * Remove project directories that became empty after their last task was deleted.
 * @param {readonly string[]} roots Persistence roots.
 * @param {readonly string[]} removedDirectories Removed session directories.
 */
async function pruneEmptyProjectDirectories(roots, removedDirectories) {
  const rootSet = new Set(roots.map((root) => resolve(root)))
  const parents = new Set(removedDirectories.map((dir) => dirname(resolve(dir))))
  for (const parent of parents) {
    if (!rootSet.has(dirname(parent))) continue
    try {
      const remaining = await readdir(parent)
      if (remaining.length === 0) await rmdir(parent)
    } catch {
      // The project directory is shared or already gone; leave it alone.
    }
  }
}

/**
 * Best-effort second cache sweep: a live but quiescent task may flush one last
 * projection checkpoint shortly after the first deletion.
 * @param {string} home Resolved DSH home directory.
 * @param {readonly string[]} ids Session ids.
 */
function scheduleCacheSweep(home, ids) {
  const timer = setTimeout(() => {
    void (async () => {
      for (const file of await findProjectionCacheFiles(home, ids)) {
        try {
          await rm(file, { force: true })
        } catch {
          // The next start's journal sweep or a normal cache rewrite handles it.
        }
      }
    })().catch(() => {})
  }, CACHE_SWEEP_DELAY_MS)
  timer.unref?.()
}

/**
 * Read the deferred-cleanup journal; absent or malformed journals are empty.
 * @param {string} home Resolved DSH home directory.
 * @returns {Promise<{ dirs: string[], caches: string[], sessionIds: string[] }>}
 */
export async function readPendingJournal(home) {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(home), PENDING_JOURNAL_FILE), 'utf8'))
    return {
      dirs: Array.isArray(parsed?.dirs) ? parsed.dirs.filter((value) => typeof value === 'string') : [],
      caches: Array.isArray(parsed?.caches) ? parsed.caches.filter((value) => typeof value === 'string') : [],
      sessionIds: Array.isArray(parsed?.sessionIds) ? parsed.sessionIds.filter((value) => typeof value === 'string') : [],
    }
  } catch {
    return { dirs: [], caches: [], sessionIds: [] }
  }
}

/**
 * Merge one deletion's leftovers into the journal, serialized against other
 * concurrent deletions.
 * @param {string} home Resolved DSH home directory.
 * @param {{ dirs?: readonly string[], caches?: readonly string[], sessionIds?: readonly string[] }} patch New leftovers.
 */
function enqueueJournal(home, patch) {
  const job = journalChain.then(async () => {
    const current = await readPendingJournal(home)
    const next = {
      dirs: [...new Set([...current.dirs, ...(patch.dirs ?? [])])],
      caches: [...new Set([...current.caches, ...(patch.caches ?? [])])],
      sessionIds: [...new Set([...current.sessionIds, ...(patch.sessionIds ?? [])])],
    }
    await writePendingJournal(home, next)
  })
  journalChain = job.catch(() => {})
  return job
}

/**
 * Persist the journal, or remove it when nothing remains.
 * @param {string} home Resolved DSH home directory.
 * @param {{ dirs: readonly string[], caches: readonly string[], sessionIds: readonly string[] }} entries
 */
async function writePendingJournal(home, entries) {
  const journal = join(resolve(home), PENDING_JOURNAL_FILE)
  if (entries.dirs.length === 0 && entries.caches.length === 0) {
    try {
      await rm(journal, { force: true })
    } catch {
      // A leftover empty journal is harmless.
    }
    return
  }
  try {
    await mkdir(resolve(home), { recursive: true })
    const temporary = `${journal}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({
      version: 1,
      dirs: [...entries.dirs],
      caches: [...entries.caches],
      sessionIds: [...entries.sessionIds],
    }))
    await rename(temporary, journal)
  } catch (error) {
    throw new TaskDeleteError(500, 'journal-write-failed', `无法写入待清理清单：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Retry every deferred deletion recorded by an earlier run. Called once the
 * Host has started and no live handle from that earlier deletion can hold the
 * files any more.
 * @param {string} home Resolved DSH home directory.
 * @param {any} registry Live Workspace registry, when mounted.
 * @returns {Promise<{ removed: number, remaining: number }>}
 */
export async function sweepPendingDeletions(home, registry) {
  const pending = await readPendingJournal(home)
  if (pending.dirs.length === 0 && pending.caches.length === 0) {
    return { removed: 0, remaining: 0, sessionIds: pending.sessionIds }
  }
  const remainingDirs = []
  for (const dir of pending.dirs) {
    const outcome = await removeWithRetry(dir)
    if (!outcome.ok) remainingDirs.push(dir)
  }
  const remainingCaches = []
  for (const file of pending.caches) {
    const outcome = await removeWithRetry(file)
    if (!outcome.ok) remainingCaches.push(file)
  }
  await pruneEmptyProjectDirectories([join(resolve(home), 'sessions')], pending.dirs.filter((dir) => !remainingDirs.includes(dir)))
  if (remainingDirs.length === 0) {
    for (const id of pending.sessionIds) {
      try {
        await registry?.unarchiveSession?.(id)
      } catch {
        // The id already holds no live archive record, or the registry is absent.
      }
    }
  }
  await writePendingJournal(home, { dirs: remainingDirs, caches: remainingCaches, sessionIds: pending.sessionIds })
  return {
    removed: (pending.dirs.length - remainingDirs.length) + (pending.caches.length - remainingCaches.length),
    remaining: remainingDirs.length + remainingCaches.length,
    sessionIds: pending.sessionIds,
  }
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {number} limit Byte ceiling.
 * @returns {Promise<string>} UTF-8 body text.
 */
function readJsonBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        rejectBody(new TaskDeleteError(413, 'payload-too-large', '请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/**
 * Write one JSON response, ignoring already-closed sockets.
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON payload.
 */
function writeJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // The peer disconnected before the response; nothing useful to do.
  }
}

/**
 * Small unref'd delay so a pending timer never keeps the process alive.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms)
    timer.unref?.()
  })
}

/** Exposed for unit tests (not part of the plugin API). */
export const __testing = {
  SESSION_ID_PATTERN,
  collectSessionArtifacts,
  deleteTask,
  findProjectionCacheFiles,
  findSessionDirs,
  isMaterialized,
  readPendingJournal,
  removeCollectedArtifacts,
  removeTaskReminders,
  resolveDshHome,
  sessionRoots,
  stopSessionWork,
  sweepPendingDeletions,
}
