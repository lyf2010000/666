# 截图与坐标

## 坐标约定（实测）

- 原理图坐标单位 `0.01 inch`；原点在页面左下，Y 向上。
- SVG 导出坐标：`svgX = schematicX`，`svgY = -schematicY`。
- 实测 A4 `viewBox="-10.5 -835.5 1191 846"`，宽高 1191×846。
- 器件 BBox 由 `sch_Primitive.getPrimitivesBBox([primitiveId])` 返回：

```text
svgLeft   = bbox.minX
svgTop    = -bbox.maxY
svgWidth  = bbox.maxX - bbox.minX
svgHeight = bbox.maxY - bbox.minY
```

`getPrimitivesBBox` 一次只返回一个并集 BBox；需要逐器件 BBox 时必须逐个调用。

## 页面导出

```js
const file = await eda.sch_ManufactureData.getExportDocumentFile(
  'page', 'SVG', undefined, 'Current Schematic Page'
);
const svg = await file.text();
```

- 页面 SVG 缓存在运行目录 `page-<pageFileKey>.svg`。
- `pageFileKey` **带原理图维度**：`<schematicName>__<pageName>`（保留中文等 Unicode 字母/数字，替换文件系统非法字符，Windows 保留名加前缀）；键碰撞时追加短页 UUID 后缀。两个原理图的同名图页（如都叫 `P1`）因此不会互相覆盖 geometry 条目与 SVG。
- 当前页同时注册 `__current__` 别名与真实键；逐页导出跳过已采集的当前页。
- 多页导出会切换当前图页；`try/finally` 恢复原文档。

## 页选择与校验（宁可占位，不画错框）

**EasyEDA 图元 uid 是页内局部的**：不同原理图/图页的 `ggeN` 会重复，同一 uid 在另一页是不同物理器件（实测某工程两页 27 个 uid 全部碰撞、位号全不同）。因此：

1. `choosePage` 按优先级生成候选页：`location.pages` 命中的键/页名/页键/“原理图 / 图页”标签 → 包含 finding uid（含 nets 展开）的页 → `__current__` → 全部页；
2. 每个候选页裁剪前必须通过校验：
   - finding 的 uid 至少一个在该页 `components` 中；
   - 所有在场 uid 的 geometry 位号与网表位号一致（uid 身份校验）；
   - 显式 `location.uids` 的位号与 `finding.location.designators` 一致（nets 展开的邻居器件不受此限）；
   - 仅带位号的 finding 经 `designatorIndex` 校验，只信任网表确认的 uid；
3. 全部候选不匹配 → 占位“截图不可用（页/器件不匹配）”，计入 `screenshots.failed`；
4. **缓存 SVG 身份校验**：SVG 根 `viewBox` 与 collect 记录的 `page.svgViewBox` 不一致（空白归一化后比较）→ 缓存被其他页覆盖（旧版页键不含原理图维度），占位“截图不可用（页面 SVG 与几何不匹配）”，重新 collect 修复。

`comp.page` / `finding.location.pages` / packets 的 `facts.page` 一律写唯一“原理图 / 图页”标签（如 `瑞萨核心 / P1`），`comp.pageKey` 写 `pageFileKey`；scope `page:P1` 仍兼容裸页名（忽略大小写）。

## 本地裁剪

1. 读取缓存的 `page-*.svg`；
2. 将根 `<svg>` 的 `viewBox` 改为目标区域（外扩 40 单位）；
3. 将 `width/height` 设为区域尺寸的 2 倍（上限 2000）；
4. 在 `</svg>` 前插入 `<rect>`：

```html
<rect x="minX" y="-maxY" width="maxX-minX" height="maxY-minY"
      fill="rgba(220,38,38,0.12)" stroke="#DC2626" stroke-width="2"
      vector-effect="non-scaling-stroke"/>
```

- 退化 BBox（缺失、零面积、NaN）不得画框；返回占位卡片并计入 `screenshots.failed`。
- `map_pages=false` 且器件不在当前页时，不画红框，显示占位提示。
- 并集面积 > 页面 70% 时，退回首个器件区域，避免整页截图。

## 可选 PNG（v1.1）

只有 `--image-format png` 且 Bridge 可用时，才把 SVG 送给 `OffscreenCanvas` 光栅化；Bridge 断开/离线自动回退 SVG。v1 默认纯 Node，不依赖 Canvas。
