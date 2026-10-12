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

- Messages with audio get a headphones button in their **⋯** menu. It opens a panel: play/pause,
  previous/next paragraph, stop, speed, **Continue** (go on to the next message with audio), and one row per
  paragraph showing who speaks. Click a row to play from there.
- The paragraph being read is highlighted and kept in view. Where you stopped is remembered per message,
  in this browser.
- `/breeze-play [message id]`, `/breeze-stop`, `/breeze-info`.
- If a message was edited, swiped, or split differently since its audio was made, the panel says
  **Outdated** and why. The audio still plays, but its timing may no longer match the rows.
- Earlier renders of a message (up to 3) can be picked from the panel's version list.

## Install

Extensions → Install extension → `https://github.com/NarpasSword/st-breeze-player`.
Disable ST-breeze-tts-director's player if you don't need its live TTS any more. They don't conflict:
the slash commands, CSS classes and settings keys are all different.

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
