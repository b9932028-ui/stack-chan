import { loadPreferenceConfig } from 'loadPreference'
import type { StackchanAppBehavior } from 'app-behavior'
import { shutdownAxp2101 } from 'axp2101-shutdown'
import { DogFace, ImageFace, SimpleFace } from 'behaviors/face'
import type { CameraImageType } from 'camera'
import { type CameraPreviewFrame, createCameraPreviewDialog, prepareCameraPreviewFrame } from 'camera-preview'
import { DOMAIN, PREF_KEYS } from 'consts'
import { Emoticon, type EmoticonKey } from 'effects/emoticon'
import { Emotion } from 'face-state'
import { type HandAnimationName, isHandAnimationName } from 'hands'
import type { MotionType } from 'imu'
import { localize } from 'localization'
import config from 'mc/config'
import Modules from 'modules'
import type { Content as PiuContent } from 'piu/MC'
import { randomBetween, wait } from 'stackchan-util'
import Timer from 'timer'
import { getUSBControlExtensionCapabilities, runUSBControlExtension } from 'usb-control-registry'
import { USBPreferenceServer } from 'usb-preference-server'

const FORWARD = {
  y: 0,
  p: 0,
  r: 0,
}
const LEFT = {
  ...FORWARD,
  y: Math.PI / 6,
}
const RIGHT = {
  ...FORWARD,
  y: -Math.PI / 6,
}
const DOWN = {
  ...FORWARD,
  p: Math.PI / 32,
}
const UP = {
  ...FORWARD,
  p: -Math.PI / 6,
}
const RECORD_PLAYBACK_DURATION_MS = 2000
const CAMERA_PREVIEW_DURATION_MS = 5000
const CAMERA_PREVIEW_STOP_DELAY_MS = 120
// Capture at the GC0308's native QQVGA size. The preview renderer scales this
// to 200x120; requesting 200 pixels wide selects the larger 240x176 mode and
// increases both the contiguous DMA requirement and frame overflow pressure.
const CAMERA_PREVIEW_CAPTURE_WIDTH = 160
const CAMERA_PREVIEW_CAPTURE_HEIGHT = 120
const CAMERA_PREVIEW_CAPTURE_IMAGE_TYPE: CameraImageType =
  (config as { format?: string }).format === 'RGB565BE' ? 'rgb565be' : 'rgb565le'
const TOUCH_PANEL_PETTING_WINDOW_MS = 1500
const TOUCH_PANEL_HAPPY_DURATION_MS = 5000
const TOUCH_PANEL_PET_MOTION_STEP_MS = 220
const TOUCH_PANEL_PET_MOTION_STEP_SEC = TOUCH_PANEL_PET_MOTION_STEP_MS / 1000
const MOTION_DETECT_COLD_DURATION_MS = 5000
const SPEECH_SYNTHESIS_TEXT = 'こんにちわ。すたっくちゃんです。'

