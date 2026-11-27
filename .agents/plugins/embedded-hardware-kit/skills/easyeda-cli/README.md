# EasyEDA CLI Skill

**English** | [中文](#中文)

A skill for Claude Code and other SKILL.md-compatible AI agents. It lets the
agent drive the **EasyEDA Pro / JLCEDA Pro (嘉立创EDA专业版) desktop client**
through the client's built-in command line, and ships a **cross-platform
detector** that tells the agent where the client is installed, which edition it
is, and whether it is on `PATH`.

- Works on **Windows, macOS and Linux**.
- Detects both editions: `lceda-pro` (mainland China) and `easyeda-pro`
  (international).
- Read-only detection: it never installs, launches or closes the editor.
- No Node.js or Python required — only Bash or Windows PowerShell.

---

## English

### What it does

Once installed, the skill teaches the agent to:

1. **Detect the client** — installation directory, executable, edition,
   version, build id, and `PATH` status (see
   `scripts/detect-easyeda-cli.sh` / `.ps1`).
2. **Discover commands at runtime** — always from the installed version's
   `--help`, never from memory.
3. **Drive the editor safely** — open/modify `.eprj3` projects, draw schematics
   and PCBs, export netlist/BOM/Gerber/STEP/screenshots, query the editor API
   and the design-file format through the `doc` command family, and close
   sessions it created.

### Requirements

| Item | Requirement |
| --- | --- |
| EasyEDA Pro desktop client | v4.1.70 or newer (the CLI is built into the client) |
| Agent | Claude Code or any agent that loads `SKILL.md` skills |
| Script runtime | Bash (macOS/Linux, or Git Bash/WSL on Windows) **or** Windows PowerShell |

Download the client from [lceda.cn](https://lceda.cn/page/download) (mainland
edition) or [easyeda.com](https://easyeda.com/page/download) (international
edition). The browser edition does not support the CLI.

### Install from the GitHub ZIP (no Git needed)

1. Open **https://github.com/easyeda/easyeda-cli-skill**.
2. Click the green **Code** button → **Download ZIP**
   (direct link: <https://github.com/easyeda/easyeda-cli-skill/archive/refs/heads/main.zip>).
3. Extract the ZIP. You get a folder named `easyeda-cli-skill-main`.
4. Rename that folder to **`easyeda-cli`**.
5. Move it into your personal skills directory:
   - **Windows:** `C:\Users\<your-name>\.claude\skills\easyeda-cli`
   - **macOS / Linux:** `~/.claude/skills/easyeda-cli`
6. Check the layout: `SKILL.md` must be **directly inside** the folder —
   `...\.claude\skills\easyeda-cli\SKILL.md`. Do not leave an extra nested
   folder such as `easyeda-cli\easyeda-cli-skill-main\SKILL.md`.
7. Restart Claude Code (or open a new session) so it picks up the skill.

If an older skill with the same name already exists, replace that folder with
this one.

#### Verify the installation

```bash
bash ~/.claude/skills/easyeda-cli/scripts/detect-easyeda-cli.sh --text
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.claude\skills\easyeda-cli\scripts\detect-easyeda-cli.ps1" -Text
```

You should see the detected edition, installation directory, executable and
version. If nothing is found, install the desktop client v4.1.70+ first.

### Install by handing one sentence to an AI agent

Copy the sentence below into Claude Code (or another agent that can run shell
commands and write files):

> Install the Claude Code skill from https://github.com/easyeda/easyeda-cli-skill :
> download the repository ZIP, extract it, rename the extracted folder to
> `easyeda-cli`, place it at `~/.claude/skills/easyeda-cli` (on Windows:
> `%USERPROFILE%\.claude\skills\easyeda-cli`) so that `SKILL.md` is directly
> inside that folder, then run `scripts/detect-easyeda-cli.sh --text` and report
> the detected EasyEDA Pro edition, installation path and version.

The agent will download, unpack, place and verify the skill. Restart Claude Code
afterwards if the skill does not appear immediately.

### Use it

Just ask in natural language, for example:

- “Detect my EasyEDA Pro installation.”
- “Use easyeda-cli to export the netlist of `D:/work/board.eprj3`.”
- “Draw this circuit in EasyEDA Pro and save it as a new project.”

The skill starts every session by running the detector, then discovers the
current CLI commands from `--help` before acting.

### Repository layout

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Skill instructions loaded by the agent |
| `scripts/detect-easyeda-cli.sh` | Detector for Linux, macOS and Windows (Git Bash/WSL) |
| `scripts/detect-easyeda-cli.ps1` | Detector for native Windows PowerShell |
| `scripts/detect-easyeda-cli.cmd` | Double-click / cmd wrapper for the PowerShell detector |
| `README.md` | This file |

### License

[Apache-2.0](LICENSE)

[Back to top](#easyeda-cli-skill)

---

## 中文

[English](#english) | **中文**

这是一个面向 Claude Code 及其他支持 `SKILL.md` 的 AI Agent 的 skill。它让 Agent
通过客户端内置的命令行驱动**嘉立创EDA专业版（EasyEDA Pro）桌面客户端**，并自带
**跨平台安装检测脚本**，告诉 Agent 客户端装在哪里、是哪个发行版、版本多少、是否
已经在 `PATH` 中。

- 支持 **Windows、macOS、Linux** 三大系统。
- 自动区分国内版 `lceda-pro` 与国际版 `easyeda-pro`。
- 检测过程只读：不会安装、启动或关闭编辑器。
- 不依赖 Node.js / Python，只需要 Bash 或 Windows PowerShell。

### 它做什么

安装后，Agent 会：

1. **检测客户端**：安装目录、可执行文件、发行版、版本、构建号、是否在 `PATH`
   （对应 `scripts/detect-easyeda-cli.sh` / `.ps1`）。
2. **运行时发现命令**：一律以本机版本的 `--help` 为准，不靠记忆。
3. **安全驱动编辑器**：打开/修改 `.eprj3` 工程、绘制原理图与 PCB、导出
   netlist/BOM/Gerber/STEP/截图、通过 `doc` 命令族查询扩展 API 与设计文件格式，
   并在用完时关闭自己创建的会话。

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 嘉立创EDA专业版桌面客户端 | v4.1.70 及以上（CLI 内置于客户端） |
| AI Agent | Claude Code，或其他会加载 `SKILL.md` 的 Agent |
| 脚本运行环境 | Bash（macOS/Linux，或 Windows 的 Git Bash/WSL）**或** Windows PowerShell |

客户端下载：[国内版 lceda.cn](https://lceda.cn/page/download)，
[国际版 easyeda.com](https://easyeda.com/page/download)。浏览器/在线版不支持 CLI。

### 方法一：从 GitHub 下载 ZIP 安装（普通用户推荐，不需要 Git）

1. 打开 **https://github.com/easyeda/easyeda-cli-skill**。
2. 点击绿色 **Code** 按钮 → **Download ZIP**
   （直链：<https://github.com/easyeda/easyeda-cli-skill/archive/refs/heads/main.zip>）。
3. 解压 ZIP，会得到一个名为 `easyeda-cli-skill-main` 的文件夹。
4. 把这个文件夹**重命名为** **`easyeda-cli`**。
5. 把它放进个人 skills 目录：
   - **Windows：** `C:\Users\<你的用户名>\.claude\skills\easyeda-cli`
   - **macOS / Linux：** `~/.claude/skills/easyeda-cli`
6. 检查目录结构：`SKILL.md` 必须**直接位于**该文件夹下，即
   `...\.claude\skills\easyeda-cli\SKILL.md`。不要出现
   `easyeda-cli\easyeda-cli-skill-main\SKILL.md` 这种多套一层的结构。
7. 重启 Claude Code（或新开一个会话），让它加载 skill。

如果本地已有同名的旧 skill，用这个文件夹替换它即可。

#### 验证是否安装成功

```bash
bash ~/.claude/skills/easyeda-cli/scripts/detect-easyeda-cli.sh --text
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.claude\skills\easyeda-cli\scripts\detect-easyeda-cli.ps1" -Text
```

正常应输出检测到的发行版、安装目录、可执行文件和版本。若提示找不到，请先安装
v4.1.70+ 的桌面客户端。

### 方法二：复制一句话交给 AI Agent 安装

把下面这句话复制给 Claude Code（或其他能执行命令、读写文件的 Agent）：

> 请安装 Claude Code skill：从 https://github.com/easyeda/easyeda-cli-skill
> 下载仓库 ZIP 并解压，把解压出的文件夹重命名为 `easyeda-cli` 后放到
> `~/.claude/skills/easyeda-cli`（Windows 为
> `%USERPROFILE%\.claude\skills\easyeda-cli`），确保 `SKILL.md` 直接位于该目录下，
> 然后运行 `scripts/detect-easyeda-cli.sh --text`，并把检测到的嘉立创EDA专业版
> 发行版、安装目录和版本告诉我。

Agent 会自动完成下载、解压、放置和验证。如果安装后 skill 没有立即出现，重启
Claude Code 或新开会话即可。

### 怎么使用

直接用自然语言提问，例如：

- “检测我的嘉立创EDA装在哪里、是哪个发行版。”
- “用 easyeda-cli 导出 `D:/work/board.eprj3` 的网表。”
- “在嘉立创EDA里画出这个电路并保存成新工程。”

skill 会在每个会话开始时先运行检测脚本，再用本机 `--help` 发现当前可用命令，
然后才开始操作。

### 仓库结构

| 路径 | 用途 |
| --- | --- |
| `SKILL.md` | Agent 加载的 skill 指令 |
| `scripts/detect-easyeda-cli.sh` | Linux / macOS / Windows（Git Bash、WSL）检测脚本 |
| `scripts/detect-easyeda-cli.ps1` | Windows 原生 PowerShell 检测脚本 |
| `scripts/detect-easyeda-cli.cmd` | cmd / 双击运行的 PowerShell 包装脚本 |
| `README.md` | 本说明 |

### 许可证

[Apache-2.0](LICENSE)

[回到顶部](#easyeda-cli-skill)
