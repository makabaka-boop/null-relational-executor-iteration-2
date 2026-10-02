/**
 * 关系模式推导：校验（check.ts）与执行（execute.ts）共用同一套规则，
 * 保证“校验通过的模式”与“执行产出的模式”完全一致。
 */
import type { AggregateSpec, ColumnDef, ColumnType } from './types.js';

export interface RelSchema {
  columns: ColumnDef[];
  /**
   * 来源关系名（scan 的表名或别名；filter/project 透传）。
   * 连接或聚合之后为 undefined（派生关系不可再用于限定名）。
   */
  relation: string | undefined;
}

export function columnIndex(schema: RelSchema, name: string): number {
  return schema.columns.findIndex((c) => c.name === name);
}

export function columnType(schema: RelSchema, name: string): ColumnType | undefined {
  const idx = columnIndex(schema, name);
  return idx < 0 ? undefined : schema.columns[idx]!.type;
}

/**
 * 连接输出模式：左列在前、右列在后（袋语义，列不去重）。
 * 两侧同名的列在两侧都限定为 `关系名.列名`；无冲突的列保持原名。
 */
export function joinSchemas(left: RelSchema, right: RelSchema): RelSchema {
  const leftNames = new Set(left.columns.map((c) => c.name));
  const rightNames = new Set(right.columns.map((c) => c.name));
  const columns: ColumnDef[] = [
    ...left.columns.map((c) => ({
      name: rightNames.has(c.name) ? `${left.relation}.${c.name}` : c.name,
      type: c.type,
    })),
    ...right.columns.map((c) => ({
      name: leftNames.has(c.name) ? `${right.relation}.${c.name}` : c.name,
      type: c.type,
    })),
  ];
  return { columns, relation: undefined };
}

export function projectSchema(
  input: RelSchema,
  columns: { name: string; as?: string }[],
): RelSchema {
  return {
    relation: input.relation,
    columns: columns.map((c) => ({
      name: c.as ?? c.name,
      type: columnType(input, c.name)!,
    })),
  };
}

export function aggregateSchema(
  input: RelSchema,
  groupBy: string[],
  aggregates: AggregateSpec[],
): RelSchema {
  const columns: ColumnDef[] = groupBy.map((name) => ({
    name,
    type: columnType(input, name)!,
  }));
  for (const agg of aggregates) {
    // COUNT(*)/COUNT(列) 必为数值；SUM 的输入已校验为数值
    columns.push({ name: agg.as, type: 'number' });
  }
  return { columns, relation: undefined };
}
