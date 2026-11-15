// Run: node --test services/api/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheck, CITY_CHECK_PROMPT } from '../../../api/_lib/citycheck.ts';

test('clean JSON', () => {
  assert.deepEqual(parseCheck('{"verdict":"not_pothole","reason":"Barrel in the bike lane."}'),
    { verdict: 'not_pothole', reason: 'Barrel in the bike lane.' });
});
test('JSON in a code fence, any case', () => {
  assert.equal(parseCheck('```json\n{"verdict": "Pothole", "reason": "hole"}\n```')?.verdict, 'pothole');
});
test('bare word fallback prefers not_pothole', () => {
  assert.equal(parseCheck('verdict: not_pothole')?.verdict, 'not_pothole');
  assert.equal(parseCheck('looks like a pothole')?.verdict, 'pothole');
});
test('junk → null (report stays unchecked, still shown)', () => {
  assert.equal(parseCheck(''), null);
  assert.equal(parseCheck('{"verdict":"maybe"}'), null);
});
test('prompt has every placeholder', () => {
  for (const k of ['{SUMMARY}', '{ADDRESS}', '{TEXT}', '{PHOTO}']) assert.ok(CITY_CHECK_PROMPT.includes(k));
});
