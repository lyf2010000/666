# 嘉立创EDA专业版官方离线扩展包（`.eext`）

本目录存放从嘉立创官方 GitHub Releases 验证下载的国内版（`zh-cn`）扩展包，用于在嘉立创EDA专业版界面直接离线导入：

| 文件名 | 官方来源 | 用途 |
| :--- | :--- | :--- |
| `run-api-gateway_v1.0.5_zh-cn.eext` | `easyeda/eext-run-api-gateway` (`v1.0.5`) | 官方 AI WebSocket 网关扩展，配合 `easyeda-api` Skill（端口 `49620–49629`）实时操控画布 |
| `jlc-order-dfm-checker_v1.0.5_zh-cn.eext` | `easyeda/eext-jlc-order-dfm-checker` (`v1.0.5`) | 官方嘉立创下单 DFM 自动核对扩展 |

## 一键部署与导入

在 `666` 仓库根目录运行 PowerShell 脚本（自动同步 Antigravity 插件/Skills/记忆/原生 MCP，并高亮打开本目录供嘉立创导入）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\import-jlceda-kit.ps1
```

随后在嘉立创EDA专业版中：`高级 → 扩展管理器 → 左下角蓝色「导入」` → 选中 `.eext` 文件 → 启用并勾选「允许外部交互」。

> **提示**：嘉立创EDA专业版 `v4.1.70+`（本机为 `v4.1.105`）已原生内置 CLI 与 `--mcp stdio`，即便暂不导入 `.eext`，Antigravity 也可通过 `easyeda-cli` / 原生 MCP 直接连接操作。
