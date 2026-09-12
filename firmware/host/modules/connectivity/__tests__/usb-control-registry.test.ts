import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  getUSBControlExtensionCapabilities,
  registerUSBControlNamespace,
  runUSBControlExtension,
} from '../usb-control-registry.js'

test('USB control namespaces advertise and route namespaced commands', async () => {
  const unregister = registerUSBControlNamespace('sample', ['status', 'play'], (command, value) => ({ command, value }))
  try {
    assert.deepEqual(getUSBControlExtensionCapabilities(), ['sample.status', 'sample.play'])
    assert.deepEqual(await runUSBControlExtension('sample.play', 'blink'), {
      command: 'play',
      value: 'blink',
    })
    assert.throws(() => runUSBControlExtension('sample.unknown', null), /unsupported command/)
  } finally {
    unregister()
  }
  assert.deepEqual(getUSBControlExtensionCapabilities(), [])
})

test('a namespace can replace its registration without an old disposer removing the new one', () => {
  const unregisterOld = registerUSBControlNamespace('sample', ['old'], () => undefined)
  const unregisterNew = registerUSBControlNamespace('sample', ['new'], () => undefined)
  unregisterOld()
  assert.deepEqual(getUSBControlExtensionCapabilities(), ['sample.new'])
  unregisterNew()
})
