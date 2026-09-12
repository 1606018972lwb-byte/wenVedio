# wenVedio · 桌面客户端（一体化）

跨平台桌面版视频生成工作台：界面、服务端全部内置在一个应用里，双击即用，不需要安装 Node，也不需要单独部署服务。基于 Electron 实现，可打包 macOS 与 Windows x64。

## 工作方式

- 客户端启动时，主进程会以纯 Node 身份拉起内置的 `src/server.js`，等 `/api/health` 通过后再加载界面，所以功能与 web 版完全一致。
- 任务记录、模型、令牌等全部配置保存在用户数据目录的 data 文件夹里（Windows `%APPDATA%\wenVedio\data`，macOS `~/Library/Application Support/wenVedio/data`）：`data/config/` 放各类配置，`data/log/` 按天存放日志（如 `2026-09-12.log`），日志保留 30 天、过期自动删除。安装包目录只读，这样升级客户端也不会丢数据。
- 视频下载默认写入系统「下载」文件夹，可在「任务记录 → 下载路径」里更换（走系统原生对话框）。
- 外部链接（如「查询入口」）交给系统默认浏览器打开，不在客户端内新开窗口。

autodl 的工作流 API Key 在客户端的「令牌管理」里添加即可，保存在用户数据目录，不会进入前端代码或 Git。

## 目录结构

```
wenVedio_Client/
├── desktop/              # Electron 主进程与预加载脚本
│   ├── main.js           # 拉起内置服务、创建窗口、下载相关 IPC
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
2.1 模型的峰谷价格（元/秒）、谷值时段和按分辨率单价可在模型编辑器里选配，配置后「当前模型」面板与任务详情会显示对应计费。
3. 回到「视频生成」，填写 prompt 和参考图后提交任务；提交行会按当前时间显示适用的模型价格。

## 图片生成

左侧「图片生成」是独立的生图工作台（在视频生成上面）：

- 模型走 OpenAI 兼容的 /v1/images/generations 接口（如 uuapi.cc 中转的 gpt-image 系列），在「模型管理」里把模型类型设为「图片模型」即可；价格支持按张计费、按规格（1K/2K/4K）分别定价，币种支持 USD 与人民币符号。
- 提交行按所选规格与数量显示总价；生成在后台异步执行，任务列表里可预览缩略图、逐张下载。
- 生成的图片保存在数据目录 data/images/，删除任务记录会同时删除图片文件。

## 价格与用量统计

- 模型价格支持峰/谷时段与按分辨率（规格）定价，可组合配置；费用 = 费率 × 时长（视频）或 费率 × 数量（图片），任务提交/完成时自动计算并记录。
- 「任务记录」页顶部是用量统计：总花费、本月花费、本月任务数、本月成功率，以及按模型的花费明细；记录表带费用列。
- 视频模型已内置 AutoDL MiniMax H3 全部工作流（官方原价：白天 480P 0.03 / 768P 0.04，夜间 480P 0.02 / 768P 0.03，单位元/秒）。

## 应用设置

右下角的 ⚙ 按钮打开「应用设置」：

- **开机自动启动**：登录系统时自动运行客户端
- **关闭时最小化到托盘**：点关闭按钮隐藏到系统托盘，托盘图标可重新打开或退出
- **任务完成桌面通知**：生成完成或失败时弹出系统通知
- **任务进度刷新间隔**：10 秒 ～ 5 分钟，默认 60 秒
- **预约提交间隔**：默认 5 秒，可调 1-600 秒（持久化到数据目录 `settings.json`）

## 与其它目录的关系

- `wenVedio_web/`：带浏览器界面的 web 版，与本客户端共用同一套页面和服务端代码。
- 本目录的 `src/` 是一份独立副本，web 版更新后可用 `wenVedio_web/src` 覆盖本目录 `src` 再重新打包（桌面专属分支通过 `window.wenvedioDesktop` 判断，web 端不受影响）。

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
