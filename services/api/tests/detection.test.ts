// Run: node --test services/api/tests/   (Node 22.6+ strips the TS types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDetectionsBody, validateDetection, MAX_BATCH } from '../../../api/_lib/detection.ts';

const sample = JSON.parse(readFileSync('shared/fixtures/detection.sample.json', 'utf8'));

test('the shared fixture is valid', () => {
  const d = validateDetection(sample);
  assert.equal(typeof d, 'object');
  assert.equal((d as any).captured_at, '2026-11-14T18:30:00.000Z');
});

test('single and batch bodies', () => {
  assert.equal((parseDetectionsBody(sample) as any[]).length, 1);
  const two = parseDetectionsBody({ detections: [sample, { ...sample, detection_id: 'b' }] });
  assert.equal((two as any[]).length, 2);
});

test('duplicate ids in one batch: last wins', () => {
  const r = parseDetectionsBody({ detections: [sample, { ...sample, verdict: 'pothole' }] }) as any[];
  assert.equal(r.length, 1);
  assert.equal(r[0].verdict, 'pothole');
});

test('bbox and verdict_reason are optional', () => {
  const { bbox, verdict_reason, ...rest } = sample;
  const d = validateDetection(rest) as any;
  assert.equal(d.bbox, null);
  assert.equal(d.verdict_reason, null);
});

const bad: [string, object, RegExp][] = [
  ['no id', { detection_id: '' }, /detection_id/],
  ['bad source', { source: 'phone' }, /source/],
  ['lat out of range', { lat: 91 }, /lat/],
  ['lon is a string', { lon: '-83' }, /lon/],
  ['bad date', { captured_at: 'yesterday' }, /captured_at/],
  ['confidence > 1', { confidence: 1.5 }, /confidence/],
  ['bbox of 3', { bbox: [1, 2, 3] }, /bbox/],
  ['no image_url', { image_url: '' }, /image_url/],
  ['bad verdict', { verdict: 'maybe' }, /verdict/],
];
for (const [name, patch, re] of bad) {
  test(`rejects: ${name}`, () => {
    const r = parseDetectionsBody({ ...sample, ...patch });
    assert.equal(typeof r, 'string');
    assert.match(r as string, re);
  });
}

test('batch errors name the index; empty and oversized batches rejected', () => {
  assert.match(parseDetectionsBody({ detections: [sample, { ...sample, lat: 'x' }] }) as string, /detections\[1\]/);
  assert.match(parseDetectionsBody({ detections: [] }) as string, /empty/);
  assert.match(parseDetectionsBody({ detections: Array(MAX_BATCH + 1).fill(sample) }) as string, /at most/);
  assert.match(parseDetectionsBody([sample]) as string, /object/);
});

test('camera (v4) is optional, phone|dashcam only', () => {
  assert.equal((validateDetection(sample) as any).camera, null);
  assert.equal((validateDetection({ ...sample, camera: 'dashcam' }) as any).camera, 'dashcam');
  assert.equal((validateDetection({ ...sample, camera: 'phone' }) as any).camera, 'phone');
  assert.equal(typeof validateDetection({ ...sample, camera: 'drone' }), 'string');
});
