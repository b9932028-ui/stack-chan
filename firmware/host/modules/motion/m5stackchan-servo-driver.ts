import {
  angleToRawPosition,
  createM5StackChanServoConfig,
  type M5StackChanServoConfig,
  RAD_TO_01_DEGREE,
  rawPositionToAngle,
  rotationToM5StackChanServoAngles,
  SCS_FACTORY_ANGLE_LIMIT,
  velocityToScsPwmRegister,
} from 'm5stackchan-servo'
import {
  type MotionCompletion,
  type MotionDurationSeconds,
  type MotionResultCallback,
  motionDurationSecondsToMilliseconds,
} from 'motion-controller'
import SCServo from 'protocols/scservo'
import { type PY32IOExpander, tryGetSharedPY32IOExpander } from 'py32-io-expander'
import type { Maybe, Rotation } from 'stackchan-util'

type M5StackChanServoDriverProps = Partial<{
  panId: number
  tiltId: number
  yawZeroPosition: number
  pitchZeroPosition: number
  config: Partial<{
    serial: Partial<M5StackChanServoConfig['serial']>
    yaw: Partial<M5StackChanServoConfig['yaw']>
    pitch: Partial<M5StackChanServoConfig['pitch']>
  }>
  serial: Partial<M5StackChanServoConfig['serial']>
  servoPower: {
    type?: 'py32' | 'none'
    pin?: number
    address?: number
  }
}>

type AngleLimits = { min: number; max: number }

