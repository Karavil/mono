import {describe, expect, test} from 'vitest';
import type {Row} from '../../../zero-protocol/src/data.ts';
import {ChangeIndex} from './change-index.ts';
import {ChangeType} from './change-type.ts';
import {
  makeAddChange,
  makeChildChange,
  makeEditChange,
  makeRemoveChange,
  type Change,
} from './change.ts';
import type {Node} from './data.ts';
import {
  skipYields,
  type FetchRequest,
  type Input,
  type Output,
} from './operator.ts';
import type {SourceSchema} from './schema.ts';
import {InputIntersection, InputUnion} from './set-operators.ts';
import {consume, type Stream} from './stream.ts';

const schema: SourceSchema = {
  tableName: 'assignment',
  columns: {
    id: {type: 'number'},
    value: {type: 'number'},
  },
  primaryKey: ['id'],
  relationships: {},
  compareRows: (left, right) => (left.id as number) - (right.id as number),
  isHidden: false,
  sort: [['id', 'asc']],
  system: 'client',
};

describe('InputUnion', () => {
  test('fetch merges sorted inputs and deduplicates by primary key', () => {
    const left = new MutableInput([
      node({id: 1, value: 10}),
      node({id: 3, value: 30}),
    ]);
    const right = new MutableInput([
      node({id: 2, value: 20}),
      node({id: 3, value: 30}),
    ]);

    const union = new InputUnion([left, right]);

    expect(Array.from(skipYields(union.fetch({})), n => n.row.id)).toEqual([
      1, 2, 3,
    ]);
  });

  test('push emits one add, remove, or edit when multiple branches match', () => {
    const left = new MutableInput([]);
    const right = new MutableInput([]);
    const union = new InputUnion([left, right]);
    const sink = new RecordingOutput();
    union.setOutput(sink);

    left.rows = [node({id: 1, value: 10})];
    left.push(makeAddChange(node({id: 1, value: 10})));
    right.rows = [node({id: 1, value: 10})];
    right.push(makeAddChange(node({id: 1, value: 10})));

    left.rows = [node({id: 1, value: 11})];
    left.push(
      makeEditChange(node({id: 1, value: 11}), node({id: 1, value: 10})),
    );
    right.rows = [node({id: 1, value: 11})];
    right.push(
      makeEditChange(node({id: 1, value: 11}), node({id: 1, value: 10})),
    );

    left.rows = [];
    left.push(makeRemoveChange(node({id: 1, value: 11})));
    right.rows = [];
    right.push(makeRemoveChange(node({id: 1, value: 11})));

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.ADD,
      ChangeType.EDIT,
      ChangeType.REMOVE,
    ]);
  });

  test('push emits primary key edits as remove and add', () => {
    const left = new MutableInput([node({id: 1, value: 10})]);
    const right = new MutableInput([]);
    const union = new InputUnion([left, right]);
    const sink = new RecordingOutput();
    union.setOutput(sink);

    left.rows = [node({id: 2, value: 10})];
    left.push(
      makeEditChange(node({id: 2, value: 10}), node({id: 1, value: 10})),
    );

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.REMOVE,
      ChangeType.ADD,
    ]);
    expect(sink.changes.map(change => change[ChangeIndex.NODE].row.id)).toEqual(
      [1, 2],
    );
  });

  test('push emits an edit when representative ownership moves earlier', () => {
    const left = new MutableInput([]);
    const right = new MutableInput([node({id: 1, value: 20})]);
    const union = new InputUnion([left, right]);
    const sink = new RecordingOutput();
    union.setOutput(sink);

    left.rows = [node({id: 1, value: 10})];
    left.push(makeAddChange(node({id: 1, value: 10})));

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.EDIT,
    ]);
    const [change] = sink.changes;
    expect(change).toBeDefined();
    if (!change) {
      throw new Error('Expected change');
    }
    expect(change[ChangeIndex.TYPE]).toBe(ChangeType.EDIT);
    if (change[ChangeIndex.TYPE] !== ChangeType.EDIT) {
      throw new Error('Expected edit');
    }
    expect(change[ChangeIndex.NODE].row).toEqual({
      id: 1,
      value: 10,
    });
    expect(change[ChangeIndex.OLD_NODE].row).toEqual({
      id: 1,
      value: 20,
    });
  });

  test('push emits an edit when representative ownership moves later', () => {
    const left = new MutableInput([node({id: 1, value: 10})]);
    const right = new MutableInput([node({id: 1, value: 20})]);
    const union = new InputUnion([left, right]);
    const sink = new RecordingOutput();
    union.setOutput(sink);

    left.rows = [];
    left.push(makeRemoveChange(node({id: 1, value: 10})));

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.EDIT,
    ]);
    const [change] = sink.changes;
    expect(change).toBeDefined();
    if (!change) {
      throw new Error('Expected change');
    }
    expect(change[ChangeIndex.TYPE]).toBe(ChangeType.EDIT);
    if (change[ChangeIndex.TYPE] !== ChangeType.EDIT) {
      throw new Error('Expected edit');
    }
    expect(change[ChangeIndex.NODE].row).toEqual({
      id: 1,
      value: 20,
    });
    expect(change[ChangeIndex.OLD_NODE].row).toEqual({
      id: 1,
      value: 10,
    });
  });

  test('push forwards child changes from the earliest matching branch only', () => {
    const left = new MutableInput([node({id: 1, value: 10})]);
    const right = new MutableInput([node({id: 1, value: 10})]);
    const union = new InputUnion([left, right]);
    const sink = new RecordingOutput();
    union.setOutput(sink);

    left.push(childChange(node({id: 1, value: 10})));
    right.push(childChange(node({id: 1, value: 10})));

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.CHILD,
    ]);
  });
});

