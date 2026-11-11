# 实际会话侧栏：host 节拍单灯集成

2026-11-11，本机 `/Users/yanghao/myprogram/codex-tern`，Tern 0.9.16 (41a10a5)。

结论：已将正式会话侧栏从 window-only canvas 改为 `codex-tern.sessions` host block。实际客户端配合固定 app-server 的隔离离屏验证通过，运行行按共享 500ms host 节拍亮暗切换；普通前台窗口连续实时呈现仍未验证。本轮没有连接、刷新或重启日常窗口，没有 commit/push。

## 实现与边界

- `tern-plugin/plugin.toml` 注册 host 入口和非独立菜单项的 sessions block，仍保留原窗口入口、TOC 及样式。
- `sessions-view.luau` 提取原列表视图，保留每行节点 key、状态优先级、颜色、可访问名称、标题效果、菜单、置顶和归档控件；每行仅一个 8×8 灯。只有 working 行随 host 相位加减 dim class，opacity 在 1/0.2 间变化。
- `session-beat.luau` 为全部会话侧栏共用一个 host timer。回调修改相位并通过 `BlockCx:render()` 更新实际视图；没有灯光用的 window Lua timer 或 CSS animation。晚到跳过错过的相位，不补发积压回调。没有 working 行即取消灯计时器。
- `host.luau` 保存目标 client pane 与列表快照，接收 `sync` block 事件，计算是否存在 working 行并启停节拍；重载恢复状态但加入当前相位。可选 `CT_SESSION_LIGHT_TRACE=1` 记录 tick/view/render_return/sync/cancel。
- `window.luau` 继续使用已有 bridge 获取真实客户端列表，保留业务轮询、宽度偏好、导航确认、锁定检查及 TOC；将快照通过 `cx.session:event` 交给 host block，不声称 host 能直接改 canvas。host 点击经 `BlockCx:open` 的窗口 link route 回到原动作处理，重新检查最新状态；内部路由总被消费，不交给外部 URL handler。实测导航、置顶、重命名、归档均经过此路径。

灯计时器停止不等于移除原有业务/宽度轮询；它们仍负责会话变化和布局，不驱动闪烁。快照发现仍依赖原窗口 bridge，因此本次没有宣称解决窗口事件派发的所有问题，也未改变原TOC的canvas架构。

## 关闭与迁移

Tern 0.9.16 关闭 plugin pane 后可能保留 host pane ID，不能只依赖 `pane_exited`。窗口的 `pane_closed` 标记本插件 KV，host 下一拍释放该记录、不再 render 或重排；卸载同时取消计时器并清理捕获记录，代际检查阻止旧回调复活。只有非运行状态时不额外开计时器，记录最迟在 unload 释放。窗口半部新增 unload 取消既有业务/宽度 timer。

恢复时只识别本插件拥有的 `codex-tern.sessions/v1:<target>` 旧 canvas，通过真正的 host block 替换其布局位置，然后关闭旧 pane；不迁移其它 owner 的 canvas。旧列表 bridge 和动作协议没有变化，因此无需重启 Codex app-server 客户端。

## 实际生效方式

源码与 `bun run build` 构建均已完成，独立离屏实例已加载新代码。**日常 Tern 实例尚未由本轮加载新插件。**

已通过 setup 链接本仓库插件时，由用户在目标 Tern 环境运行：

```sh
tern plugin reload codex-tern
```

这会加载 host/window 新入口；窗口恢复逻辑迁移旧会话 canvas，缺失侧栏可再从命令面板执行 `Codex: Sessions`。如果从未链接本仓库插件，先在仓库运行 `bun bin/codex-tern setup`。以上是正常插件生效入口；本轮仅在独立离屏 fixture 中实测重载与迁移，没有对日常实例执行这些命令。

## 最终验证与证据

最终证据目录：`/private/tmp/ct-sidebar-host-1794388262249-89422/`。

