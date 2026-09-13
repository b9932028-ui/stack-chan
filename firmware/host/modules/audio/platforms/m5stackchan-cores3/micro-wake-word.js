import Resource from 'Resource'
import AudioIn from 'audio-in'
import { acquireAudioInput, releaseAudioInput } from 'audio-input-lock'

const AUDIO_INPUT_OWNER = 'Okay Nabu wake word'

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
 * CoreS3-only, always-on local recognition of the stock "Okay Nabu" model.
 * Speech audio is consumed on-device and is never retained or transmitted.
 */
export default class MicroWakeWord {
  #audioIn = null
  #recognizer = null
  #onDetected

  constructor(onDetected) {
    if (typeof onDetected !== 'function') throw new TypeError('onDetected must be a function')
    this.#onDetected = onDetected
  }

  start() {
    if (this.#audioIn) return

    acquireAudioInput(AUDIO_INPUT_OWNER)
    let recognizer
    try {
      recognizer = new NativeMicroWakeWord(new Resource('okay_nabu.tflite'))
      const onDetected = this.#onDetected
      const audioIn = new AudioIn({
        channels: 1,
        onReadable(size) {
          const buffer = this.read(size)
          if (buffer && recognizer.feed(buffer)) onDetected('Okay Nabu')
        },
      })
      audioIn.start()
      this.#recognizer = recognizer
      this.#audioIn = audioIn
    } catch (error) {
      recognizer?.close()
      releaseAudioInput(AUDIO_INPUT_OWNER)
      throw error
    }
  }

  stats() {
    return this.#recognizer?.stats() ?? null
  }

  stop() {
    this.#audioIn?.close()
    this.#audioIn = null
    this.#recognizer?.close()
    this.#recognizer = null
    releaseAudioInput(AUDIO_INPUT_OWNER)
  }

  close() {
    this.stop()
  }
}
