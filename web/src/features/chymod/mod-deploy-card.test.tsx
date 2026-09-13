import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installModToDevice } from '../../../editor/esptool-installer.mjs'
import { ModDeployCard } from '@/features/chymod/mod-deploy-card'

vi.mock('../../../editor/esptool-installer.mjs', () => ({
  createEsptoolLoader: vi.fn(),
  DEVICE_OPERATION_STATUS: { CANCELLED: 'cancelled', INSTALLED: 'installed' },
  installModToDevice: vi.fn(),
}))

describe('ModDeployCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('selects an XSA and port, releases USB control, and installs the MOD', async () => {
    const port = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) }
    const requestPort = vi.fn(async () => port)
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(installModToDevice).mockImplementation(async (_loader, selectedPort, bytes, options) => {
      const partition = { type: 0x40, subtype: 1, offset: 0xfa0000, size: 0x40000, label: 'xs' }
      const firmware = {
        projectName: 'xs_esp32',
        version: '9.0.0+stackchan.1',
        moddableVersion: '9.0.0',
        hostApiVersion: 1,
      }
      expect(selectedPort).toBe(port)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(
        await options?.onPreflight?.({
          chip: 'ESP32-S3',
          partition,
          appPartition: { type: 0, subtype: 0, offset: 0x10000, size: 0xf90000, label: 'factory' },
          firmware,
          archiveSize: 3,
        })
      ).toBe(true)
      options?.onProgress?.(1)
      return { status: 'installed', chip: 'ESP32-S3', partition, firmware, verified: true }
    })
    const disconnectControl = vi.fn(async () => {})

    render(<ModDeployCard controlConnected disconnectControl={disconnectControl} />)
    const file = new File([new Uint8Array([1, 2, 3])], 'capsule_face.xsa', {
      type: 'application/octet-stream',
    })
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    })
    fireEvent.change(screen.getByLabelText('XSA archive'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Select port' }))

    await screen.findByText('USB 303A:1001')
    fireEvent.click(screen.getByRole('button', { name: 'Deploy MOD' }))

    await waitFor(() => expect(disconnectControl).toHaveBeenCalledOnce())
    await screen.findByText('MOD installed and verified on ESP32-S3.')
    expect(requestPort).toHaveBeenCalledOnce()
    expect(installModToDevice).toHaveBeenCalledOnce()
  })
})
