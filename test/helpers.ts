/**
 * 测试辅助：构造器 + 与引擎相互独立的参考实现。
 * 参考实现刻意采用不同策略（连接用哈希索引而非嵌套循环、
 * 分组用线性查找 + 逐键深比较而非 JSON 编码、谓词用真值表查表），
 * 用来交叉核对引擎的连接、筛选、聚合、重复行与来源证据。
 */
import type {
  ColumnDef,
  ColumnType,
  InputTable,
  JoinType,
  Operand,
  PlanNode,
  Predicate,
  RowId,
  Scalar,
} from '../src/index.js';
import type { Tri } from '../src/index.js';

// ---------------------------------------------------------------------------
// 确定性伪随机数（mulberry32）
// ---------------------------------------------------------------------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 计划构造器
// ---------------------------------------------------------------------------

export const col = (name: string): Operand => ({ kind: 'column', name });
export const lit = (value: Scalar): Operand => ({ kind: 'literal', value });
export const cmp = (op: '=' | '!=' | '<' | '<=' | '>' | '>=', left: Operand, right: Operand): Predicate => ({
  kind: 'comparison',
  op,
  left,
  right,
});
export const andP = (...args: Predicate[]): Predicate => ({ kind: 'and', args });
export const orP = (...args: Predicate[]): Predicate => ({ kind: 'or', args });
export const notP = (arg: Predicate): Predicate => ({ kind: 'not', arg });
export const isNullP = (operand: Operand): Predicate => ({ kind: 'isNull', operand });
export const isNotNullP = (operand: Operand): Predicate => ({ kind: 'isNotNull', operand });

export const scan = (table: string, alias?: string): PlanNode =>
  alias === undefined ? { op: 'scan', table } : { op: 'scan', table, alias };
export const filter = (input: PlanNode, predicate: Predicate): PlanNode => ({
  op: 'filter',
  input,
  predicate,
});
export const join = (
  left: PlanNode,
  right: PlanNode,
  leftColumn: string,
  rightColumn: string,
  options?: { joinType?: JoinType; on?: Predicate },
): PlanNode => ({
  op: 'join',
  left,
  right,
  leftColumn,
  rightColumn,
  ...(options?.joinType !== undefined ? { joinType: options.joinType } : {}),
  ...(options?.on !== undefined ? { on: options.on } : {}),
});
export const project = (input: PlanNode, columns: (string | { name: string; as: string })[]): PlanNode => ({
  op: 'project',
  input,
  columns: columns.map((c) => (typeof c === 'string' ? { name: c } : c)),
});
export const aggregate = (
  input: PlanNode,
  groupBy: string[],
  aggregates: (
    | { func: 'countStar'; as: string }
    | { func: 'count' | 'sum'; column: string; as: string }
  )[],
): PlanNode => ({ op: 'aggregate', input, groupBy, aggregates });

/** 便捷建表：rows 为 [id, ...values] 元组 */
export function table(
  name: string,
  columns: [string, ColumnType][],
  rows: [RowId, ...Scalar[]][],
): InputTable {
  return {
    name,
    columns: columns.map(([colName, type]) => ({ name: colName, type })),
    rows: rows.map(([id, ...values]) => ({ id, values })),
  };
}

// ---------------------------------------------------------------------------
// 参考模型：与引擎无关的行表示
// ---------------------------------------------------------------------------

export interface RefRow {
  values: Scalar[];
  sourceIds: RowId[];
}

export interface RefRelation {
  columns: ColumnDef[];
  /** 来源关系名（表名或别名）；用于连接后同名列的限定名推导 */
  relation?: string;
  rows: RefRow[];
}

export function refScan(t: InputTable, relation?: string): RefRelation {
  return {
    relation,
    columns: t.columns.map((c) => ({ ...c })),
    rows: t.rows.map((r) => ({ values: [...r.values], sourceIds: [r.id] })),
  };
}

