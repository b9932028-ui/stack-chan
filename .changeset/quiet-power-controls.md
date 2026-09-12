---
"stack-chan": minor
"stackchan-web": minor
---

Add USB restart and CoreS3 shutdown commands with confirmation buttons in USB live controls.

Use the AXP2101 shutdown command directly to avoid the SDK powerOff routine triggering a SoC reset. Add a read-only USB powerStatus diagnostic reporting ESP32 reset reason and PMIC status registers.
