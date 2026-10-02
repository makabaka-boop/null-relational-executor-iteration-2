/**
 * 结构校验：把未受信的 JSON 解析为带类型的请求模型。
 * 只检查“形状”（字段存在、类型正确、枚举合法、数量上限），
 * 列名引用与类型一致性由 check.ts 负责。
 */
import type {
  AggregateSpec,
  ColumnDef,
  ColumnType,
  ComparisonOp,
  InputRow,
  InputTable,
  Operand,
  PlanNode,
  Predicate,
  Scalar,
} from './types.js';
import { MAX_ROWS_PER_TABLE, MAX_TABLES } from './types.js';

export interface ParsedRequest {
  tables: InputTable[];
  plan: PlanNode;
}

const COMPARISON_OPS = new Set<ComparisonOp>(['=', '!=', '<', '<=', '>', '>=']);
const COLUMN_TYPES = new Set<ColumnType>(['number', 'string', 'boolean']);

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isScalar(x: unknown): x is Scalar {
  return (
    x === null ||
    typeof x === 'string' ||
    typeof x === 'boolean' ||
    (typeof x === 'number' && Number.isFinite(x))
  );
}

/** 定义性名称（表名、列名、别名）：非空且不含 '.'（'.' 保留给连接后的限定名） */
function isDefName(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && !x.includes('.');
}

