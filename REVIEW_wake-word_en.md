# Wake Word Investigation — "Hi Copilot" / "Hey Copilot"

Status: **Done. A custom-trained "Hey Copilot" microWakeWord model runs on
device and triggers from the device microphone.** esp-sr was abandoned.
Hardware: M5Stack CoreS3 (ESP32-S3, 16 MB flash, 8 MB Quad PSRAM @ 40 MHz)
Firmware: Moddable SDK (XS) on ESP-IDF 6.0
Date of investigation: 2026-09-13; model trained and deployed 2026-09-14

> **Result up front.** The three de-risking steps in §7 all passed. Front end
> 0.74 ms + inference 6.8 ms = **7.5 ms against a 30 ms budget (25%)**, zero
> dropped samples, and the stock `okay_nabu` model triggers reliably from the
> device microphone.
>
> Step 4 is also done: `hey_copilot.tflite` (62,304 B) was trained TTS-only on
> an RTX 5070 in 2 h 40 min and replaced `okay_nabu` in firmware. On its test
> set it reaches **2.84% false rejects at 0 false accepts/hour** (cutoff 0.87).
> The full training record is in **§9**.

---

## 1. Goal

Always-on, on-device recognition of one or two fixed phrases ("Hi Copilot",
"Hey Copilot"). On detection, ChyMOD plays the `happy` animation. No agent, no
speech-to-text, no command vocabulary. The feature is togglable from the ChyMOD
browser console over USB.

A stated property of the original design, recorded in the source:

> `Audio is consumed by ESP-SR on-device and is never retained or transmitted.`
> — `copilot-wake-word.js`

> `No speech audio leaves the device.`
> — `sdkconfig.defaults`

This constraint is load-bearing and was reaffirmed during the investigation. It
rules out server-side or cloud inference regardless of how convenient they are.

---

## 2. What was built

An implementation using Espressif's **esp-sr MultiNet** as a *continuous*
recognizer, with no WakeNet gating:

- `firmware/host/modules/audio/platforms/m5stackchan-cores3/copilot-wake-word.c`
  — native binding over `esp_mn_*`, phrases registered at runtime via
  `esp_mn_commands_add(1, "HI COPILOT")` / `(2, "HEY COPILOT")`
- `.../copilot-wake-word.js` — `AudioIn` capture, feeds PCM to the recognizer
- `firmware/mods/capsule_face/mod.js` — `chymod.wake` USB command, state in
  `chymod.status`, preference persisted across reboots
- `web/src/features/chymod/` — toggle and status fields in the browser console
- A 6 MB `model` partition carved out of the factory app partition

It worked end to end, in the sense that the device booted, the toggle worked,
and the recognizer initialized without error. It was not usable.

---

## 3. Defects found, in the order they surfaced

### 3.1 Wake never triggered — stereo interleaving

`copilot-wake-word.js` opened the microphone with `new AudioIn({ channels: 1 })`.
That runtime option does **not** reach the I2S slot configuration. In the
Moddable ESP32 driver the hardware layout is fixed by a build-time define:

```c
.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
    (2 == MODDEF_AUDIOIN_NUMCHANNELS) ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO),

rx_std_cfg.slot_cfg.slot_mask = (2 == MODDEF_AUDIOIN_NUMCHANNELS)
    ? I2S_STD_SLOT_BOTH : MODDEF_AUDIOIN_I2S_SLOT;
```

The CoreS3 platform sets `numChannels: 2` (confirmed in the generated
`mc.defines.h`: `#define MODDEF_AUDIOIN_NUMCHANNELS (2)`), so the microphone
always delivers **interleaved stereo**. The runtime option only changed the
driver's bookkeeping. MultiNet was being fed `L R L R …` and expects 16 kHz
mono, so it received noise.

**Fixed** by de-interleaving in `xs_copilot_wake_word_feed()`, keeping the first
channel, with the frame stride taken from `MODDEF_AUDIOIN_NUMCHANNELS` so the
code stays correct for a mono build.

Instrumentation later showed both channels are byte-identical
(`rmsL=123 rmsR=123`, `116/116`, `118/118`), i.e. one physical mono microphone
duplicated into both slots. Taking channel 0 is correct.

> Note: `robot.record()` in `firmware/host/modules/audio/microphone.ts` uses the
> same `channels: 1` option and writes a WAV header claiming 1 channel. It has
> the **same latent bug**. This was not fixed and is still present.

### 3.2 `recordPlayback` crashed the device

With wake enabled, invoking the host's own `recordPlayback` produced:

