import { onContextCreated as initializeDefaultContext } from 'app-default-behavior/on-context-created'
import { FaceBase } from 'behaviors/face'
import { Outline } from 'commodetto/outline'
import { Emoticon } from 'effects/emoticon'
import { Emotion } from 'face-state'
import MicroWakeWord from 'micro-wake-word'
import { getFillSkin } from 'parts/shape-utils'
import Preference from 'preference'
import { defineShapeTemplate } from 'template'
import Timer from 'timer'
import { registerUSBControlNamespace } from 'usb-control-registry'

const ANIMATION_NAMES = ['idle', 'blink', 'lookAround', 'happy', 'angry', 'working']
const IDLE_DECISION_MS = 3000
const BLINK_DURATION_MS = 1000
const LOOK_DURATION_MS = 7600
const MOOD_DURATION_MS = 3000
const MOOD_TRANSITION_MS = 450
const WORK_DURATION_MS = 15000
const WORK_TRANSITION_MS = 500
const WORK_LINE_MS = 2400
const WORK_BLINK_START_MS = 2050

// Motion panel ported from the M5Stack StackChan app. Angles are in 0.1 degrees,
// the same unit and ranges as the app and its servo configuration.
const MOTION_YAW_ANGLE_LIMIT = Object.freeze({ min: -1280, max: 1280 })
const MOTION_PITCH_ANGLE_LIMIT = Object.freeze({ min: 0, max: 900 })
const MOTION_SPEED_LIMIT = Object.freeze({ min: 0, max: 1000 })
const MOTION_ROTATE_LIMIT = Object.freeze({ min: -1000, max: 1000 })
const MOTION_DEFAULT_SPEED = 500
// The app firmware releases torque once a servo is at rest, checking every 200 ms.
const MOTION_TORQUE_RELEASE_MS = 200
const DECIDEGREES_PER_RADIAN = 1800 / Math.PI

const LOOK_X_OFFSET_PX = 27
const SINGLE_BLINK_DURATION_MS = 300
const BLINK_GAP_MS = 300
const SECOND_BLINK_START_MS = SINGLE_BLINK_DURATION_MS + BLINK_GAP_MS
const BLINK_CLOSE_MS = 90
const BLINK_HOLD_MS = 40
const BLINK_OPEN_MS = SINGLE_BLINK_DURATION_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS
const LOOK_KEYFRAMES = [
  [0, 0, 0, 0],
  [600, -LOOK_X_OFFSET_PX, 5, 0],
  [1400, -LOOK_X_OFFSET_PX, 5, 0],
  [2300, LOOK_X_OFFSET_PX, 0, 5],
  [3100, LOOK_X_OFFSET_PX, 0, 5],
  [4000, 22, -14, -14],
  [4800, 22, -14, -14],
  [5800, -22, 14, 14],
  [6600, -22, 14, 14],
  [LOOK_DURATION_MS, 0, 0, 0],
]

const EYE_WIDTH = 28
const EYE_HEIGHT = 64
const EYE_CANVAS_WIDTH = 84
const EYE_CANVAS_HEIGHT = 104
const EYE_BASE_LEFT = (EYE_CANVAS_WIDTH - EYE_WIDTH) / 2
const EYE_BASE_TOP = (EYE_CANVAS_HEIGHT - EYE_HEIGHT) / 2
const MORPH_STEPS = 8
const workingPrimarySkin = getFillSkin(0xffffff)
const workingSecondarySkin = getFillSkin(0x000000)
const workingLabelStyle = new Style({
  font: 'OpenSans-Regular-24',
  color: '#ffffff',
  horizontal: 'left',
  vertical: 'middle',
})

const smoothStep = (value) => value * value * (3 - 2 * value)

function createCapsuleOutline(open) {
  const height = 5 + (EYE_HEIGHT - 5) * open
  const top = (EYE_HEIGHT - height) / 2
  const bottom = top + height
  const radius = Math.min(EYE_WIDTH / 2, height / 2)
  const control = radius * 0.55228475
  const path = new Outline.CanvasPath()
  path.moveTo(radius, top)
  path.lineTo(EYE_WIDTH - radius, top)
  path.bezierCurveTo(EYE_WIDTH - radius + control, top, EYE_WIDTH, top + radius - control, EYE_WIDTH, top + radius)
  path.lineTo(EYE_WIDTH, bottom - radius)
  path.bezierCurveTo(
    EYE_WIDTH,
    bottom - radius + control,
    EYE_WIDTH - radius + control,
    bottom,
    EYE_WIDTH - radius,
    bottom,
  )
  path.lineTo(radius, bottom)
  path.bezierCurveTo(radius - control, bottom, 0, bottom - radius + control, 0, bottom - radius)
  path.lineTo(0, top + radius)
  path.bezierCurveTo(0, top + radius - control, radius - control, top, radius, top)
  path.closePath()
  return Outline.fill(path)
}

