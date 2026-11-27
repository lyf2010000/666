# EDA DRC 规则名映射

`sch_Drc.check(false, false, true)` 返回数组，每项形如：

```json
{
  "type": "warn",
  "rule": "SHOWDANDLING",
  "primitives": [{ "primitiveId": "...", "sheet": "...", "name": "$1N14" }]
}
```

本 skill 只把能确定性映射的项转为 finding；未映射项进入报告附录，不做推断。

| rule | 中文 | 处理 |
| --- | --- | --- |
| `SHOWDANDLING` | 悬空网络 | R005，P2；网络存在或不存在都报告 |
| `SHOWNC` | 未连接引脚 | 暂不映射；进入附录 |
| `SHOWPINNOCONNECT` | 引脚 NC 标记 | 暂不映射；进入附录 |
| `SHOWCOMPONENTOVERLAP` | 器件重叠 | 暂不映射；进入附录 |
| `SHOWNETLABEL` | 网络标签问题 | 暂不映射；进入附录 |
| 其他 | 未收录 | 输出“DRC 规则 <rule>（未收录，请查阅 EDA 文档）” |

未知规则回退文案使用 `references/drc-rules.md` 的同一规则；不要凭规则名猜测电气含义。