export function dedup(ids: RowId[]): RowId[] {
  const seen = new Set<string>();
  const out: RowId[] = [];
  for (const id of ids) {
    const key = `${typeof id}:${String(id)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 三值逻辑真值表（作为数据的独立参考）
// ---------------------------------------------------------------------------

export const TRIS: Tri[] = ['T', 'F', 'U'];

export const AND_TABLE: Record<Tri, Record<Tri, Tri>> = {
  T: { T: 'T', F: 'F', U: 'U' },
  F: { T: 'F', F: 'F', U: 'F' },
  U: { T: 'U', F: 'F', U: 'U' },
};

export const OR_TABLE: Record<Tri, Record<Tri, Tri>> = {
  T: { T: 'T', F: 'T', U: 'T' },
  F: { T: 'T', F: 'F', U: 'U' },
  U: { T: 'T', F: 'U', U: 'U' },
};

export const NOT_TABLE: Record<Tri, Tri> = { T: 'F', F: 'T', U: 'U' };

/** 参考比较：显式 NULL 判定 + 显式三值 */
export function refCompare(
  op: '=' | '!=' | '<' | '<=' | '>' | '>=',
  left: Scalar,
  right: Scalar,
): Tri {
  if (left === null || right === null) return 'U';
  switch (op) {
    case '=':
      return left === right ? 'T' : 'F';
    case '!=':
      return left !== right ? 'T' : 'F';
    case '<':
      return (left as number) < (right as number) ? 'T' : 'F';
    case '<=':
      return (left as number) <= (right as number) ? 'T' : 'F';
    case '>':
      return (left as number) > (right as number) ? 'T' : 'F';
    case '>=':
      return (left as number) >= (right as number) ? 'T' : 'F';
  }
}

/** 参考谓词求值：完全基于真值表查表 */
export function refEvalPredicate(
  pred: Predicate,
  values: Scalar[],
  columns: ColumnDef[],
): Tri {
  const valueOf = (operand: Operand): Scalar =>
    operand.kind === 'literal'
      ? operand.value
      : values[columns.findIndex((c) => c.name === operand.name)]!;
  switch (pred.kind) {
    case 'constant':
      return pred.value ? 'T' : 'F';
    case 'comparison':
      return refCompare(pred.op, valueOf(pred.left), valueOf(pred.right));
    case 'and': {
      let acc: Tri = 'T';
      for (const arg of pred.args) acc = AND_TABLE[acc][refEvalPredicate(arg, values, columns)];
      return acc;
    }
    case 'or': {
      let acc: Tri = 'F';
      for (const arg of pred.args) acc = OR_TABLE[acc][refEvalPredicate(arg, values, columns)];
      return acc;
    }
    case 'not':
      return NOT_TABLE[refEvalPredicate(pred.arg, values, columns)];
    case 'isNull':
      return valueOf(pred.operand) === null ? 'T' : 'F';
    case 'isNotNull':
      return valueOf(pred.operand) !== null ? 'T' : 'F';
  }
}

/** 参考筛选：只保留 TRUE */
export function refFilter(rel: RefRelation, pred: Predicate): RefRelation {
  return {
    relation: rel.relation,
    columns: rel.columns,
    rows: rel.rows.filter((r) => refEvalPredicate(pred, r.values, rel.columns) === 'T'),
  };
}

// ---------------------------------------------------------------------------
// 参考连接：哈希索引实现（引擎是嵌套循环），输出顺序仍为左行优先
// ---------------------------------------------------------------------------

/** 参考连接输出列：同名冲突列在两侧都限定为 关系名.列名（与 schema.ts 同一规则） */
export function refJoinColumns(left: RefRelation, right: RefRelation): ColumnDef[] {
  const leftNames = new Set(left.columns.map((c) => c.name));
  const rightNames = new Set(right.columns.map((c) => c.name));
  return [
    ...left.columns.map((c) => ({
      name: rightNames.has(c.name) ? `${left.relation}.${c.name}` : c.name,
      type: c.type,
    })),
    ...right.columns.map((c) => ({
      name: leftNames.has(c.name) ? `${right.relation}.${c.name}` : c.name,
      type: c.type,
    })),
  ];
}

/**
 * 参考等值连接：右表按非 NULL 键建哈希桶，左行线性探测（与引擎的嵌套循环独立）。
 * 额外 on 谓词在连接后的行上按真值表求值，只有 TRUE 才算真实匹配。
 * 传入的 RefRelation 需带 relation 名（refScanWith），用于限定名列推导。
 */
export function refJoin(
  left: RefRelation,
  right: RefRelation,
  leftCol: string,
  rightCol: string,
  on?: Predicate,
): RefRelation {
  const li = left.columns.findIndex((c) => c.name === leftCol);
  const ri = right.columns.findIndex((c) => c.name === rightCol);
  const columns = refJoinColumns(left, right);
  const index = new Map<Scalar, RefRow[]>();
  for (const r of right.rows) {
    const key = r.values[ri]!;
    if (key === null) continue; // NULL 不能连接
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [r]);
    else bucket.push(r);
  }
  const rows: RefRow[] = [];
  for (const l of left.rows) {
    const key = l.values[li]!;
    if (key === null) continue;
    for (const r of index.get(key) ?? []) {
      const values = [...l.values, ...r.values];
      if (on !== undefined && refEvalPredicate(on, values, columns) !== 'T') continue;
      rows.push({
        values,
        sourceIds: dedup([...l.sourceIds, ...r.sourceIds]),
      });
    }
  }
  return { columns, rows };
}

/**
 * 参考左外连接：每个左行先做等值 + on 匹配；没有任何真实匹配时
 * （右表无候选、键为 NULL、或所有候选 on 为 FALSE/UNKNOWN）
 * 恰好补一次右侧 NULL 扩展行，来源证据只含左侧行 ID。
 */
export function refLeftJoin(
  left: RefRelation,
  right: RefRelation,
  leftCol: string,
  rightCol: string,
  on?: Predicate,
): RefRelation {
  const li = left.columns.findIndex((c) => c.name === leftCol);
  const ri = right.columns.findIndex((c) => c.name === rightCol);
  const columns = refJoinColumns(left, right);
  const index = new Map<Scalar, RefRow[]>();
  for (const r of right.rows) {
    const key = r.values[ri]!;
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [r]);
    else bucket.push(r);
  }
  const nulls = right.columns.map(() => null);
  const rows: RefRow[] = [];
  for (const l of left.rows) {
    const key = l.values[li]!;
    let matched = 0;
    if (key !== null) {
      for (const r of index.get(key) ?? []) {
        const values = [...l.values, ...r.values];
        if (on !== undefined && refEvalPredicate(on, values, columns) !== 'T') continue;
        rows.push({
          values,
          sourceIds: dedup([...l.sourceIds, ...r.sourceIds]),
        });
        matched += 1;
      }
    }
    if (matched === 0) {
      rows.push({
        values: [...l.values, ...nulls],
        sourceIds: dedup([...l.sourceIds]),
      });
    }
  }
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// 参考聚合：线性查找分组 + 逐键深比较（NULL 与 NULL 同组）
// ---------------------------------------------------------------------------

function keyEquals(a: Scalar[], b: Scalar[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function refAggregate(
  rel: RefRelation,
  groupBy: string[],
  aggregates: (
    | { func: 'countStar'; as: string }
    | { func: 'count' | 'sum'; column: string; as: string }
  )[],
): RefRelation {
  const groupIdx = groupBy.map((name) => rel.columns.findIndex((c) => c.name === name));
  const groups: { key: Scalar[]; rows: RefRow[] }[] = [];
  if (groupBy.length === 0) groups.push({ key: [], rows: [] });
  for (const row of rel.rows) {
    const key = groupIdx.map((i) => row.values[i]!);
    let group = groups.find((g) => keyEquals(g.key, key));
    if (group === undefined) {
      group = { key, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  const rows: RefRow[] = groups.map((group) => {
    const values: Scalar[] = [...group.key];
    for (const agg of aggregates) {
      if (agg.func === 'countStar') {
        values.push(group.rows.length);
        continue;
      }
      const ci = rel.columns.findIndex((c) => c.name === agg.column);
      const nonNull = group.rows.map((r) => r.values[ci]!).filter((v) => v !== null);
      if (agg.func === 'count') {
        values.push(nonNull.length);
      } else {
        values.push(nonNull.length === 0 ? null : (nonNull as number[]).reduce((a, b) => a + b, 0));
      }
    }
    return { values, sourceIds: dedup(group.rows.flatMap((r) => r.sourceIds)) };
  });
  const columns: ColumnDef[] = [
    ...groupBy.map((name) => ({
      name,
      type: rel.columns.find((c) => c.name === name)!.type,
    })),
    ...aggregates.map((agg) => ({ name: agg.as, type: 'number' as ColumnType })),
  ];
  return { relation: undefined, columns, rows };
}

export function refProject(rel: RefRelation, cols: string[]): RefRelation {
  const idx = cols.map((name) => rel.columns.findIndex((c) => c.name === name));
  return {
    relation: rel.relation,
    columns: cols.map((name) => rel.columns.find((c) => c.name === name)!),
    rows: rel.rows.map((r) => ({
      values: idx.map((i) => r.values[i]!),
      sourceIds: r.sourceIds,
    })),
  };
}