function createHappyOutline(progress) {
  if (progress === 0) return createCapsuleOutline(1)
  const lowerControlY = 78 - 44 * progress
  const path = new Outline.CanvasPath()
  path.moveTo(14, 0)
  path.bezierCurveTo(22, 0, 28, 6, 28, 14)
  path.lineTo(28, 50)
  path.quadraticCurveTo(14, lowerControlY, 0, 50)
  path.lineTo(0, 14)
  path.bezierCurveTo(0, 6, 6, 0, 14, 0)
  path.closePath()
  return Outline.fill(path)
}

function createAngryOutline(progress) {
  if (progress === 0) return createCapsuleOutline(1)
  const upperControlY = -14 + 44 * progress
  const path = new Outline.CanvasPath()
  path.moveTo(0, 14)
  path.quadraticCurveTo(14, upperControlY, 28, 14)
  path.lineTo(28, 50)
  path.bezierCurveTo(28, 58, 22, 64, 14, 64)
  path.bezierCurveTo(6, 64, 0, 58, 0, 50)
  path.closePath()
  return Outline.fill(path)
}

const happyOutlines = []
const angryOutlines = []
const blinkOutlines = []
for (let step = 0; step <= MORPH_STEPS; step += 1) {
  const progress = step / MORPH_STEPS
  happyOutlines.push(createHappyOutline(progress))
  angryOutlines.push(createAngryOutline(progress))
  blinkOutlines.push(createCapsuleOutline(progress))
}