describe('InputIntersection', () => {
  test('fetch keeps rows whose key appears in every input', () => {
    const left = new MutableInput([
      node({id: 1, value: 10}),
      node({id: 2, value: 20}),
    ]);
    const right = new MutableInput([
      node({id: 2, value: 200}),
      node({id: 3, value: 300}),
    ]);

    const intersection = new InputIntersection([left, right], ['id']);

    expect(Array.from(skipYields(intersection.fetch({})), n => n.row)).toEqual([
      {id: 2, value: 20},
    ]);
  });

  test('fetch deduplicates rows by intersection key', () => {
    const left = new MutableInput([
      node({id: 1, value: 10}),
      node({id: 1, value: 11}),
      node({id: 2, value: 20}),
    ]);
    const right = new MutableInput([node({id: 1, value: 100})]);

    const intersection = new InputIntersection([left, right], ['id']);

    expect(Array.from(skipYields(intersection.fetch({})), n => n.row)).toEqual([
      {id: 1, value: 10},
    ]);
  });

  test('push emits when a key enters or leaves the intersection', () => {
    const left = new MutableInput([node({id: 1, value: 10})]);
    const right = new MutableInput([]);
    const intersection = new InputIntersection([left, right], ['id']);
    const sink = new RecordingOutput();
    intersection.setOutput(sink);

    right.rows = [node({id: 1, value: 100})];
    right.push(makeAddChange(node({id: 1, value: 100})));

    right.rows = [];
    right.push(makeRemoveChange(node({id: 1, value: 100})));

    expect(sink.changes).toHaveLength(2);
    expect(sink.changes[0][ChangeIndex.TYPE]).toBe(ChangeType.ADD);
    expect(sink.changes[0][ChangeIndex.NODE].row).toEqual({
      id: 1,
      value: 10,
    });
    expect(sink.changes[1][ChangeIndex.TYPE]).toBe(ChangeType.REMOVE);
    expect(sink.changes[1][ChangeIndex.NODE].row).toEqual({
      id: 1,
      value: 10,
    });
  });

  test('push emits remove and add when a non-primary branch moves keys', () => {
    const left = new MutableInput([
      node({id: 1, value: 10}),
      node({id: 2, value: 20}),
    ]);
    const right = new MutableInput([node({id: 1, value: 100})]);
    const intersection = new InputIntersection([left, right], ['id']);
    const sink = new RecordingOutput();
    intersection.setOutput(sink);

    right.rows = [node({id: 2, value: 100})];
    right.push(
      makeEditChange(node({id: 2, value: 100}), node({id: 1, value: 100})),
    );

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.REMOVE,
      ChangeType.ADD,
    ]);
    expect(sink.changes.map(change => change[ChangeIndex.NODE].row)).toEqual([
      {id: 1, value: 10},
      {id: 2, value: 20},
    ]);
  });

  test('push forwards child changes from the representative branch only', () => {
    const left = new MutableInput([node({id: 1, value: 10})]);
    const right = new MutableInput([node({id: 1, value: 100})]);
    const intersection = new InputIntersection([left, right], ['id']);
    const sink = new RecordingOutput();
    intersection.setOutput(sink);

    right.push(childChange(node({id: 1, value: 100})));
    left.push(childChange(node({id: 1, value: 10})));

    expect(sink.changes.map(change => change[ChangeIndex.TYPE])).toEqual([
      ChangeType.CHILD,
    ]);
    expect(sink.changes[0][ChangeIndex.NODE].row).toEqual({
      id: 1,
      value: 10,
    });
  });
});

class MutableInput implements Input {
  rows: Node[];
  #output: Output | undefined;

  constructor(rows: Node[]) {
    this.rows = rows;
  }

  setOutput(output: Output): void {
    this.#output = output;
  }

  getSchema(): SourceSchema {
    return schema;
  }

  *fetch(req: FetchRequest): Stream<Node | 'yield'> {
    for (const row of this.rows) {
      if (matchesConstraint(row.row, req.constraint)) {
        yield row;
      }
    }
  }

  push(change: Change): void {
    consume(this.#output?.push(change, this) ?? []);
  }

  destroy(): void {}
}

class RecordingOutput implements Output {
  readonly changes: Change[] = [];

  *push(change: Change): Stream<'yield'> {
    this.changes.push(change);
  }
}

function node(row: Row): Node {
  return {row, relationships: {}};
}

function childChange(parent: Node): Change {
  return makeChildChange(parent, {
    relationshipName: 'children',
    change: makeAddChange(node({id: 99, value: 99})),
  });
}

function matchesConstraint(
  row: Row,
  constraint: FetchRequest['constraint'],
): boolean {
  if (!constraint) {
    return true;
  }
  return Object.entries(constraint).every(([key, value]) => row[key] === value);
}
