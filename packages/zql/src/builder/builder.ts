import type {LogContext} from '@rocicorp/logger';
import {assert, unreachable} from '../../../shared/src/asserts.ts';
import type {JSONValue} from '../../../shared/src/json.ts';
import {must} from '../../../shared/src/must.ts';
import type {
  AST,
  ColumnReference,
  CompoundKey,
  Condition,
  Conjunction,
  CorrelatedSubquery,
  CorrelatedSubqueryCondition,
  Disjunction,
  LiteralValue,
  Ordering,
  Parameter,
  SimpleCondition,
  ValuePosition,
} from '../../../zero-protocol/src/ast.ts';
import type {Row} from '../../../zero-protocol/src/data.ts';
import type {PrimaryKey} from '../../../zero-protocol/src/primary-key.ts';
import {Exists} from '../ivm/exists.ts';
import {FanIn} from '../ivm/fan-in.ts';
import {FanOut} from '../ivm/fan-out.ts';
import {
  buildFilterPipeline,
  type FilterInput,
} from '../ivm/filter-operators.ts';
import {Filter} from '../ivm/filter.ts';
import {FlippedJoin} from '../ivm/flipped-join.ts';
import {Join} from '../ivm/join.ts';
import type {Input, InputBase, Storage} from '../ivm/operator.ts';
import {InputIntersection, InputUnion} from '../ivm/set-operators.ts';
import {Skip} from '../ivm/skip.ts';
import type {Source, SourceInput} from '../ivm/source.ts';
import {Take} from '../ivm/take.ts';
import {UnionFanIn} from '../ivm/union-fan-in.ts';
import {UnionFanOut} from '../ivm/union-fan-out.ts';
import {planQuery} from '../planner/planner-builder.ts';
import type {ConnectionCostModel} from '../planner/planner-connection.ts';
import type {PlanDebugger} from '../planner/planner-debug.ts';
import {completeOrdering} from '../query/complete-ordering.ts';
import type {DebugDelegate} from './debug-delegate.ts';
import {createPredicate, type NoSubqueryCondition} from './filter.ts';

export type StaticQueryParameters = {
  authData: Record<string, JSONValue>;
  preMutationRow?: Row | undefined;
};

/**
 * Interface required of caller to buildPipeline. Connects to constructed
 * pipeline to delegate environment to provide sources and storage.
 */
export interface BuilderDelegate {
  readonly applyFiltersAnyway?: boolean | undefined;
  debug?: DebugDelegate | undefined;

  /**
   * When true, allows NOT EXISTS conditions in queries.
   * Defaults to false.
   *
   * We only set this to true on the server.
   * The client-side query engine cannot support NOT EXISTS because:
   * 1. Zero only syncs a subset of data to the client
   * 2. On the client, we can't distinguish between a row not existing vs.
   *    a row not being synced to the client
   * 3. NOT EXISTS requires complete knowledge of what doesn't exist
   */
  readonly enableNotExists?: boolean | undefined;

  /**
   * Called once for each source needed by the AST.
   * Might be called multiple times with same tableName. It is OK to return
   * same storage instance in that case.
   */
  getSource(tableName: string): Source | undefined;

  /**
   * Called once for each operator that requires storage. Should return a new
   * unique storage object for each call.
   */
  createStorage(name: string): Storage;

  decorateInput(input: Input, name: string): Input;

  addEdge(source: InputBase, dest: InputBase): void;

  decorateFilterInput(input: FilterInput, name: string): FilterInput;

  decorateSourceInput(input: SourceInput, queryID: string): Input;

  /**
   * The AST is mapped on-the-wire between client and server names.
   *
   * There is no "wire" for zqlite tests so this function is provided
   * to allow tests to remap the AST.
   */
  mapAst?: ((ast: AST) => AST) | undefined;
}

/**
 * Builds a pipeline from an AST. Caller must provide a delegate to create source
 * and storage interfaces as necessary.
 *
 * Usage:
 *
 * ```ts
 * class MySink implements Output {
 *   readonly #input: Input;
 *
 *   constructor(input: Input) {
 *     this.#input = input;
 *     input.setOutput(this);
 *   }
 *
 *   push(change: Change, _: Operator) {
 *     console.log(change);
 *   }
 * }
 *
 * const input = buildPipeline(ast, myDelegate, hash(ast));
 * const sink = new MySink(input);
 * ```
 */
