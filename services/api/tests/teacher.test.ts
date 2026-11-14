// Run: node --test services/api/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBox2d, parseTeacher } from '../../../api/_lib/teacher.ts';

test('box_2d [ymin,xmin,ymax,xmax] 0-1000 → normalised top-left box', () => {
  assert.deepEqual(fromBox2d([500, 100, 700, 400]), { x: 0.1, y: 0.5, w: 0.3, h: 0.2 });
});
test('swapped corners, out-of-range values are fixed; tiny or bad boxes dropped', () => {
  assert.deepEqual(fromBox2d([700, 400, 500, 100]), { x: 0.1, y: 0.5, w: 0.3, h: 0.2 });
  assert.deepEqual(fromBox2d([-50, 900, 100, 1200]), { x: 0.9, y: 0, w: 0.1, h: 0.1 });
  assert.equal(fromBox2d([500, 500, 502, 502]), null);
  assert.equal(fromBox2d([1, 2, 3]), null);
  assert.equal(fromBox2d('nope'), null);
});
test('reply in a code fence with prose; lookalike kinds normalised', () => {
  const t = parseTeacher('Here you go:\n```json\n{"potholes":[{"box_2d":[600,200,700,300],"confidence":0.8,"note":"deep"}],' +
    '"lookalikes":[{"box_2d":[500,500,560,600],"kind":"Manhole"},{"box_2d":[100,100,200,200],"kind":"tree"}],"road_visible":true}\n```');
  assert.equal(t?.potholes.length, 1);
  assert.equal(t?.potholes[0].conf, 0.8);
  assert.deepEqual(t?.lookalikes.map((l) => l.kind), ['manhole', 'other']);
  assert.equal(t?.road_visible, true);
});
test('empty / missing lists and road_visible false', () => {
  assert.deepEqual(parseTeacher('{"potholes":[],"road_visible":false}'), { potholes: [], lookalikes: [], road_visible: false });
  assert.equal(parseTeacher('no json here'), null);
  assert.equal(parseTeacher('{broken'), null);
});

test('reply cut off by max_tokens: complete potholes list is kept, lookalikes dropped', () => {
  const cut = '{"potholes": [{"box_2d": [600, 200, 700, 300], "confidence": 0.7, "note": "hole"}], "lookalikes": [{"box_2d": [700, 0, 795, 75], "kind": "other"}, {"box_2d": [698, 35';
  const t = parseTeacher(cut);
  assert.equal(t?.potholes.length, 1);
  assert.deepEqual(t?.lookalikes, []);
  assert.deepEqual(parseTeacher('{"potholes": [], "lookalikes": [{"box_2d": [1,')?.potholes, []);
  assert.equal(parseTeacher('{"potholes": [{"box_2d": [6'), null); // potholes list itself cut → unusable
});
