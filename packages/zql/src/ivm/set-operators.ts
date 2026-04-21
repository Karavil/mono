import {areEqual} from '../../../shared/src/arrays.ts';
import {assert} from '../../../shared/src/asserts.ts';
import type {Writable} from '../../../shared/src/writable.ts';
import type {CompoundKey} from '../../../zero-protocol/src/ast.ts';
import type {Row, Value} from '../../../zero-protocol/src/data.ts';
import {ChangeIndex} from './change-index.ts';
import {ChangeType} from './change-type.ts';
import {
  makeAddChange,
  makeEditChange,
  makeRemoveChange,
  type Change,
} from './change.ts';
import type {Node} from './data.ts';
import {
  throwOutput,
  type FetchRequest,
  type Input,
  type InputBase,
  type Output,
} from './operator.ts';
import type {SourceSchema} from './schema.ts';
import {type Stream} from './stream.ts';
import {mergeFetches} from './union-fan-in.ts';

/**
 * Physical OR over multiple independently optimized root pipelines.
 *
 * Conceptually:
 *
 *   branch 0: parent WHERE teacher_id = 1
 *   branch 1: child WHERE student_id = 'student-1' -> parent
 *
 *                    InputUnion
 *                  /            \
 *          parent rows        parent rows
 *
 * Fetch is a sorted merge by the output schema comparator. Duplicate primary
 * keys are represented by the first branch in input order. Push has to preserve
 * that same "earliest branch owns the row" rule, including handoffs:
 *
 *   before push:
 *     branch 0: empty
 *     branch 1: {id: 1, value: 20}
 *     output:   {id: 1, value: 20}
 *
 *   after branch 0 adds {id: 1, value: 10}:
 *     branch 0: {id: 1, value: 10}
 *     branch 1: {id: 1, value: 20}
 *     output:   {id: 1, value: 10}
 *
 * The visible result did not gain a new primary key. Its representative row
 * changed, so downstream receives EDIT(value 20 -> 10).
 *
 * This operator deliberately does not try to merge relationship payloads from
 * duplicate rows. The builder only uses it for root queries without related
 * rows, start, or limit.
 */
export class InputUnion implements Input {
  readonly #inputs: readonly Input[];
  readonly #inputIndexes: ReadonlyMap<InputBase, number>;
  readonly #schema: SourceSchema;
  #output: Output = throwOutput;

  constructor(inputs: readonly Input[]) {
    assert(inputs.length > 0, 'InputUnion requires at least one input');
    this.#inputs = inputs;
    this.#inputIndexes = new Map(inputs.map((input, index) => [input, index]));
    this.#schema = mergeInputSchemas('input union', inputs);
    for (const input of inputs) {
      input.setOutput(this);
    }
  }

  setOutput(output: Output): void {
    this.#output = output;
  }

  getSchema(): SourceSchema {
    return this.#schema;
  }

  fetch(req: FetchRequest): Stream<Node | 'yield'> {
    const compareRows = req.reverse
      ? (left: Node, right: Node) =>
          this.#schema.compareRows(right.row, left.row)
      : (left: Node, right: Node) =>
          this.#schema.compareRows(left.row, right.row);
    return mergeFetches(
      this.#inputs.map(input => input.fetch(req)),
      compareRows,
    );
  }

