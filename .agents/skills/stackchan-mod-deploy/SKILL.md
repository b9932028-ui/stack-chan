---
name: stackchan-mod-deploy
description: Create, build, and deploy Stack-chan firmware MODs in this repository. Use when adding or changing firmware/mods projects, producing an XSA archive, or installing a MOD to a connected Stack-chan without reflashing the host firmware. Do not use for simulator-only work or full host firmware flashing.
---

# Stack-chan MOD workflow

Work from `firmware/` and follow the repository `AGENTS.md`. Preserve unrelated working-tree changes and never edit generated files under `dist/`.

## Windows toolchain environment

The Moddable and ESP-IDF tools are installed locally but are not globally configured. A bare Codex PowerShell can therefore report `spawnSync mcrun ENOENT`, `spawn mcconfig ENOENT`, or `Cannot execute nmake!` even though the toolchain is present. Do not run `npm run setup` based only on those errors.

Prefer the maintained helpers, which load the existing Visual Studio and Moddable environment:

- Build any MOD: `cmd /d /c E:\MicroChan\output\build-mod.cmd mods/<mod-name>/manifest.json`
- Build `capsule_face`: `cmd /d /c E:\MicroChan\output\build-mod.cmd`
- Deploy a MOD to the confirmed COM7 device: `cmd /d /c E:\MicroChan\output\deploy-mod-com7.cmd mods/<mod-name>/manifest.json`

The build helper initializes Visual Studio with `vcvars32.bat`, sets `MODDABLE=C:\Users\b9932\xs-dev\moddable`, and puts the Moddable release tools on `PATH`. Firmware and deployment helpers additionally use `IDF_TOOLS_PATH=C:\Users\b9932\.espressif` and the ESP-IDF environment under `C:\Users\b9932\xs-dev\esp32\esp-idf`.

When diagnosing a helper failure, verify those existing paths and that `mcrun` and `nmake` resolve after initialization before considering reinstallation. Run raw `npm run mod:build` or `npm run mod` only from an already initialized Moddable/Visual Studio shell.

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

1. Use the Windows helper above to confirm the existing toolchain. Treat `npm run doctor` from an ordinary PowerShell as incomplete evidence because that shell does not inherit the local SDK environment.
2. Run the relevant focused test or lint check for changed code.
3. Build without touching the device:

   ```console
   cmd /d /c E:\MicroChan\output\build-mod.cmd mods/<mod-name>/manifest.json
   ```

4. Confirm the archive exists at `dist/bin/esp32/release/<mod-name>/<mod-name>.xsa`.

## Deploy

Deploy only after the user has explicitly authorized writing to the device.

1. Run `npm run scan` and identify the intended ESP32-S3 serial port. If multiple ports exist, do not guess.
2. For a confirmed COM7 device, install through the maintained helper:

   ```console
   cmd /d /c E:\MicroChan\output\deploy-mod-com7.cmd mods/<mod-name>/manifest.json
   ```

   For another confirmed port, use an initialized Moddable/Visual Studio shell and run:

   ```console
   npm run mod -- mods/<mod-name>/manifest.json --port <COM-port> --mode=release
   ```

   This builds the XSA, discovers the live type `0x40`, subtype `1` `xs` partition, validates compatibility and capacity, writes only that partition, verifies the bytes, and resets the device. It must not erase flash or reflash the host firmware.

3. For a MOD created in the browser editor, use Chrome or Edge and its Web Serial install action; the editor builds the archive before writing it. Use the CLI path above for a repository-built XSA. In either path, select the confirmed device and write only the detected `xs` partition.
4. Treat deployment as successful only when preflight identifies the expected Stack-chan host and the result reports both successful verification and MOD installation. Stop on a chip, firmware-version, capacity, port, or digest mismatch.

Report the MOD source path, generated XSA path, selected port or Web Serial path, and verification result.
