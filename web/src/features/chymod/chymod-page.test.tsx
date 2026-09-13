import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
              options: ['idle', 'blink', 'lookAround', 'happy', 'angry', 'working'],
            },
            {
              id: 'randomEnabled',
              kind: 'toggle',
              command: 'chymod.random',
              statusKey: 'randomEnabled',
              label: 'Enable random animation every 3 seconds',
            },
            {
              id: 'wakeEnabled',
              kind: 'toggle',
              command: 'chymod.wake',
              statusKey: 'wakeEnabled',
              label: 'Enable “Okay Nabu” wake animation',
            },
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
        wakeEnabled: command === 'chymod.wake',
        wakeError: null,
        wakeHitCount: 0,
        lastWakePhrase: null,
      }
    })
    vi.mocked(useUSBControl).mockReturnValue({
      connection: 'connected',
      connected: true,
      capabilities: new Set(['chymod.describe', 'chymod.play', 'chymod.status', 'chymod.random', 'chymod.wake']),
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
    const workingButton = screen.getByRole('button', { name: '作業中' })
    await waitFor(() => expect(workingButton).toBeEnabled())
    fireEvent.click(workingButton)
    await waitFor(() => expect(request).toHaveBeenCalledWith('chymod.play', 'working'))

    // Control wording is the page's, not the firmware's fixed English.
    expect(screen.getByRole('checkbox', { name: '3秒ごとのランダム再生を有効にする' })).toBeChecked()
    const wakeToggle = screen.getByRole('checkbox', { name: 'Enable “Okay Nabu” wake animation' })
    fireEvent.click(wakeToggle)
    await waitFor(() => expect(request).toHaveBeenCalledWith('chymod.wake', true))
  })

  it('labels a toggle the page does not know from the descriptor', async () => {
    const request = vi.fn(async (command: string) => {
      if (command === 'chymod.describe') {
        return {
          version: 1,
          controls: [{ id: 'futureFlag', kind: 'toggle', command: 'chymod.future', label: 'Some future toggle' }],
        }
      }
      return { version: 1, state: 'idle', randomEnabled: true, elapsedMs: 0, durationMs: null, nextRandomInMs: 3000 }
    })
    vi.mocked(useUSBControl).mockReturnValue({
      connection: 'connected',
      connected: true,
      capabilities: new Set(['chymod.describe', 'chymod.status', 'chymod.future']),
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

    expect(await screen.findByRole('checkbox', { name: 'Some future toggle' })).toBeInTheDocument()
  })
})
