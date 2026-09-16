import Resource from 'Resource'
import AudioIn from 'audio-in'
import { acquireAudioInput, releaseAudioInput } from 'audio-input-lock'
import Timer from 'timer'

const AUDIO_INPUT_OWNER = 'Hey Copilot wake word'
const RESUME_RETRY_MS = 500

class NativeMicroWakeWord extends Native('xs_micro_wake_word_destructor') {
  constructor(model) {
    super()
    native('xs_micro_wake_word_constructor').call(this, model)
  }

  feed(buffer) {
    return native('xs_micro_wake_word_feed').call(this, buffer)
  }

  stats() {
    return native('xs_micro_wake_word_stats').call(this)
  }

  close() {
    native('xs_micro_wake_word_close').call(this)
  }
}

/**
 * CoreS3-only, always-on local recognition of the custom-trained "Hey Copilot" model.
 * Speech audio is consumed on-device and is never retained or transmitted.
 *
 * The microphone and speaker share I2S port 1 and its clocks, so recording while
 * anything plays makes playback stutter. The wake word therefore releases the
 * microphone whenever the speaker amplifier is held (every playback path holds it,
 * see speaker-amp.js) and resumes when playback ends.
 */
export default class MicroWakeWord {
  #audioIn = null
  #recognizer = null
  #onDetected
  #unsubscribePlayback = null
  #resumeTimer = null

  constructor(onDetected) {
    if (typeof onDetected !== 'function') throw new TypeError('onDetected must be a function')
    this.#onDetected = onDetected
  }

  start() {
    if (this.#recognizer) return

    const recognizer = new NativeMicroWakeWord(new Resource('hey_copilot.tflite'))
    this.#recognizer = recognizer
    const amp = globalThis.stackchanSpeakerAmp
    try {
      if (!amp?.active) this.#openInput()
    } catch (error) {
      this.#recognizer = null
      recognizer.close()
      throw error
    }
    if (typeof amp?.subscribe === 'function') {
      this.#unsubscribePlayback = amp.subscribe((playing) => {
        if (playing) this.#pauseInput()
        else this.#resumeInput()
      })
    }
  }

  stats() {
    return this.#recognizer?.stats() ?? null
  }

  stop() {
    this.#unsubscribePlayback?.()
    this.#unsubscribePlayback = null
    this.#clearResumeTimer()
    this.#closeInput()
    this.#recognizer?.close()
    this.#recognizer = null
  }

  close() {
    this.stop()
  }

  #openInput() {
    if (this.#audioIn || !this.#recognizer) return
    acquireAudioInput(AUDIO_INPUT_OWNER)
    try {
      const recognizer = this.#recognizer
      const onDetected = this.#onDetected
      const audioIn = new AudioIn({
        channels: 1,
        onReadable(size) {
          const buffer = this.read(size)
          if (buffer && recognizer.feed(buffer)) onDetected('Hey Copilot')
        },
      })
      audioIn.start()
      this.#audioIn = audioIn
    } catch (error) {
      releaseAudioInput(AUDIO_INPUT_OWNER)
      throw error
    }
  }

  #closeInput() {
    if (!this.#audioIn) return
    this.#audioIn.close()
    this.#audioIn = null
    releaseAudioInput(AUDIO_INPUT_OWNER)
  }

  #pauseInput() {
    this.#clearResumeTimer()
    this.#closeInput()
  }

  #resumeInput() {
    this.#clearResumeTimer()
    if (!this.#recognizer || this.#audioIn || globalThis.stackchanSpeakerAmp?.active) return
    try {
      this.#openInput()
    } catch (error) {
      // Another owner (for example the USB microphone) may still hold the input.
      trace(`[micro-wake-word] resume deferred: ${error?.message ?? error}\n`)
      this.#resumeTimer = Timer.set(() => {
        this.#resumeTimer = null
        this.#resumeInput()
      }, RESUME_RETRY_MS)
    }
  }

  #clearResumeTimer() {
    if (this.#resumeTimer === null) return
    Timer.clear(this.#resumeTimer)
    this.#resumeTimer = null
  }
}