const MoodIris = defineShapeTemplate((opts) => ({
  left: EYE_BASE_LEFT,
  top: EYE_BASE_TOP,
  width: EYE_WIDTH,
  height: EYE_HEIGHT,
  skin: getFillSkin(0xffffff),
  Behavior: class extends Behavior {
    #lastEmotion = -1
    #lastStep = -1

    onCreate(shape) {
      shape.fillOutline = happyOutlines[0]
      shape.strokeOutline = undefined
    }

    onFaceSkin(shape, palette) {
      shape.skin = palette.primary
    }

    onFaceState(shape, face) {
      const emotion = face.emotion
      const eye = face.eyes[opts.side]
      const step = Math.max(0, Math.min(MORPH_STEPS, Math.round(eye.open * MORPH_STEPS)))
      if (emotion === this.#lastEmotion && step === this.#lastStep) return

      this.#lastEmotion = emotion
      this.#lastStep = step
      if (emotion === Emotion.HAPPY) {
        shape.fillOutline = happyOutlines[step]
      } else if (emotion === Emotion.ANGRY) {
        shape.fillOutline = angryOutlines[step]
      } else {
        shape.fillOutline = blinkOutlines[step]
      }
    }
  },
}))

const MoodEye = Container.template((opts) => {
  const iris = new MoodIris({ side: opts.side })
  return {
    left: opts.cx - EYE_CANVAS_WIDTH / 2,
    top: opts.cy - EYE_CANVAS_HEIGHT / 2,
    width: EYE_CANVAS_WIDTH,
    height: EYE_CANVAS_HEIGHT,
    clip: true,
    Behavior: class extends Behavior {
      onFaceState(_container, face) {
        const eye = face.eyes[opts.side]
        iris.coordinates = {
          left: EYE_BASE_LEFT + eye.gazeX * 2,
          top: EYE_BASE_TOP + eye.gazeY * 2,
          width: EYE_WIDTH,
          height: EYE_HEIGHT,
        }
      }
    },
    contents: [iris],
  }
})

const MoodMark = Container.template((opts) => ({
  left: opts.left,
  top: opts.top,
  width: opts.size,
  height: opts.size,
  visible: false,
  Behavior: class extends Behavior {
    onFaceState(container, face) {
      container.visible = face.emotion === opts.emotion
    }
  },
  contents: [new Emoticon({ key: opts.key, left: 0, top: 0, width: opts.size, height: opts.size })],
}))

const WorkingEffect = Container.template((opts) => {
  // Scale every page detail together while preserving the book's width.
  const bookY = (value) => Math.round((value * 2) / 3)
  const bookPart = (left, top, width, height, skin) =>
    new Content(null, {
      left,
      top: bookY(top),
      width,
      height: Math.max(1, bookY(height)),
      skin,
    })
  const pageTurn = new Container(null, {
    left: 70,
    top: bookY(5),
    width: 56,
    height: bookY(38),
    visible: false,
    clip: true,
    skin: new Skin({ fill: '#b8c4cf' }),
    contents: [
      new Content(null, { left: 0, top: 0, bottom: 0, width: 2, skin: workingSecondarySkin }),
      bookPart(5, 10, 42, 2, workingSecondarySkin),
      bookPart(5, 20, 34, 2, workingSecondarySkin),
    ],
  })
  const book = new Container(null, {
    left: 94,
    top: 188,
    width: 132,
    height: bookY(48),
    contents: [
      bookPart(0, 4, 64, 40, workingPrimarySkin),
      bookPart(68, 4, 64, 40, workingPrimarySkin),
      bookPart(4, 44, 58, 3, workingPrimarySkin),
      bookPart(70, 44, 58, 3, workingPrimarySkin),
      bookPart(65, 8, 3, 36, workingSecondarySkin),
      bookPart(10, 14, 44, 2, workingSecondarySkin),
      bookPart(10, 24, 38, 2, workingSecondarySkin),
      bookPart(78, 14, 44, 2, workingSecondarySkin),
      bookPart(84, 24, 38, 2, workingSecondarySkin),
      pageTurn,
    ],
  })
  const label = new Label(null, {
    left: 94,
    width: 150,
    top: 18,
    height: 32,
    string: 'Working',
    style: workingLabelStyle,
  })
  return {
    left: 0,
    top: 0,
    width: 320,
    height: 240,
    visible: false,
    contents: [book, label],
    Behavior: class extends Behavior {
      onCreate(container) {
        opts.machine.setVisualListener((state, elapsed) => {
          const active = state === 'working'
          container.visible = active
          if (!active) return

          const transition =
            elapsed < WORK_TRANSITION_MS
              ? smoothStep(elapsed / WORK_TRANSITION_MS)
              : elapsed > WORK_DURATION_MS - WORK_TRANSITION_MS
                ? smoothStep((WORK_DURATION_MS - elapsed) / WORK_TRANSITION_MS)
                : 1
          book.coordinates = {
            left: 94,
            top: 202 - 14 * transition,
            width: 132,
            height: bookY(48),
          }

          const dots = Math.floor(elapsed / 350) % 4
          label.string = `Working${dots === 0 ? '' : ` ${'.'.repeat(dots)}`}`

          const pagePhase = elapsed % (WORK_LINE_MS * 2)
          const turnDuration = 1200
          pageTurn.visible = pagePhase >= WORK_LINE_MS * 2 - turnDuration
          if (pageTurn.visible) {
            const progress = (pagePhase - (WORK_LINE_MS * 2 - turnDuration)) / turnDuration
            const width = Math.max(3, Math.round(60 * Math.abs(Math.cos(Math.PI * progress))))
            pageTurn.coordinates = {
              left: progress < 0.5 ? 66 : 66 - width,
              top: bookY(5) - Math.round(9 * Math.sin(Math.PI * progress)),
              width,
              height: bookY(38) + Math.round(6 * Math.sin(Math.PI * progress)),
            }
          }
        })
      }
    },
  }
})

function applyLookPose(elapsed, face) {
  let x = 0
  let leftY = 0
  let rightY = 0
  let previous = LOOK_KEYFRAMES[0]
  for (let index = 1; index < LOOK_KEYFRAMES.length; index += 1) {
    const next = LOOK_KEYFRAMES[index]
    if (elapsed < next[0]) {
      const progress = smoothStep((elapsed - previous[0]) / (next[0] - previous[0]))
      x = previous[1] + (next[1] - previous[1]) * progress
      leftY = previous[2] + (next[2] - previous[2]) * progress
      rightY = previous[3] + (next[3] - previous[3]) * progress
      break
    }
    previous = next
  }

  face.emotion = Emotion.NEUTRAL
  face.eyes.left.open = 1
  face.eyes.right.open = 1
  face.eyes.left.gazeX = x / 2
  face.eyes.right.gazeX = x / 2
  face.eyes.left.gazeY = leftY / 2
  face.eyes.right.gazeY = rightY / 2
}

function getSingleBlinkOpen(elapsed) {
  if (elapsed < BLINK_CLOSE_MS) {
    return 1 - smoothStep(elapsed / BLINK_CLOSE_MS)
  }
  if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
  return smoothStep((elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS)
}

function getBlinkOpen(elapsed) {
  if (elapsed < SINGLE_BLINK_DURATION_MS) return getSingleBlinkOpen(elapsed)
  if (elapsed < SECOND_BLINK_START_MS) return 1
  if (elapsed < SECOND_BLINK_START_MS + SINGLE_BLINK_DURATION_MS) {
    return getSingleBlinkOpen(elapsed - SECOND_BLINK_START_MS)
  }
  return 1
}

function applyMoodPose(face, emotion, progress) {
  face.emotion = emotion
  face.eyes.left.open = progress
  face.eyes.right.open = progress
  face.eyes.left.gazeX = 0
  face.eyes.right.gazeX = 0
  face.eyes.left.gazeY = 0
  face.eyes.right.gazeY = 0
}

function applyIdlePose(face, eyeOpen = 1) {
  face.emotion = Emotion.NEUTRAL
  face.eyes.left.open = eyeOpen
  face.eyes.right.open = eyeOpen
  face.eyes.left.gazeX = 0
  face.eyes.right.gazeX = 0
  face.eyes.left.gazeY = 0
  face.eyes.right.gazeY = 0
}

function applyMoodAnimation(face, emotion, elapsed) {
  const progress =
    elapsed < MOOD_TRANSITION_MS
      ? smoothStep(elapsed / MOOD_TRANSITION_MS)
      : elapsed > MOOD_DURATION_MS - MOOD_TRANSITION_MS
        ? smoothStep((MOOD_DURATION_MS - elapsed) / MOOD_TRANSITION_MS)
        : 1
  applyMoodPose(face, emotion, progress)
}

function applyWorkingPose(face, elapsed) {
  const lineElapsed = elapsed % WORK_LINE_MS
  const scanProgress = smoothStep(Math.min(1, lineElapsed / (WORK_LINE_MS - 450)))
  const transition =
    elapsed < WORK_TRANSITION_MS
      ? smoothStep(elapsed / WORK_TRANSITION_MS)
      : elapsed > WORK_DURATION_MS - WORK_TRANSITION_MS
        ? smoothStep((WORK_DURATION_MS - elapsed) / WORK_TRANSITION_MS)
        : 1
  const x = (-20 + 40 * scanProgress) * transition
  const y = 12 * transition
  const eyeOpen =
    lineElapsed >= WORK_BLINK_START_MS && lineElapsed < WORK_BLINK_START_MS + SINGLE_BLINK_DURATION_MS
      ? getSingleBlinkOpen(lineElapsed - WORK_BLINK_START_MS)
      : 1

  face.emotion = Emotion.NEUTRAL
  face.eyes.left.open = eyeOpen
  face.eyes.right.open = eyeOpen
  face.eyes.left.gazeX = x / 2
  face.eyes.right.gazeX = x / 2
  face.eyes.left.gazeY = y / 2
  face.eyes.right.gazeY = y / 2
}

function isAnimationName(value) {
  return typeof value === 'string' && ANIMATION_NAMES.includes(value)
}

function createAnimationStateMachine() {
  let state = 'idle'
  let elapsed = 0
  let randomEnabled = true
  let visualListener = null
  let wakeEnabled = false
  let wakeError = null
  let wakeHitCount = 0
  let lastWakePhrase = null
  let wakeWord = null

  const notifyVisuals = () => visualListener?.(state, elapsed)

  const enter = (nextState) => {
    state = nextState
    elapsed = 0
    notifyVisuals()
  }

  const durationFor = () => {
    switch (state) {
      case 'blink':
        return BLINK_DURATION_MS
      case 'lookAround':
        return LOOK_DURATION_MS
      case 'happy':
      case 'angry':
        return MOOD_DURATION_MS
      case 'working':
        return WORK_DURATION_MS
      default:
        return null
    }
  }

  const status = () => ({
    version: 1,
    state,
    randomEnabled,
    elapsedMs: Math.round(elapsed),
    durationMs: durationFor(),
    nextRandomInMs: state === 'idle' && randomEnabled ? Math.max(0, Math.round(IDLE_DECISION_MS - elapsed)) : null,
    wakeEnabled,
    wakeError,
    wakeHitCount,
    lastWakePhrase,
    wakeStats: wakeWord?.stats() ?? null,
  })

  const onWakeDetected = (phrase) => {
    wakeHitCount += 1
    lastWakePhrase = phrase
    enter('happy')
  }

  const setWake = (value, persist = true) => {
    if (typeof value !== 'boolean') throw new Error('wake mode must be boolean')
    wakeError = null
    if (value !== wakeEnabled) {
      if (value) {
        try {
          wakeWord = new MicroWakeWord(onWakeDetected)
          wakeWord.start()
          wakeEnabled = true
        } catch (error) {
          wakeWord?.close()
          wakeWord = null
          wakeEnabled = false
          wakeError = String(error)
        }
      } else {
        wakeWord?.close()
        wakeWord = null
        wakeEnabled = false
      }
    }
    if (persist) Preference.set('chymod', 'wake', wakeEnabled)
    return status()
  }

  return {
    play(value) {
      if (!isAnimationName(value)) throw new Error('invalid animation')
      enter(value)
      return status()
    },
    setRandom(value) {
      if (typeof value !== 'boolean') throw new Error('random mode must be boolean')
      randomEnabled = value
      if (state === 'idle') elapsed = 0
      return status()
    },
    setWake,
    setVisualListener(listener) {
      visualListener = listener
      notifyVisuals()
    },
    status,
    tick(tickMillis, face) {
      elapsed += tickMillis
      if (state === 'idle' && randomEnabled && elapsed >= IDLE_DECISION_MS) {
        enter(ANIMATION_NAMES[Math.floor(Math.random() * ANIMATION_NAMES.length)])
      } else {
        const duration = durationFor()
        if (duration !== null && elapsed >= duration) enter('idle')
      }

      switch (state) {
        case 'blink':
          applyIdlePose(face, getBlinkOpen(elapsed))
          break
        case 'lookAround':
          applyLookPose(elapsed, face)
          break
        case 'happy':
          applyMoodAnimation(face, Emotion.HAPPY, elapsed)
          break
        case 'angry':
          applyMoodAnimation(face, Emotion.ANGRY, elapsed)
          break
        case 'working':
          applyWorkingPose(face, elapsed)
          break
        default:
          applyIdlePose(face)
          break
      }
      notifyVisuals()
    },
  }
}

function createAnimationMotion(machine) {
  return (tickMillis, face) => machine.tick(tickMillis, face)
}

/**
 * The app drives each servo with a critically damped spring whose stiffness is
 * 10 + (speed / 1000)^2 * 640. Such a spring settles in about 5.83 / sqrt(stiffness)
 * seconds whatever the distance, which is the goal time our servos understand.
 */
function motionSpeedToSeconds(speed) {
  const normalized = speed / 1000
  return 5.83 / Math.sqrt(10 + normalized * normalized * 640)
}

function readMotionInteger(value, limit, name) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  return Math.max(limit.min, Math.min(limit.max, value))
}

function readMotionServo(value, name) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') throw new Error(`${name} must be an object`)
  return value
}

