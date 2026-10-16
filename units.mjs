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

/** SHA-256 hex of a string. Web Crypto where it exists; browsers only expose crypto.subtle in a secure context
 *  (https or localhost), so plain http on a LAN address (a phone on http://<ip>:<port>) uses the JS fallback. */
export async function sha256(text) {
    const data = new TextEncoder().encode(String(text ?? ''));
    const subtle = globalThis.crypto?.subtle;
    const bytes = subtle ? new Uint8Array(await subtle.digest('SHA-256', data)) : sha256Bytes(data);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Plain-JS SHA-256 of bytes (FIPS 180-4), for pages without Web Crypto. */
export function sha256Bytes(data) {
    const len = data.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    view.setUint32(padded.length - 4, (len << 3) >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    h.forEach((v, i) => ov.setUint32(i * 4, v));
    return out;
}

/** The text of the swipe a message currently shows. */
export function shownText(message) {
    return String(message?.mes ?? '');
}
