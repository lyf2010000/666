# 规则目录（v1.0）

> 这里是**确定性规则引擎**实现的 55 条规则（`R001~R060`，剔除废弃/预留号 R021/R022/R024/R057/R059）。
> 完整的 AI/人工审查面见 `references/review-checklist.md`（约 280 项，含电源树、保护、时序、
> 模拟、接口、安规、可制造性等）。规则只是清单中可自动化的子集。

模式口径：`quick` 跑确定性规则集；`standard` 跑全部 v1 核心规则；`strict` 额外跑 strict-only。
规则只使用 `categoryConfidence >= medium` 的分类；低置信度时跳过并记录。

| ID | 规则 | 级别 | 模式 | 证据 |
| --- | --- | --- | --- | --- |
| R001 | 单引脚网络 | P2 | quick | net + pin |
| R002 | 器件引脚悬空 | P1/P2 | quick | pin |
| R003 | 重复位号 | P0/P3 | quick | component × N |
| R004 | 网络无引脚 | P2 | quick | net |
| R005 | DRC 悬空网络 | P2 | quick | drc (+ net) |
| R006 | 电源/地引脚悬空 | P0/P1 | quick | pin |
| R007 | 电源网络无来源 | P2 | standard | net + 拓扑 |
| R008 | IC 去耦缺失 | P2 | standard | pin + net |
| R009 | I2C 上拉缺失 | P1 | standard | net |
| R010 | 复位上拉缺失 | P2 | standard | pin + 相邻器件 |
| R011 | BOOT 引脚悬空 | P1 | standard | pin |
| R012 | 晶振负载电容缺失 | P2 | standard | crystal + net |
| R013 | LED 限流电阻缺失 | P1 | standard | led + net |
| R014 | 差分对不完整 | P2 | quick | net / differentialPairGroups |
| R015 | 连接器电源/地引脚悬空 | P1 | quick | pin |
| R016 | 缺值/占位值 | P2/P3 | quick | component:Value (+ bom) |
| R017 | 缺封装 | P1 | quick | component |
| R018 | BOM/PCB 标志组合 | P3 | standard | component 属性 |
| R019 | 料号缺失 | P3 | standard | component 属性 |
| R020 | 网络名近似重复 | P3 | standard/strict | net × 2 |
| R023 | 电源入口保护缺失 | P3 | standard/strict | net + 连接器 |
| R025 | 关键电源轨缺测试点 | P3 | strict | net |
| R026 | BOM/网表一致性 | P2/P3 | quick | bom |
| R027 | 未用运放通道输入悬空 | P3 | strict | pin |
| R028 | 未用逻辑门输入悬空 | P2 | strict | pin |
| R029 | 电源/地网络冲突 | P0 | quick | pin × N / component |
| R030 | MOSFET 栅极缺少下拉 | P2 | standard | pin + 电阻 |
| R031 | 三极管基极缺少限流电阻 | P2 | standard | pin + 电阻 |
| R032 | 继电器线圈缺少续流二极管 | P1 | standard | pin + 二极管 |
| R033 | 稳压器反馈分压不完整 | P2 | standard | FB pin + 电阻 |
| R034 | 稳压器使能脚悬空 | P1 | standard | pin |
| R035 | 两脚器件两端同网络 | P2 | standard | pin × 2 |
| R036 | 稳压器输出缺少电容 | P2 | standard | OUT pin + 电容 |
| R037 | LED 极性可能反接 | P1 | standard | pin A/K |
| R038 | 电解电容极性可能反接 | P1 | standard | pin +/- |
| R039 | 继电器续流二极管方向错误 | P1 | standard | relay + diode |
| R040 | 孤立地网络 | P2 | standard | net + 拓扑 |
| R041 | UART 同方向引脚互连 | P1 | standard | pin × N |
| R042 | 稳压器输入缺少电容 | P2 | standard | IN pin + 电容 |
| R043 | 光耦输入缺少限流电阻 | P2 | standard | pin + 电阻 |
| R044 | CAN/RS-485 总线缺终端电阻 | P3 | strict | net × 2 + 电阻 |
| R045 | SWD 调试对不完整 | P3 | strict | net |
| R046 | 复位脚直连电源/地（固定电平） | P0/P1 | standard | pin + net |
| R047 | 同一电源轨多个电源输出直接并联 | P1 | standard | net + component × N |
| R048 | USB-C CC1/CC2 缺 Rp/Rd 或悬空 | P1 | standard | pin |
| R049 | MCU 内核稳压脚（VCL/VCAP）缺储能电容 | P1 | standard | pin + net |
| R050 | 同一料号对应多个不同值 | P1 | standard | component/bom 属性 |
| R051 | 电源选择跳线无默认状态 | P2 | standard | component + pin × N |
| R052 | VREFH/VREFL 参考脚缺去耦/参考源 | P2 | standard | pin |
| R053 | 去耦电容数量少于电源引脚数 | P3 | strict | component + pin × N |
| R054 | 连接器数据线缺 ESD/TVS 保护 | P2 | standard | pin + net |
| R055 | 跨电源域直连缺电平转换 | P2 | strict | net + 拓扑 |
| R056 | LED 限流估算超出 0.5–20mA | P3 | standard | led + 电阻 + 电源域 |
| R058 | 晶振节点引到连接器/排针 | P3 | standard | crystal + net |
| R060 | 连接器引脚使用无语义自动网络名 | P3 | strict | component + pin × N |

