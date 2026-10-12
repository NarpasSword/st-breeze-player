// Breeze Player: plays pre-rendered, QA'd Breeze audio attached to SillyTavern messages.
//
// The st-audio skill (Claude Code) directs, renders and checks the audio outside SillyTavern, uploads one mp3 per
// message to the user's files (/user/files/breeze_<chat>_m<id>_<hash>.mp3) and stores a timing table on the
// message as `extra.breeze_audio`. This extension only plays it: no TTS provider, no model calls, no writes to
// the chat. Paragraph rows come from the same splitter the skill used (units.mjs), so row N is the audio's
// paragraph N; when the message no longer matches (edited, swiped, other splitter version) it says so.
//
// Replaces ST-breeze-tts-director's player. Its own settings key is `breeze_player_v3`; resume positions are
// kept in localStorage (per browser), never in the chat.

import { buildUnits, sha256, DEFAULT_OPTIONS } from './units.mjs';
import { isEntry, locate, paragraphStart, staleness, versions, qaLabel, clock, speakersOf } from './timeline.mjs';

const MODULE = 'breeze_player_v3';
const NAME = 'Breeze Player';
const DEFAULTS = { rate: 1, continue: true, autoscroll: true, expand: false };
const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// fa-file-audio, not a headphones icon: ST-breeze-tts-director puts fa-headphones on the same menu.
const BUTTON_HTML = '<div title="Breeze Player: play this message\'s attached audio" class="mes_button sbp_play fa-solid fa-file-audio"></div>';
const RESUME_KEY = 'breeze_player_v3_resume';
const RESUME_LIMIT = 300;

const ctx = () => SillyTavern.getContext();

function settings() {
    const store = ctx().extensionSettings;
    store[MODULE] = store[MODULE] || {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (store[MODULE][k] === undefined) store[MODULE][k] = v;
    return store[MODULE];
}
const saveSettings = () => ctx().saveSettingsDebounced();

// ------------------------------------------------------------------ resume positions (localStorage, per browser)

function resumeMap() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}'); } catch { return {}; }
}
function resumeKey(messageId, url) { return `${ctx().getCurrentChatId?.() ?? ''}|${messageId}|${url}`; }
function saveResume(messageId, url, t) {
    try {
        const m = resumeMap();
        if (t > 2) m[resumeKey(messageId, url)] = { t: Math.round(t * 10) / 10, at: Date.now() };
        else delete m[resumeKey(messageId, url)];
        const keys = Object.keys(m);
        if (keys.length > RESUME_LIMIT) keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - RESUME_LIMIT).forEach(k => delete m[k]);
        localStorage.setItem(RESUME_KEY, JSON.stringify(m));
    } catch { /* storage blocked: resume is a convenience */ }
}
function loadResume(messageId, url) { return resumeMap()[resumeKey(messageId, url)]?.t ?? 0; }

// ------------------------------------------------------------------ message model

function message(id) { return ctx().chat?.[id]; }
function audioOf(id) { const a = message(id)?.extra?.breeze_audio; return isEntry(a) ? a : null; }
function audioMessages() {
    const chat = ctx().chat || [];
    const out = [];
    for (let i = 0; i < chat.length; i++) if (isEntry(chat[i]?.extra?.breeze_audio)) out.push(i);
    return out;
}

async function describe(id, entry) {
    const m = message(id);
    const text = String(m?.mes ?? '');
    const units = buildUnits(text, entry.options || DEFAULT_OPTIONS);
    const why = staleness(entry, { textSha: await sha256(text), swipeId: m?.swipe_id ?? 0, paragraphCount: units.length });
    return { units, why };
}

// ------------------------------------------------------------------ the one player

const player = {
    audio: new Audio(),
    id: null,          // message id playing (or loaded)
    entry: null,       // the breeze_audio entry loaded (current or a history version)
    lastSave: 0,
    load(id, entry) {
        if (this.id === id && this.entry?.url === entry.url) return;
        this.stop(false);
        this.id = id;
        this.entry = entry;
        this.audio.src = entry.url;
        this.audio.preload = 'auto';
        this.audio.playbackRate = settings().rate;
    },
    async play(at = null) {
        if (!this.entry) return;
        pauseOthers();
        if (at != null) this.audio.currentTime = at;
        this.audio.playbackRate = settings().rate;
        try { await this.audio.play(); } catch (e) {
            if (e?.name !== 'AbortError') toastr.error(`Could not play: ${e?.message ?? e}`, NAME);
        }
    },
    pause() { this.audio.pause(); },
    stop(clear = true) {
        if (this.entry && this.id != null) saveResume(this.id, this.entry.url, this.audio.currentTime);
        this.audio.pause();
        if (clear) { this.id = null; this.entry = null; this.audio.removeAttribute('src'); this.audio.load(); }
    },
    get playing() { return !!this.entry && !this.audio.paused && !this.audio.ended; },
};

