/**
 * 语义校验：在结构校验（parse.ts）之后、执行之前完成。
 * 检查列名引用、类型一致性与计划合法性；发现错误只记录不执行，
 * 因此错误请求永远不会产生部分结果。
 */
import type { ColumnType, InputTable, Operand, PlanNode, Predicate } from './types.js';
import {
  aggregateSchema,
  columnIndex,
  columnType,
  joinSchemas,
  projectSchema,
  type RelSchema,
} from './schema.js';

/** 字面量 NULL 的类型：与任何列类型兼容（比较结果恒为 UNKNOWN） */
type OperandType = ColumnType | 'null';

export function checkPlan(
  node: PlanNode,
  tables: Map<string, InputTable>,
  errors: string[],
  path: string,
): RelSchema | null {
  switch (node.op) {
    case 'scan': {
      const table = tables.get(node.table);
      if (table === undefined) {
        errors.push(`${path}: unknown table '${node.table}'`);
        return null;
      }
      return {
        relation: node.alias ?? node.table,
        columns: table.columns.map((c) => ({ ...c })),
      };
    }
    case 'filter': {
      const schema = checkPlan(node.input, tables, errors, `${path}.input`);
      if (schema === null) return null;
      checkPredicate(node.predicate, schema, errors, `${path}.predicate`);
      return schema;
    }
    case 'join': {
      const left = checkPlan(node.left, tables, errors, `${path}.left`);
      const right = checkPlan(node.right, tables, errors, `${path}.right`);
      if (left === null || right === null) return null;
      const li = columnIndex(left, node.leftColumn);
      const ri = columnIndex(right, node.rightColumn);
      if (li < 0) {
        errors.push(`${path}: left join column '${node.leftColumn}' does not exist`);
      }
      if (ri < 0) {
        errors.push(`${path}: right join column '${node.rightColumn}' does not exist`);
      }
      if (li >= 0 && ri >= 0) {
        const lt = left.columns[li]!.type;
        const rt = right.columns[ri]!.type;
        if (lt !== rt) {
          errors.push(
            `${path}: join key type mismatch ('${node.leftColumn}' is ${lt}, '${node.rightColumn}' is ${rt})`,
          );
        }
      }
      const shared = left.columns.filter((c) => columnIndex(right, c.name) >= 0);
      if (
        shared.length > 0 &&
        (left.relation === undefined ||
          right.relation === undefined ||
          left.relation === right.relation)
      ) {
        errors.push(
          `${path}: column(s) ${shared
            .map((c) => `'${c.name}'`)
            .join(', ')} exist on both join inputs and cannot be qualified; give the scans distinct aliases`,
        );
      }
      return joinSchemas(left, right);
    }
    case 'project': {
      const schema = checkPlan(node.input, tables, errors, `${path}.input`);
      if (schema === null) return null;
      let ok = true;
      const outNames = new Set<string>();
      for (const col of node.columns) {
        if (columnIndex(schema, col.name) < 0) {
          errors.push(`${path}: unknown column '${col.name}'`);
          ok = false;
        }
        const outName = col.as ?? col.name;
        if (outNames.has(outName)) {
          errors.push(`${path}: duplicate output column '${outName}'`);
          ok = false;
        }
        outNames.add(outName);
      }
      return ok ? projectSchema(schema, node.columns) : null;
    }
    case 'aggregate': {
      const schema = checkPlan(node.input, tables, errors, `${path}.input`);
      if (schema === null) return null;
      let ok = true;
      const groupSet = new Set<string>();
      for (const name of node.groupBy) {
        if (columnIndex(schema, name) < 0) {
          errors.push(`${path}: unknown group-by column '${name}'`);
          ok = false;
        }
        if (groupSet.has(name)) {
          errors.push(`${path}: duplicate group-by column '${name}'`);
          ok = false;
        }
        groupSet.add(name);
      }
      const outNames = new Set<string>(node.groupBy);
      for (const agg of node.aggregates) {
        if (agg.func !== 'countStar') {
          const type = columnType(schema, agg.column);
          if (type === undefined) {
            errors.push(`${path}: unknown aggregate column '${agg.column}'`);
            ok = false;
          } else if (agg.func === 'sum' && type !== 'number') {
            errors.push(`${path}: SUM requires a numeric column, '${agg.column}' is ${type}`);
            ok = false;
          }
        }
        if (outNames.has(agg.as)) {
          errors.push(`${path}: duplicate output column name '${agg.as}'`);
          ok = false;
        }
        outNames.add(agg.as);
      }
      return ok ? aggregateSchema(schema, node.groupBy, node.aggregates) : null;
    }
  }
}

function checkPredicate(
  pred: Predicate,
  schema: RelSchema,
  errors: string[],
  path: string,
): void {
  switch (pred.kind) {
    case 'comparison': {
      const lt = operandType(pred.left, schema, errors, `${path}.left`);
      const rt = operandType(pred.right, schema, errors, `${path}.right`);
      if (lt === null || rt === null) return; // 列名错误已记录
      if (lt !== 'null' && rt !== 'null' && lt !== rt) {
        errors.push(`${path}: cannot compare ${lt} with ${rt}`);
        return;
      }
      const effective = lt !== 'null' ? lt : rt;
      if (
        effective !== 'null' &&
        effective === 'boolean' &&
        (pred.op === '<' || pred.op === '<=' || pred.op === '>' || pred.op === '>=')
      ) {
        errors.push(`${path}: operator '${pred.op}' is not defined for boolean`);
      }
      return;
    }
    case 'and':
    case 'or':
      pred.args.forEach((arg, i) => checkPredicate(arg, schema, errors, `${path}.args[${i}]`));
      return;
    case 'not':
      checkPredicate(pred.arg, schema, errors, `${path}.arg`);
      return;
    case 'isNull':
    case 'isNotNull':
      operandType(pred.operand, schema, errors, `${path}.operand`);
      return;
    case 'constant':
      return;
  }
}

function operandType(
  operand: Operand,
  schema: RelSchema,
  errors: string[],
  path: string,
): OperandType | null {
  if (operand.kind === 'literal') {
    const value = operand.value;
    if (value === null) return 'null';
    return typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'boolean';
  }
  const type = columnType(schema, operand.name);
  if (type === undefined) {
    errors.push(`${path}: unknown column '${operand.name}'`);
    return null;
  }
  return type;
}