export function buildPipeline(
  ast: AST,
  delegate: BuilderDelegate,
  queryID: string,
  costModel?: ConnectionCostModel,
  lc?: LogContext,
  planDebugger?: PlanDebugger,
): Input {
  ast = delegate.mapAst ? delegate.mapAst(ast) : ast;
  ast = completeOrdering(
    ast,
    tableName => must(delegate.getSource(tableName)).tableSchema.primaryKey,
  );

  if (costModel) {
    ast = planQuery(ast, costModel, planDebugger, lc);
  }
  return buildPipelineInternal(ast, delegate, queryID, '');
}

export function bindStaticParameters(
  ast: AST,
  staticQueryParameters: StaticQueryParameters | undefined,
) {
  const visit = (node: AST): AST => ({
    ...node,
    where: node.where ? bindCondition(node.where) : undefined,
    related: node.related?.map(sq => ({
      ...sq,
      subquery: visit(sq.subquery),
    })),
  });

  function bindCondition(condition: Condition): Condition {
    if (condition.type === 'simple') {
      return {
        ...condition,
        left: bindValue(condition.left),
        right: bindValue(condition.right) as Exclude<
          ValuePosition,
          ColumnReference
        >,
      };
    }
    if (condition.type === 'correlatedSubquery') {
      return {
        ...condition,
        related: {
          ...condition.related,
          subquery: visit(condition.related.subquery),
        },
      };
    }

    return {
      ...condition,
      conditions: condition.conditions.map(bindCondition),
    };
  }

  const bindValue = (value: ValuePosition): ValuePosition => {
    if (isParameter(value)) {
      const anchor = must(
        staticQueryParameters,
        'Static query params do not exist',
      )[value.anchor];
      const resolvedValue = resolveField(anchor, value.field);
      return {
        type: 'literal',
        value: resolvedValue as LiteralValue,
      };
    }
    return value;
  };

  return visit(ast);
}

function resolveField(
  anchor: Record<string, JSONValue> | Row | undefined,
  field: string | string[],
): unknown {
  if (anchor === undefined) {
    return null;
  }

  if (Array.isArray(field)) {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    return field.reduce((acc, f) => (acc as any)?.[f], anchor) ?? null;
  }

  return anchor[field] ?? null;
}

function isParameter(value: ValuePosition): value is Parameter {
  return value.type === 'static';
}

const EXISTS_LIMIT = 3;
const PERMISSIONS_EXISTS_LIMIT = 1;

/**
 * Checks if a condition tree contains any NOT EXISTS operations.
 * Recursively checks AND/OR branches but does not recurse into nested subqueries
 * (those are checked when buildPipelineInternal processes them).
 */
export function assertNoNotExists(condition: Condition): void {
  switch (condition.type) {
    case 'simple':
      return;

    case 'correlatedSubquery':
      if (condition.op === 'NOT EXISTS') {
        throw new Error(
          'not(exists()) is not supported on the client - see https://bugs.rocicorp.dev/issue/3438',
        );
      }
      return;

    case 'and':
    case 'or':
      for (const c of condition.conditions) {
        assertNoNotExists(c);
      }
      return;
    default:
      unreachable(condition);
  }
}