- `result.json`：ok=true、errors=[]；记录命令边界、静默区间、原生布局、焦点与清理。
- `events.jsonl`、`daemon.log`、`renderer.log`：逐事件记录与独立外部单调接收时间。
- `serve/working.png`、`after-quiet.png`、`phase-*.png` 和布局 JSON：实际会话侧栏单灯亮暗帧。

实际客户端从项目构建启动，后端为仓库固定 fixture，不调用真实模型或真实用户会话。验证覆盖自动打开、每行单灯/名称/尺寸、目录过滤、真实行切换、置顶、分页、右键重命名、后台行归档、新建会话、任务停止、运行时重载与侧栏关闭。TOC和宽度代码沿用原实现，没有在日常窗口重新验收所有交互。

| 检查 | 实测 |
| --- | --- |
| 后台节拍 | 约8秒真实墙钟静默区间，0次ctl，16 tick / 16 view / 16 render_return |
| 间隔 | 插件内部最大503.938375ms、最大late 5.108250ms；外部日志接收最大504.259625ms |
| 原生帧 | 消费者布局收到 working 灯 opacity=1和0.2，客户端pane2在检查点保留焦点 |
| 运行时重载 | 旧VM cancel(reason=unload)/disposed，新VM恢复一个侧栏；静默区间只有一个替代计时器的频率，没有重复节拍 |
| 非运行 | 停止后静默区间0 tick/0 render_return；状态颜色与已读优先级保留 |
| 关闭 | 关闭后至多下一拍处理释放，后续不再render或排灯timer |
| 旧canvas迁移 | 为正确插件owner造旧canvas，再调用生产迁移逻辑；旧pane移除，仅一个host侧栏，客户端焦点保留 |
| 清理 | remaining=[]，endpointsRemaining=[]，原有Tern进程PID和启动时间仍匹配 |

迁移 fixture 只在临时插件副本追加一个创建旧 canvas 的命令，用来得到正确 owner；其余主要交互和节拍验证直接加载仓库生产插件。此前把 Carly owner 的 canvas 当旧插件侧栏的测试断言失败，已纠正；所有失败尝试均清理进程和端点，不计入通过。

后台与静态检查：

- `lua test/session-beat.test.lua`：7项通过，覆盖生产状态优先级、共享节拍、晚加入、停/启、关闭、卸载和迟到；受控时钟不是实时证据。
- `bun test test/session-status.test.ts test/session-actions.test.ts test/commands-skills-pin.test.ts test/reading-position.test.ts test/session-titles.test.ts`：70项通过、0失败。
- `bun run build`：包含 TypeScript noEmit 检查及实际构建，通过。
- 新增 Luau 由真实 Tern VM 加载执行；没有独立 Luau 静态检查器。
- `git diff --check` 通过。原有未提交修改保留；本轮只调整相关侧栏文件、预览测试入口，并添加 host 实现和测试。

`node scripts/session-host-qa.mjs` 为复现入口，强制独立配置、daemon、control、shell配置、Codex目录和工作目录；仅离屏 serve，不创建可见窗口。清理只针对本次 PID+启动时间，并核验 socket 删除。

## 未证明的部分

本次必须区分：host 真实回调与独立外部接收时间、`cx:render()`/view 构造及消费者帧变化、屏幕实时呈现。离屏消费者布局已收到亮暗变化，但没有逐帧传输或呈现时间戳；边界检查本身也会推进headless处理，不能拿两张截图证明持续显示。`serve` 使用进程内host，灯事件归属该host VM；独立daemon仅核验插件可加载，不代表普通窗口/daemon全链路实测。尚未取得“应用在前台、灯block未聚焦”的普通原生窗口连续显示证据，不能宣称底层数秒停派发已修复。

下一步由用户加载新插件后确认真实窗口体验；进一步自动验收仍需不抢焦点的独立实时原生呈现观测能力，本轮不操作日常窗口来补这个证据。

## 既有独立问题

原 `sessions.css` 的标题样式 `width: fit-content` 在该构建有解析警告，灯规则正常；该属性与本轮前的内容一致，未扩展修改。原型文档 `host-light-prototype.md` 是前一轮独立原型报告，本轮正式集成以本文为准。
