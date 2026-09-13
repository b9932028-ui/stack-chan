/** One write target named by a manifest: a binary and the flash offset it belongs at. */
export type FirmwarePartRef = { path: string; offset: number }

/**
 * Supplies the manifest and the binaries from somewhere other than `manifestUrl`,
 * so a locally built firmware can be written without being published to this site.
 */
export type FirmwareSource = {
  readManifest: () => Promise<unknown>
  readPart: (part: FirmwarePartRef) => Promise<Uint8Array>
}

export type FirmwareBoard = {
  id: string
  label: string
  manifestUrl: string
  /** When set, the manifest and binaries come from here instead of `manifestUrl`. */
  source?: FirmwareSource
}

export const FIRMWARE_BOARDS: readonly FirmwareBoard[] = [
  {
    id: 'esp32_m5stack',
    label: 'M5Stack',
    manifestUrl: new URL('./manifest_esp32_m5stack.json', document.baseURI).href,
  },
  {
    id: 'esp32_m5stack_core2',
    label: 'M5Stack Core2',
    manifestUrl: new URL('./manifest_esp32_m5stack_core2.json', document.baseURI).href,
  },
  {
    id: 'esp32_m5stack_cores3',
    label: 'M5Stack CoreS3',
    manifestUrl: new URL('./manifest_esp32_m5stack_cores3.json', document.baseURI).href,
  },
  {
    id: 'esp32_m5stackchan_cores3',
    label: 'M5StackChan CoreS3',
    manifestUrl: new URL('./manifest_esp32_m5stackchan_cores3.json', document.baseURI).href,
  },
]
