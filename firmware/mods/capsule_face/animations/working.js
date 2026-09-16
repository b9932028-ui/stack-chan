import { smoothStep } from 'capsule-face-animations/shared'
import { Emotion } from 'face-state'
import { getFillSkin } from 'parts/shape-utils'

const DURATION_MS = 15000
const TRANSITION_MS = 500
const LINE_MS = 2400
const BLINK_START_MS = 2050
const SINGLE_BLINK_DURATION_MS = 300
const BLINK_CLOSE_MS = 90
const BLINK_HOLD_MS = 40
const BLINK_OPEN_MS = SINGLE_BLINK_DURATION_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS

const primarySkin = getFillSkin(0xffffff)
const secondarySkin = getFillSkin(0x000000)
const labelStyle = new Style({
  font: 'OpenSans-Regular-24',
  color: '#ffffff',
  horizontal: 'left',
  vertical: 'middle',
})

function getSingleBlinkOpen(elapsed) {
  if (elapsed < BLINK_CLOSE_MS) return 1 - smoothStep(elapsed / BLINK_CLOSE_MS)
  if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
  return smoothStep((elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS)
}

export const WorkingEffect = Container.template((opts) => {
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
      new Content(null, { left: 0, top: 0, bottom: 0, width: 2, skin: secondarySkin }),
      bookPart(5, 10, 42, 2, secondarySkin),
      bookPart(5, 20, 34, 2, secondarySkin),
    ],
  })
  const book = new Container(null, {
    left: 94,
    top: 188,
    width: 132,
    height: bookY(48),
    contents: [
      bookPart(0, 4, 64, 40, primarySkin),
      bookPart(68, 4, 64, 40, primarySkin),
      bookPart(4, 44, 58, 3, primarySkin),
      bookPart(70, 44, 58, 3, primarySkin),
      bookPart(65, 8, 3, 36, secondarySkin),
      bookPart(10, 14, 44, 2, secondarySkin),
      bookPart(10, 24, 38, 2, secondarySkin),
      bookPart(78, 14, 44, 2, secondarySkin),
      bookPart(84, 24, 38, 2, secondarySkin),
      pageTurn,
    ],
  })
  const label = new Label(null, {
    left: 94,
    width: 150,
    top: 18,
    height: 32,
    string: 'Working',
    style: labelStyle,
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
            elapsed < TRANSITION_MS
              ? smoothStep(elapsed / TRANSITION_MS)
              : elapsed > DURATION_MS - TRANSITION_MS
                ? smoothStep((DURATION_MS - elapsed) / TRANSITION_MS)
                : 1
          book.coordinates = {
            left: 94,
            top: 202 - 14 * transition,
            width: 132,
            height: bookY(48),
          }

          const dots = Math.floor(elapsed / 350) % 4
          label.string = `Working${dots === 0 ? '' : ` ${'.'.repeat(dots)}`}`

          const pagePhase = elapsed % (LINE_MS * 2)
          const turnDuration = 1200
          pageTurn.visible = pagePhase >= LINE_MS * 2 - turnDuration
          if (pageTurn.visible) {
            const progress = (pagePhase - (LINE_MS * 2 - turnDuration)) / turnDuration
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

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const lineElapsed = elapsed % LINE_MS
    const scanProgress = smoothStep(Math.min(1, lineElapsed / (LINE_MS - 450)))
    const transition =
      elapsed < TRANSITION_MS
        ? smoothStep(elapsed / TRANSITION_MS)
        : elapsed > DURATION_MS - TRANSITION_MS
          ? smoothStep((DURATION_MS - elapsed) / TRANSITION_MS)
          : 1
    const x = (-20 + 40 * scanProgress) * transition
    const y = 12 * transition
    const eyeOpen =
      lineElapsed >= BLINK_START_MS && lineElapsed < BLINK_START_MS + SINGLE_BLINK_DURATION_MS
        ? getSingleBlinkOpen(lineElapsed - BLINK_START_MS)
        : 1

    face.emotion = Emotion.NEUTRAL
    face.eyes.left.open = eyeOpen
    face.eyes.right.open = eyeOpen
    face.eyes.left.gazeX = x / 2
    face.eyes.right.gazeX = x / 2
    face.eyes.left.gazeY = y / 2
    face.eyes.right.gazeY = y / 2
  },
})
