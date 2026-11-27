# Embedded & JLCEDA Hardware Engineering Rules & Persistent Memory

## 1. Core Engineering Rules (Always On)
1. **Evidence First**: Always inspect actual project artifacts (`.ioc`, `.enet`, `.eprj3`, datasheets, schematics, netlists, BOMs, or live `lceda-pro` CLI/MCP output) before asserting pinouts, peripheral multiplexing, register definitions, component footprints, or API signatures.
2. **Zero Fabrication**: Never invent LCSC `Cxxxxxx` part numbers, IC pin numbers, pad mappings, MCU register bitfields, or EasyEDA API methods. Mark any unverified parameter explicitly as `[待核实]`.
3. **Safety Gates**:
   - Ask for user confirmation before destructive EasyEDA Pro canvas operations (batch moves, net/track deletions, copper re-pours, project overwrites) or risky hardware/motor bring-up actions.
   - Always verify current limits, dead-time configuration, gate drive clamping, and hardware fault handling (`nFAULT` / timer `BKIN` break inputs) before enabling power stages.
   - Never proceed past pre-payment/cart staging on JLCPCB/LCSC orders without explicit user confirmation.

## 2. Verified Local JLCEDA Pro Environment Memory
- **Installed Client**: 嘉立创EDA专业版（国内版 `lceda-pro`）**v4.1.105** at `D:\lceda-pro\lceda-pro.exe` (verified 2026-11-27).
  - Official AI CLI docs bundled at `D:\lceda-pro\docs\cli-for-ai.md`, `easyeda-cli.md`, `easyeda-format.md`.
  - **PATH & Legacy Install Caution**: Stale `E:\lceda-pro` may appear in `PATH`, and a legacy **v2.2.32.3** copy exists at `C:\Program Files\lceda-pro` (`cliCapable: false`, probes time out). Always invoke `D:\lceda-pro\lceda-pro.exe` (v4.1.105) explicitly.
  - **Windows PowerShell Gotcha (CRITICAL)**: `& "D:\lceda-pro\lceda-pro.exe" ...` returns **empty stdout** in PowerShell unless piped through `| Out-String` or captured via `Start-Process -Wait -RedirectStandardOutput`.
  - **Native Bridge & MCP**: `D:\lceda-pro\lceda-pro.exe doctor` connects natively (`versionMatch: true`, `resultChannel: true`), and `D:\lceda-pro\lceda-pro.exe --mcp stdio` exposes official MCP tools (`lceda-pro.help`, `lceda-pro.discover`, `lceda-pro.call`) registered as `embedded-hardware-kit_lceda-pro`.
  - **Runtime Authority**: Always query `lceda-pro --help` and `lceda-pro doc api|format|external` of the installed version before invoking commands or APIs; never trust memorized signatures.
- **Alternative Local Bridge Backup**: `D:\EDAhelper\JLCEDA-MCP-main` (VS Code/Cursor `mcp-hub` + `mcp-bridge.eext`, kept as fallback).
- **Cross-Device Sync Repository**: `https://github.com/lyf2010000/666` (local clone at `C:\Users\Temp\Documents\Codex\2026-11-22\stm32-foc\666`). Before editing rules/skills/notes, `git pull` `666` to stay synced across devices.

## 3. JLCEDA & Hardware Skill Routing Matrix (Installed in `embedded-hardware-kit`)
Choose the right skill for the task instead of mixing workflows:
- **`jlceda-pcb-design`** (user custom): 4-phase gated PCB workflow, JLCPCB DFM process rules (2/4-layer 1oz/2oz), 24V/STM32 FOC power-stage self-check (`DRV8320S` / `INA240` / `LMR14020` / `TJA1051T/3`), adversarial review.
- **`easyeda-cli`** (official `easyeda/easyeda-cli-skill`): Driving `D:\lceda-pro\lceda-pro.exe` v4.1.105 directly via built-in CLI (`open`, `session`, `invoke`, `doc`, exports) without extra extensions.
- **`easyeda-eprj3`** (official `easyeda/easyeda-eprj3-skill`): Creating, editing, and deterministically validating `.eprj3` project folders (two-way sync with `lceda-pro open`), including local ERC/DRC/netlist verification scripts (`scripts/`).
- **`easyeda-schematic-review`** (official `easyeda/easyeda-schematic-review-skill`): Read-only schematic & `.enet` netlist review generating self-contained HTML reports with annotated screenshots (supports CLI mode, Bridge mode, or offline `.enet`).
- **`easyeda-api`** (official `easyeda/easyeda-api-skill`): In-editor JS / `eda.*` extension API development and WebSocket bridge (`Run API Gateway` `.eext`, ports `49620–49629`).
- **`stm32-embedded-dev`** (user custom): STM32G4/STM8 CubeMX `.ioc` validation, TIM1/TIM8 complementary PWM + ADC sync, 6-stage FOC bring-up, embedded C/C++ ISR safety review.
