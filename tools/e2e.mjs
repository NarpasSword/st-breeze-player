// End-to-end check of Breeze Player in a real SillyTavern page (the st-audio testbed, or any ST you point it at).
//   docker run --rm --network host -v "$PWD:/x" -w /x st-drive:latest node tools/e2e.mjs [ST_URL] [avatar] [chat] [outdir]
// Needs a chat whose messages carry extra.breeze_audio (st-audio attach). It never saves the chat or touches files,
// but ST itself may save settings: run it against the st-audio testbed, not a production ST.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const { chromium } = createRequire('/opt/st-drive/')('playwright');
const [ST = 'http://127.0.0.1:8011', AVATAR = 'Testa.png', CHAT = 'Testa - storywriter - test - 2026-10-12', OUT = '/tmp/e2e'] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const intercepted = []; // writes the page tried (answered locally, never sent)
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && /breeze|sbp|player|director/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
// Never let the page write anything during the test.
await page.route('**/api/**', (route) => {
    const r = route.request();
    const p = new URL(r.url()).pathname;
    // The chat and the audio files are what is under test: never let the page change them. (Run this against the
    // testbed only; settings and the character's last-chat pointer are allowed to change there.)
    if (r.method() === 'POST' && /^\/api\/(chats\/(save|delete|rename)|files\/)/.test(p) && p !== '/api/files/verify') {
        let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
        intercepted.push({ path: p, file: body?.path ?? null });
        return route.fulfill({ status: 200, body: '{"ok":true}' });
    }
    return route.continue();
});
await page.goto(ST, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.SillyTavern?.getContext && document.querySelector('#send_textarea'), null, { timeout: 120000 });
// A fresh ST (the testbed) asks for a persona name first; accept the default.
await page.waitForTimeout(3000);
const onboarding = page.locator('.popup:has-text("Persona Name") .popup-button-ok, .popup:has-text("Persona Name") .menu_button:has-text("Save")').first();
if (await onboarding.isVisible().catch(() => false)) { await onboarding.click(); await page.waitForTimeout(2000); }
await page.waitForFunction(() => SillyTavern.getContext().characters?.length > 0, null, { timeout: 60000 });
check('extension loaded', await page.waitForFunction(() => !!globalThis.breezePlayer, null, { timeout: 30000 }).then(() => true, () => false));

await page.evaluate(async ({ AVATAR, CHAT }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const c = SillyTavern.getContext();
    const idx = c.characters.findIndex((x) => x.avatar === AVATAR);
    await c.selectCharacterById(String(idx));
    for (let k = 0; k < 20 && SillyTavern.getContext().characterId !== String(idx); k++) await sleep(250);
    await sleep(2500);   // let ST finish opening the character's last chat before switching
    for (let k = 0; k < 4 && SillyTavern.getContext().getCurrentChatId() !== CHAT; k++) {
        await SillyTavern.getContext().openCharacterChat(CHAT);
        for (let j = 0; j < 20 && SillyTavern.getContext().getCurrentChatId() !== CHAT; j++) await sleep(250);
    }
}, { AVATAR, CHAT });
const opened = await page.waitForFunction((CHAT) => SillyTavern.getContext().getCurrentChatId() === CHAT && document.querySelectorAll('#chat .mes').length > 1, CHAT, { timeout: 30000 }).then(() => true, () => false);
if (!opened) {
    const s = await page.evaluate(() => { const c = SillyTavern.getContext(); return { char: c.characterId, name: c.name2, chat: c.getCurrentChatId(), n: c.chat.length, dom: document.querySelectorAll('#chat .mes').length }; });
    await page.screenshot({ path: `${OUT}/not-opened.png` });
    console.log('could not open the chat', JSON.stringify(s), errors.join(' | '));
    process.exit(1);
}
await page.waitForTimeout(1500);

