# apps/web — 三维创作台前端

模块化数字人平台的网页端（V1 参赛版）：三维编辑器、导入向导、动作模式与管理后台。

## 技术栈

Vite 5 + React 18 + TypeScript 5 + three.js + @pixiv/three-vrm + zustand + react-router-dom 6 + @mediapipe/tasks-vision。无 UI 框架，样式为手写深色编辑器风格。

## 开发

```bash
# monorepo 根目录
npm install
bash scripts/setup-mediapipe.sh   # 首次：本地化姿态模型与 wasm（离线运行要求）
bash scripts/dev-web.sh           # 或 npm run dev:web
```

- 开发服务器：<http://localhost:5173>，`/api` 代理到 `http://localhost:8000`（后端）。
- 演示账号：`demo@dhp.local / demo123456`（普通用户），`admin@dhp.local / admin123456`（管理员）。

## 质量命令

```bash
npm run typecheck --workspace apps/web   # tsc --noEmit
npm run build --workspace apps/web       # vite build
```

## 页面

| 路由 | 说明 |
| --- | --- |
| `/login` | 登录 / 注册 |
| `/` | 首页：项目介绍、两条创建路径、公开示例占位 |
| `/create` | 创建向导：手动捏人 / 导入外部模型 |
| `/import` | 导入六步向导：选择文件 → 权属确认 → 上传（进度/取消）→ 校验 → 报告（FULL/POSE_ONLY/REJECTED 徽章 + 逐项检查 + ≤3 条修复建议）→ 预览激活 |
| `/editor/:id` | 三维编辑器：左侧分类（脸部/体型/肤色/穿搭）、中间三维视窗、右侧参数面板；撤销/重做、乐观锁保存（409 冲突弹窗）、封面快照上传 |
| `/avatars` | 我的数字人：封面卡片、编辑/动作/复制/删除 |
| `/motion/:id` | 动作模式：预置动作（待机/挥手/走路）+ 摄像头姿态驱动（校准 2.5s → 实时驱动 → 丢失回退）+ 手部追踪（实验性开关：手掌朝向 + 五指屈伸，需 VRM 模型带手指骨骼） |
| `/admin` | 管理后台（仅 admin）：资产筛选列表、发布/下架、manifest 校验任务 |

## 关键约定

- **骨骼驱动的世界系约定**：`rig-mapping` 输出相对绑定姿态的世界系旋转增量，`avatar-runtime` 的 `applyBoneRotations` 按父先子后顺序写入。v2 绝对方向映射（`absolute-world-v2`）：优先用 MediaPipe worldLandmarks（米制、髋部原点、深度可靠）把骨骼世界方向直接对齐关键点肢体方向，与校准姿势无关（站立预备即可校准）；镜像预览只是 video 的 CSS 显示（`scaleX(-1)`），骨骼映射走解剖学对应（`mirror: false`，右手驱动右手）。
- **换装事务**：编辑器点穿搭卡片时先经 `AvatarPackage.wearTrait()`（内部调 schema `checkWearable()`）校验并预构建，成功才写入文档 store；失败 toast 结构化原因，场景与文档均不变。
- **导入人物能力分级**：`assetSource.type === 'imported'` 时，编辑器只显示导入 manifest 声明的可编辑参数（`editableProfile`）；`POSE_ONLY` 隐藏换装面板并显示「可动作控制，不支持 V1 通用换装」。
- **摄像头隐私**：视频与关键点完全在浏览器本地处理（MediaPipe wasm 本地加载），不上传任何帧。
- **手部追踪（实验性）**：动作模式面板中的开关（默认关）。Hand Landmarker（21 点 × 双手）→ `hand-mapper` 手掌坐标系 + 手指屈伸映射 → 手指扩展骨骼（VRM 命名 30 根，仅 rigMap 中存在的骨骼生效）。handedness 按官方文档对未镜像前置画面做一次左右交换，保持解剖学对应。内置底模无手指骨骼时仅手掌朝向生效。

## 动作识别调试（/pose-lab 隐藏路由）

`/pose-lab`（不进导航）：用与生产完全相同的管线分析本地视频文件（默认
`/samples/broadcast-gymnastics.mp4`），量化「骨骼世界方向 vs 关键点世界方向」夹角误差，
页面画 2D 骨架叠加，结果挂到 `window.__poseLabResult`。

```bash
node scripts/pose-video-lab.mjs            # playwright + 本机 Chrome，报告存 tmp/pose-lab-report.json
# 常用参数：--query "auto=1&start=86&end=620&interval=0.15&calibSec=604&model=heavy&delegate=CPU&smooth=1"
```

误差解读：主指标 `errors`（vs 图像关键点）受图像 z 噪声限制；自检 `errorsWorld`
（vs worldLandmarks）验证管线一致性（无 clamp 段应≈0）。回归夹具在
`packages/rig-mapping/test/fixtures/`（广播体操真实帧），由 vitest 断言方向语义。

## MediaPipe 本地化

`public/mediapipe/` 下的资源由 `scripts/setup-mediapipe.sh` 生成：

- `pose_landmarker_full.task`（约 9MB，流畅档姿态模型）
- `pose_landmarker_heavy.task`（约 29MB，精准档姿态模型，动作模式默认档）
- `hand_landmarker.task`（约 7.8MB，手部追踪模型，实验性）
- `wasm/`（约 32MB，从 `node_modules/@mediapipe/tasks-vision/wasm` 拷贝）

`FilesetResolver.forVisionTasks('/mediapipe/wasm')` 指向本地路径，比赛现场可完全离线运行。
