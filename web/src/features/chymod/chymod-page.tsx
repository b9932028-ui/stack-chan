import { Cable, Unplug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { CodexVoiceCard } from '@/features/chymod/codex-voice-card'
import { ModDeployCard } from '@/features/chymod/mod-deploy-card'
import { MotionControl, type MotionControlDescriptor, type MotionStatus } from '@/features/chymod/motion-control'
import { useCodexVoice } from '@/features/chymod/use-codex-voice'
import {
  type WakeOrientation,
  WakeOrientationCard,
  type WakeOrientationDescriptor,
} from '@/features/chymod/wake-orientation-card'

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
  statusKey?: 'randomEnabled' | 'wakeEnabled'
  label?: string
}

type TeamsPresence = 'available' | 'busy' | 'away'

type TeamsStatusControl = {
  id: string
  kind: 'teams-status'
  command: string
  statusKey: 'teamsStatus'
  presences: TeamsPresence[]
  maxLength: number
}

type ChyModDescriptor = {
  version: number
  controls: Array<
    ActionControl | ToggleControl | TeamsStatusControl | MotionControlDescriptor | WakeOrientationDescriptor
  >
}

type ChyModStatus = {
  version: number
  state: string
  randomEnabled: boolean
  elapsedMs: number
  durationMs: number | null
  nextRandomInMs: number | null
  wakeEnabled?: boolean
  wakeError?: string | null
  wakeHitCount?: number
  lastWakePhrase?: string | null
  wakeOrientation?: WakeOrientation | null
  teamsStatus?: { presence: TeamsPresence; message: string }
  motion?: MotionStatus
}

const teamsPresenceLabels: Record<TeamsPresence, string> = {
  available: 'Available',
  busy: 'Busy',
  away: 'Away',
}

const teamsPresenceColors: Record<TeamsPresence, string> = {
  available: 'bg-[#78a81f]',
  busy: 'bg-[#c4314b]',
  away: 'bg-[#f5c400]',
}

const animationLabels: Record<string, string> = {
  idle: '閒置',
  blink: '眨眼',
  lookAround: '四處看看',
  happy: '開心',
  angry: '生氣',
  working: '工作中',
  microsoft: 'Microsoft',
  rainbow: 'Rainbow',
}

/**
 * The MOD describes which controls exist; their wording stays here so the page
 * reads in the viewer's language instead of the firmware's fixed English.
 */
const toggleLabels: Record<string, string> = {
  randomEnabled: '啟用每3秒亂數播放',
  wakeEnabled: 'Enable “Hey Copilot” wake animation',
}

function isDescriptor(value: unknown): value is ChyModDescriptor {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as ChyModDescriptor).controls))
}

function isStatus(value: unknown): value is ChyModStatus {
  return Boolean(value && typeof value === 'object' && typeof (value as ChyModStatus).state === 'string')
}