export class M5StackChanServoDriver {
  #pan: SCServo
  #tilt: SCServo
  #config: M5StackChanServoConfig
  #rotation: Rotation = { y: 0, p: 0, r: 0 }
  #rotationResult: Maybe<Rotation> = { success: true, value: this.#rotation }
  #rotationErrorResult: { success: false; reason?: string } = { success: false }
  // Angle limits the pan servo had before entering PWM mode; null while in position mode.
  #panPositionLimits: AngleLimits | null = null
  #servoPower?: {
    setEnabled: (enabled: boolean) => void
  }

  constructor(param: M5StackChanServoDriverProps = {}) {
    this.#config = createM5StackChanServoConfig({
      serial: {
        ...param.config?.serial,
        ...param.serial,
      },
      yaw: {
        ...param.config?.yaw,
        ...(param.panId !== undefined ? { id: param.panId } : {}),
        ...(param.yawZeroPosition !== undefined ? { zeroPosition: param.yawZeroPosition } : {}),
      },
      pitch: {
        ...param.config?.pitch,
        ...(param.tiltId !== undefined ? { id: param.tiltId } : {}),
        ...(param.pitchZeroPosition !== undefined ? { zeroPosition: param.pitchZeroPosition } : {}),
      },
    })
    this.#pan = new SCServo({ id: this.#config.yaw.id, serial: this.#config.serial, awaitWriteResponse: true })
    this.#tilt = new SCServo({ id: this.#config.pitch.id, serial: this.#config.serial, awaitWriteResponse: true })
    if (param.servoPower?.type !== 'none') {
      this.#servoPower = new PY32ServoPower(param.servoPower?.pin ?? 0, param.servoPower?.address)
    }
  }

  onAttached() {
    this.#servoPower?.setEnabled(true)
    this.#recoverPanFromPwmMode()
  }

  onDetached() {
    this.#servoPower?.setEnabled(false)
  }

  setTorque(torque: boolean, callback?: MotionCompletion): void {
    this.#pan.setTorque(torque, (panError) => {
      if (panError != null) {
        callback?.(panError)
        return
      }
      this.#tilt.setTorque(torque, callback)
    })
  }

  applyRotation(ori: Rotation, time: MotionDurationSeconds = 0.5, callback?: MotionCompletion): void {
    this.#leavePanPwmMode((modeError) => {
      if (modeError != null) {
        callback?.(modeError)
        return
      }
      this.#applyPositions(ori, time, callback)
    })
  }

  /**
   * Spins the yaw servo continuously, as the source firmware's `Servo::rotate` does.
   * The SCS servo runs as a wheel while both angle limits are 0. The limits it had are
   * kept here and written back before the next position move.
   *
   * @param velocity - -1000 to 1000; 0 stops the servo but stays in PWM mode
   */
  rotateYaw(velocity: number, callback?: MotionCompletion): void {
    const register = velocityToScsPwmRegister(velocity)
    if (this.#panPositionLimits != null) {
      this.#pan.setRawPwm(register, callback)
      return
    }
    this.#pan.readAngleLimits((limits) => {
      if (limits.success === false) {
        callback?.(new Error(limits.reason ?? 'failed to read yaw angle limits'))
        return
      }
      // Limits already at 0 mean PWM mode was left on by an earlier session; restore factory limits later.
      const wheelAlready = limits.value.min === 0 && limits.value.max === 0
      const positionLimits = wheelAlready ? SCS_FACTORY_ANGLE_LIMIT : limits.value
      this.#pan.writeAngleLimits(0, 0, (modeError) => {
        if (modeError != null) {
          callback?.(modeError)
          return
        }
        this.#panPositionLimits = { min: positionLimits.min, max: positionLimits.max }
        this.#pan.setRawPwm(register, callback)
      })
    })
  }

  getRotation(callback: MotionResultCallback<Maybe<Rotation>>): void {
    this.#pan.readRawPosition((panStatus) => {
      if (panStatus.success === false) {
        this.#returnRotationError(callback, panStatus.reason)
        return
      }
      this.#tilt.readRawPosition((tiltStatus) => {
        if (tiltStatus.success === false) {
          this.#returnRotationError(callback, tiltStatus.reason)
          return
        }
        const yawAngle = rawPositionToAngle(panStatus.value.position, this.#config.yaw)
        const pitchAngle = rawPositionToAngle(tiltStatus.value.position, this.#config.pitch)
        this.#rotation.y = yawAngle / RAD_TO_01_DEGREE
        this.#rotation.p = -(pitchAngle / RAD_TO_01_DEGREE)
        this.#rotation.r = 0.0
        callback(this.#rotationResult)
      })
    })
  }

  #applyPositions(ori: Rotation, time: MotionDurationSeconds, callback?: MotionCompletion): void {
    const angles = rotationToM5StackChanServoAngles(ori)
    const panRawPosition = angleToRawPosition(angles.yaw, this.#config.yaw)
    const tiltRawPosition = angleToRawPosition(angles.pitch, this.#config.pitch)
    if (time === 0) {
      this.#pan.setRawPosition(panRawPosition, (panError) => {
        if (panError != null) {
          callback?.(panError)
          return
        }
        this.#tilt.setRawPosition(tiltRawPosition, callback)
      })
    } else {
      const goalTimeMilliseconds = motionDurationSecondsToMilliseconds(time)
      this.#pan.setRawPositionInTime(panRawPosition, goalTimeMilliseconds, (panError) => {
        if (panError != null) {
          callback?.(panError)
          return
        }
        this.#tilt.setRawPositionInTime(tiltRawPosition, goalTimeMilliseconds, callback)
      })
    }
  }

  #leavePanPwmMode(next: MotionCompletion): void {
    const limits = this.#panPositionLimits
    if (limits == null) {
      next()
      return
    }
    this.#pan.setRawPwm(0, (stopError) => {
      if (stopError != null) {
        next(stopError)
        return
      }
      this.#pan.writeAngleLimits(limits.min, limits.max, (modeError) => {
        if (modeError == null) this.#panPositionLimits = null
        next(modeError)
      })
    })
  }

  /**
   * A reset while spinning leaves the pan servo powered in PWM mode, where it keeps
   * turning and ignores position commands. A servo that was just powered on has
   * already reverted, and simply does not answer yet, which is harmless here.
   */
  #recoverPanFromPwmMode(): void {
    this.#pan.readAngleLimits((limits) => {
      if (limits.success === false || limits.value.min !== 0 || limits.value.max !== 0) return
      trace('[m5stackchan-servo] pan servo was left in PWM mode; restoring position mode\n')
      this.#pan.setRawPwm(0, () => {
        this.#pan.writeAngleLimits(SCS_FACTORY_ANGLE_LIMIT.min, SCS_FACTORY_ANGLE_LIMIT.max, (error) => {
          if (error != null) trace(`[m5stackchan-servo] pan position mode restore failed: ${String(error)}\n`)
        })
      })
    })
  }

  #returnRotationError(callback: MotionResultCallback<Maybe<Rotation>>, reason?: string): void {
    this.#rotationErrorResult.reason = reason
    callback(this.#rotationErrorResult)
  }
}

class PY32ServoPower {
  #pin: number
  #expander?: PY32IOExpander

  constructor(pin: number, address?: number) {
    this.#pin = pin
    const expander = tryGetSharedPY32IOExpander(address === undefined ? undefined : { address }, (error) => {
      trace(`[m5stackchan-servo] PY32 servo power init failed: ${error}\n`)
    })
    if (!expander) return
    this.#expander = expander
    expander.setDirection(this.#pin, true)
    expander.setPullMode(this.#pin, true)
    trace(`[m5stackchan-servo] configured PY32 servo power pin ${this.#pin}\n`)
  }

  setEnabled(enabled: boolean) {
    const expander = this.#expander
    if (!expander) return
    expander.digitalWrite(this.#pin, enabled)
    trace(`[m5stackchan-servo] servo power ${enabled ? 'on' : 'off'} (${expander.getWriteValue(this.#pin)})\n`)
  }
}