function buildPipelineInternal(
  ast: AST,
  delegate: BuilderDelegate,
  queryID: string,
  name: string,
  partitionKey?: CompoundKey,
): Input {
  const source = delegate.getSource(ast.table);
  if (!source) {
    throw new Error(`Source not found: ${ast.table}`);
  }

  ast = uniquifyCorrelatedSubqueryConditionAliases(ast);

  if (!delegate.enableNotExists && ast.where) {
    assertNoNotExists(ast.where);
  }

  // Two narrow physical rewrites run before the generic source/filter/join
  // pipeline below. They are not boolean normalizations. They replace a broad
  // parent scan with a plan that starts from selective roots once the planner
  // has marked at least one EXISTS as flipped.
  //
  // OR shape:
  //
  //   parent WHERE A OR EXISTS(child WHERE B)
  //
  // becomes:
  //
  //   parent WHERE A        child WHERE B
  //          \              /
  //           \            /
  //              InputUnion
  //
  // AND shape:
  //
  //   parent WHERE EXISTS(child WHERE B) AND EXISTS(child WHERE C)
  //
  // becomes:
  //
  //   child WHERE B   child WHERE C
  //        \             /
  //       InputIntersection on child correlation key
  //                 |
  //          FlippedJoin to parent
  //
  // The guards on each rewrite are intentionally strict. If a query needs
  // limits, related rows, non unique child matches, or nested subquery
  // semantics, it falls through to the older pipeline.
  const rootUnionBranches = getRootUnionBranches(ast);
  if (rootUnionBranches) {
    return applyRootUnionBranches(
      ast,
      rootUnionBranches,
      delegate,
      queryID,
      name,
      partitionKey,
    );
  }

  const intersection = getSameRelationshipExistsIntersection(
    ast.where,
    delegate,
  );
  const sourceWhere = intersection ? undefined : ast.where;
  const csqConditions = intersection
    ? []
    : gatherCorrelatedSubqueryQueryConditions(ast.where);
  const splitEditKeys: Set<string> = partitionKey
    ? new Set(partitionKey)
    : new Set();
  for (const csq of csqConditions) {
    for (const key of csq.related.correlation.parentField) {
      splitEditKeys.add(key);
    }
  }
  if (intersection) {
    for (const key of intersection.related.correlation.parentField) {
      splitEditKeys.add(key);
    }
  }
  if (ast.related) {
    for (const csq of ast.related) {
      for (const key of csq.correlation.parentField) {
        splitEditKeys.add(key);
      }
    }
  }
  const conn = source.connect(
    must(ast.orderBy),
    sourceWhere,
    splitEditKeys,
    delegate.debug,
  );

  let end: Input = delegate.decorateSourceInput(conn, queryID);
  end = delegate.decorateInput(end, `${name}:source(${ast.table})`);
  const {fullyAppliedFilters} = conn;

  if (intersection) {
    end = applySameRelationshipExistsIntersection(
      intersection,
      delegate,
      end,
      name,
    );
  }

  if (ast.start) {
    const skip = new Skip(end, ast.start);
    delegate.addEdge(end, skip);
    end = delegate.decorateInput(skip, `${name}:skip)`);
  }

  for (const csqCondition of csqConditions) {
    // flipped EXISTS are handled in applyWhere
    if (!csqCondition.flip) {
      end = applyCorrelatedSubQuery(
        {
          ...csqCondition.related,
          subquery: {
            ...csqCondition.related.subquery,
            limit:
              csqCondition.related.system === 'permissions'
                ? PERMISSIONS_EXISTS_LIMIT
                : EXISTS_LIMIT,
          },
        },
        delegate,
        queryID,
        end,
        name,
        true,
      );
    }
  }

  if (sourceWhere && (!fullyAppliedFilters || delegate.applyFiltersAnyway)) {
    end = applyWhere(end, sourceWhere, delegate, name);
  }

  if (ast.limit !== undefined) {
    const takeName = `${name}:take`;
    const take = new Take(
      end,
      delegate.createStorage(takeName),
      ast.limit,
      partitionKey,
    );
    delegate.addEdge(end, take);
    end = delegate.decorateInput(take, takeName);
  }

  if (ast.related) {
    // Dedupe by alias - last one wins (LWW), like limit(5).limit(10)
    const byAlias = new Map<string, CorrelatedSubquery>();
    for (const csq of ast.related) {
      byAlias.set(csq.subquery.alias ?? '', csq);
    }
    for (const csq of byAlias.values()) {
      end = applyCorrelatedSubQuery(csq, delegate, queryID, end, name, false);
    }
  }

  return end;
}

function applyRootUnionBranches(
  ast: AST,
  branches: readonly Condition[],
  delegate: BuilderDelegate,
  queryID: string,
  name: string,
  partitionKey?: CompoundKey,
): Input {
  // Run every OR branch as its own root query, then merge by primary key.
  // This is the physical equivalent of SQLite's multi-index OR strategy:
  //
  //   OR
  //     teacher_id = 1
  //     EXISTS(membership student_id = 'student-1')
  //
  //   parent root: teacher_id = 1
  //   child root:  membership student_id = 'student-1' -> parent lookup
  //   union:       sorted primary-key dedupe
  //
  // Each recursive branch keeps the same ordering and split-edit keys as the
  // original AST, so the union can merge streams without re-sorting.
  const inputs = branches.map((branch, index) =>
    buildPipelineInternal(
      {
        ...ast,
        where: branch,
      },
      delegate,
      queryID,
      `${name}:or-${index}`,
      partitionKey,
    ),
  );

  const union = new InputUnion(inputs);
  for (const input of inputs) {
    delegate.addEdge(input, union);
  }
  return delegate.decorateInput(union, `${name}:input-union`);
}