```
[AudioTest] record start duration=2000
assert failed: 0x421f224c
Backtrace: 0x40386729 ...
Rebooting...
```

The ESP32 exposes one I2S input channel. The wake recognizer held `AudioIn`;
`robot.record()` opened a second one; the IDF driver asserted and took the
device down. The PDM path in the Moddable driver has an `already in use` guard,
but the I2S standard path does not.

**Fixed** with a single-owner guard (`audio-input-lock.ts`) that both
`microphone.ts` and `copilot-wake-word.js` claim before opening `AudioIn`.
Verified on device — the crash became a clean, catchable error naming the
holder:

```
[AudioTest] record playback error microphone is in use by copilot wake word
```

The holder was stored on `globalThis` rather than in module scope, because
`microphone` is preloaded and preloaded modules are frozen into ROM.

### 3.3 Inference ran on the XS main thread

`AudioIn.onReadable` → JS callback → synchronous `multinet->detect()`, all on
the thread that also drives the animation and the USB control protocol.

**Fixed** by moving inference to a dedicated FreeRTOS task with a ring buffer,
following the pattern already used by `esp32-opus-encoder.c` in this repo.
`feed()` became non-blocking: de-interleave into the ring, return. The task
publishes a detection atomically and the next `feed()` collects it — at ~33
feeds/second the added latency is at most one audio chunk, so the JS API and the
MOD required no changes.

Measured effect on the USB control round-trip:

| | wake OFF | wake ON |
|---|---|---|
| before offload | 208 ms | **407 ms** |
| after offload | 206 ms | **213 ms** |

Main-thread responsiveness was fully restored. The animation was not.

---

## 4. Root cause — why esp-sr was abandoned

On-device instrumentation, printed every ~2 s from the inference task:

```
MultiNet6
chunk=512 detectUs=91370  budgetUs=32000 rmsL=123 rmsR=123 dropped=2945
chunk=512 detectUs=102998 budgetUs=32000 rmsL=116 rmsR=116 dropped=20609
chunk=512 detectUs=87972  budgetUs=32000 rmsL=118 rmsR=118 dropped=32385

MultiNet7
chunk=512 detectUs=68802  budgetUs=32000 rmsL=111 rmsR=111 dropped=0
chunk=512 detectUs=67320  budgetUs=32000 rmsL=114 rmsR=114 dropped=0
chunk=512 detectUs=71603  budgetUs=32000 rmsL=209 rmsR=210 dropped=0
chunk=512 detectUs=63352  budgetUs=32000 rmsL=210 rmsR=210 dropped=0
```

`budgetUs` is the real time a 512-sample chunk represents at 16 kHz (32 ms).
`detectUs` is the measured cost of one `detect()` call.

**MultiNet6 ran ~2.8x slower than real time.** Two thirds of the audio was
discarded, which shredded the phrase and explains why detection was so
unreliable. MultiNet7 brought this to ~2.1x and, at the audio rate actually
arriving, stopped dropping — but it never triggered at all in testing.

### Cost scales linearly with model size

| Model | `srmodels.bin` | measured `detectUs` | implied throughput |
|---|---|---|---|
| `mn6_en` | 3,788,232 B (3.61 MiB) | ~90 ms | 40.1 MiB/s |
| `mn7_en` | 2,761,093 B (2.63 MiB) | ~67 ms | 39.3 MiB/s |

Two independent measurements imply almost the same effective weight throughput
(~39.5 MiB/s). The model does not fit in the 32 KB data cache, so every
inference streams the full weight set. **The bottleneck is memory bandwidth,
not CPU.**

> **Unverified:** the implied ~39.5 MiB/s is roughly double an 80 MHz DIO flash
> bus (~20 MB/s), which suggests esp-sr loads weights into PSRAM at `create()`
> rather than streaming from flash. Espressif's benchmark table lists PSRAM
> usage (324 KB / 2920 KB / 4100 KB) that tracks model size closely, which is
> consistent. `Kconfig.projbuild` only offers `MODEL_IN_FLASH` /
> `MODEL_IN_SDCARD`, so this was not confirmed. Either way the conclusion holds:
> cost is linear in model size, and CoreS3's Quad PSRAM @ 40 MHz is roughly a
> quarter the bandwidth of the Octal @ 80 MHz parts Espressif benchmarks on.

### Residual impact on the UI

Even with inference on its own task, pinned to core 1:

| | tick ratio | RPC median |
|---|---|---|
| wake OFF | 0.90 | 209 ms |
| wake ON | **0.65** | 216 ms |

`tick ratio` is device animation time over wall-clock time (1.00 = real time).
A ~28% animation slowdown persisted, inherent to running MultiNet continuously.

