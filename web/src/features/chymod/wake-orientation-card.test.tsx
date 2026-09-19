import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import {
  readWakeOrientationDraft,
  WakeOrientationCard,
  type WakeOrientationDescriptor,
} from '@/features/chymod/wake-orientation-card'

const control: WakeOrientationDescriptor = {
  id: 'wakeOrientation',
  kind: 'orientation',
  command: 'chymod.wake-orientation',
  statusKey: 'wakeOrientation',
  label: 'Wake up orientation',
  yaw: { min: -1280, max: 1280 },
  pitch: { min: 0, max: 900 },
  speed: 500,
}

describe('readWakeOrientationDraft', () => {
  it('treats either field left blank as no turn on wake', () => {
    expect(readWakeOrientationDraft({ yaw: '', pitch: '' }, control)).toEqual({
      kind: 'clear',
    })
    expect(readWakeOrientationDraft({ yaw: '300', pitch: '  ' }, control)).toEqual({ kind: 'clear' })
    expect(readWakeOrientationDraft({ yaw: '', pitch: '450' }, control)).toEqual({ kind: 'clear' })
  })

  it('reports a value outside the servo range instead of clamping it', () => {
    expect(readWakeOrientationDraft({ yaw: '2000', pitch: '100' }, control)).toEqual({
      kind: 'invalid',
      message: 'Yaw must be between -1280 and 1280.',
    })
    expect(readWakeOrientationDraft({ yaw: '0', pitch: '-5' }, control)).toEqual({
      kind: 'invalid',
      message: 'Pitch must be between 0 and 900.',
    })
    expect(readWakeOrientationDraft({ yaw: 'left', pitch: '0' }, control)).toEqual({
      kind: 'invalid',
      message: 'Enter whole numbers.',
    })
  })

  it('rounds an accepted pose to whole tenths of a degree', () => {
    expect(readWakeOrientationDraft({ yaw: '-300.4', pitch: '450.6' }, control)).toEqual({
      kind: 'set',
      value: { yaw: -300, pitch: 451 },
    })
  })
})

describe('WakeOrientationCard', () => {
  const renderCard = (status: { yaw: number; pitch: number } | null, request = vi.fn(async () => ({}))) => {
    render(
      <I18nProvider>
        <WakeOrientationCard control={control} status={status} connected request={request} onError={() => undefined} />
      </I18nProvider>
    )
    return request
  }

  it('seeds the fields from the pose stored on the device and saves an edit', async () => {
    const request = renderCard({ yaw: -300, pitch: 450 })
    const yaw = screen.getByLabelText(/Yaw/) as HTMLInputElement
    const pitch = screen.getByLabelText(/Pitch/) as HTMLInputElement
    expect(yaw.value).toBe('-300')
    expect(pitch.value).toBe('450')
    expect(screen.getByRole('status').textContent).toContain('-30.0°')

    fireEvent.change(yaw, { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('chymod.wake-orientation', {
        yaw: 600,
        pitch: 450,
      })
    )
  })

  it('clears the pose on the device and leaves the fields empty', async () => {
    const request = renderCard({ yaw: 100, pitch: 200 })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('chymod.wake-orientation', null))
    expect((screen.getByLabelText(/Yaw/) as HTMLInputElement).value).toBe('')
  })

  it('refuses an out-of-range pose without sending anything', () => {
    const request = renderCard(null)
    fireEvent.change(screen.getByLabelText(/Yaw/), {
      target: { value: '5000' },
    })
    fireEvent.change(screen.getByLabelText(/Pitch/), {
      target: { value: '0' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Yaw must be between -1280 and 1280.')).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
  })
})
