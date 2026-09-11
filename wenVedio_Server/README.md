# wenVedio · 服务端

视频生成工作台的服务端：把第三方视频生成 API（autodl / MiniMax H3）代理到本地，浏览器或桌面客户端只访问本服务端，长期 API Key 不落到前端。

本目录是**纯 API 服务端**，不托管页面，适合单独部署给桌面客户端（远程模式）或其它程序调用。带浏览器界面的版本在 `wenVedio_web`。

## 运行

```bash
cp .env.example .env     # 填入 AUTODL_API_KEY
npm start                # 或 node src/server.js
```

监听 `http://127.0.0.1:8787`（由 `.env` 的 `PORT` / `HOST` 决定）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | 不限制 | 监听地址。`127.0.0.1` 仅本机；`0.0.0.0` 允许局域网/远程访问 |
| `AUTODL_API_KEY` | 空 | autodl 工作流 API Key |
| `AUTODL_TASKS_TOKEN` | 空 | 平台站内 token，填了才能查询任务结果 |
| `AUTODL_WORKFLOW` | `minimax_h3_lightx2v_v5_15s` | 默认工作流 |
| `AUTODL_REQUEST_URL` / `AUTODL_QUERY_URL` | 见 `.env.example` | 提交 / 查询地址 |
| `MOCK` | `false` | `true` 为演示模式，不真的调用第三方接口 |
| `WENVEDIO_DATA_DIR` | `./data` | 任务记录、模型、令牌的存放目录 |

模型和令牌也可以不写在 `.env` 里，改为运行后通过 API（`/api/models`、`/api/tokens`）配置，会持久化到数据目录。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/models` | 读取 / 保存模型配置 |
| GET/POST | `/api/tokens` | 读取 / 保存令牌 |
| POST | `/api/batches` | 提交任务批次 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 查询单条任务 |
| GET | `/api/tasks/:id/download` | 代理下载生成的视频 |
| DELETE | `/api/tasks` / `/api/tasks/:id` | 删除任务记录 |

接口带 `Access-Control-Allow-Origin: *`，因此桌面客户端可以跨域直连。

## 接到桌面客户端

在客户端左侧「服务端」页里，把服务端地址填成本服务的地址（例如 `http://192.168.1.10:8787`）即可。默认情况下客户端使用自己内置的本地服务，不需要本服务端。

## 安全提醒

**本服务端没有鉴权。**任何能访问到端口的人都可以通过它提交任务并消耗你的 API Key。因此：

- 默认只监听 `127.0.0.1`，不要随意改成 `0.0.0.0`。
- 确认要对外提供时，请放在内网或反向代理后面，并自行加上访问控制（如 Basic Auth、IP 白名单、VPN）。
