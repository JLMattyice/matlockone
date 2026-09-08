"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only bridge between the recovery form and the main process.
 *
 * Two named calls, nothing else — no filesystem, no database handle, no
 * arbitrary IPC. The window renders local HTML, but it is treated like any
 * other untrusted renderer.
 */
contextBridge.exposeInMainWorld("recovery", {
  listAccounts: () => ipcRenderer.invoke("recovery:list"),
  reset: (email, password) => ipcRenderer.invoke("recovery:reset", { email, password }),
  cancel: () => ipcRenderer.send("recovery:cancel"),
});
