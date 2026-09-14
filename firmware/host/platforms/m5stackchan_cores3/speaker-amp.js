/*
 * AW88298 speaker amplifier power control for the CoreS3.
 *
 * Moddable's CoreS3 setup powers the amplifier on once and leaves it on. The I2S
 * clocks are shared with the microphone, so while anything records -- the
 * always-on wake word -- the idle amplifier's output stage picks up noise and the
 * speaker hisses. Lowering the amplifier volume does not remove it; powering the
 * amplifier down does. Espressif's esp_codec_dev aw88298 driver and M5Unified
 * both power it down whenever nothing is playing; this does the same, reference
 * counted across every playback path that holds it.
 *
 * Register access goes through speaker-amp.c: Moddable's JavaScript I2C refuses a
 * second handle on 0x36, which its own setup already owns.
 */

const nativeOpen = native('xs_stackchan_speaker_amp_open')
const nativeWrite = native('xs_stackchan_speaker_amp_write')
const nativeRead = native('xs_stackchan_speaker_amp_read')

const SYSCTRL_REGISTER = 0x04
// I2SEN=1 AMPPD=0 PWDN=0: what Moddable's CoreS3 setup writes to enable output.
const SYSCTRL_ENABLED = 0x4040
// esp_codec_dev aw88298 disable: set PWDN and AMPPD, clear I2SEN.
const SYSCTRL_DISABLED = (SYSCTRL_ENABLED | 0x03) & ~0x40

export function createSpeakerAmp() {
  const port = nativeOpen.call(undefined)
  if (port < 0) throw new Error('AW88298 did not answer on any I2C bus')

  let active = 0
  const write = (value) => {
    try {
      nativeWrite.call(undefined, SYSCTRL_REGISTER, value)
    } catch (error) {
      trace(`[speaker-amp] SYSCTRL write failed: ${error}\n`)
    }
  }

  // Nothing is playing at boot, so start powered down.
  write(SYSCTRL_DISABLED)

  return {
    port,
    acquire() {
      active += 1
      if (active === 1) write(SYSCTRL_ENABLED)
    },
    release() {
      if (active === 0) return
      active -= 1
      if (active === 0) write(SYSCTRL_DISABLED)
    },
    get active() {
      return active
    },
    readSysctrl() {
      return nativeRead.call(undefined, SYSCTRL_REGISTER)
    },
  }
}