> **Measurement caveat:** the first A/B runs used `lookAround` (7600 ms) with a
> sampling window that could cross the animation's end, resetting `elapsedMs`
> and reading as a fake slowdown. Numbers above come from the corrected method
> (windows kept well inside the animation). Earlier figures of 0.26 and 0.04
> should be disregarded.

### Verdict

MultiNet is designed to recognize commands **after** a wake word, not to run
always-on. Espressif ships WakeNet for that role precisely because a
continuously-running large model does not fit the budget. The architecture was
wrong, not the implementation.

---

## 5. Current repository state

All wake-word code has been **removed** from the working tree and the removal is
committed. Specifically:

- Deleted: `copilot-wake-word.c`, `copilot-wake-word.js`, `partitions.csv`,
  `audio-input-lock.ts`
- Reverted: `audio/manifest.json` (esp-sr + cjson dependencies, module
  registration, partition-table pointer), `microphone.ts` (the lock),
  `sdkconfig.defaults` (model selection), `moddable-version.mjs` +
  its test (partition source redirect)
- Trimmed: `idf-dependencies.mjs` lost the `esp-sr` / `cjson` entries but
  **kept** the Windows Ninja response-file support, which is general build
  infrastructure; its test was reworked to use `esp_audio_codec` as the fixture
- `mod.js`: wake import, state, `setWake`, status fields, `chymod.wake`
  registration and boot restore removed. The `working` animation and the
  double blink were **kept**.

Retained deliberately: the ChyMOD page still carries `wakeEnabled` /
`wakeError` / `wakeHitCount` types and status fields, plus the matching locale
strings. These are harmless — controls are driven by `chymod.describe`, which no
longer advertises `chymod.wake`, so the toggle does not render and the fields
show `—`.

The flash layout is back to a single factory partition; the `xs` MOD partition
returned from `0x9a0000` to `0xfa0000`. Firmware, MOD and web console were
rebuilt and redeployed to COM7 and verified.

A complete snapshot of the removed implementation — including the FreeRTOS task,
ring buffer, de-interleaving and the diagnostics — is preserved in
`git stash@{0}`. It can now be dropped: the microWakeWord component below
reimplements the same plumbing, and §7 records the de-interleaving trap it
contains so nothing is lost by discarding it.

**Superseded.** The state above describes the tree immediately after the esp-sr
removal. microWakeWord has since been implemented and merged into `develop`
(commits `b8dfd756` and `f4902558`), and `git stash@{0}` has served its purpose:

- `platforms/m5stackchan-cores3/micro-wake-word.cpp` — TFLM component: 20 ops,
  `MicroResourceVariables`, 40 KB tensor arena, ring buffer and inference task,
  plus a `stats()` call exposing front-end and inference timing, PCM level,
  dropped samples and probabilities
- `platforms/m5stackchan-cores3/micro-wake-word.js` — `AudioIn` capture
- `platforms/m5stackchan-cores3/hey_copilot.tflite` + `hey_copilot.NOTICE.md` —
  the custom model now loaded by firmware (§9), cutoff lowered to 0.87
- `platforms/m5stackchan-cores3/okay_nabu.tflite` + `okay_nabu.NOTICE.md` —
  stock Apache-2.0 model with attribution and SHA-256, kept in the tree as a
  known-good fallback but **no longer packaged** (`audio/manifest.json` `data`
  points at `hey_copilot`)
- `audio-input-lock.ts` — the single-owner microphone guard, restored
- `mod.js` / ChyMOD console — `chymod.wake` and the status fields, restored,
  now also surfacing `wakeStats`

---

## 6. Alternatives evaluated

The decisive criterion, derived from the failure above: **can the model be small
enough to live in internal SRAM (tens of KB), avoiding the streaming
bottleneck?**

| Option | Model size | Custom phrase | Verdict |
|---|---|---|---|
| **microWakeWord** | **52–60 KB** | Self-service training | **Best software path** |
| esp-sr WakeNet9 | ~284 KB | Vendor-gated | Viable but no self-service |
| esp-sr MultiNet | 2.6–3.6 MB | Runtime, plain text | **Failed — this report** |
| Porcupine | ~20 KB claimed | Excellent tooling | **Impossible — no Xtensa build** |
| openWakeWord | ONNX, multi-MB | Self-service | Too slow on S3 ("several seconds per 80 ms frame") |
| Snowboy / Mycroft Precise | — | — | Unmaintained, never had Xtensa ports |
| Sensory / Fluent.ai / DaVoice / Cyberon | — | — | Vendor-gated, no ESP32-S3 port found |
| M5Stack Unit ASR (CI-03T) | n/a — external module | **Free self-service** | Escape hatch: zero host CPU |

