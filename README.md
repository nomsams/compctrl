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

- Touch the point on the live screen where the Windows pointer should go. Tap to click and drag to drag.
- **Scan QR code** opens the phone's rear camera and connects from the QR code displayed in the Windows companion.
- Drag with two fingers to scroll.
- Use the always-visible **Ctrl+C** and **Ctrl+V** buttons for clipboard shortcuts.
- **Keys** opens a phone typing field plus every standard PC key, function keys, modifiers, navigation keys, and arrows.
- The session drawer controls the 30-second screen jiggler, disconnect, restart, and shutdown. Power actions require a 1.8-second hold.
- A dropped connection retries with exponential backoff, reacts immediately when the phone returns online, and remembers the last active code across a page reload. Disconnecting manually disables auto-reconnect.

## Security and network notes

- The Windows companion is required. Normal web pages are deliberately prevented from controlling the operating system or capturing the desktop unattended.
- Pairing codes use an unambiguous 32-character alphabet and provide about 40 bits of entropy. Generate a new code from the companion whenever a code may have been shared.
- WebRTC encrypts media and data in transit. The default public PeerJS signaling service can see connection metadata such as the temporary peer ID and IP addresses, but not decrypted screen or input data.
- This build intentionally has no default TURN relay so the screen does not fall back to a third-party media server. A direct P2P route may fail on restrictive corporate, hotel, or carrier networks.
- The native bridge accepts commands only through Electron IPC; it does not open a local TCP port. Restart and shutdown are unavailable until a paired WebRTC data channel is open, and the phone UI requires a press-and-hold confirmation.

## Project layout

- `app/remote.tsx` — mobile controller, reconnection logic, touch mapping, keyboard, and power UI
- `app/host.tsx` — Windows companion pairing and live-session UI
- `companion/main.cjs` — tray app, screen-capture permission, persistence, and protected system operations
- `companion/native-bridge.ps1` — persistent Win32 mouse and keyboard bridge
- `.github/workflows/` — GitHub Pages deployment and Windows packaging
