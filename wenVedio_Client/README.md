# wenVedio · 桌面客户端

跨平台桌面版视频生成工作台，功能与 web 版一致，界面就是同一套前端页面。基于 Electron 实现，可打包 macOS 与 Windows x64。

## 服务端：内置 / 远程

客户端有两种连接方式，在左侧「服务端」页切换：

- **内置本地服务（默认）**：客户端自带一份服务端代码，启动时由主进程拉起，双击即用，不需要先装 Node 或另起服务。
- **远程服务端**：填写远程地址（如 `http://192.168.1.10:8787`）后，界面的所有接口请求都发往该地址，内置服务只继续负责加载界面。适合把 API Key 集中放在一台机器上、多人共用。

远程模式需要配合 `wenVedio_Server`（独立的纯 API 服务端）。服务端的接口带 `Access-Control-Allow-Origin: *`，客户端可以跨域直连。

配置保存在 `%APPDATA%\wenVedio\config.json`（macOS 为 `~/Library/Application Support/wenVedio/config.json`）。

## 与 web 版的差异

桌面端复用 `src/` 下同源的服务端和前端页面，只有几处必要的桌面适配：

- **无需安装 Node**：内置服务端随客户端启动，等健康检查通过后再显示界面。
- **数据写入用户目录**：任务记录、模型和令牌保存在系统用户数据目录，因为安装包目录是只读的，同时升级客户端不会丢数据。
- **下载目录走原生对话框**：默认写入系统「下载」文件夹，可在「任务记录 → 下载路径」里更换。
- **多一个「服务端」页**：web 版没有这一页。

外部链接（如「查询入口」）会交给系统默认浏览器打开，不会在客户端内新开窗口。

## 目录结构

```
wenVedio_Client/
├── desktop/              # Electron 主进程与预加载脚本
│   ├── main.js           # 拉起内置服务、创建窗口、服务端配置与下载相关 IPC
│   └── preload.js        # 通过 contextBridge 暴露最小桌面能力
├── src/                  # 内置的前端页面与服务端（与 web 版同源）
│   ├── server.js
│   ├── app.js
│   ├── index.html
│   ├── styles.css
│   └── ui-overrides.css
├── build/icon.png        # 应用图标（1024×1024）
├── package.json          # 依赖与 electron-builder 打包配置
└── .env.example
```

## 开发运行

```bash
npm install
npm run desktop     # 启动桌面客户端（开发模式）
npm start           # 只启动内置服务，用浏览器访问 http://127.0.0.1:8787
```

## 打包

```bash
npm run dist:win    # Windows x64：NSIS 安装包 + 免安装 portable
npm run dist:mac    # macOS：dmg + zip（x64 / arm64）
```

产物输出到 `release/`。

关于跨平台构建：

- macOS 的 dmg 必须在 macOS 上构建，Windows 上执行 `dist:mac` 不会生成 dmg。
- Windows 包可以在 Windows 上构建，也可以在 macOS 上交叉构建。
- `mac` 目标已设置 `identity: null`（不签名）。未签名的应用首次打开需要在「系统设置 → 隐私与安全性」中手动允许。

## 首次使用

1. 打开客户端，进入「令牌管理」，添加 autodl 平台的工作流 API Key。
2. 进入「模型管理」，确认模型的工作流 ID、提交地址、查询地址和所用令牌。
3. 回到「视频提交」，填写 prompt 和参考图后提交任务。

默认用内置服务就够了；要连远程服务端，去「服务端」页填地址。

## 与其它目录的关系

- `wenVedio_Server/`：独立的纯 API 服务端，供远程模式使用。
- `wenVedio_web/`：带浏览器界面的 web 版。
- 本目录的 `src/` 是一份独立副本，更新 web 版后可用 `wenVedio_web/src` 覆盖本目录 `src` 再重新打包（桌面专属分支通过 `window.wenvedioDesktop` 判断，web 端不受影响）。

## 网络受限时的安装与打包

GitHub Releases 被网络阻断时，`npm install` 会装好依赖但下载不到 Electron 二进制（表现为 `node_modules/electron/dist` 不存在），打包时也会卡在 electron-builder 的工具链下载上。改用 npmmirror 镜像即可：

```bash
# 依赖装好后补下载 Electron 二进制
ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" node node_modules/electron/install.js

# 打包时同时指定两个镜像
ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://cdn.npmmirror.com/binaries/electron-builder-binaries/" \
npm run dist:win
```

## 已验证

- Windows x64 打包通过：`release/wenVedio-0.2.0-win-x64-setup.exe`（NSIS 安装版）与 `release/wenVedio-0.2.0-win-x64-portable.exe`（免安装版）。
- 打包后的客户端启动后，内置服务 `/api/health` 与首页均正常返回，任务记录/模型/令牌写入 `%APPDATA%\wenVedio\data`。
- macOS 打包配置已就绪（dmg + zip，x64 / arm64），但需要在 macOS 上执行 `npm run dist:mac` 才能真正产出。