function getRootUnionBranches(ast: AST): readonly Condition[] | undefined {
  // This rewrite is only safe at the root of a plain query. start, limit, and
  // related rows all observe the whole result stream, so they need a richer
  // physical plan than "run branch pipelines, then union".
  if (
    ast.where?.type !== 'or' ||
    ast.where.conditions.length < 2 ||
    ast.start !== undefined ||
    ast.limit !== undefined ||
    ast.related !== undefined
  ) {
    return undefined;
  }

  const branches = ast.where.conditions;

  // At least one branch must already be source driven by a flipped EXISTS.
  // Otherwise a root union would just split a query that the existing source
  // or filter pipeline can already handle.
  if (!branches.some(conditionIncludesFlippedSubqueryAtAnyLevel)) {
    return undefined;
  }

  // There must also be at least one local parent branch. If every branch is a
  // child branch, the existing UnionFanOut and UnionFanIn path handles it.
  if (!branches.some(isNotAndDoesNotContainSubquery)) {
    return undefined;
  }

  // The normalizer flattens ORs before planning. If a nested OR survives here,
  // keep the old path rather than inventing branch semantics locally.
  if (branches.some(branch => branch.type === 'or')) {
    return undefined;
  }

  return branches;
}

function applySameRelationshipExistsIntersection(
  intersection: SameRelationshipExistsIntersection,
  delegate: BuilderDelegate,
  end: Input,
  name: string,
): Input {
  // Build the child side before the parent lookup:
  //
  //   assignment_to_student WHERE student_id = 'student-1'
  //                 intersect by assignment_id
  //   assignment_to_student WHERE student_id = 'student-2'
  //                 |
  //          assignment WHERE id = assignment_id
  //
  // The resulting InputIntersection emits child rows whose correlation key is
  // present in every sibling EXISTS branch. FlippedJoin then performs the
  // reduced parent lookup. This avoids loading a parent row after the first
  // child scan only to probe the second child relationship row-by-row.
  const {conditions, related} = intersection;
  const childInputs = conditions.map((condition, index) =>
    buildPipelineInternal(
      condition.related.subquery,
      delegate,
      '',
      `${name}.${condition.related.subquery.alias}:intersect-${index}`,
      related.correlation.childField,
    ),
  );
  const child = new InputIntersection(
    childInputs,
    related.correlation.childField,
  );
  for (const childInput of childInputs) {
    delegate.addEdge(childInput, child);
  }

  const flippedJoin = new FlippedJoin({
    parent: end,
    child,
    parentKey: related.correlation.parentField,
    childKey: related.correlation.childField,
    relationshipName: must(
      related.subquery.alias,
      'Subquery must have an alias',
    ),
    hidden: related.hidden ?? false,
    system: related.system ?? 'client',
  });
  delegate.addEdge(end, flippedJoin);
  delegate.addEdge(child, flippedJoin);
  return delegate.decorateInput(
    flippedJoin,
    `${name}:intersect-flipped-join(${related.subquery.alias})`,
  );
}

type SameRelationshipExistsIntersection = {
  readonly related: CorrelatedSubquery;
  readonly conditions: readonly CorrelatedSubqueryCondition[];
};

