---
name: easyeda-cli
description: >-
  Drive the EasyEDA Pro / JLCEDA Pro (嘉立创EDA专业版) desktop client through its
  built-in command-line client. Use when asked to operate the editor from a
  terminal or script: detect the installed client and its edition (Windows,
  macOS or Linux; mainland lceda-pro or international easyeda-pro), draw
  schematics/PCB programmatically, create or modify .eprj3 projects, export
  netlist/BOM/Gerber/STEP/screenshot, or query the editor API and design-file
  format via the `doc` command family.
  Trigger on: "easyeda-pro", "lceda-pro", "EasyEDA CLI", "EDA CLI",
  "命令行操作嘉立创EDA", "命令行驱动EDA", "CLI".
  This skill may lag behind API changes; always confirm current usage via the
  installed client's `--help` and `doc` output.
  Scope: THIS skill = driving the editor via the CLI executable.
  In-editor JS / extension development / WebSocket bridge → easyeda-api skill;
  offline .eprj3 construction without the client → easyeda-eprj3 skill;
  generating EasyEDA format data → easyeda-format skill.
---

# EasyEDA Pro CLI (Command-Line Client)

This skill teaches an AI agent to drive the EasyEDA Pro (JLCEDA Pro,
嘉立创EDA专业版) desktop client through its built-in command-line client.
**Command names, options, and APIs change between client versions.** The
authoritative source is always the `--help` output and the built-in `doc`
command family of the installed version — never memory or older documentation.

> **Declaration: this skill may lag behind the API.**
> The CLI and the extension API evolve continuously. This document is a
> workflow guide, not an API reference. Before using any command, option, API
> method, enum, or design-file field, query the installed client itself:
>
> - `lceda-pro --help` and `lceda-pro <command> --help`
> - `lceda-pro doc api ...` and `lceda-pro doc format ...`
> - `lceda-pro doctor` for the running bridge version and connection state
>
> If this document conflicts with the installed version's help or `doc` output,
> **the installed output wins**. Treat every example here as an illustration,
> not as a stable API contract. Never copy a signature from this file without
> re-checking it against the running client.
>
> **Design-file formats are version-bound too.** Online documentation and
> examples in this skill may lag behind releases. Before reading or writing
> `.esch2` / `.epcb2` / `.epan2` records, query the installed client with
> `lceda-pro doc format` (and `--class-name <type>`); that output is the only
> authority.

## Step 0: Detect the installation (required at the start of every session)

Do not assume the installation path (never hardcode `C:\Program Files\lceda-pro`),
and do not assume the command is on `PATH`. First run the read-only detector
shipped with this skill:

```bash
# Windows Git Bash / WSL / MSYS2, macOS, Linux (recommended)
bash <skill-dir>/scripts/detect-easyeda-cli.sh
```

```powershell
# Native Windows PowerShell (when Git Bash is unavailable)
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\detect-easyeda-cli.ps1"
```

`<skill-dir>` is the directory containing `SKILL.md`. The default install
location is `~/.claude/skills/easyeda-cli` (Windows:
`C:\Users\<user>\.claude\skills\easyeda-cli`).

The detector is read-only: it does not install, launch, or close the editor; it
only inspects files and runs `--help`. It prints JSON by default; add `--text`
for a human-readable summary. Options:

| Option | Purpose |
| --- | --- |
| `--text` | Human-readable summary (JSON is the default) |
| `--no-probe` | Do not run `--help`; rely on paths and the `version` file only |
| `--doctor` | Also run `doctor` to probe the running editor bridge |
| `--timeout <seconds>` | Per-probe timeout; default 20 |

### Result fields

| Field | Meaning |
| --- | --- |
| `ok` | Whether an installation was found; never pretend the CLI is usable when `false` |
| `distribution` | Distribution: `lceda-pro` (mainland China) or `easyeda-pro` (international) |
| `edition` | `mainland` / `international` |
| `product` | Product name: `JLCEDA Pro` / `EasyEDA Pro` |
| `installDir` | Installation directory (forward slashes; safe for path joins) |
| `executable` | Full path to the directly executable binary |
| `command` | Command name (`lceda-pro` / `easyeda-pro`) |
| `onPath` | Whether that executable is on `PATH` |
| `version` | Client version parsed from the `--help` header |
| `buildId` | Build id from the installation's `version` file, if present |
| `cliCapable` / `probed` | Whether the CLI works / whether probing ran; `null` means not probed |
| `ambiguous` | Whether both editions are installed |
| `selectedReason` | Why this installation was selected |
| `installations` | All installations found (possibly multiple versions/editions) |
| `warnings` | Warnings that must be read and respected |
| `doctor` | Present only with `--doctor`: bridge connection, endpoint, bridgeVersion |

