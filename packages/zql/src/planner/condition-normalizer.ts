import type {
  AST,
  Condition,
  CorrelatedSubquery,
  CorrelatedSubqueryCondition,
  LiteralValue,
  SimpleCondition,
  ValuePosition,
} from '../../../zero-protocol/src/ast.ts';
import {planIdSymbol} from '../../../zero-protocol/src/ast.ts';

const TRUE: Condition = {type: 'and', conditions: []};
const FALSE: Condition = {type: 'or', conditions: []};

export function normalizePlannerAST(ast: AST): AST {
  return {
    ...ast,
    where: ast.where ? normalizeCondition(ast.where) : undefined,
    related: ast.related?.map(related => ({
      ...related,
      subquery: normalizePlannerAST(related.subquery),
    })),
  };
}

function normalizeCondition(condition: Condition): Condition {
  switch (condition.type) {
    case 'simple':
      return normalizeSimpleCondition(condition);
    case 'correlatedSubquery':
      return normalizeCorrelatedSubquery(condition);
    case 'and':
      return buildAnd(condition.conditions.map(normalizeCondition));
    case 'or':
      return buildOr(condition.conditions.map(normalizeCondition));
  }
}

function normalizeSimpleCondition(condition: SimpleCondition): Condition {
  if (condition.right.type !== 'literal') {
    return condition;
  }

  const value = condition.right.value;
  if (!Array.isArray(value)) {
    return condition;
  }

  if (condition.op === 'IN') {
    const values = dedupeInLiteralValues(value);
    switch (values.length) {
      case 0:
        return FALSE;
      case 1:
        return {
          ...condition,
          op: '=',
          right: {type: 'literal', value: values[0]},
        };
      default:
        return {
          ...condition,
          right: {type: 'literal', value: values},
        };
    }
  }

  if (condition.op === 'NOT IN') {
    const values = dedupeInLiteralValues(value);
    switch (values.length) {
      case 0:
        return condition;
      case 1:
        return {
          ...condition,
          op: '!=',
          right: {type: 'literal', value: values[0]},
        };
      default:
        return {
          ...condition,
          right: {type: 'literal', value: values},
        };
    }
  }

  return condition;
}

function normalizeCorrelatedSubquery(
  condition: CorrelatedSubqueryCondition,
): CorrelatedSubqueryCondition {
  const {[planIdSymbol]: _planId, ...conditionWithoutPlanId} = condition;
  return {
    ...conditionWithoutPlanId,
    related: {
      ...condition.related,
      subquery: normalizePlannerAST(condition.related.subquery),
    },
  };
}

function buildAnd(conditions: readonly Condition[]): Condition {
  const flattened = flatten('and', conditions);
  if (flattened.some(isAlwaysFalse)) {
    return FALSE;
  }

  const deduped = dedupe(
    flattened.filter(condition => !isAlwaysTrue(condition)),
  );
  const intersected = intersectEquivalentAndPredicates(deduped);
  if (intersected.some(isAlwaysFalse)) {
    return FALSE;
  }

  switch (intersected.length) {
    case 0:
      return TRUE;
    case 1:
      return intersected[0];
    default:
      return {type: 'and', conditions: intersected};
  }
}

function buildOr(conditions: readonly Condition[]): Condition {
  const flattened = flatten('or', conditions);
  if (flattened.some(isAlwaysTrue)) {
    return TRUE;
  }

  const deduped = dedupe(
    flattened.filter(condition => !isAlwaysFalse(condition)),
  );
  if (deduped.length === 0) {
    return FALSE;
  }

  const compacted = mergeEquivalentOrPredicates(deduped);

  const factored = factorCommonConjuncts(compacted);
  if (factored) {
    return normalizeCondition(factored);
  }

  const merged = mergeSameRelationshipExists(compacted);
  switch (merged.length) {
    case 0:
      return FALSE;
    case 1:
      return merged[0];
    default:
      return {type: 'or', conditions: merged};
  }
}

