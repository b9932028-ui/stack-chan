import { type FirmwareBoard, type FirmwarePartRef } from '@/features/firmware-install/boards'
import { AppError } from '@/lib/errors/app-error'

/**
 * The binaries an ESP32 firmware write is made of, in flash order. A build writes
 * all three; a rebuild of the application alone only replaces `xs_esp32.bin`.
 */
export const LOCAL_FIRMWARE_BINARIES = ['bootloader.bin', 'partition-table.bin', 'xs_esp32.bin'] as const

/** Selecting this alongside the binaries overrides the board manifest entirely. */
export const LOCAL_MANIFEST_NAME = 'manifest.json'

/** Flash offsets come from the board manifest, so the application image is the one file we require. */
const REQUIRED_BINARY = 'xs_esp32.bin'

const fileKey = (value: string) => value.split(/[\\/]/).pop()?.toLowerCase() ?? ''

const indexByName = (files: readonly File[]) => {
  const index = new Map<string, File>()
  // A later pick of the same name wins, matching how the file dialog presents a re-selection.
  for (const file of files) index.set(fileKey(file.name), file)
  return index
}

export type LocalFirmwareSelection = {
  /** Selected files that map onto a firmware binary, in flash order. */
  recognized: File[]
  /** Known binaries this selection does not cover. */
  missing: string[]
  /** Selected files that take no part in the write. */
  ignored: File[]
  /** True when the selection carries its own `manifest.json`. */
  hasManifest: boolean
  /** True when there is enough to attempt a write. */
  installable: boolean
}

/**
 * Describes what a set of locally picked files would write, so the form can report
 * the outcome before anything touches the device.
 */
export function inspectLocalFirmwareFiles(files: readonly File[]): LocalFirmwareSelection {
  const index = indexByName(files)
  const recognized = LOCAL_FIRMWARE_BINARIES.filter((name) => index.has(name)).map((name) => index.get(name) as File)
  const hasManifest = index.has(LOCAL_MANIFEST_NAME)
  const claimed = new Set<string>([...LOCAL_FIRMWARE_BINARIES, LOCAL_MANIFEST_NAME])
  return {
    recognized,
    missing: LOCAL_FIRMWARE_BINARIES.filter((name) => !index.has(name)),
    ignored: files.filter((file) => !claimed.has(fileKey(file.name))),
    hasManifest,
    // Its own manifest names its own parts, so the application image is not required then.
    installable: hasManifest || index.has(REQUIRED_BINARY),
  }
}

type UnknownManifest = { name?: unknown; version?: unknown; builds?: unknown }
type UnknownBuild = { chipFamily?: unknown; parts?: unknown }

/**
 * Narrows a board manifest to the parts the selection actually provides, so picking
 * only a rebuilt application image writes that partition and leaves the rest alone.
 */
const restrictToSelectedParts = (manifest: unknown, index: Map<string, File>) => {
  if (!manifest || typeof manifest !== 'object') return manifest
  const { builds, ...rest } = manifest as UnknownManifest
  if (!Array.isArray(builds)) return manifest
  return {
    ...rest,
    version: `${String((manifest as UnknownManifest).version ?? '')} (ローカル)`.trim(),
    builds: builds.map((build: UnknownBuild) => {
      if (!build || typeof build !== 'object' || !Array.isArray(build.parts)) return build
      return {
        ...build,
        parts: (build.parts as FirmwarePartRef[]).filter((part) => index.has(fileKey(String(part?.path ?? '')))),
      }
    }),
  }
}

/**
 * Wraps a board so the write pulls its binaries from locally selected files. Flash
 * offsets and the chip family still come from the board manifest unless the selection
 * supplies its own `manifest.json`.
 */
export function createLocalFirmwareBoard(base: FirmwareBoard, files: readonly File[]): FirmwareBoard {
  const index = indexByName(files)
  return {
    ...base,
    source: {
      readManifest: async () => {
        const manifestFile = index.get(LOCAL_MANIFEST_NAME)
        if (manifestFile) {
          try {
            return JSON.parse(await manifestFile.text())
          } catch (cause) {
            throw new AppError('manifest-invalid', '選択したmanifest.jsonを解析できませんでした', { cause })
          }
        }
        const response = await fetch(base.manifestUrl)
        if (!response.ok) {
          throw new AppError('manifest-fetch', `manifestを取得できませんでした (HTTP ${response.status})`)
        }
        return restrictToSelectedParts(await response.json(), index)
      },
      readPart: async (part) => {
        const file = index.get(fileKey(part.path))
        if (!file) {
          throw new AppError('firmware-file-missing', `${part.path}に対応するファイルが選択されていません`)
        }
        return new Uint8Array(await file.arrayBuffer())
      },
    },
  }
}
