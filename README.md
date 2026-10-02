# structured-query-engine

TypeScript/Node 服务：执行**结构化查询计划**（JSON 描述，不解析 SQL 文本）。
一次请求最多包含 **2 张表**（每张最多 **300 行**），计划由扫描、三值逻辑筛选、
一次等值连接（内连接或**左外连接**，可带额外 `on` 谓词）、投影、分组聚合节点组成，
全程**袋语义**（保留重复行）。

## 运行

```bash
npm install
npm test          # 编译并运行全部测试（node:test）
npm start         # 启动 HTTP 服务，默认 :3000（PORT 环境变量可改）
```

```bash
curl -s localhost:3000/execute -d '{"tables":[...],"plan":{...}}'
```

也可以作为库使用：`import { executeQuery } from './src/index.js'`。

## 请求格式

```jsonc
{
  "tables": [
    {
      "name": "users",
      "columns": [
        { "name": "id", "type": "number" },
        { "name": "name", "type": "string" }
      ],
      "rows": [
        { "id": "u1", "values": [1, "alice"] },
        { "id": "u2", "values": [2, "bob"] }
      ]
    }
  ],
  "plan": { "op": "scan", "table": "users" }
}
```

- 列类型：`number`（有限数值）/ `string` / `boolean`；任何列都允许 `null`。
- 每个源行的 `id`（字符串或数值）在**整个请求内唯一**，用于来源证据。
- 表名、列名、别名是非空字符串且不含 `.`（`.` 保留给连接后的限定名）。

## 计划节点

| 节点 | 字段 | 说明 |
| --- | --- | --- |
| `scan` | `table`, `alias?` | 扫描一张表 |
| `filter` | `input`, `predicate` | 只保留谓词为 **TRUE** 的行 |
| `join` | `left`, `right`, `leftColumn`, `rightColumn`, `joinType?`, `on?` | 等值连接（每请求至多一个）；`joinType` 为 `inner`（缺省）或 `leftOuter` |
| `project` | `input`, `columns: [{name, as?}]` | 投影/重命名 |
| `aggregate` | `input`, `groupBy`, `aggregates` | 分组聚合（每请求至多一个） |

谓词：`comparison`（`=` `!=` `<` `<=` `>` `>=`，操作数为 `{kind:"column",name}` 或
`{kind:"literal",value}`）、`and` / `or` / `not` / `isNull` / `isNotNull` / `constant`。

聚合：`{func:"countStar", as}`、`{func:"count", column, as}`、`{func:"sum", column, as}`。

## 语义

- **三值逻辑**：`NULL` 与任何值（包括 `NULL`）的比较结果为 UNKNOWN；
  `WHERE` 只保留 TRUE。连接键为 NULL 的行不能连接（`NULL = NULL` 不成立）。
- **左外连接**（`joinType: "leftOuter"`）：等值键始终是必需条件；可选的额外
  `on` 谓词在**连接后的候选行**上按三值逻辑求值，只有 TRUE 才算真实匹配。
  右表无匹配，或所有候选的 `on` 结果为 FALSE／UNKNOWN（含左键为 NULL）时，
  左行**恰好输出一次**右侧 NULL 扩展行，`sourceIds` 只含左侧行 ID。
  有真实匹配时保持袋语义与左行优先的嵌套循环顺序（重复键仍笛卡尔展开）。
  `on` 与连接**外层 filter 分阶段执行**：`on` 不满足会补空行，外层 filter
  在补空行上求值（右列为 NULL → 多为 UNKNOWN）则直接筛掉、不会补行；
  因此外层 filter 不能下推进连接。内连接携带 `on` 时它只是连接阶段的合取条件。
- **分组**：分组键为 NULL 的行归入同一组；分组按**首次出现顺序**输出。
- **聚合**：`COUNT(*)` 计全部行（含左外连接补出的空行）；
  `COUNT(列)`、`SUM(列)` 忽略 NULL（补空行的右列是 NULL，故不计入）；
  没有非 NULL 值时 `SUM` 为 `NULL`。无分组键时整个输入是一组（空输入也产出一行）。
- **袋语义**：重复行保留并重复计数。
- **顺序**：结果顺序由输入行顺序决定（连接为左行优先的嵌套循环顺序），
  分组按首次出现顺序。
- **来源证据**：每个输出行带 `sourceIds` —— 实际参与该行（或聚合组）的源行 ID，
  按首次出现顺序去重。左外连接补空行的证据只包含左行 ID。
- **列名**：连接两侧同名列在两侧都限定为 `关系名.列名`（关系名为表名或 `alias`）；
  无冲突列保持原名；`on` 谓词按连接输出列名解析。自连接需用 `alias` 区分两侧。

## 响应

```jsonc
// 成功
{ "ok": true,
  "columns": [{ "name": "region", "type": "string" }, { "name": "total", "type": "number" }],
  "rows": [{ "values": ["east", 250], "sourceIds": ["s1", "s3", "s7"] }] }

// 失败（校验错误）：不返回任何部分结果
{ "ok": false, "errors": ["plan.predicate.left: unknown column 'ghost'"] }
```

执行前完成全部校验：表/行结构、行值类型、行 ID 唯一性、计划结构、
列名引用（含连接 `on` 谓词，按连接输出列名解析）、比较与连接键的类型一致性、
`SUM` 列为数值、输出列名唯一等。`joinType` 必须是 `inner` 或 `leftOuter`。
任何错误都导致整体失败，**不会返回部分结果**。

### 左外连接示例

```jsonc
// 主表行即使没有明细（或 on 不成立）也保留，右侧补 NULL：
// u1 命中 d1；u3 无明细 → [3, "carol", null, null]；u4 键为 NULL 同样补空行
{
  "op": "join",
  "joinType": "leftOuter",
  "left": { "op": "scan", "table": "users" },
  "right": { "op": "scan", "table": "orders" },
  "leftColumn": "id",
  "rightColumn": "userId",
  "on": { "kind": "isNotNull", "operand": { "kind": "column", "name": "amount" } }
}
```

## HTTP 接口

- `GET /health` → `200 { "ok": true }`
- `POST /execute` → `200`（成功）/ `422`（校验失败）/ `400`（非法 JSON）/ `413`（请求体过大）

## 目录结构

```
src/
  types.ts     公共类型（请求、计划、响应）
  trilogic.ts  三值逻辑（AND/OR/NOT 与比较）
  parse.ts     结构校验：JSON → 带类型模型
  check.ts     语义校验：列名引用与类型一致性
  schema.ts    模式推导（校验与执行共用）
  execute.ts   执行器（扫描/筛选/连接/投影/聚合）
  index.ts     executeQuery 入口
  server.ts    HTTP 服务
test/
  helpers.ts     独立参考实现（哈希连接含左外/on、真值表求值、线性查找分组）
  *.test.ts      真值表、筛选、连接、左外连接、聚合、校验、随机流水线交叉核对
```

测试用与引擎**相互独立**的参考实现交叉核对：连接用哈希索引（引擎用嵌套循环）、
谓词用真值表查表、分组用线性查找 + 逐键深比较，覆盖内/左外连接、额外 on 谓词、
聚合、重复行与来源证据；左外连接另用独立小表枚举预言机穷举重复键、NULL 键、
无匹配、on 与外层 filter 差异及聚合来源证据。
