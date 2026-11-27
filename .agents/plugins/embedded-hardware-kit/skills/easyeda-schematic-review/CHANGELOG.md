# Changelog

All notable changes to this project are documented in this file.

本文件记录项目的重要变更。

## [0.0.2] - 2026-11-20

### Added / 新增

- CLI mode: `--source cli --project <eprj3>` reviews a local project through the desktop client CLI (no Bridge); `--page`, `--cli`, `--cli-show`, `--invoke-timeout`.
  CLI 模式：经桌面客户端 CLI 审查本地 `.eprj3` 工程（无需 Bridge）；支持 `--page`、`--cli`、`--cli-show`、`--invoke-timeout`。
- `--full`: no caps on packets, findings, screenshots or open questions; incomplete AI packets fail the run (exit 6).
  `--full` 全量输出：解除审查包/结论/截图/开放问题上限，未审完的 AI 包视为失败。
- 19 new rules (55 total, R001–R060): R040–R060; R057 reserved, R059 as an open question.
  新增 19 条规则（共 55 条，R001–R060）；R057 预留、R059 实现为 open question。

### Fixed / 修复

- BOM TSV parsing: EasyEDA exports tab-separated, which produced ~106 noise findings on a real board.
  BOM 按 TSV 解析：嘉立创导出实为制表符分隔，此前在真实板卡上产生约 106 条噪声。
- Merge: an independent AI P0 is no longer absorbed by a rule finding; AI enhancements accumulate in `aiEnhancements[]`.
  合并：独立 AI P0 不再被规则条目吸收；多条 AI 增强全部保留（`aiEnhancements[]`）。
- Screenshots: page keys carry the schematic dimension; page/component and cached-SVG identity are verified before cropping (no wrong red boxes).
  截图：页键带原理图维度；裁剪前校验页/器件与缓存 SVG 身份，不再画错框。
- CLI: waits for the project to finish loading before opening a page.
  CLI：打开图页前等待工程加载完成，避免采集超时。

### Changed / 变更

- `--source cli` added alongside `live`/`file`; R023 promoted to standard; page names are unique `Schematic / Page` labels.
  新增 `--source cli`（与 `live`/`file` 并列）；R023 提升到 standard；图页统一为唯一的“原理图 / 图页”标签。

## [0.0.1] - 2026-11-19

- Initial release: deterministic rules, packet-based AI review, offline HTML report with annotated screenshots.
  首次发布：确定性规则、逐包 AI 审查、带红框截图的离线 HTML 报告。
