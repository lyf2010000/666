---
name: jlceda-pcb-design
description: >-
  Use this skill when designing, reviewing, or operating EasyEDA Pro (嘉立创EDA专业版)
  schematics, PCBs, BOM/CPL files, or JLCPCB manufacturing outputs—including pinout
  verification, LCSC part sourcing, 2/4-layer layout planning, power/FOC motor-driver
  hardware self-checks, ERC/DRC validation, and driving EasyEDA Pro via MCP or the
  official Run API Gateway bridge.
---

# 嘉立创EDA（EasyEDA Pro）PCB 设计、核对与自检工作流

本 Skill 综合了开源社区成熟验证的 PCB Agent Skill 工程实践（`easyeda/easyeda-api-skill`、`daishuge/pcb-skill`、`oaslananka/easyeda-mcp-pro`、`Zero1683/PCB-Design-Skill`），面向 **嘉立创EDA专业版 + 嘉立创打样/SMT（JLCPCB / LCSC）** 全流程。

## 核心铁律（必须遵守）

1. **证据优先，严禁猜测（Evidence First）**：
   - 必须优先读取实际工程文件（`.ioc`、原理图/PCB 图纸、网表、BOM、数据手册或已连接的 EasyEDA Pro 实时画布数据）。
   - 绝不编造立创编号（`Cxxxxxx`）、芯片引脚号、封装焊盘顺序或 EasyEDA API 方法名；无法直接核实的项必须明确标注 **`[待人工核实]`**。
2. **明确区分“已核实”与“建议/推断”**：
   - 任何审查结论必须标明依据来源（数据手册章节、CubeMX 引脚表、实际图纸坐标或实测网表）。
3. **操作安全闸门（Safety Gates）**：
   - 通过 MCP / Run API Gateway 对 EasyEDA Pro 画布执行**批量移动、删线、改网表、铺铜重绘**等修改前，先读取当前状态/截图，并说明改动范围再执行；重大结构改动前先征得用户确认。
   - AI 审查不能替代最终人工 ERC/DRC 与下单前复核；涉及下单/付款流程一律在支付前停止并交由用户确认。

---

## 四阶段闸门工作流（Gated Workflow）

根据用户当前所处阶段进入对应步骤，**上一阶段硬约束未澄清前不盲目推进下一阶段**。

### Phase 1：需求与工艺约束冻结
先确认会影响物理板子的硬约束（缺项则向用户列出简短确认项）：
- **板材与叠层**：层数（2 层 / 4 层）、板厚（默认 1.6mm）、外层铜厚（`1oz` 常规 / `2oz` 大电流功率板）、内层铜厚（`0.5oz` / `1oz`）。
- **尺寸与结构**：板框尺寸、安装孔位置与孔径（M2/M3、是否接地）、对外接口朝向（电源 XT60/MR60、USB-C、CAN、SWD、排针防干涉）。
- **电气与散热边界**：输入电压范围、持续/峰值电流（决定线宽、铜厚、过孔阵与 TVS/电容耐压）、是否需要散热器或底部裸露焊盘（EPAD）导热过孔。
- **采购策略**：手工焊接 / 嘉立创 SMT 贴片（是否优先基础库 Basic Parts 以省换料费）。

### Phase 2：原理图、引脚与立创配单核对
1. **MCU 与外设零冲突校验**：对照芯片数据手册或 `.ioc` 文件，核查每个引脚复用功能（避免把不支持 I2C/ADC/互补 PWM 的引脚错配）、电源域、晶振、BOOT0、SWD/NRST。
2. **封装后缀与引脚顺序核对（高频翻车点）**：
   - 逐颗核对芯片**完整订货型号后缀**与封装符号是否一致（例如 `INA240A2DR` SOIC-8 与 `INA240A2PWR` TSSOP-8 引脚顺序不同）。
3. **关键外围电路逐项体检**：
   - 电源树（Buck 反馈分压、肖特基耐压、电感饱和电流、LDO 压差与输入/输出电容、TVS 击穿电压）。
   - 驱动芯片/高压芯片（电荷泵电容、自举电容、`VCP` 接法、`DVDD` 内部输出禁止短接外部电源、开漏引脚上拉）。
   - 通信与接口（USB-C `CC1`/`CC2` 独立 `5.1kΩ` 下拉、CAN 双电源 `VCC=5V`/`VIO=3.3V` + ESD + 120Ω 终端）。
   - 详细硬件/功率/FOC 核对清单见：[references/power-foc-checklist.md](./references/power-foc-checklist.md)。
