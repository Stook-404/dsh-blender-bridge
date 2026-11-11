# dsh-blender-bridge

把本地 Blender 接进 DeepSeek Harness：对话里说「建模」「建一个…的模型」，agent 会真的在 Blender 里建模并渲染预览图。

## 位置

| 项 | 路径 |
|---|---|
| 插件源码 | `D:\Tools\dsh-blender-bridge` |
| 已注册到 | `C:\Users\admin\.dsh\profiles\desktop\package.json`（`file:D:/Tools/dsh-blender-bridge`，bundles 第 13 项） |
| 建模产物 | `C:\Users\admin\.dsh\blender-out\<jobId>\`（`spec.json` / `scene.blend` / `preview.png`） |
| 任务索引 | `C:\Users\admin\.dsh\blender-out\jobs.json` |
| Blender | `D:\Blender\blender.exe`（自动探测，可用环境变量 `BLENDER_EXE` 覆盖） |

## 组成

```
dsh-blender-bridge/
├─ package.json          插件清单（dsh.bundle.patch）
├─ cordis.patch.yml      挂载点：id=blender-bridge
├─ lib/index.js          服务端：2 个工具 + HTTP 路由 + 系统提示注入
├─ python/build_scene.py Blender 驱动（几何体/材质/灯光/相机/渲染）
└─ panel.html            可视化面板（轮询 /blender-bridge/jobs）
```

## 工具

### `blender_build`

参数（`objects` 必填）：

| 字段 | 说明 |
|---|---|
| `objects[].type` | cube / sphere / cylinder / cone / torus / plane / circle |
| `objects[].name` | 对象名 |
| `objects[].location` | `[x,y,z]` 米 |
| `objects[].scale` | `[x,y,z]` |
| `objects[].rotation` | `[rx,ry,rz]` 弧度 |
| `objects[].radius` | 球/柱/锥半径 |
| `objects[].color` | `#RRGGBB` |
| `objects[].metallic` / `roughness` | 0–1 |
| `title` | 面板显示的任务标题 |
| `ground` | 是否加地面 |
| `width` / `height` / `samples` | 渲染尺寸与 Cycles 采样（默认 720/720/32） |

返回：`jobId`、`preview`（PNG 路径）、`blend`（.blend 路径）、`objectCount`、`durationMs`。

### `blender_status`

列出最近任务（状态 / 标题 / 耗时）。

## 面板

服务端路由（挂在宿主 webServer 上）：

```
http://127.0.0.1:19387/blender-bridge/panel    ← 可视化面板
http://127.0.0.1:19387/blender-bridge/jobs     ← JSON 任务列表
http://127.0.0.1:19387/blender-bridge/preview/<相对路径>
```

面板每 2 秒轮询，展示每个任务的状态、预览图、耗时与产物路径。

## 触发规则

两处生效：

1. **工具描述**：写明「提到建模必须调用 blender_build」
2. **系统提示注入**：`ctx.systemPrompt.context({ name: 'dsh-blender-bridge:guidance', order: 72 })`

## 实现要点

- **无头建模**：`blender.exe --background --factory-startup --python build_scene.py -- spec.json out.blend out.png`
- **自动取景**：按场景包围盒 + 相机 FOV 计算距离（`dist = radius/2 / tan(fov/2) * fit`）
- **光照**：三盏面光（主光/补光/轮廓光）+ 世界背景，避免默认全黑
- **贴图**：Principled BSDF，颜色做 sRGB→线性转换
- **渲染**：Cycles CPU + 降噪（无头模式下 EEVEE 需要 GL 上下文，不可靠）
- **编码**：读 spec 用 `utf-8-sig`，容忍 PowerShell 写的 BOM

## 已知限制

1. **侧边栏按钮尚未实现**：DSH 的右侧栏需要注入 React 组件（`ctx.slots.register({name:'sidebar.right.pane.tab', key, inject}, Component)`），需要针对客户端运行时构建 bundle。当前用浏览器打开面板 URL 代替。
2. **EEVEE 不可用**：请在无头环境用 CYCLES。
3. 复杂建模（布尔、修改器、曲线、导入外部模型）尚未支持，目前是基本几何体组合。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-blender-bridge
```

源码目录 `D:\Tools\dsh-blender-bridge` 与产物目录 `C:\Users\admin\.dsh\blender-out` 需手动删除。


## 侧边栏标签

插件会在 DeepSeek Harness 右侧栏注册一个 **Blender** 标签页，内容即 `/blender-bridge/panel` 面板（建模任务列表 + 预览图，2 秒自动刷新）。

### 宿主脚本需要的两段注册

```js
ctx.inject(['sidebarRightTabs', 'slots'], (owner) => {
  const tabs  = owner.get('sidebarRightTabs')
  const slots = owner.get('slots') || owner.slots

  // ① tab 类型：决定右侧栏菜单里出现什么
  tabs.register({
    id: 'dsh-blender-bridge',
    kind: 'blender-bridge',
    keepMounted: true,
    title: () => 'Blender',
    guide: [{ id: 'panel', order: 120, title: () => 'Blender', description: () => '用 Blender 建模并预览' }],
  })

  // ② tab 身体：提供渲染组件
  slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-blender-bridge' }, BlenderPanel)
})
```

### 三个坑（实测）

| 写法 | 结果 | 原因 |
|---|---|---|
| 模块级 `inject: ['slots']` | ❌ 侧边栏无按钮 | 缺该服务的宿主会把插件 park，`apply` 不执行 |
| `ctx.get('slots')` | ❌ `slots === undefined` | 根 ctx 取不到服务 |
| `ctx.inject(['slots'], owner => ...)` | ✅ 可用 | 子 ctx 才有服务 |
| 只注入 `sidebarRightTabs` | ❌ `owner.slots` 为 undefined | 两个服务必须一起注入 |

`guide` 条目缺 `id` 或 `description` 时，标签不会出现在菜单里——这是最隐蔽的一处。

宿主没有右侧栏时，插件仍正常工作：工具与面板 URL 都不受影响。
