const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('compCtrl', {
  getSettings: () => ipcRenderer.invoke('compctrl:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('compctrl:save-settings', settings),
  setGroqApiKey: (key) => ipcRenderer.invoke('compctrl:set-groq-api-key', key),
  transcribeAudio: (chunks, mimeType) => ipcRenderer.invoke('compctrl:transcribe-audio', chunks, mimeType),
  dispatch: (message) => ipcRenderer.invoke('compctrl:dispatch', message),
  setJiggler: (enabled) => ipcRenderer.invoke('compctrl:set-jiggler', enabled),
  setDisplayBlanked: (enabled) => ipcRenderer.invoke('compctrl:set-display-blanked', enabled),
  systemAction: (action) => ipcRenderer.invoke('compctrl:system-action', action),
  onDisplayState: (callback) => {
    const handler = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on('compctrl:display-state', handler);
    return () => ipcRenderer.removeListener('compctrl:display-state', handler);
  },
  onBeforeQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('compctrl:before-quit', handler);
    return () => ipcRenderer.removeListener('compctrl:before-quit', handler);
  },
});