预留号：R021（废弃）、R022/R024（预留）、R057（LDO 最小输出电容，需器件库支持，v1.1）、
R059（SWD 排针线序，无统一标准，实现为 open question 而非编号规则）。

## 误报边界

同一对象命中多条规则时按抑制组去重：引脚级 `R046 > R048 > R006 > R015 > R011 > R027 > R028 > R034 > R036 > R042 > R008 > R010 > R002`，
网络级 `R005 > R004 > R001`（前者更具体，后者不再重复报告）。

### R001
- `testpoint` / `antenna` 器件、位号前缀 `TP/TEST/ANT/JMP`、单针连接器豁免。
- 电源符号/网络标签不是器件，仍可能产生单引脚网络；报告保留以便人工确认。
- 同一网络已有 R005（DRC 悬空）时不再报 R001。

### R002
- `noConnect === true` 跳过。
- 无 `pins.json` 时降为 `P2/medium`，文案提示"可能故意不接"。
- 引脚名为 `NC/DNC/NO_CONNECT/RESERVED`（含 `RF_NC`、`PA0(NC)`、`NC_1` 等前后缀写法）时转为 open question，不报 finding。
- Type-C `SBU1/SBU2` 悬空转为 open question（USB2.0 应用通常故意不接），不报 finding。
- 复合引脚名（如 `P010/VREFH0`）按 `/` 分段匹配控制/电源/地模式。

### R003
- 相同非空 `Group ID`、位号后缀 `U1A/U1B`、同 Device/Manufacturer Part 且引脚号集合不相交（或仅电源脚重叠）视为多部件，不报或降 P3。

### R004 / R005
- R005 对 DRC `SHOWDANDLING` 的网络无论是否存在于模型都报告；网络不存在时用 `drc.primitiveId` 作为证据。
- R005 优先于 R004（更具体）。

### R006 / R015
- 引脚名匹配电源/地模式且 `net === ""`。
- `noConnect === true` 时降 P1/medium，不按 P0。
- 同一引脚 R006 优先于 R015、R002。

### R007
- 从电源网络出发，最多 5 跳，经 2 引脚无源件（R/C/L/FB/FUSE/SW）寻找连接器、稳压器、电池等来源。
- 引脚名本身即电源输出证据：`VBUS/VOUT/VO/V3/3V3OUT/5VOUT` 等视为来源（CH330N 的 V3、LDO 的 VOUT 即使被分类为 ic 也能识别）。
- 2–3 脚、全部引脚都在非地电源网络上的非无源器件视为电源选择跳线，允许穿越（HEAD3 跳线选 VCC 的场景）。
- 电源符号不是器件，只有网络标签的板子可能被报；这是有意保留的审查提示。

### R008
- 仅检查 `ic` / `regulator` 的电源引脚网络；电容必须在同一网络与地之间，或经磁珠/0Ω 电阻一跳到地。
- `powerKind === "reference"` 的 `VREF/VPP` 跳过；引脚名分类为 reference（含复合名 `P010/VREFH0`）也跳过，交由 R052。
- 同一引脚已有 R036/R042（输出/输入电容更具体）等报告时按抑制组去重。

### R009
- 网络名匹配 `SCL/SDA`（含前后缀与序号，如 `I2C_SCL0`、`MCU_SDA1`）。
- 排阻存在但内部拓扑未知时转 open question，不直接报 P1。

