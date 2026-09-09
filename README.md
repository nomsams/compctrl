# CompCtrl

CompCtrl turns a phone into a live screen, mouse, and full keyboard for a Windows computer. The phone UI is a static GitHub Pages site. A small Electron companion on Windows captures the selected display and injects native mouse and keyboard input.

After the initial rendezvous, video and control messages use an encrypted WebRTC peer-to-peer connection. The public PeerJS broker only introduces the two devices; it does not carry the live screen when a direct route is available.

## Run it locally

Requirements: Windows 10/11 and Node.js 22 or newer.

1. In PowerShell, run `./Start-CompCtrl.ps1` from this folder.
2. On the companion window, copy the eight-character pairing code.
3. Open the [published phone controller](https://nomsams.github.io/compctrl/), tap **Scan QR code**, and point the phone camera at the QR shown by the companion. You can still enter the eight-character code manually.

For development, use two terminals:

```powershell
npm install
npm run dev
./Start-CompCtrl.ps1
```

The companion is preconfigured with `https://nomsams.github.io/compctrl/` for one-scan QR pairing. Use `Start-CompCtrl.ps1 -WebUrl 'https://another-address.example/'` only to override it during development.

Closing the companion window sends it to the Windows notification tray. “Start with Windows” is enabled by default. The screen jiggler runs in the companion every 30 seconds even when the phone is disconnected.

## Publish the phone controller

1. Create a GitHub repository and push this project to its `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. The included `Deploy phone controller to GitHub Pages` workflow publishes `dist/client` and reports the HTTPS address.
4. Paste that address into the Windows companion to enable one-scan QR pairing.

The `Build Windows companion` workflow can be run manually from the Actions page. It produces installer and portable `.exe` artifacts. Locally, `npm run pack:windows` creates the same files in `release/`.

## Controls

- The live screen acts like a touchpad by default: swipe anywhere to move the large on-screen pointer, then tap or use the dedicated left/right click buttons.
- Hold one finger still to open the 3× precision magnifier. Move while holding to line up its crosshair, then release; the pointer stays put without clicking.
- Enable **Permanent magnifier** in session controls to keep the 3× crosshair view visible during normal movement.
- Pinch with two fingers to zoom the live view up to 4×. The mapping remains aligned after phone orientation changes, and the visible zoom chip restores the full-screen view.
- Use the fullscreen button for an immersive controller that hides both app bars. A small bottom button reveals the shortcut bar again, and the exit button restores the normal layout. Landscape mode also uses compact bars when not immersive.
- **Scan QR code** opens the phone's rear camera and connects from the QR code displayed in the Windows companion.
- Drag with two fingers to scroll.
- Open session controls to switch between touchpad and direct-touch positioning, change pointer speed, disable tap-to-click, or enable drag/select. Drag/select is off by default to prevent accidental text selection.
- Use the always-visible **Ctrl+C** and **Ctrl+V** buttons for clipboard shortcuts.
- **Type** opens the phone's native keyboard in a compact typing strip by default. Enable **Show full PC key panel** when you want the keyboard button to open function keys, modifiers, navigation keys, and arrows instead.
- Use the dedicated **Up** and **Down** buttons on the edge of the desktop for reliable one-tap scrolling, or keep using the two-finger scroll gesture.
- **Floating mini video** uses the phone browser's Picture-in-Picture mode when available, so the live computer view can stay above other apps. Return to the controller at any time; it resumes the existing session or reconnects automatically after mobile background suspension.
- The session drawer controls the 30-second screen jiggler, disconnect, restart, and shutdown. Power actions require a 1.8-second hold.
- **Turn local screens off** covers every Windows display with a capture-excluded black privacy curtain. The phone continues showing and controlling the desktop underneath. Restore the displays from the phone, the companion, the tray, or with **Ctrl+Alt+Shift+F12**.
- A dropped connection retries with exponential backoff, reacts immediately when the phone returns online, and remembers the last active code across a page reload. Disconnecting manually disables auto-reconnect.

## Security and network notes

- The Windows companion is required. Normal web pages are deliberately prevented from controlling the operating system or capturing the desktop unattended.
- Pairing codes use an unambiguous 32-character alphabet and provide about 40 bits of entropy. Generate a new code from the companion whenever a code may have been shared.
- WebRTC encrypts media and data in transit. The default public PeerJS signaling service can see connection metadata such as the temporary peer ID and IP addresses, but not decrypted screen or input data.
- This build intentionally has no default TURN relay so the screen does not fall back to a third-party media server. A direct P2P route may fail on restrictive corporate, hotel, or carrier networks.
- The native bridge accepts commands only through Electron IPC; it does not open a local TCP port. Restart and shutdown are unavailable until a paired WebRTC data channel is open, and the phone UI requires a press-and-hold confirmation.
- Privacy-screen state is deliberately not saved across a companion restart. It blacks the local displays without powering down the monitor hardware, because Windows wakes a hardware-powered-off display as soon as remote mouse or keyboard input is injected.

## Project layout

- `app/remote.tsx` — mobile controller, reconnection logic, touch mapping, keyboard, and power UI
- `app/host.tsx` — Windows companion pairing and live-session UI
- `companion/main.cjs` — tray app, screen-capture permission, persistence, and protected system operations
- `companion/native-bridge.ps1` — persistent Win32 mouse and keyboard bridge
- `.github/workflows/` — GitHub Pages deployment and Windows packaging
