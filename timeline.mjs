// timeline.mjs: pure helpers for playing a message's attached audio. No DOM, no SillyTavern.
//
// A message's `extra.breeze_audio` (written by the st-audio skill) looks like:
//   { v: 1, job, units_version, options, swipe_id, text_sha256, url, sha256, duration,
//     paragraphs: [{ i, start, end, segments: [{ i, start, end, speaker }] }],
//     qa: { lines, passed, rerolled, flagged: [ids], tone_flags }, rendered, history: [older entries] }
// Times are seconds from the start of the file.

import { UNITS_VERSION } from './units.mjs';

/** Is this a usable audio entry? */
export function isEntry(a) {
    return !!(a && typeof a === 'object' && a.v === 1 && typeof a.url === 'string' && Array.isArray(a.paragraphs));
}

/** Where in the message time t falls: { p, s } (indices into paragraphs / their segments). Gaps count as the
 *  line before them, so a pause keeps the paragraph it follows highlighted. Before the first line: p 0. */
export function locate(paragraphs, t) {
    if (!paragraphs?.length) return { p: -1, s: -1 };
    let lo = 0, hi = paragraphs.length - 1, p = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (paragraphs[mid].start <= t) { p = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const segs = paragraphs[p].segments || [];
    let s = 0;
    for (let k = 0; k < segs.length; k++) if (segs[k].start <= t) s = k;
    return { p, s };
}

/** Start time of paragraph p (clamped). */
export function paragraphStart(paragraphs, p) {
    if (!paragraphs?.length) return 0;
    return paragraphs[Math.max(0, Math.min(p, paragraphs.length - 1))].start;
}

/** Why an entry no longer fits the message it is attached to ([] = current). */
export function staleness(entry, { textSha, swipeId, paragraphCount }) {
    const why = [];
    if (entry.text_sha256 && textSha && entry.text_sha256 !== textSha) why.push('text changed');
    if ((entry.swipe_id ?? 0) !== (swipeId ?? 0)) why.push('another swipe is shown');
    if (entry.units_version !== UNITS_VERSION) why.push('cut with another splitter version');
    if (paragraphCount != null && paragraphCount !== entry.paragraphs.length) why.push('paragraph count differs');
    return why;
}

/** The current entry plus its history, newest first, as [{ label, entry }]. */
export function versions(a) {
    if (!isEntry(a)) return [];
    const all = [a, ...(Array.isArray(a.history) ? a.history.filter(isEntry) : [])];
    return all.map((e, k) => ({ label: `${k === 0 ? 'current' : `older ${k}`}: ${e.rendered ? String(e.rendered).slice(0, 16).replace('T', ' ') : e.job ?? '?'}`, entry: e }));
}

/** "QA 212/214, 3 re-rolled" style summary. */
export function qaLabel(qa) {
    if (!qa || typeof qa.lines !== 'number') return '';
    const bits = [`QA ${qa.passed}/${qa.lines}`];
    if (qa.rerolled) bits.push(`${qa.rerolled} re-rolled`);
    if (qa.flagged?.length) bits.push(`${qa.flagged.length} flagged`);
    return bits.join(', ');
}

/** m:ss */
export function clock(t) {
    const s = Math.max(0, Math.floor(t || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Speakers of a paragraph, in order, without repeats. */
export function speakersOf(paragraph) {
    const out = [];
    for (const s of paragraph?.segments || []) if (s.speaker && !out.includes(s.speaker)) out.push(s.speaker);
    return out;
}