### R010
- 复位引脚名覆盖 `RST/NRST/RESET/NRESET/RES/XRES/MCLR`（含序号与 `_N/N/#` 后缀），复合名按 `/` 分段匹配。
- 连接器、测试点、机械件不参与；复位脚直接 tied 到电源/地属于固定电平，交由 R046 报危险极性，不在上拉检查范围。
- 同一引脚已有 R046 等更具体报告时按抑制组去重。

### R012 / R013
- 晶振两侧都需要对地电容；接地/电源焊盘不参与判定；带电源引脚的有源振荡器整体跳过。
- LED 以整体判定，A/K 任一侧有串联电阻即可。
- 位号 `D` 的 LED 可能被分类为 `diode`，导致 R013 漏报；该限制写入报告。

### R014
- 差分对组只有 P 或 N（或 DP/DM）时报；命名回退识别 `_P/_N`、`_DP/_DM` 与 `+/-` 后缀（如 `USB_D+` 缺 `USB_D-`）。
- 电源/地/自动网络不参与 `+/-` 后缀判定。

### R016
- 判定 `rawValue`，不是 `displayValue`；`valuePlaceholder` 由 parse 预计算（含 `NC/N/C/DNP/DNI`）。
- 连接器、测试点、机械件不报。
- `Add into BOM=false`（dnpCandidate）仅产生 open question，不产生 high-confidence finding。
- `Add into BOM`/`Convert to PCB` 属性缺失时按 yes 处理（普通器件语义），并写入 model.warnings。
- BOM 交叉核对：BOM 已提供有效值（非占位、非封装代码如 0805）时，网表缺值只是标注不完整，降为 `P3/medium`（`params.inBom=yes`）。

### R018
- `addIntoBom=true && convertToPcb=false` 或反向组合报 P3；机械件/测试点跳过。

### R020
- 排除自动网络 `$...`、电源/地网络、完全相同名称。
- 排除端口/引脚式自动名（`P000`、`UART1` 等 `^[A-Za-z]{1,4}\d+$`）与长度 ≤3 的短名（`DN/DP/TX/RX`）。
- 排除互补后缀的有意配对：`DP/DM`、`DP/DN`、`P/N`、`+/-`、`H/L`、`A/B`、`TX/RX`、`SCL/SDA`、`POS/NEG`（忽略末尾序号）。
- standard：归一化后 Levenshtein ≤ 1；strict：≤ 2。

### R023
- standard 起启用（USB 供电板在 standard 下也需要入口保护检查）：电源轨被连接器触及且同网络无 fuse/tvs 时报 P3/low。
- 保护器件在轨的下游（经磁珠/电阻之后）检不出来，提示人工确认入口路径。

### R026
- BOM 不可用时跳过并写入 `coverage.skippedRules`。
- 自动识别分隔符：嘉立创 EDA `getBomFile('bom','csv')` 实际导出 TSV（制表符分隔），按首行 `\t`/`,`/`;` 计数取最多者；带引号逗号 CSV 仍兼容。
- 支持 UTF-8/GBK 与中英文列头；数量/位号/料号不一致分别报；料号比较忽略空白与大小写。
- 数量 >10000 视为疑似列错位，只产生 warning，不产生 finding。

### R029
- 同一网络同时存在电源与地属性引脚 → P0。
- 两条不同电源轨经 0Ω/跳线/焊盘直接合并 → P0；0Ω 识别覆盖 `0/0R/0Ω/0OHM/0R0/0.0/000` 等写法。
- `VREF/VPP` 为 reference，不参与"电源轨互短"的简单判定。

### R030 / R031
- 仅当栅极/基极已联网且未找到到源极/地/驱动侧的电阻时报告。
- 栅极由推挽驱动或基极由恒流源驱动时可能误报；只报 P2/medium，报告注明需结合驱动方式确认。

### R032
- 仅对 `relay` 类别且线圈两端都有网络的器件检查；固态继电器/光耦继电器可能不需要续流二极管，分类为 `relay` 时需人工确认。
- 二极管必须跨接在线圈两端；串联在驱动回路中不算续流。

### R033
- 仅对 `regulator` 且存在 FB/VFB/FEEDBACK/ADJ 引脚的器件检查；多个 FB 引脚逐一检查。
- 固定输出版本可能没有外部 FB 分压；若 FB 引脚存在但网络为空，R002/R033 会提示，最终以数据手册为准。

