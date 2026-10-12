// node --test tools/units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnits, splitLines, splitSegments, sha256, UNITS_VERSION } from '../units.mjs';

test('CRLF and blank-looking lines are not paragraphs', () => {
    const mes = 'One.\r\n\r\nTwo.\r\n ​ \r\nThree.';
    assert.deepEqual(splitLines(mes), ['One.', 'Two.', 'Three.']);
});

test('tag blocks are removed even across lines; single tags stay', () => {
    const mes = 'Before.\n<details>hidden\nstill hidden</details>\nShe sighed. <laughs> Fine.';
    assert.deepEqual(splitLines(mes), ['Before.', 'She sighed. <laughs> Fine.']);
});

test('horizontal rules are excluded by default; custom exclusions apply', () => {
    assert.deepEqual(splitLines('A\n---\nB\n***\n___'), ['A', 'B']);
    assert.deepEqual(splitLines('A\nOOC: x\nB', { exclusions: ['^OOC:'] }), ['A', 'B']);
    assert.deepEqual(splitLines('A\n---', { exclusions: ['(['] }), ['A', '---']); // bad pattern ignored
});

test('segments: straight and curly quotes, narration around them', () => {
    assert.deepEqual(splitSegments('"Hi," she said. “Bye.”'), [
        { kind: 'dialogue', text: 'Hi,' },
        { kind: 'narration', text: 'she said.' },
        { kind: 'dialogue', text: 'Bye.' },
    ]);
    assert.deepEqual(splitSegments('No quotes at all.'), [{ kind: 'narration', text: 'No quotes at all.' }]);
});

test('asterisks are content, not markup', () => {
    assert.deepEqual(splitSegments('2 * 3 * 4 is *twenty-four*.'), [{ kind: 'narration', text: '2 * 3 * 4 is *twenty-four*.' }]);
});

test('empty quotes are dropped', () => {
    assert.deepEqual(splitSegments('He said "" and left.'), [
        { kind: 'narration', text: 'He said' }, { kind: 'narration', text: 'and left.' }]);
});

test('buildUnits numbers paragraphs and segments from 0', () => {
    const u = buildUnits('A "b" c.\n\nD.');
    assert.equal(u.length, 2);
    assert.equal(u[0].i, 0);
    assert.deepEqual(u[0].segments.map(s => s.i), [0, 1, 2]);
    assert.equal(u[1].segments[0].text, 'D.');
});

test('sha256 is hex and stable', async () => {
    assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(UNITS_VERSION, 1);
});
