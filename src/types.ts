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

/**
 * 连接类型：
 * - inner（默认）：内连接，无匹配的左行不输出
 * - leftOuter：左外连接；无真实匹配的左行恰好输出一次右侧 NULL 扩展行
 */
export type JoinType = 'inner' | 'leftOuter';

/** 结构化查询计划节点 */
export type PlanNode =
  | { op: 'scan'; table: string; alias?: string }
  | { op: 'filter'; input: PlanNode; predicate: Predicate }
  | {
      op: 'join';
      left: PlanNode;
      right: PlanNode;
      leftColumn: string;
      rightColumn: string;
      /** 缺省为 inner */
      joinType?: JoinType;
      /**
       * 可选的额外连接谓词，在连接后的行上求值；只有 TRUE 才算真实匹配。
       * 等值键始终是必需条件，NULL 键不连接。leftOuter 下 FALSE/UNKNOWN
       * 的候选不产出匹配行，左行改由 NULL 扩展行补出。
       * 必须与连接外层的 filter 分阶段执行，不能把外层 filter 下推到连接内。
       */
      on?: Predicate;
    }
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
