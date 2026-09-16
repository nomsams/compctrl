const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('compCtrl', {
  getSettings: () => ipcRenderer.invoke('compctrl:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('compctrl:save-settings', settings),
  setGroqApiKey: (key) => ipcRenderer.invoke('compctrl:set-groq-api-key', key),
  transcribeAudio: (chunks, mimeType) => ipcRenderer.invoke('compctrl:transcribe-audio', chunks, mimeType),
  issueTrustedDevice: (deviceId, deviceName) => ipcRenderer.invoke('compctrl:issue-trusted-device', deviceId, deviceName),
  verifyTrustedDevice: (deviceId, challenge, nonce, proof) => ipcRenderer.invoke('compctrl:verify-trusted-device', deviceId, challenge, nonce, proof),
  revokeTrustedDevice: (deviceId) => ipcRenderer.invoke('compctrl:revoke-trusted-device', deviceId),
  panicLockdown: () => ipcRenderer.invoke('compctrl:panic-lockdown'),
  readClipboard: () => ipcRenderer.invoke('compctrl:read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('compctrl:write-clipboard', text),
  dispatch: (message) => ipcRenderer.invoke('compctrl:dispatch', message),
  setJiggler: (enabled) => ipcRenderer.invoke('compctrl:set-jiggler', enabled),
  setDisplayBlanked: (enabled) => ipcRenderer.invoke('compctrl:set-display-blanked', enabled),
  authorizeDisplayCapture: (audioRequested) => ipcRenderer.invoke('compctrl:authorize-display-capture', audioRequested),
  systemAction: (action) => ipcRenderer.invoke('compctrl:system-action', action),
  onDisplayState: (callback) => {
    const handler = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on('compctrl:display-state', handler);
    return () => ipcRenderer.removeListener('compctrl:display-state', handler);
  },
  onLockdown: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('compctrl:lockdown', handler);
    return () => ipcRenderer.removeListener('compctrl:lockdown', handler);
  },
  onBeforeQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('compctrl:before-quit', handler);
    return () => ipcRenderer.removeListener('compctrl:before-quit', handler);
  },
});
