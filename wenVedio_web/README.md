# wenVedio · 视频生成工作台

一个面向内容团队的视频生成作业台：一次配置、批量提交多条视频任务，后台代理第三方视频生成 API（MiniMax H3 / autodl ComfyUI 工作流），集中查看进度并管理下载。

> 产品与技术方案由团队另行维护，不随代码仓库分发。

## 功能

- **创建生成任务**：提示词、时长（默认 5 秒）、分辨率、seed，以及 `ref_image_0` 到 `ref_image_9` 图片参数。
- **提交任务**：`ref_image_0` 必填，`ref_image_1` 到 `ref_image_9` 可选，按填写内容提交。
- **工作台**：只显示尚未完成的任务，方便持续关注生成进度。
- **任务记录**：独立页面查看全部任务，支持按全部 / 进行中 / 已完成 / 失败筛选和批量下载。
- **持久化保存**：任务记录保存在本地 `data/tasks.json`，服务重启后自动恢复（不重复保存 Base64 原图）。
- **API 管理**：独立配置请求地址、查询地址、API Key 和请求参数 JSON。
- **批量下载**：勾选任务后获取视频（需服务端配置查询令牌）。

## 目录结构

```
wenVedio/
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