export function ChyModPage() {
  const { t } = useI18n()
  const voice = useCodexVoice()
  const usb = {
    connection: voice.connection === 'ready' ? 'connected' : voice.connection,
    connected: voice.connection === 'ready',
    capabilities: voice.controlCapabilities,
    error: voice.error ? { message: voice.error } : null,
    connect: voice.connect,
    disconnect: voice.disconnect,
    request: voice.requestControl,
  }
  const [descriptor, setDescriptor] = useState<ChyModDescriptor | null>(null)
  const [status, setStatus] = useState<ChyModStatus | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [busyControl, setBusyControl] = useState<string | null>(null)
  const [teamsPresence, setTeamsPresence] = useState<TeamsPresence>('available')
  const [teamsMessage, setTeamsMessage] = useState('WFH')
  const [teamsDraftInitialized, setTeamsDraftInitialized] = useState(false)
  const animationControl = descriptor?.controls.find(
    (control): control is ActionControl => control.kind === 'actions' && control.command === 'chymod.play'
  )
  const motionControl = descriptor?.controls.find(
    (control): control is MotionControlDescriptor => control.kind === 'motion'
  )
  const wakeOrientationControl = descriptor?.controls.find(
    (control): control is WakeOrientationDescriptor => control.kind === 'orientation'
  )
  const teamsStatusControl = descriptor?.controls.find(
    (control): control is TeamsStatusControl => control.kind === 'teams-status'
  )

  useEffect(() => {
    if (teamsDraftInitialized || !status?.teamsStatus) return
    setTeamsPresence(status.teamsStatus.presence)
    setTeamsMessage(status.teamsStatus.message)
    setTeamsDraftInitialized(true)
  }, [status?.teamsStatus, teamsDraftInitialized])

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
      <aside className="grid content-start gap-5">
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
        <ModDeployCard controlConnected={usb.connected} disconnectControl={usb.disconnect} />
      </aside>

      <main className="grid min-w-0 gap-5">
        <CodexVoiceCard voice={voice} />
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
            {status?.wakeError && (
              <Alert variant="destructive">
                <AlertDescription>{t('喚醒辨識失敗：{error}', { error: status.wakeError })}</AlertDescription>
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
                <div>
                  <dt className="text-muted-foreground">{t('喚醒辨識')}</dt>
                  <dd className="font-medium">{t(status.wakeEnabled ? '聆聽中' : '已關閉')}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('喚醒次數')}</dt>
                  <dd className="font-medium">{status.wakeHitCount ?? 0}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">{t('最後喚醒語句')}</dt>
                  <dd className="font-medium">{status.lastWakePhrase ?? '—'}</dd>
                </div>
              </dl>
            )}

            {animationControl && (
              <section className="grid gap-3">
                <Label>{t('立即播放')}</Label>
                <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
                  {animationControl.options.map((animation) => (
                    <Button
                      key={animation}
                      type="button"
                      variant={status?.state === animation ? 'default' : 'outline'}
                      disabled={!usb.connected || busyControl !== null}
                      onClick={() => void runCommand(animationControl.id, animationControl.command, animation)}
                    >
                      {t(animationLabels[animation] ?? animation)}
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {descriptor?.controls.map((control) => {
              if (control.kind !== 'toggle') return null
              return (
                <section key={control.id} className="flex items-center gap-3 rounded-lg border p-4">
                  <Checkbox
                    id={`chymod-${control.id}`}
                    checked={
                      status
                        ? Boolean(
                            status[
                              control.statusKey ?? (control.id === 'wakeEnabled' ? 'wakeEnabled' : 'randomEnabled')
                            ]
                          )
                        : false
                    }
                    disabled={!usb.connected || busyControl !== null}
                    onCheckedChange={(checked) => void runCommand(control.id, control.command, checked === true)}
                  />
                  <Label htmlFor={`chymod-${control.id}`}>
                    {toggleLabels[control.id] ? t(toggleLabels[control.id]) : (control.label ?? control.id)}
                  </Label>
                </section>
              )
            })}
          </CardContent>
        </Card>
        {teamsStatusControl && (
          <Card>
            <CardHeader>
              <CardTitle>Teams Status</CardTitle>
              <CardDescription>Show a Teams icon, presence light, and short message on the display.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-3">
                <Label>Presence</Label>
                <RadioGroup
                  value={teamsPresence}
                  onValueChange={(value) => setTeamsPresence(value as TeamsPresence)}
                  className="sm:grid-cols-3"
                >
                  {teamsStatusControl.presences.map((presence) => (
                    <Label
                      key={presence}
                      htmlFor={`chymod-teams-${presence}`}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border p-3"
                    >
                      <RadioGroupItem
                        id={`chymod-teams-${presence}`}
                        value={presence}
                        disabled={!usb.connected || busyControl !== null}
                      />
                      <span className={`size-4 rounded-sm ${teamsPresenceColors[presence]}`} aria-hidden="true" />
                      {teamsPresenceLabels[presence]}
                    </Label>
                  ))}
                </RadioGroup>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="chymod-teams-message">Message</Label>
                <Input
                  id="chymod-teams-message"
                  value={teamsMessage}
                  maxLength={teamsStatusControl.maxLength}
                  disabled={!usb.connected || busyControl !== null}
                  placeholder="WFH"
                  onChange={(event) => setTeamsMessage(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {teamsMessage.length}/{teamsStatusControl.maxLength} characters
                </p>
              </div>
              <Button
                type="button"
                disabled={!usb.connected || busyControl !== null}
                onClick={() =>
                  void runCommand(teamsStatusControl.id, teamsStatusControl.command, {
                    presence: teamsPresence,
                    message: teamsMessage,
                  })
                }
              >
                Show Teams status
              </Button>
            </CardContent>
          </Card>
        )}
        {wakeOrientationControl && (
          <WakeOrientationCard
            control={wakeOrientationControl}
            status={status ? (status.wakeOrientation ?? null) : undefined}
            connected={usb.connected}
            request={usb.request}
            onError={setCommandError}
          />
        )}
        {motionControl && (
          <MotionControl
            control={motionControl}
            status={status?.motion}
            connected={usb.connected}
            request={usb.request}
            onError={setCommandError}
          />
        )}
      </main>
    </div>
  )
}
