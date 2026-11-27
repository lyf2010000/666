# 数据结构

## `model.json`

```json
{
  "schemaVersion": "1.0",
  "source": { "mode": "live|file", "project": "", "board": "", "schematic": "",
              "netlistType": "JLCEDA", "netlistVersion": "2.0.0", "exportedAt": "" },
  "stats": { "components": 0, "nets": 0, "pins": 0 },
  "components": [{
    "uid": "gge1", "designator": "U1", "name": "NE555",
    "displayValue": "NE555", "rawValue": null, "valuePlaceholder": false,
    "footprint": "", "supplierPart": "", "manufacturer": "",
    "manufacturerPart": "", "lcscPartName": "", "partClass": "",
    "datasheet": "", "description": "", "addIntoBom": true, "convertToPcb": true,
    "page": "Schematic1 / P1", "pageKey": "Schematic1__P1",
    "category": "ic", "categoryConfidence": "high", "categoryBasis": ["designator:U"],
    "dnp": null, "dnpConfidence": null, "dnpSource": null, "dnpCandidate": false,
    "pinsAvailable": true,
    "pins": [{ "number": "1", "name": "GND", "net": "GND",
               "pinType": "", "noConnect": false }],
    "props": {}
  }],
  "nets": [{
    "name": "VCC", "pinCount": 3,
    "pins": [{ "uid": "gge1", "designator": "U1", "pin": "8", "pinName": "VCC" }],
    "isAuto": false, "isPower": true, "isGround": false,
    "powerKind": "rail", "netClassConfidence": "high", "netClassBasis": ["power:VCC"]
  }],
  "pinsAvailable": true,
  "drcAvailable": true,
  "geometry": {
    "currentPage": "P1",
    "currentSchematic": "Schematic1",
    "pages": {
      "Schematic1__P1": {
        "pageUuid": "", "pageName": "P1", "pageFileKey": "Schematic1__P1",
        "schematicUuid": "", "schematicName": "Schematic1",
        "pageWidth": 1170, "pageHeight": 825,
        "svgViewBox": "-10.5 -835.5 1191 846",
        "svgPath": "page-Schematic1__P1.svg", "pngPath": null,
        "components": { "gge1": { "designator": "U1", "primitiveId": "",
                                  "bbox": { "minX": 0, "minY": 0, "maxX": 1, "maxY": 1 } } },
        "designatorIndex": { "U1": ["gge1"] },
        "drcPrimitives": { "primitiveId": { "bbox": {} } }
      }
    }
  },
  "drc": [],
  "warnings": []
}
```

`valuePlaceholder` 由 parse 阶段一次计算；R016 只读取，不重复解析 `props`。

## `lint.json`

只保存规则结果与 `messageKey + params`，不保存本地化散文。

```json
{
  "schemaVersion": "1.0",
  "mode": "standard",
  "findings": [{
    "id": "F-001", "source": "rule", "ruleId": "R009",
    "messageKey": "R009.title", "params": { "net": "SDA" },
    "severity": "P1", "confidence": "medium", "category": "interface",
    "evidence": [{ "kind": "net", "net": "SDA", "pins": ["U2.5"] }],
    "location": { "pages": [], "designators": [], "uids": [], "nets": ["SDA"] },
    "heuristic": true
  }],
  "openQuestions": [{ "question": "", "related": [], "why": "" }],
  "coverage": { "skippedRules": [], "suppressedFindings": 0, "rulesEvaluated": [] }
}
```

## `packets/<fileKey>.json`

```json
{
  "packet_id": "component:U1",
  "fileKey": "component-U1",
  "tier": "T0|T1|T2",
  "subject": "U1 ic",
  "facts": { "components": [], "nets": [] },
  "neighbors": [],
  "existingRuleFindings": [],
  "questions": [],
  "checklist": { "domains": ["C-PWR", "C-PRT"], "file": "references/review-checklist.md" },
  "estimated_tokens": 1200
}
```

`fileKey` 只保留 `[A-Za-z0-9._-]`；Windows 保留名加前缀 `_`。

## `findings.ai.<fileKey>.json`

```json
{
  "findings": [{
    "id": "AI-component-U1-001",
    "severity": "P1", "confidence": "medium", "category": "interface",
    "title": "", "observation": "", "impact": "", "suggestion": "",
    "evidence": [{ "kind": "pin", "uid": "gge1", "designator": "U1",
                   "pin": "4", "net": "VCC" }],
    "location": { "pages": [], "designators": ["U1"], "uids": ["gge1"], "nets": ["VCC"] },
    "enhancesRuleFindingId": null
  }],
  "open_questions": []
}
```

证据必须能在当前 packet/model 中找到；merge 会拒绝无效证据。

## `findings.final.json`

在 lint finding 基础上补充：

- `title/observation/impact/suggestion`：当前语言物化文本；
- `findingKey`：规则 `<ruleId>:<sha1(排序后的 evidence 引用键).slice(0,12)>`；AI `<packet_id>:<sha1(subject+evidence).slice(0,12)>`；
- `screenshots[]`、`screenshotPlaceholder`；
- `aiEnhancement`（若 AI 补充了规则 finding）。

`finding.location.pages` 保存唯一“原理图 / 图页”标签（如 `Schematic1 / P1`，
无原理图名时退化为页名），规则与 AI finding 缺省时由 `model.components[].page`
自动推导；`comp.pageKey` 保存带原理图维度的 `pageFileKey`。图元 uid 是页内局部的，
页归属只在 geometry 位号与网表位号一致时认领。报告筛选器直接使用这些唯一标签；
scope `page:P1` 仍兼容裸页名与页键（忽略大小写）。

`coverage` 包含 `componentPercent/netPercent`、`packetsReviewed/Skipped/Failed`、
`partial`、`skippedRules`、`suppressedFindings`、`omittedFindings`、`omittedQuestions`。

## `report.json`

```json
{
  "schemaVersion": "1.0",
  "runId": "2026-11-13-010203",
  "skillVersion": "1.0.0",
  "generatedAt": "",
  "lang": "zh",
  "mode": "standard",
  "source": {},
  "stats": {},
  "findings": [],
  "openQuestions": [],
  "coverage": {},
  "review": {
    "model": "claude-sonnet-5-5",
    "startedAt": "", "endedAt": "", "durationMs": 0,
    "tokens": { "input": 0, "output": 0, "total": 0 },
    "tokensEstimated": false
  },
  "screenshots": { "generated": 0, "failed": 0, "skipped": 0 },
  "artifacts": [{ "path": "report.html", "type": "report", "sha256": "", "bytes": 0 }]
}
```

`review` 来自 `review-context.json`（`--model`、`--tokens-in/--tokens-out` 可覆盖）：
`durationMs = endedAt - startedAt`；`tokens` 缺失时用已完成 packet 的
`estimated_tokens` 与 AI 输出文件估算，并置 `tokensEstimated: true`。

## `manifest.json`

`files` 与 `report.artifacts` 统一为 `{path,type,sha256,bytes}`；
`runId` 等于运行目录名；`status` 依次为 `collecting → collected → linted → awaiting_ai → merged → captured → done`。