/** 引用性名称（列引用）：非空即可，可以是连接后的限定名 */
function isRefName(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function rowIdKey(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

export function parseRequest(raw: unknown, errors: string[]): ParsedRequest | null {
  if (!isObject(raw)) {
    errors.push('request: must be a JSON object with "tables" and "plan"');
    return null;
  }
  const tables = parseTables(raw.tables, errors);
  const plan = parsePlan(raw.plan, errors, 'plan');
  if (plan !== null) {
    const counts = countNodes(plan);
    if (counts.join > 1) {
      errors.push(`plan: at most one join node is allowed per request, found ${counts.join}`);
    }
    if (counts.aggregate > 1) {
      errors.push(
        `plan: at most one aggregate node is allowed per request, found ${counts.aggregate}`,
      );
    }
  }
  if (tables === null || plan === null) return null;
  return { tables, plan };
}

function countNodes(plan: PlanNode): { join: number; aggregate: number } {
  let join = 0;
  let aggregate = 0;
  const walk = (node: PlanNode): void => {
    switch (node.op) {
      case 'join':
        join += 1;
        walk(node.left);
        walk(node.right);
        break;
      case 'aggregate':
        aggregate += 1;
        walk(node.input);
        break;
      case 'filter':
      case 'project':
        walk(node.input);
        break;
      case 'scan':
        break;
    }
  };
  walk(plan);
  return { join, aggregate };
}

function parseTables(raw: unknown, errors: string[]): InputTable[] | null {
  if (!Array.isArray(raw)) {
    errors.push('tables: must be an array of table definitions');
    return null;
  }
  if (raw.length === 0) {
    errors.push('tables: at least one table is required');
    return null;
  }
  if (raw.length > MAX_TABLES) {
    errors.push(`tables: at most ${MAX_TABLES} tables per request, got ${raw.length}`);
  }
  const tables: InputTable[] = [];
  const tableNames = new Set<string>();
  const rowIds = new Set<string>();
  raw.forEach((rawTable, ti) => {
    const path = `tables[${ti}]`;
    const table = parseTable(rawTable, path, tableNames, rowIds, errors);
    if (table !== null) tables.push(table);
  });
  return tables.length > 0 ? tables : null;
}

function parseTable(
  raw: unknown,
  path: string,
  tableNames: Set<string>,
  rowIds: Set<string>,
  errors: string[],
): InputTable | null {
  if (!isObject(raw)) {
    errors.push(`${path}: table must be an object { name, columns, rows }`);
    return null;
  }
  if (!isDefName(raw.name)) {
    errors.push(`${path}.name: must be a non-empty string without '.'`);
    return null;
  }
  const name = raw.name;
  if (tableNames.has(name)) {
    errors.push(`${path}.name: duplicate table name '${name}'`);
    return null;
  }
  tableNames.add(name);

  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    errors.push(`${path}.columns: must be a non-empty array of { name, type }`);
    return null;
  }
  const columns: ColumnDef[] = [];
  const columnNames = new Set<string>();
  let columnsOk = true;
  raw.columns.forEach((rawCol, ci) => {
    const colPath = `${path}.columns[${ci}]`;
    if (!isObject(rawCol) || !isDefName(rawCol.name)) {
      errors.push(`${colPath}: column must be an object with a non-empty name (no '.')`);
      columnsOk = false;
      return;
    }
    if (!COLUMN_TYPES.has(rawCol.type as ColumnType)) {
      errors.push(`${colPath}.type: must be one of 'number' | 'string' | 'boolean'`);
      columnsOk = false;
      return;
    }
    if (columnNames.has(rawCol.name)) {
      errors.push(`${colPath}: duplicate column name '${rawCol.name}'`);
      columnsOk = false;
      return;
    }
    columnNames.add(rawCol.name);
    columns.push({ name: rawCol.name, type: rawCol.type as ColumnType });
  });
  if (!columnsOk) return null;

  if (!Array.isArray(raw.rows)) {
    errors.push(`${path}.rows: must be an array of { id, values }`);
    return null;
  }
  if (raw.rows.length > MAX_ROWS_PER_TABLE) {
    errors.push(
      `${path}.rows: at most ${MAX_ROWS_PER_TABLE} rows per table, got ${raw.rows.length}`,
    );
  }
  const rows: InputRow[] = [];
  raw.rows.forEach((rawRow, ri) => {
    const row = parseRow(rawRow, `${path}.rows[${ri}]`, columns, rowIds, errors);
    if (row !== null) rows.push(row);
  });
  return { name, columns, rows };
}

function parseRow(
  raw: unknown,
  path: string,
  columns: ColumnDef[],
  rowIds: Set<string>,
  errors: string[],
): InputRow | null {
  if (!isObject(raw)) {
    errors.push(`${path}: row must be an object { id, values }`);
    return null;
  }
  const id = raw.id;
  if (!(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))) {
    errors.push(`${path}.id: must be a string or a finite number`);
    return null;
  }
  const key = rowIdKey(id);
  if (rowIds.has(key)) {
    errors.push(`${path}.id: duplicate row id ${JSON.stringify(id)} (ids must be unique across all tables)`);
    return null;
  }
  if (!Array.isArray(raw.values) || raw.values.length !== columns.length) {
    errors.push(`${path}.values: must be an array of exactly ${columns.length} value(s)`);
    return null;
  }
  for (let vi = 0; vi < raw.values.length; vi += 1) {
    const value: unknown = raw.values[vi];
    const column = columns[vi]!;
    if (!isScalar(value)) {
      errors.push(
        `${path}.values[${vi}]: unsupported value (must be a finite number, string, boolean, or null)`,
      );
      return null;
    }
    if (value !== null) {
      const actual: ColumnType =
        typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'boolean';
      if (actual !== column.type) {
        errors.push(
          `${path}.values[${vi}]: expected ${column.type} for column '${column.name}', got ${actual}`,
        );
        return null;
      }
    }
  }
  rowIds.add(key);
  return { id, values: raw.values as Scalar[] };
}

