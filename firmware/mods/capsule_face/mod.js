import Resource from 'Resource'
import { onContextCreated as initializeDefaultContext } from 'app-default-behavior/on-context-created'
import { FaceBase } from 'behaviors/face'
import {
  ANIMATION_NAMES,
  ANIMATIONS,
  ListeningEffect,
  MicrosoftEffect,
  PLAY_ANIMATION_NAMES,
  RANDOM_ANIMATION_NAMES,
  RainbowEffect,
  SpeakingEffect,
  TEAMS_PRESENCES,
  TeamsEffect,
  ThinkingEffect,
  WaitingInputEffect,
  WorkingEffect,
} from 'capsule-face-animations/index'
import { Outline } from 'commodetto/outline'
import { Emoticon } from 'effects/emoticon'
import { Emotion } from 'face-state'
import MicroWakeWord from 'micro-wake-word'
import Modules from 'modules'
import { getFillSkin } from 'parts/shape-utils'
import Preference from 'preference'
import Speaker from 'speaker'
import { defineShapeTemplate } from 'template'
import Timer from 'timer'
import { registerUSBControlNamespace } from 'usb-control-registry'

const IDLE_DECISION_MS = 3000

// Acknowledgement chime for "Hey Copilot". The microphone and the speaker share
// I2S port 1, so the chime has to finish before the utterance is recorded; see
// the CoreS3 Speaker Amplifier Contract in AGENTS.md.
const WAKE_CHIME_RESOURCE = 'wake-chime.wav'
// The shared Speaker built by the host follows the TTS volume preference, which
// is low enough that the chime disappears, so this MOD owns its own playback level.
// The asset peaks near full scale; the CoreS3 amplifier distorts on a sustained tone
// at that level, so play it 8 dB down. Speech survives it because it is not sustained.
const WAKE_CHIME_VOLUME = 0.4
// Hand over to listening halfway through "happy": waiting out the whole reaction
// read as a stall before the robot started hearing anything.
const WAKE_REACTION_MILLISECONDS = Math.round(ANIMATIONS.happy.duration / 2)

// Motion panel ported from the M5Stack StackChan app. Angles are in 0.1 degrees,
// the same unit and ranges as the app and its servo configuration.
const MOTION_YAW_ANGLE_LIMIT = Object.freeze({ min: -1280, max: 1280 })
const MOTION_PITCH_ANGLE_LIMIT = Object.freeze({ min: 0, max: 900 })
const MOTION_SPEED_LIMIT = Object.freeze({ min: 0, max: 1000 })
const MOTION_ROTATE_LIMIT = Object.freeze({ min: -1000, max: 1000 })
const MOTION_DEFAULT_SPEED = 500
// "Wake up orientation" turns at the middle of the speed range, about 0.45 s per move.
const WAKE_ORIENTATION_SPEED = MOTION_DEFAULT_SPEED
const WAKE_ORIENTATION_KEY = 'wakeOrientation'
// The app firmware releases torque once a servo is at rest, checking every 200 ms.
const MOTION_TORQUE_RELEASE_MS = 200
const DECIDEGREES_PER_RADIAN = 1800 / Math.PI

const EYE_WIDTH = 28
const EYE_HEIGHT = 64
const EYE_CANVAS_WIDTH = 84
const EYE_CANVAS_HEIGHT = 104
const EYE_BASE_LEFT = (EYE_CANVAS_WIDTH - EYE_WIDTH) / 2
const EYE_BASE_TOP = (EYE_CANVAS_HEIGHT - EYE_HEIGHT) / 2
const MORPH_STEPS = 8
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

function isAnimationName(value) {
  return typeof value === 'string' && ANIMATION_NAMES.includes(value)
}

/**
 * Heap figures from the host's native helper. USB playback has been aborting the
 * main machine with "Chunk allocation: failed", which is the system allocator
 * refusing, so the status report carries what memory looked like at the time.
 */
