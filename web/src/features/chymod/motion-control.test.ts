import { describe, expect, it } from 'vitest'

import { joystickPointToAngles, motionPayload, servoPayload } from '@/features/chymod/motion-control'

const yawRange = { min: -1280, max: 1280 }
const pitchRange = { min: 0, max: 900 }

describe('servoPayload', () => {
  it('sends angle and speed when the angle is non-zero, even if rotate is set', () => {
    expect(servoPayload({ angle: 300, speed: 700, rotate: 400 })).toEqual({ angle: 300, speed: 700 })
  })

  it('sends rotate only when the angle is zero', () => {
    expect(servoPayload({ angle: 0, speed: 500, rotate: -250 })).toEqual({ rotate: -250, speed: 500 })
  })

  it('falls back to angle zero when neither is set', () => {
    expect(servoPayload({ angle: 0, speed: 500, rotate: 0 })).toEqual({ angle: 0, speed: 500 })
  })

  it('builds the app controlMotion shape', () => {
    expect(
      motionPayload({ yaw: { angle: 120, speed: 500, rotate: 0 }, pitch: { angle: 450, speed: 300, rotate: 0 } })
    ).toEqual({ yawServo: { angle: 120, speed: 500 }, pitchServo: { angle: 450, speed: 300 } })
  })
})

describe('joystickPointToAngles', () => {
  // 300 x 200 pad with 25 px padding: usable area is 250 x 150.
  it('maps the padded corners to the servo range, top edge being maximum pitch', () => {
    expect(joystickPointToAngles(25, 25, 300, 200, yawRange, pitchRange)).toEqual({ yaw: -1280, pitch: 900 })
    expect(joystickPointToAngles(275, 175, 300, 200, yawRange, pitchRange)).toEqual({ yaw: 1280, pitch: 0 })
  })

  it('maps the centre to yaw zero and mid pitch', () => {
    expect(joystickPointToAngles(150, 100, 300, 200, yawRange, pitchRange)).toEqual({ yaw: 0, pitch: 450 })
  })

  it('clamps points in the padding to the range edges', () => {
    expect(joystickPointToAngles(0, 0, 300, 200, yawRange, pitchRange)).toEqual({ yaw: -1280, pitch: 900 })
    expect(joystickPointToAngles(400, 400, 300, 200, yawRange, pitchRange)).toEqual({ yaw: 1280, pitch: 0 })
  })
})
