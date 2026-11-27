# 嘉立创EDA专业版 Skills 导入、验证与环境记忆归档

> **日期**：2026-11-27  
> **插件名称**：`embedded-hardware-kit`（全局安装路径：`C:\Users\Temp\.gemini\config\plugins\embedded-hardware-kit\`）  
> **跨设备同步源**：`https://github.com/lyf2010000/666`（对应目录：`.agents/plugins/embedded-hardware-kit/`）

---

## 1. 本机实测环境档案

| 项目 | 已验证信息 |
| :--- | :--- |
| **嘉立创EDA专业版（国内版）** | `D:\lceda-pro\lceda-pro.exe`，版本 **`4.1.105.0339a6cd`**（支持原生内置 CLI 与原生 `--mcp stdio`） |
| **旧版残留（勿用）** | `C:\Program Files\lceda-pro\lceda-pro.exe`（v2.2.32.3，`cliCapable: false`，CLI 探测会超时）；`PATH` 中存在旧路径 `E:\lceda-pro` |
| **官方 AI 文档目录** | `D:\lceda-pro\docs\cli-for-ai.md`、`easyeda-cli.md`、`easyeda-format.md` |
| **原生桥接验证** | `lceda-pro doctor` → `connected: true`、`versionMatch: true`、`resultChannel: true`（68ms） |
| **原生 MCP Server** | 已注册在插件 `mcp_config.json` 中（`embedded-hardware-kit_lceda-pro`），暴露 `lceda-pro.help` / `lceda-pro.discover` / `lceda-pro.call` |
| **PowerShell 关键避坑** | 直接 `& "D:\lceda-pro\lceda-pro.exe" ...` 输出为空，必须接管道 `\| Out-String` 或用 `Start-Process -Wait -RedirectStandardOutput` |
| **本地备选工具** | `D:\EDAhelper\JLCEDA-MCP-main`（VS Code / Cursor 侧 `mcp-hub` + `mcp-bridge.eext`） |

---

## 2. 已导入并验证的 6 个 Skills 清单

| Skill 名称 | 来源 / 提交版本 | 验证结果 | 使用场景 |
| :--- | :--- | :--- | :--- |
| `jlceda-pcb-design` | 自有 `666` 仓库（已更新桥接参考） | Antigravity 插件已加载 | 四阶段 PCB 设计流程、JLCPCB 2/4 层 1oz/2oz DFM、24V/STM32 FOC 功率板自检、对抗式审查 |
| `stm32-embedded-dev` | 自有 `666` 仓库 | Antigravity 插件已加载 | STM32G4/STM8 CubeMX `.ioc`、TIM1/TIM8 互补 PWM + ADC 同步、FOC 六阶段上电调机 |
| `easyeda-cli` | 官方 `easyeda/easyeda-cli-skill` (`d7470dd`, 2026-11-17, Apache-2.0) | `detect-easyeda-cli.ps1` 实测 `ok: true`，精准识别 v4.1.105 | 直接用 `lceda-pro.exe` 内置 CLI 打开/操控工程、查询实时 `doc api/format`、导出制造文件 |
| `easyeda-eprj3` | 官方 `easyeda/easyeda-eprj3-skill` (`acb1ed3`, 2026-11-22, MIT, 103★) | `smoke.js` 128/128、`dfm.js` 90/90、`depcheck.js` 0 第三方依赖全部通过 | 离线/双向同步创建编辑 `.eprj3` 工程，运行本地 ERC/DRC/网表比对校验 |
| `easyeda-schematic-review` | 官方 `easyeda/easyeda-schematic-review-skill` (`9158d0e`, 2026-11-20, Apache-2.0) | 脚本与单元测试已验证 | 只读原理图与 `.enet` 网表深度审查，输出带批注截图的离线 HTML 报告 |
| `easyeda-api` | 官方 `easyeda/easyeda-api-skill` (`0394d63`, 2026-11-24, 1215★) | `ws` 依赖安装并通过导入校验 | 官方完整 `eda.*` API 检索与 `Run API Gateway` WebSocket 桥接（端口 `49620–49629`） |

---

## 3. GitHub 社区精选候补（已调研验证，按需选装）

1. **`zhoushoujianwork/easyeda-agent`（1247★，2026-11-27 活跃）**：社区 Star 最高的嘉立创 AI 自动化框架，支持 PDF 数据手册直接建库（Symbol/Footprint/Device/3D）及严格 `save → reload → readback` 闭环；因需额外安装独立 Go CLI/daemon 与插件市场连接器 `easyeda-agent-connector`，暂列为进阶选装。
2. **`hyl64/jlcmcp`（290★，MIT）** / **`oaslananka/easyeda-mcp-pro`（77★，AGPL-3.0）**：第三方多工具 MCP Server，若未来需要更丰富的自动布局/布线封装工具时可加装。
3. **`daishuge/pcb-skill`（194★，MIT）** & **`ChengminLi/AI-PCB-layout`（38★）**：前者强项在手焊友好/性价比/免费打样流程（核心思想已吸收进 `jlceda-pcb-design`），后者专注电力电子功率 PCB 逐级审查，适合 FOC 功率板进阶参考。

---

## 4. 持久记忆生效机制

- 核心规则、本机环境路径、PowerShell 避坑点与 6 个 Skill 路由表已写入插件常驻规则：`rules/AGENTS.md`（插件启用期间在所有新会话自动加载，形成持久记忆）。
- 同步至本仓库 `666` 后，在其他设备执行 `git pull` 并将 `.agents/plugins/embedded-hardware-kit` 复制到 `~/.gemini/config/plugins/embedded-hardware-kit` 即可完整复原（`easyeda-api` 若用 WebSocket 桥接只需补跑 `npm install --omit=dev`）。
