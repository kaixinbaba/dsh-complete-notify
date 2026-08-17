# Changelog

## 0.4.0 — 2026-08-17

- 新特性：通知按**结果状态**区分——绿「任务完成」/ 黄「等待你的反馈（阻塞）」/ 红「任务已中断 / 任务失败」/ 橙「达到 token 上限」；toast 图标、标题、左边框按状态着色，系统通知标题同步区分
- Host 记录每个根会话最近一次 `turn/end` 的 `reason.kind`（`session/event` 监听），经 recap 路由一并返回给客户端；客户端兜底推断（`turn-error` / `turn-max-tokens` 节点、被打断的 assistant）
- 修复：阻塞（等待反馈）时 agent 回到 idle 原会被误报为「任务完成」，现正确显示黄色「等待你的反馈」
- 新增结果状态相关单测（共 27 个用例全绿）

## 0.3.0 — 2026-08-17

- 新特性：toast 与系统通知附带**一句话小结（💬 recap）**——弹窗先显示降级小结（最终回答前 50 字清洗版），Host 端异步调用 LLM 生成真正的 ≤50 字小结并自动升级替换；小结覆盖整轮运行
- Host 半从空壳变为真实实现：监听 `agent/status` idle 触发 recap 生成（每次运行一次 LLM 调用），经 webserver 路由 `GET /dsh-complete-notify/recap` 供客户端拉取
- 新增 Host 与客户端小结/回答提取单测（共 24 个用例全绿）
- 文档：说明 recap 的降级/升级机制与「最后一轮统计 vs 整轮小结」的口径差异

## 0.2.0 — 2026-08-16

- 新特性：toast 与系统通知附带**运行统计**——时长（⏱，`turnTimings` 最后一轮）、tokens（⚡，assistant 消息 `usage` 输入+输出之和）、步骤数（🔧，工具调用块计数）
- toast 增加「点击打开会话」提示，点击直达对应会话；系统通知点击同样聚焦并打开会话
- 新增运行统计模块单元测试（共 16 个用例全绿）
- 文档：安装方式改为 npm 优先，新增 CHANGELOG

## 0.1.0 — 2026-08-16

- 首发：任务完成时播放 Web Audio 合成「叮咚」提示音 + 页面内 toast；页面在后台时发送系统通知 + 标题闪烁
- 完成检测与官方运行指示灯同源（会话列表 `running` / `completed`），按会话去重、子代理过滤、多会话 toast 栈限 3 条
- 设置页（设置 → 任务完成通知）：总开关 / 音效 / 系统通知 / 音量 / 测试音效与测试通知，localStorage 持久化
- 发布到 GitHub（kaixinbaba/dsh-complete-notify）与 npm（dsh-complete-notify）
