/**
 * 公共类型定义：请求（有类型表 + 结构化查询计划）与响应。
 */

/** 标量值：三种基本类型之一，或 NULL */
export type Scalar = number | string | boolean | null;

export type ColumnType = 'number' | 'string' | 'boolean';

/** 源行 ID：字符串或有限数值，在整个请求内唯一 */
export type RowId = string | number;

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

export interface InputRow {
  id: RowId;
  values: Scalar[];
}

export interface InputTable {
  name: string;
  columns: ColumnDef[];
  rows: InputRow[];
}

/** 谓词操作数：列引用或字面量 */
export type Operand =
  | { kind: 'column'; name: string }
  | { kind: 'literal'; value: Scalar };

export type ComparisonOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

/** 三值逻辑谓词 */
export type Predicate =
  | { kind: 'comparison'; op: ComparisonOp; left: Operand; right: Operand }
  | { kind: 'and'; args: Predicate[] }
  | { kind: 'or'; args: Predicate[] }
  | { kind: 'not'; arg: Predicate }
  | { kind: 'isNull'; operand: Operand }
  | { kind: 'isNotNull'; operand: Operand }
  | { kind: 'constant'; value: boolean };

/** 聚合函数：COUNT(*) / COUNT(列) / SUM(列) */
export type AggregateSpec =
  | { func: 'countStar'; as: string }
  | { func: 'count'; column: string; as: string }
  | { func: 'sum'; column: string; as: string };

/** 结构化查询计划节点 */
export type PlanNode =
  | { op: 'scan'; table: string; alias?: string }
  | { op: 'filter'; input: PlanNode; predicate: Predicate }
  | { op: 'join'; left: PlanNode; right: PlanNode; leftColumn: string; rightColumn: string }
  | { op: 'project'; input: PlanNode; columns: { name: string; as?: string }[] }
  | { op: 'aggregate'; input: PlanNode; groupBy: string[]; aggregates: AggregateSpec[] };

export interface QueryRequest {
  tables: InputTable[];
  plan: PlanNode;
}

export interface OutputRow {
  values: Scalar[];
  /** 实际参与该行（或聚合组）的源行 ID，按首次出现顺序去重 */
  sourceIds: RowId[];
}

export interface QuerySuccess {
  ok: true;
  columns: ColumnDef[];
  rows: OutputRow[];
}

/** 校验失败：不返回任何部分结果 */
export interface QueryFailure {
  ok: false;
  errors: string[];
}

export type QueryResult = QuerySuccess | QueryFailure;

/** 每次请求最多两张表 */
export const MAX_TABLES = 2;
/** 每张表最多 300 行 */
export const MAX_ROWS_PER_TABLE = 300;
