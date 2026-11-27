# EasyEDA Pro（嘉立创EDA专业版）AI 桥接与开源生态参考（已验证版）

> **更新时间**：2026-11-27  
> **本机已验证环境**：嘉立创EDA专业版 `v4.1.105`（`D:\lceda-pro\lceda-pro.exe`），已内置官方 CLI 与原生 MCP Server（`--mcp stdio`）。

---

## 1. 已导入并验证的官方核心 Skills（`github.com/easyeda/*`）

全部来自嘉立创官方 `easyeda` GitHub 组织，已直接集成到本插件 `embedded-hardware-kit` 中：

| Skill | 官方仓库 | 协议 / 热度 | 核心能力与适用场景 |
| :--- | :--- | :--- | :--- |
| **`easyeda-cli`** | `easyeda/easyeda-cli-skill` | Apache-2.0（官方） | **首选通道（适配 v4.1.70+ / 本机 v4.1.105）**：直接驱动 `lceda-pro.exe` 内置 CLI（`open` / `session` / `invoke` / `doc api\|format`），免装第三方扩展 |
| **`easyeda-eprj3`** | `easyeda/easyeda-eprj3-skill` | MIT / 103★（官方） | 离线/双向同步创建与编辑 `.eprj3` 工程，自带零依赖 Node.js 几何/网表/ERC/DRC 校验脚本，`lceda-pro open` 可实时同步打开 |
| **`easyeda-schematic-review`** | `easyeda/easyeda-schematic-review-skill` | Apache-2.0（官方） | 只读原理图与 `.enet` 网表深度审查，自动生成带批注截图的离线 HTML 报告（支持 CLI、Bridge、离线 `.enet` 三模式） |
| **`easyeda-api`** | `easyeda/easyeda-api-skill` | 1215★（官方） | 官方最全 `eda.*` 扩展 API 文档 + WebSocket 桥接服务（端口 `49620–49629`，配合 `Run API Gateway` `.eext` 扩展做画布内 JS 操控） |

---

## 2. 社区已验证高质量项目（按需选装参考）

| 项目 | 热度 / 协议 | 特点与定位 | 是否建议加装 |
| :--- | :--- | :--- | :--- |
| **`zhoushoujianwork/easyeda-agent`** | **1247★**（活跃至 2026-11-27） | 社区 Star 最高的 EasyEDA Pro AI 自动化全套工具（支持 PDF 数据手册建库 Symbol/Footprint/3D、严格 `save→reload→readback` 闭环），附 EdaDesk Desktop | 需额外安装独立 Go CLI/daemon 与立创插件市场连接器 `easyeda-agent-connector`；需要重度全自动画图/PDF建库时再加装 |
| **`hyl64/jlcmcp`** | 290★ / MIT | 基于官方 Run API Gateway 的 59 工具 MCP Server（含自动布局/布线/DRC 自修复） | 当官方原生 CLI/MCP（3 入口工具）不满足高层封装需求时可选 |
| **`daishuge/pcb-skill`** | 194★ / MIT | 端到端四阶段硬件交付 Skill（强调手焊友好、性价比、嘉立创免费打样边界、下单前闸门） | 核心流程方法论已吸收进 `jlceda-pcb-design` |
| **`oaslananka/easyeda-mcp-pro`** | 77★ / AGPL-3.0（活跃至 2026-11-27） | 生产级权限分级 MCP Server + 审查 Skills | 如需更细粒度的工具权限策略可选 |
| **`ChengminLi/AI-PCB-layout`** | 38★ | 专注**电力电子/功率 PCB** 设计与逐级人工闸门审查 | 与 24V FOC 功率板高度契合，可作为进阶参考 |
| **本地已有 `D:\EDAhelper\JLCEDA-MCP-main`** | Apache-2.0 | VS Code / Cursor 双端扩展方案（`mcp-hub` + `mcp-bridge.eext`） | 保留作 VS Code 侧备用方案 |

---

## 3. 本机原生 CLI & MCP 接入要点（v4.1.105 已验证）

1. **原生 MCP（已配置在插件 `mcp_config.json` 中）**：
   - Server 名：`embedded-hardware-kit_lceda-pro`（`mcp_config.json` 键名 `lceda-pro`）
   - 命令：`D:\lceda-pro\lceda-pro.exe --mcp stdio`
   - 暴露工具：`lceda-pro.help`、`lceda-pro.discover`、`lceda-pro.call`
2. **命令行健康检查与避坑**：
   - **必须用管道捕获输出**：Windows PowerShell 直接运行 `& "D:\lceda-pro\lceda-pro.exe" ...` 输出为空，务必加 `| Out-String`：
     ```powershell
     & "D:\lceda-pro\lceda-pro.exe" doctor | Out-String
     & "D:\lceda-pro\lceda-pro.exe" --help | Out-String
     & "D:\lceda-pro\lceda-pro.exe" doc api --help | Out-String
     ```
   - 注意本机 `PATH` 中存在旧路径 `E:\lceda-pro`，调用时优先显式使用 `D:\lceda-pro\lceda-pro.exe`。
3. **官方 WebSocket 桥接备选（`easyeda-api` + Run API Gateway）**：
   - 启动服务：`node scripts/bridge-server.mjs`（自动监听 `49620–49629`）。
   - 在嘉立创EDA专业版 `高级 → 扩展管理器` 安装并启用 `Run API Gateway`，勾选“允许外部交互”。

---

## 4. 自动化操控画布的安全准则

- **操作前先备份/保存版本**，先用只读接口获取元件清单、网表和视口截图，确认坐标单位与原点。
- **每次调用 API 前先查实时文档**：通过 `lceda-pro doc api` / `lceda-pro doc format` 核实当前版本签名，严禁凭记忆编造方法名。
- **不一次性全自动盲布大功率板**：优先让 AI 做器件核对、网表对比、`.eprj3` 校验、DRC/ERC 审查、丝印避让；大电流功率回路与敏感模拟采样区由人工精调复核。
- **每批次改动后立即复验**：执行 `save → reload/readback → DRC/ERC`，确认未引入新冲突再继续。
