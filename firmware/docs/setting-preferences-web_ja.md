# Webブラウザを使ったｽﾀｯｸﾁｬﾝの設定変更

[English](./setting-preferences-web.md)

WebブラウザからUSBまたはBLE(Bluetooth Low Energy)でｽﾀｯｸﾁｬﾝの設定を書き換えることができます。
どちらも事前にWi-Fiを設定する必要はありません。

## 前提

* ブラウザがUSBの場合はWeb Serial、BLEの場合はWeb Bluetooth APIに対応していること
* USB設定はM5StackChan CoreS3ファームウェアで使用できます。他の対応機種ではBLEを使用してください

## 手順

* Cボタンを押しながらｽﾀｯｸﾁｬﾝを起動する。タッチパネル搭載のモデル（Core2、CoreS3）はタッチパネルを触りながらｽﾀｯｸﾁｬﾝを起動する
* M5Stackに設定画面が表示される

![設定画面（M5Stack）](./images/web-preference-launch.jpg)

* https://stack-chan.github.io/stack-chan/web/preference/ を開く

![設定画面（Webブラウザ）](./images/web-preference-top.png)

* 「USBで接続」を選びｽﾀｯｸﾁｬﾝのUSBシリアルデバイスを選択するか、「BLEで接続」を選択する

![接続画面](./images/web-preference-connect.png)

* BLEの場合は「STK」を選択する

![設定フォーム](./images/web-preference-form.png)

* 設定項目が一覧表示されるので、設定したい項目を編集して「Submit」を選択する
* 「Preference set」という表示が出たら書き込み成功！

## USBからリアルタイム操作する

デフォルト動作を通常起動した状態で、同じ設定ページからUSB接続するとリアルタイム操作パネルを利用できます。顔・感情・吹き出し・読み上げ・頭と手の動き・見回し・サーボテスト・トーン再生・録音再生・画面色・カメラプレビュー・対応機種のLEDを操作できます。

設定フォームとリアルタイム操作は1つのUSBシリアル接続を共有します。リアルタイム操作はすぐに反映されますが、保存した設定の一部はStack-chanの再起動後に反映されます。

Stack-chanを設定画面で起動した場合も設定編集はできますが、リアルタイム操作は無効になります。
