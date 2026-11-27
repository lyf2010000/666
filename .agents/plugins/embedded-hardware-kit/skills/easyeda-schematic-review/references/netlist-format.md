# EasyEDA `.enet` 网表格式

实测环境：EasyEDA Pro V4.1.99，`sch_ManufactureData.getNetlistFile('design','JLCEDA')`。

## 顶层结构

```json
{
  "version": "2.0.0",
  "projectId": "…",
  "components": { "<uid>": { "props": {}, "pinInfoMap": {}, "altLibs": {} } },
  "designRule": { "netRule": { "<net>": { "net": "…", "ruleMap": {} } }, "trackPhysics": {} },
  "differentialPair": {},
  "netClass": {},
  "equalLengthNetGroup": {},
  "differentialPairGroups": {}
}
```

## 器件字段

`components` 是以 UID 为键的对象。每个器件：

| 路径 | 说明 |
| --- | --- |
| `props["Unique ID"]` | 器件 UID，与原理图 `getState_UniqueId()` 对应 |
| `props.Designator` | 位号，如 `U1`、`R1`；多部件可能是 `U1A` |
| `props.Value` | 原始 Value；可能缺失或为表达式 |
| `props["LCSC Part Name"]` | 立创料号名称；常被当作 displayValue 回退 |
| `props["Supplier Part"]` | 供应商料号，如 `C504549` |
| `props.Manufacturer` / `Manufacturer Part` | 制造商与料号 |
| `props.Footprint` / `FootprintName` | 封装 |
| `props["Add into BOM"]` | `yes` / `no` |
| `props["Convert to PCB"]` | `yes` / `no` |
| `props["Group ID"]` | 多部件器件的分组；可能为空 |
| `props.Description` | 描述，可能为空 |
| `pinInfoMap` | 引脚映射；键为引脚号 |

`pinInfoMap` 项：

```json
{ "name": "GND", "number": "1", "net": "GND", "pinClass": "",
  "pinDifferentialPairClass": "", "props": { "Pin Number": "1" } }
```

- `net` 为空字符串表示未连接。
- 引脚电气类型不在网表中；实时模式可通过 `pins.json` 补充 `pinType`。
- `noConnect` 不在网表中；实时模式通过 `pins.json` 补充。

## 网络

- 网络由引脚 `net` 字段聚合得到；`designRule.netRule` 可能包含没有引脚的废弃网络。
- 自动网络名以 `$` 开头（如 `$1N13`），不应参与网络名相似度检查。
- 电源/地分类按名称启发式完成，见 `references/rule-catalog.md`。

## 常见差异

- `Value` 缺失但 `LCSC Part Name` 有值：`rawValue=null`，`displayValue` 回退到料号名。
- `Name` 可能是 `={Value}` 表达式；解析时要按 `props` 展开。
- 多部件器件可能使用相同位号 + 相同 `Group ID`，或位号后缀 `U1A/U1B`。
- BOM 列头随客户端语言变化；解析时同时接受中英文列头。

## 不支持

- Protel2 `.net`：v1 明确不支持；提示用户重新导出 `.enet`（`JLCEDA` 类型）。
- 仿真网表 `getSimulationNetlistFile()`：v1 不使用。
