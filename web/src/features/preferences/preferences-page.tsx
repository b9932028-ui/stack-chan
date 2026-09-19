import { Bluetooth, Cable, Info, Mic, Play, Save, Trash2, Unplug } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { OperationStatus } from '@/components/stackchan/operation-status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { PreferenceKey } from '@/features/preferences/preference-model'
import { usePreferences } from '@/features/preferences/use-preferences'

type FieldProps = Omit<ComponentProps<'input'>, 'id' | 'name' | 'value' | 'disabled' | 'onChange'> & {
  name: PreferenceKey
  label: string
  wide?: boolean
}

export function PreferencesPage() {
  const { t } = useI18n()
  const preferences = usePreferences()
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [powerCommand, setPowerCommand] = useState<'restart' | 'shutdown' | null>(null)
  const [balloonText, setBalloonText] = useState('Hello from Stack-chan')
  const [speechText, setSpeechText] = useState('こんにちは。スタックチャンです。')

  const canControl = (command: string) =>
    preferences.connected && !preferences.busy && preferences.controlCapabilities.has(command)

  const inputField = ({ name, label, type = 'text', wide, ...props }: FieldProps) => (
    <div className={wide ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}>
      <Label htmlFor={name}>{t(label)}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        value={preferences.values[name]}
        disabled={!preferences.connected || preferences.readOnly.has(name)}
        onChange={(event) => preferences.update(name, event.target.value)}
        {...props}
      />
    </div>
  )

  const selectField = (
    name: PreferenceKey,
    label: string,
    options: readonly { value: string; label: string; translate?: boolean }[],
    hint?: string,
    wide = false
  ) => (
    <div className={wide ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}>
      <Label htmlFor={name}>{t(label)}</Label>
      <Select
        value={preferences.values[name]}
        disabled={!preferences.connected || preferences.readOnly.has(name)}
        onValueChange={(value) => value && preferences.update(name, value)}
      >
        <SelectTrigger id={name} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span translate={option.translate === false ? 'no' : undefined}>
                {option.translate === false ? option.label : t(option.label)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs leading-5 text-muted-foreground">{t(hint)}</p>}
    </div>
  )

  const section = (title: string, children: ReactNode) => (
    <Card>
      <CardHeader>
        <CardTitle>{t(title)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  )

  return (
    <>
      <div className="page-container grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="grid gap-4 lg:sticky lg:top-22">
          <Card>
            <CardHeader>
              <CardTitle>{t('本体設定')}</CardTitle>
              <CardDescription>{t('USBまたはBLEでｽﾀｯｸﾁｬﾝに接続します。')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Alert role="note">
                <Info aria-hidden="true" />
                <AlertDescription>
                  {t('USBは通常画面のまま接続できます。BLEを使う場合は、本体の設定画面を開いてください。')}
                </AlertDescription>
              </Alert>
              {preferences.connected && preferences.transport === 'usb' && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {t(
                    preferences.controlAvailable
                      ? '通常画面のｽﾀｯｸﾁｬﾝをこのページから操作できます。'
                      : '本体が設定モードです。即時操作を使うには通常起動してください。'
                  )}
                </p>
              )}
              {preferences.connected ? (
                <Button variant="destructive" onClick={() => void preferences.disconnect()} disabled={preferences.busy}>
                  <Unplug data-icon="inline-start" />
                  {t('切断')}
                </Button>
              ) : (
                <div className="grid gap-2">
                  <Button onClick={() => void preferences.connect('usb')} disabled={preferences.busy}>
                    <Cable data-icon="inline-start" />
                    {t(
                      preferences.connection === 'connecting' && preferences.transport === 'usb'
                        ? '接続中…'
                        : 'USBで接続'
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => void preferences.connect('ble')} disabled={preferences.busy}>
                    <Bluetooth data-icon="inline-start" />
                    {t(
                      preferences.connection === 'connecting' && preferences.transport === 'ble'
                        ? '接続中…'
                        : 'BLEで接続'
                    )}
                  </Button>
                </div>
              )}
              <p className="text-sm text-muted-foreground" role="status">
                {t(preferences.connected ? '接続済み' : '未接続')}
              </p>
            </CardContent>
          </Card>
          <OperationStatus
            state={preferences.operation}
            labels={{
              pending: t('処理中'),
              success: t('設定を更新しました'),
              cancelled: t('お知らせ'),
              error: t('設定操作に失敗しました'),
            }}
          />
        </aside>

        <form
          className="grid min-w-0 gap-5"
          aria-label={t('設定項目')}
          onSubmit={(event) => {
            event.preventDefault()
            void preferences.save()
          }}
        >
          <Card>
            <CardHeader>
              <CardTitle>{t('USB即時操作')}</CardTitle>
              <CardDescription>{t('設定と同じUSB接続で、表情、動作、音声、LEDを操作します。')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="control-face">{t('顔の種類')}</Label>
                  <Select
                    disabled={!canControl('face')}
                    onValueChange={(value) => void preferences.control('face', value)}
                  >
                    <SelectTrigger id="control-face" className="w-full">
                      <SelectValue placeholder={t('選択')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="simple">{t('シンプル')}</SelectItem>
                      <SelectItem value="dog">{t('いぬ')}</SelectItem>
                      <SelectItem value="image">{t('画像')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="control-emotion">{t('表情')}</Label>
                  <Select
                    disabled={!canControl('emotion')}
                    onValueChange={(value) => void preferences.control('emotion', value)}
                  >
                    <SelectTrigger id="control-emotion" className="w-full">
                      <SelectValue placeholder={t('選択')} />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        ['neutral', '通常'],
                        ['happy', 'うれしい'],
                        ['angry', '怒る'],
                        ['sad', '悲しい'],
                        ['hot', '暑い'],
                        ['sleepy', '眠い'],
                      ].map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {t(label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="control-hand">{t('手のアニメーション')}</Label>
                  <Select
                    disabled={!canControl('hand')}
                    onValueChange={(value) => void preferences.control('hand', value)}
                  >
                    <SelectTrigger id="control-hand" className="w-full">
                      <SelectValue placeholder={t('選択')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('なし')}</SelectItem>
                      <SelectItem value="rock-paper-scissors">{t('グーチョキパー')}</SelectItem>
                      <SelectItem value="clap">{t('拍手')}</SelectItem>
                      <SelectItem value="thinking">{t('考え中')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="control-balloon">{t('吹き出し')}</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="control-balloon"
                    value={balloonText}
                    onChange={(event) => setBalloonText(event.target.value)}
                  />
                  <Button
                    type="button"
                    disabled={!canControl('balloon')}
                    onClick={() => void preferences.control('balloon', balloonText)}
                  >
                    {t('表示')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canControl('balloon')}
                    onClick={() => void preferences.control('balloon', '')}
                  >
                    {t('隠す')}
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="control-speech">{t('しゃべる内容')}</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="control-speech"
                    value={speechText}
                    onChange={(event) => setSpeechText(event.target.value)}
                  />
                  <Button
                    type="button"
                    disabled={!canControl('speak') || !speechText.trim()}
                    onClick={() => void preferences.control('speak', speechText)}
                  >
                    <Mic data-icon="inline-start" />
                    {t('しゃべる')}
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label>{t('頭の向き')}</Label>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['left', '左'],
                    ['right', '右'],
                    ['up', '上'],
                    ['down', '下'],
                    ['forward', '正面'],
                  ].map(([value, label]) => (
                    <Button
                      key={value}
                      type="button"
                      variant="outline"
                      disabled={!canControl('pose')}
                      onClick={() => void preferences.control('pose', value)}
                    >
                      {t(label)}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    disabled={!canControl('servoTest')}
                    onClick={() => void preferences.control('servoTest')}
                  >
                    <Play data-icon="inline-start" />
                    {t('サーボテスト')}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('lookAround')}
                  onClick={() => void preferences.control('lookAround', true)}
                >
                  {t('見回す')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('lookAround')}
                  onClick={() => void preferences.control('lookAround', false)}
                >
                  {t('見回し停止')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('led')}
                  onClick={() => void preferences.control('led', true)}
                >
                  {t('LEDオン')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('led')}
                  onClick={() => void preferences.control('led', false)}
                >
                  {t('LEDオフ')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('tone')}
                  onClick={() => void preferences.control('tone')}
                >
                  {t('テスト音')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('recordPlayback')}
                  onClick={() => void preferences.control('recordPlayback')}
                >
                  {t('録音して再生')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('camera')}
                  onClick={() => void preferences.control('camera')}
                >
                  {t('カメラ表示')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('color')}
                  onClick={() => void preferences.control('color', 'light')}
                >
                  {t('白')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canControl('color')}
                  onClick={() => void preferences.control('color', 'dark')}
                >
                  {t('黒')}
                </Button>
              </div>
              <div className="grid gap-3 border-t pt-4 sm:col-span-2">
                <p className="text-sm font-medium">{t('電源操作')}</p>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'USB接続が切断されます。未保存の設定は先に保存してください。電源を切った後は本体で電源を入れてください。'
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canControl('restart')}
                    onClick={() => setPowerCommand('restart')}
                  >
                    {t('再起動')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={!canControl('shutdown')}
                    onClick={() => setPowerCommand('shutdown')}
                  >
                    {t('電源を切る')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          {section(
            'Wi-Fi',
            <>
              {inputField({
                name: 'wifi.ssid',
                label: 'SSID',
                autoComplete: 'off',
              })}
              {inputField({
                name: 'wifi.password',
                label: 'パスワード',
                type: 'password',
                autoComplete: 'off',
              })}
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!preferences.connected || preferences.busy}
                  onClick={() => setClearDialogOpen(true)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t('Wi-Fi設定を消去')}
                </Button>
              </div>
            </>
          )}
          {section(
            '外観',
            <>
              {selectField('ui.type', '顔の種類', [
                { value: 'simple', label: 'シンプル' },
                { value: 'dog', label: 'いぬ' },
              ])}
              {selectField('ui.language', '本体の表示言語', [
                { value: 'ja', label: '日本語', translate: false },
                { value: 'en', label: 'English', translate: false },
                { value: 'zh-CN', label: '简体中文', translate: false },
              ])}
              <div className="grid gap-2 sm:col-span-2">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="ui.brightness">{t('画面の明るさ')}</Label>
                  <output htmlFor="ui.brightness" className="text-sm tabular-nums text-muted-foreground">
                    {preferences.values['ui.brightness']}%
                  </output>
                </div>
                <input
                  id="ui.brightness"
                  name="ui.brightness"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={preferences.values['ui.brightness']}
                  disabled={!preferences.connected || preferences.readOnly.has('ui.brightness')}
                  className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                  onChange={(event) => preferences.update('ui.brightness', event.target.value)}
                />
                <p className="text-xs leading-5 text-muted-foreground">{t('設定を保存すると本体へ反映されます。')}</p>
              </div>
            </>
          )}
          {section(
            'サーボ',
            <>
              {selectField(
                'driver.type',
                'ドライバー',
                [
                  {
                    value: 'm5stackchan',
                    label: 'M5StackChan Servo（CoreS3専用・推奨）',
                  },
                  { value: 'scservo', label: 'SCServo（汎用・外部配線向け）' },
                  { value: 'dynamixel', label: 'Dynamixel（Protocol 2）' },
                  { value: 'rs30x', label: 'RS30X' },
                  { value: 'pwm', label: 'PWM（SG-90）' },
                  { value: 'none', label: 'なし' },
                ],
                'M5StackChan Servoは専用UART、ゼロ位置、可動域、PY32サーボ電源を設定します。CoreS3専用ファームウェアではこの項目に固定されます。',
                true
              )}
              {inputField({
                name: 'driver.offsetPan',
                label: 'パン オフセット',
                type: 'number',
              })}
              {inputField({
                name: 'driver.offsetTilt',
                label: 'チルト オフセット',
                type: 'number',
              })}
            </>
          )}
          {section(
            '音声合成',
            <>
              {selectField('tts.type', 'サービス', [
                { value: 'voicevox', label: 'VOICEVOX', translate: false },
                { value: 'elevenlabs', label: 'ElevenLabs', translate: false },
                { value: 'google-tts', label: 'Google TTS', translate: false },
                { value: 'openai', label: 'OpenAI', translate: false },
                { value: 'local', label: 'ローカル' },
              ])}
              {inputField({
                name: 'tts.host',
                label: 'ホスト',
                placeholder: 'my-tts-host.local',
              })}
              {inputField({
                name: 'tts.port',
                label: 'ポート',
                type: 'number',
                placeholder: '50021',
              })}
              {inputField({
                name: 'tts.voice',
                label: '音声',
                placeholder: 'ally',
              })}
              {inputField({
                name: 'tts.token',
                label: 'トークン',
                type: 'password',
              })}
              {inputField({
                name: 'tts.volume',
                label: '音量（0–1）',
                type: 'number',
                step: '0.1',
                min: '0',
                max: '1',
              })}
            </>
          )}
          {section(
            'AI',
            <>
              {inputField({
                name: 'ai.token',
                label: 'トークン',
                type: 'password',
              })}
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="ai.context">{t('システムロール')}</Label>
                <Textarea
                  id="ai.context"
                  rows={5}
                  value={preferences.values['ai.context']}
                  disabled={!preferences.connected || preferences.readOnly.has('ai.context')}
                  placeholder="You are Stack-chan（スタックチャン）, the palm sized super kawaii companion robot."
                  onChange={(event) => preferences.update('ai.context', event.target.value)}
                />
              </div>
            </>
          )}
          {section(
            'MCP Server',
            inputField({
              name: 'mcp.token',
              label: 'Bearerトークン',
              type: 'password',
              wide: true,
            })
          )}
          <footer className="sticky bottom-0 z-10 flex justify-end border-t bg-background/95 py-3 backdrop-blur">
            <Button type="submit" disabled={!preferences.connected || preferences.busy}>
              <Save data-icon="inline-start" />
              {t('設定を保存')}
            </Button>
          </footer>
        </form>
      </div>

      <AlertDialog
        open={powerCommand !== null}
        onOpenChange={(open) => {
          if (!open) setPowerCommand(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(powerCommand === 'restart' ? '再起動しますか？' : '電源を切りますか？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'USB接続が切断されます。未保存の設定は先に保存してください。電源を切った後は本体で電源を入れてください。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('キャンセル')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!powerCommand || !canControl(powerCommand)}
              onClick={() => {
                if (powerCommand) void preferences.control(powerCommand)
                setPowerCommand(null)
              }}
            >
              {t('実行する')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Wi-Fi設定を消去しますか？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('保存済みのSSIDとパスワードを消去します。次回はオフラインで起動します。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('キャンセル')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setClearDialogOpen(false)
                void preferences.clearWifi()
              }}
            >
              {t('消去する')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
