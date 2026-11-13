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
   including their saved delivery records, removed through the Schedule service;
5. attachment objects (image objects, generic file objects, and their hard-link
   directories) that are referenced only by this task. Every remaining session
   log is scanned first; anything still referenced by another task stays;
6. this task's memories in the optional Memory Brain plugin, plus semantic
   memories whose every source episode belongs to this task. The Client half
   calls Memory Brain's own endpoint after the deletion succeeds.

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
4. Delete every reminder bound to the task through the Schedule service, which
   also drops the saved delivery records and refreshes the Automation tasks UI.
5. Delete the log directories and cache records.
6. Scan every remaining session log and delete only attachment objects that no
   remaining task references.
7. Clear the temporary archive marker and broadcast `api-session/removed`. The
   Client half then asks Memory Brain to forget this task's memories.
8. If a file is still briefly locked by the live process, deletion is retried;
   anything still locked is journaled in
   `<DSH_HOME>/task-delete-pending.json` and removed by the next plugin start.

## Safety boundaries

- Attachment objects are deleted only after every remaining session log has been
  scanned and none references them; shared attachments stay. Pure caches such as
  request-image transforms are left in place.
- Memory Brain cleanup removes only episodes owned by this task and semantic
  memories whose members all came from it; mixed-knowledge semantic memories
  stay. It is skipped when Memory Brain is not installed.
- The Workspace itself is not deleted. Stale task ids left in workspace order
  records are invisible and never recreate the task.
- Scheduled reminders created from the task are deleted with it, including
  their delivery records; nothing remains in Automation tasks.
- Deletion is hard and irreversible. There is no undo.

## Known limitations

- Orphan-attachment cleanup is safety-first best effort: if a remaining session
  is still being written (or cannot be read) during the scan, cleanup is skipped
  with a warning instead of risking removal of a still-referenced object.
- Memory Brain cleanup is initiated by the Client half right after a successful
  deletion; if its endpoint is unavailable at that moment, memories may remain
  and can be forgotten manually in the Memory Brain panel.
- If a file is still briefly locked by the live process, file deletion may be
  deferred to the next start (the UI and persisted list drop it immediately).
- Other-task messages that referenced the deleted task become unreadable old
  references; they stay inside those tasks' logs.

## Development

The package is plain ESM: no build step. Run the deletion-pipeline tests with
Node 22+:

```sh
npm test
```

- `index.js` — Host half: authenticated local route, artifact discovery,
  stop/flush pipeline, reminder deletion, orphan-attachment scan/removal,
  retries, deferred cleanup journal, UI removal event.
- `client.js` — Client half: registers the `sidebar.workspaces.session.menu.item`
  row and the `shell.overlay` confirmation dialog, then asks Memory Brain to
  forget the deleted task's memories. It uses React and theme tokens only and
  imports no Harness Client package.
- `locale/*.json`, `icon.svg` — plugin manager display metadata and artwork.

## License

MIT — see [LICENSE](LICENSE).