### microWakeWord (recommended)

Upstream is `OHF-Voice/micro-wake-word` (the `kahrendt/microWakeWord` repo is now
a fork). Apache-2.0. Ships in Home Assistant Voice PE, so the device-side path is
production-proven.

- Models are **52–60 KB** int8 TFLite, 40–60x smaller than MultiNet. They fit in
  internal SRAM; `tflite::GetModel()` takes a plain pointer, so a `memcpy` into
  `MALLOC_CAP_INTERNAL` removes the bandwidth problem entirely.
- Inference runs **every 30 ms**, which aligns with our 32 ms chunk budget.
- The feature front end is already a standalone, dependency-free C ESP-IDF
  component (`esphome/esp-micro-speech-features`). The inference core's coupling
  to ESPHome is thin — logging, an allocator, and a removable preferences
  object. Estimated 200–300 lines to write our own component.

Three things must be copied exactly or it will silently never trigger:
1. The 20 TFLM ops registered in `register_streaming_ops_`, including
   `VarHandle` / `ReadVariable` / `AssignVariable` — streaming state lives in
   TFLM resource variables, so `MicroResourceVariables` must be created.
2. The feature quantization, `value_div = 666`.
3. Sliding-window averaging (`sliding_window_size: 5`), `probability_cutoff`,
   and a `MIN_SLICES_BEFORE_DETECTION` refractory period.

Known risks:
- **Training quality is the real risk.** Upstream states plainly that training a
  usable model "is still very difficult" and that the notebook's output "will
  most likely not be usable". The issue tracker corroborates this.
- **Licensing**: the official negative-sample datasets are CC-BY-NC-4.0 and the
  notebook says self-trained models should be treated as non-commercial personal
  use. An upstream issue asking for clarification has had no reply. Fine for a
  personal project; a blocker for redistribution unless a permissively-licensed
  negative corpus is assembled.
- **ESP-IDF 6.0 compatibility is unverified.** The component manifests say
  `idf: ">=5.1"` with no upper bound, but CI almost certainly does not cover 6.0,
  and `priv_req` includes `driver`, which 6.0 restructured.
- The arena size in the model manifest **underestimates** actual need
  (`okay_nabu` wants 33,488 B against a declared 26,080 B). Budget ~40 KB or
  port the upstream `probe_arena_size_()` logic.

### A warning that applies to any TFLM approach — since **resolved**

`ckeller42/kws-de` runs TFLite Micro + ESP-NN **on this exact board**. With a
17,880-byte model, one streaming step still cost **82–85 ms** — down from
164–181 ms only after the FFT front end was rewritten by hand. A small model
does not guarantee low latency; the feature front end can dominate.

This was the largest open risk against microWakeWord, and it **did not
materialize**. Measured on our device with `okay_nabu`:

```
frontendAverageUs   741–778 µs     (0.74 ms)
invokeAverageUs    6631–6811 µs    (6.8 ms)
total              ~7.5 ms per 30 ms inference interval = 25% of budget
```

microWakeWord's C front end ("avoids TFLM interpreter use for feature
generation") is roughly **100x cheaper** than the hand-rolled FFT path that
`kws-de` had to optimize. The concern was legitimate but the component already
solves it.

### Espressif's custom wake word channel — ruled out

For the record: a free, official, still-operating channel exists at
`espressif/esp-sr` issue #88 (TTS-trained, free for commercial use, most recent
delivery six days before this investigation). It was **explicitly ruled out** by
project decision. Two independent reasons also argue against it: there is no
SLA (20+ requests open with no reply, some for months), and "Copilot" is a
Microsoft trademark used as their own wake word — Espressif has previously
declined words encumbered by commercial agreements.

There is **no self-service WakeNet training**. Espressif: "目前没有开放训练代码或
接口" and esp-sr cannot import TFLite models. The `wn9_customword` folder is
misleadingly named; it is a copy of the 小爱同学 model.

---

## 7. Next steps

Staged so that **the first three require no model training at all**. All three
are now **done and green**.

### Step 1 — Toolchain compatibility — **PASS**

`espressif/esp-tflite-micro`, `espressif/esp-nn` and
`esphome/esp-micro-speech-features` build against ESP-IDF 6.0. The `idf: ">=5.1"`
open upper bound held; no `driver` restructuring problem materialized.

### Step 2 — Latency floor — **PASS**

Stock Apache-2.0 `okay_nabu.tflite` (60,264 B), 20 ops registered,
`MicroResourceVariables` created. Measured on device:

