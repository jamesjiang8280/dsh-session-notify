# dsh-session-notify

> 多会话并行时，谁跑完了、谁在等你确认——右上角一眼看到。

DSH（DeepSeek Harness）Web 插件：当**任意会话执行完成**或**需要你交互**时，在窗格右上角弹出类 macOS 的系统通知（toast），点击通知在**当前标签页内**切换到该会话。

Session notifier for DeepSeek Harness — macOS-style toasts at the top-right of the DSH pane when a session finishes or needs your input.

## 能力 / Capabilities

| 事件 | 触发条件 | 通知样式 |
|------|----------|----------|
| 会话完成 | 会话事件流出现 `turn/end` | 🟢 绿色边框「会话回合已完成」 |
| 等待审批 | 会话事件流出现 `approval/asked`（工具调用等你点「允许一次/拒绝」） | 🟠 橙红边框「等待审批」，文案带工具名与原因 |
| 需要交互 | `tool/call` 中出现 `ask_user_question`，或旧事件 `interaction` / `ask-user` / `session/held` | 🟠 橙色边框「会话需要交互」 |

- 多条通知在右上方垂直堆叠（最多保留最近 50 条），可逐条关闭；
- **20 秒无操作自动渐隐消失**：悬停暂停计时、移开重新计时，点击/关闭立即处理；
- 通知文案带**会话标题**（从持久化快照缓存，30 秒刷新）；
- **点击任意通知（绿色完成 / 橙红审批 / 橙色交互）在当前标签页内切换会话**（调用框架 `uiWorkspace.openSession()`，与点击侧边栏会话行一致，无刷新、无新标签页）；toast 可聚焦，回车/空格同样触发跳转；
- 悬停有 2% 放大 + 阴影加深的可点击提示；
- 中英文案跟随浏览器语言；
- **默认只通知你能在侧边栏看到的顶层会话**：AI 内部派生的子会话（`header.origin = "subagent"` / `delegationDepth > 0`）没有入口可点，默认跳过；需要时可用配置 `includeSubagents: true` 打开；
- 纯 JS，无构建步骤，Host 半 + 浏览器半。

## 安装 / Installation

```bash
# 方式一：从 GitHub 安装（需要 pnpm，本机已装 DSH）
dsh plugin --profile web add github:jamesjiang8280/dsh-session-notify

# 方式二：从本地目录 link 安装
dsh plugin --profile web add link:/path/to/dsh-session-notify
```

安装后**重启 `dsh web`** 并强制刷新页面（`Cmd+Shift+R`）即可。

> 手动安装：把本目录加入 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，并在 profile 的 `cordis.patch.yml` 追加：
>
> ```yaml
> - id: session-notify
>   name: "dsh-session-notify"
>   config: {}
> ```

## 工作原理 / How it works

```
会话事件 (turn/end | approval/asked | tool/call ask_user_question)
        │  写入会话事件日志
        ▼
Host 半 (index.js)  每 3 秒轮询 sessions.list()
        │  扫描新增事件 → 入队（去重、防历史洪水）
        ▼
GET /dsh-session-notify/notifications
        │  浏览器每 2 秒拉取
        ▼
Client 半 (client.js)  注册进 shell.overlay → 右上角 toast
```

- **Host 半**：依赖 `webServer` 服务；用 `sessions.list()` 枚举 live 会话，沿 `session.eventAt(i)` 增量扫描事件；首次见到会话只记录 head，避免把历史 `turn/end` 全部弹一遍。
- **Client 半**：通过 `shell.overlay` 槽位渲染通知容器；点击时调用 `ctx.get('uiWorkspace').openSession(sessionId)` 完成 SPA 内切换。

## 自检与调试 / Diagnostics

| 端点 | 用途 |
|------|------|
| `GET /dsh-session-notify/test?kind=turn-end` | 触发一条绿色测试通知（绑定最新 live 会话） |
| `GET /dsh-session-notify/test?kind=interaction` | 触发一条橙色测试通知 |
| `GET /dsh-session-notify/test?kind=approval` | 触发一条红色「等待审批」测试通知 |
| `GET /dsh-session-notify/test?sessionId=xxx&title=yyy` | 指定会话/标题 |
| `GET /dsh-session-notify/test?repeat=30` | 每 2 秒重复触发，持续 30 秒（最多 60） |
| `GET /dsh-session-notify/debug` | 队列、投递数、轮询模式、live 会话数、浏览器端自检状态 |
| `GET /dsh-session-notify/sessions` | 列出当前 live 会话（id / title / seq） |

浏览器端自检：控制台执行 `window.__DSH_SESSION_NOTIFY_VERSION__` 可确认已加载的客户端版本。

## 项目结构 / Structure

```
dsh-session-notify/
├── index.js          # Host 半：事件扫描 + 通知队列 + HTTP 路由
├── client.js         # 浏览器半：shell.overlay toast + 点击切换会话
├── cordis.patch.yml  # 插件注册补丁
├── package.json      # 包元数据（dsh.bundle / dsh.client）
├── LICENSE
└── README.md
```

## 已知限制 / Limitations

- 只能看到**宿主仍持有（live）**的会话；已被释放的历史会话不会再触发通知。
- 交互类通知依赖事件名 `approval/asked`（审批）、`tool/call` 中的 `ask_user_question`（提问）以及旧事件名 `interaction` / `ask-user` / `session/held`；若你的版本使用其他事件名，改 `index.js` 中的匹配列表即可。
- 通知点击依赖 `uiWorkspace` 服务（DSH 客户端内置）；若某版本服务名不同，可在 `client.js` 的 `navigateToSession` 候选列表里补充。

## 许可 / License

MIT
