# Changelog

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
