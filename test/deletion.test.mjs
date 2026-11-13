// Unit test for dsh-task-delete's deletion pipeline.
// Runs against a throwaway directory tree that mimics <DSH_HOME>.
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import {
  __testing,
  findProjectionCacheFiles,
  findSessionDirs,
  sessionRoots,
} from '../index.js'

const target = 'session-11111111-1111-1111-1111-111111111111'
const child = 'session-22222222-2222-2222-2222-222222222222'
const other = 'session-33333333-3333-3333-3333-333333333333'

const base = join(tmpdir(), `dsh-task-delete-test-${process.pid}`)
const home = join(base, 'home')
const root = join(home, 'sessions')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const journalFile = join(home, 'task-delete-pending.json')

/** Minimal persistence snapshot shape used by the Host half. */
function snapshot(id, extra = {}) {
  return {
    header: { id, version: 4, createdAt: 0, isSeeded: false, ...extra },
    formatStatus: 'current',
    revision: 'test-revision',
    eventCount: 1,
    sizeBytes: 1,
  }
}

/**
 * Minimal Host context for deleteTask orchestration tests.
 * `live` sessions get fake Session objects; `liveAgents` get fake Agent objects.
 * `reminders` are the Schedule catalog rows visible to the fake Schedule service.
 */
function mockContext(snapshots, {
  live = new Set(),
  liveAgents = new Set(),
  archived = [],
  reminders = [],
  withSchedule = true,
} = {}) {
  const emitted = []
  const archiveCalls = []
  const unarchiveCalls = []
  const parallelCalls = []
  const flushCalls = []
  const cancelCalls = []
  const whenIdleCalls = []
  const reminderDeletes = []

  const agents = new Map()
  for (const id of liveAgents) {
    agents.set(id, {
      id,
      cancel(cause) {
        cancelCalls.push([id, cause])
      },
      async whenIdle() {
        whenIdleCalls.push(id)
      },
    })
  }

  const sessions = new Map()
  for (const id of live) {
    sessions.set(id, {
      id,
      async flush() {
        flushCalls.push(id)
        return true
      },
    })
  }

  const registry = {
    archivedSessionIds: [...archived],
    async archiveSession(id, options) {
      archiveCalls.push([id, options])
    },
    async unarchiveSession(id) {
      unarchiveCalls.push(id)
    },
  }

  const schedule = {
    async catalog() {
      return reminders
    },
    async delete(request) {
      reminderDeletes.push(request)
      return { id: request.id, deleted: true }
    },
  }

  return {
    emitted,
    archiveCalls,
    unarchiveCalls,
    parallelCalls,
    flushCalls,
    cancelCalls,
    whenIdleCalls,
    reminderDeletes,
    ctx: {
      sessionPersistence: { list: async () => snapshots, config: { root } },
      sessions: {
        get: (id) => sessions.get(id),
        flush: async (session) => session.flush(),
      },
      agents: { get: (id) => agents.get(id) },
      get: (name) => {
        if (name === 'workspaceRegistry') return registry
        if (name === 'schedule') return withSchedule ? schedule : undefined
        return undefined
      },
      async parallel(name, request) {
        parallelCalls.push([name, request])
      },
      emit: (name, args) => {
        emitted.push(args === undefined ? [name] : [name, args])
      },
      logger: { warn() {} },
    },
  }
}

