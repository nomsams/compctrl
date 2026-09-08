const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('compCtrl', {
  getSettings: () => ipcRenderer.invoke('compctrl:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('compctrl:save-settings', settings),
  dispatch: (message) => ipcRenderer.invoke('compctrl:dispatch', message),
  setJiggler: (enabled) => ipcRenderer.invoke('compctrl:set-jiggler', enabled),
  systemAction: (action) => ipcRenderer.invoke('compctrl:system-action', action),
  onBeforeQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('compctrl:before-quit', handler);
    return () => ipcRenderer.removeListener('compctrl:before-quit', handler);
  },
});

