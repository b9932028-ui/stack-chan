// jsdom's File omits the Blob read methods that browsers implement, so these tests
// use the spec-compliant File from Node instead.
import { File } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type FirmwareBoard } from '@/features/firmware-install/boards'
import { createLocalFirmwareBoard, inspectLocalFirmwareFiles } from '@/features/firmware-install/local-firmware'
import { installFirmware } from '@/services/firmware-install/firmware-install-service'

const board: FirmwareBoard = {
  id: 'cores3',
  label: 'CoreS3',
  manifestUrl: 'https://example.test/manifest.json',
}

const boardManifest = {
  name: 'Stack-chan',
  version: '1.1.0',
  builds: [
    {
      chipFamily: 'ESP32-S3',
      parts: [
        { path: 'tech.moddable.stackchan/cores3/bootloader.bin', offset: 0 },
        { path: 'tech.moddable.stackchan/cores3/partition-table.bin', offset: 32768 },
        { path: 'tech.moddable.stackchan/cores3/xs_esp32.bin', offset: 65536 },
      ],
    },
  ],
}

const file = (name: string, bytes: number[]) => new File([Uint8Array.from(bytes)], name) as unknown as globalThis.File

const stubManifestFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(boardManifest), { status: 200 }))
  )

describe('local firmware selection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('recognizes firmware binaries in flash order and reports the rest', () => {
    const selection = inspectLocalFirmwareFiles([
      file('notes.txt', [0]),
      file('xs_esp32.bin', [3]),
      file('bootloader.bin', [1]),
    ])

    expect(selection.recognized.map((entry) => entry.name)).toEqual(['bootloader.bin', 'xs_esp32.bin'])
    expect(selection.missing).toEqual(['partition-table.bin'])
    expect(selection.ignored.map((entry) => entry.name)).toEqual(['notes.txt'])
    expect(selection.installable).toBe(true)
    expect(selection.hasManifest).toBe(false)
  })

  it('refuses a selection without the application image or a manifest', () => {
    expect(inspectLocalFirmwareFiles([file('bootloader.bin', [1])]).installable).toBe(false)
    expect(inspectLocalFirmwareFiles([file('manifest.json', [1])]).installable).toBe(true)
  })

  it('keeps board offsets and narrows the write to the selected binaries', async () => {
    stubManifestFetch()
    const local = createLocalFirmwareBoard(board, [file('xs_esp32.bin', [7, 8, 9])])

    const manifest = (await local.source?.readManifest()) as typeof boardManifest
    expect(manifest.builds[0].parts).toEqual([{ path: 'tech.moddable.stackchan/cores3/xs_esp32.bin', offset: 65536 }])
    expect(manifest.version).toBe('1.1.0 (ローカル)')

    const bytes = await local.source?.readPart(manifest.builds[0].parts[0])
    expect(Array.from(bytes ?? [])).toEqual([7, 8, 9])
  })

  it('matches manifest parts to selected files by name, ignoring the bundled directories', async () => {
    stubManifestFetch()
    const local = createLocalFirmwareBoard(board, [
      file('bootloader.bin', [1]),
      file('partition-table.bin', [2]),
      file('xs_esp32.bin', [3]),
    ])

    const manifest = (await local.source?.readManifest()) as typeof boardManifest
    expect(manifest.builds[0].parts).toHaveLength(3)
    const written = await Promise.all(
      manifest.builds[0].parts.map(async (part) => Array.from((await local.source?.readPart(part)) ?? []))
    )
    expect(written).toEqual([[1], [2], [3]])
  })

  it('prefers a selected manifest over the board manifest', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const ownManifest = {
      name: 'Local build',
      version: '0.0.1-dev',
      builds: [{ chipFamily: 'ESP32', parts: [{ path: './xs_esp32.bin', offset: 4096 }] }],
    }
    const local = createLocalFirmwareBoard(board, [
      new File([JSON.stringify(ownManifest)], 'manifest.json') as unknown as globalThis.File,
      file('xs_esp32.bin', [5]),
    ])

    expect(await local.source?.readManifest()).toEqual(ownManifest)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes only local bytes and never fetches a bundled binary', async () => {
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        requested.push(url)
        if (url.endsWith('manifest.json')) return new Response(JSON.stringify(boardManifest), { status: 200 })
        // A bundled binary reaching the network would mean the local selection was bypassed.
        return new Response(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), { status: 200 })
      })
    )
    const written: { address: number; bytes: Uint8Array }[] = []
    const adapterFactory = vi.fn(async () => ({
      inspect: async () => 'ESP32-S3',
      write: vi.fn(async (files: typeof written) => void written.push(...files)),
      resetToRunApp: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    }))

    const local = createLocalFirmwareBoard(board, [file('xs_esp32.bin', [7, 8, 9]), file('bootloader.bin', [1, 2])])
    const result = await installFirmware(
      {} as never,
      local,
      { onLog: () => {}, onStage: () => {}, onProgress: () => {}, onConfirm: async () => true },
      adapterFactory as never
    )

    expect(requested).toEqual(['https://example.test/manifest.json'])
    expect(requested.some((url) => url.endsWith('.bin'))).toBe(false)
    expect(written).toEqual([
      { address: 0, bytes: Uint8Array.from([1, 2]) },
      { address: 65536, bytes: Uint8Array.from([7, 8, 9]) },
    ])
    // partition-table.bin was not selected, so it is absent rather than taken from the bundle.
    expect(result?.bytesWritten).toBe(5)
  })

  it('reports a part with no matching file instead of writing nothing', async () => {
    stubManifestFetch()
    const local = createLocalFirmwareBoard(board, [file('xs_esp32.bin', [1])])
    await expect(local.source?.readPart({ path: 'somewhere/bootloader.bin', offset: 0 })).rejects.toThrow(
      'に対応するファイルが選択されていません'
    )
  })
})