### Decision rules

1. `ok:false` → stop. Ask the user to install the **desktop client v4.1.70+**
   (mainland edition: lceda.cn; international edition: easyeda.com).
   **Never download or install the client yourself.**
2. `ok:true` → record `distribution`, `installDir`, `executable`, and `version`.
   - `onPath:true`: use `command` directly (for example, `lceda-pro`).
   - `onPath:false`: use the quoted absolute path, for example
     `"C:/Program Files/lceda-pro/lceda-pro.exe" --help`.
   - All examples in this skill use `lceda-pro`; when the detector reports
     `easyeda-pro`, substitute that name verbatim.
3. `ambiguous:true` → both editions are installed. Tell the user which two were
   found and **ask which one to drive**; never mix sessions from different
   editions.
4. `version` below `4.1.70` → the CLI is not supported; ask the user to upgrade
   before continuing.
5. `warnings` is non-empty → read every warning and comply; do not ignore
   “not on PATH”, “outdated version”, and similar messages.
6. Re-run the detector at the start of every new session; installations may
   have changed.

Report the result to the user in one sentence, for example:
“Detected the mainland edition lceda-pro 4.1.103 at `C:/Program Files/lceda-pro`.”

### Step 0.5: Confirm the running environment

File detection proves the client is installed, not that an editor is running.
Before acting on a project, probe the local bridge:

```bash
"<executable>" doctor
# or: bash scripts/detect-easyeda-cli.sh --doctor
```

`doctor` returns the usual JSON envelope. Important fields under `value`:

| Field | Meaning |
| --- | --- |
| `endpoint` | Local endpoint id; never hardcode it |
| `connected` | `true` only while an editor window is running |
| `bridgeVersion` | Version of the running bridge; `null` when disconnected |
| `versionMatch` | Whether the CLI and bridge versions match |
| `resultChannel` | Implementation detail; usually `null` |

The detector's `--doctor` mode returns a normalized `doctor` object with
`ok`, `connected`, `endpoint`, `bridgeVersion`, and `raw` at its top level.

- `connected:false` → no editor is running. Ask the user to open the client, or
  create a session with `open` if the task may open a new window.
- `versionMatch:false` → ask the user to restart the editor; if it persists,
  upgrade the client so the CLI and bridge versions agree.
- A successful `doctor` does **not** mean a project is open. Use `session list`
  to see sessions, their `origin` (`cli`/`user`), and project paths.

## Distribution editions

| Edition | Executable | Product name | Market | Download site |
| --- | --- | --- | --- | --- |
| Mainland China | `lceda-pro` | JLCEDA Pro / 嘉立创EDA专业版 | Mainland China | lceda.cn |
| International | `easyeda-pro` | EasyEDA Pro | International | easyeda.com |

- Both editions share the same CLI, extension API, and design-file format. They
  differ only in distribution channel, default servers, and UI language.
  Detection is based on the **executable name**; the product name and version
  in the `--help` header confirm it.
- Legacy **standard editions** (`lceda.exe` / `easyeda.exe` 6.x) have no CLI;
  the detector ignores them. If the user points to such an installation,
  explain that the Pro edition is required and guide them to install it.
- Use the official English name **EasyEDA** and the Chinese name **嘉立创EDA**;
  do not use variant spellings.

### Using the right executable in commands

Both editions expose the same commands under different executable names. All
examples in this skill use `lceda-pro`; if the detector reports `easyeda-pro`,
substitute it exactly:

| Purpose | Mainland edition | International edition |
| --- | --- | --- |
| Show help | `lceda-pro --help` | `easyeda-pro --help` |
| Probe the bridge | `lceda-pro doctor` | `easyeda-pro doctor` |
| Open a session | `lceda-pro open` | `easyeda-pro open` |
| List sessions | `lceda-pro session list` | `easyeda-pro session list` |
| Close a session | `lceda-pro session close --session <id> --destroy` | `easyeda-pro session close --session <id> --destroy` |
| Run JavaScript | `lceda-pro invoke --session <id> --ext-uuid eda --code "..."` | `easyeda-pro invoke --session <id> --ext-uuid eda --code "..."` |
| Query the API | `lceda-pro doc api --class-name DMT_Project` | `easyeda-pro doc api --class-name DMT_Project` |
| Query the file format | `lceda-pro doc format --class-name TMSchComponent` | `easyeda-pro doc format --class-name TMSchComponent` |

