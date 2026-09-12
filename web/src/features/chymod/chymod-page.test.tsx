import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import { ChyModPage } from '@/features/chymod/chymod-page'
import { useUSBControl } from '@/features/chymod/use-usb-control'

vi.mock('@/features/chymod/use-usb-control', () => ({
  useUSBControl: vi.fn(),
}))

describe('ChyModPage', () => {
  it('renders controls described by the MOD and sends namespaced commands', async () => {
    const request = vi.fn(async (command: string) => {
      if (command === 'chymod.describe') {
        return {
          version: 1,
          controls: [
            {
              id: 'animation',
              kind: 'actions',
              command: 'chymod.play',
              options: ['idle', 'blink', 'lookAround', 'happy', 'angry'],
            },
            { id: 'randomEnabled', kind: 'toggle', command: 'chymod.random' },
          ],
        }
      }
      return {
        version: 1,
        state: command === 'chymod.play' ? 'happy' : 'idle',
        randomEnabled: true,
        elapsedMs: 0,
        durationMs: null,
        nextRandomInMs: 3000,
      }
    })
    vi.mocked(useUSBControl).mockReturnValue({
      connection: 'connected',
      connected: true,
      capabilities: new Set(['chymod.describe', 'chymod.play', 'chymod.status', 'chymod.random']),
      error: null,
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      request,
    })

    render(
      <I18nProvider>
        <ChyModPage />
      </I18nProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'うれしい' }))
    expect(request).toHaveBeenCalledWith('chymod.play', 'happy')
    expect(screen.getByRole('checkbox', { name: '3秒ごとのランダム再生を有効にする' })).toBeChecked()
  })
})