export function parsePlan(raw: unknown, errors: string[], path: string): PlanNode | null {
  if (!isObject(raw)) {
    errors.push(`${path}: plan node must be an object with an "op" field`);
    return null;
  }
  switch (raw.op) {
    case 'scan': {
      if (!isRefName(raw.table)) {
        errors.push(`${path}.table: must be a non-empty string`);
        return null;
      }
      if (raw.alias !== undefined && !isDefName(raw.alias)) {
        errors.push(`${path}.alias: must be a non-empty string without '.'`);
        return null;
      }
      return raw.alias === undefined
        ? { op: 'scan', table: raw.table }
        : { op: 'scan', table: raw.table, alias: raw.alias };
    }
    case 'filter': {
      const input = parsePlan(raw.input, errors, `${path}.input`);
      const predicate = parsePredicate(raw.predicate, errors, `${path}.predicate`);
      return input !== null && predicate !== null ? { op: 'filter', input, predicate } : null;
    }
    case 'join': {
      const left = parsePlan(raw.left, errors, `${path}.left`);
      const right = parsePlan(raw.right, errors, `${path}.right`);
      const leftOk = isRefName(raw.leftColumn);
      const rightOk = isRefName(raw.rightColumn);
      if (!leftOk) errors.push(`${path}.leftColumn: must be a non-empty string`);
      if (!rightOk) errors.push(`${path}.rightColumn: must be a non-empty string`);
      // joinType 缺省为 inner；只允许枚举值
      let joinType: 'inner' | 'left' = 'inner';
      let joinTypeOk = true;
      if (raw.joinType !== undefined) {
        if (raw.joinType !== 'inner' && raw.joinType !== 'left') {
          errors.push(`${path}.joinType: must be 'inner' or 'left'`);
          joinTypeOk = false;
        } else {
          joinType = raw.joinType;
        }
      }
      // 可选的额外 ON 谓词（结构与 filter 谓词相同）
      let on: Predicate | undefined;
      let onOk = true;
      if (raw.on !== undefined) {
        on = parsePredicate(raw.on, errors, `${path}.on`) ?? undefined;
        if (on === undefined) onOk = false;
      }
      if (
        left === null ||
        right === null ||
        !leftOk ||
        !rightOk ||
        !joinTypeOk ||
        !onOk
      ) {
        return null;
      }
      return {
        op: 'join',
        left,
        right,
        leftColumn: raw.leftColumn as string,
        rightColumn: raw.rightColumn as string,
        ...(raw.joinType !== undefined ? { joinType } : {}),
        ...(raw.on !== undefined ? { on } : {}),
      };
    }
    case 'project': {
      const input = parsePlan(raw.input, errors, `${path}.input`);
      if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
        errors.push(`${path}.columns: must be a non-empty array of { name, as? }`);
        return null;
      }
      const columns: { name: string; as?: string }[] = [];
      let ok = true;
      raw.columns.forEach((rawCol, i) => {
        const colPath = `${path}.columns[${i}]`;
        if (!isObject(rawCol) || !isRefName(rawCol.name)) {
          errors.push(`${colPath}: must be an object { "name": <column>, "as"?: <alias> }`);
          ok = false;
          return;
        }
        if (rawCol.as !== undefined && !isDefName(rawCol.as)) {
          errors.push(`${colPath}.as: must be a non-empty string without '.'`);
          ok = false;
          return;
        }
        columns.push(
          rawCol.as === undefined ? { name: rawCol.name } : { name: rawCol.name, as: rawCol.as },
        );
      });
      if (input === null || !ok) return null;
      return { op: 'project', input, columns };
    }
    case 'aggregate': {
      const input = parsePlan(raw.input, errors, `${path}.input`);
      if (!Array.isArray(raw.groupBy) || !raw.groupBy.every(isRefName)) {
        errors.push(`${path}.groupBy: must be an array of column names (may be empty)`);
        return null;
      }
      if (!Array.isArray(raw.aggregates)) {
        errors.push(`${path}.aggregates: must be an array of aggregate specs`);
        return null;
      }
      const aggregates: AggregateSpec[] = [];
      let ok = true;
      raw.aggregates.forEach((rawAgg, i) => {
        const agg = parseAggregate(rawAgg, `${path}.aggregates[${i}]`, errors);
        if (agg === null) ok = false;
        else aggregates.push(agg);
      });
      if ((raw.groupBy as string[]).length === 0 && aggregates.length === 0) {
        errors.push(`${path}: aggregate must produce at least one output column`);
        ok = false;
      }
      if (input === null || !ok) return null;
      return { op: 'aggregate', input, groupBy: raw.groupBy as string[], aggregates };
    }
    default:
      errors.push(
        `${path}.op: unknown plan node ${JSON.stringify(raw.op)} (expected scan | filter | join | project | aggregate)`,
      );
      return null;
  }
}

