import assert from 'node:assert/strict'
import test from 'node:test'
import { shutdownAxp2101 } from './axp2101-shutdown.js'

test('requests shutdown without a reset and preserves power configuration', () => {
  for (let initial = 0; initial < 256; initial++) {
    const events: string[] = []
    let configuration = initial
    shutdownAxp2101({
      readByte: () => configuration,
      writeByte(register, value) {
        assert.equal(register, 0x10, 'only common power configuration may change')
        if (value & 2) events.push('reset')
        if (value & 1) events.push('shutdown')
        configuration = value
      },
    })
    assert.deepEqual(events, ['shutdown'])
    assert.equal(configuration & 0xfc, initial & 0xfc)
  }
})

test('does not write a guessed configuration if the PMIC read fails', () => {
  let written = false
  assert.throws(
    () =>
      shutdownAxp2101({
        readByte() {
          throw new Error('I2C unavailable')
        },
        writeByte() {
          written = true
        },
      }),
    /I2C unavailable/,
  )
  assert.equal(written, false)
})
