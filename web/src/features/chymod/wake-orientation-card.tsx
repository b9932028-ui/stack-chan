import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type WakeOrientationRange = { min: number; max: number }

export type WakeOrientationDescriptor = {
  id: string
  kind: 'orientation'
  command: string
  statusKey?: string
  label?: string
  yaw: WakeOrientationRange
  pitch: WakeOrientationRange
  speed: number
}

export type WakeOrientation = { yaw: number; pitch: number }

/**
 * Angles are in tenths of a degree, the unit the MOD and the servo configuration
 * already use, so the numbers here match the Motion panel's sliders.
 */
export function formatAngle(value: number): string {
  return `${(value / 10).toFixed(1)}°`
}

export type WakeOrientationDraft = { yaw: string; pitch: string }

export type WakeOrientationResult =
  { kind: 'clear' } | { kind: 'set'; value: WakeOrientation } | { kind: 'invalid'; message: string }

/**
 * Leaving either axis blank means "do not turn on wake", which is also what the
 * MOD stores for a cleared orientation. A half-filled pair is never a valid pose,
 * so only a value that is present and out of range is reported as an error.
 */
export function readWakeOrientationDraft(
  draft: WakeOrientationDraft,
  control: Pick<WakeOrientationDescriptor, 'yaw' | 'pitch'>
): WakeOrientationResult {
  const yawText = draft.yaw.trim()
  const pitchText = draft.pitch.trim()
  if (yawText === '' || pitchText === '') return { kind: 'clear' }
  const yaw = Number(yawText)
  const pitch = Number(pitchText)
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { kind: 'invalid', message: 'Enter whole numbers.' }
  if (yaw < control.yaw.min || yaw > control.yaw.max)
    return {
      kind: 'invalid',
      message: `Yaw must be between ${control.yaw.min} and ${control.yaw.max}.`,
    }
  if (pitch < control.pitch.min || pitch > control.pitch.max)
    return {
      kind: 'invalid',
      message: `Pitch must be between ${control.pitch.min} and ${control.pitch.max}.`,
    }
  return {
    kind: 'set',
    value: { yaw: Math.round(yaw), pitch: Math.round(pitch) },
  }
}

type WakeOrientationCardProps = {
  control: WakeOrientationDescriptor
  status: WakeOrientation | null | undefined
  connected: boolean
  request: (command: string, value?: unknown) => Promise<unknown>
  onError: (message: string) => void
}

export function WakeOrientationCard({ control, status, connected, request, onError }: WakeOrientationCardProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<WakeOrientationDraft>({
    yaw: '',
    pitch: '',
  })
  const [invalid, setInvalid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const synced = useRef(false)

  // Seed the fields from what the device stored, but never overwrite an edit in
  // progress: the page polls chymod.status once a second.
  useEffect(() => {
    if (synced.current || status === undefined) return
    synced.current = true
    if (status) setDraft({ yaw: String(status.yaw), pitch: String(status.pitch) })
  }, [status])

  const send = async (value: WakeOrientation | null) => {
    setBusy(true)
    try {
      await request(control.command, value)
    } catch (error) {
      onError(String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    const result = readWakeOrientationDraft(draft, control)
    if (result.kind === 'invalid') {
      setInvalid(result.message)
      return
    }
    setInvalid(null)
    void send(result.kind === 'set' ? result.value : null)
  }

  const clear = () => {
    setInvalid(null)
    setDraft({ yaw: '', pitch: '' })
    void send(null)
  }

  const disabled = !connected || busy

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Wake up orientation')}</CardTitle>
        <CardDescription>
          {t(
            'Turn the head to this pose when the wake word fires and a USB host is attached. Leave either field blank to skip the turn.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="chymod-wake-yaw">
              {t('Yaw')} ({control.yaw.min} – {control.yaw.max})
            </Label>
            <Input
              id="chymod-wake-yaw"
              type="number"
              inputMode="numeric"
              min={control.yaw.min}
              max={control.yaw.max}
              step={1}
              value={draft.yaw}
              disabled={disabled}
              placeholder={t('blank')}
              onChange={(event) => setDraft((current) => ({ ...current, yaw: event.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chymod-wake-pitch">
              {t('Pitch')} ({control.pitch.min} – {control.pitch.max})
            </Label>
            <Input
              id="chymod-wake-pitch"
              type="number"
              inputMode="numeric"
              min={control.pitch.min}
              max={control.pitch.max}
              step={1}
              value={draft.pitch}
              disabled={disabled}
              placeholder={t('blank')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  pitch: event.target.value,
                }))
              }
            />
          </div>
        </div>

        {invalid && <p className="text-sm text-destructive">{invalid}</p>}

        <p className="text-sm text-muted-foreground" role="status">
          {status
            ? t('Saved: yaw {yaw}, pitch {pitch}', {
                yaw: formatAngle(status.yaw),
                pitch: formatAngle(status.pitch),
              })
            : t('Saved: no turn on wake')}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={disabled} onClick={save}>
            {t('Save')}
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={clear}>
            {t('Clear')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
