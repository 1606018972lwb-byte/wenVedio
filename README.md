# wenVedio · 视频生成工作台

一个面向内容团队的视频生成作业台：一次配置、批量提交多条视频任务，后台代理第三方视频生成 API（MiniMax H3 / autodl ComfyUI 工作流），集中查看进度并管理下载。

> 产品与技术方案见 `方案设计/视频工作台产品与技术方案.md`。

## 功能

- **创建生成批次**：批次名称、统一提示词、时长（1–15 秒）、分辨率、参考图。
- **批量提交**：一次提交多条任务，逐条返回 `task_id`，成功/失败独立展示。
- **任务队列**：全部 / 生成中 / 已完成 / 失败筛选，实时轮询进度。
- **API 连接**：工作流 ID、后端地址、演示模式开关，连接测试。
- **批量下载**：勾选任务后获取视频（需服务端配置查询令牌）。

## 目录结构

```
wenVedio/
├── server.js           # Node 服务端：代理第三方 API，托管前端
├── app.js              # 前端逻辑（对接本地后端 /api）
├── index.html          # 前端页面（工作台）
├── styles.css          # 前端样式
├── package.json        # 零依赖，node server.js 即可启动
├── .env.example        # 环境变量示例（复制为 .env 并填真实值）
├── .env                # 本地敏感配置，不入 Git（含 API Key）
├── .gitignore
└── 方案设计/           # 产品与技术方案、界面原型草稿
```

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
node server.js
```

服务默认运行在 <http://127.0.0.1:8787>。

### 3. 打开工作台

浏览器访问 <http://127.0.0.1:8787>，填写提示词与时长，点击「提交批次」。

## 服务端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查：返回工作流、模式、是否配置 Key |
| POST | `/api/batches` | 提交批次，body：`{name, tasks:[{prompt,duration,resolution,reference_images}]}` |
| GET | `/api/tasks/:id` | 查询单个任务（`id` 为服务端生成的本地任务号） |
| GET | `/api/tasks` | 列出本次服务会话中的任务 |

## 架构与安全

- **前端不持有 API Key**：浏览器只访问本地后端 `/api`，由 `server.js` 调用第三方接口并附带鉴权。
- **API Key 存于服务端 `.env`**：已通过 `.gitignore` 排除，**严禁提交到 Git**。
- **任务查询需平台登录令牌**：工作流 API Key 仅能「提交」，无法查询任务结果；在 `.env` 配置 `AUTODL_TASKS_TOKEN`（平台站内登录 token）后，工作台可自动轮询并取回视频地址。

## 第三方接口说明（实测）

- 提交：`POST {AUTODL_ENDPOINT}/{workflow}`，鉴权 `Authorization: Bearer <API_KEY>`
- 合法参数：`prompt`（必填）、`duration`（整数，1–15，默认 5）、`ref_image_0`（必填，图片 URL，支持多图 `ref_image_1..5`）
- 注意：不要传 `resolution` / `workflow_id` 等字段，否则报「存在未定义的参数」。
