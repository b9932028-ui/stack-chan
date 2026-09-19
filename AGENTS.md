# AGENTS.md

This file provides repository-wide guidance for coding agents working in this repository.

## Project Overview

Stack-chan is a JavaScript-driven M5Stack-embedded robot. The codebase is primarily TypeScript/JavaScript built on the Moddable SDK platform for ESP32 microcontrollers.

## Core Architecture

### Modular Component System
- **Host Program**: Core firmware (`firmware/host/app/main.ts`) that provides the robot framework
- **MODs**: User applications that extend functionality (in `firmware/mods/` directory)
- **Drivers**: Hardware abstraction for different servo types (PWM, DYNAMIXEL, RS30X, SCServo)
- **UI modules**: Piu Application, views, drawer, status bar, bubbles, effects, and face components under `firmware/host/modules/ui`
- **TTS Engines**: Text-to-speech providers (local, remote, VoiceVox, ElevenLabs, OpenAI)
- **Services**: Background services (HTTP server, network, preferences)

### Key Directories
- `firmware/host/`: Core firmware source code
- `firmware/mods/`: Modular applications that can be loaded at runtime
- tests: Co-located under the target `firmware/host`, `firmware/mods`, or platform implementation
- `firmware/typings/`: TypeScript definitions for the Moddable platform
- `firmware/dist/`: Generated firmware programs and intermediate build files; do not edit or commit them
- `case/`: 3D printable robot case files
- `schematics/`: PCB designs for control boards

## Development Commands

All commands should be run from the `firmware/` directory:

### Setup and Installation
- `npm run setup` - Set up ModdableSDK and ESP-IDF using xs-dev
- `npm run setup -- --device=esp32` - Additional ESP32 setup
- `npm run doctor` - Check development environment status

### Building and Deployment
- `npm run build` - Build firmware for M5StackChan CoreS3 (default target)
- `npm run deploy` - Build and flash firmware to connected device
- `npm run debug` - Build and flash with debug mode
- `npm run mod` - Flash a MOD to already-deployed firmware (fast development cycle)
- `npm run bundle` - Create a bundle of the firmware
- `npm run clean` - Remove generated files under `firmware/dist`

### Firmware Build Output Contract

- Use the repository npm scripts instead of invoking `mcconfig`, `mcrun`, or `mcpack` directly. The wrappers supply the managed Moddable `-o` argument.
- Normal host, MOD, and test builds write programs to `firmware/dist/bin/` and intermediate files to `firmware/dist/tmp/`.
- The host application name is always `stack-chan-host`.
- Do not add a custom `-o`; repository commands reject it to keep worktree output isolated under `firmware/dist`.
- `npm run clean` removes all generated files under `firmware/dist`.
- `npm run bundle` builds every release target under `firmware/dist/`, stages validated target artifacts in `firmware/dist/bundle-targets/`, and writes the assembled directory and ZIP under `firmware/host/app/`.
- The named `npm run build:release:<target>` scripts and `npm run bundle:package` are the CI building blocks for parallel target builds and final artifact assembly.
- `npm run mod` uses `mcrun -t build` to create an archive, then discovers and writes the live device's `xs` partition with `esptool`.

### Code Quality
- `npm run lint` - Run Biome linter
- `npm run lint:fix` - Auto-fix linting issues
- `npm run format` - Check code formatting with Biome
- `npm run format:fix` - Auto-format code

### Device Management
- `npm run scan` - Scan for connected devices
- `npm run erase-flash` - Erase device flash memory

### Documentation and Testing
- `npm run generate-apidoc` - Generate API documentation with TypeDoc

## Target Configuration

The default target is M5StackChan CoreS3. Select other supported hardware through the named npm scripts, for example:

- `npm run build:stackchan_rt`
- `npm run build:takao_core2_sg90`
- `npm run flash:stackchan_rt`
- `npm run flash:takao_core2_sg90`

Do not use `--target` or `npm_config_target`; the firmware command wrapper rejects generic target overrides so that the matching platform and application manifest are selected together.

## MOD Development Workflow

1. Write MOD in `firmware/mods/` with `manifest.json` and `mod.js`
2. From `firmware/`, use `npm run mod -- mods/your-mod/manifest.json` for rapid iteration
3. MODs can add behavior via `onLaunch` and `onContextCreated` hooks

## ChyMOD Design Contract

ChyMOD spans the capsule-face MOD and its browser control page:

- MOD implementation: `firmware/mods/capsule_face/`
- Generic firmware USB extension registry: `firmware/host/modules/connectivity/usb-control-registry.ts`
- Browser control page: `web/src/features/chymod/`, served at `/chymod/`