  *push(change: Change, pusher: InputBase): Stream<'yield'> {
    const pusherIndex = this.#inputIndexes.get(pusher);
    assert(pusherIndex !== undefined, 'Pusher was not an input union input');

    switch (change[ChangeIndex.TYPE]) {
      case ChangeType.ADD:
        yield* this.#pushAdd(change[ChangeIndex.NODE], pusher, pusherIndex);
        return;

      case ChangeType.REMOVE:
        yield* this.#pushRemove(change[ChangeIndex.NODE], pusher, pusherIndex);
        return;

      case ChangeType.EDIT: {
        const oldNode = change[ChangeIndex.OLD_NODE];
        const newNode = change[ChangeIndex.NODE];
        if (
          rowKey(oldNode.row, this.#schema.primaryKey) !==
          rowKey(newNode.row, this.#schema.primaryKey)
        ) {
          yield* this.#pushRemove(oldNode, pusher, pusherIndex);
          yield* this.#pushAdd(newNode, pusher, pusherIndex);
          return;
        }

        if (yield* this.#earlierInputHasMatch(pusherIndex, newNode)) {
          return;
        }
        yield* this.#output.push(change, this);
        return;
      }

      case ChangeType.CHILD:
        if (
          yield* this.#earlierInputHasMatch(
            pusherIndex,
            change[ChangeIndex.NODE],
          )
        ) {
          return;
        }
        yield* this.#output.push(change, this);
        return;
    }
  }

  destroy(): void {
    for (const input of this.#inputs) {
      input.destroy();
    }
  }

  *#pushAdd(
    node: Node,
    pusher: InputBase,
    pusherIndex: number,
  ): Generator<'yield'> {
    // ADD has three cases:
    //
    //   no other branch has pk       => new visible row, emit ADD
    //   later branch has pk          => representative handoff, emit EDIT
    //   earlier branch has pk        => still represented earlier, emit nothing
    const match = yield* this.#firstMatchingInputExcept(pusher, node);
    if (!match) {
      yield* this.#output.push(makeAddChange(node), this);
      return;
    }
    if (pusherIndex < match.index && !rowsEqual(node.row, match.node.row)) {
      yield* this.#output.push(makeEditChange(node, match.node), this);
    }
  }

