# Capsule Face MOD

Displays two white vertical capsule-shaped eyes on a black background, without a mouth.

The face continues to use Stack-chan's standard blink, gaze, expression, and breathing motions.

From the `firmware` directory, build and install it with:

```console
npm run mod:m5stackchan_cores3 -- mods/capsule_face/manifest.json --port COM7
```

## Animation modules

Each animation lives in `animations/` and exports an object with this interface:

```js
export default {
  duration: 1000,
  apply(face, elapsed) {
    // Update the face for the current elapsed time.
  },
}
```

Use `duration: null` for an animation that does not end automatically. Register new
animations in `animations/index.js`; the state machine and USB descriptor read from
that registry, so animation implementations do not need to modify `mod.js`.

## Teams pixel art

The Teams Status control displays a fixed 32 x 32 Teams icon on the left, a
pixel-art presence lamp on the right, and a custom message below them. Available,
busy, and away use green-check, red-minus, and yellow-clock lamps. Sending
`chymod.teams-status` immediately shows the selected layout for six seconds, then
returns to idle. It is excluded from Play now and random playback.

Edit the icon in `animations/teams-art.js` and the three lamps in
`animations/teams-status-art.js`. `teams.js` draws horizontal color runs without
image resources or time-driven redraws.

## Wake acknowledgement chime

`assets/wake-chime.wav` plays as soon as the "Hey Copilot" wake word fires, and the
conversation starts only after it finishes. The microphone and the speaker share I2S
port 1, so recording over the chime would stutter and swallow the first words. Keep
the asset short: its length is dead time between the wake word and the first word of
the utterance.

The asset must be a 24 kHz mono 16-bit PCM WAV with a plain 44-byte header, because
`speaker.ts` reads the format fields at fixed offsets. Regenerate it from a source
file with:

```console
ffmpeg -i <source> -map_metadata -1 -fflags +bitexact -flags:a +bitexact -ac 1 -ar 24000 -c:a pcm_s16le -af "volume=13dB,silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB,atrim=end=0.475,afade=t=in:st=0:d=0.01,afade=t=out:st=0.455:d=0.02" assets/wake-chime.wav
```

`volume` brings the peak to about -1 dBFS. `silenceremove` drops the leading silence,
and `atrim` cuts the tail: the source fades into a constant noise floor around -32 dBFS
that no silence threshold separates from real decay, so the end point is measured from
the amplitude envelope. Re-measure both for a new source.

The fades matter on hardware. The amplifier powers up immediately before playback, so
a chime that starts at full level pops, and an abrupt cut at the end clicks. Keep the
asset normalised and set the playback level with `WAKE_CHIME_VOLUME` in `mod.js`
instead of re-rendering at a lower gain: the CoreS3 amplifier distorts on a sustained
tone near full scale, which is why the chime plays 8 dB down while speech does not.

The MOD plays the chime through its own `Speaker` rather than the host's shared
instance, which follows the much quieter TTS volume preference.