// ------------------------------------------------------------------ one voice at a time
// ST-breeze-tts-director (its panel player and its TTS provider) and SillyTavern's own narration play through their
// own audio elements, some of them outside the DOM. Wrap HTMLMediaElement.play once so that whichever starts speaking,
// the other stops: another speech element starting pauses Breeze Player, and Breeze Player starting pauses the speech
// element that played last. Looping media (background music, ambience) is left alone both ways.
const others = new Set(); // speech elements seen playing, held weakly enough: dropped when they end or pause

function installExclusivePlayback() {
    const proto = HTMLMediaElement.prototype;
    if (proto.play.__sbpWrapped) return;
    const original = proto.play;
    const wrapped = function (...args) {
        if (this !== player.audio && !this.loop && this instanceof HTMLAudioElement) {
            others.add(this);
            const drop = () => others.delete(this);
            this.addEventListener('pause', drop, { once: true });
            this.addEventListener('ended', drop, { once: true });
            if (player.playing) { player.pause(); repaintAll(); }
        }
        return original.apply(this, args);
    };
    wrapped.__sbpWrapped = true;
    proto.play = wrapped;
}

function pauseOthers() {
    for (const el of others) { try { if (!el.paused) el.pause(); } catch { /* gone */ } }
    others.clear();
    // SillyTavern's narration queue only advances when a line ends, so a paused line holds the queue where it is.
    // Its menu button is deliberately not pressed: when it thinks nothing is playing it starts the last message.
}

// ------------------------------------------------------------------ panels

const panels = new Map(); // message id -> { root, repaint, rows }

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function iconButton(icon, title, onClick) {
    const b = el('div', `sbp_btn menu_button fa-solid ${icon}`);
    b.title = title;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(ev); });
    return b;
}

function closePanel(id) { panels.get(id)?.root.remove(); panels.delete(id); }
function closeAllPanels() { [...panels.keys()].forEach(closePanel); }

