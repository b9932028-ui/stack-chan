import { onContextCreated as initializeDefaultContext } from 'app-default-behavior/on-context-created'
import { FaceBase } from 'behaviors/face'
import { Outline } from 'commodetto/outline'
import { Emoticon } from 'effects/emoticon'
import { Emotion } from 'face-state'
import { getFillSkin } from 'parts/shape-utils'
import { defineShapeTemplate } from 'template'
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
              statusKey: 'randomEnabled',
              label: 'Enable random animation every 3 seconds',
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
  robot.ui.addEffect(new WorkingEffect({ machine }), 'chymod-working')
  robot.face.setColor('primary', 0xff, 0xff, 0xff)
  robot.face.setColor('secondary', 0x00, 0x00, 0x00)
}
