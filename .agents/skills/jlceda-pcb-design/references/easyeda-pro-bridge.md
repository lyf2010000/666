# EasyEDA Pro（嘉立创EDA专业版）AI 桥接与开源生态参考

> 本文件汇总当前 GitHub 上经过社区验证的嘉立创EDA专业版 AI 自动化方案，供后续接入实时画布操控时参考。

---

## 1. 主流成熟 GitHub 项目速览

| 项目 | 定位 | 核心机制 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`easyeda/easyeda-api-skill`**（官方） | EasyEDA Pro 官方 AI Skill 与桥接器 | 本地 Node.js WebSocket Bridge Server（端口 `49620–49629`）+ EDA 内置 **Run API Gateway** 扩展（`.eext`），实时执行 `eda.*` API | 稳定查询最新官方扩展 API、直接脚本化读写/调试 EasyEDA Pro 画布 |
| **`oaslananka/easyeda-mcp-pro`** | 生产级 EasyEDA Pro MCP Server + 审查 Skills | MCP 协议封装原理图/PCB 读取、器件与封装审查、设计验证，带权限分级与安全闸门 | 接入支持 MCP 的 AI 客户端做原理图/PCB 审查与受控编辑 |
| **`daishuge/pcb-skill`** / **`Zero1683/PCB-Design-Skill`** | 端到端 PCB Agent Skill | 四阶段闸门工作流（需求 → 原理图+立创选型 → 布局布线+DRC → Gerber/BOM/下单前闸门） | 学习或套用完整硬件工程交付流程 |
| **`Keitark/pcba-design-skills`** / **`mash/jlcpcb-skills`** | JLCPCB/LCSC 选型与 PCBA 下单辅助 | LCSC 料号筛选（Basic vs Extended）、BOM/CPL 匹配与核价 | 批量 BOM 配单降本与贴片核对 |

---

## 2. 官方通道（`easyeda-api-skill` + Run API Gateway）接入要点

1. **AI / 本地端**：
   - 获取 `easyeda/easyeda-api-skill`，安装依赖并编译文档：`npm install && npm run build:docs`。
   - 启动本地 WebSocket 桥接服务：`npm run server`（自动监听 `49620–49629` 可用端口）。
2. **嘉立创EDA专业版端**：
   - 从扩展市场/开源广场安装 **`Run API Gateway`**（`.eext`）。
   - 在 `高级 → 扩展管理器` 中启用扩展，勾选 **“允许外部交互（Allow External Interaction）”** 与 **“显示在顶部菜单”**。
   - 确认顶部菜单出现 `API Gateway` 并显示已连接。
3. **Antigravity MCP 接入（如需使用 MCP Server）**：
   - 在 `~/.gemini/config/mcp_config.json` 中配置对应 `stdio` MCP Server（如 `easyeda-mcp-pro` 或 `jlceda-mcp`），重启/重载即可获得直接操作画布的工具集。

---

## 3. 自动化操控画布的安全准则

- **操作前先备份/保存版本**，先用只读接口获取元件清单、网表和视口截图，确认坐标单位与原点。
- **不一次性全自动盲布大功率板**：优先让 AI 做**器件核对、网表对比、非关键外围批量对齐、丝印自动整理避让焊盘、铺铜与 DRC 审查**；大电流功率回路与敏感模拟区由人工复核或精调。
- **每批次改动后立即复验**：执行截图对比 + 重新运行 ERC/DRC，确认未引入新冲突再继续下一步。