type InMergeCandidate = {
  readonly left: ValuePosition;
  readonly values: readonly InLiteralValue[];
  readonly isAlreadyIn: boolean;
};

type InLiteralValue = string | number | boolean;

type InMergeGroup = {
  readonly left: ValuePosition;
  readonly firstIndex: number;
  readonly values: InLiteralValue[];
  readonly valueKeys: Set<string>;
  changed: boolean;
};

type DomainCandidate = {
  readonly left: ValuePosition;
  readonly include?: readonly InLiteralValue[] | undefined;
  readonly exclude: readonly InLiteralValue[];
  readonly isAlreadyCompound: boolean;
};

type DomainGroup = {
  readonly left: ValuePosition;
  readonly firstIndex: number;
  include: InLiteralValue[] | undefined;
  readonly exclude: InLiteralValue[];
  readonly excludeKeys: Set<string>;
  changed: boolean;
};

function intersectEquivalentAndPredicates(
  conditions: readonly Condition[],
): Condition[] {
  const intersected: Array<Condition | undefined> = [...conditions];
  const groups = new Map<string, DomainGroup>();

  for (const [index, condition] of conditions.entries()) {
    const candidate = getDomainCandidate(condition);
    if (!candidate) {
      continue;
    }

    const key = stableStringify(candidate.left);
    const group = groups.get(key);
    if (!group) {
      const nextGroup: DomainGroup = {
        left: candidate.left,
        firstIndex: index,
        include:
          candidate.include === undefined
            ? undefined
            : dedupeInLiteralValues(candidate.include),
        exclude: [],
        excludeKeys: new Set<string>(),
        changed: candidate.isAlreadyCompound,
      };
      groups.set(key, nextGroup);
      addExcludedValues(nextGroup, candidate.exclude);
      continue;
    }

    intersected[index] = undefined;
    group.changed = true;
    if (candidate.include !== undefined) {
      group.include =
        group.include === undefined
          ? dedupeInLiteralValues(candidate.include)
          : intersectInLiteralValues(group.include, candidate.include);
    }
    addExcludedValues(group, candidate.exclude);
  }

  for (const group of groups.values()) {
    if (!group.changed) {
      continue;
    }
    intersected[group.firstIndex] = buildDomainCondition(group);
  }

  return intersected.filter((condition): condition is Condition => !!condition);
}

function getDomainCandidate(condition: Condition): DomainCandidate | undefined {
  if (condition.type !== 'simple' || condition.right.type !== 'literal') {
    return undefined;
  }

  const {value} = condition.right;
  switch (condition.op) {
    case '=':
      return isInLiteralValue(value)
        ? {
            left: condition.left,
            include: [value],
            exclude: [],
            isAlreadyCompound: false,
          }
        : undefined;
    case 'IN':
      return Array.isArray(value) && value.every(isInLiteralValue)
        ? {
            left: condition.left,
            include: value,
            exclude: [],
            isAlreadyCompound: true,
          }
        : undefined;
    case '!=':
      return isInLiteralValue(value)
        ? {
            left: condition.left,
            exclude: [value],
            isAlreadyCompound: false,
          }
        : undefined;
    case 'NOT IN':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every(isInLiteralValue)
        ? {
            left: condition.left,
            exclude: value,
            isAlreadyCompound: true,
          }
        : undefined;
    default:
      return undefined;
  }
}

function addExcludedValues(
  group: DomainGroup,
  values: readonly InLiteralValue[],
): void {
  for (const value of values) {
    const key = stableStringify(value);
    if (group.excludeKeys.has(key)) {
      group.changed = true;
      continue;
    }
    group.excludeKeys.add(key);
    group.exclude.push(value);
  }
}

function buildDomainCondition(group: DomainGroup): Condition {
  if (group.include !== undefined) {
    return buildInCondition(
      group.left,
      group.include.filter(
        value => !group.excludeKeys.has(stableStringify(value)),
      ),
    );
  }
  return buildNotInCondition(group.left, group.exclude);
}

