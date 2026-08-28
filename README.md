# dsh-simplify

DeepSeek Harness 界面简化插件：进入清理模式后，右键移除页面元素，被移除的元素可在「设置 → 简化」中查看交互式预览并原样恢复。

Clean up the DeepSeek Harness (dsh) web UI: in clean mode, right-click any page element to remove it; removed elements can be previewed interactively and restored from the settings page.

## 功能 / Features

- 首页左下角、设置按钮上方的「简化」图标按钮，一键进入/退出清理模式（仅图标，无文字）。
- 清理模式中悬浮元素会显示红色描边，右键移除，左键操作完全不受影响，Esc 或再次点击按钮退出。
- 移除记录保存在浏览器 localStorage，并实时防复活（MutationObserver 重扫）：只有与移除时完全相同的元素会被重新清除，列表重排后位置漂移的相邻元素不会被误删。
- 设置页侧栏新增「简化」页：列出所有被移除元素，每条带**交互式预览**——按原样式绘制，直接点击预览即可执行该元素原本的操作且不会还原位置；可独立「恢复」或勾选后「批量恢复」，恢复的元素以原样回到原位置。
- 侧边栏折叠时，页脚按钮与其它插件统一排成一列，互不冲突。

## 安装 / Install

从 GitHub 仓库安装（需 dsh 命令行）：

```bash
dsh plugin --profile web add github:Anna-la/dsh-simplify
```

或从插件市场（dsh-market）搜索 `dsh-simplify` 安装。安装后重启 Harness（或刷新 Web 页面）即可。

Alternatively install from a local copy:

```bash
dsh plugin --profile web add ./<path-to>/dsh-simplify
```

## 使用 / Usage

1. 点击左侧底部设置按钮上方的「简化」图标进入清理模式（底部出现提示条）。
2. 移动鼠标，悬浮的元素会显示红色描边；对该元素单击右键即可移除。左键点击、拖拽等操作不受影响。
3. 按 `Esc` 或再次点击「简化」图标退出清理模式。
4. 打开「设置 → 简化」，可查看全部已移除元素：行内预览区显示元素原样式，点击可体验它原本的操作（不会还原位置）；勾选多条后点「批量恢复」，或对单条点「恢复」。

## 开发 / Development

- `client/client.js` —— 浏览器端 bundle（DSH client 插件，手写 `window.__ModuleLoader__.load` 格式，仅依赖 `react` seed）。
- `lib/index.js` —— 服务端占位入口（使 loader 能挂载该插件）。
- `fixture-test.html` 在本地存在：用系统 Chrome 打开可对引擎逻辑做全量自检（移除/记录/恢复/重扫/清理模式/设置页渲染/级联回归/交互预览，52 项断言）。

仓库结构符合 DSH 插件收录规范：`package.json` 声明 `dsh.bundle.patch` 与根目录 `cordis.patch.yml`。

License: MIT