function getSameRelationshipExistsIntersection(
  condition: Condition | undefined,
  delegate: BuilderDelegate,
): SameRelationshipExistsIntersection | undefined {
  // Detect a narrow, physical intersection opportunity:
  //
  //   AND
  //     EXISTS(relationship R, child predicate A)
  //     EXISTS(relationship R, child predicate B)
  //
  // We only need one sibling to be planned as flipped. Once one branch is
  // source-driven, intersecting all compatible siblings lets the runtime start
  // with the child table and avoid parent-first probing.
  if (condition?.type !== 'and') {
    return undefined;
  }

  const conditions = condition.conditions.map(getIntersectableExists);
  if (conditions.some(candidate => candidate === undefined)) {
    return undefined;
  }

  const candidates = conditions as CorrelatedSubqueryCondition[];
  if (candidates.length < 2) {
    return undefined;
  }

  // Respect explicit user intent. flip: false means "keep this semi-join".
  // Undefined still means the planner may decide, so it can join a group where
  // another sibling was chosen as flipped.
  if (!candidates.some(candidate => candidate.flip === true)) {
    return undefined;
  }

  const key = sameRelationshipExistsKey(candidates[0]);
  if (
    !key ||
    candidates.some(candidate => sameRelationshipExistsKey(candidate) !== key)
  ) {
    return undefined;
  }

  const childSource = delegate.getSource(candidates[0].related.subquery.table);
  if (!childSource) {
    return undefined;
  }

  // InputIntersection is a key-set operator. It emits one representative row
  // per child correlation key, so each branch must be unique for that key.
  // If a branch could return two child rows for the same parent, intersecting
  // keys would no longer match the row-level EXISTS stream semantics.
  if (
    candidates.some(
      candidate =>
        !isUniquePerCorrelationKey(
          candidate,
          childSource.tableSchema.primaryKey,
        ),
    )
  ) {
    return undefined;
  }

  return {
    related: candidates[0].related,
    conditions: candidates,
  };
}

function getIntersectableExists(
  condition: Condition,
): CorrelatedSubqueryCondition | undefined {
  // The AND intersection rewrite is only valid for the simple shape below:
  //
  //   EXISTS child
  //     where child filters have no nested EXISTS
  //     with no child related/start/limit
  //
  // Nested relationships, cursors, and limits can make "does this parent key
  // exist?" depend on more than the child predicate's key domain. In that
  // world, intersecting child key sets could skip rows that the original
  // sibling EXISTS checks would have accepted.
  return match(asCorrelatedSubqueryCondition(condition))
    .when(isPlainExistsBranch)
    .when(hasIntersectableChildSubquery)
    .value();
}

function asCorrelatedSubqueryCondition(
  condition: Condition,
): CorrelatedSubqueryCondition | undefined {
  return condition.type === 'correlatedSubquery' ? condition : undefined;
}

function isPlainExistsBranch(condition: CorrelatedSubqueryCondition): boolean {
  return (
    condition.op === 'EXISTS' &&
    condition.scalar !== true &&
    condition.flip !== false
  );
}

function hasIntersectableChildSubquery(
  condition: CorrelatedSubqueryCondition,
): boolean {
  const {subquery} = condition.related;
  return (
    subquery.related === undefined &&
    subquery.start === undefined &&
    subquery.limit === undefined &&
    (subquery.where === undefined ||
      isNotAndDoesNotContainSubquery(subquery.where))
  );
}

function sameRelationshipExistsKey(
  condition: CorrelatedSubqueryCondition,
): string | undefined {
  const exists = getIntersectableExists(condition);
  if (!exists) {
    return undefined;
  }

  const {related} = exists;
  // Include orderBy because SourceSchema.sort must match across every child
  // input in the intersection. EXISTS does not care about child ordering
  // semantically, but the runtime stream contract does.
  return JSON.stringify({
    system: related.system,
    hidden: related.hidden,
    correlation: related.correlation,
    orderBy: related.subquery.orderBy,
    subquery: {
      schema: related.subquery.schema,
      table: related.subquery.table,
    },
  });
}

function isUniquePerCorrelationKey(
  condition: CorrelatedSubqueryCondition,
  childPrimaryKey: readonly string[],
): boolean {
  // Prove:
  //
  //   correlation child fields + literal equality filters cover child PK
  //
  // Example:
  //
  //   child PK:          [assignment_id, student_id]
  //   correlation key:   [assignment_id]
  //   child predicate:   student_id = 'student-1'
  //
  // The branch can now emit at most one membership row for each assignment_id,
  // so intersecting by assignment_id is equivalent to intersecting row sets for
  // EXISTS purposes.
  const constrained = new Set(condition.related.correlation.childField);
  collectEqualityConstrainedColumns(
    condition.related.subquery.where,
    constrained,
  );
  return childPrimaryKey.every(key => constrained.has(key));
}