function mergeEquivalentOrPredicates(
  conditions: readonly Condition[],
): Condition[] {
  const merged: Array<Condition | undefined> = [...conditions];
  const groups = new Map<string, InMergeGroup>();

  for (const [index, condition] of conditions.entries()) {
    const candidate = getInMergeCandidate(condition);
    if (!candidate) {
      continue;
    }

    const key = stableStringify(candidate.left);
    let group = groups.get(key);
    if (!group) {
      group = {
        left: candidate.left,
        firstIndex: index,
        values: [],
        valueKeys: new Set(),
        changed: candidate.isAlreadyIn,
      };
      groups.set(key, group);
    } else {
      merged[index] = undefined;
      group.changed = true;
    }

    for (const value of candidate.values) {
      const valueKey = stableStringify(value);
      if (group.valueKeys.has(valueKey)) {
        group.changed = true;
        continue;
      }
      group.valueKeys.add(valueKey);
      group.values.push(value);
    }
  }

  for (const group of groups.values()) {
    if (!group.changed) {
      continue;
    }
    merged[group.firstIndex] = buildInCondition(group.left, group.values);
  }

  return merged.filter((condition): condition is Condition => !!condition);
}

function buildInCondition(
  left: ValuePosition,
  values: readonly InLiteralValue[],
): Condition {
  switch (values.length) {
    case 0:
      return FALSE;
    case 1:
      return {
        type: 'simple',
        left,
        op: '=',
        right: {type: 'literal', value: values[0]},
      };
    default:
      return {
        type: 'simple',
        left,
        op: 'IN',
        right: {type: 'literal', value: values},
      };
  }
}

function buildNotInCondition(
  left: ValuePosition,
  values: readonly InLiteralValue[],
): Condition {
  switch (values.length) {
    case 0:
      return TRUE;
    case 1:
      return {
        type: 'simple',
        left,
        op: '!=',
        right: {type: 'literal', value: values[0]},
      };
    default:
      return {
        type: 'simple',
        left,
        op: 'NOT IN',
        right: {type: 'literal', value: values},
      };
  }
}

function getInMergeCandidate(
  condition: Condition,
): InMergeCandidate | undefined {
  if (condition.type !== 'simple') {
    return undefined;
  }

  if (condition.op === '=') {
    const value =
      condition.right.type === 'literal' ? condition.right.value : undefined;
    if (isInLiteralValue(value)) {
      return {
        left: condition.left,
        values: [value],
        isAlreadyIn: false,
      };
    }
    return undefined;
  }

  if (condition.op === 'IN' && condition.right.type === 'literal') {
    const value = condition.right.value;
    if (Array.isArray(value) && value.every(isInLiteralValue)) {
      return {
        left: condition.left,
        values: value,
        isAlreadyIn: true,
      };
    }
  }

  return undefined;
}

function isInLiteralValue(
  value: LiteralValue | undefined,
): value is InLiteralValue {
  return value !== undefined && value !== null && !Array.isArray(value);
}

