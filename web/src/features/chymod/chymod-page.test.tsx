import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import { ChyModPage } from '@/features/chymod/chymod-page'
import { useCodexVoice } from '@/features/chymod/use-codex-voice'

vi.mock('@/features/chymod/use-codex-voice', () => ({
  useCodexVoice: vi.fn(),
}))

const voiceMock = (requestControl: (command: string, value?: unknown) => Promise<unknown>, capabilities: string[]) => ({
  connection: 'ready' as const,
  phase: 'idle' as const,
  controlCapabilities: new Set(capabilities),
  featureEnabled: true,
  commandsEnabled: true,
  recordingUrl: null,
  recordingStats: null,
  transcript: '',
  answer: '',
  error: null,
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  stopRecording: vi.fn(),
  requestControl,
  setFeatureEnabled: vi.fn(),
  setCommandsEnabled: vi.fn(),
  clear: vi.fn(),
})

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
              label: 'Enable “Hey Copilot” wake animation',
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
    vi.mocked(useCodexVoice).mockReturnValue(
      voiceMock(request, ['chymod.describe', 'chymod.play', 'chymod.status', 'chymod.random', 'chymod.wake'])
    )

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
    const wakeToggle = screen.getByRole('checkbox', { name: 'Enable “Hey Copilot” wake animation' })
    fireEvent.click(wakeToggle)
    await waitFor(() => expect(request).toHaveBeenCalledWith('chymod.wake', true))
  })

  it('renders every animation reported by the MOD without a frontend allowlist', async () => {
    const request = vi.fn(async (command: string) => {
      if (command === 'chymod.describe') {
        return {
          version: 1,
          controls: [
            {
              id: 'animation',
              kind: 'actions',
              command: 'chymod.play',
              options: ['idle', 'surprised', 'dance-v2'],
            },
          ],
        }
      }
      return {
        version: 1,
        state: 'idle',
        randomEnabled: false,
        elapsedMs: 0,
        durationMs: null,
        nextRandomInMs: null,
      }
    })
    vi.mocked(useCodexVoice).mockReturnValue(voiceMock(request, ['chymod.describe', 'chymod.play', 'chymod.status']))

    render(
      <I18nProvider>
        <ChyModPage />
      </I18nProvider>
    )

    expect(await screen.findByRole('button', { name: 'surprised' })).toBeInTheDocument()
    const danceButton = screen.getByRole('button', { name: 'dance-v2' })
    fireEvent.click(danceButton)
    await waitFor(() => expect(request).toHaveBeenCalledWith('chymod.play', 'dance-v2'))
  })

  it('renders Teams Status separately and sends presence plus a custom message', async () => {
    const request = vi.fn(async (command: string) => {
      if (command === 'chymod.describe') {
        return {
          version: 1,
          controls: [
            { id: 'animation', kind: 'actions', command: 'chymod.play', options: ['idle'] },
            {
              id: 'teamsStatus',
              kind: 'teams-status',
              command: 'chymod.teams-status',
              statusKey: 'teamsStatus',
              presences: ['available', 'busy', 'away'],
              maxLength: 12,
            },
          ],
        }
      }
      return {
        version: 1,
        state: command === 'chymod.teams-status' ? 'teams' : 'idle',
        randomEnabled: false,
        elapsedMs: 0,
        durationMs: 6000,
        nextRandomInMs: null,
        teamsStatus: { presence: 'available', message: 'WFH' },
      }
    })
    vi.mocked(useCodexVoice).mockReturnValue(
      voiceMock(request, ['chymod.describe', 'chymod.play', 'chymod.status', 'chymod.teams-status'])
    )

    render(
      <I18nProvider>
        <ChyModPage />
      </I18nProvider>
    )

    expect(await screen.findByText('Teams Status')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Busy' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'IN A CALL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show Teams status' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('chymod.teams-status', { presence: 'busy', message: 'IN A CALL' })
    )
  })

  it('renders the ported motion panel and sends app-shaped controlMotion commands', async () => {
    const request = vi.fn(async (command: string) => {
      if (command === 'chymod.describe') {
        return {
          version: 1,
          controls: [
            {
              id: 'motion',
              kind: 'motion',
              command: 'chymod.motion',
              yaw: {
                angle: { min: -1280, max: 1280 },
                speed: { min: 0, max: 1000 },
                rotate: { min: -1000, max: 1000 },
              },
              pitch: { angle: { min: 0, max: 900 }, speed: { min: 0, max: 1000 } },
              defaultSpeed: 500,
            },
          ],
        }
      }
      return { version: 1, state: 'idle', randomEnabled: false, elapsedMs: 0, durationMs: null, nextRandomInMs: null }
    })
    vi.mocked(useCodexVoice).mockReturnValue(voiceMock(request, ['chymod.describe', 'chymod.status', 'chymod.motion']))

    render(
      <I18nProvider>
        <ChyModPage />
      </I18nProvider>
    )

    expect(await screen.findByRole('button', { name: '重設動作' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: '搖桿' })).toBeInTheDocument()

    // Slider moves are sent when the drag ends, like the app's onChangeEnd.
    const yawAngle = document.getElementById('chymod-motion-yaw-angle') as HTMLInputElement
    fireEvent.change(yawAngle, { target: { value: '300' } })
    expect(request).not.toHaveBeenCalledWith('chymod.motion', expect.anything())
    fireEvent.pointerUp(yawAngle)
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('chymod.motion', {
        yawServo: { angle: 300, speed: 500 },
        pitchServo: { angle: 0, speed: 500 },
      })
    )

    // Rotate zeroes the yaw angle, so the app's toJson sends rotate instead.
    const yawRotate = document.getElementById('chymod-motion-yaw-rotate') as HTMLInputElement
    fireEvent.change(yawRotate, { target: { value: '-400' } })
    fireEvent.pointerUp(yawRotate)
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('chymod.motion', {
        yawServo: { rotate: -400, speed: 500 },
        pitchServo: { angle: 0, speed: 500 },
      })
    )

    fireEvent.click(screen.getByRole('button', { name: '重設動作' }))
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith('chymod.motion', {
        yawServo: { angle: 0, speed: 500 },
        pitchServo: { angle: 0, speed: 500 },
      })
    )
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
    vi.mocked(useCodexVoice).mockReturnValue(voiceMock(request, ['chymod.describe', 'chymod.status', 'chymod.future']))

    render(
      <I18nProvider>
        <ChyModPage />
      </I18nProvider>
    )

    expect(await screen.findByRole('checkbox', { name: 'Some future toggle' })).toBeInTheDocument()
  })
})
