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
