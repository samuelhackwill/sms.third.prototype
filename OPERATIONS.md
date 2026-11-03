# Staff quick guide

Use this guide after an installer has paired and tested all screens.

To assign positions (app 2.1+): open **Pair / Position** and press **Start Pairing Mode**. Connected phones turn red. Tap each phone once, starting at the top left, moving left-to-right across each row, then down. Wait for green confirmation before tapping the next phone. Press **Stop Pairing** on the Mac whenever finished, even with fewer than 30 phones. Assignments are saved immediately; a full wall stops automatically. Starting another session begins again at slot 0 and replaces positions as you tap, without erasing untouched slots. Pairing expires after ten minutes for safety.

The dashboard opens on **Control**: Pair / Position first, **Send Test Text** second. Stop pairing, then press Send Test Text to scroll “Bla bla bla” once across each occupied row, right-to-left, with 750 ms between row starts. It resumes exhibition mode and reports preparation/failure; offline paired phones are skipped and counted rather than blocking the test. The previous artwork remains in Advanced releases for reuse/rollback. All previous tools, including Night Mode, the virtual matrix, manual slot fields and scene editor, are preserved in **Advanced**.

Use the **Text speed** slider (20–1000 logical pixels/second) before sending a test. Try 80–120 for slower movement; the original speed was 240. It changes the next test, not the text already moving. The last sent speed is saved on the controller and restored when reopening the dashboard. No phone update is required. Current native runtime targets 30 frames/second, not 60; actual device performance may be lower. Speed and frame rate are independent.

For a published server update, open **Update Phone Wall** in Applications and approve once; no package reinstall or Terminal is required after installing version 2.2.0. Only committed/pushed source is downloaded. Update outside exhibition hours with internet available; normal operation remains offline-capable. Artwork-only changes do not require an IPA update.

Artistic editing and staged release instructions are in [RUNTIME.md](RUNTIME.md). Use one phone, then a selected group, then promote the same immutable release to the entire matrix. Do not treat a release as successful until its target phones report displayed; a preparation error leaves the previous artwork in place.

1. Switch on the dedicated router, screen chargers and Mac mini. If the Mac was deliberately shut down, press its power button and log into the installation account as instructed. Restored power alone may not start it.
2. Open **Phone Wall Dashboard** in Applications on the Mac mini. It signs in automatically; no Terminal or operator key is needed with the packaged installation. Check the device count and text status labels.
3. For the approved exhibition artwork, open **Advanced** and press **Start Exhibition**. Check all screens. If a scene needs selecting, choose the approved scene before starting.
4. At closing, open **Advanced** and press **Night Mode**. Screens become black and dim; phones remain plugged in and reachable. Do not shut them down individually.
5. Set Target to **Entire matrix** and use **Blackout** for an immediate black display. Use **Start Exhibition** to resume. Manual mode controls disable an enabled daily schedule; the installer must save the schedule again to reactivate it.
6. For a missing screen, find its Offline card. Click neighboring paired screens, set Target to **Selected phones**, then press **Identify**. The test pattern lasts 15 seconds. Check the missing phone's cable, charger and Wi-Fi. Ask the installer for USB recovery if it does not return. Return Target to **Entire matrix** afterward.

After an outage, restore router, chargers and Mac power and wait for reconnect. The packaged controller starts at boot, before login; logging in is only needed to open the dashboard. A fully powered-off iPhone cannot be switched on remotely by this app; use its physical power button if needed. Single App Mode reboot/autolaunch must have been verified for the deployed build.

Keep ventilation clear and cables secured. Remove any phone with a swollen battery, abnormal heat or unstable charging from service. Do not use personal accounts or store personal information on installation phones. The dedicated router travels with the wall when moving rooms.
