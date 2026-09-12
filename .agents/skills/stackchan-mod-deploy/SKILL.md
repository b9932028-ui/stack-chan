---
name: stackchan-mod-deploy
description: Create, build, and deploy Stack-chan firmware MODs in this repository. Use when adding or changing firmware/mods projects, producing an XSA archive, or installing a MOD to a connected Stack-chan without reflashing the host firmware. Do not use for simulator-only work or full host firmware flashing.
---

# Stack-chan MOD workflow

Work from `firmware/` and follow the repository `AGENTS.md`. Preserve unrelated working-tree changes and never edit generated files under `dist/`.

## Create or change a MOD

1. Put the MOD in `mods/<mod-name>/`.
2. Add `manifest.json` with the normal MOD includes and module entry:

   ```json
   {
     "include": [
       "$(MODDABLE)/examples/manifest_mod.json",
       "$(MODDABLE)/examples/manifest_typings.json"
     ],
     "modules": { "*": ["./mod"] }
   }
   ```

3. Implement `mod.js` or `mod.ts` and export `onContextCreated(context)`. Prefer the public capability APIs documented in `docs/api.md`; do not import host-internal modules.
4. Keep MOD-specific assets and manifest entries in the same MOD directory. Use an existing MOD under `mods/examples/` as the closest pattern.

## Check and build

1. Run `npm run doctor` when the toolchain has not yet been confirmed. The Moddable SDK, `MODDABLE`, the platform compiler, and npm dependencies must be available; install only what the check shows is missing.
2. Run the relevant focused test or lint check for changed code.
3. Build without touching the device:

   ```console
   npm run mod:build -- mods/<mod-name>/manifest.json --mode=release
   ```

4. Confirm the archive exists at `dist/bin/esp32/release/<mod-name>/<mod-name>.xsa`.

## Deploy

Deploy only after the user has explicitly authorized writing to the device.

1. Run `npm run scan` and identify the intended ESP32-S3 serial port. If multiple ports exist, do not guess.
2. Install through the verified CLI path:

   ```console
   npm run mod -- mods/<mod-name>/manifest.json --port <COM-port> --mode=release
   ```

   This builds the XSA, discovers the live type `0x40`, subtype `1` `xs` partition, validates compatibility and capacity, writes only that partition, verifies the bytes, and resets the device. It must not erase flash or reflash the host firmware.

3. For a MOD created in the browser editor, use Chrome or Edge and its Web Serial install action; the editor builds the archive before writing it. Use the CLI path above for a repository-built XSA. In either path, select the confirmed device and write only the detected `xs` partition.
4. Treat deployment as successful only when preflight identifies the expected Stack-chan host and the result reports both successful verification and MOD installation. Stop on a chip, firmware-version, capacity, port, or digest mismatch.

Report the MOD source path, generated XSA path, selected port or Web Serial path, and verification result.
