# EasyEDA Schematic Review Skill

**English** · [简体中文](#简体中文)

A read-only schematic review skill for **EasyEDA / 嘉立创EDA Pro**. Give it a
schematic netlist, and it produces an evidence-based, severity-ranked HTML
review report with annotated screenshots — either from the project currently
open in EasyEDA, or offline from an exported `.enet` file.

Works as a standard **Agent Skill** for Claude Code and other
Agent Skills-compatible tools.

- License: [Apache-2.0](LICENSE)
- Runtime: Node.js 18+, no third-party dependencies
- Version: see `metadata.version` in [SKILL.md](SKILL.md)

---

## English

### What it does

| Capability | Description |
| --- | --- |
| Deterministic rules | 55 built-in checks (R001–R060) for connectivity, power/ground, interfaces, component parameters, BOM consistency, polarity, and more |
| AI review | Claude reviews prioritized packets of the netlist for topology- and intent-level issues that rules cannot cover |
| Evidence-based findings | Every finding must cite a component UID, pin, net, property, DRC item, or BOM row; unsupported claims are rejected or downgraded to open questions |
| Annotated screenshots | P0/P1 findings get a cropped schematic screenshot with a red highlight box |
| Offline HTML report | Single-page report works without a network connection: filter, search, print, lightbox, dark mode, review status, Markdown minutes export |
| Bilingual | Chinese (`zh`, default) and English (`en`) reports and AI output |
| Read-only | Never creates, modifies, saves, or deletes anything in your EasyEDA project |

It is **not** a replacement for manual review or EasyEDA's own ERC/DRC, and it
does not review PCB layout, routing, signal integrity, or simulation.

### Requirements

| Item | Needed for | Notes |
| --- | --- | --- |
| Claude Code (or another Agent Skills tool) | AI review | Recommended; the AI step runs inside the agent session |
| Node.js 18 or newer | Everything | Check with `node -v` |
| EasyEDA Pro / 嘉立创EDA 专业版 | Bridge / CLI mode | Bridge mode: the project must be open in the editor |
| `easyeda-api-skill` + `run-api-gateway.eext` | Bridge mode | The Bridge that lets the skill export data from EasyEDA |
| EasyEDA Pro / JLCEDA Pro desktop client with CLI (v4.1.70+) | CLI mode | Reviews a local `.eprj3` project without the Bridge; the skill opens and closes the editor session itself |
| An exported `.enet` netlist | Offline mode | Export from EasyEDA with netlist type **JLCEDA** |

### Installation

#### 1. Install this skill

Clone the repository into your personal Claude Code skills directory.

macOS / Linux:

```bash
git clone git@github.com:easyeda/easyeda-schematic-review-skill.git \
  ~/.claude/skills/easyeda-schematic-review
```

Windows PowerShell:

```powershell
git clone git@github.com:easyeda/easyeda-schematic-review-skill.git `
  "$env:USERPROFILE\.claude\skills\easyeda-schematic-review"
```

If you do not use SSH, replace the URL with
`https://github.com/easyeda/easyeda-schematic-review-skill.git`.

You can also install it per project by cloning into
`<your-project>/.claude/skills/easyeda-schematic-review`.

Verify the installation:

```bash
node ~/.claude/skills/easyeda-schematic-review/scripts/review.mjs --version
```

Restart your Claude Code session after installing so the skill is discovered.

#### 2. Set up live mode (optional)

Skip this section if you only want to review exported `.enet` files.

1. Install the EasyEDA API Bridge skill next to this one:

   ```bash
   git clone https://github.com/easyeda/easyeda-api-skill.git \
     ~/.claude/skills/easyeda-api-skill
   cd ~/.claude/skills/easyeda-api-skill
   npm install
   ```

2. Install the EasyEDA extension **run-api-gateway** in EasyEDA:

   <https://jlcext.com/item/oshwhub-official/run-api-gateway>

3. Start the Bridge:

   ```bash
   node ~/.claude/skills/easyeda-api-skill/scripts/bridge-server.mjs
   ```

   The Bridge listens on the first free port in `49620–49629`.

4. Open your project in EasyEDA. The extension connects to the Bridge
   automatically.

Check the connection:

```bash
curl http://127.0.0.1:49620/health
```

You should see `"service": "easyeda-bridge"`.

### Quick start

#### Option A — Ask Claude Code (recommended)

With the project open in EasyEDA and the Bridge running, start a Claude Code
session in any folder and say:

```text
审查当前原理图
```

or in English:

```text
Review the current schematic.
```

Claude Code reads [SKILL.md](SKILL.md), asks **which connection mode** to use
and where the report should be saved, collects the data, runs the rules,
reviews the netlist packet by packet, and tells you the final report path.

Connection modes:

| Mode | Adopt when | Requirement |
| --- | --- | --- |
| Bridge (`--source live`) | The project is open in a running EasyEDA editor | `easyeda-api-skill` Bridge + `run-api-gateway.eext` loaded |
| CLI (`--source cli`) | You have a local/offline project file to review | Desktop client v4.1.70+ (built-in CLI) + the project's `.eprj3` path |

The agent asks this question on every review unless you already named the mode
or provided an exported `.enet` file (then offline `--source file` is used
directly). It never guesses a mode or a project path.

Useful prompts:

| You want | Say |
| --- | --- |
| Full review (rules + AI) | “审查当前原理图” / “Review the current schematic” |
| Review a local project file | “审查本地工程 C:\boards\MyBoard.eprj3” / “Review C:\boards\MyBoard.eprj3” |
| Fast rules-only review | “快速审查原理图，不用 AI” / “Quick review, no AI” |
| Review only power circuitry | “只审查电源部分” / “Review the power section only” |
| Review one component | “重点看 U1” / “Focus on U1” |
| Review an exported netlist | “审查 D:\designs\board.enet” / “Review D:\designs\board.enet” |

Reports default to `tmp/schematic-review/<runId>/report.html` under the folder
where the command runs; the agent asks for a destination first and falls back to
this default only if you have no preference. Open that file in any browser; no
server or network is required.

#### Option B — Command line

Set the skill directory once:

```bash
# macOS / Linux
SKILL_DIR=~/.claude/skills/easyeda-schematic-review

# Windows PowerShell
# $SKILL_DIR = "$env:USERPROFILE\.claude\skills\easyeda-schematic-review"
```

Offline rules-only review (no EDA, no AI, finishes in seconds):

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source file --netlist design.enet --mode quick
```

Live rules-only review (EasyEDA + Bridge required):

```bash
node "$SKILL_DIR/scripts/review.mjs" run --source live --mode quick
```

CLI rules-only review (local `.eprj3` project through the desktop client, no Bridge):

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source cli --project "C:/path/to/MyBoard.eprj3" --mode quick
```

> **CLI mode never parses the `.eprj3` file.** The skill calls the desktop
> client's built-in CLI (`lceda-pro` / `easyeda-pro`, v4.1.70+): it opens the
> project in an editor session and reads netlist, BOM, DRC, pin data, page SVGs
> and geometry through the same read-only editor APIs as Bridge mode. `open`
> leaves no document active, and netlist/DRC APIs need one — the skill opens a
> schematic page (the **first page by default**; `--page <uuid|名称>` selects
> another; use the uuid when page names repeat across schematics). The
> session it opened is closed when the run finishes (even on failure).
> Opening a project may upgrade its file format to the current client version
> (folder projects are two-way synced) — back it up first if that matters.

Write the report to a folder of your choice:

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source file --netlist design.enet --mode quick --out tmp/my-review
```

> **Standard mode from the command line:** `--mode standard` runs collection,
> rules, and packet generation, then stops with `status = awaiting_ai`. The AI
> step must be performed by the agent session. The easiest way is to ask
> Claude Code to run the review; for a fully scripted pipeline, use
> `--mode quick` or add `--no-ai`.

### Review modes

| Mode | Rules | AI | Typical use |
| --- | --- | --- | --- |
| `quick` | Core deterministic rule set | No | Fast self-check, CI, privacy-sensitive runs |
| `standard` | All v1 rules | Yes | Default design review |
| `strict` | All rules + strict-only heuristics | Yes | Deep review before a design review meeting |

Add `--no-ai` to `standard`/`strict` to keep all rules but skip the AI step.

### Common options

| Option | Description |
| --- | --- |
| `--source live\|cli\|file` | `live` = Bridge, `cli` = desktop-client CLI on a local `.eprj3`, `file` = exported netlist |
| `--project <file>` | CLI mode: absolute path of the local `.eprj3` project (ask the user; never guessed) |
| `--cli <exe>` | CLI mode: executable override; otherwise auto-detects `lceda-pro` / `easyeda-pro` |
| `--cli-show` | CLI mode: show the editor window (default: headless) |
| `--page <uuid\|name>` | CLI mode: schematic page to review (default: first page); use the uuid when page names repeat across schematics |
| `--invoke-timeout <ms>` | CLI mode: per-invoke timeout (defaults per step; max 30 min) |
| `--full` | No caps on packets, findings, screenshots or open questions; incomplete AI packets fail the run (exit 6). “100%” = every component/net enters rules + AI review, not every possible defect |
| `--netlist <file>` | Path to the `.enet` file (offline mode) |
| `--bom <file>` | Optional BOM CSV for cross-checks |
| `--drc <file>` | Optional DRC JSON exported from EasyEDA |
| `--mode quick\|standard\|strict` | Review depth |
| `--scope <expr>` | Limit findings: `page:P1`, `net:VCC`, `designator:U1`, `category:power` |
| `--focus <expr>` | Prioritization hint for packet review; e.g. `--focus U1` puts packets for U1 first when the packet limit applies |
| `--lang zh\|en` | Report and AI output language (default `zh`) |
| `--out <dir>` | Run directory (default `tmp/schematic-review/<timestamp>`) |
| `--no-screenshots` | Skip screenshot generation |
| `--self-contained` | Inline screenshots as base64 into a single HTML file |
| `--max-findings N` | Cap P2/P3 rule findings (noise rules first); P0/P1 and AI conclusions are never truncated |
| `--max-p0 N`, `--max-p1 N`, `--strict-exit` | CI thresholds; exit code 10 when exceeded |
| `--fail-partial` | Exit code 6 when AI coverage is partial |
| `--model <name>` | Review model shown in the report (or `SCHEMATIC_REVIEW_MODEL`) |
| `--tokens-in N` / `--tokens-out N` | Exact review token usage shown in the report (or `SCHEMATIC_REVIEW_TOKENS_IN/OUT`) |

The full flag list is in [SKILL.md](SKILL.md).

### What you get

```text
tmp/schematic-review/<runId>/
├── report.html            # Main report: open this
├── report.json            # Machine-readable report
├── findings.final.json    # Merged, validated, deduplicated findings
├── model.json             # Normalized netlist model
├── lint.json              # Deterministic rule results
├── packets/               # AI review packets + manifest + progress
├── ai/                    # Per-packet AI findings
├── screenshots/           # Annotated SVG crops for P0/P1 findings
├── design.enet            # Source netlist snapshot
└── manifest.json          # Run metadata, versions, file hashes, coverage
```

The HTML report contains:

- P0/P1/P2/P3 and open-question counts, risk dashboard, and coverage percentages
- The three most important findings at the top
- Filter by severity/category/page, full-text search, screenshot-only toggle
- Evidence tables, impact and suggestion for every finding
- Annotated schematic screenshots with red highlight boxes
- Open questions kept separate from confirmed findings
- Coverage and limitations, plus an appendix with component/net/DRC tables
- Per-finding review status (`待定 / 确认修改 / 豁免误报`, or in English mode
  `Pending / Confirm fix / Waived`) saved in `localStorage`, and one-click
  Markdown minutes export
- Print / save-as-PDF layout

### How it works

```text
EasyEDA (live)  ──┐
                  ├─→ collect → parse → model.json
design.enet ──────┘                 │
                                    ├─→ lint (R001–R060) → lint.json
                                    ├─→ packets (power / IC / interface / passives)
                                    ├─→ AI review, one packet at a time
                                    ├─→ merge: schema + evidence validation, dedupe, sort
                                    ├─→ capture: crop cached page SVG + red box
                                    └─→ report.html + report.json
```

- The Node.js scripts never call an LLM. The AI review is performed by the
  Claude Code session reading one packet at a time.
- Every AI finding is validated against the netlist; findings that cite a
  non-existent component, pin, or net are rejected.
- Findings that need design intent or a datasheet become **open questions**
  instead of being asserted as defects.

### Rules at a glance

The deterministic engine covers 55 rules, including:

| Area | Examples |
| --- | --- |
| Connectivity | Single-pin nets, floating pins, duplicate designators, nets with no pins |
| Power / ground | Floating power pins, power/ground net conflicts, missing decoupling, missing supply source, isolated ground nets, regulator input/output capacitors, paralleled power outputs, power-select jumpers, VREF decoupling, MCU core-regulator caps |
| Interfaces | I2C pull-ups, reset pull-ups, reset tied to a rail, floating BOOT pins, crystal load capacitors, UART TX/RX cross-check, CAN/RS-485 termination, SWD pair completeness, USB-C CC Rp/Rd, connector data-line ESD, cross-domain level shifts |
| Component-level | LED current-limit resistors and current estimates, MOSFET gate pull-downs, relay flyback diodes, regulator feedback/enable, optocoupler input resistors, crystal nets routed to headers |
| Parameters / BOM | Missing or placeholder values, missing footprints, BOM/netlist mismatches (TSV/CSV auto-detected), missing part numbers, one part number with conflicting values |
| Polarity | Reversed LED, electrolytic capacitor, flyback diode |

Severity levels:

| Level | Meaning |
| --- | --- |
| P0 | Likely damage, short circuit, or non-functional design at power-up |
| P1 | High probability of malfunction or a critical interface error |
| P2 | Reliability, derating, or design-rule risk |
| P3 | Readability, manufacturability, or optimization suggestion |

See [references/rule-catalog.md](references/rule-catalog.md) for every rule and
its false-positive boundaries, and
[references/review-checklist.md](references/review-checklist.md) for the full
~280-item review checklist used by the AI.

### Safety and privacy

- **Read-only:** only export/read APIs are called. The skill never modifies,
  saves, or deletes project data and never places orders.
- **Your data stays local by default:** netlist, BOM, DRC, model, findings,
  screenshots, and reports are written only to the local run directory.
- **AI review sends netlist fragments to the model.** If that is not allowed,
  use `--mode quick` or `--no-ai`. In these modes the scripts run locally and
  should only report exit codes and severity counts; a Claude session can still
  read the artifacts, so say so explicitly if the user asks for details.
- **Screenshots are design data.** Treat the whole report folder as sensitive.
  Use `--no-screenshots` if you do not want schematic images on disk.
- **Prompt injection is treated as data.** Any instruction-like text found in
  descriptions, names, or net names is ignored and reported as an open question.
- Reports are never written into the EasyEDA project directory unless you
  explicitly choose such an `--out` folder.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| “未发现 EasyEDA Bridge” / Bridge not found | Start `easyeda-api-skill`'s Bridge and confirm `run-api-gateway.eext` is loaded in EasyEDA |
| “未找到 EasyEDA CLI” / CLI not found | Install EasyEDA Pro / JLCEDA Pro desktop client v4.1.70+, keep `lceda-pro` / `easyeda-pro` on `PATH`, or pass `--cli <exe>`; Bridge mode (`--source live`) still works without the CLI |
| Bridge is running but no EDA window | Open a project in EasyEDA; check `http://127.0.0.1:49620/eda-windows` |
| Multiple EDA windows detected | Pass `--window-id <id>`; find IDs in `/eda-windows` |
| `.net` / `.asc` / `.tel` / `.dnet` rejected | v1 supports only EasyEDA `.enet`; export a **JLCEDA** netlist |
| No screenshots in the report | Offline mode has no geometry; live mode needs `--map-pages` for pages other than the current one |
| Screenshot placeholder “页/器件不匹配” or “页面 SVG 与几何不匹配” | The page/component evidence check failed, or an older run's cached SVG was overwritten by another page; re-run `collect` (page keys now carry the schematic dimension). A placeholder is shown instead of a wrong red box |
| `node: command not found` / old Node | Install Node.js 18 or newer |
| Report has no AI findings | `quick`/`--no-ai` was used, or no AI packets were completed; check `packets/progress.json` |
| AI review stopped halfway | Resume with `--resume --out <runDir>`, or ask Claude Code to continue; a partial report is still produced |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic error |
| `2` | Environment / Bridge error |
| `3` | Netlist missing or unsupported format |
| `4` | Netlist parse failure |
| `5` | Merge failed / all AI findings invalid |
| `6` | Partial report with `--fail-partial` |
| `10` | P0/P1 threshold exceeded (`--max-p0`, `--max-p1`, `--strict-exit`) |

If several apply, the highest wins: `10 > 6 > 5 > 4 > 3 > 2 > 1 > 0`.

### Development

```bash
# Run the test suite
node --test tests/rules.test.mjs
```

- The runtime uses only Node.js built-in modules; there is no `npm install`.
- Rule fixtures are synthetic and anonymized. Do not add customer designs.
- The version has a single source of truth: `metadata.version` in
  [SKILL.md](SKILL.md).
- Project background and design decisions: [docs/PRD.md](docs/PRD.md).

### License

[Apache-2.0](LICENSE)

---

## 简体中文

面向 **嘉立创EDA（EasyEDA）专业版** 的只读原理图审查 Skill。给它一份原理图网表，
它会输出一份**有证据、分级别、可复核**的 HTML 审查报告，并附上带红框标注的异常
位置截图。数据可以来自当前在 EasyEDA 中打开的工程，也可以来自离线导出的
`.enet` 文件。

可直接用于 Claude Code 以及其他兼容 Agent Skills 标准的 AI 工具。

- 许可证：[Apache-2.0](LICENSE)
- 运行环境：Node.js 18+，无第三方依赖
- 版本：见 [SKILL.md](SKILL.md) 中的 `metadata.version`

### 它能做什么

| 能力 | 说明 |
| --- | --- |
| 确定性规则 | 内置 55 条检查（R001–R060），覆盖连接性、电源/地、接口、器件参数、BOM 一致性、极性等 |
| AI 审查 | Claude 按“审查包”逐个检查网表，发现规则难以覆盖的拓扑级、意图级问题 |
| 证据驱动 | 每条结论必须引用位号 UID、引脚、网络、属性、DRC 项或 BOM 行；无证据的结论会被拒绝或降级为待确认问题 |
| 异常位置截图 | P0/P1 问题自动附上裁剪后的原理图截图，并用红框标出相关器件 |
| 离线 HTML 报告 | 单页报告，断网可打开；支持筛选、搜索、打印、放大、深色模式、评审标记、Markdown 纪要导出 |
| 中英双语 | 报告与 AI 输出支持中文（`zh`，默认）和英文（`en`） |
| 只读 | 不会创建、修改、保存或删除 EasyEDA 工程中的任何内容 |

它**不能**替代人工评审或 EasyEDA 自带的 ERC/DRC，也不审查 PCB 布局布线、
信号完整性或仿真。

### 环境要求

| 项目 | 用途 | 说明 |
| --- | --- | --- |
| Claude Code（或其他 Agent Skills 工具） | AI 审查 | 推荐；AI 审查在会话内完成 |
| Node.js 18 或更新版本 | 全部功能 | 用 `node -v` 检查 |
| 嘉立创EDA 专业版 | 桥接 / CLI 模式 | 桥接模式需要在编辑器中打开目标工程 |
| `easyeda-api-skill` + `run-api-gateway.eext` | 桥接模式 | 用于从 EasyEDA 导出数据 |
| 嘉立创EDA专业版 / EasyEDA Pro 桌面客户端（含 CLI，≥ 4.1.70） | CLI 模式 | 直接审查本地 `.eprj3` 工程，无需 Bridge；会话由本 Skill 打开并自动关闭 |
| 导出的 `.enet` 网表 | 离线模式 | 在 EasyEDA 中按 **JLCEDA** 类型导出 |

### 安装

#### 1. 安装本 Skill

把仓库克隆到 Claude Code 的个人 Skill 目录。

macOS / Linux：

```bash
git clone git@github.com:easyeda/easyeda-schematic-review-skill.git \
  ~/.claude/skills/easyeda-schematic-review
```

Windows PowerShell：

```powershell
git clone git@github.com:easyeda/easyeda-schematic-review-skill.git `
  "$env:USERPROFILE\.claude\skills\easyeda-schematic-review"
```

不使用 SSH 时，把地址换成
`https://github.com/easyeda/easyeda-schematic-review-skill.git`。

也可以只给某个项目安装：克隆到
`<项目目录>/.claude/skills/easyeda-schematic-review`。

检查安装：

```bash
node ~/.claude/skills/easyeda-schematic-review/scripts/review.mjs --version
```

安装后重启 Claude Code 会话，让 Skill 被识别。

#### 2. 配置实时模式（可选）

如果只审查导出的 `.enet` 文件，可以跳过本节。

1. 在同一个 Skill 目录下安装 EasyEDA API Bridge：

   ```bash
   git clone https://github.com/easyeda/easyeda-api-skill.git \
     ~/.claude/skills/easyeda-api-skill
   cd ~/.claude/skills/easyeda-api-skill
   npm install
   ```

2. 在 EasyEDA 中安装扩展 **run-api-gateway**：

   <https://jlcext.com/item/oshwhub-official/run-api-gateway>

3. 启动 Bridge：

   ```bash
   node ~/.claude/skills/easyeda-api-skill/scripts/bridge-server.mjs
   ```

   Bridge 会自动占用 `49620–49629` 中第一个可用端口。

4. 在 EasyEDA 中打开目标工程。扩展会自动连接 Bridge。

检查连接：

```bash
curl http://127.0.0.1:49620/health
```

应能看到 `"service": "easyeda-bridge"`。

### 快速开始

#### 方式一：直接对 Claude Code 说（推荐）

在 EasyEDA 中打开工程、Bridge 正常运行后，在任意目录启动 Claude Code，然后说：

```text
审查当前原理图
```

或英文：

```text
Review the current schematic.
```

Claude Code 会读取 [SKILL.md](SKILL.md)，先询问**使用哪种连接模式**与报告输出目录，
再自动完成取数、规则检查、逐包 AI 审查，最后告诉你报告路径。

连接模式：

| 模式 | 适用场景 | 前置条件 |
| --- | --- | --- |
| 桥接（`--source live`） | 已在运行中的 EasyEDA 编辑器里打开待审查工程 | `easyeda-api-skill` Bridge + 已加载 `run-api-gateway.eext` |
| CLI（`--source cli`） | 审查本地 / 离线工程文件 | 桌面客户端 v4.1.70+（内置 CLI）+ 工程 `.eprj3` 路径 |

除非你已经说明模式或直接提供 `.enet` 网表文件（此时直接走离线 `--source file`），
否则每次审查都会先问这个问题；不会自行猜测模式或工程路径。

常用说法：

| 你想做什么 | 可以这样说 |
| --- | --- |
| 完整审查（规则 + AI） | “审查当前原理图” |
| 审查本地工程文件 | “审查本地工程 C:\boards\MyBoard.eprj3” |
| 只跑规则，不用 AI | “快速审查原理图，不用 AI” |
| 只看电源部分 | “只审查电源部分” |
| 重点看某个器件 | “重点看 U1” |
| 审查导出的网表 | “审查 D:\designs\board.enet” |

报告默认写到运行目录下的
`tmp/schematic-review/<runId>/report.html`；Claude Code 会先询问你希望保存到
哪个目录，只有你表示无所谓时才使用默认位置。双击即可用浏览器打开，不需要
服务器或网络。

#### 方式二：命令行

先设置 Skill 目录：

```bash
# macOS / Linux
SKILL_DIR=~/.claude/skills/easyeda-schematic-review

# Windows PowerShell
# $SKILL_DIR = "$env:USERPROFILE\.claude\skills\easyeda-schematic-review"
```

离线规则审查（不需要 EDA、不调用 AI，几秒完成）：

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source file --netlist design.enet --mode quick
```

实时规则审查（需要 EasyEDA + Bridge）：

```bash
node "$SKILL_DIR/scripts/review.mjs" run --source live --mode quick
```

CLI 规则审查（本地 `.eprj3` 工程，经桌面客户端 CLI，无需 Bridge）：

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source cli --project "C:/path/to/MyBoard.eprj3" --mode quick
```

> **CLI 模式不解析 `.eprj3` 文件格式。** 本 Skill 调用桌面客户端内置 CLI
> （`lceda-pro` / `easyeda-pro`，v4.1.70+）：在编辑器会话中打开工程，再通过与桥接
> 模式完全相同的只读 editor API 读取网表、BOM、DRC、引脚数据、页面 SVG 与几何。
> `open` 之后没有活动文档，而网表/DRC API 需要一个——本 Skill 会自动打开一个原理图
> 图页（**默认第一个图页**；`--page <uuid|名称>` 指定其他图页，页名跨原理图重复时请用
> uuid）。运行结束（含失败）会自动关闭它创建的会话。打开工程可能把文件格式升级到当前
> 客户端版本（文件夹工程双向同步），介意时请先备份。

指定报告目录：

```bash
node "$SKILL_DIR/scripts/review.mjs" run \
  --source file --netlist design.enet --mode quick --out tmp/my-review
```

> **命令行下的 standard 模式：** `--mode standard` 会完成取数、规则检查和审查包
> 生成，然后停在 `status = awaiting_ai`，等待 AI 会话继续。最省事的方式是直接
> 让 Claude Code 执行审查；如果要纯脚本流水线，请使用 `--mode quick` 或加
> `--no-ai`。

### 审查模式

| 模式 | 规则 | AI | 典型用途 |
| --- | --- | --- | --- |
| `quick` | 核心确定性规则集 | 否 | 快速自检、CI、隐私敏感场景 |
| `standard` | 全部 v1 规则 | 是 | 默认设计评审 |
| `strict` | 全部规则 + strict-only 启发式 | 是 | 评审会前的深度检查 |

在 `standard`/`strict` 后加 `--no-ai`，可保留全部规则但跳过 AI。

### 常用参数

| 参数 | 说明 |
| --- | --- |
| `--source live\|cli\|file` | `live` 走 Bridge，`cli` 经桌面客户端 CLI 审查本地 `.eprj3`，`file` 读导出的网表 |
| `--project <file>` | CLI 模式：本地 `.eprj3` 工程绝对路径（必须向用户确认，不得猜测） |
| `--cli <exe>` | CLI 模式：指定可执行文件；默认自动探测 `lceda-pro` / `easyeda-pro` |
| `--cli-show` | CLI 模式：显示编辑器窗口（默认 headless 打开） |
| `--page <uuid\|名称>` | CLI 模式：指定要审查的原理图图页（默认第一个图页）；页名跨原理图重复时请用 uuid |
| `--invoke-timeout <ms>` | CLI 模式：单次 invoke 超时（默认按步骤内置值，最大 30 分钟） |
| `--full` | 全量输出：审查包、结论、截图、开放问题一律不设上限；未审完的 AI 包视为失败（退出 6）。“100%”指每个器件/网络都进入规则 + AI 审查，而非发现所有潜在缺陷 |
| `--netlist <file>` | 离线模式下的 `.enet` 路径 |
| `--bom <file>` | 可选的 BOM CSV，用于一致性检查 |
| `--drc <file>` | 可选的 DRC JSON |
| `--mode quick\|standard\|strict` | 审查深度 |
| `--scope <expr>` | 限定问题范围：`page:P1`、`net:VCC`、`designator:U1`、`category:power` |
| `--focus <expr>` | 审查优先级提示；例如 `--focus U1` 会在审查包数量受限时优先审查 U1 相关的包 |
| `--lang zh\|en` | 报告与 AI 输出语言（默认 `zh`） |
| `--out <dir>` | 运行目录（默认 `tmp/schematic-review/<时间戳>`） |
| `--no-screenshots` | 不生成截图 |
| `--self-contained` | 把截图以 base64 内联成单个 HTML 文件 |
| `--max-findings N` | 限制 P2/P3 规则噪声数量（R020/R026 优先）；P0/P1 与 AI 结论永不截断 |
| `--max-p0 N`、`--max-p1 N`、`--strict-exit` | CI 阈值，超限退出码 10 |
| `--fail-partial` | AI 覆盖不完整时退出码 6 |
| `--model <name>` | 报告中显示的审查模型（也可用 `SCHEMATIC_REVIEW_MODEL`） |
| `--tokens-in N` / `--tokens-out N` | 报告中显示的精确 Token 消耗（也可用 `SCHEMATIC_REVIEW_TOKENS_IN/OUT`） |

完整参数表见 [SKILL.md](SKILL.md)。

### 输出内容

```text
tmp/schematic-review/<runId>/
├── report.html            # 主报告，打开这个
├── report.json            # 机读报告
├── findings.final.json    # 合并、校验、去重后的最终问题
├── model.json             # 规范化后的网表模型
├── lint.json              # 确定性规则结果
├── packets/               # AI 审查包、manifest、progress
├── ai/                    # 逐包 AI 结论
├── screenshots/           # P0/P1 问题的红框截图
├── design.enet            # 本次使用的网表快照
└── manifest.json          # 运行元数据、版本、文件哈希、覆盖率
```

HTML 报告包含：

- P0/P1/P2/P3 和待确认问题数量、风险仪表盘、覆盖率百分比
- 顶部“最需要关注的 3 件事”
- 按级别/类别/图页筛选，全文搜索，仅看有截图
- 每条问题的证据表、影响与建议
- 带红框的原理图异常位置截图
- 待确认问题单独展示，不与正式问题混排
- 审查覆盖与限制，附录含器件表、网络表、DRC 原始结果
- 每条问题可标记“待定 / 确认修改 / 豁免误报”，状态保存在
  `localStorage`，并可一键导出 Markdown 评审纪要
- 打印 / 另存为 PDF 样式

### 工作流程

```text
EasyEDA 实时取数 ──┐
                    ├─→ collect → parse → model.json
design.enet ────────┘                     │
                                          ├─→ lint（R001–R060）→ lint.json
                                          ├─→ packets（电源 / IC / 接口 / 无源件）
                                          ├─→ AI 逐包审查
                                          ├─→ merge：校验证据、去重、排序
                                          ├─→ capture：裁剪页面 SVG + 画红框
                                          └─→ report.html + report.json
```

- Node.js 脚本不调用任何大模型；AI 审查由 Claude Code 会话逐个读取审查包完成。
- 每条 AI 结论都会回查网表；引用不存在的器件、引脚或网络会被拒绝。
- 需要设计意图或数据手册才能判断的内容，会进入“待确认问题”，而不是直接下结论。

### 规则概览

确定性规则引擎共 55 条，主要包括：

| 方向 | 示例 |
| --- | --- |
| 连接性 | 单引脚网络、引脚悬空、重复位号、网络无引脚 |
| 电源/地 | 电源引脚悬空、电源与地冲突、去耦缺失、电源无来源、孤立地网络、稳压器输入/输出电容、电源输出并联、电源选择跳线、VREF 去耦、MCU 内核储能电容 |
| 接口 | I2C 上拉、复位上拉、复位脚接死电平、BOOT 悬空、晶振负载电容、UART TX/RX 交叉检查、CAN/RS-485 终端、SWD 对完整性、USB-C CC Rp/Rd、连接器数据线 ESD、跨电源域直连 |
| 器件级 | LED 限流电阻与电流估算、MOSFET 栅极下拉、继电器续流二极管、稳压器反馈/使能、光耦输入限流、晶振节点引到排针 |
| 参数/BOM | 缺值或占位值、缺封装、BOM/网表不一致（TSV/CSV 自动识别）、缺料号、同一料号多个值 |
| 极性 | LED、电解电容、续流二极管方向 |

级别定义：

| 级别 | 含义 |
| --- | --- |
| P0 | 上电即可能损坏、短路或无法工作 |
| P1 | 高概率功能失效或关键接口错误 |
| P2 | 可靠性、降额或设计规范风险 |
| P3 | 可读性、可制造性或优化建议 |

每条规则的判定细节和误报边界见
[references/rule-catalog.md](references/rule-catalog.md)；AI 使用的完整审查清单约
280 项，见 [references/review-checklist.md](references/review-checklist.md)。

### 安全与隐私

- **只读：** 只调用导出/读取 API，不修改、保存或删除工程数据，也不会触发下单。
- **数据默认留在本地：** 网表、BOM、DRC、模型、结论、截图和报告只写入本地运行目录。
- **AI 审查会把网表片段发送给模型。** 如果不允许，请使用 `--mode quick` 或
  `--no-ai`。这两种模式下脚本在本地执行，会话应只转述退出码和各级别计数；
  但 Claude 会话仍可能读取产物内容，用户要求查看细节时应明确告知。
- **截图也是设计数据。** 整个报告目录请按敏感资料管理；不需要原理图图片时加
  `--no-screenshots`。
- **提示注入按数据处理。** 描述、名称、网络名中的“忽略以上规则”等文本会被忽略，
  并作为待确认问题报告。
- 除非你显式把 `--out` 指向工程目录，报告不会写入 EasyEDA 工程目录。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示“未发现 EasyEDA Bridge” | 启动 `easyeda-api-skill` 的 Bridge，并确认 EasyEDA 已加载 `run-api-gateway.eext` |
| 提示“未找到 EasyEDA CLI” | 安装嘉立创EDA专业版 / EasyEDA Pro 桌面客户端 v4.1.70+，把 `lceda-pro` / `easyeda-pro` 加入 `PATH`，或用 `--cli <exe>` 指定；没有 CLI 时仍可用桥接模式（`--source live`） |
| Bridge 已启动但没有 EDA 窗口 | 在 EasyEDA 中打开工程；访问 `http://127.0.0.1:49620/eda-windows` 检查 |
| 检测到多个 EDA 窗口 | 加 `--window-id <id>`，窗口 ID 可从 `/eda-windows` 获取 |
| `.net` / `.asc` / `.tel` / `.dnet` 被拒绝 | v1 只支持 EasyEDA `.enet`，请重新导出 **JLCEDA** 类型网表 |
| 报告里没有截图 | 离线模式没有几何数据；实时模式下非当前图页需要加 `--map-pages` |
| 截图占位“页/器件不匹配”或“页面 SVG 与几何不匹配” | 页/器件证据校验未通过，或旧版运行目录的缓存 SVG 被其他图页覆盖；重新 `collect` 即可（页键现已带原理图维度）。宁可占位，不画错框 |
| 提示找不到 `node` 或版本过低 | 安装 Node.js 18 或更新版本 |
| 没有 AI 结论 | 使用了 `quick`/`--no-ai`，或 AI 包未完成；检查 `packets/progress.json` |
| AI 审查中途停止 | 用 `--resume --out <runDir>` 继续，或让 Claude Code 继续；已生成部分报告 |

### 退出码

| 代码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 一般错误 |
| `2` | 环境 / Bridge 错误 |
| `3` | 网表缺失或格式不支持 |
| `4` | 网表解析失败 |
| `5` | 合并失败 / 全部 AI 结论不合法 |
| `6` | 使用 `--fail-partial` 时的部分报告 |
| `10` | 超过 P0/P1 阈值（`--max-p0`、`--max-p1`、`--strict-exit`） |

多个条件同时成立时取最高值：`10 > 6 > 5 > 4 > 3 > 2 > 1 > 0`。

### 开发

```bash
# 运行测试
node --test tests/rules.test.mjs
```

- 运行时只用 Node.js 内置模块，无需 `npm install`。
- 测试 fixture 均为匿名合成工程，请勿加入客户设计。
- 版本号唯一来源是 [SKILL.md](SKILL.md) 的 `metadata.version`。
- 项目背景与设计决策见 [docs/PRD.md](docs/PRD.md)。

### 许可证

[Apache-2.0](LICENSE)