4. **BOM 核对**：检查器件值、精度、耐压（电容按工作电压 ≥1.5~2 倍降额）、封装、数量、立创编号，标明未验证库存/价格的估算项。

### Phase 3：PCB 布局、布线与对抗式自检
1. **先评估可布通性与分区**：
   - 强弱电/功率与模拟分区明确，优先规划主回流路径（`24V -> 高边 MOS -> 相线 -> 电机 -> 低边 MOS -> PGND`）和完整地平面（四层板优先 `Inner1` 做完整 `GND`）。
   - 去耦电容紧贴电源引脚、晶振紧靠 MCU 并包地、差分线（USB `D+/D-`、CAN `H/L`、电流采样开尔文线）等长紧凑走线。
2. **嘉立创 DFM 工艺校验**：
   - 按板层与铜厚核对最小线宽/线距、过孔内径/外径、盘中孔/塞孔、铜皮到板边距离、丝印线宽与避让焊盘。
   - 工艺参数速查见：[references/jlcpcb-dfm-rules.md](./references/jlcpcb-dfm-rules.md)。
3. **对抗式审查（Adversarial Review）**：
   - 假设“这块板子第一次上电就会冒烟或不工作”，主动从以下角度找致命缺陷：
     - 电源短路 / 反接 / 内部 LDO 与外部电源互顶；
     - 封装镜像、Pin 1 标错、二极管/TVS 极性反接、接插件公母或线序反转；
     - 器件机械碰撞（电解电容高度、XT60/MR60 焊接空间、排针与螺丝柱干涉、插件焊盘遮挡）；
     - 采样回路串错电阻或未从采样电阻焊盘内侧开尔文引出；
     - 过孔/线宽载流不足或散热焊盘（EPAD）未打过孔阵列。

### Phase 4：制造输出与投板前闸门（Gerber / BOM / CPL）
导出发往嘉立创前，按序输出核对结论：
1. **ERC / DRC 零致命报错**（每条忽略的告警必须写明理由）。
2. **Gerber 文件检查**：确认顶/底层线路、内电层、阻焊、丝印、边框（BoardOutline）、钻孔（Excellon/槽孔）齐全且无孤岛铜/悬空线。
3. **SMT 贴片检查（如走嘉立创贴片）**：核对 BOM（位号、规格、封装、LCSC 编号、DNP 标记）与坐标文件 CPL（原点、正反面、极性旋转角度，必要时在嘉立创贴片预览器里逐颗目检方向）。
4. **丝印与首板调试友好性**：电源接口正负极、排针逐脚丝印、板子版本号与日期、关键测试点（`VBUS`/`5V`/`3V3`/`GND`/采样输出）是否清晰可读。

---

## 连接 EasyEDA Pro 实操模式（当已配置桥接 / MCP 时）

当工作环境已接入 EasyEDA Pro 的 **Run API Gateway（`easyeda-api-skill`）** 或 **MCP Server（如 `easyeda-mcp-pro` / `jlceda-mcp`）** 时：
1. 先读取当前打开的工程/文档信息与视口截图，确认处于正确图纸（原理图 vs PCB）。
2. 遵循 **“先读后写 → 小步批量 → 写后截图 + 跑 DRC 验证”** 循环，禁止盲目连续修改。
3. 桥接安装与开源生态参考见：[references/easyeda-pro-bridge.md](./references/easyeda-pro-bridge.md)。

---

## 输出格式规范（审查与自检报告）

执行设计审查或投板自检时，按严重程度分级输出，便于用户逐条消项：
- **🔴 致命阻塞（Must Fix，上电会炸板/无法工作/无法焊接）**：给出具体位号/引脚、原因与精确修改方案。
- **🟡 高风险建议（Should Fix，影响稳定性/EMC/发热/良率）**：说明风险与优化做法。
- **🟢 可选优化（Nice to Have，丝印/测试点/成本/SMT 基础库替代）**。
- **📋 待人工核实项（Needs Human Verification）**：明确列出因缺少实物图纸、数据手册或实时库存而需人工确认的点。