Keep the animation state machine inside the MOD so it operates identically with no USB connection. It starts in `idle`; while idle and random playback is enabled, every three seconds it randomly selects one of `idle`, `blink`, `lookAround`, `happy`, `angry`, or `working`. A non-idle animation returns to `idle` when complete and restarts the three-second countdown. A manual animation request interrupts immediately, then follows the same return-to-idle behavior. The `working` animation may use the full-screen effect layer for visuals such as its book and animated bottom status line that must render outside the movable face region.

The wake word runs one fixed sequence, which the MOD owns end to end. With a USB host attached: aim the head at the stored `wakeOrientation` (skipped when none is stored), play the chime and `happy` together, and once `happy` has played in full switch to `listening` and only then ask the host to record. Cutting `happy` short to start recording looked wrong, and the shared I2S port needs the chime to have drained first. The host's conversation states drive the rest: `recognizing` holds `thinking`, `speaking` holds `speaking`, and `standby` returns to `idle`. With no USB host the sequence is just the chime and `happy`. Conversation animations loop while their phase lasts, because a phase outlives any one animation.

USB is an optional control and observation path, not the animation scheduler. Keep host-firmware changes generic: MODs register namespaced commands through the USB control registry, and ChyMOD owns only the `chymod.*` namespace. The current protocol is:

- `chymod.describe`: return the versioned, schema-driven control descriptor
- `chymod.play`: immediately play one named animation
- `chymod.status`: return the current animation, elapsed time, duration, random setting, and next decision time
- `chymod.random`: enable or disable autonomous random playback (off by default)
- `chymod.wake`: enable or disable the "Hey Copilot" wake word
- `chymod.wake-orientation`: store `{ yaw, pitch }` in tenths of a degree, or `null` for no turn
- `chymod.teams-status`: show the Teams layout with a presence light and short custom message

Command and namespace names must match `/^[a-z][a-z0-9-]*$/`, which `usb-control-registry.ts` enforces at registration. A camelCase name throws `invalid USB control command` out of `onContextCreated`, and the host then falls back to its default face with no on-screen hint that the MOD failed; the boot trace is where that shows up.

Add future ChyMOD controls through the descriptor and namespaced request/response protocol instead of adding feature-specific switches to the default firmware USB server. Preserve the existing `stackchan-usb-v1` handshake and request IDs so multiple controls can share the serial connection safely.

The web page must render controls from `chymod.describe`, display live state from `chymod.status`, and remain usable when capabilities are unavailable by showing a clear disconnected or unsupported state. For backend/web UI updates, add and maintain English copy only. Do not update Japanese or Simplified Chinese translations unless the user explicitly requests them.

The voice pipeline records itself to `web/logs/chymod-voice.log` (JSON lines, rotated at 4 MB keeping one previous file, gitignored). The backend writes its own timings and failures; the page posts what it sees to `/api/chymod/voice/log`, including device error codes, recording statistics and conversation timings. Read that file when diagnosing a past failure instead of asking for the run to be repeated. It holds transcripts and answers, so it stays on the machine running the dev server.

For device deployment, flash host firmware first only when the generic USB bridge changes. Wait for the ESP32-S3 port to return, then install `capsule_face.xsa` into the discovered `xs` MOD partition. Ordinary face or state-machine changes should use the MOD-only deployment path.

When a required local development port is occupied and the project service needs to restart, identify the owning process from the exact port and verify that it belongs to this project, then stop the old service before starting its replacement. Do not terminate unrelated processes or use broad process cleanup.

## Hardware Configuration

Configuration is managed through preferences system with these key areas:
- `driver`: Servo motor configuration (type: scservo, dynamixel, pwm, rs30x, none)
- `tts`: Text-to-speech engine selection
- `ui`: Piu UI and face selection
- `wifi`: Network configuration

## CoreS3 Speaker Amplifier Contract

On `m5stackchan_cores3`, the AW88298 speaker amplifier is powered down whenever nothing is playing. The microphone and speaker share I2S clocks, so while the always-on wake word records, an idle amplifier left powered makes the speaker hiss; lowering its volume does not help, powering it down does. The control lives in `firmware/host/platforms/m5stackchan_cores3/speaker-amp.js` and `speaker-amp.c`, and the board setup installs it as `globalThis.stackchanSpeakerAmp` with reference-counted `acquire()` and `release()`.