function collectEqualityConstrainedColumns(
  condition: Condition | undefined,
  constrained: Set<string>,
): void {
  // This is intentionally conservative. Only literal equality predicates prove
  // uniqueness. IN, OR, scalar subqueries, and nested EXISTS can still be
  // optimized later, but they need a richer proof than this small helper.
  if (!condition) {
    return;
  }
  if (condition.type === 'simple') {
    if (
      condition.op === '=' &&
      condition.left.type === 'column' &&
      condition.right.type === 'literal'
    ) {
      constrained.add(condition.left.name);
    }
    return;
  }
  if (condition.type === 'and') {
    for (const child of condition.conditions) {
      collectEqualityConstrainedColumns(child, constrained);
    }
  }
}

function applyWhere(
  input: Input,
  condition: Condition,
  delegate: BuilderDelegate,
  name: string,
): Input {
  if (!conditionIncludesFlippedSubqueryAtAnyLevel(condition)) {
    return buildFilterPipeline(input, delegate, filterInput =>
      applyFilter(filterInput, condition, delegate, name),
    );
  }

  return applyFilterWithFlips(input, condition, delegate, name);
}

function applyFilterWithFlips(
  input: Input,
  condition: Condition,
  delegate: BuilderDelegate,
  name: string,
): Input {
  let end = input;
  assert(condition.type !== 'simple', 'Simple conditions cannot have flips');

  switch (condition.type) {
    case 'and': {
      const [withFlipped, withoutFlipped] = partitionBranches(
        condition.conditions,
        conditionIncludesFlippedSubqueryAtAnyLevel,
      );
      if (withoutFlipped.length > 0) {
        end = buildFilterPipeline(input, delegate, filterInput =>
          applyAnd(
            filterInput,
            {
              type: 'and',
              conditions: withoutFlipped,
            },
            delegate,
            name,
          ),
        );
      }
      assert(withFlipped.length > 0, 'Impossible to have no flips here');
      for (const cond of withFlipped) {
        end = applyFilterWithFlips(end, cond, delegate, name);
      }
      break;
    }
    case 'or': {
      const [withFlipped, withoutFlipped] = partitionBranches(
        condition.conditions,
        conditionIncludesFlippedSubqueryAtAnyLevel,
      );
      assert(withFlipped.length > 0, 'Impossible to have no flips here');

      const ufo = new UnionFanOut(end);
      delegate.addEdge(end, ufo);
      end = delegate.decorateInput(ufo, `${name}:ufo`);

      const branches: Input[] = [];
      if (withoutFlipped.length > 0) {
        const branch = buildFilterPipeline(end, delegate, filterInput =>
          applyOr(
            filterInput,
            {
              type: 'or',
              conditions: withoutFlipped,
            },
            delegate,
            name,
          ),
        );
        branches.push(branch);
      }

      for (const cond of withFlipped) {
        branches.push(applyFilterWithFlips(end, cond, delegate, name));
      }

      const ufi = new UnionFanIn(ufo, branches);
      for (const branch of branches) {
        delegate.addEdge(branch, ufi);
      }
      end = delegate.decorateInput(ufi, `${name}:ufi`);

      break;
    }
    case 'correlatedSubquery': {
      const sq = condition.related;
      const child = buildPipelineInternal(
        sq.subquery,
        delegate,
        '',
        `${name}.${sq.subquery.alias}`,
        sq.correlation.childField,
      );
      const flippedJoin = new FlippedJoin({
        parent: end,
        child,
        parentKey: sq.correlation.parentField,
        childKey: sq.correlation.childField,
        relationshipName: must(
          sq.subquery.alias,
          'Subquery must have an alias',
        ),
        hidden: sq.hidden ?? false,
        system: sq.system ?? 'client',
      });
      delegate.addEdge(end, flippedJoin);
      delegate.addEdge(child, flippedJoin);
      end = delegate.decorateInput(
        flippedJoin,
        `${name}:flipped-join(${sq.subquery.alias})`,
      );
      break;
    }
  }

  return end;
}

function applyFilter(
  input: FilterInput,
  condition: Condition,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  switch (condition.type) {
    case 'and':
      return applyAnd(input, condition, delegate, name);
    case 'or':
      return applyOr(input, condition, delegate, name);
    case 'correlatedSubquery':
      return applyCorrelatedSubqueryCondition(input, condition, delegate, name);
    case 'simple':
      return applySimpleCondition(input, delegate, condition);
  }
}

