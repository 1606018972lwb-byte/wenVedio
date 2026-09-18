# wenVedio · 桌面客户端（一体化）

跨平台桌面版视频生成工作台：界面、服务端全部内置在一个应用里，双击即用，不需要安装 Node，也不需要单独部署服务。基于 Electron 实现，可打包 macOS 与 Windows x64。

## 工作方式

- 客户端启动时，主进程会以纯 Node 身份拉起内置的 `src/server.js`，等 `/api/health` 通过后再加载界面。
- 窗口用自绘标题栏（Electron `titleBarStyle: 'hidden'` + `titleBarOverlay`）：系统标题栏隐藏，右上角保留系统原生的最小化/最大化/关闭按钮，按钮配色随主题同步。标题栏固定不动，侧边栏与内容区各自独立滚动。
- 任务记录、模型、令牌等全部配置保存在用户数据目录的 data 文件夹里（Windows `%APPDATA%\wenVedio\data`，macOS `~/Library/Application Support/wenVedio/data`）：`data/config/` 放各类配置，`data/log/` 按天存放日志（如 `2026-09-12.log`），日志保留 30 天、过期自动删除。安装包目录只读，这样升级客户端也不会丢数据。
- 视频下载默认写入系统「下载」文件夹，可在「应用设置 → 视频下载路径」里更换（走系统原生对话框）。
- 外部链接（如「查询入口」）交给系统默认浏览器打开，不在客户端内新开窗口。

autodl 的工作流 API Key 在客户端的「令牌管理」里添加即可，保存在用户数据目录，不会进入前端代码或 Git。

## 界面与主题

- 界面样式是一套令牌化的设计系统：`src/styles.css` 定义结构、组件与浅色主题的 CSS 变量，`src/ui-overrides.css` 只负责深色主题的变量覆盖。组件规则里不写死色值，所以两套主题共用同一份样式。
- 主题在「应用设置 → 界面主题」里切换：**浅色 / 深色 / 跟随系统**，选择存在本地，首帧由 `index.html` 里的内联脚本定好，不会先闪一下浅色再变深色。
- 标题栏右侧的状态指示灯会真实探测 `/api/health`（默认 20 秒一次）：正常是绿点「服务正常」，连不上会变红并提示「服务已断开」。
- 前端的静态资源与 API 响应都带 `Cache-Control: no-store`。替换 `src/` 后重新打开客户端一定能看到新界面，不会因为 Chromium 缓存而看起来「没更新」。

## 目录结构