| | measured | note |
|---|---|---|
| front end | **0.74 ms** | ~100x cheaper than the `kws-de` hand-rolled FFT |
| `Invoke()` | **6.8 ms** | |
| total | **7.5 ms / 30 ms** | 25% of budget |
| tensor arena used | **25,796 B** | of 40,960 allocated |
| dropped samples | **0** | |

Budgeting 40 KB of arena was correct: the manifest's declared 26,080 B would
have been marginal against the 25,796 B actually used.

### Step 3 — End-to-end with a stock model — **PASS**

Verified rates from the device, all matching spec:

```
pcmSampleCount   ≈ 16,000 /s    (16 kHz)
featureCount     ≈ 97 /s        (one per 10 ms)
invokeCount      ≈ 32 /s        (one per 30 ms)
```

"Okay Nabu" triggers reliably from the device microphone; the ChyMOD console
reported 5 hits with the correct `lastWakePhrase`.

> **Trap — do not de-interleave.** §3.1 documents that the CoreS3 I2S slot
> layout is fixed stereo, which makes it tempting to de-interleave in the wake
> word component. **Do not.** `xs_audioin_read` in
> `$(MODDABLE)/modules/io/audioin/esp32/audioin.c` already strips a channel when
> `AudioIn` is constructed with `channels: 1`:
>
> ```c
> if (input->numChannels == 1)
>     available /= 2;					// strip left channel
> ```
>
> Buffers reaching `feed()` are already mono. De-interleaving again halves the
> effective rate to 8 kHz and the model silently stops matching — the counters
> all look healthy while `maxProbability` never rises. This was hit and fixed
> during bring-up; the reasoning is recorded in `micro-wake-word.cpp`.
>
> Note also that equal per-channel RMS is **not** evidence of interleaving:
> mono data read as channel pairs yields near-equal RMS too, since both are the
> same signal sampled a step apart.

> **Deployment lesson.** During bring-up the symptom "does not trigger" turned
> out to be a stale build on the device, not a code defect — a clean rebuild and
> flash of unchanged source fixed it. When behaviour contradicts the source,
> confirm what is actually running before debugging the code.

### Step 4 — Train "Hey Copilot" — **DONE**

> The guidance below was written **before** training and is kept as the plan of
> record. §9 records what was actually done; where they differ, §9 wins. In
> short: plain spelling instead of IPA, no confusable negatives and no real
> recordings were needed for a usable first model.

**Use `malonestar/custom-micro-wake-word-model`** rather than the upstream
notebook. It is a fork of microWakeWord set up for Windows + WSL2 + NVIDIA, and
it carries three patches that fix exactly the breakages upstream's issue tracker
is full of:

| patched file | fix |
|---|---|
| `microwakeword/audio/clips.py` | replaces TorchCodec (no Windows/WSL2 support) with `soundfile` + `librosa` |
| `microwakeword/test.py` | NumPy 2.0 `np.trapz` → `np.trapezoid` |
| `microwakeword/train.py` | same, plus guards before calling `.numpy()` on metrics |

