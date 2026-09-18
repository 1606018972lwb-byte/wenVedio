# wenVedio · 视频生成工作台

一个面向内容团队的视频生成作业台：一次配置、批量提交多条视频任务，后台代理第三方视频生成 API（MiniMax H3 / autodl ComfyUI 工作流），集中查看进度并管理下载。

> 产品与技术方案由团队另行维护，不随代码仓库分发。

## 功能

界面与桌面客户端保持一致，同一套 `src/` 代码同时用于 Web 端与 Electron 客户端。

- **图片生成 / 视频生成**：选择模型后按字段定义生成表单（清晰度与画幅分段按钮、数量与时长步进器、提示词、参考图），提交行实时显示单价与预计费用；图片任务支持图生图参考图。
- **任务记录（分组）**：`汇总任务` 查看全部任务，`图片任务` / `视频任务` 为独立页面，各自的进度统计与花费单独计算；支持状态标签页、类型标签 / 模型 / 调用配置 / 日期 / 关键词筛选、行内勾选批量下载与删除、行操作下拉（下载 / 文件位置 / 查看 / 重新提交 / 删除）。
- **模型管理**：表格支持搜索、类型标签、供应商、调用配置、状态筛选与按名称等排序；抽屉内可编辑基础信息、接口配置、表单字段、价格与高级设置，类型支持多标签、供应商可自由输入。
- **令牌管理**：表格展示名称 / 供应商 / 掩码 / 绑定模型数 / 最近更新，支持双击行或按钮进入编辑抽屉，添加令牌后自动绑定未配置令牌的模型。
- **持久化保存**：任务、令牌与模型配置保存在服务端数据目录（默认 `data/`），服务重启后自动恢复。
- **下载**：桌面客户端可将视频与图片分别保存到各自配置的下载目录并定位文件；浏览器端使用目录选择器或浏览器下载。


## ⚠️ 这份代码目前落后于桌面客户端

`wenVedio_web/src` 与 `wenVedio_Client/src` 是两份重复副本，**桌面客户端那份更新**。web 端这份还没有以下改动：

- 界面重做（令牌化设计系统、浅色/深色主题、自绘标题栏）
- 模型 AI 自动配置
- 防重复配置，以及缺失的 `DELETE /api/models/:id` 路由
- 标题栏的服务状态真实探活、静态资源禁缓存

**同步方向是从客户端流向 web，不要反向覆盖**：

```bash
cp -r wenVedio_Client/src/. wenVedio_web/src/
```

把 web 端的 `src` 覆盖回客户端会丢掉上述全部改动。

## 目录结构

```
wenVedio_web/
├── src/                # 全部项目代码
│   ├── server.js       # Node 服务端：代理第三方 API，托管前端
│   ├── app.js          # 前端逻辑（对接本地后端 /api）
│   ├── index.html      # 前端页面（工作台）
│   ├── styles.css      # 前端样式
│   └── ui-overrides.css # 页面覆盖样式
├── package.json        # 零依赖，npm start 即可启动
├── .env.example        # 环境变量示例（复制为 .env 并填真实值）
├── .env                # 本地敏感配置，不入 Git（含 API Key）
└── .gitignore
```

全部代码只在 `src/` 目录中维护。

## 运行

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入你的 AUTODL_API_KEY（平台工作流 API Key）
```

### 2. 启动服务

```bash
npm start
# 或直接
node src/server.js
```

服务默认运行在 <http://127.0.0.1:8787>。

### 3. 打开工作台

浏览器访问 <http://127.0.0.1:8787>，填写 `prompt`、`ref_image_0`，按需填写其余图片和参数后点击「提交任务」。

## 服务端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查：返回工作流、模式、是否配置 Key |
| GET | `/api/config` | 读取当前请求地址、查询地址和请求参数配置（API Key 只返回是否已配置） |
| POST | `/api/config` | 保存请求地址、查询地址、API Key 和请求参数配置 |
| POST | `/api/batches` | 提交任务，body：`{tasks:[{prompt,duration,resolution,seed,reference_images}]}` |
| GET | `/api/tasks/:id` | 查询单个任务（`id` 为服务端生成的本地任务号） |
| GET | `/api/tasks` | 列出本次服务会话中的任务 |

## 架构与安全

- **前端不持有 API Key**：浏览器只访问本地后端 `/api`，由 `server.js` 调用第三方接口并附带鉴权。
- **API Key 存于服务端 `.env`**：已通过 `.gitignore` 排除，**严禁提交到 Git**。
- **任务状态自动同步**：使用 AutoDL 官方 `comfyui_workflow/result/{task_id}` 接口，与提交任务使用同一个 ComfyUI Token，并从 `results` 读取视频地址。

## 第三方接口说明（实测）

- 提交：`POST {AUTODL_ENDPOINT}/{workflow}`，鉴权 `Authorization: Bearer <API_KEY>`
- 合法参数：`prompt`（必填，1–500000）、`duration`（整数，1–15，默认 5）、`resolution`、`seed`，以及 `ref_image_0`（必填）到 `ref_image_9`（可选）。图片支持 URL/base64 和本地 JPG、PNG、WebP 上传；本地图片会在浏览器中转成 base64 后提交。图片总数最多 10 张，支持删除和拖动缩略图调整顺序。
