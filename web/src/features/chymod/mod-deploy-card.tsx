import { FileArchive, Usb, Zap } from 'lucide-react'
import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress, ProgressLabel } from '@/components/ui/progress'
import { toAppError } from '@/lib/errors/app-error'
import { createEsptoolLoader, DEVICE_OPERATION_STATUS, installModToDevice } from '../../../editor/esptool-installer.mjs'

type SerialPortLike = {
  getInfo?: () => { usbVendorId?: number; usbProductId?: number }
}

type SerialNavigator = Navigator & {
  serial?: { requestPort: () => Promise<SerialPortLike> }
}

type DeployState =
  | { status: 'idle' }
  | { status: 'pending'; message: string; progress: number }
  | { status: 'success'; message: string }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string }

type ModDeployCardProps = {
  controlConnected: boolean
  disconnectControl: () => Promise<void>
}

function hexId(value: number | undefined) {
  return value === undefined ? '????' : value.toString(16).padStart(4, '0').toUpperCase()
}

function describePort(port: SerialPortLike | null) {
  if (!port) return 'No port selected'
  const info = port.getInfo?.()
  if (!info || (info.usbVendorId === undefined && info.usbProductId === undefined)) return 'Web Serial port selected'
  return `USB ${hexId(info.usbVendorId)}:${hexId(info.usbProductId)}`
}

export function ModDeployCard({ controlConnected, disconnectControl }: ModDeployCardProps) {
  const [archive, setArchive] = useState<File | null>(null)
  const [port, setPort] = useState<SerialPortLike | null>(null)
  const [operation, setOperation] = useState<DeployState>({ status: 'idle' })
  const [logs, setLogs] = useState<string[]>([])

  const selectPort = async () => {
    const serial = (navigator as SerialNavigator).serial
    if (!serial) {
      setOperation({ status: 'error', message: 'Web Serial is unavailable. Use Chrome or Edge.' })
      return
    }
    try {
      setPort(await serial.requestPort())
      setOperation({ status: 'idle' })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return
      setOperation({ status: 'error', message: toAppError(error, 'mod.port').message })
    }
  }

  const deploy = async () => {
    if (!archive || !port) return
    setLogs([])
    setOperation({ status: 'pending', message: 'Preparing MOD archive…', progress: 0 })
    try {
      if (controlConnected) await disconnectControl()
      const bytes = new Uint8Array(await archive.arrayBuffer())
      const result = await installModToDevice(createEsptoolLoader, port, bytes, {
        onLog: (message: string) => setLogs((current) => [...current, message]),
        onProgress: (progress: number) =>
          setOperation({ status: 'pending', message: 'Writing MOD to the device…', progress }),
        onPrompt: (message: string) => setOperation({ status: 'pending', message, progress: 1 }),
        onPreflight: ({ chip, partition, firmware }: any) =>
          window.confirm(
            `Install ${archive.name} to ${chip} / ${firmware.projectName || 'Stack-chan'} ${firmware.version}?\n\n` +
              `Only the xs MOD partition at 0x${partition.offset.toString(16)} will be replaced.`
          ),
      })
      if (result.status === DEVICE_OPERATION_STATUS.CANCELLED) {
        setOperation({ status: 'cancelled', message: 'MOD deployment was cancelled.' })
        return
      }
      setOperation({
        status: 'success',
        message: `MOD installed and verified on ${String(result.chip ?? 'the device')}.`,
      })
    } catch (error) {
      setOperation({ status: 'error', message: toAppError(error, 'mod.deploy').message })
    }
  }

  const pending = operation.status === 'pending'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deploy MOD</CardTitle>
        <CardDescription>Select an XSA archive and a USB serial port.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="chymod-xsa">XSA archive</Label>
          <Input
            id="chymod-xsa"
            type="file"
            accept=".xsa,application/octet-stream"
            disabled={pending}
            onChange={(event) => {
              setArchive(event.target.files?.[0] ?? null)
              setOperation({ status: 'idle' })
            }}
          />
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <FileArchive className="size-3.5" />
            {archive ? `${archive.name} (${archive.size.toLocaleString()} bytes)` : 'No XSA selected'}
          </p>
        </div>

        <div className="grid gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={() => void selectPort()}>
            <Usb data-icon="inline-start" />
            Select port
          </Button>
          <p className="text-xs text-muted-foreground">{describePort(port)}</p>
        </div>

        {controlConnected && (
          <Alert>
            <AlertDescription>The ChyMOD control connection will close before deployment.</AlertDescription>
          </Alert>
        )}

        <Button type="button" disabled={!archive || !port || pending} onClick={() => void deploy()}>
          <Zap data-icon="inline-start" />
          {pending ? 'Deploying…' : 'Deploy MOD'}
        </Button>

        {operation.status === 'pending' && (
          <Progress value={Math.round(operation.progress * 100)}>
            <ProgressLabel>{operation.message}</ProgressLabel>
            <span className="ml-auto text-sm text-muted-foreground tabular-nums">
              {Math.round(operation.progress * 100)}%
            </span>
          </Progress>
        )}
        {operation.status !== 'idle' && operation.status !== 'pending' && (
          <Alert variant={operation.status === 'error' ? 'destructive' : 'default'}>
            <AlertDescription role="status">{operation.message}</AlertDescription>
          </Alert>
        )}

        {logs.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Deployment log</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3">
              {logs.join('\n')}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