/**
 * Accepts the app's `controlMotion` JSON:
 * `{ yawServo: { angle | rotate, speed }, pitchServo: { angle, speed } }`.
 * Joystick drags arrive faster than the servo bus can take them, so commands are
 * coalesced: only the latest target is sent once the previous move is accepted.
 */
function createMotionControl(motion) {
  const rotateSupported = typeof motion.rotateYaw === 'function'
  const yaw = { mode: 'angle', angle: 0, speed: MOTION_DEFAULT_SPEED, rotate: 0 }
  const pitch = { angle: 0, speed: MOTION_DEFAULT_SPEED }
  let torque = false
  let running = false
  let error = null
  let pendingPose = false
  let pendingRotate = false
  let pendingSeconds = 0
  let pendingRelease = false
  let releaseTimer
  let retried = false
  let timeouts = 0

  const status = () => ({
    yaw: { ...yaw },
    pitch: { ...pitch },
    torque,
    moving: running,
    rotateSupported,
    error,
    timeouts,
  })

  // The app firmware never waits for servo replies, so a lost or late reply goes unnoticed
  // there. Do the same: a servo timeout is counted, not reported, since the next command
  // overwrites the target anyway. The driver writes pan before tilt and stops at the first
  // failure, so the move is retried once to make sure the last position of a drag lands.
  const isServoTimeout = (cause) => String(cause).includes('timed out')

  const clearReleaseTimer = () => {
    if (releaseTimer === undefined) return
    Timer.clear(releaseTimer)
    releaseTimer = undefined
  }

  // The pan and tilt servos share one half-duplex bus, but each SCServo queues only
  // its own commands. Every bus write therefore goes through drain(), one at a time:
  // a torque release sent beside a new move collides on the wire and times out.
  const scheduleTorqueRelease = (seconds) => {
    clearReleaseTimer()
    releaseTimer = Timer.set(
      () => {
        releaseTimer = undefined
        pendingRelease = true
        if (!running) void drain()
      },
      Math.round(seconds * 1000) + MOTION_TORQUE_RELEASE_MS,
    )
  }

  const drain = async () => {
    running = true
    try {
      while (pendingPose || pendingRotate || pendingRelease) {
        if (!pendingPose && !pendingRotate) {
          pendingRelease = false
          if (torque) {
            try {
              await motion.setTorque(false)
            } catch (cause) {
              if (!isServoTimeout(cause)) throw cause
              timeouts += 1
            }
            torque = false
          }
          continue
        }

        const pose = pendingPose
        // A pose moves both axes and takes yaw out of PWM mode, so a spinning yaw is restarted after it.
        const rotate = pendingRotate || (pose && yaw.mode === 'rotate')
        const seconds = pendingSeconds
        pendingPose = false
        pendingRotate = false
        pendingRelease = false
        pendingSeconds = 0
        clearReleaseTimer()
        try {
          if (!torque) {
            await motion.setTorque(true)
            torque = true
          }
          motion.lookAway()
          if (pose) {
            await motion.setPose(
              {
                position: { x: 0, y: 0, z: 0 },
                rotation: { y: yaw.angle / DECIDEGREES_PER_RADIAN, p: -pitch.angle / DECIDEGREES_PER_RADIAN, r: 0 },
              },
              seconds,
            )
          }
          if (rotate) await motion.rotateYaw(yaw.rotate)
          retried = false
        } catch (cause) {
          if (!isServoTimeout(cause)) throw cause
          timeouts += 1
          // The lost write may have been the torque enable, so enable it again with the retry.
          torque = false
          if (!retried) {
            retried = true
            // yaw and pitch still hold the latest target; a newer command merges into this retry.
            pendingPose = pendingPose || pose
            pendingRotate = pendingRotate || rotate
            pendingSeconds = Math.max(pendingSeconds, seconds)
            continue
          }
          retried = false
        }
        error = null
        if (yaw.mode !== 'rotate' || yaw.rotate === 0) scheduleTorqueRelease(pose ? seconds : 0)
      }
    } catch (cause) {
      error = String(cause)
      // A failed command leaves the torque state unknown; re-enable it before the next move.
      torque = false
    } finally {
      running = false
    }
  }

  const request = (value) => {
    if (value === null || typeof value !== 'object') throw new Error('motion must be an object')
    const yawServo = readMotionServo(value.yawServo, 'yawServo')
    const pitchServo = readMotionServo(value.pitchServo, 'pitchServo')
    // Validate the whole command before changing any state.
    const yawRotate = readMotionInteger(yawServo?.rotate, MOTION_ROTATE_LIMIT, 'yawServo.rotate')
    const yawAngle = readMotionInteger(yawServo?.angle, MOTION_YAW_ANGLE_LIMIT, 'yawServo.angle')
    const yawSpeed = readMotionInteger(yawServo?.speed, MOTION_SPEED_LIMIT, 'yawServo.speed')
    const pitchAngle = readMotionInteger(pitchServo?.angle, MOTION_PITCH_ANGLE_LIMIT, 'pitchServo.angle')
    const pitchSpeed = readMotionInteger(pitchServo?.speed, MOTION_SPEED_LIMIT, 'pitchServo.speed')
    if (yawRotate !== undefined && !rotateSupported) {
      throw new Error('this firmware does not support continuous yaw rotation')
    }

    // Same precedence as the app firmware's update_servo: rotate first, then angle.
    // A missing speed falls back to the default spring, which matches speed 500.
    if (yawRotate !== undefined) {
      yaw.mode = 'rotate'
      yaw.rotate = yawRotate
      if (yawSpeed !== undefined) yaw.speed = yawSpeed
      pendingRotate = true
    } else if (yawAngle !== undefined) {
      yaw.mode = 'angle'
      yaw.angle = yawAngle
      yaw.rotate = 0
      yaw.speed = yawSpeed ?? MOTION_DEFAULT_SPEED
      pendingPose = true
      pendingSeconds = Math.max(pendingSeconds, motionSpeedToSeconds(yaw.speed))
    }
    // The app's pitch servo cannot spin, so a pitch rotate is ignored like Servo::rotate does.
    if (pitchAngle !== undefined) {
      pitch.angle = pitchAngle
      pitch.speed = pitchSpeed ?? MOTION_DEFAULT_SPEED
      pendingPose = true
      pendingSeconds = Math.max(pendingSeconds, motionSpeedToSeconds(pitch.speed))
    }
    if (!running && (pendingPose || pendingRotate)) void drain()
    return status()
  }

  const descriptor = () => ({
    id: 'motion',
    kind: 'motion',
    command: 'chymod.motion',
    yaw: {
      angle: MOTION_YAW_ANGLE_LIMIT,
      speed: MOTION_SPEED_LIMIT,
      rotate: rotateSupported ? MOTION_ROTATE_LIMIT : null,
    },
    pitch: { angle: MOTION_PITCH_ANGLE_LIMIT, speed: MOTION_SPEED_LIMIT },
    defaultSpeed: MOTION_DEFAULT_SPEED,
  })

  return { descriptor, request, status }
}

