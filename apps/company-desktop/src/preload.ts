import { contextBridge, ipcRenderer } from "electron";
import { createCompanyPreloadApi } from "./preload-api.js";

const api = createCompanyPreloadApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as never);
  },
  off: (channel, listener) => {
    ipcRenderer.off(channel, listener as never);
  },
});

contextBridge.exposeInMainWorld("forgeCompany", api);
