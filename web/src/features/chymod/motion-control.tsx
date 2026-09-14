import { RotateCcw } from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'

/**
 * Port of the Motion panel from the M5Stack StackChan app
 * (`app/lib/view/popup/motion.dart` and `grid_coordinate_joystick.dart`).
 * The avatar editor is intentionally not ported.
 */

export type MotionRange = { min: number; max: number }

export type MotionControlDescriptor = {
  id: string
  kind: 'motion'
  command: string
  yaw: { angle: MotionRange; speed: MotionRange; rotate: MotionRange | null }
  pitch: { angle: MotionRange; speed: MotionRange }
  defaultSpeed: number
}

export type MotionStatus = {
  yaw: { mode: 'angle' | 'rotate'; angle: number; speed: number; rotate: number }
  pitch: { angle: number; speed: number }
  torque: boolean
  moving: boolean
  rotateSupported: boolean
  error: string | null
}

type ServoItem = { angle: number; speed: number; rotate: number }
type MotionState = { yaw: ServoItem; pitch: ServoItem }

// The app's joystick: 25 px of padding around the usable area and a 50 px knob.
export const JOYSTICK_PADDING_PX = 25
const JOYSTICK_KNOB_PX = 50

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function defaultMotionState(speed: number): MotionState {
  return { yaw: { angle: 0, speed, rotate: 0 }, pitch: { angle: 0, speed, rotate: 0 } }
}

/** Mirrors the app's `MotionDataItem.toJson`: a non-zero angle wins, then a non-zero rotate. */
export function servoPayload(item: ServoItem) {
  if (item.angle !== 0) return { angle: item.angle, speed: item.speed }
  if (item.rotate !== 0) return { rotate: item.rotate, speed: item.speed }
  return { angle: item.angle, speed: item.speed }
}

export function motionPayload(state: MotionState) {
  return { yawServo: servoPayload(state.yaw), pitchServo: servoPayload(state.pitch) }
}

/**
 * Maps a pointer position inside the joystick to servo angles, as the app does:
 * left edge is the minimum yaw, and the top edge is the maximum pitch.
 */
export function joystickPointToAngles(
  x: number,
  y: number,
  width: number,
  height: number,
  yawRange: MotionRange,
  pitchRange: MotionRange,
  padding = JOYSTICK_PADDING_PX
) {
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)
  const clampedX = clamp(x, padding, width - padding)
  const clampedY = clamp(y, padding, height - padding)
  const yaw = ((clampedX - padding) / usableWidth) * (yawRange.max - yawRange.min) + yawRange.min
  const pitch = pitchRange.max - ((clampedY - padding) / usableHeight) * (pitchRange.max - pitchRange.min)
  return { yaw: Math.trunc(yaw), pitch: Math.trunc(pitch) }
}

/** Sends only the newest value while a request is in flight, so a drag cannot queue up stale moves. */
function useLatestSender<T>(send: (value: T) => Promise<void>) {
  const sendRef = useRef(send)
  sendRef.current = send
  const inFlight = useRef(false)
  const queued = useRef<{ value: T } | null>(null)

  return useCallback((value: T) => {
    if (inFlight.current) {
      queued.current = { value }
      return
    }
    const run = async (next: T) => {
      inFlight.current = true
      try {
        await sendRef.current(next)
      } finally {
        inFlight.current = false
      }
      const pending = queued.current
      queued.current = null
      if (pending) void run(pending.value)
    }
    void run(value)
  }, [])
}

type SliderRowProps = {
  id: string
  label: string
  value: number
  range: MotionRange
  disabled: boolean
  onChange: (value: number) => void
  onCommit: () => void
}

function SliderRow({ id, label, value, range, disabled, onChange, onCommit }: SliderRowProps) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)_3.5rem] items-center gap-3">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="range"
        className="w-full accent-primary"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <span className="text-right text-sm tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}

type MotionControlProps = {
  control: MotionControlDescriptor
  status: MotionStatus | undefined
  connected: boolean
  request: (command: string, value?: unknown) => Promise<unknown>
  onError: (message: string) => void
}

