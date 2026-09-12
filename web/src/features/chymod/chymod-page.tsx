import { Cable, Unplug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useUSBControl } from '@/features/chymod/use-usb-control'

type ActionControl = {
  id: string
  kind: 'actions'
  command: string
  options: string[]
}

type ToggleControl = {
  id: string
  kind: 'toggle'
  command: string
}

type ChyModDescriptor = {
  version: number
  controls: Array<ActionControl | ToggleControl>
}

type ChyModStatus = {
  version: number
  state: string
  randomEnabled: boolean
  elapsedMs: number
  durationMs: number | null
  nextRandomInMs: number | null
}

const animationLabels: Record<string, string> = {
  idle: '閒置',
  blink: '眨眼',
  lookAround: '四處看看',
  happy: '開心',
  angry: '生氣',
}

function isDescriptor(value: unknown): value is ChyModDescriptor {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as ChyModDescriptor).controls))
}

function isStatus(value: unknown): value is ChyModStatus {
  return Boolean(value && typeof value === 'object' && typeof (value as ChyModStatus).state === 'string')
}

export function ChyModPage() {
  const { t } = useI18n()
  const usb = useUSBControl()
  const [descriptor, setDescriptor] = useState<ChyModDescriptor | null>(null)
  const [status, setStatus] = useState<ChyModStatus | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [busyControl, setBusyControl] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    if (!usb.capabilities.has('chymod.status')) return
    try {
      const result = await usb.request('chymod.status')
      if (isStatus(result)) setStatus(result)
    } catch (error) {
      setCommandError(String(error))
    }
  }, [usb.capabilities, usb.request])

  useEffect(() => {
    if (!usb.connected || !usb.capabilities.has('chymod.describe')) return
    let active = true
    void usb
      .request('chymod.describe')
      .then((result) => {
        if (active && isDescriptor(result)) setDescriptor(result)
      })
      .catch((error) => active && setCommandError(String(error)))
    void refreshStatus()
    const timer = window.setInterval(() => void refreshStatus(), 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refreshStatus, usb.capabilities, usb.connected, usb.request])

  const runCommand = async (controlId: string, command: string, value: unknown) => {
    setBusyControl(controlId)
    setCommandError(null)
    try {
      const result = await usb.request(command, value)
      if (isStatus(result)) setStatus(result)
    } catch (error) {
      setCommandError(String(error))
    } finally {
      setBusyControl(null)
    }
  }

  return (
    <div className="page-container grid gap-6 py-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside>
        <Card>
          <CardHeader>
            <CardTitle>ChyMOD</CardTitle>
            <CardDescription>{t('USBでChyMODの状態と動作を制御します。')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {usb.connected ? (
              <Button variant="destructive" onClick={() => void usb.disconnect()}>
                <Unplug data-icon="inline-start" />
                {t('切断')}
              </Button>
            ) : (
              <Button disabled={usb.connection === 'connecting'} onClick={() => void usb.connect()}>
                <Cable data-icon="inline-start" />
                {t(usb.connection === 'connecting' ? '接続中…' : 'USBで接続')}
              </Button>
            )}
            <p className="text-sm text-muted-foreground" role="status">
              {t(usb.connected ? '接続済み' : '未接続')}
            </p>
          </CardContent>
        </Card>
      </aside>

      <main className="grid min-w-0 gap-5">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>{t('動畫狀態機')}</CardTitle>
                <CardDescription>{t('手動動畫會立即播放，結束後回到閒置並重新開始亂數倒數。')}</CardDescription>
              </div>
              <Badge variant={status?.state === 'idle' ? 'secondary' : 'default'}>
                {t(status ? (animationLabels[status.state] ?? status.state) : '等待狀態')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-6">
            {!usb.connected && (
              <Alert>
                <AlertDescription>{t('請先以USB連接已安裝ChyMOD的ｽﾀｯｸﾁｬﾝ。')}</AlertDescription>
              </Alert>
            )}
            {usb.connected && !usb.capabilities.has('chymod.status') && (
              <Alert variant="destructive">
                <AlertDescription>{t('目前Firmware或MOD不支援ChyMOD控制協定。')}</AlertDescription>
              </Alert>
            )}
            {(usb.error || commandError) && (
              <Alert variant="destructive">
                <AlertDescription>{usb.error?.message ?? commandError}</AlertDescription>
              </Alert>
            )}

            {status && (
              <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">{t('目前動畫')}</dt>
                  <dd className="font-medium">{t(animationLabels[status.state] ?? status.state)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('已播放')}</dt>
                  <dd className="font-medium">{(status.elapsedMs / 1000).toFixed(1)}s</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('動畫長度')}</dt>
                  <dd className="font-medium">
                    {status.durationMs === null ? '—' : `${(status.durationMs / 1000).toFixed(1)}s`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('下次亂數')}</dt>
                  <dd className="font-medium">
                    {status.nextRandomInMs === null ? '—' : `${(status.nextRandomInMs / 1000).toFixed(1)}s`}
                  </dd>
                </div>
              </dl>
            )}

            {descriptor?.controls.map((control) => {
              if (control.kind === 'actions') {
                return (
                  <section key={control.id} className="grid gap-3">
                    <Label>{t('立即播放')}</Label>
                    <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
                      {control.options.map((option) => (
                        <Button
                          key={option}
                          type="button"
                          variant={status?.state === option ? 'default' : 'outline'}
                          disabled={!usb.connected || busyControl !== null}
                          onClick={() => void runCommand(control.id, control.command, option)}
                        >
                          {t(animationLabels[option] ?? option)}
                        </Button>
                      ))}
                    </div>
                  </section>
                )
              }
              return (
                <section key={control.id} className="flex items-center gap-3 rounded-lg border p-4">
                  <Checkbox
                    id={`chymod-${control.id}`}
                    checked={status?.randomEnabled ?? false}
                    disabled={!usb.connected || busyControl !== null}
                    onCheckedChange={(checked) => void runCommand(control.id, control.command, checked === true)}
                  />
                  <Label htmlFor={`chymod-${control.id}`}>{t('啟用每3秒亂數播放')}</Label>
                </section>
              )
            })}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