function applyAnd(
  input: FilterInput,
  condition: Conjunction,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  for (const subCondition of condition.conditions) {
    input = applyFilter(input, subCondition, delegate, name);
  }
  return input;
}

export function applyOr(
  input: FilterInput,
  condition: Disjunction,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  const [subqueryConditions, otherConditions] =
    groupSubqueryConditions(condition);
  // if there are no subquery conditions, no fan-in / fan-out is needed
  if (subqueryConditions.length === 0) {
    const filter = new Filter(
      input,
      createPredicate({
        type: 'or',
        conditions: otherConditions,
      }),
    );
    delegate.addEdge(input, filter);
    return filter;
  }

  const fanOut = new FanOut(input);
  delegate.addEdge(input, fanOut);
  const branches = subqueryConditions.map(subCondition =>
    applyFilter(fanOut, subCondition, delegate, name),
  );
  if (otherConditions.length > 0) {
    const filter = new Filter(
      fanOut,
      createPredicate({
        type: 'or',
        conditions: otherConditions,
      }),
    );
    delegate.addEdge(fanOut, filter);
    branches.push(filter);
  }
  const ret = new FanIn(fanOut, branches);
  for (const branch of branches) {
    delegate.addEdge(branch, ret);
  }
  fanOut.setFanIn(ret);
  return ret;
}

export function groupSubqueryConditions(condition: Disjunction) {
  const partitioned: [
    subqueryConditions: Condition[],
    otherConditions: NoSubqueryCondition[],
  ] = [[], []];
  for (const subCondition of condition.conditions) {
    if (isNotAndDoesNotContainSubquery(subCondition)) {
      partitioned[1].push(subCondition);
    } else {
      partitioned[0].push(subCondition);
    }
  }
  return partitioned;
}

export function isNotAndDoesNotContainSubquery(
  condition: Condition,
): condition is NoSubqueryCondition {
  if (condition.type === 'correlatedSubquery') {
    return false;
  }
  if (condition.type === 'simple') {
    return true;
  }
  return condition.conditions.every(isNotAndDoesNotContainSubquery);
}

function applySimpleCondition(
  input: FilterInput,
  delegate: BuilderDelegate,
  condition: SimpleCondition,
): FilterInput {
  const filter = new Filter(input, createPredicate(condition));
  delegate.decorateFilterInput(
    filter,
    `${valuePosName(condition.left)}:${condition.op}:${valuePosName(condition.right)}`,
  );
  delegate.addEdge(input, filter);
  return filter;
}

function valuePosName(left: ValuePosition) {
  switch (left.type) {
    case 'static':
      return left.field;
    case 'literal':
      return left.value;
    case 'column':
      return left.name;
  }
}

function applyCorrelatedSubQuery(
  sq: CorrelatedSubquery,
  delegate: BuilderDelegate,
  queryID: string,
  end: Input,
  name: string,
  fromCondition: boolean,
) {
  // TODO: we only omit the join if the CSQ if from a condition since
  // we want to create an empty array for `related` fields that are `limit(0)`
  if (sq.subquery.limit === 0 && fromCondition) {
    return end;
  }

  assert(sq.subquery.alias, 'Subquery must have an alias');
  const child = buildPipelineInternal(
    sq.subquery,
    delegate,
    queryID,
    `${name}.${sq.subquery.alias}`,
    sq.correlation.childField,
  );

  const joinName = `${name}:join(${sq.subquery.alias})`;
  const join = new Join({
    parent: end,
    child,
    parentKey: sq.correlation.parentField,
    childKey: sq.correlation.childField,
    relationshipName: sq.subquery.alias,
    hidden: sq.hidden ?? false,
    system: sq.system ?? 'client',
  });
  delegate.addEdge(end, join);
  delegate.addEdge(child, join);
  return delegate.decorateInput(join, joinName);
}

