const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    versions: process.versions,


    login: (credentials) => ipcRenderer.invoke('login', credentials),
    submitOtp: (otp) => ipcRenderer.invoke('submit-otp', otp),
    checkStatus: () => ipcRenderer.invoke('check-status'),

    validateReport: (reportId) => ipcRenderer.invoke('validate-report', reportId),
});