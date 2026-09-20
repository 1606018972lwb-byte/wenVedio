# 工作流模块：不变量与踩过的坑

这份文档记录的是**代码本身看不出来的约束**——每一条都对应一个真实修过的 bug 或一次失败尝试。
改工作流相关代码前先扫一遍，能避免重犯。

## 一、存盘（`src/workflow/store.js`）

**写盘永远不能抛异常。** `saveRun` 在引擎里每个节点状态变化时都被调用，抛一次就会终止整次运行。
- `JSON.stringify` 也必须包在 try 里（循环引用 / 超大对象 / 内存不足都会抛）
- rename 在 Windows 上会因索引器/杀软占用而 `EPERM`：临时文件名带进程+时间+随机数，
  rename 失败重试 5 次退避，仍失败退化为直接覆盖写
- **一条坏记录不能堵死后续所有落盘**：整体序列化失败时逐条筛，能写的照写、
  写不了的移出内存并记日志点名（否则那张表永远写不进去）
- 解析失败的文件先 `copyFileSync` 成 `.corrupt-<时间>.bak`，**绝不直接覆盖**——
  否则下一次保存就把损坏内容永久落盘，定义全丢
- 运行记录用合并写（250ms），子运行上限 30 条（`MAX_SUB_RUNS`），否则百项循环会让每次
  合并写都序列化上百条记录
- `process.once('exit')` 里补写时**不能 clearTimeout**，会撞 libuv 的
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`

## 二、引擎（`src/workflow/engine.js`）

**分支路由有三个前提，缺一个就静默出错：**
1. 边上的 `branch` 必须活过 `sanitizeDefinition`（曾经被丢掉 → 两条分支都执行）
2. `takenBranch` 必须校验节点类型是 `condition`——`merge` / `code` 会把用户字段展开到输出顶层，
   任意一个叫 `branch` 的字段都会劫持路由
3. `projectOutput` 的保留列表必须含 `branch` / `index` / `is_else`——
   用户在条件节点上声明任意输出参数后，路由信息曾被投影砍掉，
   导致命中分支的整条下游被静默 `skipped`、运行还报成功

**取消必须传播到子运行。** 循环体的子运行是独立记录，`tick` 会无条件重新 kick 未终态 run；
只标父运行会让剩下的子工作流继续烧配额。`cancelRun` 递归收集 `parent_run_id` 链。

**禁用节点是「透传」不是「掐断」。** 状态记 `skipped`，但输出=上游输出，且对下游算「已放行」；
否则下游会被一起跳过。

**从中间节点开始（`from_node`）**：上游标 `success + seeded`（输出取历史运行结果），
下游照常，**既非上游也非下游的平行分支必须显式标 `skipped`**——
不处理会留下悬空 pending 节点，运行以「有节点无法执行」失败。

**`incoming` 存的是 `{from, branch}` 对象不是 id 字符串**，改动这里要看所有使用者。

## 三、代码节点沙箱（`src/workflow/nodes.js`）

**只让字符串跨越宿主与沙箱的边界。**
- 输入用 JSON 字符串传进去、在上下文内 `JSON.parse`；日志与结果也在上下文内序列化出来
- 原因：`codeGeneration: {strings: false}` 只约束**上下文自己**的 eval/Function。
  一旦注入宿主对象（`Object`、甚至 `console.log` 函数），就能沿原型链
  `Object.constructor('return process')()` 爬到宿主。第一版修法就是这么失败的。
- **`vm` 不是安全边界**。Python 代码节点跑的是真实解释器，**完整系统权限**。
  因此：导入含代码节点的工作流要弹确认框；服务端默认只听 `127.0.0.1`。

**正则在主线程同步跑，没有 vm 超时保护。** 文本节点的 regex 模式必须限制模式长度、
源文本长度，并拒绝 `(…+)+` 这类灾难性回溯写法，否则一条工作流能卡死整个服务。

## 四、HTTP 节点

`res.text()` 是先把整个响应读进内存。URL 常由变量拼出来，可能指向大文件或无限流，
所以改成**边读边计数、超 2MB 立即 `reader.cancel()`**，并输出 `body_bytes` / `truncated`。

## 五、前端（`src/workflow-ui/`）

- `[hidden] { display: none !important; }` 是**承重墙**：视图切换靠 `hidden` 属性，
  重写样式表时删掉它会让所有视图同时显示
- 整个 `.wf-view` 禁用 `user-select`，输入框与 JSON 输出显式恢复——
  否则拖动时会扫出系统强调色的选区块，看起来像 bug
- **`snapshot()` 用去重**，焦点反复进出、空拖动不塞重复历史；
  参数改动靠 `focusin` 压快照（压的是改动前状态），编辑过程不压
- `saveCurrent()` 一进来就 `clearTimeout(state.saveTimer)`，
  否则「点试运行」与 900ms 自动保存并发、后写覆盖先写，跑的可能不是画面上的图
- `promptRun` 的输入项要读**画布实时图**（`state.canvas.getGraph()`）而不是
  `state.current.nodes`（打开时的旧副本），否则刚加的输入项不出现在表单里
- `canvas.destroy()` 必须移除挂在 window 上的 mousemove/mouseup，
  否则反复打开编辑器会累积监听
- 对齐吸附要以**拖拽起点坐标**为基准，用当前坐标会越拖越偏

## 六、验证纪律

- **先 `node --check`，通过才部署。** 这条顺序救过一次：把 `${...}` 嵌进模板表达式的对象字面量
  是非法 JS，检查拦下了，坏文件没进安装目录（否则整个工作流界面白屏）
- `wenVedio_Client/test/workflow.test.js` 是自包含回归测试（41 项断言），
  自己起服务端、跑完清理：`cd wenVedio_Client && node test/workflow.test.js`
  （端口被占用用 `WF_TEST_PORT=8796`）
- 测后端时先确认端口没被旧的 `node src/server.js` 占着——
  曾经因为旧进程还活着，新进程绑不上端口，测的其实是旧代码
- 用户正在用的客户端**不能动**：所有验证都在独立档案实例（`WENVEDIO_PROFILE=test`）上做

## 七、已知限制（不是 bug，是设计取舍）

- 图片生成节点在生成中途重启进程**无法续跑**（图片接口没有可续查的任务号），
  会明确报错让用户重跑；视频节点可以续跑
- 子工作流的输入要能被接住，必须在它的「开始」节点声明同名字段——
  开始节点只透传声明过的输入
- `last_run_status` 等卡片统计存在工作流定义里，清理运行记录不会影响它们