For scripts, bind the detected absolute path once instead of repeating the
edition name:

```bash
# Replace with the executable returned by the detector.
CLI="C:/Program Files/lceda-pro/lceda-pro.exe"        # mainland example
# CLI="C:/Program Files/easyeda-pro/easyeda-pro.exe"  # international example

"$CLI" --help
"$CLI" doctor
"$CLI" open --path "C:/Users/<user>/Documents/LCEDA-Pro/projects/MyBoard/MyBoard.eprj3"
```

- Use only the edition reported by the detector; never mix `lceda-pro` and
  `easyeda-pro` in the same task or session.
- When `onPath:false`, always use the quoted absolute `executable` path.
- Windows executables are `lceda-pro.exe` / `easyeda-pro.exe`; in Git Bash or
  PowerShell, the `.exe` suffix may be omitted when the command is on `PATH`.

## Hard facts

| Fact | Description |
| --- | --- |
| Product | Only the **desktop client** supports the CLI (v4.1.70+); the browser/online edition supports neither the bridge nor sessions |
| Executable | The same binary starts the GUI and serves CLI commands |
| Bridge | Every command talks to the running editor through a local bridge |
| Session | One editor window = one session. A command creates a session and returns its ID; later commands need that ID; close it when done |
| Response | Every command returns the same JSON envelope. **Check the top-level `ok` first**; on failure read `error` and adapt — never continue as if it succeeded |
| Source of truth | The installed version's `--help` output plus the built-in `doc api` / `doc format` commands. Online documentation may lag behind releases |
| Windows caveat | In Git Bash, `lceda-pro` works directly and stdout is captured normally. PowerShell **cannot capture this program's stdout** (`$x = & lceda-pro --help` is empty); use `\| Out-String` or `Start-Process -Wait -RedirectStandardOutput` instead. Prefer bash |
| Paths | Always use forward slashes: `C:/Users/...`. Backslashes are easily mangled by shells and JSON |

### Response envelope

Success:

```json
{ "ok": true, "value": {}, "logs": [], "durationMs": 12 }
```

Failure:

```json
{ "ok": false, "error": { "code": "EXECUTION_ERROR", "message": "..." } }
```

Only the top-level `ok` decides success or failure; `logs` and `durationMs` are
diagnostic. For `invoke`, `ok:true` means the JavaScript **ran**, not that the
operation inside it succeeded — inspect the returned `value`.

## Runtime environment, version and write scope

### How to obtain versions

| What | How |
| --- | --- |
| CLI/client version | `--help` header (`JLCEDA Pro 4.1.x.abcdef01`), or the detector's `version` |
| Build id | The `version` file inside `installDir`, or the detector's `buildId` |
| Bridge version | `doctor` → `value.bridgeVersion`; check `versionMatch` at the same time |
| Editor runtime version | `eda.sys_Environment.getEditorCurrentVersion()` via `invoke` |

Run this inside a session to confirm the runtime mode and editor version:

```javascript
return {
  isClient: eda.sys_Environment.isClient(),
  isHalfOfflineMode: eda.sys_Environment.isHalfOfflineMode(),
  version: eda.sys_Environment.getEditorCurrentVersion()
};
```

```bash
"<executable>" invoke --session <session-id> --ext-uuid eda --code "<snippet above>"
```

- `isClient()` must be `true`; `false` means a web/online environment with no
  local bridge.
- `isHalfOfflineMode()` reports whether the editor is in half-offline mode. Do
  not assume online services (team libraries, cloud storage) are available.
- Record the version; later command/API conclusions apply only to that version.

### Where files may be written

In half-offline/full-offline mode the client data directory is:

```text
%USERPROFILE%\Documents\LCEDA-Pro        (Windows)
```

`config.json` in that directory lists project roots under `APP_PROJECT_DIR`.
The `SYS_FileSystem` APIs can read and write **only inside those roots and their
subdirectories**. Query them at runtime instead of hardcoding paths:

```javascript
return {
  projects: await eda.sys_FileSystem.getProjectsPaths(),
  eda: await eda.sys_FileSystem.getEdaPath(),
  libraries: await eda.sys_FileSystem.getLibrariesPaths()
};
```

- Write exports under `projects/<project>/`; confirm the target with the user
  before writing.
- `saveFileToFileSystem(uri, file, fileName?, force?)`: a `uri` ending in `/`
  means a directory, otherwise it is a full file name; `force = true`
  overwrites.
