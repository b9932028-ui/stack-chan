import { onContextCreated as initializeDefaultContext } from 'app-default-behavior/on-context-created'
import { FaceBase } from 'behaviors/face'
import { Outline } from 'commodetto/outline'
import { Emoticon } from 'effects/emoticon'
import { Emotion } from 'face-state'
import { getFillSkin } from 'parts/shape-utils'
import { defineShapeTemplate } from 'template'
import { registerUSBControlNamespace } from 'usb-control-registry'

const ANIMATION_NAMES = ['idle', 'blink', 'lookAround', 'happy', 'angry']
const IDLE_DECISION_MS = 3000
const BLINK_DURATION_MS = 300
const LOOK_DURATION_MS = 7600
const MOOD_DURATION_MS = 3000
const MOOD_TRANSITION_MS = 450

const LOOK_X_OFFSET_PX = 27
const BLINK_CLOSE_MS = 90
const BLINK_HOLD_MS = 40
const BLINK_OPEN_MS = BLINK_DURATION_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS
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

function getBlinkOpen(elapsed) {
  if (elapsed < BLINK_CLOSE_MS) {
    return 1 - smoothStep(elapsed / BLINK_CLOSE_MS)
  }
  if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
  return smoothStep((elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS)
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

function isAnimationName(value) {
  return typeof value === 'string' && ANIMATION_NAMES.includes(value)
}

function createAnimationStateMachine() {
  let state = 'idle'
  let elapsed = 0
  let randomEnabled = true

  const enter = (nextState) => {
    state = nextState
    elapsed = 0
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
  })

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
        default:
          applyIdlePose(face)
          break
      }
    },
  }
}

function createAnimationMotion(machine) {
  return (tickMillis, face) => machine.tick(tickMillis, face)
}

function registerChyModControls(machine) {
  registerUSBControlNamespace('chymod', ['describe', 'play', 'status', 'random'], (command, value) => {
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
            },
          ],
        }
      case 'play':
        return machine.play(value)
      case 'status':
        return machine.status()
      case 'random':
        return machine.setRandom(value)
      default:
        throw new Error('unsupported ChyMOD command')
    }
  })
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
  registerChyModControls(machine)
  // A MOD hook replaces the host hook, so preserve the host's USB controls and
  // other standard runtime services before installing the custom face.
  initializeDefaultContext(robot, option)
  robot.ui.setFace(new CapsuleFace({ machine }))
  robot.face.setColor('primary', 0xff, 0xff, 0xff)
  robot.face.setColor('secondary', 0x00, 0x00, 0x00)
}
