Original prompt: 帮我优化坦克的效果，然后路面也做得好看点

- 已读取项目结构，核心逻辑集中在 src/App.vue。
- 计划：增强坦克动态表现（后坐力、炮口闪光、履带尘土、移动抖动）并重做地面纹理（渐变+车辙+噪点）。- 已完成第一轮视觉增强：
  - 坦克新增后坐力、炮口闪光、履带动态纹理、移动扬尘、阴影。
  - 地面重绘为渐变+网格噪点+横纵纹理+裂纹细节。
- 补充自动化钩子：window.render_game_to_text 与 window.advanceTime(ms)。
- 修复潜在运行错误：移除 setupBgm 内未定义变量引用。
- 清理重复 tick 定义，统一为 runFrame + tick 主循环。
- 发现 Playwright client 初次执行失败：缺少 playwright 依赖。
- 正在安装 playwright，并准备重跑自动化截图验证。
- Playwright 验证已通过（使用技能脚本 web_game_playwright_client.js）。
- 产物：output/web-game/shot-0..2.png, state-0..2.json。
- 控制链路验证：左移 + 开火动作正常，state 与画面一致；无 errors-*.json。
- 后续可选优化：若希望更明显的“履带压痕”，可把地表粒子持久化为短时 decal 层。
