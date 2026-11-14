// Run: node --test services/api/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, VERIFY_PROMPT } from '../../../api/_lib/verify.ts';

test('clean JSON', () => {
  assert.deepEqual(parseVerdict('{"verdict":"pothole","reason":"Deep hole with broken edges."}'),
    { verdict: 'pothole', reason: 'Deep hole with broken edges.' });
});
test('JSON inside a code fence / prose', () => {
  const r = parseVerdict('Sure!\n```json\n{"verdict": "Patch", "reason": "Fresh asphalt square."}\n```');
  assert.equal(r?.verdict, 'patch');
});
test('not_pothole / none map to shadow (the contract has no other "false" verdict)', () => {
  assert.equal(parseVerdict('{"verdict":"not_pothole","reason":"manhole"}')?.verdict, 'shadow');
  assert.equal(parseVerdict('{"verdict":"none"}')?.verdict, 'shadow');
});
test('plain word fallback, default reason', () => {
  assert.deepEqual(parseVerdict('shadow'), { verdict: 'shadow', reason: 'Vision check: shadow.' });
});
test('garbage → null (detection stays unverified)', () => {
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict('I cannot see the image.'), null);
});
test('prompt asks for JSON with the three verdicts', () => {
  for (const w of ['"pothole"', '"patch"', '"shadow"', 'JSON']) assert.ok(VERIFY_PROMPT.includes(w));
});