It also ships trained models including `hey_stackchan_v1.tflite`, and reports
better results than upstream's own tuned model: `hey frank` v5 at **0.103 FA/hr,
97.58% recall**, and `hey m5` v3 at **0.000 FA/hr, 97.81% recall** with 217 real
recordings added. (Author's own figures, not independently verified.) It is
small — 17 stars, 23 commits, all within two weeks of March 2026 and quiet
since — so treat it as one person's working setup, not a maintained product.
Its ESPHome `.yaml` and `components/` are irrelevant to us; only the training
side matters, and its output is a standard ESPHome v2 manifest plus `.tflite`,
which our own component already consumes.

- **Start with zero recordings.** TTS-only is the standard approach — the stock
  microWakeWord models are Piper-TTS-trained, and Espressif reports TTS reaching
  90–95% of human-recorded accuracy. Note the fork uses **50,000** TTS samples
  from the libritts multi-speaker model (reducible to 25,000), not the ~1000 of
  the upstream notebook's baseline; ~25 min to generate on a Colab T4. Training
  runs two-phase `[25000, 20000]` steps at batch 256.
- **Use IPA, and verify pronunciation first.** The fork drives Piper with IPA
  rather than spelling. For "hey frank" it uses `hˈeɪ fɹˈæŋk˺`, where the
  no-audible-release marker `˺` forces closure of the final consonant so the
  model cannot learn to fire on a truncated version. A starting point for our
  phrase is `hˈeɪ kˈoʊpaɪlət`, likely with `˺` on the final /t/ — **listen to
  generated samples before training on them**. Plain spelling (`"hey copilot"`)
  is fine for a first diagnostic run.
- **Train confusable hard negatives.** The fork trains phonetically similar
  phrases as high-penalty negatives to suppress near-miss false accepts — for
  "hey frank", "hey fran" and "hey finn". For ours: "hey copy", "hey pilot",
  "okay copilot", "hey copilots", "hey cobalt". `negative_class_weight [50, 60]`
  is documented there as the single most effective false-accept control.
- Only if the TTS-only model underperforms, record ~30–50 utterances. Because
  this is a single-user prototype, recording through the CoreS3's own microphone
  removes the usual train/test domain mismatch. Vary speaking rate and record
  across different times of day; leave distance, volume and noise to
  augmentation, which models those faithfully. Augmentation multiplies existing
  information — it cannot substitute for phonetic variety, which is what TTS
  supplies.
- Start with **one phrase**, not two. Half the work and fewer variables.
- A single-user system can be tuned far more conservatively than a product: a
  missed trigger costs a repeat, a false accept at midnight is worse. Bias the
  threshold toward missing, which is the direction that is otherwise hardest to
  tune.
- Decide the licensing position **before** generating data. Both upstream and the
  fork pull negatives from AudioSet / Free Music Archive / MIT RIR with mixed
  licences, and both state the result is for **non-commercial personal use
  only**. An internal corporate demo is not obviously "personal use", so if this
  is shown at work, either get that cleared or assemble a permissively-licensed
  negative corpus (FSD50K's CC subset, FMA CC-BY-4.0, Common Voice).

**Constraints since resolved.** Trademark is not a concern — this is an internal
Microsoft demo of Microsoft's own mark. Training hardware is available (RTX 5070,
matching the fork's tested RTX 5070 Ti / 12 GB VRAM environment; the fork also
wants WSL2, Python 3.12 and 16 GB+ system RAM). Feature generation takes 20–40
min on GPU; training itself runs a few hours at the default schedule.

### Fallback — M5Stack Unit ASR (U194)

No longer needed for latency — Step 2 passed — but kept on record in case the
custom phrase cannot be trained to an acceptable false-accept rate. The CI-03T
is a Grove-connected escape hatch from the same vendor: custom wake words are **free and
self-service** via the Smart Pi platform, and the host CPU cost is **zero** — it
reports over UART at 115200 8N1, so the animation loop cannot be starved by
construction. Unverified: recognition latency and English custom-word accuracy.

### Explicitly not recommended

- **Streaming audio to a PC or server** (USB or Wi-Fi). Bandwidth is a non-issue
  (32 KB/s; the repo already has a framed USB audio path with
  `STACKCHAN_MICROPHONE_SAMPLE_RATE = 16000`), but it breaks the project's
  stated "no speech audio leaves the device" property. Rejected on privacy
  grounds, not technical ones.
- **Buying an XVF3800.** It does not perform wake word detection at all; it is a
  front-end DSP. It cannot solve the custom-phrase problem.
- **Switching flash to QIO** to buy bandwidth. Even doubled, MultiNet stays over
  budget, and a wrong flash mode risks an unbootable device.
- **Raising PSRAM to 80 MHz.** `sdkconfig.defaults` documents that 40 MHz is
  deliberate: "Direct PSRAM DMA corrupts RGB565 frames when it competes with the
  CoreS3 display on the 40 MHz PSRAM."

---

## 8. Loose ends

- `robot.record()` still has the stereo-interleaving bug described in §3.1. It
  writes a WAV header declaring one channel while the data is interleaved
  stereo, so recordings play back wrong. Independent of wake word work.
- ~~The single-owner microphone guard was removed along with the wake feature.~~
  Restored as `audio-input-lock.ts` with microWakeWord; `git stash@{0}` can be
  dropped.
- `hey_copilot.tflite` has not had an on-device false-accept measurement. The
  0 FA/h figure comes from ~5 h of test ambience (§9.6). Watch for false
  triggers from TV or conversation; the cutoff can be raised toward 0.90–0.93
  without retraining.
- `okay_nabu.tflite` is still in the tree but unused. Delete it once the custom
  model has proven itself, or keep it as the fallback.
- The header comment of `micro-wake-word.cpp` still credits the Okay Nabu
  manifest. That remains true for the post-processing parameters (sliding
  window, refractory period); only the cutoff now differs.
- M5Stack documents the CoreS3 codec as ES7210 with "dual-microphone input".
  Instrumentation showed both I2S slots carrying identical data, which suggests
  a register configuration rather than a hardware limit. If a second physical
  microphone exists, a 2-mic AFE could improve far-field pickup at no hardware
  cost. Not verified — would need the schematic.

---

## 9. Training record — `hey_copilot.tflite`

### 9.1 Environment

| | |
|---|---|
| Host | Windows 11, 31.2 GB RAM, RTX 5070 (12 GB, compute capability 12.0) |
| Runtime | WSL2 Ubuntu, Python 3.12 venv (uv), TensorFlow 2.21 + CUDA 12.9 |
| Framework | `OHF-Voice/micro-wake-word` `4665173`, with malonestar's three patches overlaid (`clips.py`, `test.py`, `train.py`, see Step 4) |
| TTS | `rhasspy/piper-sample-generator` `2971426`, voice `en_US-libritts_r-medium` |
| WSL memory cap | **`memory=26GB`** in `%USERPROFILE%\.wslconfig` (default 15 GB is not enough, §9.7) |

The training scripts live outside this repository, in `E:\MicroWave`:

| script | does |
|---|---|
| `1b-generate-parallel.ps1` | parallel Piper generation into shards, merged with unique names; `-Target` tops up to a total |
| `2-download-negatives.ps1` + `fetch_negatives.py` | augmentation audio and negative feature sets, resumable |
| `3-train.ps1` + `build_features.py` + `write_config.py` | features → `training_parameters.yaml` → train → quantize → streaming ROC |
| `inspect_tflite.py` | compares a trained model's tensors and op set against `okay_nabu.tflite` |
| `watch_memory.sh` | samples WSL memory every 10 s, so an OOM leaves evidence |

Blackwell has no prebuilt TensorFlow kernels: the first GPU run JIT-compiles from
PTX and sits silent for a long time before step 1. It is not a hang.

### 9.2 Positive samples

- **50,000** clips of `Hey Copilot`, plain spelling, `--noise-scale-ws 0.4`,
  3 parallel workers.
- espeak-ng (Piper's G2P) already renders the phrase as `hˈeɪ kˈoʊpaɪlət`.
  Hyphenating or spacing it ("co-pilot") makes it **worse** by adding a second
  stress; the "cop-pilot" mispronunciation seen earlier came from a different
  TTS engine. No IPA input was needed.
- No confusable negatives and no real recordings.

### 9.3 Augmentation and features

Augmentation audio: MIT impulse responses, one parquet shard of AudioSet
(`agkphysics/AudioSet`, `data/bal_train/NN.parquet`; the notebook's `.tar` URL is
gone), and FMA extra-small. Each clip is padded to 3.2 s with 0.195–0.205 s
jitter, background SNR −5 to 10 dB, with `Gain` 1.0, `AddBackgroundNoise` 0.75,
`RIR` 0.5 and EQ / distortion / pitch / band-stop / colour noise at 0.1 each.

| split | repetition | slide frames | spectrograms | build time |
|---|---|---|---|---|
| training | 2 | 10 | 800,000 (37 GB) | 42 min |
| validation | 1 | 10 | 50,000 | 2 min 40 s |
| testing | 1 | 1 | 5,000 | 1 min 33 s |

malonestar uses training repetition 3; 2 was enough here.

Negatives are microWakeWord's pre-generated feature sets
(`kahrendt/microwakeword` on Hugging Face):

| set | sampling weight | role |
|---|---|---|
| positives | 2.0 | truth |
| `speech` | 10.0 | negative |
| `dinner_party` | 10.0 | negative |
| `no_speech` | 5.0 | negative |
| `dinner_party_eval` | 0.0 | ambient validation / test only |

### 9.4 Model and schedule

```
mixednet --pointwise_filters 64,64,64,64 --repeat_in_block 1,1,1,1 \
  --mixconv_kernel_sizes '[5],[7,11],[9,15],[23]' --residual_connection 0,0,0,0 \
  --first_conv_filters 32 --first_conv_kernel_size 5 --stride 3
```

26,049 parameters — the same geometry as the stock v2 models.

| | phase 1 | phase 2 |
|---|---|---|
| steps | 25,000 | 20,000 |
| learning rate | 0.001 | 0.0005 |
| negative class weight | 50 | 60 |

Batch 256, evaluation every 500 steps, best checkpoint selected by
`ambient_false_positives_per_hour` below 0.4, then `average_viable_recall`.

Wall time **2 h 40 min** with features already built. About 80 s per 500
steps plus ~30 s per evaluation.

### 9.5 Output

- `stream_state_internal_quant.tflite` → `hey_copilot.tflite`, 62,304 B
- Best weights from **step 36,000** (0 ambient false positives on validation)
- Input `[1,3,40] int8` (scale 0.10196, zero point −128), output `[1,1] uint8`
  (scale 0.00390625) and the 13 ops are **identical** to `okay_nabu.tflite`, all
  already registered in `micro-wake-word.cpp`. No runtime change was needed.

### 9.6 Results

Streaming quantized model on the test set:

| cutoff | false reject rate | false accepts / hour |
|---|---|---|
| **0.87** | **2.84%** | **0.000** |
| 0.79 | 2.50% | 0.187 |
| 0.58 | 1.92% | 0.375 |
| 0.49 | 1.66% | 0.562 |
| 0.43 | 1.52% | 0.937 |

Read these conservatively:

- The test positives are Piper TTS too, from the same generator as training.
  Real voices will miss more often.
- The false-accept figure rests on ~5.3 h of ambience (resolution 0.187 FA/h).
  "0" means "none in 5 hours", not "never".

On device the model triggers from a real voice. It was not hard to trigger at
the Okay Nabu cutoff of 0.97, but 0.97 lies above every point in this ROC, so
firmware now uses **0.87**, the highest reported cutoff.

### 9.7 Problems hit, and what they cost

1. **OOM at the second evaluation.** Training died at step 1000 with exit 9, and
   WSL restarted, losing `dmesg`. A memory sampler showed each evaluation
   loading the whole validation set into RAM with several copies alive at once:

   | | used | available | swap |
   |---|---|---|---|
   | before evaluation | 7.5 GB | 8.1 GB | 0 |
   | peak | 15.3 GB | **215 MB** | 3.8 GB |

   Not a leak — the baseline settles back to ~7 GB — but each evaluation needs
   another 7–9 GB. **Shrinking validation 5x saved only ~2 GB**, so the fix is
   the WSL cap, as malonestar's README also specifies (`memory=28GB` on a 32 GB
   host). The first diagnosis blamed the validation set alone and was wrong.
2. **Parallel generation was OOM-killed** when a training test ran alongside it.
   Generation is CPU-bound and training GPU-bound, but both share WSL's RAM.
   `1b-generate-parallel.ps1` now merges whatever shards survived before
   reporting failure, so a re-run continues instead of restarting.
3. **Dependency breakage**, each of which would have failed hours in:
   - AudioSet moved from `.tar` to parquet shards.
   - `datasets` requires torchcodec even with `decode=False` on streaming
     datasets; replaced with direct `huggingface_hub` downloads.
   - piper-sample-generator pins `audiomentations==0.33.0`; microWakeWord needs
     `AddColorNoise`. Upgraded to 0.43.1 after confirming Piper's generation path
     never imports it.
   - `tensorboard` is not in microWakeWord's `setup.py`, but training calls
     `tf.summary.scalar` at the first evaluation.
   - With `eval_step_interval` 500, a short smoke run saves no `best_weights`,
     so conversion fails; `write_config.py --eval-interval` exists for that.
4. **There is no real resume.** `--restore_checkpoint 1` restores weights and
   optimizer state from `restore/`, but the step counter, the learning-rate
   phase and the best-so-far score all reset. The first evaluation after a
   restart **overwrites `best_weights.weights.h5`** however bad it is — back it
   up first. If an interrupted run already has good best weights,
   `3-train.ps1 -ConvertOnly` is usually the better move than retraining.
   `restore/` also survives between runs, so a "fresh" run silently warm-starts
   from whatever was left there; clear it for a clean start.
5. **Stale firmware build.** After changing the packaged model, an incremental
   `npm run deploy` regenerated the makefile but skipped the Moddable step and
   flashed the previous binary, still containing `okay_nabu.tflite`. Checking
   `mc.resources.c` caught it. After a resource change, run `npm run clean`,
   then `npm run build`, then deploy — `deploy` alone refuses to run on a clean
   tree ("Please build before deploy").
6. The end-to-end smoke test of `3-train.ps1` used 300 clips, which is far too
   small to reach the memory ceiling. It proved the pipeline, not the capacity.

### 9.8 Reproducing

```powershell
cd E:\MicroWave
.\1b-generate-parallel.ps1 -Target 50000   # ~50,000 positives
.\2-download-negatives.ps1                 # resumable
.\3-train.ps1                              # or -SkipFeatures to reuse features
```

Then copy
`dataset\trained_models\wakeword\tflite_stream_state_internal_quant\stream_state_internal_quant.tflite`
over `hey_copilot.tflite`, update the SHA-256 in `hey_copilot.NOTICE.md`, and do
a clean firmware build.
