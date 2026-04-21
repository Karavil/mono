import {expect, test} from 'vitest';
import type {
  AST,
  Condition,
  CorrelatedSubqueryCondition,
  LiteralValue,
} from '../../../zero-protocol/src/ast.ts';
import {normalizePlannerAST} from './condition-normalizer.ts';

const TRUE: Condition = {type: 'and', conditions: []};
const FALSE: Condition = {type: 'or', conditions: []};

test('drops identity branches without losing real filters', () => {
  const active = eq('active', true);

  expect(normalizeWhere({type: 'or', conditions: [active, FALSE]})).toEqual(
    active,
  );
  expect(normalizeWhere({type: 'and', conditions: [active, TRUE]})).toEqual(
    active,
  );
  expect(normalizeWhere({type: 'and', conditions: [active, FALSE]})).toEqual(
    FALSE,
  );
});

test('rewrites same-column OR equalities to IN', () => {
  expect(
    normalizeWhere({
      type: 'or',
      conditions: [eq('status', 'active'), eq('status', 'pending')],
    }),
  ).toEqual({
    type: 'simple',
    left: {type: 'column', name: 'status'},
    op: 'IN',
    right: {type: 'literal', value: ['active', 'pending']},
  });

  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        eq('status', 'active'),
        inCondition('status', 'IN', ['active']),
      ],
    }),
  ).toEqual(eq('status', 'active'));
});

test('normalizes degenerate IN predicates', () => {
  const notInEmpty = inCondition('status', 'NOT IN', []);

  expect(normalizeWhere(inCondition('status', 'IN', []))).toEqual(FALSE);
  expect(normalizeWhere(inCondition('status', 'IN', ['active']))).toEqual(
    eq('status', 'active'),
  );
  expect(normalizeWhere(notInEmpty)).toEqual(notInEmpty);
  expect(normalizeWhere(inCondition('status', 'NOT IN', ['active']))).toEqual({
    type: 'simple',
    left: {type: 'column', name: 'status'},
    op: '!=',
    right: {type: 'literal', value: 'active'},
  });
});

test('merges OR exists branches over the same relationship', () => {
  expect(
    normalizeWhere({
      type: 'or',
      conditions: [exists(eq('title', 'hello')), exists(eq('title', 'world'))],
    }),
  ).toEqual(
    exists({
      type: 'simple',
      left: {type: 'column', name: 'title'},
      op: 'IN',
      right: {type: 'literal', value: ['hello', 'world']},
    }),
  );
});

test('factors common parent filters before merging child exists branches', () => {
  const active = eq('active', true);

  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        {
          type: 'and',
          conditions: [active, exists(eq('title', 'hello'))],
        },
        {
          type: 'and',
          conditions: [active, exists(eq('title', 'world'))],
        },
      ],
    }),
  ).toEqual({
    type: 'and',
    conditions: [
      active,
      exists({
        type: 'simple',
        left: {type: 'column', name: 'title'},
        op: 'IN',
        right: {type: 'literal', value: ['hello', 'world']},
      }),
    ],
  });
});

test('absorbs redundant branches after factoring common predicates', () => {
  const active = eq('active', true);

  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        active,
        {
          type: 'and',
          conditions: [active, eq('status', 'pending')],
        },
      ],
    }),
  ).toEqual(active);
});

test('does not merge exists branches with different semantics', () => {
  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        exists(eq('title', 'hello'), {op: 'NOT EXISTS'}),
        exists(eq('title', 'world'), {op: 'NOT EXISTS'}),
      ],
    }),
  ).toMatchObject({
    type: 'or',
    conditions: [{op: 'NOT EXISTS'}, {op: 'NOT EXISTS'}],
  });

  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        exists(eq('title', 'hello'), {scalar: true}),
        exists(eq('title', 'world'), {scalar: true}),
      ],
    }),
  ).toMatchObject({type: 'or', conditions: [{scalar: true}, {scalar: true}]});

  expect(
    normalizeWhere({
      type: 'or',
      conditions: [
        exists(eq('title', 'hello'), {subquery: {limit: 1}}),
        exists(eq('title', 'world'), {subquery: {limit: 1}}),
      ],
    }),
  ).toMatchObject({
    type: 'or',
    conditions: [
      {related: {subquery: {limit: 1}}},
      {related: {subquery: {limit: 1}}},
    ],
  });
});

test('normalizes related subqueries recursively', () => {
  expect(
    normalizePlannerAST({
      table: 'users',
      related: [
        {
          correlation: {
            parentField: ['id'],
            childField: ['userId'],
          },
          subquery: {
            table: 'posts',
            where: {
              type: 'or',
              conditions: [eq('title', 'hello'), eq('title', 'world')],
            },
          },
        },
      ],
    }).related?.[0].subquery.where,
  ).toEqual({
    type: 'simple',
    left: {type: 'column', name: 'title'},
    op: 'IN',
    right: {type: 'literal', value: ['hello', 'world']},
  });
});

function normalizeWhere(where: Condition): Condition | undefined {
  return normalizePlannerAST({table: 'users', where}).where;
}

function eq(name: string, value: LiteralValue): Condition {
  return {
    type: 'simple',
    left: {type: 'column', name},
    op: '=',
    right: {type: 'literal', value},
  };
}

function inCondition(
  name: string,
  op: 'IN' | 'NOT IN',
  values: readonly (string | number | boolean)[],
): Condition {
  return {
    type: 'simple',
    left: {type: 'column', name},
    op,
    right: {type: 'literal', value: values},
  };
}

function exists(
  where: Condition | undefined,
  options: {
    readonly op?: 'EXISTS' | 'NOT EXISTS' | undefined;
    readonly scalar?: boolean | undefined;
    readonly subquery?: Partial<AST> | undefined;
  } = {},
): CorrelatedSubqueryCondition {
  return {
    type: 'correlatedSubquery',
    op: options.op ?? 'EXISTS',
    scalar: options.scalar,
    related: {
      correlation: {
        parentField: ['id'],
        childField: ['userId'],
      },
      subquery: {
        table: 'posts',
        where,
        ...options.subquery,
      },
    },
  };
}
