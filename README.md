# gitocode

监控一个 GitHub 仓库：当指定协作者 push 了对 prompt 文档的修改时，把改动交给 Claude Code CLI 处理，再以 bot 身份自动 commit + push 结果。每个仓库固定使用同一个 Claude session，上下文可以跨任务延续。

## 工作流程

```
每 pollIntervalSec 秒 git fetch
  → 找出 lastProcessedSha..origin/main 之间改动了 promptFiles 的 commit
  → 只保留 watchAuthors 白名单内的作者（bot 自己的 commit 永远忽略，防止死循环）
  → 防抖 debounceSec：远端停止变化后才开始处理，连续多次 push 合并成一次任务
  → git pull --rebase
  → 把每个 commit 对 prompt 文件的 diff 通过 stdin 交给 claude -p（首次 --session-id，之后 --resume）
  → git add -A && commit（bot 身份）&& push（被拒时会 rebase 后重试一次）
  → 更新 state.json
```

## 使用

要求：Node >= 18，`claude` CLI 已登录，并且本机的 git 对该仓库有 push 权限。

```bash
cp config.example.json config.json   # 按需修改
npm start                            # 常驻运行
npm run once                         # 只跑一轮（调试用）
node src/index.js -c other.json      # 指定其他配置文件
```

第一次运行只记录当前远端的 HEAD，不会回放历史。如果想让 Claude 处理已有的 prompt，把 `state.json` 里的 `lastProcessedSha` 改成更早的 commit 即可。

## 配置项

| 字段 | 说明 |
|---|---|
| `repoPath` | 被监控仓库在本机的 clone 路径（必须是干净的工作区，不要在里面手动改东西） |
| `remote` / `branch` | 默认 `origin` / `main` |
| `promptFiles` | 要监控的 prompt 文档路径（相对仓库根目录） |
| `watchAuthors` | 作者白名单，填邮箱或 git 用户名。留空表示除 bot 外所有人 |
| `bot` | 自动 commit 时使用的身份，**必须和白名单里任何人都不同** |
| `pollIntervalSec` | 轮询间隔 |
| `debounceSec` | 防抖时间，0 表示不防抖 |
| `claude.permissionMode` | 推荐 `acceptEdits` |
| `claude.allowedTools` / `disallowedTools` | 工具白名单/黑名单，见下方安全说明 |
| `claude.model` | 留 `null` 使用默认模型 |
| `claude.timeoutMin` | 单次任务超时 |
| `claude.extraArgs` | 透传给 claude 的其他参数 |

## state.json

```json
{ "lastProcessedSha": "...", "sessionId": "...", "runs": 3, "failures": 0 }
```

- 想**重置 Claude 会话**（上下文太长或跑偏时）：停掉程序，删除 `sessionId` 字段后重启。
- 想在交互模式下查看或接管这个会话：`cd <repoPath> && claude --resume <sessionId>`。

## 出错时的行为

- `fetch` 失败（网络问题）：记录日志，下一轮重试。
- Claude 返回错误且**没有改动文件**：不推进进度，下一轮重试；连续 3 次失败后退出。
- Claude 返回错误且**留下了改动**，或工作区本来就不干净：直接退出，等人工检查。
- Ctrl-C：等当前任务完成后再退出；再按一次强制退出。

## 安全说明

协作者写的内容会被一个能改文件、能执行命令的 agent 执行，相当于给了对方在你机器上的部分执行权：

- 不要使用 `--dangerously-skip-permissions`，并且尽量收紧 `allowedTools`。headless 模式下不在白名单里的工具会被直接拒绝。
- 发给 Claude 的 diff 只来自白名单作者的 commit，但 Claude 仍然能读到完整的 prompt 文件（里面可能包含其他人的修改）。
- 建议在 GitHub 上给 prompt 文件设置保护，比如 CODEOWNERS 或分支保护，限制谁能修改它。