- `.eprj3` is a folder project with **two-way sync**: editor saves land on disk
  immediately, and direct disk edits are reloaded by the editor. Always verify
  files on disk after saving.

## Core principle: discover first, then act

**Never assume commands or APIs from memory or from this document.** This skill
may be older than the installed client. Whenever help output conflicts with
memory, this file, or any other document, trust the installed version's help
output.

### 1. List all commands

```bash
lceda-pro --help        # or the executable returned by the detector
```

The help header prints the exact product name and version — record it, because
later conclusions apply only to that version. The command list is the
authoritative set of available commands.

### 2. Find a command by keyword

```bash
lceda-pro --search <keyword>
```

Use **English** keywords (for example `netlist`, `bom`, `gerber`,
`screenshot`, `session`).

### 3. Read a command's usage

```bash
lceda-pro <command> --help
lceda-pro <command> <subcommand> --help
```

Read it before running anything; do not guess option names or argument shapes.
If a value requires a user decision (project name, target path, what to export),
ask the user instead of inventing one.

## Discover the editor API and file format: the `doc` command family

The CLI serves the editor's reference documentation, so no memorized API
knowledge is needed. It uses progressive disclosure:

```bash
lceda-pro doc api                                  # list classes: {name, comment}
lceda-pro doc api --class-name DMT_Project         # methods + callPath
lceda-pro doc api --class-name DMT_Project --method-name createProject
lceda-pro doc api --class-name EPCB_LayerId        # enum values
lceda-pro doc format --class-name TMSchComponent   # design-file field definitions
```

- `callPath` maps a class to the runtime object: class `DMT_Project` is called
  as `eda.dmt_Project`.
- Method entries include a runnable `example`; prefer it over guessing.
- Class prefixes group domains: `DMT_` (projects / boards / editor), `SCH_`,
  `PCB_`, `LIB_`, `SYS_`, and `E*_` (enums).
- Start with `lceda-pro doc --help`, then follow the subcommand help level by
  level. **Read the relevant signature or format type before writing code that
  uses it**; re-check after the client is upgraded.

### Design-file format is version-bound

Online documentation, community posts, and examples in this skill can be older
than the installed client. Always query the installed client before reading or
writing project files:

```bash
lceda-pro doc format                          # list available format types
lceda-pro doc format --class-name TMSchComponent
lceda-pro doc format --class-name TSchAttr
lceda-pro doc format --class-name TWire
```

- The installed version's `doc format` output is the authority; ignore field
  lists copied from online docs or from this skill.
- Read every field's name, type, and `required` flag before writing a record.
- Re-query after a client update; fields can be added, removed, or renamed.

## Sessions, invocation and MCP

### Sessions

| Command | Notes |
| --- | --- |
| `open [--path <project>] [--headless true\|false]` | Opens a window and returns `value.sessionId`, `renderId`, `path`, `headless`. Without `--path` it opens a bare editor; `--headless true` hides the window |
| `session list` | Shows every session with `origin` (`cli`/`user`), `status`, project `path`, and `title` |
| `session close --session <id> --destroy` | Closes the session and its window. Use it for every session you created; without `--destroy`, a CLI-opened visible window may remain open |
| `session abort --session <id>` | Last resort for a stuck session; unsaved edits are lost. Never use it on a user-opened window without asking |
| `stop` | Gracefully stops the local service. Use only when the user explicitly asks; never as routine cleanup |
| `activate` | Brings the server window up and focuses it |

- One editor window equals one session. Sessions with `origin:user` belong to
  the user; do not close or abort them.
- `.eprj3` folder projects opened with `--path` stay in two-way sync with the
  editor.
- Close every session you created before finishing so windows do not pile up.

### `invoke` essentials

```bash
"<executable>" invoke --session <session-id> --ext-uuid eda \
  --args '{"key":"value"}' \
  --code "return __CLI__.args.key"
```

| Item | Rule |
| --- | --- |
| `--ext-uuid eda` | Always include it to run with the editor's built-in extension identity and full permissions (local file I/O, system APIs) |
| Code shape | The source is an **async function body**: use `return` and `await`; the return value is serialized to JSON |
| `--args` | JSON text exposed inside the code as `__CLI__.args` |
| `--timeout` | Invocation budget in ms; default `60000`, maximum `1800000`. Raise it for long operations |
| Long code | Save it to a `.js` file and pass `--code "$(cat file.js)"` to avoid shell quoting problems |
| `File`/`Blob` results | Save them through `SYS_FileSystem`, or convert to Base64 with `FileReader` before returning |
| `ok:true` | For `invoke` this means the code ran, **not** that the operation succeeded. Inspect the returned `value` |