function readMemory() {
  try {
    if (!Modules.has('stackchan-crash-diagnostics')) return null
    return Modules.importNow('stackchan-crash-diagnostics')()
  } catch (error) {
    trace(`[chymod] memory diagnostics unavailable: ${error}\n`)
    return null
  }
}

/** Stored as "yaw,pitch" so the preference stays a plain string. */
function readWakeOrientationPreference() {
  const stored = Preference.get('chymod', WAKE_ORIENTATION_KEY)
  if (typeof stored !== 'string') return null
  const parts = stored.split(',')
  if (parts.length !== 2) return null
  const yaw = Number(parts[0])
  const pitch = Number(parts[1])
  if (!Number.isInteger(yaw) || !Number.isInteger(pitch)) return null
  return { yaw, pitch }
}

/**
 * `conversation` is the USB voice link: `isConnected()` reports whether a host is
 * attached, `start()` asks it to record, and `orient(yaw, pitch)` aims the head.
 */
function createAnimationStateMachine(conversation) {
  let state = 'idle'
  let elapsed = 0
  let randomEnabled = false
  const visualListeners = []
  let wakeEnabled = false
  let wakeError = null
  let wakeHitCount = 0
  let lastWakePhrase = null
  let wakeWord = null
  let chimeSpeaker = null
  let wakeOrientation = readWakeOrientationPreference()
  let teamsStatus = { presence: 'available', message: 'WFH' }
  const teamsStatusListeners = []
  // A held animation loops until another state is entered; a completion callback
  // replaces the usual return to idle when a one-shot animation finishes.
  let heldState = null
  let stateCompletion = null

  const notifyVisuals = () => {
    for (const listener of visualListeners) listener(state, elapsed)
  }

  const restart = () => {
    elapsed = 0
    notifyVisuals()
  }

  const enter = (nextState) => {
    // Interrupting the wake sequence (a manual animation, say) drops its follow-up,
    // so put the wake word back rather than leaving it closed for good.
    const discarded = stateCompletion
    heldState = null
    stateCompletion = null
    state = nextState
    elapsed = 0
    notifyVisuals()
    if (discarded) resumeWake()
  }

  /**
   * Plays `name` and runs `done` after `at` milliseconds instead of returning to
   * idle. `at` defaults to the whole animation; the wake reaction hands over
   * partway through so the conversation does not wait out the flourish.
   */
  const enterOnce = (name, done, at = ANIMATIONS[name].duration) => {
    enter(name)
    stateCompletion = { at, done }
  }

  /** Plays `name` on a loop until some other state is entered. */
  const hold = (name) => {
    if (heldState === name && state === name) return status()
    enter(name)
    heldState = name
    return status()
  }

  const durationFor = () => ANIMATIONS[state].duration

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
    wakeOrientation: wakeOrientation ? { ...wakeOrientation } : null,
    teamsStatus: { ...teamsStatus },
    wakeStats: wakeWord?.stats() ?? null,
    memory: readMemory(),
  })

  const playWakeChime = () => {
    try {
      if (!chimeSpeaker) chimeSpeaker = new Speaker({ volume: WAKE_CHIME_VOLUME })
      return chimeSpeaker.play(new Resource(WAKE_CHIME_RESOURCE))
    } catch (error) {
      trace(`[chymod] wake chime failed: ${error}\n`)
      return Promise.resolve(false)
    }
  }

  const isConversationReady = () => {
    try {
      return conversation?.isConnected() === true
    } catch (error) {
      trace(`[chymod] conversation transport unavailable: ${error}\n`)
      return false
    }
  }

  const applyWakeOrientation = () => {
    if (!wakeOrientation) return
    try {
      conversation.orient(wakeOrientation.yaw, wakeOrientation.pitch)
    } catch (error) {
      trace(`[chymod] wake orientation failed: ${error}\n`)
    }
  }

  // Recording starts here, once "happy" has played in full: cutting the reaction
  // short looked wrong, and by now the chime has released the shared I2S port.
  const beginListening = () => {
    hold('listening')
    try {
      conversation.start()
    } catch (error) {
      wakeError = String(error)
      enter('idle')
      resumeWake()
    }
  }

  // With no USB host there is nothing to say, so the reaction is the whole response.
  const endWakeReaction = () => {
    enter('idle')
    resumeWake()
  }

  const onWakeDetected = (phrase) => {
    wakeHitCount += 1
    lastWakePhrase = phrase
    wakeWord?.close()
    wakeWord = null
    const conversational = isConversationReady()
    enterOnce('happy', conversational ? beginListening : endWakeReaction, WAKE_REACTION_MILLISECONDS)
    void playWakeChime()
    // The move is issued last even though it is the first thing to happen. A servo
    // command is written immediately and its reply has to be read back by this
    // machine within 120 ms; starting the chime blocks that long on its own
    // (amplifier I2C, then AudioOut installing the I2S driver), so a move issued
    // before it had its reply sitting unread and every wake turn timed out.
    if (conversational) applyWakeOrientation()
  }

  const resumeWake = () => {
    if (!wakeEnabled || wakeWord) return status()
    wakeError = null
    try {
      wakeWord = new MicroWakeWord(onWakeDetected)
      wakeWord.start()
    } catch (error) {
      wakeWord?.close()
      wakeWord = null
      wakeEnabled = false
      wakeError = String(error)
    }
    return status()
  }

  const setWakeOrientation = (value) => {
    if (value === null || value === undefined) {
      wakeOrientation = null
      Preference.delete('chymod', WAKE_ORIENTATION_KEY)
      return status()
    }
    if (typeof value !== 'object') throw new Error('wake orientation must be an object or null')
    const yaw = readMotionInteger(value.yaw, MOTION_YAW_ANGLE_LIMIT, 'yaw')
    const pitch = readMotionInteger(value.pitch, MOTION_PITCH_ANGLE_LIMIT, 'pitch')
    // Either axis left blank means "do not turn on wake", same as clearing it.
    if (yaw === undefined || pitch === undefined) {
      wakeOrientation = null
      Preference.delete('chymod', WAKE_ORIENTATION_KEY)
      return status()
    }
    wakeOrientation = { yaw, pitch }
    Preference.set('chymod', WAKE_ORIENTATION_KEY, `${yaw},${pitch}`)
    return status()
  }

  const setWake = (value, persist = true) => {
    if (typeof value !== 'boolean') throw new Error('wake mode must be boolean')
    wakeError = null
    if (value !== wakeEnabled) {
      if (value) {
        wakeEnabled = true
        resumeWake()
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
    setTeamsStatus(value) {
      if (!value || typeof value !== 'object') throw new Error('Teams status must be an object')
      const presence = value.presence
      const message = value.message
      if (!TEAMS_PRESENCES.includes(presence)) throw new Error('invalid Teams presence')
      if (typeof message !== 'string') throw new Error('Teams message must be a string')
      const trimmedMessage = message.trim()
      if (trimmedMessage.length > 12) throw new Error('Teams message must be 12 characters or fewer')
      teamsStatus = { presence, message: trimmedMessage }
      for (const listener of teamsStatusListeners) listener(teamsStatus)
      enter('teams')
      return status()
    },
    hold,
    resumeWake,
    setWake,
    setWakeOrientation,
    addVisualListener(listener) {
      visualListeners.push(listener)
      listener(state, elapsed)
    },
    addTeamsStatusListener(listener) {
      teamsStatusListeners.push(listener)
      listener(teamsStatus)
    },
    status,
    tick(tickMillis, face) {
      elapsed += tickMillis
      const pending = stateCompletion
      if (pending && elapsed >= pending.at) {
        stateCompletion = null
        pending.done()
      } else if (state === 'idle' && randomEnabled && elapsed >= IDLE_DECISION_MS) {
        enter(RANDOM_ANIMATION_NAMES[Math.floor(Math.random() * RANDOM_ANIMATION_NAMES.length)])
      } else {
        const duration = durationFor()
        if (duration !== null && elapsed >= duration) {
          if (heldState === state) restart()
          else enter('idle')
        }
      }

      ANIMATIONS[state].apply(face, elapsed)
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
    ['describe', 'play', 'status', 'random', 'wake', 'wake-orientation', 'motion', 'teams-status'],
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
                options: PLAY_ANIMATION_NAMES,
              },
              {
                id: 'teamsStatus',
                kind: 'teams-status',
                command: 'chymod.teams-status',
                statusKey: 'teamsStatus',
                presences: TEAMS_PRESENCES,
                maxLength: 12,
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
              {
                id: 'wakeOrientation',
                kind: 'orientation',
                command: 'chymod.wake-orientation',
                statusKey: 'wakeOrientation',
                label: 'Wake up orientation',
                yaw: MOTION_YAW_ANGLE_LIMIT,
                pitch: MOTION_PITCH_ANGLE_LIMIT,
                speed: WAKE_ORIENTATION_SPEED,
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
        case 'wake-orientation':
          return withMotion(machine.setWakeOrientation(value ?? null))
        case 'teams-status':
          return withMotion(machine.setTeamsStatus(value))
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
  const remoteSession = robot.conversation.remoteSession
  const motionControl = createMotionControl(robot.motion)
  const machine = createAnimationStateMachine({
    isConnected: () => remoteSession?.transportState === 'ready',
    start: () => remoteSession.requestStart(),
    orient: (yaw, pitch) =>
      motionControl.request({
        yawServo: { angle: yaw, speed: WAKE_ORIENTATION_SPEED },
        pitchServo: { angle: pitch, speed: WAKE_ORIENTATION_SPEED },
      }),
  })
  registerChyModControls(machine, motionControl)
  // A MOD hook replaces the host hook, so preserve the host's USB controls and
  // other standard runtime services before installing the custom face.
  initializeDefaultContext(robot, option)
  robot.ui.setFace(new CapsuleFace({ machine }))
  robot.ui.addEffect(new WorkingEffect({ machine }), 'chymod-working')
  robot.ui.addEffect(new ListeningEffect({ machine }), 'chymod-listening')
  robot.ui.addEffect(new SpeakingEffect({ machine }), 'chymod-speaking')
  robot.ui.addEffect(new TeamsEffect({ machine }), 'chymod-teams')
  robot.ui.addEffect(new ThinkingEffect({ machine }), 'chymod-thinking')
  robot.ui.addEffect(new WaitingInputEffect({ machine }), 'chymod-waiting-input')
  robot.ui.addEffect(new MicrosoftEffect({ machine }), 'chymod-microsoft')
  robot.ui.addEffect(new RainbowEffect({ machine }), 'chymod-rainbow')
  robot.face.setColor('primary', 0xff, 0xff, 0xff)
  robot.face.setColor('secondary', 0x00, 0x00, 0x00)
  if (remoteSession) {
    if (remoteSession.activationState === 'inactive') remoteSession.activate()
    remoteSession.subscribe((state) => {
      switch (state) {
        case 'listening':
          machine.hold('listening')
          break
        case 'recognizing':
          // Covers transcription and the wait for Codex, which read as one pause.
          machine.hold('thinking')
          break
        case 'speaking':
          machine.hold('speaking')
          break
        case 'blocked':
          machine.play('angry')
          machine.resumeWake()
          break
        case 'standby':
          machine.play('idle')
          machine.resumeWake()
          break
      }
    })
  }
  // USB voice turns the wake word on by default, but an explicit "off" from the
  // ChyMOD page wins; the wake word holds the microphone while it listens.
  const wakePreference = Preference.get('chymod', 'wake')
  if (wakePreference === true || (remoteSession && wakePreference !== false)) machine.setWake(true, false)
}
