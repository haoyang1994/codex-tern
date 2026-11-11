# 后台节拍单灯原型：实现与实测

2026-11-11，本机 `/Users/yanghao/myprogram/codex-tern`，Tern 0.9.16 (41a10a5)。

结论：独立 host-owned block 原型已实现，后台回调和离屏帧变化验证通过；尚不能证明普通前台窗口里、灯光 block 未聚焦时的连续实时显示已经解决。没有迁移侧栏、重启日常窗口、安装到日常配置或 commit/push。

## 原型位置与行为

`plugins/host-light-prototype/` 是独立插件，没有改动原有 `tern-plugin/` 的常亮草稿。

- `beat.luau`：所有原型 block 共用一个 500ms host timer，按共同的时钟边界更新相位。晚到不补发积压回调；新灯加入当前相位。停止最后一个运行状态时取消计时器，代际检查阻止已排队旧回调复活。
- `host.luau`：注册 `host-light-prototype.light`。回调变更 `state.lit` 后实际调用 `BlockCx:render()`；`view` 返回单个 8×8 灯节点，Tern 负责 diff 与视图传送。诊断以 `CT_HOST_LIGHT_TRACE=1` 开启，区分 tick、view、render_return。
- `window.luau`：仅提供不改变 block 焦点的打开命令和 `pane_closed` 生命周期桥接。没有窗口 Lua timer。
- `light.css`：亮暗来自状态 class 对应的 opacity 1/0.2；明确禁用 CSS animation/transition。

本原型只有“运行中”青灯闪烁。等待输入为黄灯、等待权限及失败为红灯、完成未读为绿灯，均常亮；已读/未运行为灰灯。停止运行不会为了其它状态继续保活计时器。`beat.status` 保留等待/权限、运行与已读重叠、其他客户端锁定、失败与完成的优先级，单元测试覆盖这些语义。这里的按钮和状态均为合成数据，尚未连接 Codex 会话或侧栏 bridge。原方案不同状态的不同闪烁周期未迁入这个最小原型。

保存仅持久化状态含义，恢复时加入共享相位。卸载取消旧计时器并释放捕获的 context；运行中的 pane 在插件重载后重新 init，随后由新 VM 计时器继续闪烁。

## 生命周期修正

第一次真实关闭验证发现：该构建关闭插件 pane 后，host 的 `tern.pane.list()` 仍保留其 ID，且没有观察到 `pane_exited`；仅靠 host 列表剔除会使计时器继续运行。最终实现由窗口的 `pane_closed` 在本插件 KV 中标记关闭，host 在下一次共享节拍读取标记、释放记录且不再 render；没有新增窗口计时器或保活刷新。`pane_exited` 与 unload 同时保留清理路径。仅有非运行状态时没有调度，关闭标记及捕获记录最迟在 unload 清理；这不是完整侧栏生命周期方案。

## 最终实际证据

最终通过运行：`/private/tmp/ct-host-light-1794387330121-53852/`。

`result.json` 保存命令时间、静默区间、宿主日志归属、逐事件外部接收时间、布局、状态与清理结果；`events.jsonl`、`daemon.log`、`renderer.log` 保存原始记录，`serve/` 保存 PNG 和布局 JSON。

| 检查 | 实测 |
| --- | --- |
| 无干预墙钟区间 | 12001ms，0 次 ctl；伴随 pane2 保持 block 焦点，灯在 pane4 |
| 回调与构造 | 24 tick、24 view、24 render_return，亮暗交替 |
| 插件内部时钟 | 最大相邻间隔 504.719084ms，最大 late 5.066334ms |
| 独立外部观测 | Node `performance.now()` 记录日志接收，最大相邻接收间隔 504.851208ms；首尾接收跨度 11496.047667ms。它是接收时间，不冒充精确的原生回调进入时间 |
| 实际视图变化 | 原生离屏布局收到同一个 8×8 青色单灯的 opacity=1 与 0.2；检查点焦点始终为 pane2 |
| 完成与已读 | 完成后 1701ms 静默区间 0 tick/0 render；完成绿灯和已读灰灯均为 opacity=1 |
| 恢复运行 | 1701ms 内 4 次 tick/render |
| 关闭 | 1701ms 内仅下一次 tick 处理清理，0 render，之后未重排 |
| 活动卸载 | 实际 fixture 重载出现 cancel(reason=unload)、disposed；保存的运行状态重新 init 后恢复新节拍，不能将其误称为旧 timer 泄漏 |
| 清理 | remaining=[]，endpointsRemaining=[]；原有 Tern 进程 PID+启动时间仍匹配 |

三个证据层次必须分开：

1. **回调**：外部真实墙钟区间里有独立接收的约 500ms host 回调记录，未使用 `ctl wait` 推进时间或反复刷新维持节拍。headless 的模拟文档时钟不作为真实墙钟。
2. **视图发送/接收**：真实 `cx:render()` 返回、`view` 构造和消费者原生布局的两种亮暗状态已验证。没有逐帧协议发送/接收时间戳，不能断言每一帧都在 500ms 内传到消费者；截图/布局检查本身可以推动 headless 处理。
3. **实时显示**：没有可见原生窗口；离屏布局报告 onScreen=false/windowed=false。没有证明“应用在前台、灯所在 block 未聚焦”的普通窗口连续实时呈现，也没有逐毫秒焦点采样。本结果只支持 host 路径原型与离屏帧变化可行，不支持宣称日常停顿已修复。

`serve` 使用进程内 host；最终灯的 tick/view/render 日志归属 renderer 进程中的 **host VM**，不是 window VM。另起的独立 daemon 加载了实际 host 插件，但未拥有该离屏灯。不能把本次结果说成普通窗口与独立 daemon 之间的全链路验证。

## 测试与完整性

- `lua test/host-light.test.lua`：9 项通过，属于受控时钟语义/取消/共享节拍测试，不是实时性能证明。
- `bun test test/activity.test.ts test/session-status.test.ts`：17 项通过、0 失败。
- `bun run check`：TypeScript noEmit 通过。本机无独立 Luau 静态检查器；新增 Luau 已由真实 Tern VM 加载和执行。
- `node --check scripts/host-light-qa.mjs`：通过。
- `scripts/host-light-qa.mjs`：最终原生离屏集成运行 `ok=true`、errors=[]。先前实验捕获的 SDK 调用、布局类型断言和关闭清理问题已修正，不将失败运行算作通过。
- 本轮开始前的 30 个已修改/未跟踪文件 SHA256 均未改变，基线在 `/private/tmp/ct-host-light-baseline-20261111.json`；未覆盖或回退用户与并发改动。

复现实验入口为 `node scripts/host-light-qa.mjs`。它使用新建的 `/private/tmp/ct-host-light-<time>-<pid>`、私有配置/插件目录/daemon socket/control socket、空 shell 启动配置及安静子进程，禁止默认端点回退；不创建可见窗口。受限运行器若拒绝读取 ps/GPU，仅按原审批机制申请运行该脚本，不改用日常窗口。每次运行产生独立目录；清理按 PID+启动时间，仅处理本次所有进程，再清除本次 socket。实验结束后不再运行任何计时器。

## 推荐下一步

保留为候选原型，暂不迁移侧栏。下一步应先取得能连接普通 daemon、按真实墙钟连续运行且不抢焦点的独立离屏原生窗口/呈现观测能力，再测“前台但灯 block 未聚焦”，同时记录帧接收与呈现时间。当前工具没有提供这种实时画面证据；在此之前不能以两张截图或模拟时钟判定停顿已经解决。若通过，再单独评估 window-only canvas 到 host block 的最小结构迁移。