function dedupeInLiteralValues(
  values: readonly InLiteralValue[],
): InLiteralValue[] {
  const seen = new Set<string>();
  const deduped: InLiteralValue[] = [];
  for (const value of values) {
    const key = stableStringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function intersectInLiteralValues(
  left: readonly InLiteralValue[],
  right: readonly InLiteralValue[],
): InLiteralValue[] {
  const rightValues = new Set(right.map(stableStringify));
  return left.filter(value => rightValues.has(stableStringify(value)));
}

function flatten(
  type: 'and' | 'or',
  conditions: readonly Condition[],
): Condition[] {
  const flattened: Condition[] = [];
  for (const condition of conditions) {
    if (condition.type === type) {
      flattened.push(...condition.conditions);
    } else {
      flattened.push(condition);
    }
  }
  return flattened;
}

function factorCommonConjuncts(
  conditions: readonly Condition[],
): Condition | undefined {
  if (conditions.length < 2) {
    return undefined;
  }

  const branches = conditions.map(condition =>
    condition.type === 'and' ? [...condition.conditions] : [condition],
  );
  const commonKeys = new Set(branches[0].map(conditionKey));
  for (const branch of branches.slice(1)) {
    const branchKeys = new Set(branch.map(conditionKey));
    for (const key of [...commonKeys]) {
      if (!branchKeys.has(key)) {
        commonKeys.delete(key);
      }
    }
  }

  if (commonKeys.size === 0) {
    return undefined;
  }

  const common: Condition[] = [];
  const firstBranch = branches[0];
  for (const condition of firstBranch) {
    if (commonKeys.has(conditionKey(condition))) {
      common.push(condition);
    }
  }

  const remainingBranches = branches.map(branch =>
    branch.filter(condition => !commonKeys.has(conditionKey(condition))),
  );

  return buildAnd([
    ...common,
    buildOr(remainingBranches.map(branch => buildAnd(branch))),
  ]);
}

function mergeSameRelationshipExists(
  conditions: readonly Condition[],
): Condition[] {
  const merged: Array<Condition | undefined> = [...conditions];
  const groups = new Map<
    string,
    {
      readonly template: CorrelatedSubqueryCondition;
      readonly firstIndex: number;
      readonly filters: Condition[];
    }
  >();

  for (const [index, condition] of conditions.entries()) {
    const key = mergeableExistsKey(condition);
    if (!key || condition.type !== 'correlatedSubquery') {
      continue;
    }

    const group = groups.get(key);
    const filter = condition.related.subquery.where ?? TRUE;
    if (group) {
      merged[index] = undefined;
      group.filters.push(filter);
    } else {
      groups.set(key, {
        template: condition,
        firstIndex: index,
        filters: [filter],
      });
    }
  }

  for (const group of groups.values()) {
    merged[group.firstIndex] = mergeExistsGroup(group.template, group.filters);
  }

  return dedupe(
    merged.filter((condition): condition is Condition => !!condition),
  );
}

function mergeExistsGroup(
  template: CorrelatedSubqueryCondition,
  filters: readonly Condition[],
): CorrelatedSubqueryCondition {
  const where = buildOr(filters);
  return {
    ...template,
    related: {
      ...template.related,
      subquery: {
        ...template.related.subquery,
        where: isAlwaysTrue(where) ? undefined : where,
      },
    },
  };
}

function mergeableExistsKey(condition: Condition): string | undefined {
  if (condition.type !== 'correlatedSubquery') {
    return undefined;
  }
  if (condition.op !== 'EXISTS' || condition.scalar === true) {
    return undefined;
  }

  const {related} = condition;
  const {subquery} = related;
  if (
    subquery.related !== undefined ||
    subquery.start !== undefined ||
    subquery.limit !== undefined ||
    subquery.orderBy !== undefined
  ) {
    return undefined;
  }

  const mergeShape: CorrelatedSubquery = {
    ...related,
    subquery: {
      schema: subquery.schema,
      table: subquery.table,
      alias: subquery.alias,
    },
  };
  return stableStringify({
    op: condition.op,
    flip: condition.flip,
    scalar: condition.scalar,
    related: mergeShape,
  });
}

function dedupe(conditions: readonly Condition[]): Condition[] {
  const seen = new Set<string>();
  const deduped: Condition[] = [];
  for (const condition of conditions) {
    const key = conditionKey(condition);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(condition);
  }
  return deduped;
}

function conditionKey(condition: Condition): string {
  return stableStringify(condition);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isAlwaysTrue(condition: Condition): boolean {
  return condition.type === 'and' && condition.conditions.length === 0;
}

function isAlwaysFalse(condition: Condition): boolean {
  return condition.type === 'or' && condition.conditions.length === 0;
}