let defaultUSBControlServer: USBPreferenceServer | undefined

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export const onContextCreated: NonNullable<StackchanAppBehavior['onContextCreated']> = (robot) => {
  const emotions: Emotion[] = [Emotion.HAPPY, Emotion.ANGRY, Emotion.SAD, Emotion.HOT, Emotion.SLEEPY, Emotion.NEUTRAL]
  const emotionOptions = [
    { value: String(Emotion.NEUTRAL), label: localize('drawer.emotion.neutral') },
    { value: String(Emotion.HAPPY), label: localize('drawer.emotion.happy') },
    { value: String(Emotion.ANGRY), label: localize('drawer.emotion.angry') },
    { value: String(Emotion.SAD), label: localize('drawer.emotion.sad') },
    { value: String(Emotion.HOT), label: localize('drawer.emotion.hot') },
    { value: String(Emotion.SLEEPY), label: localize('drawer.emotion.sleepy') },
  ]
  let speechVisible = false
  let emoticonEffect: PiuContent | null = null
  let currentEmotion: Emotion = Emotion.NEUTRAL
  let pettingRestoreTimer: ReturnType<typeof Timer.set> | undefined
  let pettingPreviousEmotion: Emotion | undefined
  let pettingPreviousRotation: typeof robot.pose.body.rotation | undefined
  let pettingMotionActive = false
  let pettingHoldTimer: ReturnType<typeof Timer.set> | undefined
  let motionDetectRestoreTimer: ReturnType<typeof Timer.set> | undefined
  let motionDetectPreviousEmotion: Emotion | undefined
  const remoteControl: { setLED?: (enabled: boolean) => void } = {}
  const emotionKeyMap: Record<Emotion, EmoticonKey | null> = {
    [Emotion.HAPPY]: 'heart',
    [Emotion.ANGRY]: 'angry',
    [Emotion.SAD]: 'tear',
    [Emotion.HOT]: 'sweat',
    [Emotion.SLEEPY]: 'sleepy',
    [Emotion.NEUTRAL]: null,
    [Emotion.DOUBTFUL]: null,
    [Emotion.COLD]: null,
  }
  const setEmotionWithEffect = (target: typeof robot, nextEmotion: Emotion) => {
    currentEmotion = nextEmotion
    target.setEmotion(nextEmotion)
    if (emoticonEffect) {
      target.ui.removeEffect(emoticonEffect)
      emoticonEffect = null
    }
    const key = emotionKeyMap[nextEmotion]
    if (key) {
      emoticonEffect = new Emoticon({ key, name: 'emotion' })
      target.ui.addEffect(emoticonEffect)
    }
  }
  const poseForRotation = (rotation: typeof robot.pose.body.rotation) => ({
    position: { ...robot.pose.body.position },
    rotation,
  })
  const runPettingHoldMotion = async (upRotation: typeof robot.pose.body.rotation) => {
    try {
      await robot.setPose(poseForRotation(upRotation), TOUCH_PANEL_PET_MOTION_STEP_SEC)
    } catch (error) {
      trace(`[TouchPanel] pet hold motion error ${errorMessage(error)}\n`)
      try {
        await robot.setTorque(false)
      } catch (torqueError) {
        trace(`[TouchPanel] pet hold torque release error ${errorMessage(torqueError)}\n`)
      }
    }
  }
  const runPettingMotion = async (
    upRotation: typeof robot.pose.body.rotation,
    leftRight: (direction: number) => typeof robot.pose.body.rotation,
    firstDirection: number,
  ) => {
    try {
      await robot.setTorque(true)
      // Multiple visible steps make this read as head shaking, not a single pose change.
      await robot.setPose(poseForRotation(leftRight(firstDirection)), TOUCH_PANEL_PET_MOTION_STEP_SEC)
      await wait(TOUCH_PANEL_PET_MOTION_STEP_MS)
      await robot.setPose(poseForRotation(leftRight(-firstDirection)), TOUCH_PANEL_PET_MOTION_STEP_SEC)
      await wait(TOUCH_PANEL_PET_MOTION_STEP_MS)
      await robot.setPose(poseForRotation(leftRight(firstDirection * 0.55)), TOUCH_PANEL_PET_MOTION_STEP_SEC)
      await wait(TOUCH_PANEL_PET_MOTION_STEP_MS)
      // Keep the happy reaction looking upward until the restore timer returns to the original pose.
      await robot.setPose(poseForRotation(upRotation), TOUCH_PANEL_PET_MOTION_STEP_SEC)
      pettingHoldTimer = Timer.set(() => {
        pettingHoldTimer = undefined
        void runPettingHoldMotion(upRotation)
      }, TOUCH_PANEL_PET_MOTION_STEP_MS * 2)
    } catch (error) {
      trace(`[TouchPanel] pet motion error ${errorMessage(error)}\n`)
      try {
        await robot.setTorque(false)
      } catch (torqueError) {
        trace(`[TouchPanel] pet motion torque release error ${errorMessage(torqueError)}\n`)
      }
    } finally {
      pettingMotionActive = false
    }
  }
  const runPettingRestoreMotion = async (rotation: typeof robot.pose.body.rotation) => {
    try {
      await robot.setPose(poseForRotation(rotation), TOUCH_PANEL_PET_MOTION_STEP_SEC)
    } catch (error) {
      trace(`[TouchPanel] restore motion error ${errorMessage(error)}\n`)
    } finally {
      try {
        await robot.setTorque(false)
      } catch (torqueError) {
        trace(`[TouchPanel] restore torque release error ${errorMessage(torqueError)}\n`)
      }
    }
  }

  let faceMode: 'simple' | 'dog' | 'image' = 'simple'
  let handAnimation: HandAnimationName = 'none'
  let cameraPreviewTimer: ReturnType<typeof Timer.set> | undefined
  const syncFaceMode = (
    app = robot.ui.application as { distribute?: (event: string, payload: unknown) => void } | undefined,
  ) => {
    app?.distribute?.('onFaceMode', faceMode)
  }
  const syncHandAnimation = () => robot.ui.setHandAnimation(handAnimation)
  const closeDrawer = () => robot.ui.closeDrawer()
  const createCurrentFace = () =>
    faceMode === 'dog' ? new DogFace({}) : faceMode === 'image' ? new ImageFace({}) : new SimpleFace({})
  const applyFaceMode = (value: unknown) => {
    if (value !== 'simple' && value !== 'dog' && value !== 'image') throw new Error('invalid face mode')
    faceMode = value
    robot.ui.setFace(createCurrentFace())
    syncFaceMode()
  }
  const restoreCameraPreview = () => {
    if (cameraPreviewTimer) {
      Timer.clear(cameraPreviewTimer)
      cameraPreviewTimer = undefined
    }
    // Restore the preserved face main component (keeps the current avatar mode/emotion).
    robot.ui.showFace()
    robot.hideBalloon()
  }
  robot.drawer.addDrawerButton({
    key: 'toggleFace',
    label: localize('drawer.face'),
    kind: 'choice',
    value: faceMode,
    options: [
      { value: 'simple', label: localize('drawer.face.simple') },
      { value: 'dog', label: localize('drawer.face.dog') },
      { value: 'image', label: localize('drawer.face.image') },
    ],
    callback: (_target, value) => {
      try {
        applyFaceMode(value)
      } catch {}
    },
  })
  syncFaceMode()
  robot.drawer.addDrawerButton({
    key: 'cycleEmotion',
    label: localize('drawer.emotion'),
    kind: 'choice',
    value: String(currentEmotion),
    options: emotionOptions,
    callback: (target, value) => {
      const nextEmotion = Number(value) as Emotion
      if (!emotions.includes(nextEmotion) && nextEmotion !== Emotion.NEUTRAL) return
      let canceledPettingMotion = false
      if (pettingRestoreTimer) {
        Timer.clear(pettingRestoreTimer)
        pettingRestoreTimer = undefined
        pettingPreviousEmotion = undefined
        canceledPettingMotion = true
      }
      if (pettingHoldTimer) {
        Timer.clear(pettingHoldTimer)
        pettingHoldTimer = undefined
        canceledPettingMotion = true
      }
      if (canceledPettingMotion) {
        void target
          .setTorque(false)
          .catch((error) => trace(`[TouchPanel] canceled petting torque release error ${errorMessage(error)}\n`))
      }
      setEmotionWithEffect(target, nextEmotion)
    },
  })
  robot.drawer.addDrawerButton({
    key: 'toggleSpeech',
    label: localize('drawer.balloon'),
    kind: 'toggle',
    initialState: speechVisible,
    callback: (target) => {
      speechVisible = !speechVisible
      if (speechVisible) {
        target.showBalloon('Hello from Stack-chan')
      } else {
        target.hideBalloon()
      }
      robot.drawer.setDrawerButtonState('toggleSpeech', speechVisible)
    },
  })
  robot.drawer.addDrawerButton({
    key: 'speakStackchan',
    label: 'Speak',
    callback: async (target) => {
      closeDrawer()
      try {
        const result = await target.audio.say(SPEECH_SYNTHESIS_TEXT)
        if ('reason' in result) trace(`[SpeechSynthesis] ${result.reason}\n`)
      } catch (error) {
        trace(`[SpeechSynthesis] error ${errorMessage(error)}\n`)
      }
    },
  })
  robot.drawer.addDrawerButton({
    key: 'handAnimation',
    label: '手',
    kind: 'choice',
    value: handAnimation,
    options: [
      { value: 'none', label: '無し' },
      { value: 'rock-paper-scissors', label: 'グーチョキパー' },
      { value: 'clap', label: '拍手' },
      { value: 'thinking', label: '考え中' },
    ],
    callback: (target, value) => {
      if (!isHandAnimationName(value)) return
      handAnimation = value
      target.ui.setHandAnimation(handAnimation)
      target.ui.closeDrawer()
    },
  })
  syncHandAnimation()

  const runCameraPreview = async (target: typeof robot) => {
    let frame: Awaited<ReturnType<typeof target.camera.capture>> | undefined
    let previewFrame: CameraPreviewFrame | undefined
    const stopCameraAfterPreviewPaint = () =>
      new Promise<void>((resolve) => {
        Timer.set(() => {
          try {
            trace('[CameraPreview] camera stop begin\n')
            const result = target.camera.stop()
            if (result && typeof (result as { then?: unknown }).then === 'function') {
              ;(result as Promise<void>).then(
                () => {
                  trace('[CameraPreview] camera stop done\n')
                  resolve()
                },
                (stopError: unknown) => {
                  trace(`[CameraPreview] stop error ${errorMessage(stopError)}\n`)
                  resolve()
                },
              )
            } else {
              trace('[CameraPreview] camera stop done\n')
              resolve()
            }
          } catch (stopError) {
            trace(`[CameraPreview] stop error ${errorMessage(stopError)}\n`)
            resolve()
          }
        }, CAMERA_PREVIEW_STOP_DELAY_MS)
      })
    try {
      target.showBalloon('starting camera...')
      await target.camera.start({
        width: CAMERA_PREVIEW_CAPTURE_WIDTH,
        height: CAMERA_PREVIEW_CAPTURE_HEIGHT,
        imageType: CAMERA_PREVIEW_CAPTURE_IMAGE_TYPE,
      })
      frame = await target.camera.capture({
        width: CAMERA_PREVIEW_CAPTURE_WIDTH,
        height: CAMERA_PREVIEW_CAPTURE_HEIGHT,
        imageType: CAMERA_PREVIEW_CAPTURE_IMAGE_TYPE,
      })
      if (!frame) {
        trace('[CameraPreview] capture returned no frame\n')
        target.showBalloon('camera unavailable')
        return
      }
      previewFrame = prepareCameraPreviewFrame(frame)
      // Swap the whole main area for a full-area preview dialog; AppBar/Drawer stay active on top.
      // The dialog draws its own caption, so no preview-time balloon is needed.
      target.ui.setMain(
        createCameraPreviewDialog(previewFrame, {
          onRender: (mode) => {
            trace(`[CameraPreview] render mode=${mode}\n`)
          },
          onDismiss: restoreCameraPreview,
        }),
      )
      trace(
        `[CameraPreview] rendered ${previewFrame.width}x${previewFrame.height} ${previewFrame.imageType} via Piu Port\n`,
      )
      closeDrawer()
      if (cameraPreviewTimer) Timer.clear(cameraPreviewTimer)
      cameraPreviewTimer = Timer.set(restoreCameraPreview, CAMERA_PREVIEW_DURATION_MS)
    } catch (error) {
      trace(`[CameraPreview] error ${errorMessage(error)}\n`)
      try {
        target.showBalloon('camera error')
      } catch (balloonError) {
        trace(`[CameraPreview] error balloon failed ${errorMessage(balloonError)}\n`)
      }
    } finally {
      if (frame) {
        trace('[CameraPreview] frame close begin\n')
        frame.close?.()
        trace('[CameraPreview] frame close done\n')
      }
      await stopCameraAfterPreviewPaint()
      hideBalloonLater(1200)
    }
  }
  if (robot.camera.available !== false) {
    robot.drawer.addDrawerButton({
      key: 'cameraPreview',
      label: localize('drawer.camera'),
      icon: 'camera',
      callback: (target) => runCameraPreview(target),
    })
  }

  /**
   * Look around (Drawer toggle)
   */
  let isFollowing = false
  const toggleLookAround = async () => {
    await setLookAround(!isFollowing)
  }
  const setLookAround = async (nextFollowing: boolean) => {
    try {
      await robot.setTorque(nextFollowing)
      isFollowing = nextFollowing
      robot.drawer.setDrawerButtonState('toggleLookAround', isFollowing)
      const text = isFollowing ? 'looking' : 'look away'
      robot.showBalloon(text)
      await wait(1000)
      robot.hideBalloon()
    } catch (error) {
      trace(`[Look] toggle error ${errorMessage(error)}\n`)
      robot.drawer.setDrawerButtonState('toggleLookAround', isFollowing)
    }
  }
  const targetLoop = () => {
    if (!isFollowing) {
      robot.lookAway()
      return
    }
    const x = randomBetween(0.4, 1.0)
    const y = randomBetween(-0.4, 0.4)
    const z = randomBetween(-0.02, 0.2)
    trace(`looking at: [${x}, ${y}, ${z}]\n`)
    robot.lookAt([x, y, z])
  }
  Timer.repeat(targetLoop, 5000)
  robot.drawer.addDrawerButton({
    key: 'toggleLookAround',
    label: localize('drawer.lookAround'),
    kind: 'toggle',
    initialState: isFollowing,
    callback: toggleLookAround,
  })

  /**
   * Servo test (Drawer action)
   */
  let isMoving = false
  const runServoTest = async () => {
    if (isMoving) return
    isMoving = true
    let failed = false
    const rotations = [LEFT, RIGHT, DOWN, UP, FORWARD]
    try {
      isFollowing = false
      robot.lookAway()
      robot.drawer.setDrawerButtonState('toggleLookAround', false)
      robot.showBalloon('moving...')
      await robot.setTorque(true)
      for (const rotation of rotations) {
        await robot.setPose(poseForRotation(rotation))
        await wait(1000)
      }
    } catch (error) {
      failed = true
      trace(`[ServoTest] motion error ${errorMessage(error)}\n`)
      robot.showBalloon('servo error')
    } finally {
      try {
        await robot.setTorque(false)
      } catch (error) {
        failed = true
        trace(`[ServoTest] torque release error ${errorMessage(error)}\n`)
        robot.showBalloon('servo error')
      }
      isMoving = false
      if (failed) {
        Timer.set(() => robot.hideBalloon(), 1200)
      } else {
        robot.hideBalloon()
      }
    }
  }
  const startServoTest = () =>
    runServoTest().catch((error) => {
      isMoving = false
      trace(`[ServoTest] unexpected error ${errorMessage(error)}\n`)
    })
  robot.drawer.addDrawerButton({
    key: 'servoTest',
    label: localize('drawer.servo'),
    icon: 'play',
    callback: startServoTest,
  })

  /**
   * LED test(Drawer action)
   */
  if (Object.keys(robot.led).length) {
    const ledName = Object.keys(robot.led)[0] as string
    let isLighting = false
    const setLED = (enabled: boolean) => {
      isLighting = enabled
      if (isLighting) {
        robot.lightRainbow(ledName)
      } else {
        robot.lightOff(ledName)
      }
      robot.drawer.setDrawerButtonState('toggleLED', isLighting)
    }
    robot.drawer.addDrawerButton({
      key: 'toggleLED',
      label: 'LED',
      kind: 'toggle',
      initialState: isLighting,
      callback: () => setLED(!isLighting),
    })
    remoteControl.setLED = setLED
  }

  /**
   * Audio tests (Drawer actions)
   */
  let isAudioTesting = false
  const hideBalloonLater = (delay = 900) => {
    Timer.set(() => {
      robot.hideBalloon()
    }, delay)
  }
  const runPlayTone = async () => {
    if (isAudioTesting) return
    isAudioTesting = true
    robot.showBalloon('playing tone...')
    try {
      trace('[AudioTest] playTone start\n')
      await robot.tone(880, 400, 0.35)
      trace('[AudioTest] playTone complete\n')
      robot.showBalloon('tone complete')
    } catch (error) {
      trace(`[AudioTest] playTone error ${errorMessage(error)}\n`)
      robot.showBalloon('tone error')
    } finally {
      isAudioTesting = false
      hideBalloonLater()
    }
  }
  const runRecordPlayback = async () => {
    if (isAudioTesting) return
    isAudioTesting = true
    robot.showBalloon('recording...')
    try {
      trace(`[AudioTest] record start duration=${RECORD_PLAYBACK_DURATION_MS}\n`)
      const buffer = await robot.record(RECORD_PLAYBACK_DURATION_MS)
      trace(`[AudioTest] record complete bytes=${buffer.byteLength}\n`)
      if (buffer.byteLength === 0) {
        robot.showBalloon('record failed')
        return
      }

      trace('[AudioTest] playback start\n')
      robot.showBalloon('playing...')
      const played = await robot.playAudio(buffer)
      trace(`[AudioTest] playback complete played=${played}\n`)
      robot.showBalloon(played ? 'playback complete' : `recorded ${buffer.byteLength} bytes`)
    } catch (error) {
      trace(`[AudioTest] record playback error ${errorMessage(error)}\n`)
      robot.showBalloon('audio error')
    } finally {
      isAudioTesting = false
      hideBalloonLater(1200)
    }
  }
  robot.drawer.addDrawerButton({
    key: 'playTone',
    label: localize('drawer.playSound'),
    icon: 'play',
    callback: runPlayTone,
  })
  robot.drawer.addDrawerButton({
    key: 'recordPlayback',
    label: localize('drawer.recordAndPlay'),
    icon: 'microphone',
    callback: runRecordPlayback,
  })

  /**
   * Change color (Drawer action)
   */
  let colorMode: 'dark' | 'light' = 'light'
  const colorOptions = [
    { value: 'light', label: localize('drawer.color.light'), color: '#ffffff' },
    { value: 'dark', label: localize('drawer.color.dark'), color: '#000000' },
  ]
  function selectColor(_target: typeof robot, value?: string) {
    if (value === 'dark' || value === 'light') applyColor(value)
  }
  const registerColorDrawerButton = () => {
    robot.drawer.addDrawerButton({
      key: 'toggleColor',
      label: localize('drawer.colorScheme'),
      kind: 'swatch',
      value: colorMode,
      options: colorOptions,
      callback: selectColor,
    })
  }
  const applyColor = (value: 'dark' | 'light') => {
    colorMode = value
    if (colorMode === 'light') {
      robot.setColor('primary', 0xff, 0xff, 0xff)
      robot.setColor('secondary', 0x00, 0x00, 0x00)
    } else {
      robot.setColor('primary', 0x00, 0x00, 0x00)
      robot.setColor('secondary', 0xff, 0xff, 0xff)
    }
    registerColorDrawerButton()
  }
  registerColorDrawerButton()

  if (robot.imu != null) {
    const motionEmotionMap: Record<MotionType, Emotion> = {
      upsideDown: Emotion.SAD,
      fallenForward: Emotion.ANGRY,
      fallenBackward: Emotion.ANGRY,
      fallenLeft: Emotion.ANGRY,
      fallenRight: Emotion.ANGRY,
      shake: Emotion.HOT,
    }
    robot.imu.start()
    robot.imu.onEvent = (event) => {
      const type = event.motion
      trace(`[IMU] motion detected: ${type}\n`)
      if (motionDetectPreviousEmotion === undefined) motionDetectPreviousEmotion = currentEmotion
      if (motionDetectRestoreTimer) Timer.clear(motionDetectRestoreTimer)

      const motionEmotion = motionEmotionMap[type]
      setEmotionWithEffect(robot, motionEmotion)
      motionDetectRestoreTimer = Timer.set(() => {
        if (currentEmotion === motionEmotion) {
          const restoreEmotion = motionDetectPreviousEmotion ?? Emotion.NEUTRAL
          trace(`[IMU] restore emotion ${restoreEmotion}\n`)
          setEmotionWithEffect(robot, restoreEmotion)
        }
        motionDetectPreviousEmotion = undefined
        motionDetectRestoreTimer = undefined
      }, MOTION_DETECT_COLD_DURATION_MS)
    }
  }

  if (robot.button != null) {
    if (robot.button.a != null) {
      robot.button.a.onEvent = (event) => {
        if (!event.pressed) {
          return
        }
        void toggleLookAround().catch((error) => trace(`[Button] look error ${errorMessage(error)}\n`))
      }
    }
    if (robot.button.b != null) {
      robot.button.b.onEvent = (event) => {
        if (!event.pressed) {
          return
        }
        void startServoTest()
      }
    }
    if (robot.button.c != null) {
      robot.button.c.onEvent = (event) => {
        if (!event.pressed) {
          return
        }
        applyColor(colorMode === 'light' ? 'dark' : 'light')
      }
    }
  }

  if (robot.touchPanel != null) {
    let lastForwardSwipeTicks: number | undefined
    let lastBackwardSwipeTicks: number | undefined
    robot.touchPanel.subscribe((event) => {
      const type = event.gesture
      trace(`[TouchPanel] gesture: ${type}\n`)
      if (type !== 'forwardSwipe' && type !== 'backwardSwipe') return

      if (type === 'forwardSwipe') lastForwardSwipeTicks = event.ticks
      else lastBackwardSwipeTicks = event.ticks

      const hasRecentForwardSwipe =
        lastForwardSwipeTicks !== undefined && event.ticks - lastForwardSwipeTicks <= TOUCH_PANEL_PETTING_WINDOW_MS
      const hasRecentBackwardSwipe =
        lastBackwardSwipeTicks !== undefined && event.ticks - lastBackwardSwipeTicks <= TOUCH_PANEL_PETTING_WINDOW_MS
      if (hasRecentForwardSwipe && hasRecentBackwardSwipe) {
        trace('[TouchPanel] petting detected: set emotion HAPPY with heart effect\n')
        if (pettingPreviousEmotion === undefined) pettingPreviousEmotion = currentEmotion
        if (pettingPreviousRotation === undefined) pettingPreviousRotation = { ...robot.pose.body.rotation }
        if (pettingRestoreTimer) Timer.clear(pettingRestoreTimer)
        if (pettingHoldTimer) {
          Timer.clear(pettingHoldTimer)
          pettingHoldTimer = undefined
        }
        setEmotionWithEffect(robot, Emotion.HAPPY)
        if (!pettingMotionActive) {
          pettingMotionActive = true
          const baseRotation = pettingPreviousRotation
          const yawAmount = randomBetween(Math.PI / 15, Math.PI / 10)
          const pitch = Math.max(-Math.PI / 4, baseRotation.p - randomBetween(Math.PI / 10, Math.PI / 8))
          const firstDirection = Math.random() < 0.5 ? -1 : 1
          const upRotation = { ...baseRotation, p: pitch }
          const leftRight = (direction: number) => ({
            ...baseRotation,
            p: pitch,
            y: Math.max(-Math.PI / 6, Math.min(Math.PI / 6, baseRotation.y + direction * yawAmount)),
          })
          trace(
            `[TouchPanel] pet motion shake yaw=${yawAmount.toFixed(3)} pitch=${pitch.toFixed(3)} direction=${firstDirection}\n`,
          )
          void runPettingMotion(upRotation, leftRight, firstDirection).catch((error) =>
            trace(`[TouchPanel] pet motion rejected ${errorMessage(error)}\n`),
          )
        }
        pettingRestoreTimer = Timer.set(() => {
          const restoreEmotion = pettingPreviousEmotion ?? Emotion.NEUTRAL
          trace(`[TouchPanel] restore emotion ${restoreEmotion}\n`)
          setEmotionWithEffect(robot, restoreEmotion)
          if (pettingHoldTimer) {
            Timer.clear(pettingHoldTimer)
            pettingHoldTimer = undefined
          }
          if (pettingPreviousRotation) {
            void runPettingRestoreMotion(pettingPreviousRotation).catch((error) =>
              trace(`[TouchPanel] restore motion rejected ${errorMessage(error)}\n`),
            )
          }
          pettingPreviousEmotion = undefined
          pettingPreviousRotation = undefined
          pettingRestoreTimer = undefined
        }, TOUCH_PANEL_HAPPY_DURATION_MS)
        lastForwardSwipeTicks = undefined
        lastBackwardSwipeTicks = undefined
      }
    })
  }

  const preferences = loadPreferenceConfig()
  const effectiveValues = Object.fromEntries(
    PREF_KEYS.flatMap(([domain, key]) => {
      const value = preferences[domain]?.[key]
      return value == null ? [] : [[`${domain}.${key}`, value]]
    }),
  )
  const emotionByName: Record<string, Emotion> = {
    neutral: Emotion.NEUTRAL,
    happy: Emotion.HAPPY,
    angry: Emotion.ANGRY,
    sad: Emotion.SAD,
    hot: Emotion.HOT,
    sleepy: Emotion.SLEEPY,
  }
  const poseByName = { forward: FORWARD, left: LEFT, right: RIGHT, down: DOWN, up: UP }
  const system = (globalThis as typeof globalThis & { System?: { restart(): void } }).System
  const power = Modules.has('axp2101-power-capture')
    ? (
        Modules.importNow('axp2101-power-capture') as {
          getAxp2101Power():
            | { powerOff(): void; readByte(register: number): number; writeByte(register: number, value: number): void }
            | undefined
        }
      ).getAxp2101Power()
    : undefined
  let powerCommandPending = false
  const controlCapabilities = [
    ...(system?.restart ? ['restart'] : []),
    ...(power?.powerOff ? ['shutdown', 'powerStatus'] : []),
    'face',
    'emotion',
    'balloon',
    'speak',
    'hand',
    'lookAround',
    'pose',
    'servoTest',
    'tone',
    'recordPlayback',
    'color',
    ...(robot.camera.available !== false ? ['camera'] : []),
    ...(remoteControl.setLED ? ['led'] : []),
    ...getUSBControlExtensionCapabilities(),
  ]
  try {
    defaultUSBControlServer?.close()
    defaultUSBControlServer = new USBPreferenceServer({
      keys: PREF_KEYS,
      effectiveValues,
      readOnlyKeys: preferences.driver.typeLocked === true ? [`${DOMAIN.driver}.type`] : [],
      controlCapabilities,
      onControlCommand: async (command, value) => {
        if (powerCommandPending) throw new Error('power operation already pending')
        switch (command) {
          case 'powerStatus': {
            if (!power) throw new Error('power diagnostics unavailable')
            const registers: Record<string, number> = {}
            for (const address of [0x00, 0x01, 0x10, 0x20, 0x21, 0x22, 0x24, 0x25, 0x26]) {
              registers[address.toString(16).padStart(2, '0')] = power.readByte(address)
            }
            const resetReason = Modules.has('stackchan-reset-reason')
              ? (Modules.importNow('stackchan-reset-reason') as () => number)()
              : undefined
            return { resetReason, registers }
          }
          case 'restart':
          case 'shutdown': {
            let powerAction: () => void
            if (command === 'restart') {
              if (!system?.restart) throw new Error('restart unavailable')
              powerAction = () => system.restart()
            } else {
              if (!power?.powerOff) throw new Error('shutdown unavailable')
              powerAction = () => shutdownAxp2101(power)
            }
            powerCommandPending = true
            // Allow the USB command acknowledgement to leave before disconnecting.
            Timer.set(() => {
              try {
                powerAction()
              } catch (error) {
                trace(`[control-usb] power command failed: ${errorMessage(error)}\n`)
              } finally {
                powerCommandPending = false
              }
            }, 750)
            return
          }
          case 'face':
            applyFaceMode(value)
            return
          case 'emotion': {
            const emotion = emotionByName[String(value)]
            if (emotion === undefined) throw new Error('invalid emotion')
            setEmotionWithEffect(robot, emotion)
            return
          }
          case 'balloon': {
            const text = String(value ?? '').slice(0, 160)
            if (text) robot.showBalloon(text)
            else robot.hideBalloon()
            return
          }
          case 'speak': {
            const text = String(value ?? '')
              .trim()
              .slice(0, 300)
            if (!text) throw new Error('speech text is empty')
            await robot.audio.say(text)
            return
          }
          case 'hand':
            if (!isHandAnimationName(value)) throw new Error('invalid hand animation')
            handAnimation = value
            syncHandAnimation()
            return
          case 'lookAround':
            await setLookAround(value === true)
            return
          case 'pose': {
            const rotation = poseByName[String(value) as keyof typeof poseByName]
            if (!rotation) throw new Error('invalid pose')
            isFollowing = false
            robot.drawer.setDrawerButtonState('toggleLookAround', false)
            await robot.setTorque(true)
            await robot.setPose(poseForRotation(rotation))
            return
          }
          case 'servoTest':
            await runServoTest()
            return
          case 'led':
            remoteControl.setLED?.(value === true)
            return
          case 'tone':
            await runPlayTone()
            return
          case 'recordPlayback':
            await runRecordPlayback()
            return
          case 'color':
            if (value !== 'light' && value !== 'dark') throw new Error('invalid color scheme')
            applyColor(value)
            return
          case 'camera':
            await runCameraPreview(robot)
            return
          default:
            return runUSBControlExtension(command, value)
        }
      },
    })
  } catch (error) {
    trace(`[control-usb] unavailable: ${errorMessage(error)}\n`)
  }
}
