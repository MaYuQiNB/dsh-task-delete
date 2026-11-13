/**
 * Client half of the `dsh-task-delete` bundle.
 *
 * Adds one row to every Workspace task's "..." menu
 * (`sidebar.workspaces.session.menu.item`) and one frame-wide confirmation
 * dialog (`shell.overlay`). Confirming POSTs to the Host half's local route,
 * which erases the task's session logs and projection cache from disk and then
 * announces the removal to the Web UI.
 *
 * Deliberately imports no Harness Client package: React is the only module, and
 * visible state uses the slot hooks the owner passes in.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'task-delete'
    const DELETE_ROUTE = '/task-delete/delete'
    const STYLE_TAG_ID = 'dsh-task-delete-styles'

    const zh = {
      'menu.deleteTask': '删除任务',
      'dialog.title': '彻底删除这个任务？',
      'dialog.untitled': '未命名任务',
      'dialog.description': '“{title}”的会话记录、本地日志与缓存将从这台电脑上永久删除。',
      'dialog.irreversible': '此操作不可撤销，删除后无法恢复。',
      'dialog.stopWarning': '该任务正在运行或打开。继续删除会先停止它的工作，再从本机移除记录。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '正在停止并删除…',
      'dialog.failed': '删除失败：{message}',
    }

    const en = {
      'menu.deleteTask': 'Delete task',
      'dialog.title': 'Delete this task permanently?',
      'dialog.untitled': 'Untitled task',
      'dialog.description': 'The conversation, local logs, and cache of “{title}” will be permanently deleted from this computer.',
      'dialog.irreversible': 'This cannot be undone.',
      'dialog.stopWarning': 'This task is running or open. Deleting it first stops its work, then removes the local records.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Stopping and deleting…',
      'dialog.failed': 'Delete failed: {message}',
    }

    const CSS = [
      '.dsh-task-delete-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1);border:0;}',
      '.dsh-task-delete-menu-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;margin:0;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;appearance:none;}',
      '.dsh-task-delete-menu-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}',
      '.dsh-task-delete-menu-row:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary);}',
      '.dsh-task-delete-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);}',
      '.dsh-task-delete-dialog{box-sizing:border-box;width:min(440px,100%);padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px color-mix(in srgb,#000 28%,transparent);}',
      '.dsh-task-delete-title{font-size:15px;font-weight:600;line-height:22px;}',
      '.dsh-task-delete-body{margin-top:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-task-delete-body p{margin:0 0 8px;}',
      '.dsh-task-delete-body p:last-child{margin-bottom:0;}',
      '.dsh-task-delete-warning{color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-task-delete-error{color:var(--dsw-alias-state-error-primary);word-break:break-word;}',
      '.dsh-task-delete-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}',
      '.dsh-task-delete-btn{box-sizing:border-box;height:32px;padding:0 14px;border:1px solid transparent;border-radius:6px;font:inherit;font-size:13px;line-height:30px;cursor:pointer;appearance:none;}',
      '.dsh-task-delete-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay),0 0 0 4px var(--dsw-alias-brand-primary);}',
      '.dsh-task-delete-btn:disabled{cursor:default;opacity:.6;}',
      '.dsh-task-delete-btn-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);}',
      '.dsh-task-delete-btn-secondary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}',
      '.dsh-task-delete-btn-danger{background:var(--dsw-alias-state-error-primary);color:#fff;}',
      '.dsh-task-delete-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 86%,#000);}',
    ].join('\n')

    /** Small observable snapshot store for the pending delete request. */
    function createSnapshotStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function TrashIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        style: { flex: 'none' },
      }, h('path', {
        fill: 'currentColor',
        d: 'M6.5 2A1.5 1.5 0 0 0 5 3.5V5H2.5a.75.75 0 0 0 0 1.5h.62l.63 7.02A2 2 0 0 0 5.74 15.5h4.52a2 2 0 0 0 1.99-1.98l.63-7.02h.62a.75.75 0 0 0 0-1.5H11V3.5A1.5 1.5 0 0 0 9.5 2h-3Zm3 3V3.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5V5h4ZM4.66 6.5h6.68l-.62 6.97a.5.5 0 0 1-.5.53H5.78a.5.5 0 0 1-.5-.53L4.66 6.5Zm1.59 1.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V8.5a.75.75 0 0 1 .75-.75Zm3.5 0a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V8.5a.75.75 0 0 1 .75-.75Z',
      }))
    }

    /**
     * One row of a task's "..." menu.
     * @param {object} props Slot props: row identity, menu open state, injected request, locale.
     */
    function DeleteTaskMenuItem({ displayTitle, sessionId, useMenuOpenState, requestTaskDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(React.Fragment, null,
        h('div', { className: 'dsh-task-delete-menu-sep', role: 'presentation' }),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: 'dsh-task-delete-menu-row',
          title: t('menu.deleteTask'),
          onClick: () => {
            setMenuOpen(false)
            requestTaskDelete({ sessionId, displayTitle })
          },
        }, h(TrashIcon), h('span', null, t('menu.deleteTask'))),
      )
    }

    /**
     * Frame-wide dialog shell; renders only while a delete was requested.
     * @param {object} props Deletion request source and actions.
     */
    function DeleteTaskDialog({ useTaskDeleteRequest, settleTaskDelete, performTaskDelete, isSessionOpen, leaveDeletedSession, t }) {
      const request = useTaskDeleteRequest((pending) => pending)
      if (request === null) return null
      return h(DeleteTaskDialogBody, {
        key: `${request.sessionId}:${request.seq}`,
        request,
        settleTaskDelete,
        performTaskDelete,
        isSessionOpen,
        leaveDeletedSession,
        t,
      })
    }

    /**
     * One confirmation dialog; remounted per request so in-flight state is fresh.
     * @param {object} props Request, settlement, Host call, live-state probe, locale.
     */
    function DeleteTaskDialogBody({ request, settleTaskDelete, performTaskDelete, isSessionOpen, leaveDeletedSession, t }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const dialogRef = React.useRef(null)
      const confirmRef = React.useRef(null)
      const open = isSessionOpen(request.sessionId)

      React.useEffect(() => {
        if (confirmRef.current !== null && typeof confirmRef.current.focus === 'function') {
          confirmRef.current.focus()
        }
      }, [])

      React.useEffect(() => {
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.body.style.overflow = previous
        }
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            if (busy) return
            event.preventDefault()
            event.stopPropagation()
            settleTaskDelete()
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const nodes = [...dialogRef.current.querySelectorAll('button:not([disabled])')]
          if (nodes.length === 0) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [busy, settleTaskDelete])

      const dismiss = () => {
        if (busy) return
        settleTaskDelete()
      }

      const confirm = async () => {
        if (busy) return
        const wasOpen = isSessionOpen(request.sessionId)
        setBusy(true)
        setError(null)
        const outcome = await performTaskDelete(request.sessionId)
        if (outcome.ok) {
          if (wasOpen) leaveDeletedSession(request.sessionId)
          settleTaskDelete()
          return
        }
        setError(t('dialog.failed', { message: outcome.message }))
        setBusy(false)
      }

      return h('div', {
        className: 'dsh-task-delete-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) dismiss()
        },
      }, h('div', {
        ref: dialogRef,
        className: 'dsh-task-delete-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsh-task-delete-title',
        onMouseDown: (event) => {
          event.stopPropagation()
        },
      },
      h('div', { className: 'dsh-task-delete-title', id: 'dsh-task-delete-title' }, t('dialog.title')),
      h('div', { className: 'dsh-task-delete-body' },
        h('p', null, t('dialog.description', { title: request.displayTitle || t('dialog.untitled') })),
        h('p', { className: 'dsh-task-delete-warning' }, t('dialog.irreversible')),
        open ? h('p', { className: 'dsh-task-delete-warning' }, t('dialog.stopWarning')) : null,
        error === null ? null : h('p', { className: 'dsh-task-delete-error', role: 'alert' }, error),
      ),
      h('div', { className: 'dsh-task-delete-actions' },
        h('button', {
          type: 'button',
          className: 'dsh-task-delete-btn dsh-task-delete-btn-secondary',
          disabled: busy,
          onClick: dismiss,
        }, t('dialog.cancel')),
        h('button', {
          ref: confirmRef,
          type: 'button',
          className: 'dsh-task-delete-btn dsh-task-delete-btn-danger',
          disabled: busy,
          onClick: () => {
            void confirm()
          },
        }, busy ? t('dialog.deleting') : t('dialog.confirm')),
      )))
    }

    /**
     * Install the menu row, the confirmation dialog, and their state.
     * @param {import('@deepseek-ai/cordis').Context} ctx Client plugin context.
     */
    function apply(ctx) {
      const requestStore = createSnapshotStore(null)
      let requestSeq = 0

      const requestTaskDelete = ({ sessionId, displayTitle }) => {
        requestSeq += 1
        requestStore.set({ sessionId, displayTitle, seq: requestSeq })
      }
      const settleTaskDelete = () => {
        requestStore.set(null)
      }
      const isSessionOpen = (sessionId) => {
        try {
          const list = ctx.sessions.list.getSnapshot()
          const row = list.byId[sessionId]
          return row !== undefined && (row.retainedBy?.mainView ?? 0) > 0
        } catch {
          return false
        }
      }
      // Deleting the task shown in the main view leaves that view bound to a
      // session the Host has removed; open a fresh New Session instead.
      const leaveDeletedSession = (_sessionId) => {
        try {
          ctx.uiWorkspace.startSession()
        } catch (error) {
          console.warn('dsh-task-delete: could not open a new session after deleting the current task:', error)
        }
      }
      const performTaskDelete = async (sessionId) => {
        try {
          const response = await fetch(DELETE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => null)
          if (response.ok && payload !== null && payload.ok === true) return { ok: true }
          const message = payload !== null && payload.error !== undefined && typeof payload.error.message === 'string'
            ? payload.error.message
            : `HTTP ${response.status}`
          return { ok: false, message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-task-delete: dictionaries')
      ctx.effect(() => {
        document.getElementById(STYLE_TAG_ID)?.remove()
        const tag = document.createElement('style')
        tag.id = STYLE_TAG_ID
        tag.dataset.plugin = 'dsh-task-delete'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'dsh-task-delete: styles')

      // `inject` waits for the owner declaration so this row also appears when
      // the Workspace browser mounts after us or is later restored.
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'task-delete.delete',
        order: 500,
        locale: NS,
        inject: () => ({ requestTaskDelete }),
      }, DeleteTaskMenuItem))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'task-delete.dialog',
        locale: NS,
        inject: () => ({
          hooks: { taskDeleteRequest: requestStore },
          settleTaskDelete,
          performTaskDelete,
          isSessionOpen,
          leaveDeletedSession,
        }),
      }, DeleteTaskDialog))
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply,
    }
  },
})
