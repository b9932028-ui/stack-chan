import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import { PreferencesPage } from '@/features/preferences/preferences-page'
import { DEFAULT_PREFERENCES } from '@/features/preferences/preference-model'
import { usePreferences } from '@/features/preferences/use-preferences'

vi.mock('@/features/preferences/use-preferences', () => ({
  usePreferences: vi.fn(),
}))

describe('PreferencesPage', () => {
  beforeEach(() => {
    vi.mocked(usePreferences).mockReturnValue({
      connection: 'connected',
      transport: 'ble',
      connected: true,
      busy: false,
      values: DEFAULT_PREFERENCES,
      readOnly: new Set(),
      controlCapabilities: new Set(),
      controlAvailable: false,
      operation: { status: 'idle' },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      update: vi.fn(),
      save: vi.fn(async () => {}),
      clearWifi: vi.fn(async () => {}),
      control: vi.fn(async () => {}),
    })
  })

  it('shows the MCP server token as a password field', () => {
    render(
      <I18nProvider>
        <PreferencesPage />
      </I18nProvider>
    )

    const token = screen.getByLabelText('Bearerトークン')
    expect(token).toHaveAttribute('name', 'mcp.token')
    expect(token).toHaveAttribute('type', 'password')
  })
  it.each([
    ['restart', '再起動'],
    ['shutdown', '電源を切る'],
  ])('confirms %s before sending a USB command', async (command, label) => {
    const control = vi.fn(async () => {})
    const defaults = vi.mocked(usePreferences)()
    vi.mocked(usePreferences).mockReturnValue({
      ...defaults,
      transport: 'usb',
      controlAvailable: true,
      controlCapabilities: new Set(['restart', 'shutdown']),
      control,
    })
    render(
      <I18nProvider>
        <PreferencesPage />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(control).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '実行する' }))
    expect(control).toHaveBeenCalledExactlyOnceWith(command)
  })

  it('disables power controls when firmware does not advertise them', () => {
    render(
      <I18nProvider>
        <PreferencesPage />
      </I18nProvider>
    )
    expect(screen.getByRole('button', { name: '再起動' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '電源を切る' })).toBeDisabled()
  })
})
