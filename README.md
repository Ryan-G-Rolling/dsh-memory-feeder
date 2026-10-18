# dsh-memory-feeder

DSH 的记忆写回插件。每个完成的主会话轮次结束后，它把用户与助手的文本同步写入本地队列，再用该会话的模型抽取长期事实，追加到 Markdown 记忆库的候选区，等你核实后再合并。

v1 只写 `agents/dsh/inbox.md`，**不会**直接修改 `shared/`、`projects/` 或 `MEMORY.md`。

## 行为

- 只处理顶层会话（跳过 `origin: subagent`），只在 `turn/end` 且原因为 `completed` 时入队。
- 入队是同步追加 `.pending.jsonl`，所以 `dsh headless` 一次性运行退出前也不会丢。
- 抽取在插件启动后约 1.5 秒、新轮次入队后约 5 秒、失败后 15 秒重试。
- 每个完成轮次向 `agents/dsh/inbox.md` 追加一块，带来源会话、工作目录、模型、置信度和原始对话摘录；轮次内抽到的事实按 scope 合并成块。
- 已写过的候选记在 `.seen.json`，重复运行不会重复写；同一队列条目最多尝试 3 次。
- 抽取以用户亲口说的事实、计划、目标、偏好为主；助手的建议不会被改写成用户计划，助手长解释只在有可复用结论时提取。
- 入队前与写盘前清洗 `sk-*`、GitHub token、`Bearer`、私钥和 `key: value` 形式的凭据。
- 抽取器不读正式记忆，可能提出与已有条目重复的候选；合并时以正式条目为准。

## 安装

### 1. 准备记忆库目录

`memoryRoot` 指向你的 Markdown 记忆库根目录。插件会自动创建候选区目录和文件：

```
<memoryRoot>/
  agents/
    dsh/
      inbox.md        # 插件创建并追加
```

`memoryRoot` 没有默认值，必须显式配置；未配置时插件会写一条日志并停用。

### 2. 写入 DSH 配置

DSH 分两层，装错层会出现“配置了但没反应”：

- `~/.dsh/cordis.patch.yml`：给 web 和 headless 用。
- `~/.dsh/profiles/desktop/cordis.patch.yml`：给桌面版用。桌面宿主只读 profile 层，不读 home 层，所以桌面版必须单独 insert；桌面 profile 由 Electron 独占，不能用 `dsh plugin --profile desktop` 安装。

把下面的 insert 块追加到对应 patch 文件。`name` 用插件 `index.js` 的绝对路径（见 [cordis.patch.example.yml](cordis.patch.example.yml)）：

```yaml
- insert:
    - id: dsh-memory-feeder
      name: '<PLUGIN_DIR>/index.js'
      config:
        memoryRoot: '<MEMORY_ROOT>'
        inboxSubdir: agents/dsh
        debounceMs: 5000
        maxItems: 5
        minConfidence: 0.6
```

两处可以共用同一个队列和 `.seen.json`，不会重复写同一条记忆。改完桌面 patch 后重启桌面版。

> 不要把插件装在两个层都加载的位置，否则同一轮会入队两次。

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `memoryRoot` | 无（必填） | 记忆库根目录 |
| `inboxSubdir` | `agents/dsh` | 候选区相对路径，写入其中的 `inbox.md` |
| `debounceMs` | `5000` | 新轮次入队后延迟多久抽取 |
| `startupDelayMs` | `1500` | 启动后处理遗留队列的延迟 |
| `retryDelayMs` | `15000` | 失败或队列未清空时的重试间隔 |
| `maxPerRun` | `5` | 每次最多处理几条队列记录 |
| `maxQueueAttempts` | `3` | 单条记录最多尝试次数 |
| `maxItems` | `5` | 每轮最多保留几条候选 |
| `minConfidence` | `0.6` | 低于该置信度的提取结果丢弃 |
| `minTurnChars` | `30` | 用户加助手文本低于该长度不入队 |
| `maxTranscriptChars` | `16000` | 入队文本上限，用户约占 40% |
| `maxSeenEntries` | `2000` | 去重哈希保留条数 |
| `provider` / `model` | 空 | 留空时用该会话 `request/header` 的路由 |
| `queuePath` / `seenPath` / `logPath` | 插件目录 | 队列、去重表和日志位置 |

路径都建议用绝对路径。Windows 下 YAML 单引号里的反斜杠不需要转义，写成正斜杠也可以。

## 本地测试

复制 [test.patch.example.yml](test.patch.example.yml)，替换其中的 `<PLUGIN_DIR>` 与 `<MEMORY_ROOT>`，然后：

```sh
dsh headless --patch "<PLUGIN_DIR>/test.patch.example.yml" "随便完成一轮对话"
```

测试 patch 把候选区指到 `agents/dsh/_feeder_test`。headless 通常在入队后立刻退出，异步抽取可能来不及跑；再执行一次同样的命令，启动时就会处理上一条队列记录。

跑完清理：

```sh
rm -rf "<MEMORY_ROOT>/agents/dsh/_feeder_test"
rm -f "<PLUGIN_DIR>/.pending.test.jsonl" "<PLUGIN_DIR>/.seen.test.json" "<PLUGIN_DIR>/.feeder.test.log"
```

## 日志与排错

- 日志同时写 stderr 和插件目录的 `.feeder.log`，前缀 `[dsh-memory-feeder]`；stderr 不污染 headless 的 stdout。
- 启动日志里的 `ready (memoryRoot=...)` 说明配置已读到；只看到 `disabled: config.memoryRoot is required` 就是没配路径。
- 入队日志是 `queued turn ...`；抽取成功是 `extracted N item(s)` 和 `appended ...`。
- 卡在 `skip turn: no provider/model` 时，在配置里显式指定 `provider` 和 `model`。

## 安全边界

- 队列和日志里会有对话原文，按敏感文件对待，不要提交到公开仓库。仓库自带的 `.gitignore` 已忽略这些文件。
- 不写 API key、token、密码、登录态；敏感信息只放环境变量。
- 写入前会清洗常见凭据格式，但清洗是兜底，不是保证。不要把密钥粘进对话。
- 记忆库如果同步到远端，`inbox.md` 里的候选和对话摘录也会一起同步，按需选择私有备份。

## 限制

- 只处理顶层会话；子代理的对话不入队。
- 依赖 DSH 的 `llm` 服务和会话 `request/header` 里的 provider/model。
- 候选不会自动合并、去重到正式条目；需要人或其他 agent 定期清理。
- 在 Windows 的 DSH 桌面版、web 和 headless 上验证过；其他平台未实测。

## License

MIT
