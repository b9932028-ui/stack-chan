import { Cpu, FileCog, RotateCcw, TriangleAlert, Usb } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { LogConsole } from '@/components/stackchan/log-console'
import { OperationStatus } from '@/components/stackchan/operation-status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FIRMWARE_BOARDS } from '@/features/firmware-install/boards'
import {
  createLocalFirmwareBoard,
  inspectLocalFirmwareFiles,
  LOCAL_FIRMWARE_BINARIES,
  LOCAL_MANIFEST_NAME,
} from '@/features/firmware-install/local-firmware'
import { useFirmwareInstall } from '@/features/firmware-install/use-firmware-install'
import { type OperationState } from '@/features/operations/operation-state'
import { useLogBuffer } from '@/hooks/use-log-buffer'

type FirmwareSourceMode = 'bundled' | 'local'

export function HostInstallForm() {
  const { t } = useI18n()
  const [boardId, setBoardId] = useState(FIRMWARE_BOARDS[0].id)
  const [sourceMode, setSourceMode] = useState<FirmwareSourceMode>('bundled')
  const [localFiles, setLocalFiles] = useState<File[]>([])
  const { entries, append, clear } = useLogBuffer()
  const onLog = useCallback(
    (message: string, level: 'info' | 'warning' | 'error' = 'info') => append(message, level, 'device'),
    [append]
  )
  const install = useFirmwareInstall(onLog)
  const board = FIRMWARE_BOARDS.find((candidate) => candidate.id === boardId) ?? FIRMWARE_BOARDS[0]
  const busy = ['selecting-port', 'inspecting-device', 'confirming', 'installing'].includes(install.state.status)

  const selection = useMemo(() => inspectLocalFirmwareFiles(localFiles), [localFiles])
  const usingLocal = sourceMode === 'local'
  const target = useMemo(
    () => (usingLocal ? createLocalFirmwareBoard(board, localFiles) : board),
    [usingLocal, board, localFiles]
  )
  const blocked = usingLocal && !selection.installable

  const operation = useMemo<OperationState>(() => {
    switch (install.state.status) {
      case 'idle':
        return { status: 'idle' }
      case 'selecting-port':
        return { status: 'pending', message: t('USBデバイスを選択しています') }
      case 'inspecting-device':
        return { status: 'pending', message: t('接続したデバイスを確認しています') }
      case 'confirming':
        return { status: 'pending', message: t('書き込み内容を確認してください') }
      case 'installing':
        return { status: 'pending', message: t('ファームウェアを書き込んでいます'), progress: install.state.progress }
      case 'success':
        return {
          status: 'success',
          result: install.state.result,
          message: t('書き込みが終了し、デバイスを再起動しました。'),
        }
      case 'cancelled':
        return { status: 'cancelled', message: t('デバイスには変更を加えていません。') }
      case 'error':
        return { status: 'error', error: install.state.error }
    }
  }, [install.state, t])

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('ファームウェア書き込み')}</CardTitle>
          <CardDescription>
            {t('USBで接続するｽﾀｯｸﾁｬﾝのボードと、書き込むファームウェアを選択してください。')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="target-board">{t('ボード')}</Label>
            <Select value={boardId} onValueChange={(value) => value && setBoardId(value)} disabled={busy}>
              <SelectTrigger id="target-board" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIRMWARE_BOARDS.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>{t('ファームウェアの入手元')}</Label>
            <RadioGroup
              value={sourceMode}
              onValueChange={(value) => {
                setSourceMode(value as FirmwareSourceMode)
                install.reset()
              }}
              disabled={busy}
              className="grid gap-2 sm:grid-cols-2"
            >
              {(
                [
                  ['bundled', t('同梱のファームウェア')],
                  ['local', t('ローカルのファイルを指定')],
                ] as const
              ).map(([value, label]) => (
                <Label
                  key={value}
                  htmlFor={`firmware-source-${value}`}
                  className="flex items-center gap-2 rounded-lg border border-input p-3 font-normal has-data-checked:border-primary has-data-checked:bg-primary/5"
                >
                  <RadioGroupItem id={`firmware-source-${value}`} value={value} />
                  {label}
                </Label>
              ))}
            </RadioGroup>
          </div>

          {usingLocal && (
            <div className="grid gap-2">
              <Label htmlFor="local-firmware-files">{t('ファームウェアファイル')}</Label>
              <Input
                id="local-firmware-files"
                type="file"
                multiple
                accept=".bin,.json,application/octet-stream,application/json"
                disabled={busy}
                onChange={(event) => {
                  setLocalFiles(Array.from(event.target.files ?? []))
                  install.reset()
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('ビルド出力フォルダ内の{files}をまとめて選択してください。', {
                  files: LOCAL_FIRMWARE_BINARIES.join(' / '),
                })}
              </p>

              {localFiles.length > 0 && (
                <dl className="grid gap-1 rounded-lg bg-muted p-3 text-xs">
                  {selection.recognized.map((file) => (
                    <div key={file.name} className="flex items-center justify-between gap-3">
                      <dt className="flex items-center gap-1.5 font-medium">
                        <FileCog className="size-3.5" aria-hidden="true" />
                        {file.name}
                      </dt>
                      <dd className="text-muted-foreground">
                        {t('{bytes}バイト', { bytes: file.size.toLocaleString() })}
                      </dd>
                    </div>
                  ))}
                  {selection.hasManifest && (
                    <div className="text-muted-foreground">
                      {t('{name}を使って書き込み位置を決めます。', { name: LOCAL_MANIFEST_NAME })}
                    </div>
                  )}
                  {selection.ignored.length > 0 && (
                    <div className="text-muted-foreground">
                      {t('書き込みに使わないファイル: {files}', {
                        files: selection.ignored.map((file) => file.name).join(', '),
                      })}
                    </div>
                  )}
                </dl>
              )}

              {localFiles.length > 0 && !selection.installable && (
                <Alert variant="destructive" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{t('書き込めるファームウェアが見つかりません')}</AlertTitle>
                  <AlertDescription>
                    {t('少なくとも{name}を選択してください。', { name: 'xs_esp32.bin' })}
                  </AlertDescription>
                </Alert>
              )}

              {selection.installable && !selection.hasManifest && selection.missing.length > 0 && (
                <Alert role="note">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{t('一部の領域だけを書き込みます')}</AlertTitle>
                  <AlertDescription>
                    {t('選択されていない{files}は、デバイス上のものをそのまま使います。', {
                      files: selection.missing.join(' / '),
                    })}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <Alert className="border-amber-500/50 bg-amber-500/10" role="note">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t('書き込み前にご確認ください')}</AlertTitle>
            <AlertDescription>
              {t('書き込みを開始すると、本体に保存した設定とインストール済みのMODはすべて消去されます。')}
            </AlertDescription>
          </Alert>
          <OperationStatus
            state={operation}
            labels={{
              pending: t('書き込み処理中'),
              success: t('書き込みに成功しました'),
              cancelled: t('書き込みをキャンセルしました'),
              error: t('書き込みに失敗しました'),
            }}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="min-h-10 flex-1" onClick={() => void install.install(target)} disabled={busy || blocked}>
              <Usb data-icon="inline-start" />
              {install.state.status === 'idle' ? t('USBに接続して書き込む') : t('もう一度書き込む')}
            </Button>
            {!busy && install.state.status !== 'idle' && (
              <Button variant="outline" onClick={install.reset}>
                <RotateCcw data-icon="inline-start" />
                {t('状態をリセット')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <LogConsole entries={entries} onClear={clear} title={t('書き込みログ')} />

      <AlertDialog open={install.state.status === 'confirming'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Cpu />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('このデバイスへ書き込みますか？')}</AlertDialogTitle>
            <AlertDialogDescription>{t('既存のファームウェアを選択した内容で上書きします。')}</AlertDialogDescription>
          </AlertDialogHeader>
          {install.state.status === 'confirming' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted p-3 text-sm">
              <dt className="text-muted-foreground">{t('ボード')}</dt>
              <dd className="font-medium">{install.state.device.board.label}</dd>
              <dt className="text-muted-foreground">{t('検出')}</dt>
              <dd className="font-medium">{install.state.device.chip}</dd>
              <dt className="text-muted-foreground">{t('バージョン')}</dt>
              <dd className="font-medium">{install.state.device.firmwareVersion}</dd>
              <dt className="text-muted-foreground">{t('書き込む領域')}</dt>
              <dd className="font-medium">{t('{count}個', { count: install.state.device.partCount })}</dd>
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={install.cancel}>{t('キャンセル')}</AlertDialogCancel>
            <AlertDialogAction onClick={install.confirm}>{t('書き込む')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