function parseAggregate(raw: unknown, path: string, errors: string[]): AggregateSpec | null {
  if (!isObject(raw)) {
    errors.push(`${path}: aggregate must be an object { func, column?, as }`);
    return null;
  }
  if (!isDefName(raw.as)) {
    errors.push(`${path}.as: must be a non-empty string without '.'`);
    return null;
  }
  const as = raw.as;
  if (raw.func === 'countStar') {
    return { func: 'countStar', as };
  }
  if (raw.func === 'count' || raw.func === 'sum') {
    if (!isRefName(raw.column)) {
      errors.push(`${path}.column: '${raw.func}' requires a column name`);
      return null;
    }
    return { func: raw.func, column: raw.column, as };
  }
  errors.push(`${path}.func: must be 'countStar' | 'count' | 'sum'`);
  return null;
}

export function parsePredicate(raw: unknown, errors: string[], path: string): Predicate | null {
  if (!isObject(raw)) {
    errors.push(`${path}: predicate must be an object with a "kind" field`);
    return null;
  }
  switch (raw.kind) {
    case 'comparison': {
      if (!COMPARISON_OPS.has(raw.op as ComparisonOp)) {
        errors.push(`${path}.op: must be one of '=' '!=' '<' '<=' '>' '>='`);
        return null;
      }
      const left = parseOperand(raw.left, errors, `${path}.left`);
      const right = parseOperand(raw.right, errors, `${path}.right`);
      return left !== null && right !== null
        ? { kind: 'comparison', op: raw.op as ComparisonOp, left, right }
        : null;
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(raw.args) || raw.args.length === 0) {
        errors.push(`${path}.args: must be a non-empty array of predicates`);
        return null;
      }
      const args = raw.args.map((arg, i) => parsePredicate(arg, errors, `${path}.args[${i}]`));
      return args.every((arg): arg is Predicate => arg !== null)
        ? { kind: raw.kind, args }
        : null;
    }
    case 'not': {
      const arg = parsePredicate(raw.arg, errors, `${path}.arg`);
      return arg !== null ? { kind: 'not', arg } : null;
    }
    case 'isNull':
    case 'isNotNull': {
      const operand = parseOperand(raw.operand, errors, `${path}.operand`);
      return operand !== null ? { kind: raw.kind, operand } : null;
    }
    case 'constant': {
      if (typeof raw.value !== 'boolean') {
        errors.push(`${path}.value: must be a boolean`);
        return null;
      }
      return { kind: 'constant', value: raw.value };
    }
    default:
      errors.push(
        `${path}.kind: unknown predicate kind ${JSON.stringify(raw.kind)} (expected comparison | and | or | not | isNull | isNotNull | constant)`,
      );
      return null;
  }
}

function parseOperand(raw: unknown, errors: string[], path: string): Operand | null {
  if (!isObject(raw)) {
    errors.push(`${path}: operand must be an object { kind: 'column' | 'literal', ... }`);
    return null;
  }
  if (raw.kind === 'column') {
    if (!isRefName(raw.name)) {
      errors.push(`${path}.name: must be a non-empty string`);
      return null;
    }
    return { kind: 'column', name: raw.name };
  }
  if (raw.kind === 'literal') {
    if (!('value' in raw) || !isScalar(raw.value)) {
      errors.push(`${path}.value: must be a finite number, string, boolean, or null`);
      return null;
    }
    return { kind: 'literal', value: raw.value };
  }
  errors.push(`${path}.kind: must be 'column' or 'literal'`);
  return null;
}