const marked = await page.evaluate(() => [...document.querySelectorAll('#chat .mes')].map((m) => [Number(m.getAttribute('mesid')), m.classList.contains('sbp_has_audio')]));
const withAudio = marked.filter(([, a]) => a).map(([i]) => i);
check('messages with audio are marked', withAudio.length >= 1, `marked ${JSON.stringify(withAudio)}`);
const visible = await page.evaluate((id) => getComputedStyle(document.querySelector(`#chat .mes[mesid="${id}"] .sbp_play`)).display, withAudio[0]);
check('play button shown on a message with audio', visible !== 'none', visible);
const noAudio = marked.find(([, a]) => !a);
if (noAudio) {
    const hidden = await page.evaluate((id) => { const b = document.querySelector(`#chat .mes[mesid="${id}"] .sbp_play`); return b ? getComputedStyle(b).display : 'none'; }, noAudio[0]);
    check('play button hidden without audio', hidden === 'none', hidden);
}

const last = withAudio.at(-1);
const first = withAudio[0];
// Open the panel through the message button (as the user would; the button is in the hover menu).
await page.evaluate((id) => document.querySelector(`#chat .mes[mesid="${id}"] .sbp_play`).click(), last);
await page.waitForSelector(`#chat .mes[mesid="${last}"] .sbp_panel`, { timeout: 10000 });
const rows = await page.$$eval(`#chat .mes[mesid="${last}"] .sbp_row`, (r) => r.length);
const want = await page.evaluate((id) => SillyTavern.getContext().chat[id].extra.breeze_audio.paragraphs.length, last);
check('panel has one row per paragraph', rows === want && rows > 0, `${rows} rows, ${want} paragraphs`);
const rowText = await page.$eval(`#chat .mes[mesid="${last}"] .sbp_row .sbp_text`, (e) => e.textContent.length);
check('rows show paragraph text', rowText > 0);
const stale = await page.$$eval(`#chat .mes[mesid="${last}"] .sbp_warn`, (r) => r.length);
check('fresh audio is not marked outdated', stale === 0);

// Play, then check time advances and a row is highlighted.
await page.click(`#chat .mes[mesid="${last}"] .sbp_bar .fa-play`);
await page.waitForTimeout(2500);
const st1 = await page.evaluate(() => ({ t: breezePlayer.player.audio.currentTime, paused: breezePlayer.player.audio.paused, err: breezePlayer.player.audio.error?.code ?? null }));
check('audio plays', st1.t > 0.8 && !st1.paused, JSON.stringify(st1));
const on = await page.$$eval(`#chat .mes[mesid="${last}"] .sbp_row.sbp_on`, (r) => r.map((x) => x.dataset.p));
check('current paragraph highlighted', on.length === 1, JSON.stringify(on));
const status = await page.$eval(`#chat .mes[mesid="${last}"] .sbp_status`, (e) => e.textContent);
check('status shows time and speaker', /\d:\d\d \/ \d:\d\d · \S/.test(status), status);
await page.screenshot({ path: `${OUT}/playing.png` });

// Seek by clicking a later row.
const target = Math.min(rows - 1, 3);
await page.click(`#chat .mes[mesid="${last}"] .sbp_row[data-p="${target}"]`);
await page.waitForTimeout(600);
const seek = await page.evaluate(({ id, p }) => ({ t: breezePlayer.player.audio.currentTime, start: SillyTavern.getContext().chat[id].extra.breeze_audio.paragraphs[p].start }), { id: last, p: target });
check('row click seeks to its paragraph', Math.abs(seek.t - seek.start) < 0.9, JSON.stringify(seek));
const on2 = await page.$$eval(`#chat .mes[mesid="${last}"] .sbp_row.sbp_on`, (r) => r.map((x) => x.dataset.p));
check('highlight follows the seek', on2[0] === String(target), JSON.stringify(on2));

// Pause / resume.
await page.click(`#chat .mes[mesid="${last}"] .sbp_bar .fa-pause`);
await page.waitForTimeout(400);
check('pause', await page.evaluate(() => breezePlayer.player.audio.paused));

// Continue: play the first message from near its end; the next message with audio should start by itself.
if (withAudio.length > 1) {
    await page.evaluate(async (id) => {
        await breezePlayer.playMessage(id);
        const a = breezePlayer.player.audio;
        await new Promise((r) => (a.readyState >= 1 ? r() : a.addEventListener('loadedmetadata', r, { once: true })));
        a.currentTime = Math.max(0, a.duration - 0.6);
    }, first);
    await page.waitForFunction((id) => breezePlayer.player.id === id && !breezePlayer.player.audio.paused, withAudio[1], { timeout: 10000 }).catch(() => {});
    const cont = await page.evaluate(() => ({ id: breezePlayer.player.id, t: breezePlayer.player.audio.currentTime }));
    check('continues to the next message with audio', cont.id === withAudio[1], JSON.stringify(cont));
}

