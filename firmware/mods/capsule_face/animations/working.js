import { applyNeutralPose, smoothStep } from 'capsule-face-animations/shared'
import { Emotion } from 'face-state'
import { getFillSkin } from 'parts/shape-utils'

const DURATION_MS = 15000
const TRANSITION_MS = 500
const CLOSE_START_MS = 12000
const CLOSE_DURATION_MS = 700
const DONE_START_MS = CLOSE_START_MS + CLOSE_DURATION_MS
const LINE_MS = 2400
const BLINK_START_MS = 2050
const SINGLE_BLINK_DURATION_MS = 300
const BLINK_CLOSE_MS = 90
const BLINK_HOLD_MS = 40
const BLINK_OPEN_MS = SINGLE_BLINK_DURATION_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS
const PAGE_TURN_FRAME_MS = 67

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
  const closedBook = new Container(null, {
    left: 94,
    top: 188,
    width: 132,
    height: bookY(48),
    visible: false,
    skin: primarySkin,
    contents: [
      new Content(null, { left: 5, right: 5, top: 5, height: 2, skin: secondarySkin }),
      new Content(null, { left: 5, right: 5, bottom: 5, height: 2, skin: secondarySkin }),
    ],
  })
  let bookLeft = 94
  let bookTop = 188
  let closedBookLeft = 94
  let closedBookTop = 188
  let closedBookWidth = 132
  let closedBookHeight = bookY(48)
  let pageTurnLeft = 70
  let pageTurnTop = bookY(5)
  let pageTurnWidth = 56
  let pageTurnHeight = bookY(38)
  let lastPageTurnFrame = -1
  let lastLabel = 'Working'

  const setBookPosition = (left, top) => {
    if (left === bookLeft && top === bookTop) return
    bookLeft = left
    bookTop = top
    book.coordinates = { left, top, width: 132, height: bookY(48) }
  }

  const setClosedBookBounds = (left, top, width, height) => {
    if (left === closedBookLeft && top === closedBookTop && width === closedBookWidth && height === closedBookHeight)
      return
    closedBookLeft = left
    closedBookTop = top
    closedBookWidth = width
    closedBookHeight = height
    closedBook.coordinates = { left, top, width, height }
  }

  const setPageTurnBounds = (left, top, width, height) => {
    if (left === pageTurnLeft && top === pageTurnTop && width === pageTurnWidth && height === pageTurnHeight) return
    pageTurnLeft = left
    pageTurnTop = top
    pageTurnWidth = width
    pageTurnHeight = height
    pageTurn.coordinates = { left, top, width, height }
  }

  return {
    left: 0,
    top: 0,
    width: 320,
    height: 240,
    visible: false,
    contents: [book, closedBook, label],
    Behavior: class extends Behavior {
      onCreate(container) {
        opts.machine.addVisualListener((state, elapsed) => {
          const active = state === 'working' && elapsed < DURATION_MS
          if (container.visible !== active) container.visible = active
          if (!active) return

          const transition =
            elapsed < TRANSITION_MS
              ? smoothStep(elapsed / TRANSITION_MS)
              : elapsed > DURATION_MS - TRANSITION_MS
                ? smoothStep((DURATION_MS - elapsed) / TRANSITION_MS)
                : 1
          const closing = elapsed >= CLOSE_START_MS
          const closeProgress = smoothStep(Math.max(0, Math.min(1, (elapsed - CLOSE_START_MS) / CLOSE_DURATION_MS)))
          if (book.visible === closing) book.visible = !closing
          if (closedBook.visible !== closing) closedBook.visible = closing
          if (closing) {
            const closedWidth = Math.round(132 - 66 * closeProgress)
            setClosedBookBounds(
              Math.round(160 - closedWidth / 2),
              Math.round(202 - 14 * transition),
              closedWidth,
              Math.round(bookY(48) - 20 * closeProgress),
            )
          } else setBookPosition(94, Math.round(202 - 14 * transition))

          const dots = Math.floor(elapsed / 350) % 4
          const nextLabel = elapsed >= DONE_START_MS ? 'Done!' : `Working${dots === 0 ? '' : ` ${'.'.repeat(dots)}`}`
          if (nextLabel !== lastLabel) {
            lastLabel = nextLabel
            label.string = nextLabel
          }
          const labelVisible = elapsed < DURATION_MS - TRANSITION_MS
          if (label.visible !== labelVisible) label.visible = labelVisible

          const pagePhase = elapsed % (LINE_MS * 2)
          const turnDuration = 1200
          const pageTurnActive = pagePhase >= LINE_MS * 2 - turnDuration
          if (pageTurn.visible !== pageTurnActive) pageTurn.visible = pageTurnActive
          if (pageTurnActive) {
            const pageTurnFrame = Math.floor(elapsed / PAGE_TURN_FRAME_MS)
            if (pageTurnFrame === lastPageTurnFrame) return
            lastPageTurnFrame = pageTurnFrame
            const progress = (pagePhase - (LINE_MS * 2 - turnDuration)) / turnDuration
            const width = Math.max(3, Math.round(60 * Math.abs(Math.cos(Math.PI * progress))))
            setPageTurnBounds(
              progress < 0.5 ? 66 : 66 - width,
              bookY(5) - Math.round(9 * Math.sin(Math.PI * progress)),
              width,
              bookY(38) + Math.round(6 * Math.sin(Math.PI * progress)),
            )
          } else lastPageTurnFrame = -1
        })
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    if (elapsed >= DURATION_MS) {
      applyNeutralPose(face)
      return
    }
    if (elapsed >= CLOSE_START_MS) {
      // Settle the reading gaze while closing, smile, then morph back to idle.
      const settle = smoothStep(Math.min(1, (elapsed - CLOSE_START_MS) / CLOSE_DURATION_MS))
      applyNeutralPose(face)
      face.eyes.left.gazeY = face.eyes.right.gazeY = 6 * (1 - settle)
      if (elapsed >= DONE_START_MS) {
        const smile = Math.min(1, (elapsed - DONE_START_MS) / TRANSITION_MS, (DURATION_MS - elapsed) / TRANSITION_MS)
        face.emotion = Emotion.HAPPY
        face.eyes.left.open = face.eyes.right.open = smoothStep(Math.max(0, smile))
      }
      return
    }
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