### R034
- 仅对 `regulator` 的 EN/ENABLE/SHDN/UVLO 引脚检查；多个使能引脚逐一检查。
- 使能脚可能由内部上拉/下载或外部逻辑驱动；无网络时仍报 P1/medium，提示核对默认状态。

### R035
- 仅对两端都有网络的 2 引脚无源/分立器件检查。
- 0Ω/跳线明确标注时豁免；开关/测试点/连接器不参与。
- 同一网络可能是画图时的临时短接，通常应视为错误。

### R036
- 仅对 `regulator` 的 OUT/VOUT/VO 引脚检查（多路输出逐一检查）；输出电容必须直接到地（经磁珠/0Ω 的间接去耦暂不视为输出电容）。
- 某些模块内部已有输出电容或允许无电容，需以数据手册为准。

### R037
- 仅在 LED 有 A/K 引脚名且阳极网络为地时报告；阳极接地几乎总是反向偏置。
- 若符号库用 `1/2` 而不是 `A/K`，规则不触发，转入人工复核。

### R038
- 仅对引脚名为 `+`/`-` 的极性电容检查；普通陶瓷电容不参与。
- 正极接地或负极接电源轨都视为反接；需结合封装极性标记确认。

### R039
- 仅当继电器线圈一端是电源网络、且能找到跨接在线圈两端的二极管时检查方向。
- 二极管阳极接电源侧视为错误；若线圈两端都不是电源网络，跳过。

### R040
- 设计至少有两个地网络时才检查；`EARTH/CHASSIS/FG` 等安规地允许有意隔离，不参与。
- 直流通路指经 2 引脚电阻/电感/磁珠/保险丝/开关/二极管/网络桥最多 3 跳到达其它地网络；仅电容耦合不算直流连接。
- 有意隔离的模拟地/功率地可能误报，报 P2/medium 并提示确认设计意图。

### R041
- 网络上有 ≥2 个 TX/TXD/TXO 引脚且无 RX/RXD/RXI 引脚（或反向）时报。
- 连接器/测试点引脚名通常标注信号名而非方向，不参与计数。
- 个别器件引脚方向定义与惯例相反时可能误报，需核对数据手册。

### R042
- 仅对 `regulator` 的 IN/VIN/VI 引脚检查；输入电容允许经磁珠/0Ω/电感一跳（输入滤波常见）。
- 模块内部已有输入电容时可能误报，以数据手册为准。

### R043
- 输入侧引脚按 `A/AN/ANODE/+` 与 `K/CATH/CATHODE/-` 识别；地网络不作为限流路径。
- 引脚名为数字的 4 脚光耦按常见引脚排列（1/2 脚为输入）推测，只产生 open question。

### R044
- 网络名归一化后匹配 `CANH/CANL`、`CANP/CANN`、`485A/485B` 对；两网络间无电阻时报 P3/low。
- 分裂终端（2×60Ω+电容）与板外终端检不出来，仅 strict 启用并提示人工确认。

### R045
- 设计中只有 SWDIO 或 SWCLK 之一时报；两者都存在时不检查数量配对。
- 仅 strict 启用；JTAG 复用 SWCLK 的调试口可能误报。

### R046
- 复位脚（`RST/NRST/RESET/NRESET/RES/XRES/MCLR`，复合名按 `/` 分段）直接连地 → P0（持续复位，板子不工作）；直接连电源 → P1（复位永不生效）。
- 连接器/测试点/机械件不参与；经电阻上拉/下拉的正常复位电路不报（那是 R010 的范围）。
- 极性判断依赖引脚名；低有效复位接电源与高有效复位接地的语义相反，报 P1/medium 提示核对数据手册。

### R047
- 同一非地电源轨上 ≥2 个不同器件的电源输出引脚（`VOUT/VO/V3/VCORE_OUT/3V3OUT/5VOUT`）直接并联 → P1/medium。
- 连接器/测试点不算输出源；经 0Ω/磁珠/二极管隔离的并联检不出来（R029 负责直接短接场景）。
- 有意均流设计（部分 LDO 支持并联）可能误报，需核对数据手册。

