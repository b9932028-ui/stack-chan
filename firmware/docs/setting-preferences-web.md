# Changing Stack-chan Settings Using a Web Browser

[日本語](./setting-preferences-web_ja.md)

You can modify Stack-chan's settings from a web browser over USB or BLE (Bluetooth Low Energy).
Neither connection requires Wi-Fi to be configured in advance.

## Prerequisites

* Your browser supports Web Serial for USB or Web Bluetooth for BLE
* USB settings currently require M5StackChan CoreS3 firmware; use BLE on the other supported targets

## Steps

* Start Stack-chan while pressing the C button. For models with a touch panel (Core2, CoreS3), start Stack-chan while touching the panel.
* The settings screen will be displayed on the M5Stack.

![Settings Screen (M5Stack)](./images/web-preference-launch.jpg)

* Open https://stack-chan.github.io/stack-chan/web/preference/

![Settings Screen (Web Browser)](./images/web-preference-top.png)

* Choose "Connect with USB" and select the Stack-chan USB serial device, or choose "Connect with Bluetooth"

![Connection Screen](./images/web-preference-connect.png)

* For Bluetooth, select "STK"

![Settings Form](./images/web-preference-form.png)

* A list of settings items will be displayed. Edit the items you wish to set and select "Submit."
* If you see a message saying "Preference set," the settings have been successfully written!

## Live control over USB

With the default behavior running normally, connect with USB from the same settings page to use the live-control panel. You can change the face and emotion, show a speech balloon, speak text, move the head and hands, start or stop looking around, test the servo, play a tone, record and play audio, switch the screen color, preview the camera, and control the LED when the hardware supports it.

The settings form and live controls share one USB serial connection. Live-control commands take effect immediately; saved preference changes may require restarting Stack-chan.

When Stack-chan is started in the settings screen, the page remains available for editing preferences, but live controls are disabled.
