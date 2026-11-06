# Phone Wall Remote

Open `../PhoneWallRemote.xcodeproj` in Xcode on the Mac that will build the control iPhone app. Select the `PhoneWallRemote` target, choose a signing team, and set a bundle identifier available to that team. The target is iPhone-only and requires iOS 16 or newer.

The app has three main controls:

- **Night mode** sets the installation's night brightness to zero and enters night mode.
- **Day mode** sets the installation's brightness to one, enters exhibition mode, and starts Roland Barthes from the beginning.
- **Shut down installation** asks for confirmation, sends all connected phones to Night mode, and then cleanly shuts down macOS after an eight-second delay. Wait for the Mac mini's power light to go off before unplugging it. This M1 Mac mini needs its physical power button pressed after reconnecting power.

It refreshes the controller every five seconds and lists paired, connected phones whose latest power report is less than a minute old and says they are unplugged. Phones without a current power report are counted separately.

On first launch, tap Connection and enter `sms-ingestor.local` (or simply `sms-ingestor`) and the Phone Wall operator key. The app uses `http://sms-ingestor.local:3100` on the installation LAN. Approve the iPhone's Local Network permission prompt. A private HTTPS Tailscale Serve URL also remains supported when both devices are on the same tailnet. The URL is saved in app preferences and the key in the iPhone Keychain. The code contains no operator key. LAN HTTP sends the operator key without transport encryption, so keep the installation Wi-Fi private and trusted.

The packaged Mac mini keeps its operator key at `/Library/Application Support/PhoneWall/operator.key`. Keep it private; this app uses the same full-control credential as the dashboard.