### R048
- 器件同时存在 CC1 与 CC2 引脚（USB-C 特征）时逐一检查：悬空或无 Rp（到电源）/Rd（到地）电阻 → P1/medium。
- 仅 USB2.0 设备也必须有 Rd，否则主机不供电；CC 引脚经电阻到电源/地即豁免。
- 引脚名不是 CC1/CC2 的 Type-C 符号（如 `CC1/CC2` 复合名）按分段匹配。

### R049
- MCU 内核稳压脚 `VCL/VCAP/VCORE/VDDCORE/VREG`（瑞萨 RA 系列 VCL 等）：无对地储能电容，或电容网络同时引到连接器 → P1/medium。
- 该电容是内核 LDO 的储能元件，不是普通去耦；引到排针会引入噪声/ESD 风险。
- 仅 ic/regulator 类别参与；引脚名不匹配时不报。

### R050
- 按网表属性与 BOM 行中的 `Supplier Part`/`Manufacturer Part` 分组，同组出现 ≥2 个不同值 → P1/medium。
- 值归一化：µ→u、忽略空白与大小写；占位值与封装代码（0402/0805 等）不参与分组。
- 同一料号不同值通常意味着 BOM 错误、贴片混料或原理图值标注错误；按位号集合去重避免网表/BOM 双报。

### R051
- 2–3 脚、全部引脚都在 ≥2 个不同非地电源网络上的 connector/ic/other 器件 → P2/medium（电源选择跳线无默认状态）。
- 磁珠/电感/0Ω 电阻等无源件不参与（那是 R029 的电源轨互短场景）。
- 提示确认出厂默认跳线位置与丝印标注；不判断哪个位置正确。

### R052
- `VREFH/VREFL/VREF+/VREF-`（含序号，复合名按 `/` 分段）参考脚无对地电容 → P2/medium。
- 仅 ic/regulator 类别参与；参考脚接固定电平且无去耦时 ADC 精度受影响。
- 外部参考源经电阻/磁珠供电的场景检不出来，提示人工确认。

### R053
- 仅 strict：ic/regulator 的电源引脚数（不含地与 reference）> 直接对地去耦电容数时报 P3/low。
- 电容必须同网络到地（经磁珠/0Ω 一跳也算）；共享电容按器件去重计数。
- 模块内部集成去耦时可能误报；只作提示，不作为缺陷。

### R054
- 连接器引脚网络名匹配数据线模式（`DP/DM/DN/D+/D-/USB/CANH/CANL/485A/485B/ETH/TXP/TXN/RXP/RXN`）且同网络无 tvs 类别或 ESD/TVS 描述器件 → P2/medium。
- 板内已有 TVS 但不在同一网络（经电阻之后）检不出来；热插拔接口建议人工确认保护路径。

### R055
- 仅 strict：非电源/地/自动网络上有 ≥2 个 ic/regulator，且各自电源域电压可解析且不同（如 5V 与 3V3）→ P2/low。
- 器件电源域取可解析电压引脚的众数；多域器件（众数并列）跳过；网络上有电阻时跳过（可能是分压/限流电平转换）。
- 电源轨名不可解析（如跳线可选 VCC）时不做判断；开漏+上拉等合法跨域连接可能误报。

### R056
- LED 供电电压取直连电源轨，或驱动 IC 的主电源域（GPIO 驱动场景）；串联电阻值按 `rawValue → name → displayValue` 顺序取第一个可解析值，封装代码（0805 等）不当作阻值。
- 估算 `iMax=(V-1.8)/R`、`iMin=(V-3.3)/R`（Vf 1.8–3.3V 覆盖红到蓝白）；iMax<0.5mA 或 iMin>20mA 时报 P3/medium。
- 电源域不可解析时保持沉默（不做无依据估算）；缺电阻由 R013 负责。

### R058
- 无源晶振（无电源引脚）的信号网络同时引到连接器/排针 → P3/medium（寄生电容影响起振与频率）。
- 有源振荡器整体跳过；晶振网络经电阻隔离后到排针检不出来。

### R060
- 仅 strict：连接器 ≥2 个引脚使用无语义自动网络名（`$...` 或 `^[A-Z]{1,3}\d{3,}$` 如 P000）→ P3/low，按器件聚合。
- 提示补充语义网络名以便审查与调试；不影响电气正确性。

### R059（open question，非编号规则）
- 连接器网络同时含 SWDIO 与 SWCLK 时产生 open question：SWD 排针无统一标准线序，请人工核对与调试器一致。
- 网表无法证明线序对错，不产生 finding。
