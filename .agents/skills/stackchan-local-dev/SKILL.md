---
name: stackchan-local-dev
description: Build, deploy, or run the Stack-chan web tools and CoreS3 firmware in this repository after its move to E:\\MicroChan.
---

# Stack-chan local development

Use this skill only for the local web tools or firmware in this repository.

## Web tools

Work in `E:\MicroChan\stack-chan\web`.

- Start the local backend/UI with `npm run dev`.
- Validate a production build with `npm run build`.
- Use Chrome or Edge for the Web Serial control page; connect to the device from the page rather than opening the serial port from another process at the same time.

## CoreS3 firmware

Work in `E:\MicroChan\stack-chan\firmware`. The standard target is M5StackChan CoreS3.

The Moddable and ESP-IDF environment is not globally configured. Use the maintained helper scripts, which load Visual Studio, Moddable, ESP-IDF, and keep Windows' `rmdir` ahead of GNU coreutils:

- Build: `cmd /c E:\MicroChan\output\build-firmware.cmd`
- Deploy the release build to COM7: `cmd /c E:\MicroChan\output\deploy-firmware-com7.cmd`
- Build a MOD: `cmd /d /c E:\MicroChan\output\build-mod.cmd mods/<mod-name>/manifest.json`
- Deploy a MOD to a confirmed COM7 device: `cmd /d /c E:\MicroChan\output\deploy-mod-com7.cmd mods/<mod-name>/manifest.json`

A bare PowerShell may report `mcrun`/`mcconfig` missing or fail to find `nmake` even when the SDK is installed. Use these helpers before concluding that setup is missing; they load Visual Studio, Moddable, and the required ESP-IDF environment from the existing local installation.

For another serial port, start from `E:\MicroChan\output\build-firmware.cmd` and run `npm run deploy -- --port COM<n> --mode=release` after its environment setup. Do not invoke `mcconfig` directly or supply `-o`; repository scripts keep artifacts under `firmware/dist`.

Before deployment, ensure the selected COM port is the intended device. A deploy writes flash and resets that device. Confirm success from the final `Hash of data verified`, `Hard resetting via RTS pin`, and `Done` lines.

## CoreS3 power-control check

The USB live controls use the same COM port as the backend. Close any CLI serial reader before opening the web page.

`shutdown` is a real PMIC shutdown and intentionally disconnects USB. The device must be turned back on with its physical power button. Firmware includes `powerStatus` for diagnostics; use `E:\MicroChan\output\diagnose-power.py` when checking reset or PMIC status.