async function writeArtifacts(id, project) {
  await mkdir(join(root, project, id), { recursive: true })
  await writeFile(join(root, project, id, 'session.v4.jsonl.zstd'), `log-${id}`)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${id}.json`), '{"record":true}')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  await mkdir(join(root, 'proj-a', target), { recursive: true })
  await mkdir(join(root, 'proj-b', child), { recursive: true })
  await mkdir(join(root, 'proj-b', other), { recursive: true })
  await writeFile(join(root, 'proj-a', target, 'session.v4.jsonl.zstd'), 'target-log')
  await writeFile(join(root, 'proj-b', child, 'session.v4.jsonl.zstd'), 'child-log')
  await writeFile(join(root, 'proj-b', other, 'session.v4.jsonl.zstd'), 'other-log')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${target}.json`), '{"record":1}')
  await writeFile(join(cacheDir, `${child}.json`), '{"record":2}')
  await writeFile(join(cacheDir, `${other}.json`), '{"record":3}')
  await writeFile(join(home, 'storages', 'workspace.json'), '{"unit":{"name":"workspace"}}')

  // Discovery works for the nested project layout.
  const dirs = await findSessionDirs([root], target)
  assert.equal(dirs.length, 1, 'finds the nested session directory')
  assert.equal(dirs[0], join(root, 'proj-a', target))

  // Discovery stays id-safe.
  assert.deepEqual(await findSessionDirs([root], '../proj-a'), [])

  const caches = await findProjectionCacheFiles(home, [target, child])
  assert.equal(caches.length, 2, 'finds projection-cache records')

  // Root preference: configured root first, then the DSH_HOME fallback.
  const roots = sessionRoots({ config: { root: root } }, home)
  assert.equal(roots[0], root)
  assert.ok(roots.includes(join(home, 'sessions')))

  // ---- collect + remove low-level pipeline ----
  const collected = await __testing.collectSessionArtifacts({
    ids: [target, child],
    materializedIds: new Set([target, child]),
    home,
    roots,
  })
  assert.equal(collected.logDirs.length, 2)
  assert.equal(collected.cacheFiles.length, 2)

  const warnings = []
  const removal = await __testing.removeCollectedArtifacts({
    ...collected,
    ids: [target, child],
    home,
    roots,
    warnings,
  })
  assert.deepEqual(warnings, [])
  assert.equal(removal.removedDirectories.length, 2)
  assert.equal(removal.removedCacheEntries.length, 2)
  assert.deepEqual(removal.pendingDirs, [])

  assert.equal(await exists(join(root, 'proj-a', target)), false)
  assert.equal(await exists(join(root, 'proj-b', child)), false)
  assert.equal(await exists(join(cacheDir, `${target}.json`)), false)
  assert.equal(await exists(join(root, 'proj-b', other)), true, 'unrelated session survives')
  assert.equal(await exists(join(root, 'proj-b', other, 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(join(root, 'proj-a')), false, 'emptied project directory is pruned')
  assert.equal((await readFile(join(home, 'storages', 'workspace.json'), 'utf8')).includes('workspace'), true)
  assert.equal(await exists(journalFile), false, 'no journal for a fully successful removal')

  // A materialized task with no discoverable log refuses the whole operation.
  await assert.rejects(
    __testing.collectSessionArtifacts({
      ids: ['session-44444444-4444-4444-4444-444444444444'],
      materializedIds: new Set(['session-44444444-4444-4444-4444-444444444444']),
      home,
      roots,
    }),
    (error) => error.code === 'session-files-missing',
  )

  // An unmaterialized task (blank session) is a successful no-op.
  const blank = await __testing.collectSessionArtifacts({
    ids: ['session-55555555-5555-5555-5555-555555555555'],
    materializedIds: new Set(),
    home,
    roots,
  })
  assert.equal(blank.logDirs.length, 0)
  assert.equal(blank.cacheFiles.length, 0)

  // ---- full deleteTask orchestration with a mocked Host context ----
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const rootId = 'session-66666666-6666-6666-6666-666666666666'
    const childId = 'session-77777777-7777-7777-7777-777777777777'
    const otherId = 'session-88888888-8888-8888-8888-888888888888'
    await writeArtifacts(rootId, 'proj-c')
    await writeArtifacts(childId, 'proj-d')
    await writeArtifacts(otherId, 'proj-d')
    const snapshots = [
      snapshot(rootId),
      snapshot(childId, { parentSession: rootId, origin: 'subagent' }),
      snapshot(otherId),
    ]
    const reminders = [
      { id: 'schedule-1', sessionId: rootId, title: 'root reminder', status: 'active' },
      { id: 'schedule-2', sessionId: childId, title: 'child reminder', status: 'inactive' },
      { id: 'schedule-3', sessionId: otherId, title: 'unrelated reminder', status: 'active' },
    ]
    const normal = mockContext(snapshots, { reminders })
    const report = await __testing.deleteTask(normal.ctx, rootId)
    assert.deepEqual(report.removedSessionIds.sort(), [rootId, childId].sort(), 'deletes the task and hidden subagent children')
    assert.equal(report.removedReminders, 2, 'deletes the task reminders and hidden-child reminders only')
    assert.deepEqual(normal.reminderDeletes, [
      { sessionId: rootId, id: 'schedule-1' },
      { sessionId: childId, id: 'schedule-2' },
    ])
    assert.deepEqual(normal.emitted, [
      ['schedule/changed'],
      ['api-session/removed', rootId],
      ['api-session/removed', childId],
    ])
    assert.deepEqual(normal.archiveCalls, [[rootId, { stopActivity: true }]], 'stops work through archive admission')
    assert.deepEqual(normal.unarchiveCalls, [rootId], 'cleans the archive marker it wrote')
    assert.equal(await exists(join(root, 'proj-c', rootId)), false)
    assert.equal(await exists(join(root, 'proj-d', childId)), false)
    assert.equal(await exists(join(root, 'proj-d', otherId)), true, 'other task survives')

    // The Schedule service is optional: deleting a task works without it.
    const noSchedule = mockContext([snapshot(otherId)], { withSchedule: false })
    const noScheduleWarnings = []
    assert.equal(await __testing.removeTaskReminders(noSchedule.ctx, [otherId], noScheduleWarnings), 0)
    assert.deepEqual(noScheduleWarnings, [])

    // A running/open task is stopped, deleted, and removed from the UI.
    const liveId = 'session-99999999-9999-9999-9999-999999999999'
    await writeArtifacts(liveId, 'proj-e')
    const live = mockContext([snapshot(liveId)], {
      live: new Set([liveId]),
      liveAgents: new Set([liveId]),
      reminders: [{ id: 'schedule-live', sessionId: liveId, title: 'live reminder', status: 'active' }],
    })
    const liveReport = await __testing.deleteTask(live.ctx, liveId)
    assert.equal(await exists(join(root, 'proj-e', liveId)), false, 'running task is deleted')
    assert.equal(await exists(join(cacheDir, `${liveId}.json`)), false, 'running task cache is deleted')
    assert.deepEqual(live.cancelCalls, [[liveId, { kind: 'user' }]], 'cancels the running turn')
    assert.deepEqual(live.whenIdleCalls, [liveId], 'waits for the live agent to settle')
    assert.deepEqual(live.flushCalls, [liveId], 'flushes committed events before deleting')
    assert.equal(liveReport.removedReminders, 1)
    assert.deepEqual(live.reminderDeletes, [{ sessionId: liveId, id: 'schedule-live' }])
    assert.deepEqual(live.emitted, [
      ['schedule/changed'],
      ['api-session/removed', liveId],
    ])
    assert.equal(liveReport.removedSessionIds[0], liveId)

    // An already-archived running task skips the archive path but still stops
    // through the raw stop event and direct cancel.
    const archivedId = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc'
    await writeArtifacts(archivedId, 'proj-f')
    const archived = mockContext([snapshot(archivedId)], {
      liveAgents: new Set([archivedId]),
      archived: [archivedId],
    })
    await __testing.deleteTask(archived.ctx, archivedId)
    assert.deepEqual(archived.archiveCalls, [], 'does not re-archive an archived task')
    assert.deepEqual(archived.parallelCalls, [['workspace/session-stop', { sessionId: archivedId }]])
    assert.deepEqual(archived.cancelCalls.map(([id]) => id), [archivedId])
    assert.equal(await exists(join(root, 'proj-f', archivedId)), false)

    // Unknown task refusal.
    const missing = mockContext([snapshot(otherId)])
    await assert.rejects(
      __testing.deleteTask(missing.ctx, 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      (error) => error.code === 'not-found',
    )

    // A hidden subagent session cannot be the deletion root.
    const childRoot = mockContext([snapshot(childId, { parentSession: rootId, origin: 'subagent' })])
    await assert.rejects(
      __testing.deleteTask(childRoot.ctx, childId),
      (error) => error.code === 'subagent-session',
    )

    // A materialized task with no log directory refuses before stopping work.
    const ghostId = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const ghost = mockContext([snapshot(ghostId)])
    await assert.rejects(
      __testing.deleteTask(ghost.ctx, ghostId),
      (error) => error.code === 'session-files-missing',
    )
    assert.deepEqual(ghost.archiveCalls, [], 'preflight failure does not stop or archive anything')
    assert.deepEqual(ghost.reminderDeletes, [], 'preflight failure does not delete reminders')

    // ---- deferred-cleanup journal sweep ----
    const pendingId = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd'
    await writeArtifacts(pendingId, 'proj-g')
    await writeFile(journalFile, JSON.stringify({
      version: 1,
      dirs: [join(root, 'proj-g', pendingId)],
      caches: [join(cacheDir, `${pendingId}.json`)],
      sessionIds: [pendingId],
    }))
    const sweepRegistry = { unarchiveCalls: [], async unarchiveSession(id) { this.unarchiveCalls.push(id) } }
    const swept = await __testing.sweepPendingDeletions(home, sweepRegistry)
    assert.equal(swept.remaining, 0)
    assert.equal(await exists(join(root, 'proj-g', pendingId)), false)
    assert.equal(await exists(join(cacheDir, `${pendingId}.json`)), false)
    assert.equal(await exists(journalFile), false)
    assert.deepEqual(sweepRegistry.unarchiveCalls, [pendingId])
    assert.deepEqual(await __testing.readPendingJournal(home), { dirs: [], caches: [], sessionIds: [] })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  // ---- orphaned attachment collection ----
  function attachmentEvent(id) {
    return {
      type: 'user/message',
      data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${id}` } }] },
    }
  }

  function fileAttachmentEvent(id) {
    return {
      type: 'tool/result',
      data: { content: [{ type: 'file', attachment: { attachmentId: id, name: 'notes.txt' } }] },
    }
  }

  function fakePersistence(sessions) {
    return {
      async list() {
        return Object.keys(sessions).map((id) => ({ header: { id } }))
      },
      async stat(id) {
        const entry = sessions[id]
        return entry === undefined ? undefined : { revision: entry.revision }
      },
      async open(id) {
        const entry = sessions[id]
        if (entry === undefined) throw new Error(`missing session ${id}`)
        return {
          async read(offset = 0, length = 500) {
            return { events: entry.events.slice(offset, offset + length) }
          },
          async close() {},
        }
      },
    }
  }

  const orphanImage = 'a'.repeat(64)
  const sharedImage = 'b'.repeat(64)
  const orphanFile = 'c'.repeat(64)
  const attachmentsRoot = join(home, 'attachments', 'v1')
  await mkdir(join(attachmentsRoot, 'objects', 'aa'), { recursive: true })
  await writeFile(join(attachmentsRoot, 'objects', 'aa', orphanImage), 'orphan-image')
  await mkdir(join(attachmentsRoot, 'objects', 'bb'), { recursive: true })
  await writeFile(join(attachmentsRoot, 'objects', 'bb', sharedImage), 'shared-image')
  await mkdir(join(attachmentsRoot, 'file-objects', 'cc'), { recursive: true })
  await writeFile(join(attachmentsRoot, 'file-objects', 'cc', orphanFile), 'orphan-file')
  await mkdir(join(attachmentsRoot, 'files', 'cc', orphanFile), { recursive: true })
  await writeFile(join(attachmentsRoot, 'files', 'cc', orphanFile, 'notes.txt'), 'orphan-link')

  const collectPersistence = fakePersistence({
    deleted: {
      revision: '1',
      events: [attachmentEvent(orphanImage), attachmentEvent(sharedImage), fileAttachmentEvent(orphanFile)],
    },
    remaining: { revision: '2', events: [attachmentEvent(sharedImage)] },
  })
  const candidates = await __testing.collectAttachmentIdsFromSessions(collectPersistence, ['deleted'], [])
  assert.deepEqual([...candidates].sort(), [orphanImage, sharedImage, orphanFile].sort())

  const remainingPersistence = fakePersistence({
    remaining: { revision: '2', events: [attachmentEvent(sharedImage)] },
  })
  const attachmentWarnings = []
  const cleanup = await __testing.cleanupOrphanAttachments({
    persistence: remainingPersistence,
    candidates,
    home,
    warnings: attachmentWarnings,
  })
  assert.deepEqual(attachmentWarnings, [])
  assert.equal(cleanup.removed, 2)
  assert.equal(cleanup.kept, 1)
  assert.equal(cleanup.skipped, false)
  assert.equal(await exists(join(attachmentsRoot, 'objects', 'aa', orphanImage)), false, 'unreferenced image object is deleted')
  assert.equal(await exists(join(attachmentsRoot, 'objects', 'bb', sharedImage)), true, 'attachment still referenced by another task is kept')
  assert.equal(await exists(join(attachmentsRoot, 'file-objects', 'cc', orphanFile)), false, 'unreferenced file object is deleted')
  assert.equal(await exists(join(attachmentsRoot, 'files', 'cc', orphanFile)), false, 'unreferenced hard-link directory is deleted')
  assert.equal(await exists(join(attachmentsRoot, 'objects', 'aa')), false, 'emptied attachment shard is pruned')

  // A remaining session that changes during the scan aborts the cleanup.
  const unstableCandidate = 'd'.repeat(64)
  await mkdir(join(attachmentsRoot, 'objects', 'dd'), { recursive: true })
  await writeFile(join(attachmentsRoot, 'objects', 'dd', unstableCandidate), 'unstable-image')
  let statCalls = 0
  const unstablePersistence = {
    async list() {
      return [{ header: { id: 'busy' } }]
    },
    async stat() {
      statCalls += 1
      return { revision: String(statCalls) }
    },
    async open() {
      return {
        async read() {
          return { events: [] }
        },
        async close() {},
      }
    },
  }
  const unstableWarnings = []
  const unstable = await __testing.cleanupOrphanAttachments({
    persistence: unstablePersistence,
    candidates: new Set([unstableCandidate]),
    home,
    warnings: unstableWarnings,
  })
  assert.equal(unstable.skipped, true, 'unstable revision aborts attachment cleanup')
  assert.equal(unstable.removed, 0)
  assert.equal(await exists(join(attachmentsRoot, 'objects', 'dd', unstableCandidate)), true, 'no attachment is deleted when the scan is unsafe')
  assert.equal(unstableWarnings.length, 1)

  console.log('dsh-task-delete deletion tests: OK')
}

try {
  await main()
} finally {
  await rm(base, { recursive: true, force: true })
}
