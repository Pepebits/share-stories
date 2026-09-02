import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replacer } from '../src/utils/logger.js';

describe('logger replacer', () => {
  it('renders a bigint as a string so JSON.stringify does not throw', () => {
    assert.equal(JSON.stringify({ id: 10n }, replacer), '{"id":"10"}');
  });

  it('leaves other values untouched', () => {
    assert.equal(JSON.stringify({ n: 5, s: 'x' }, replacer), '{"n":5,"s":"x"}');
  });
});
