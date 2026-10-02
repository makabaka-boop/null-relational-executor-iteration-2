/**
 * 执行器：仅在校验（parse + check）全部通过后调用。
 * 袋语义（保留重复行）；输出行顺序由输入行顺序与分组首次出现顺序决定。
 */
import type { InputTable, Operand, PlanNode, Predicate, RowId, Scalar } from './types.js';
import {
  aggregateSchema,
  columnIndex,
  joinSchemas,
  projectSchema,
  type RelSchema,
} from './schema.js';
import { compareValues, triAnd, triNot, triOr, type Tri } from './trilogic.js';

export interface InternalRow {
  values: Scalar[];
  /** 参与该行的源行 ID（有序、去重） */
  provenance: RowId[];
}

export interface Relation {
  schema: RelSchema;
  rows: InternalRow[];
}

function idKey(id: RowId): string {
  return `${typeof id}:${String(id)}`;
}

/** 按首次出现顺序去重 */
export function dedupIds(ids: RowId[]): RowId[] {
  const seen = new Set<string>();
  const out: RowId[] = [];
  for (const id of ids) {
    const key = idKey(id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

export function executePlan(node: PlanNode, tables: Map<string, InputTable>): Relation {
  switch (node.op) {
    case 'scan': {
      const table = tables.get(node.table)!;
      const schema: RelSchema = {
        relation: node.alias ?? node.table,
        columns: table.columns.map((c) => ({ ...c })),
      };
      return {
        schema,
        rows: table.rows.map((r) => ({ values: [...r.values], provenance: [r.id] })),
      };
    }
    case 'filter': {
      const input = executePlan(node.input, tables);
      // WHERE 只保留真值为 TRUE 的行（FALSE 与 UNKNOWN 都丢弃）
      return {
        schema: input.schema,
        rows: input.rows.filter(
          (row) => evalPredicate(node.predicate, row, input.schema) === 'T',
        ),
      };
    }
    case 'join': {
      const left = executePlan(node.left, tables);
      const right = executePlan(node.right, tables);
      const schema = joinSchemas(left.schema, right.schema);
      const li = columnIndex(left.schema, node.leftColumn);
      const ri = columnIndex(right.schema, node.rightColumn);
      const rows: InternalRow[] = [];
      const nullRight: Scalar[] = right.schema.columns.map(() => null);
      const isLeft = node.joinType === 'left';
      // 嵌套循环等值连接，左行优先、右行按输入顺序；NULL 与任何值都不相等。
      // 额外 on 谓词在等值键匹配的候选行上于连接内部求值：只有 TRUE 才算匹配。
      // on 与连接外层的 filter 分属不同阶段：on 失败（FALSE/UNKNOWN）在左外连接中
      // 触发右侧 NULL 补全行，而外层 filter 失败只会丢弃整行，二者绝不能合并。
      for (const l of left.rows) {
        const lv = l.values[li]!;
        let matched = false;
        if (lv !== null) {
          for (const r of right.rows) {
            const rv = r.values[ri]!;
            if (rv === null || lv !== rv) continue;
            const candidate: InternalRow = {
              values: [...l.values, ...r.values],
              provenance: dedupIds([...l.provenance, ...r.provenance]),
            };
            if (node.on !== undefined && evalPredicate(node.on, candidate, schema) !== 'T') {
              continue;
            }
            rows.push(candidate);
            matched = true;
          }
        }
        // 左外连接：右表无匹配，或所有候选的 on 结果为 FALSE/UNKNOWN，
        // 左行恰好输出一次右侧 NULL 扩展行，来源证据只含左侧行 ID。
        if (isLeft && !matched) {
          rows.push({
            values: [...l.values, ...nullRight],
            provenance: dedupIds(l.provenance),
          });
        }
      }
      return { schema, rows };
    }
    case 'project': {
      const input = executePlan(node.input, tables);
      const indexes = node.columns.map((c) => columnIndex(input.schema, c.name));
      return {
        schema: projectSchema(input.schema, node.columns),
        rows: input.rows.map((row) => ({
          values: indexes.map((i) => row.values[i]!),
          provenance: row.provenance,
        })),
      };
    }
    case 'aggregate': {
      const input = executePlan(node.input, tables);
      const groupIdx = node.groupBy.map((name) => columnIndex(input.schema, name));
      const aggIdx = node.aggregates.map((agg) =>
        agg.func === 'countStar' ? -1 : columnIndex(input.schema, agg.column),
      );
      // Map 保持插入顺序 → 分组按首次出现顺序输出；NULL 键归到同一组
      const groups = new Map<string, { key: Scalar[]; rows: InternalRow[] }>();
      if (node.groupBy.length === 0) {
        // 无分组键：整个输入是单一组，即使为空也产出一行
        groups.set('[]', { key: [], rows: [] });
      }
      for (const row of input.rows) {
        const key = groupIdx.map((i) => row.values[i]!);
        const encoded = JSON.stringify(key);
        let group = groups.get(encoded);
        if (group === undefined) {
          group = { key, rows: [] };
          groups.set(encoded, group);
        }
        group.rows.push(row);
      }
      const rows: InternalRow[] = [];
      for (const group of groups.values()) {
        const values: Scalar[] = [...group.key];
        node.aggregates.forEach((agg, i) => {
          if (agg.func === 'countStar') {
            values.push(group.rows.length);
            return;
          }
          const ci = aggIdx[i]!;
          if (agg.func === 'count') {
            // COUNT(列)：忽略 NULL
            let n = 0;
            for (const r of group.rows) if (r.values[ci] !== null) n += 1;
            values.push(n);
          } else {
            // SUM(列)：忽略 NULL；没有非 NULL 值时结果为 NULL
            let acc: number | null = null;
            for (const r of group.rows) {
              const v = r.values[ci];
              if (v !== null) acc = (acc ?? 0) + (v as number);
            }
            values.push(acc);
          }
        });
        rows.push({
          values,
          provenance: dedupIds(group.rows.flatMap((r) => r.provenance)),
        });
      }
      return { schema: aggregateSchema(input.schema, node.groupBy, node.aggregates), rows };
    }
  }
}

export function evalPredicate(pred: Predicate, row: InternalRow, schema: RelSchema): Tri {
  switch (pred.kind) {
    case 'constant':
      return pred.value ? 'T' : 'F';
    case 'and': {
      let acc: Tri = 'T';
      for (const arg of pred.args) {
        acc = triAnd(acc, evalPredicate(arg, row, schema));
        if (acc === 'F') break;
      }
      return acc;
    }
    case 'or': {
      let acc: Tri = 'F';
      for (const arg of pred.args) {
        acc = triOr(acc, evalPredicate(arg, row, schema));
        if (acc === 'T') break;
      }
      return acc;
    }
    case 'not':
      return triNot(evalPredicate(pred.arg, row, schema));
    case 'isNull':
      return valueOf(pred.operand, row, schema) === null ? 'T' : 'F';
    case 'isNotNull':
      return valueOf(pred.operand, row, schema) !== null ? 'T' : 'F';
    case 'comparison':
      return compareValues(
        pred.op,
        valueOf(pred.left, row, schema),
        valueOf(pred.right, row, schema),
      );
  }
}

function valueOf(operand: Operand, row: InternalRow, schema: RelSchema): Scalar {
  return operand.kind === 'literal'
    ? operand.value
    : row.values[columnIndex(schema, operand.name)]!;
}