function applyCorrelatedSubqueryCondition(
  input: FilterInput,
  condition: CorrelatedSubqueryCondition,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  assert(
    condition.op === 'EXISTS' || condition.op === 'NOT EXISTS',
    'Expected EXISTS or NOT EXISTS operator',
  );
  if (condition.related.subquery.limit === 0) {
    if (condition.op === 'EXISTS') {
      const filter = new Filter(input, () => false);
      delegate.addEdge(input, filter);
      return filter;
    }
    const filter = new Filter(input, () => true);
    delegate.addEdge(input, filter);
    return filter;
  }
  const existsName = `${name}:exists(${condition.related.subquery.alias})`;
  const exists = new Exists(
    input,
    must(condition.related.subquery.alias),
    condition.related.correlation.parentField,
    condition.op,
  );
  delegate.addEdge(input, exists);
  return delegate.decorateFilterInput(exists, existsName);
}

function gatherCorrelatedSubqueryQueryConditions(
  condition: Condition | undefined,
) {
  const csqs: CorrelatedSubqueryCondition[] = [];
  const gather = (condition: Condition) => {
    if (condition.type === 'correlatedSubquery') {
      csqs.push(condition);
      return;
    }
    if (condition.type === 'and' || condition.type === 'or') {
      for (const c of condition.conditions) {
        gather(c);
      }
      return;
    }
  };
  if (condition) {
    gather(condition);
  }
  return csqs;
}

export function assertOrderingIncludesPK(
  ordering: Ordering,
  pk: PrimaryKey,
): void {
  // oxlint-disable-next-line unicorn/prefer-set-has -- Array is more appropriate here for small collections
  const orderingFields = ordering.map(([field]) => field);
  const missingFields = pk.filter(pkField => !orderingFields.includes(pkField));

  if (missingFields.length > 0) {
    throw new Error(
      `Ordering must include all primary key fields. Missing: ${missingFields.join(
        ', ',
      )}. ZQL automatically appends primary key fields to the ordering if they are missing 
      so a common cause of this error is a casing mismatch between Postgres and ZQL.
      E.g., "userid" vs "userID".
      You may want to add double-quotes around your Postgres column names to prevent Postgres from lower-casing them:
      https://www.postgresql.org/docs/current/sql-syntax-lexical.htm`,
    );
  }
}

function uniquifyCorrelatedSubqueryConditionAliases(ast: AST): AST {
  if (!ast.where) {
    return ast;
  }
  const {where} = ast;
  if (where.type !== 'and' && where.type !== 'or') {
    return ast;
  }

  let count = 0;
  const uniquifyCorrelatedSubquery = (csqc: CorrelatedSubqueryCondition) => ({
    ...csqc,
    related: {
      ...csqc.related,
      subquery: {
        ...csqc.related.subquery,
        alias: (csqc.related.subquery.alias ?? '') + '_' + count++,
      },
    },
  });

  const uniquify = (cond: Condition): Condition => {
    if (cond.type === 'simple') {
      return cond;
    } else if (cond.type === 'correlatedSubquery') {
      return uniquifyCorrelatedSubquery(cond);
    }
    const conditions = [];
    for (const c of cond.conditions) {
      conditions.push(uniquify(c));
    }
    return {
      type: cond.type,
      conditions,
    };
  };

  const result = {
    ...ast,
    where: uniquify(where),
  };
  return result;
}

export function conditionIncludesFlippedSubqueryAtAnyLevel(
  cond: Condition,
): boolean {
  if (cond.type === 'correlatedSubquery') {
    return !!cond.flip;
  }
  if (cond.type === 'and' || cond.type === 'or') {
    return cond.conditions.some(c =>
      conditionIncludesFlippedSubqueryAtAnyLevel(c),
    );
  }
  // simple conditions don't have flips
  return false;
}

export function partitionBranches(
  conditions: readonly Condition[],
  predicate: (c: Condition) => boolean,
) {
  const matched: Condition[] = [];
  const notMatched: Condition[] = [];
  for (const c of conditions) {
    if (predicate(c)) {
      matched.push(c);
    } else {
      notMatched.push(c);
    }
  }
  return [matched, notMatched] as const;
}

type Matcher<T> = {
  readonly when: (predicate: (value: T) => boolean) => Matcher<T>;
  readonly value: () => T | undefined;
};

// A tiny Effect Match inspired helper for linear eligibility checks. It keeps
// optimizer code shaped like "start with this candidate, then require these
// properties" without hiding the individual predicates behind a large helper.
function match<T>(value: T | undefined): Matcher<T> {
  return {
    when(predicate) {
      return match(value !== undefined && predicate(value) ? value : undefined);
    },
    value() {
      return value;
    },
  };
}
