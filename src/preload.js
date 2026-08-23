const { contextBridge, ipcRenderer, shell } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  launchMinecraft: (settings) =>
    ipcRenderer.invoke("launch-minecraft", settings),

  getVersions: () =>
    ipcRenderer.invoke("get-minecraft-versions"),

  loginMicrosoft: () =>
    ipcRenderer.invoke("login-microsoft"),

  onMinecraftLog: (callback) =>
    ipcRenderer.on("minecraft-log", (_, message) => callback(message)),

  onMinecraftProgress: (callback) =>
    ipcRenderer.on("minecraft-progress", (_, progress) => callback(progress)),

  onMinecraftFinished: (callback) =>
    ipcRenderer.on("minecraft-finished", () => callback()),

  openUrl: (url) =>
    shell.openExternal(url)
});