// Slash commands.
const info = await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/breeze-info')).pipe);
check('/breeze-info', /messages with audio/.test(info), info);
await page.evaluate(async () => SillyTavern.getContext().executeSlashCommandsWithOptions('/breeze-stop'));
check('/breeze-stop', await page.evaluate(() => breezePlayer.player.id === null));

// Outdated: change the text in the page only (never saved), reopen.
await page.evaluate((id) => { SillyTavern.getContext().chat[id].mes += ' An extra sentence.'; }, last);
await page.evaluate((id) => breezePlayer.openPanel(id), last);
await page.waitForTimeout(300);
const warn = await page.$$eval(`#chat .mes[mesid="${last}"] .sbp_warn`, (r) => r.map((x) => x.textContent));
check('edited message shows outdated', warn.length === 1 && /text changed/.test(warn[0]), JSON.stringify(warn));
await page.screenshot({ path: `${OUT}/outdated.png` });

// ---- living alongside ST-breeze-tts-director (only when it is installed in the same ST) ----
const legacy = await page.evaluate(() => !!globalThis.breezeTts);
if (legacy) {
    const g = await page.evaluate(() => ({ tts: typeof globalThis.breezeTts?.getClip, director: typeof globalThis.breezeDirector,
        explain: typeof globalThis.breezeExplain, player: typeof globalThis.breezePlayer?.playMessage }));
    check('legacy: both extensions loaded, globals intact', g.tts === 'function' && g.director === 'function' && g.explain === 'function' && g.player === 'function', JSON.stringify(g));
    const cmds = await page.evaluate(() => { const c = SillyTavern.getContext().SlashCommandParser.commands;
        return ['breeze-direct', 'breeze-cast', 'breeze-audio', 'breeze-blank', 'breeze-play', 'breeze-stop', 'breeze-info'].filter((n) => !c[n]); });
    check('legacy: all seven slash commands registered', cmds.length === 0, `missing ${JSON.stringify(cmds)}`);
    const icons = await page.evaluate((id) => [...document.querySelectorAll(`#chat .mes[mesid="${id}"] .extraMesButtons .mes_button`)]
        .map((b) => b.className).filter((c) => /breeze|sbp/.test(c)), last);
    check('legacy: both message buttons present, different icons', icons.some((c) => /sbp_play/.test(c) && /fa-file-audio/.test(c)) &&
        icons.some((c) => /mes_breeze_play/.test(c)) && !icons.some((c) => /sbp_play/.test(c) && /fa-headphones/.test(c)), JSON.stringify(icons));
    // Exclusive playback: another speech element starting pauses Breeze Player, and the reverse; looping music is left alone.
    const ex = await page.evaluate(async (id) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const url = SillyTavern.getContext().chat[id].extra.breeze_audio.url;
        await breezePlayer.playMessage(id); await sleep(800);
        const other = new Audio(url); await other.play(); await sleep(500);
        const pausedByOther = breezePlayer.player.audio.paused;
        await breezePlayer.player.play(); await sleep(500);
        const otherPausedByUs = other.paused;
        const music = new Audio(url); music.loop = true; await music.play(); await sleep(500);
        const musicLeftAlone = !breezePlayer.player.audio.paused && !music.paused;
        music.pause(); other.pause(); breezePlayer.player.stop();
        return { pausedByOther, otherPausedByUs, musicLeftAlone };
    }, last);
    check('legacy: one voice at a time (and music left alone)', ex.pausedByOther && ex.otherPausedByUs && ex.musicLeftAlone, JSON.stringify(ex));
    // The old extension's take commands touch only breeze_direction; the attached audio must survive them.
    const kept = await page.evaluate(async (id) => {
        const before = JSON.stringify(SillyTavern.getContext().chat[id].extra.breeze_audio);
        const r = await SillyTavern.getContext().executeSlashCommandsWithOptions(`/breeze-blank ${id}`);
        const m = SillyTavern.getContext().chat[id];
        return { same: JSON.stringify(m.extra.breeze_audio) === before, blanked: r.pipe, direction: !!m.extra.breeze_direction };
    }, last);
    check('legacy: /breeze-blank leaves breeze_audio untouched', kept.same && kept.direction, JSON.stringify(kept));
    await page.screenshot({ path: `${OUT}/legacy.png` });
}