- After `save()` or opening a document, wait several seconds (5–10 s for
  DRC/export/status checks) before reading results.
- Use forward slashes in every path passed into JavaScript.
- To return a `File`/`Blob` through JSON, convert it first:

```javascript
const b64 = await new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.readAsDataURL(blob);
});
```

### MCP server mode

The CLI can also run as an MCP server for agents that prefer tools over shell
commands:

```bash
lceda-pro --mcp stdio                          # local agents (Claude Code, Cursor, ...)
lceda-pro --mcp http --port 3030 --token <t>   # remote/browser agents
```

Confirm the current syntax with `lceda-pro --mcp --help`.

## Execution rules

1. **Discover from the installed client, never from memory or this file.** This
   skill may lag behind API changes; every command, option, argument, API
   signature, and format field must be confirmed from the installed version's
   `--help` or `doc` output. Record the version you are targeting.
2. **Check `ok` on every response.** On failure, read `error.code` and
   `error.message` and adapt; do not continue as if the step succeeded. For
   `invoke`, also inspect `value`: `ok:true` only means the code ran.
3. **Verify artifacts on disk.** When a command claims to write files, confirm
   the files actually exist.
4. **Confirm values and write targets that require user decisions.** Project
   name, target directory, and build/export content must never be invented.
5. **Use forward slashes in paths**; quote paths that contain spaces.
6. **Write only inside the allowed project roots** returned by
   `SYS_FileSystem.getProjectsPaths()`; never write outside them.
7. **Announce long operations** to the user before running them, and raise
   `--timeout` for long `invoke` calls.
8. **Close sessions you created** with `session close --session <id> --destroy`
   when done, so editor windows do not pile up. Never close or abort a session
   with `origin:user`.
9. **GUI-only steps belong to the user.** If a step requires interaction with
   the client UI, stop and ask the user.
10. **Never run `stop`, `session abort`, or `activate` without an explicit user
    request.** `stop` shuts down the local service; `abort` can destroy unsaved
    edits.
11. **Always pass `--ext-uuid eda` to `invoke`** unless the task specifically
    targets another extension; this grants the full editor permissions needed
    for file I/O and system APIs.
12. **Never trust online docs or this skill for file-format fields.** Before
    reading or writing `.esch2` / `.epcb2` / `.epan2`, query
    `lceda-pro doc format --class-name <type>` on the installed client; online
    documentation may not be updated in time.
13. **Use the detected executable and edition.** Examples here use `lceda-pro`;
    for an `easyeda-pro` installation, substitute that name verbatim. Never
    assume `lceda-pro` exists, and never mix the two editions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Command not found / not on `PATH` | Re-run the detector; use the absolute `executable` path, or add `installDir` to `PATH` |
| `doctor` returns `connected:false` or times out | The editor is not running; ask the user to open the client, or start a session with the CLI's open command |
| `doctor` returns `versionMatch:false` | The CLI and bridge versions disagree; ask the user to restart the editor, and upgrade the client if it persists |
| Detector reports `ambiguous:true` | Both mainland and international editions exist; ask the user which one to drive and never mix them |
| `invoke` returns `ok:true` but the expected result is missing | `ok` only means the code ran. Inspect `value`, check the session ID, and confirm a project/document is open |
| A file write is rejected or invisible | The path is outside the allowed roots. Query `SYS_FileSystem.getProjectsPaths()` and write under `projects/<project>/` |
| `invoke` times out | Raise `--timeout` (maximum `1800000` ms) and split large operations into batches |
| File-format fields do not match an example | Online docs and this skill may be stale; query `lceda-pro doc format --class-name <type>` and re-check the `required` fields |
| PowerShell stdout is empty | Use bash instead, or pipe through `\| Out-String` in PowerShell |
| macOS app will not open / Linux AppImage will not execute | macOS: the user must approve it in Finder on first launch; AppImage: it needs `chmod +x` and FUSE support — let the user handle it |
| WSL detects only the Windows client | Prefer running the CLI on the Windows side or in Git Bash so it can reliably reach the desktop editor window |
| Help output differs from this document | Trust the local `--help`; this skill targets v4.1.70+ |

## Report when done

Report concisely:

- the detected edition, installation directory, executable, and client version;
- the `doctor` result (endpoint, `connected`, `versionMatch`) and the runtime
  mode reported by `isClient()` / `isHalfOfflineMode()`;
- the commands actually run (or the final help-derived workflow);
- the produced artifacts and their absolute paths;
- the session shutdown result, plus any failed step and its error message.
