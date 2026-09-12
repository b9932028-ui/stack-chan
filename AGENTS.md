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

Keep the animation state machine inside the MOD so it operates identically with no USB connection. It starts in `idle`; while idle and random playback is enabled, every three seconds it randomly selects one of `idle`, `blink`, `lookAround`, `happy`, or `angry`. A non-idle animation returns to `idle` when complete and restarts the three-second countdown. A manual animation request interrupts immediately, then follows the same return-to-idle behavior.

USB is an optional control and observation path, not the animation scheduler. Keep host-firmware changes generic: MODs register namespaced commands through the USB control registry, and ChyMOD owns only the `chymod.*` namespace. The current protocol is:

- `chymod.describe`: return the versioned, schema-driven control descriptor
- `chymod.play`: immediately play one named animation
- `chymod.status`: return the current animation, elapsed time, duration, random setting, and next decision time
- `chymod.random`: enable or disable autonomous random playback

Add future ChyMOD controls through the descriptor and namespaced request/response protocol instead of adding feature-specific switches to the default firmware USB server. Preserve the existing `stackchan-usb-v1` handshake and request IDs so multiple controls can share the serial connection safely.

The web page must render controls from `chymod.describe`, display live state from `chymod.status`, and remain usable when capabilities are unavailable by showing a clear disconnected or unsupported state. For backend/web UI updates, add and maintain English copy only. Do not update Japanese or Simplified Chinese translations unless the user explicitly requests them.

For device deployment, flash host firmware first only when the generic USB bridge changes. Wait for the ESP32-S3 port to return, then install `capsule_face.xsa` into the discovered `xs` MOD partition. Ordinary face or state-machine changes should use the MOD-only deployment path.

## Hardware Configuration

Configuration is managed through preferences system with these key areas:
- `driver`: Servo motor configuration (type: scservo, dynamixel, pwm, rs30x, none)
- `tts`: Text-to-speech engine selection
- `ui`: Piu UI and face selection
- `wifi`: Network configuration

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