// ---- deleting audio (requests are intercepted: the testbed's files and chat stay as they are) ----
// 1. Through the panel button and the confirmation popup, on a message with a single version.
await page.evaluate(() => breezePlayer.player.stop());
await page.evaluate(() => document.querySelectorAll('.sbp_panel').forEach((e) => e.remove()));
await page.evaluate(() => breezePlayer.panels.clear());
const delUrl = await page.evaluate((id) => SillyTavern.getContext().chat[id].extra.breeze_audio.url, first);
await page.evaluate((id) => breezePlayer.openPanel(id), first);
await page.waitForSelector(`#chat .mes[mesid="${first}"] .sbp_delete`);
intercepted.length = 0;
await page.click(`#chat .mes[mesid="${first}"] .sbp_delete`);
const ok = page.locator('.popup .popup-button-ok').last();
await ok.waitFor({ state: 'visible', timeout: 5000 }).then(() => ok.click(), () => {});
await page.waitForFunction((id) => !SillyTavern.getContext().chat[id].extra?.breeze_audio && !document.querySelector(`#chat .mes[mesid="${id}"] .sbp_panel`), first, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
const d1 = await page.evaluate((id) => ({ gone: !SillyTavern.getContext().chat[id].extra?.breeze_audio,
    marked: document.querySelector(`#chat .mes[mesid="${id}"]`).classList.contains('sbp_has_audio'),
    panel: !!document.querySelector(`#chat .mes[mesid="${id}"] .sbp_panel`) }), first);
check('delete button: confirms, removes the entry, closes the panel', d1.gone && !d1.marked && !d1.panel, JSON.stringify(d1));
check('delete button: deletes exactly that file and saves the chat',
    intercepted.some((x) => x.path === '/api/files/delete' && x.file === delUrl) && intercepted.some((x) => x.path === '/api/chats/save') &&
    intercepted.filter((x) => x.path === '/api/files/delete').length === 1, JSON.stringify(intercepted));
// 2. Deleting the current version promotes the older one, and only the current file is deleted.
const d2 = await page.evaluate(async (id) => {
    const m = SillyTavern.getContext().chat[id];
    const cur = m.extra.breeze_audio;
    const older = { ...cur, url: cur.url.replace(/_([0-9a-f]{8})\.mp3$/, '_00000000.mp3'), rendered: '2026-10-01T10:00:00', history: undefined };
    m.extra.breeze_audio = { ...cur, history: [older] };
    const before = m.extra.breeze_audio.url;
    const n = await breezePlayer.deleteAudio(id, 0, { confirmed: true });
    return { n, before, now: m.extra.breeze_audio?.url, history: (m.extra.breeze_audio?.history || []).length, older: older.url };
}, last);
const files2 = intercepted.filter((x) => x.path === '/api/files/delete').map((x) => x.file);
check('delete current version: older one takes its place', d2.now === d2.older && d2.history === 0 && d2.n === 1, JSON.stringify(d2));
check('delete current version: only its own file is deleted', files2.includes(d2.before) && !files2.includes(d2.older), JSON.stringify(files2));
// 3. A file another entry still uses is kept.
const d3 = await page.evaluate(async (id) => {
    const m = SillyTavern.getContext().chat[id];
    const cur = m.extra.breeze_audio;
    m.extra.breeze_audio = { ...cur, history: [{ ...cur, history: undefined, rendered: 'twin' }] };   // same url twice
    return breezePlayer.deleteAudio(id, 1, { confirmed: true });
}, last);
check('a file still in use is not deleted', d3 === 0, `deleted ${d3}`);
const cmd = await page.evaluate(() => !!SillyTavern.getContext().SlashCommandParser.commands['breeze-delete']);
check('/breeze-delete registered', cmd);

check('no extension errors in the console', errors.length === 0, errors.join(' | '));
fs.writeFileSync(`${OUT}/e2e.json`, JSON.stringify(results, null, 1));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`e2e | ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
