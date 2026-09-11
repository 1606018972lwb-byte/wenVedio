// wenVedio 桌面客户端 · 预加载脚本
// 只向页面暴露下载与服务端配置相关的少量能力，渲染进程拿不到 Node 权限。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wenvedioDesktop', {
  isDesktop: true,
  platform: process.platform,
  // 返回 { embeddedUrl, serverUrl, appVersion, platform }
  getServerConfig: () => ipcRenderer.invoke('wenvedio:get-server-config'),
  // 参数 { serverUrl }，空字符串表示改回内置本地服务
  setServerConfig: (payload) => ipcRenderer.invoke('wenvedio:set-server-config', payload),
  // 返回 { path, name } 或 null
  chooseDirectory: () => ipcRenderer.invoke('wenvedio:choose-directory'),
  defaultDownloadDirectory: () => ipcRenderer.invoke('wenvedio:default-download-directory'),
  // 参数 { directory, name, data: ArrayBuffer }
  saveFile: (payload) => ipcRenderer.invoke('wenvedio:save-file', payload),
});
