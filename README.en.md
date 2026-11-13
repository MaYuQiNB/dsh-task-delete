# dsh-task-delete · Task Delete

English | [中文](README.md)

Adds a **permanent delete** action to every Workspace task (session) in the DSH
Web sidebar.

- Hover a task row and click its `...` menu.
- The menu gains a **Delete task** row at the end.
- Confirm, and the task and its scheduled reminders are removed from this computer.

**A running or currently open task can be deleted too.** Confirming stops its
work first, then removes the local records.

## Install

This repository is a DSH bundle with both halves (Host route + Client UI).

From the DSH **Plugins** page, choose add/install and paste this repository URL:

```text
https://github.com/MaYuQiNB/dsh-task-delete
```

Or with the CLI:

```sh
dsh plugin --profile <profile> add https://github.com/MaYuQiNB/dsh-task-delete
```

The plugin appears as **Task Delete** in the plugin list. It targets the Web GUI
surface of DSH 0.2.x profiles (`desktop` / `web`).

## What is deleted

1. `<DSH_HOME>/sessions/<project-dir>/<task-id>/` — the session log directory,
   all format generations included;
2. the task's persisted projection-cache record under `<DSH_HOME>/storages/`;
3. hidden subagent child session logs owned by the task;
4. every Automation-tasks reminder bound to the task or its hidden children —
   including their saved delivery records, removed through the Schedule service.

The sidebar row disappears immediately. If the deleted task was the one shown
in the main view, the view switches to a fresh New Session.

## How deletion works for a live task

1. Stop the task's work through the Workspace archive admission
   (`stopActivity`): the running turn, owned background jobs, running
   subagents, and active reminders.
2. Explicitly cancel the live agent, wait for it to go idle, and flush
   committed events.
3. Delete every reminder bound to the task through the Schedule service, which
   also drops the saved delivery records and refreshes the Automation tasks UI.
4. Delete the log directories and cache records.
5. Clear the temporary archive marker and broadcast `api-session/removed`.
6. If a file is still briefly locked by the live process, deletion is retried;
   anything still locked is journaled in
   `<DSH_HOME>/task-delete-pending.json` and removed by the next plugin start.

## Safety boundaries

- Shared attachment objects are **not** deleted (content-addressed, possibly
  referenced by other tasks).
- The Workspace itself is not deleted. Stale task ids left in workspace order
  records are invisible and never recreate the task.
- Scheduled reminders created from the task are deleted with it, including
  their delivery records; nothing remains in Automation tasks.
- Deletion is hard and irreversible. There is no undo.

## Development

The package is plain ESM: no build step. Run the deletion-pipeline tests with
Node 22+:

```sh
npm test
```

- `index.js` — Host half: authenticated local route, artifact discovery,
  stop/flush pipeline, reminder deletion, deletion, retries, deferred cleanup
  journal, UI removal event.
- `client.js` — Client half: registers the `sidebar.workspaces.session.menu.item`
  row and the `shell.overlay` confirmation dialog. It uses React and theme
  tokens only and imports no Harness Client package.
- `locale/*.json`, `icon.svg` — plugin manager display metadata and artwork.

## License

MIT — see [LICENSE](LICENSE).
