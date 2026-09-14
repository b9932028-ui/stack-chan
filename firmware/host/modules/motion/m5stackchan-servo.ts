export type ServoAxisConfig = {
  id: number
  zeroPosition: number
  angleLimit: {
    min: number
    max: number
  }
  rawPositionLimit: {
    min: number
    max: number
  }
}

export type M5StackChanServoConfig = {
  serial: {
    transmit: number
    receive: number
    port: number
    baud: number
  }
  yaw: ServoAxisConfig
  pitch: ServoAxisConfig
}

export type RotationLike = {
  y: number
  p: number
  r?: number
}

// Source firmware scale: raw position changes by 0.32 SCS steps per 0.1 degree.
export const SCS_STEPS_PER_01_DEGREE = 16 / 5 / 10
// Radians to 0.1-degree units: pi radians equals 1800.
export const RAD_TO_01_DEGREE = 1800 / Math.PI
// Source firmware rotate velocity range, mapped onto the SCS PWM magnitude.
export const ROTATE_VELOCITY_LIMIT = 1000
export const SCS_PWM_MAX = 1023
export const SCS_PWM_REVERSE_BIT = 1 << 10
// SCS factory angle limits, used when the limits a servo had before PWM mode are unknown.
export const SCS_FACTORY_ANGLE_LIMIT = Object.freeze({ min: 0, max: 1023 })

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export const M5STACKCHAN_SERVO_DEFAULTS: M5StackChanServoConfig = Object.freeze({
  serial: Object.freeze({
    transmit: 6,
    receive: 7,
    port: 1,
    baud: 1_000_000,
  }),
  yaw: Object.freeze({
    id: 1,
    zeroPosition: 460,
    angleLimit: Object.freeze({ min: -1280, max: 1280 }),
    rawPositionLimit: Object.freeze({ min: 0, max: 1000 }),
  }),
  pitch: Object.freeze({
    id: 2,
    zeroPosition: 620,
    angleLimit: Object.freeze({ min: 0, max: 900 }),
    rawPositionLimit: Object.freeze({ min: 0, max: 1000 }),
  }),
})

export function createM5StackChanServoConfig(
  overrides: Partial<{
    serial: Partial<M5StackChanServoConfig['serial']>
    yaw: Partial<ServoAxisConfig>
    pitch: Partial<ServoAxisConfig>
  }> = {},
): M5StackChanServoConfig {
  return {
    serial: { ...M5STACKCHAN_SERVO_DEFAULTS.serial, ...overrides.serial },
    yaw: {
      ...M5STACKCHAN_SERVO_DEFAULTS.yaw,
      ...overrides.yaw,
      angleLimit: {
        ...M5STACKCHAN_SERVO_DEFAULTS.yaw.angleLimit,
        ...overrides.yaw?.angleLimit,
      },
      rawPositionLimit: {
        ...M5STACKCHAN_SERVO_DEFAULTS.yaw.rawPositionLimit,
        ...overrides.yaw?.rawPositionLimit,
      },
    },
    pitch: {
      ...M5STACKCHAN_SERVO_DEFAULTS.pitch,
      ...overrides.pitch,
      angleLimit: {
        ...M5STACKCHAN_SERVO_DEFAULTS.pitch.angleLimit,
        ...overrides.pitch?.angleLimit,
      },
      rawPositionLimit: {
        ...M5STACKCHAN_SERVO_DEFAULTS.pitch.rawPositionLimit,
        ...overrides.pitch?.rawPositionLimit,
      },
    },
  }
}

/**
 * Converts an angle in 0.1-degree units to a raw SCS position.
 * The angle is clamped to axis.angleLimit, quantized with Math.trunc, offset by axis.zeroPosition,
 * and the result is clamped to axis.rawPositionLimit.
 */
export function angleToRawPosition(angleIn01Degree: number, axis: ServoAxisConfig): number {
  const clampedAngle = clamp(angleIn01Degree, axis.angleLimit.min, axis.angleLimit.max)
  const raw = axis.zeroPosition + Math.trunc(clampedAngle * SCS_STEPS_PER_01_DEGREE)
  return clamp(raw, axis.rawPositionLimit.min, axis.rawPositionLimit.max)
}

/**
 * Converts a raw SCS position to an angle in 0.1-degree units.
 * The raw position is clamped to axis.rawPositionLimit, de-offset by axis.zeroPosition,
 * quantized with Math.trunc, and the result is clamped to axis.angleLimit.
 */
export function rawPositionToAngle(rawPosition: number, axis: ServoAxisConfig): number {
  const clampedRawPosition = clamp(rawPosition, axis.rawPositionLimit.min, axis.rawPositionLimit.max)
  const angle = Math.trunc((clampedRawPosition - axis.zeroPosition) / SCS_STEPS_PER_01_DEGREE)
  return clamp(angle, axis.angleLimit.min, axis.angleLimit.max)
}

/**
 * Converts a source-firmware rotate velocity (-1000 to 1000) into the SCS PWM register value.
 * Matches `map_range(velocity, 0, 1000, 0, 1023)` followed by `SCSCL::WritePWM`, which stores
 * the magnitude and flags the reverse direction with bit 10.
 */
export function velocityToScsPwmRegister(velocity: number): number {
  const clampedVelocity = clamp(Math.trunc(velocity), -ROTATE_VELOCITY_LIMIT, ROTATE_VELOCITY_LIMIT)
  const magnitude = Math.trunc((Math.abs(clampedVelocity) * SCS_PWM_MAX) / ROTATE_VELOCITY_LIMIT)
  return clampedVelocity < 0 ? magnitude | SCS_PWM_REVERSE_BIT : magnitude
}

export function rotationToM5StackChanServoAngles(rotation: RotationLike): { yaw: number; pitch: number } {
  return {
    yaw: Math.trunc(rotation.y * RAD_TO_01_DEGREE),
    pitch: Math.trunc(-rotation.p * RAD_TO_01_DEGREE),
  }
}