export function MotionControl({ control, status, connected, request, onError }: MotionControlProps) {
  const { t } = useI18n()
  const [state, setState] = useState(() => defaultMotionState(control.defaultSpeed))
  const [dragging, setDragging] = useState(false)
  const stateRef = useRef(state)
  const synced = useRef(false)

  // Start from what the device last applied, but never overwrite a value the user already changed.
  useEffect(() => {
    if (synced.current || !status) return
    synced.current = true
    const next = {
      yaw: {
        angle: status.yaw.angle,
        speed: status.yaw.speed,
        rotate: status.yaw.mode === 'rotate' ? status.yaw.rotate : 0,
      },
      pitch: { angle: status.pitch.angle, speed: status.pitch.speed, rotate: 0 },
    }
    stateRef.current = next
    setState(next)
  }, [status])

  const send = useLatestSender<MotionState>(async (next) => {
    try {
      await request(control.command, motionPayload(next))
    } catch (error) {
      onError(String(error))
    }
  })

  const update = (next: MotionState) => {
    synced.current = true
    stateRef.current = next
    setState(next)
  }
  const commit = () => send(stateRef.current)

  const moveJoystick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const angles = joystickPointToAngles(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      control.yaw.angle,
      control.pitch.angle
    )
    const current = stateRef.current
    update({ yaw: { ...current.yaw, rotate: 0, angle: angles.yaw }, pitch: { ...current.pitch, angle: angles.pitch } })
    commit()
  }

  const yawRange = control.yaw.angle
  const pitchRange = control.pitch.angle
  const xPercent = (state.yaw.angle - yawRange.min) / (yawRange.max - yawRange.min)
  const yPercent = 1 - (state.pitch.angle - pitchRange.min) / (pitchRange.max - pitchRange.min)
  const disabled = !connected

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{t('動作控制')}</CardTitle>
            <CardDescription>{t('搖桿與舵機滑桿，移植自 M5Stack StackChan App 的 Motion 面板。')}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {status && (
              <Badge variant={status.torque ? 'default' : 'secondary'}>
                {t(status.torque ? '扭力開啟' : '扭力釋放')}
              </Badge>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t('重設動作')}
              disabled={disabled}
              onClick={() => {
                update(defaultMotionState(control.defaultSpeed))
                commit()
              }}
            >
              <RotateCcw />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {status?.error && <p className="text-sm text-destructive">{status.error}</p>}

        <section className="grid gap-2">
          <Label>{t('搖桿')}</Label>
          <div
            role="slider"
            tabIndex={-1}
            aria-label={t('搖桿')}
            aria-valuetext={`yaw ${state.yaw.angle}, pitch ${state.pitch.angle}`}
            aria-disabled={disabled}
            className="relative h-[200px] touch-none select-none overflow-hidden rounded-3xl bg-muted"
            onPointerDown={(event) => {
              if (disabled) return
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragging(true)
              moveJoystick(event)
            }}
            onPointerMove={(event) => {
              if (dragging) moveJoystick(event)
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
          >
            <div
              className={`pointer-events-none absolute rounded-full bg-primary shadow ${dragging ? 'opacity-80' : ''}`}
              style={{
                width: JOYSTICK_KNOB_PX,
                height: JOYSTICK_KNOB_PX,
                left: `calc(${JOYSTICK_PADDING_PX}px + (100% - ${JOYSTICK_PADDING_PX * 2}px) * ${xPercent} - ${JOYSTICK_KNOB_PX / 2}px)`,
                top: `calc(${JOYSTICK_PADDING_PX}px + (100% - ${JOYSTICK_PADDING_PX * 2}px) * ${yPercent} - ${JOYSTICK_KNOB_PX / 2}px)`,
              }}
            />
          </div>
        </section>

        <section className="grid gap-3">
          <Label>{t('Yaw 舵機')}</Label>
          <SliderRow
            id="chymod-motion-yaw-angle"
            label={t('角度')}
            value={state.yaw.angle}
            range={control.yaw.angle}
            disabled={disabled}
            onChange={(angle) => update({ ...stateRef.current, yaw: { ...stateRef.current.yaw, rotate: 0, angle } })}
            onCommit={commit}
          />
          <SliderRow
            id="chymod-motion-yaw-speed"
            label={t('速度')}
            value={state.yaw.speed}
            range={control.yaw.speed}
            disabled={disabled}
            onChange={(speed) => update({ ...stateRef.current, yaw: { ...stateRef.current.yaw, speed } })}
            onCommit={commit}
          />
          {control.yaw.rotate && (
            <SliderRow
              id="chymod-motion-yaw-rotate"
              label={t('旋轉')}
              value={state.yaw.rotate}
              range={control.yaw.rotate}
              disabled={disabled}
              onChange={(rotate) => update({ ...stateRef.current, yaw: { ...stateRef.current.yaw, angle: 0, rotate } })}
              onCommit={commit}
            />
          )}
        </section>

        <section className="grid gap-3">
          <Label>{t('Pitch 舵機')}</Label>
          <SliderRow
            id="chymod-motion-pitch-angle"
            label={t('角度')}
            value={state.pitch.angle}
            range={control.pitch.angle}
            disabled={disabled}
            onChange={(angle) => update({ ...stateRef.current, pitch: { ...stateRef.current.pitch, angle } })}
            onCommit={commit}
          />
          <SliderRow
            id="chymod-motion-pitch-speed"
            label={t('速度')}
            value={state.pitch.speed}
            range={control.pitch.speed}
            disabled={disabled}
            onChange={(speed) => update({ ...stateRef.current, pitch: { ...stateRef.current.pitch, speed } })}
            onCommit={commit}
          />
        </section>
      </CardContent>
    </Card>
  )
}
