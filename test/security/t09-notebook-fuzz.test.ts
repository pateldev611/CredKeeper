import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, parseNotebook, clearOutputs } from '../../src/core';

// T09: malformed or hostile notebooks never crash the scanner.
const CASES = [
  '', '{', 'null', '[]', '{"cells": null}', '{"cells": "x"}', '{"cells": [null, 1, "a", []]}',
  '{"cells": [{"cell_type": "code", "source": 42, "outputs": "nope"}]}',
  '{"cells": [{"cell_type": "code", "source": [], "outputs": [null, {"output_type": "stream", "text": {"a": 1}}]}]}',
  '{"cells": [{"cell_type": "code", "source": [], "outputs": [{"output_type": "error", "traceback": [1, null, {}]}]}]}',
  '{"cells": [{"cell_type": "code", "source": [], "outputs": [{"output_type": "display_data", "data": {"image/png": "' + 'A'.repeat(500_000) + '"}}]}]}',
  JSON.stringify({ cells: Array.from({ length: 6000 }, () => ({ cell_type: 'code', source: 'x', outputs: [] })) }),
  '{"cells": [{"cell_type": "code", "source": ["' + 'a'.repeat(300_000) + '"], "outputs": []}]}',
];

for (const [i, raw] of CASES.entries()) {
  test(`malformed notebook #${i + 1} does not throw`, () => {
    assert.doesNotThrow(() => parseNotebook(raw));
    assert.doesNotThrow(() => new Engine().scanContent('bad.ipynb', raw));
    assert.doesNotThrow(() => clearOutputs(raw, new Set([0])));
  });
}

test('image outputs are skipped, not scanned as text', () => {
  const nb = parseNotebook('{"cells": [{"cell_type": "code", "source": [], "outputs": [{"output_type": "display_data", "data": {"image/png": "QUJD", "text/plain": "<Figure>"}}]}]}');
  assert.equal(nb.model!.cells[0].outputs[0].text, '<Figure>');
});