```
wenVedio_Client/
├── desktop/              # Electron 主进程与预加载脚本
│   ├── main.js           # 拉起内置服务、创建窗口（自绘标题栏）、下载相关 IPC
│   └── preload.js        # 通过 contextBridge 暴露最小桌面能力
├── src/                  # 内置的前端页面与服务端
│   ├── server.js         # 内置服务：代理上游 API、配置持久化、模型自动配置解析
│   ├── app.js            # 前端逻辑
│   ├── index.html        # 页面结构（含自绘标题栏与主题切换）
│   ├── styles.css        # 设计系统：令牌 + 组件 + 浅色主题
│   └── ui-overrides.css  # 深色主题的令牌覆盖
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

1. 打开客户端，进入「令牌管理」，添加 autodl 平台的工作流 API Key。（也可以先跳过，用下面的 AI 自动配置时把 Key 一并填进去。）
2. 进入「模型管理」添加模型，两条路选一条：
   - **AI 自动配置（省事）**：点右上角「✨ AI 自动配置」，填接口文档链接、模型名称和一把 DeepSeek Key，由 DeepSeek 读文档生成配置，填进模型编辑器；核对后点「保存修改」。
   - **手动新增**：点「＋ 新增模型」，逐个填写工作流 ID、提交地址、查询地址、表单字段和所用令牌。
3. 价格（峰谷元/秒、谷值时段、按分辨率单价）可在模型编辑器里选配；配置后生成页的「预计价格」和任务详情会显示对应计费。
4. 回到「视频生成」，填写 prompt 和参考图后提交任务；提交行会按当前时间显示适用的模型价格。

## 模型 AI 自动配置

「模型管理 → ✨ AI 自动配置」用一段接口文档链接自动生成模型配置，省掉手填地址和字段。

需要填三项：

| 字段 | 说明 |
| --- | --- |
| 接口文档链接 | 平台接口文档页的地址，支持 HTML 文档页和 OpenAPI / JSON 规范 |
| 模型名称 | 例 `gpt-image-1`，决定模型 ID |
| DeepSeek API Key | 用来让 DeepSeek 读文档；**填过一次会自动存成令牌，以后可以留空** |

另外有一个可选的「模型 API Key」：填了会自动建一条令牌并绑定到这个新模型（与「令牌管理」是同一份数据），不填则在编辑器里手动选。

工作方式：

- 解析**固定使用 DeepSeek**（默认 `deepseek-chat`，可在「解析模型」里改）。不要填 `deepseek-reasoner`——它是思考模型，会把 token 先花在 `reasoning_content` 上，可能返回空正文。
- Key 无效或调用失败时会退回**内置规则**兜底（完全离线，靠接口地址特征推断，会把文档里的 Base URL 与 `POST /path` 相对路径拼成完整地址），并在结果里标明来源和失败原因。
- 解析结果只是草稿，会填进原有的模型编辑器，走和手填完全相同的必填校验；**只有点了「保存修改」才会真正写入**。
- 编辑器顶部会显示一条提示，标明来源（AI 解析 / 内置规则）、置信度、用的哪个解析模型，以及需要人工核对的地方。
- **价格不会被猜**：`pricing` 一律留空，由你自己填。

已经配置过的模型会被拦住，不会重复创建：

- 在「模型名称」里输入时，如果这个名字已经存在，输入框下方会直接提示。
- 解析完成后按「模型 ID → 模型名称」的顺序比对：命中就不打开编辑器，而是给出「打开已有模型」和「以新 ID 新建」两个选择。
- 服务端也会拦：新增请求撞已有 ID 时返回 409。此前这里是无条件覆盖，同 ID 会**静默替换**掉旧配置，界面还提示「保存成功」。
- 同一个 API Key 重复提交不会堆出多条令牌，会直接复用已有的那条。

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

- **界面主题**：浅色 / 深色 / 跟随系统；深色适合长时间盯任务
- **开机自动启动**：登录系统时自动运行客户端
- **关闭时最小化到托盘**：点关闭按钮隐藏到系统托盘，托盘图标可重新打开或退出
- **任务完成桌面通知**：生成完成或失败时弹出系统通知
- **任务进度刷新间隔**：10 秒 ～ 5 分钟，默认 60 秒
- **预约提交间隔**：默认 5 秒，可调 1-600 秒（持久化到数据目录 `settings.json`）
- **视频 / 图片下载路径**：分别配置

## 与其它目录的关系

- `wenVedio_web/`：带浏览器界面的 web 版，与本客户端共用同一套页面和服务端代码，两份 `src/` 内容保持一致。
- 桌面专属的部分由 `window.wenvedioDesktop` 判断：浏览器端标题栏不为系统窗口按钮留位、也没有拖拽区（`body.is-web`），下载走浏览器能力，「应用设置」里的开机自启与托盘项不显示。
- 以本目录为同步基准：

  ```bash
  # 改完客户端后同步到 web
  cp -r wenVedio_Client/src/. wenVedio_web/src/
  ```

- 两份是重复副本，改完记得同步，否则会再次走偏。

## 已知问题

- 图片任务如果在生成过程中重启服务，记录会停在「进行中」：`runImageGeneration()` 是不带 await 的异步调用，而启动时的 `recoverStuckTasks()` 只处理 `submitting` 状态。
- 任务记录（`data/config/tasks.json`）对「已预约」任务会保留参考图的 base64 原文，且每次状态变化都全量重写该文件；预约大批任务时文件会明显变大。

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