async function openPanel(id, { play = false, version = 0 } = {}) {
    const host = document.querySelector(`#chat .mes[mesid="${id}"] .mes_block`);
    const current = audioOf(id);
    if (!host || !current) return null;
    closePanel(id);
    const vers = versions(current);
    const entry = vers[Math.min(version, vers.length - 1)].entry;
    const { units, why } = await describe(id, entry);

    const root = el('div', 'sbp_panel');
    root.dataset.mesid = String(id);
    const bar = el('div', 'sbp_bar');
    const playBtn = iconButton('fa-play', 'Play / pause', () => toggle(id, entry));
    const prevBtn = iconButton('fa-backward-step', 'Previous paragraph', () => step(id, entry, -1));
    const nextBtn = iconButton('fa-forward-step', 'Next paragraph', () => step(id, entry, +1));
    const stopBtn = iconButton('fa-stop', 'Stop', () => { player.stop(); repaintAll(); });
    const rate = el('select', 'sbp_rate text_pole');
    rate.title = 'Speed';
    for (const r of RATES) { const o = el('option', null, `${r}×`); o.value = String(r); rate.append(o); }
    rate.value = String(settings().rate);
    rate.addEventListener('change', () => { settings().rate = Number(rate.value); player.audio.playbackRate = settings().rate; saveSettings(); });
    const cont = el('label', 'sbp_cont checkbox_label');
    const contBox = el('input'); contBox.type = 'checkbox'; contBox.checked = !!settings().continue;
    contBox.addEventListener('change', () => { settings().continue = contBox.checked; saveSettings(); });
    cont.append(contBox, el('span', null, 'Continue'));
    cont.title = 'Go on to the next message with audio when this one ends';
    const status = el('span', 'sbp_status');
    const close = iconButton('fa-xmark', 'Close', () => closePanel(id));
    bar.append(playBtn, prevBtn, nextBtn, stopBtn, rate, cont, status, close);

    const info = el('div', 'sbp_info');
    const qa = qaLabel(entry.qa);
    info.append(el('span', 'sbp_badge', `${clock(entry.duration)}${qa ? ` · ${qa}` : ''}`));
    if (why.length) info.append(el('span', 'sbp_badge sbp_warn', `Outdated: ${why.join(', ')}`));
    if (vers.length > 1) {
        const pick = el('select', 'sbp_version text_pole');
        vers.forEach((v, k) => { const o = el('option', null, v.label); o.value = String(k); pick.append(o); });
        pick.value = String(version);
        pick.title = 'Earlier renders of this message';
        pick.addEventListener('change', () => { player.stop(); openPanel(id, { version: Number(pick.value) }); });
        info.append(pick);
    }

    const list = el('div', 'sbp_rows');
    const rows = [];
    const aligned = units.length === entry.paragraphs.length;
    entry.paragraphs.forEach((p, k) => {
        const row = el('div', 'sbp_row');
        row.dataset.p = String(k);
        const head = el('div', 'sbp_row_head');
        head.append(el('span', 'sbp_num', `${k + 1}`), el('span', 'sbp_time', clock(p.start)));
        for (const who of speakersOf(p)) head.append(el('span', 'sbp_chip', who));
        const text = el('div', 'sbp_text', aligned ? units[k].text : `Paragraph ${k + 1}`);
        row.append(head, text);
        row.title = 'Play from here';
        row.addEventListener('click', () => { player.load(id, entry); player.play(p.start); repaintAll(); });
        rows.push(row);
        list.append(row);
    });
    if (!settings().expand) list.classList.add('sbp_compact');

    root.append(bar, info, list);
    host.append(root);

    const repaint = () => {
        const mine = player.entry === entry && player.id === id;
        const t = mine ? player.audio.currentTime : 0;
        playBtn.classList.toggle('fa-play', !(mine && player.playing));
        playBtn.classList.toggle('fa-pause', mine && player.playing);
        status.textContent = mine ? `${clock(t)} / ${clock(entry.duration)}` : (loadResume(id, entry.url) ? `resume at ${clock(loadResume(id, entry.url))}` : '');
        const at = mine ? locate(entry.paragraphs, t) : { p: -1, s: -1 };
        rows.forEach((r, k) => r.classList.toggle('sbp_on', k === at.p));
        if (mine && at.p >= 0) {
            const seg = entry.paragraphs[at.p].segments?.[at.s];
            if (seg?.speaker) status.textContent += ` · ${seg.speaker}`;
            if (settings().autoscroll && player.playing && rows[at.p] && root.dataset.lastP !== String(at.p)) {
                root.dataset.lastP = String(at.p);
                rows[at.p].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    };
    panels.set(id, { root, repaint, rows, entry });
    repaint();
    if (play) toggle(id, entry, true);
    return root;
}

function repaintAll() { for (const p of panels.values()) p.repaint(); }

function toggle(id, entry, forcePlay = false) {
    if (player.id === id && player.entry === entry) {
        if (player.playing && !forcePlay) player.pause(); else player.play();
    } else {
        player.load(id, entry);
        player.play(loadResume(id, entry.url) || 0);
    }
    repaintAll();
}

function step(id, entry, dir) {
    if (player.id !== id || player.entry !== entry) player.load(id, entry);
    const { p } = locate(entry.paragraphs, player.audio.currentTime);
    const target = Math.max(0, Math.min(entry.paragraphs.length - 1, p + dir));
    player.play(paragraphStart(entry.paragraphs, target));
    repaintAll();
}

async function playMessage(id) {
    const entry = audioOf(id);
    if (!entry) return false;
    if (!panels.has(id)) await openPanel(id);
    const panel = panels.get(id);
    player.load(id, panel?.entry ?? entry);
    await player.play(0);
    repaintAll();
    document.querySelector(`#chat .mes[mesid="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
}

// ------------------------------------------------------------------ audio events

player.audio.addEventListener('timeupdate', () => {
    repaintAll();
    if (player.entry && Date.now() - player.lastSave > 5000) {
        player.lastSave = Date.now();
        saveResume(player.id, player.entry.url, player.audio.currentTime);
    }
});
player.audio.addEventListener('play', repaintAll);
player.audio.addEventListener('pause', () => { if (player.entry) saveResume(player.id, player.entry.url, player.audio.currentTime); repaintAll(); });
player.audio.addEventListener('error', () => {
    if (!player.entry) return;
    toastr.error(`The audio file could not be loaded (${player.entry.url}). It may have been removed.`, NAME);
    repaintAll();
});
player.audio.addEventListener('ended', async () => {
    const done = player.id;
    saveResume(done, player.entry?.url, 0);
    repaintAll();
    if (!settings().continue || done == null) return;
    const next = audioMessages().find(i => i > done);
    if (next != null) await playMessage(next);
});

// ------------------------------------------------------------------ buttons

function markMessages() {
    for (const mes of document.querySelectorAll('#chat .mes')) {
        const id = Number(mes.getAttribute('mesid'));
        mes.classList.toggle('sbp_has_audio', !!audioOf(id));
    }
}

function addButtons() {
    const inject = (host) => { if (host && !host.querySelector('.sbp_play')) host.insertAdjacentHTML('afterbegin', BUTTON_HTML); };
    inject(document.querySelector('#message_template .extraMesButtons'));
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(inject);
    markMessages();
}

// ------------------------------------------------------------------ slash commands

function registerSlashCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    const target = (v) => {
        const chat = c.chat || [];
        if (v === undefined || v === null || String(v).trim() === '') return audioMessages()[0] ?? -1;
        const n = Number(v);
        if (!Number.isInteger(n)) return -1;
        return n < 0 ? chat.length + n : n;
    };
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'breeze-play',
            returns: 'true when playback started',
            unnamedArgumentList: [new SlashCommandArgument('message id; default the first message with audio', [ARGUMENT_TYPE.NUMBER], false)],
            helpString: '<div>Play a message\'s attached Breeze audio (and, with Continue on, the messages after it).</div>',
            callback: async (_args, value) => String(await playMessage(target(value))),
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'breeze-stop',
            returns: 'nothing',
            helpString: '<div>Stop Breeze Player.</div>',
            callback: async () => { player.stop(); repaintAll(); return ''; },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'breeze-info',
            returns: 'a short summary of the audio attached to this chat',
            helpString: '<div>How many messages carry audio, their total length and QA.</div>',
            callback: async () => {
                const ids = audioMessages();
                const total = ids.reduce((n, i) => n + (audioOf(i).duration || 0), 0);
                const lines = ids.reduce((n, i) => n + (audioOf(i).qa?.lines || 0), 0);
                const passed = ids.reduce((n, i) => n + (audioOf(i).qa?.passed || 0), 0);
                return `${ids.length} messages with audio, ${clock(total)} total${lines ? `, QA ${passed}/${lines}` : ''}`;
            },
        }));
    } catch (e) {
        console.warn(`[${NAME}] slash commands not registered:`, e);
    }
}

// ------------------------------------------------------------------ settings drawer

const SETTINGS_HTML = `
<div class="sbp_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Breeze Player</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <small>Plays audio the st-audio skill attached to messages. Open it with the <i class="fa-solid fa-headphones-simple"></i>
      button on a message, or <code>/breeze-play</code>.</small>
      <label class="checkbox_label"><input id="sbp_continue" type="checkbox"> Continue to the next message with audio</label>
      <label class="checkbox_label"><input id="sbp_autoscroll" type="checkbox"> Keep the paragraph being read in view</label>
      <label class="checkbox_label"><input id="sbp_expand" type="checkbox"> Show whole paragraphs in the panel</label>
      <div id="sbp_summary" class="sbp_summary"></div>
    </div>
  </div>
</div>`;

function bindSettings() {
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host || document.querySelector('.sbp_settings')) return;
    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    const s = settings();
    for (const [id, key] of [['sbp_continue', 'continue'], ['sbp_autoscroll', 'autoscroll'], ['sbp_expand', 'expand']]) {
        const box = document.getElementById(id);
        box.checked = !!s[key];
        box.addEventListener('change', () => { s[key] = box.checked; saveSettings(); });
    }
}

function summarize() {
    const box = document.getElementById('sbp_summary');
    if (!box) return;
    const ids = audioMessages();
    if (!ids.length) { box.textContent = 'This chat has no attached audio.'; return; }
    const total = ids.reduce((n, i) => n + (audioOf(i).duration || 0), 0);
    box.textContent = `This chat: ${ids.length} messages with audio, ${clock(total)}.`;
}

// ------------------------------------------------------------------ wiring

function onChatChanged() {
    player.stop();
    closeAllPanels();
    addButtons();
    summarize();
}

jQuery(() => {
    try {
        bindSettings();
        installExclusivePlayback();
        addButtons();
        registerSlashCommands();
        $(document).on('click', '.sbp_play', async function (ev) {
            ev.stopPropagation();
            const id = Number($(this).closest('.mes').attr('mesid'));
            if (panels.has(id)) closePanel(id); else await openPanel(id);
        });
        const { eventSource, event_types: ev } = ctx();
        const refresh = () => { addButtons(); summarize(); };
        for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']) {
            if (ev[name]) eventSource.on(ev[name], refresh);
        }
        if (ev.MESSAGE_SWIPED) eventSource.on(ev.MESSAGE_SWIPED, (id) => { if (player.id === Number(id)) player.stop(); closePanel(Number(id)); refresh(); });
        if (ev.CHAT_CHANGED) eventSource.on(ev.CHAT_CHANGED, onChatChanged);
        globalThis.breezePlayer = { player, openPanel, playMessage, audioMessages, panels };
    } catch (e) {
        console.error(`[${NAME}] failed to start`, e);
    }
});