  *#pushRemove(
    node: Node,
    pusher: InputBase,
    pusherIndex: number,
  ): Generator<'yield'> {
    // REMOVE mirrors ADD:
    //
    //   no other branch has pk       => row disappeared, emit REMOVE
    //   later branch has pk          => representative handoff, emit EDIT
    //   earlier branch has pk        => still represented earlier, emit nothing
    const match = yield* this.#firstMatchingInputExcept(pusher, node);
    if (!match) {
      yield* this.#output.push(makeRemoveChange(node), this);
      return;
    }
    if (pusherIndex < match.index && !rowsEqual(node.row, match.node.row)) {
      yield* this.#output.push(makeEditChange(match.node, node), this);
    }
  }

  *#firstMatchingInputExcept(
    pusher: InputBase,
    node: Node,
  ): Generator<
    'yield',
    {readonly index: number; readonly node: Node} | undefined
  > {
    // Search in input order because fetch uses input order as the tie-break for
    // duplicate primary keys. Push must discover the same representative row.
    const constraint = keyConstraint(node.row, this.#schema.primaryKey);
    for (const [index, input] of this.#inputs.entries()) {
      if (input === pusher) {
        continue;
      }
      const matchingNode = yield* firstMatchingNode(input, constraint);
      if (matchingNode) {
        return {index, node: matchingNode};
      }
    }
    return undefined;
  }

  *#earlierInputHasMatch(
    pusherIndex: number,
    node: Node,
  ): Generator<'yield', boolean> {
    const constraint = keyConstraint(node.row, this.#schema.primaryKey);
    for (const input of this.#inputs.slice(0, pusherIndex)) {
      if (yield* inputHasMatch(input, constraint)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Physical AND over same-relationship EXISTS branches.
 *
 * Conceptually:
 *
 *   child WHERE student_id = 'student-1'  -> keys {101, 102}
 *   child WHERE student_id = 'student-2'  -> keys {102, 1500}
 *
 *             InputIntersection on assignment_id
 *                         |
 *                    key {102}
 *
 * The output row is a representative child row from the first input for each
 * intersected key. The following FlippedJoin uses that key to fetch the parent.
 *
 * The builder only creates this operator when every child branch is unique for
 * the correlation key. That keeps "one representative per key" equivalent to
 * EXISTS semantics. If a future caller wants arbitrary many rows per key, this
 * operator would need row-bag semantics instead of key-set semantics.
 */
export class InputIntersection implements Input {
  readonly #inputs: readonly Input[];
  readonly #key: CompoundKey;
  readonly #schema: SourceSchema;
  #output: Output = throwOutput;

  constructor(inputs: readonly Input[], key: CompoundKey) {
    assert(inputs.length > 0, 'InputIntersection requires at least one input');
    this.#inputs = inputs;
    this.#key = key;
    this.#schema = firstInputSchema('input intersection', inputs);
    for (const input of inputs) {
      input.setOutput(this);
    }
  }

  setOutput(output: Output): void {
    this.#output = output;
  }

  getSchema(): SourceSchema {
    return this.#schema;
  }

  *fetch(req: FetchRequest): Stream<Node | 'yield'> {
    // Fetch rest branch key sets first, then stream first-branch
    // representatives in first-branch order. yieldedKeys is the key-set part of
    // the contract: even if the first branch has duplicate rows for a key, the
    // intersection emits one representative key for the parent lookup.
    const [first, ...rest] = this.#inputs;
    const firstNodes: Node[] = [];
    for (const node of first.fetch(req)) {
      if (node === 'yield') {
        yield node;
        continue;
      }
      firstNodes.push(node);
    }

    const matchingKeys: ReadonlySet<string>[] = [];
    for (const input of rest) {
      const keys = new Set<string>();
      for (const node of input.fetch(req)) {
        if (node === 'yield') {
          yield node;
          continue;
        }
        keys.add(rowKey(node.row, this.#key));
      }
      matchingKeys.push(keys);
    }

    const yieldedKeys = new Set<string>();
    for (const node of firstNodes) {
      const key = rowKey(node.row, this.#key);
      if (!yieldedKeys.has(key) && matchingKeys.every(keys => keys.has(key))) {
        yieldedKeys.add(key);
        yield node;
      }
    }
  }

  *push(change: Change, pusher: InputBase): Stream<'yield'> {
    assert(isInput(pusher), 'Expected pusher to be an input');
    assert(this.#inputs.includes(pusher), 'Pusher was not an input');

    switch (change[ChangeIndex.TYPE]) {
      case ChangeType.ADD:
        yield* this.#pushAdd(change[ChangeIndex.NODE], pusher);
        return;

      case ChangeType.REMOVE:
        yield* this.#pushRemove(change[ChangeIndex.NODE], pusher);
        return;

      case ChangeType.EDIT: {
        const oldNode = change[ChangeIndex.OLD_NODE];
        const newNode = change[ChangeIndex.NODE];
        if (rowKey(oldNode.row, this.#key) !== rowKey(newNode.row, this.#key)) {
          yield* this.#pushRemove(oldNode, pusher);
          yield* this.#pushAdd(newNode, pusher);
          return;
        }

        if (
          pusher === this.#inputs[0] &&
          (yield* this.#allOtherInputsHaveMatch(pusher, newNode))
        ) {
          yield* this.#output.push(change, this);
        }
        return;
      }

      case ChangeType.CHILD:
        if (
          pusher === this.#inputs[0] &&
          (yield* this.#allOtherInputsHaveMatch(
            pusher,
            change[ChangeIndex.NODE],
          ))
        ) {
          yield* this.#output.push(change, this);
        }
        return;
    }
  }

  destroy(): void {
    for (const input of this.#inputs) {
      input.destroy();
    }
  }

  *#pushAdd(node: Node, pusher: Input): Generator<'yield'> {
    // A key enters the intersection only when every other branch has that key.
    // Non-first branches emit the first input's representative, because fetch
    // always represents an intersected key with a first-input row.
    if (!(yield* this.#allOtherInputsHaveMatch(pusher, node))) {
      return;
    }
    if (pusher === this.#inputs[0]) {
      yield* this.#output.push(makeAddChange(node), this);
      return;
    }
    const representative = yield* firstMatchingNode(
      this.#inputs[0],
      keyConstraint(node.row, this.#key),
    );
    if (representative) {
      yield* this.#output.push(makeAddChange(representative), this);
    }
  }

  *#pushRemove(node: Node, pusher: Input): Generator<'yield'> {
    // A key leaves the intersection when this branch no longer has it and all
    // other branches still do. For the first branch, removing the current
    // representative is visible even if another first-branch row with the same
    // key remains, because fetch would have emitted the removed representative
    // before the change.
    const constraint = keyConstraint(node.row, this.#key);
    if (
      pusher !== this.#inputs[0] &&
      (yield* inputHasMatch(pusher, constraint))
    ) {
      return;
    }
    if (!(yield* this.#allOtherInputsHaveMatch(pusher, node))) {
      return;
    }
    if (pusher === this.#inputs[0]) {
      yield* this.#output.push(makeRemoveChange(node), this);
      return;
    }
    const representative = yield* firstMatchingNode(
      this.#inputs[0],
      constraint,
    );
    if (representative) {
      yield* this.#output.push(makeRemoveChange(representative), this);
    }
  }

  *#allOtherInputsHaveMatch(
    pusher: InputBase,
    node: Node,
  ): Generator<'yield', boolean> {
    // This tests key presence, not row equality. EXISTS only cares whether each
    // branch can produce at least one child row for the parent correlation key.
    const constraint = keyConstraint(node.row, this.#key);
    for (const input of this.#inputs) {
      if (input === pusher) {
        continue;
      }
      if (!(yield* inputHasMatch(input, constraint))) {
        return false;
      }
    }
    return true;
  }
}

function mergeInputSchemas(
  operatorName: string,
  inputs: readonly Input[],
): SourceSchema {
  // The set operators sit between complete pipelines. They can only compose
  // pipelines that expose the same row stream shape. Relationships are merged
  // by name for the schema contract, but duplicate row relationship payloads
  // are not merged by InputUnion. The builder avoids that case for root union.
  const schema = {
    ...firstInputSchema(operatorName, inputs),
    relationships: {
      ...inputs[0].getSchema().relationships,
    },
  } satisfies Writable<SourceSchema>;

  const relationshipsFromBranches = new Set<string>();
  for (const input of inputs.slice(1)) {
    const inputSchema = input.getSchema();
    assertCompatibleSchema(operatorName, schema, inputSchema);
    for (const [relationshipName, relationshipSchema] of Object.entries(
      inputSchema.relationships,
    )) {
      if (relationshipName in schema.relationships) {
        continue;
      }
      assert(
        !relationshipsFromBranches.has(relationshipName),
        `Relationship ${relationshipName} exists in multiple upstream inputs to ${operatorName}`,
      );
      schema.relationships[relationshipName] = relationshipSchema;
      relationshipsFromBranches.add(relationshipName);
    }
  }

  return schema;
}

function firstInputSchema(
  operatorName: string,
  inputs: readonly Input[],
): SourceSchema {
  const schema = inputs[0].getSchema();
  for (const input of inputs.slice(1)) {
    assertCompatibleSchema(operatorName, schema, input.getSchema());
  }
  return schema;
}

function assertCompatibleSchema(
  operatorName: string,
  expected: SourceSchema,
  actual: SourceSchema,
): void {
  assert(
    expected.tableName === actual.tableName,
    `Table name mismatch in ${operatorName}: ${expected.tableName} !== ${actual.tableName}`,
  );
  assert(
    areEqual(expected.primaryKey, actual.primaryKey),
    `Primary key mismatch in ${operatorName}`,
  );
  assert(
    expected.system === actual.system,
    `System mismatch in ${operatorName}: ${expected.system} !== ${actual.system}`,
  );
  assert(
    JSON.stringify(expected.sort) === JSON.stringify(actual.sort),
    `Sort mismatch in ${operatorName}`,
  );
}

function keyConstraint(
  row: Row,
  key: readonly string[],
): Record<string, Value> {
  return Object.fromEntries(key.map(column => [column, row[column]]));
}

function rowKey(row: Row, key: readonly string[]): string {
  return JSON.stringify(key.map(column => row[column]));
}

function rowsEqual(left: Row, right: Row): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInput(input: InputBase): input is Input {
  return 'fetch' in input;
}

function* inputHasMatch(
  input: Input,
  constraint: Record<string, Value>,
): Generator<'yield', boolean> {
  for (const node of input.fetch({constraint})) {
    if (node === 'yield') {
      yield node;
      continue;
    }
    return true;
  }
  return false;
}

function* firstMatchingNode(
  input: Input,
  constraint: Record<string, Value>,
): Generator<'yield', Node | undefined> {
  for (const node of input.fetch({constraint})) {
    if (node === 'yield') {
      yield node;
      continue;
    }
    return node;
  }
  return undefined;
}
