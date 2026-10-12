// units.mjs: how a message is split into what gets read aloud. Pure, no DOM, no SillyTavern.
//
// Shared by the Breeze Player extension (browser) and the st-audio skill (node), so the paragraph
// and segment numbers in a message's `extra.breeze_audio` timing table mean the same thing on both
// sides by construction. Ported from ST-breeze-tts-director 2.0.0 (splitLines/buildUnits/splitSegments).
//
// - A paragraph is one line of the message after: tag blocks removed (<tag>...</tag>, SillyTavern's own
//   pattern), every line trimmed of whitespace and zero-width characters (CRLF chats would otherwise
//   leave one-character "\r" paragraphs), blank-looking lines dropped, and lines matching an exclusion
//   pattern dropped (default: horizontal rules, which Breeze reads aloud as dashes).
// - A segment is a span of a paragraph: quoted speech ("...", “...”, «...», 「...」, 『...』, ＂...＂)
//   is `dialogue`, everything around it `narration`. Delimiters are stripped, pieces trimmed, empties
//   dropped. There is no *action* alternative: these chats are plaintext, an asterisk is an asterisk.
//
// Changing anything here changes what paragraph N means. Bump UNITS_VERSION when it does: attached audio
// records the version it was cut with, and the player treats a mismatch as outdated.

export const UNITS_VERSION = 1;

const BLANK = /[\s​-‍﻿]/;
const BLANK_EDGES = new RegExp(`^${BLANK.source}+|${BLANK.source}+$`, 'g');
export const TAG_BLOCK = /<.*?>[\s\S]*?<\/.*?>/g;
export const DEFAULT_EXCLUSIONS = ['^[-*_=~]{3,}$'];
export const SEGMENT_PATTERN = /(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim;

export const DEFAULT_OPTIONS = Object.freeze({ skipTags: true, exclusions: DEFAULT_EXCLUSIONS });

function compile(exclusions) {
    const out = [];
    for (const p of exclusions || []) {
        const s = String(p).trim();
        if (!s) continue;
        try { out.push(new RegExp(s)); } catch { /* one bad pattern must not silence the message */ }
    }
    return out;
}

/** The message as it should be read aloud, with unspoken tag blocks removed. */
export function readableText(mes, options = DEFAULT_OPTIONS) {
    const text = String(mes ?? '');
    return options.skipTags === false ? text : text.replace(TAG_BLOCK, '');
}

/** Paragraph texts, in order. */
export function splitLines(mes, options = DEFAULT_OPTIONS) {
    const patterns = compile(options.exclusions ?? DEFAULT_EXCLUSIONS);
    return readableText(mes, options)
        .split('\n')
        .map(line => line.replace(BLANK_EDGES, ''))
        .filter(line => line && !patterns.some(p => p.test(line)));
}

/** Quoted speech and the narration around it. */
export function splitSegments(line) {
    const segments = [];
    const regex = new RegExp(SEGMENT_PATTERN.source, 'gim');
    let last = 0;
    let m;
    while ((m = regex.exec(line)) !== null) {
        if (m.index > last) {
            const before = line.slice(last, m.index).trim();
            if (before) segments.push({ kind: 'narration', text: before });
        }
        const content = m[0].slice(1, -1).trim();
        if (content) segments.push({ kind: 'dialogue', text: content });
        last = m.index + m[0].length;
    }
    if (last < line.length) {
        const rest = line.slice(last).trim();
        if (rest) segments.push({ kind: 'narration', text: rest });
    }
    if (segments.length) return segments;
    const whole = line.trim();
    return whole ? [{ kind: 'narration', text: whole }] : [];
}

/** Paragraphs with their segments: [{ i, text, segments: [{ i, kind, text }] }]. */
export function buildUnits(mes, options = DEFAULT_OPTIONS) {
    return splitLines(mes, options).map((text, i) => ({
        i,
        text,
        segments: splitSegments(text).map((s, j) => ({ i: j, ...s })),
    }));
}

/** SHA-256 hex of a string (Web Crypto: browsers and node >= 19 both have it). */
export async function sha256(text) {
    const data = new TextEncoder().encode(String(text ?? ''));
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/** The text of the swipe a message currently shows. */
export function shownText(message) {
    return String(message?.mes ?? '');
}