- Every playback path must hold the amplifier while audio plays: call `acquire()` before constructing `AudioOut` (at the latest immediately before `AudioOut.start()`) and `release()` after `stop()` or `close()`. A path that skips this is silent on this board. On boards without the control the hold is a no-op.
- The hold also coordinates the shared I2S port: `subscribe()` listeners hear `true` on the first hold and `false` after the last release, and the wake word (`micro-wake-word.js`) closes its `AudioIn` while playback is active. Recording while the speaker plays stretched a 14.6 s USB reply to 29.5 s of stuttering audio. Acquiring before constructing `AudioOut` keeps its clock configuration from racing the wake word's input.
- Already covered: tone and WAV playback in `firmware/host/modules/audio/speaker.ts`; `tts-playback-lifecycle.ts`, which covers every TTS engine that plays through `lifecycle.openAudio` and `lifecycle.onReady` (local, remote, VoiceVox, VoiceVox web, ElevenLabs, OpenAI); `stackchan-voice/tts-stackchan-voice.ts`; WebRadio in `platforms/m5stackchan-cores3/web-radio-audio-out.ts`; and USB speaker audio in `firmware/host/modules/usb-audio/worker-bridge.ts`. Any new code that constructs `AudioOut` directly must add the hold.
- The default `stackchan-voice` TTS speaks Japanese only (`stackchan-ja.aqd`). English speech needs another engine, such as ElevenLabs, OpenAI, or a remote or local TTS; those already hold the amplifier through the playback lifecycle.
- Do not open I2C address `0x36` from JavaScript. Moddable's CoreS3 setup already owns that ECMA-419 handle, and a second one fails with `duplicate address`. Use the native functions in `speaker-amp.c`, which attach to the existing ESP-IDF I2C bus.
- Do not rely on remapping `pins/audioout` or `embedded:io/audio/out` in the platform manifest to wrap playback: Moddable's own mappings take precedence and the override is silently ignored. Confirm what a module specifier compiles from in `firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host/makefile`.
- Verify amplifier changes on the device, not only by build success: the boot trace must show `[m5stackchan] speaker amplifier powered down until playback`, and SYSCTRL (register `0x04`) must read `0x4003` while idle and `0x4040` while audio plays.

## CoreS3 Microphone Capture Contract

Moddable's ESP32 `AudioIn` (`embedded:io/audio/in`) runs its callbacks on the main XS machine and buffers only 16 KB natively, about 256 ms at 16 kHz stereo. When the main machine is busy, for example while a face animation such as the ChyMOD `working` effect renders, the buffer overflows and speech disappears silently: sequence numbers stay continuous and no error is raised. A USB recording made during that animation delivered about 8.5% of the audio.

- Continuous captures that must not lose audio use native capture: `firmware/host/modules/usb-audio/microphone-capture.c`, exposed as `stackchan-usb-microphone-capture`. It reads I2S on its own task into a 3 second PSRAM ring. The main machine opens and closes it, and the reader, currently the USB worker, drains it directly.
- The microphone, the wake word's `AudioIn`, and `AudioOut` all use I2S port 1 and share clocks. Claim `audio-input-lock` before opening native capture or `AudioIn`, and never capture while speaker output is active.
- Do not add new continuous recording through `AudioIn` on the main machine. Short recordings such as the drawer's Record and play are acceptable, but they can still lose a word under load.
- Verify capture changes with the ChyMOD page's Microphone diagnostics while an animation plays: `Audio received` should match the time between the first frame and `MIC_STOP sent`.

## Git Hooks

Uses lefthook for pre-commit hooks:
- Automatically runs linting and formatting on staged files
- Install: `npm run install-hook`
- Uninstall: `npm run uninstall-hook`

## Testing Approach

Moddable test modules live under the target implementation with `manifest.test.json`; substantial tests get their own manifest for isolated execution.
Cheap constructor smokes are consolidated into shared manifests (`firmware/host/modules/__tests__/module-smoke`, `firmware/mods/examples/provider-dialogues/__tests__/dialogue-smoke`) because each manifest pays a full mcconfig build.
Node.js unit tests live next to pure helper implementations and run through `npm run test:unit`.
Prefer XS-driven Moddable tests for behavior that touches the platform (Piu, Timer, drivers); keep Node.js tests for pure logic.
Tests must verify observable behavior or relational invariants.

Do not:

- Read production source as text merely to assert exact constants, configuration values, code fragments, or regular-expression matches.
- Add tests that fail on a legitimate implementation-literal change without detecting a behavioral or architectural regression.

It is valid to:

- Parse generated artifacts or manifests and validate their schema.
- Compare independently maintained files or dynamically discovered entries.
- Verify dependency boundaries, completeness, tombstones, and relational invariants.
- Read source when its structure is itself the maintained contract.

If a constraint cannot be tested through behavior or a relational invariant, document the reason next to the source or configuration instead of adding a source-mirroring test.

## Pull Request Review Guidance

When reviewing a pull request:

- Confirm the PR description classifies release impact as `none`, `patch`, `minor`, or `major`
- Check whether user-visible firmware or web changes need a release note or changeset entry
- If no release note or changeset is needed, make sure the review states why
- For docs, CI, repository metadata, case, and schematics changes, verify release impact before requesting a release note or changeset
- Ask for tested targets, hardware-specific behavior, and reproduction or verification details when they affect release risk