function registerChyModControls(machine, motionControl) {
  const withMotion = (result) => ({ ...result, motion: motionControl.status() })
  registerUSBControlNamespace(
    'chymod',
    ['describe', 'play', 'status', 'random', 'wake', 'motion'],
    (command, value) => {
      switch (command) {
        case 'describe':
          return {
            version: 1,
            controls: [
              {
                id: 'animation',
                kind: 'actions',
                command: 'chymod.play',
                options: ANIMATION_NAMES,
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
              motionControl.descriptor(),
            ],
          }
        case 'play':
          return withMotion(machine.play(value))
        case 'status':
          return withMotion(machine.status())
        case 'random':
          return withMotion(machine.setRandom(value))
        case 'wake':
          return withMotion(machine.setWake(value))
        case 'motion':
          motionControl.request(value)
          return withMotion(machine.status())
        default:
          throw new Error('unsupported ChyMOD command')
      }
    },
  )
}

const CapsuleFace = FaceBase.template(($ = {}) => ({
  left: $.left ?? 60,
  top: $.top ?? 60,
  width: $.width ?? 200,
  height: $.height ?? 120,
  motions: [createAnimationMotion($.machine)],
  contents: [
    new MoodEye({ cx: 56, cy: 60, side: 'left' }),
    new MoodEye({ cx: 144, cy: 60, side: 'right' }),
    new MoodMark({ key: 'heart', emotion: Emotion.HAPPY, left: 0, top: 0, size: 34 }),
    new MoodMark({ key: 'angry', emotion: Emotion.ANGRY, left: 0, top: 0, size: 34 }),
  ],
}))

export function onContextCreated(robot, option) {
  const machine = createAnimationStateMachine()
  registerChyModControls(machine, createMotionControl(robot.motion))
  // A MOD hook replaces the host hook, so preserve the host's USB controls and
  // other standard runtime services before installing the custom face.
  initializeDefaultContext(robot, option)
  robot.ui.setFace(new CapsuleFace({ machine }))
  robot.ui.addEffect(new WorkingEffect({ machine }), 'chymod-working')
  robot.face.setColor('primary', 0xff, 0xff, 0xff)
  robot.face.setColor('secondary', 0x00, 0x00, 0x00)
  if (Preference.get('chymod', 'wake') === true) machine.setWake(true, false)
}
