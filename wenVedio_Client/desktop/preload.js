// wenVedio 桌面客户端 · 预加载脚本
// 只向页面暴露下载相关的少量能力，渲染进程拿不到 Node 权限。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wenvedioDesktop', {
  isDesktop: true,
  platform: process.platform,
  // 应用设置：开机自启 / 关闭时最小化到托盘
  getAppSettings: () => ipcRenderer.invoke('wenvedio:get-app-settings'),
  setAppSettings: (payload) => ipcRenderer.invoke('wenvedio:set-app-settings', payload),
  // 返回 { path, name } 或 null；kind 为 'image' | 'video'
  chooseDirectory: (payload) => ipcRenderer.invoke('wenvedio:choose-directory', payload),
  defaultDownloadDirectory: (kind) => ipcRenderer.invoke('wenvedio:default-download-directory', kind),
  // 打开文件所在位置：{ path?: 本地文件, directory?: 目录 }
  reveal: (payload) => ipcRenderer.invoke('wenvedio:reveal', payload),
  // 参数 { directory, name, data: ArrayBuffer }
  saveFile: (payload) => ipcRenderer.invoke('wenvedio:save-file', payload),
});
