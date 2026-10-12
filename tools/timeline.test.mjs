// node --test tools/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, paragraphStart, staleness, versions, qaLabel, clock, speakersOf, isEntry } from '../timeline.mjs';

const P = [
    { i: 0, start: 0.3, end: 2.0, segments: [{ i: 0, start: 0.3, end: 2.0, speaker: 'Narrator' }] },
    { i: 1, start: 2.7, end: 6.0, segments: [{ i: 0, start: 2.7, end: 3.5, speaker: 'Sera' }, { i: 1, start: 3.75, end: 6.0, speaker: 'Narrator' }] },
    { i: 2, start: 6.7, end: 9.0, segments: [{ i: 0, start: 6.7, end: 9.0, speaker: 'Narrator' }] },
];
const E = { v: 1, url: '/user/files/x.mp3', paragraphs: P, units_version: 1, swipe_id: 0, text_sha256: 'aa', duration: 9.6 };

test('locate: inside, in gaps, before and after', () => {
    assert.deepEqual(locate(P, 0), { p: 0, s: 0 });
    assert.deepEqual(locate(P, 1.0), { p: 0, s: 0 });
    assert.deepEqual(locate(P, 2.4), { p: 0, s: 0 });      // pause after paragraph 0
    assert.deepEqual(locate(P, 3.6), { p: 1, s: 0 });      // gap between segments keeps the first
    assert.deepEqual(locate(P, 3.8), { p: 1, s: 1 });
    assert.deepEqual(locate(P, 50), { p: 2, s: 0 });
    assert.deepEqual(locate([], 1), { p: -1, s: -1 });
});

test('paragraphStart clamps', () => {
    assert.equal(paragraphStart(P, 1), 2.7);
    assert.equal(paragraphStart(P, -3), 0.3);
    assert.equal(paragraphStart(P, 99), 6.7);
});

test('staleness names each reason', () => {
    assert.deepEqual(staleness(E, { textSha: 'aa', swipeId: 0, paragraphCount: 3 }), []);
    assert.deepEqual(staleness(E, { textSha: 'bb', swipeId: 1, paragraphCount: 2 }),
        ['text changed', 'another swipe is shown', 'paragraph count differs']);
    assert.deepEqual(staleness({ ...E, units_version: 0 }, { textSha: 'aa', swipeId: 0, paragraphCount: 3 }), ['cut with another splitter version']);
});

test('versions, labels, helpers', () => {
    const v = versions({ ...E, rendered: '2026-10-12T20:01:02+02:00', history: [{ ...E, url: 'old', rendered: '2026-10-11T10:00:00' }, { bad: 1 }] });
    assert.equal(v.length, 2);
    assert.match(v[0].label, /^current: 2026-10-12 20:01/);
    assert.equal(isEntry({ v: 1, url: 'x' }), false);
    assert.equal(qaLabel({ lines: 10, passed: 9, rerolled: 2, flagged: ['a'] }), 'QA 9/10, 2 re-rolled, 1 flagged');
    assert.equal(clock(125.9), '2:05');
    assert.deepEqual(speakersOf(P[1]), ['Sera', 'Narrator']);
});
