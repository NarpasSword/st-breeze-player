# Breeze Player

A SillyTavern extension that plays pre-rendered, quality-checked
[Breeze TTS 2](https://huggingface.co/RESONIA) audio attached to chat messages.

It replaces the player half of
[ST-breeze-tts-director](https://github.com/NarpasSword/ST-breeze-tts-director). The audio isn't made in the
browser any more. A Claude Code skill (`st-audio`) does that outside SillyTavern:

1. it reads a story chat and splits it into paragraphs and quotes (`units.mjs`, shared with this extension);
2. a director casts a voice per speaker from your Breeze voices and writes a delivery instruction per paragraph;
3. every line is rendered with Breeze in ComfyUI and checked with Whisper (words) and an audio model (tone),
   with automatic re-rolls;
4. each message becomes one mp3, uploaded to your SillyTavern user files as
   `/user/files/breeze_<chat>_m<id>_<hash>.mp3`, and the timing table is saved on the message as
   `extra.breeze_audio`.

This extension only plays what is attached. It makes no model or TTS calls and never writes the chat.

## Use

- Messages with audio get a file-audio button in their **⋯** menu. It opens a panel: play/pause,
  previous/next paragraph, stop, speed, **Continue** (go on to the next message with audio), and one row per
  paragraph showing who speaks. Click a row to play from there.
- The paragraph being read is highlighted and kept in view. Where you stopped is remembered per message,
  in this browser.
- The trash button deletes the version of the audio you're viewing, after asking: the mp3 is removed from your
  SillyTavern files and the entry from the message. If you delete the current version, the newest older one takes
  its place. A file that another entry in the chat still uses is kept.
- `/breeze-play [message id]`, `/breeze-stop`, `/breeze-info`, `/breeze-delete [message id] [all=true] [confirm=false]`.
- If a message was edited, swiped, or split differently since its audio was made, the panel says
  **Outdated** and why. The audio still plays, but its timing may no longer match the rows.
- Earlier renders of a message (up to 3) can be picked from the panel's version list.

## Install

Extensions → Install extension → `https://github.com/NarpasSword/st-breeze-player`.

## Using it alongside ST-breeze-tts-director

Both can be installed at the same time, and the e2e test checks that they work together:

- **No shared names.** The two extensions use different globals (`breezePlayer` vs `breezeTts` / `breezeDirector` /
  `breezeExplain`), slash commands (`/breeze-play|stop|info` vs `/breeze-direct|cast|audio|blank`), settings keys
  (`breeze_player_v3` vs `breeze_director` / `breeze_player`), message fields (`breeze_audio` vs `breeze_direction` /
  `breeze_skip`), CSS classes (`sbp_*`) and storage (one localStorage key vs IndexedDB `breeze-tts`).
- **Different buttons.** Breeze Player's button is a file-audio icon. The director's player keeps its headphones,
  and its masks button stays as it is.
- **One voice at a time.** When the director's player, its TTS provider or SillyTavern's narration starts speaking,
  Breeze Player pauses, and starting Breeze Player pauses them. Looping media such as background music and
  ambience is left alone. SillyTavern's narration queue only pauses: it holds its place until you press its own
  stop or play button.
- **Each extension leaves the other's data alone.** The director's take commands (`/breeze-blank` and so on) only
  touch `breeze_direction`. Attached audio survives them, and it is saved along with the chat whenever the chat is
  saved.

## Data format (`message.extra.breeze_audio`)

```js
{ v: 1, job, units_version, options,          // how the message was split (see units.mjs)
  swipe_id, text_sha256,                       // what the audio was cut for
  url, sha256, duration,                       // the mp3 in /user/files
  paragraphs: [{ i, start, end, segments: [{ i, start, end, speaker }] }],   // seconds
  qa: { lines, passed, rerolled, flagged, tone_flags }, rendered,
  history: [ /* up to 3 earlier entries */ ] }
```

`chat_metadata.breeze_audio` holds a job summary: the cast, the messages that carry audio, and the render date.

## Develop

```sh
node --test tools/units.test.mjs tools/timeline.test.mjs        # pure logic
node tools/e2e.mjs http://127.0.0.1:8011 Testa.png "Testa - storywriter - test - 2026-10-12" /tmp/e2e
```

`e2e.mjs` drives a real SillyTavern page in Playwright: buttons, rows, playback, highlight, seek, pause,
continue, slash commands and outdated detection. Run it against the st-audio testbed (`testbed.py`), not a
production ST. `units.mjs` is the single source of the splitter. Changing it changes what "paragraph N" means,
so bump `UNITS_VERSION` when you do.
