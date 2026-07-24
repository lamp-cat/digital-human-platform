# apps/web — 三维创作台前端

模块化数字人平台的网页端（V1 参赛版）：三维编辑器、导入向导、虚拟直播间与管理后台。

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
| `/` | 工作区首页：人物装扮、虚拟直播间、真人视频复现三个独立一级入口 |
| `/create` | 创建向导：手动捏人 / 导入外部模型 |
| `/import` | 导入六步向导：选择文件 → 权属确认 → 上传（进度/取消）→ 校验 → 报告（FULL/POSE_ONLY/REJECTED 徽章 + 逐项检查 + ≤3 条修复建议）→ 预览激活 |
| `/editor/:id` | 三维编辑器：左侧分类（脸部/体型/肤色/穿搭）、中间三维视窗、右侧参数面板；撤销/重做、乐观锁保存（409 冲突弹窗）、封面快照上传 |
| `/avatars` | 人物管理；带 `workspace=style/studio/video` 时作为相应工作流的第一步人物选择页 |
| `/motion/:id` | 虚拟直播间：以“场景与机位 / 动作驱动 / 面部与手部”标签分组，支持 3D 房间导入、鼠标自由构图、相机位置/注视点/FOV 精确设置、自定义机位、人物站位、8 组骨架动作、摄像头姿态驱动、478 点面捕与 24 FPS 双手追踪 |
| `/video/:id` | 真人视频复现：独立完成本地视频导入、身体与双手识别、预览以及 WebM 导出，不混入直播间控制面板 |
| `/admin` | 管理后台（仅 admin）：资产筛选列表、发布/下架、manifest 校验任务 |

## 关键约定

- **骨骼驱动的世界系约定**：`rig-mapping` 输出相对绑定姿态的世界系旋转增量，`avatar-runtime` 的 `applyBoneRotations` 按父先子后顺序写入。`absolute-world-v5` 优先用 MediaPipe worldLandmarks（米制、髋部原点、深度可靠）把骨骼世界方向直接对齐关键点肢体方向；肩胸朝向作为 Neck/Head 的世界基准，头部只叠加局部增量。镜像预览只是 video 的 CSS 显示（`scaleX(-1)`），骨骼映射走解剖学对应（`mirror: false`，右手驱动右手）。
- **换装事务**：编辑器点穿搭卡片时先经 `AvatarPackage.wearTrait()`（内部调 schema `checkWearable()`）校验并预构建，成功才写入文档 store；失败 toast 结构化原因，场景与文档均不变。
- **导入人物能力分级**：`assetSource.type === 'imported'` 时，编辑器只显示导入 manifest 声明的可编辑参数（`editableProfile`）；`POSE_ONLY` 隐藏换装面板并显示「可动作控制，不支持 V1 通用换装」。
- **摄像头隐私**：视频与关键点完全在浏览器本地处理（MediaPipe wasm 本地加载），不上传任何帧。
- **真人视频复现**：在 `/video/:id` 独立页面导入本地视频，先跨时间轴粗扫，再围绕最清晰的完整人体帧精细标定；播放阶段以媒体时间戳同步身体和双手识别，低置信/短时缺失点由阻尼速度预测、弱检测重锚和骨长约束补全，源视频不镜像。页面分别显示原始置信度、有效置信度、≥80% 帧覆盖和人物追踪覆盖；Three.js 最终画布由 `MediaRecorder` 录成 WebM。
- **全身蹲起**：全身模式用髋中点到支撑脚踝的垂直距离估算重心高度，Hips 根位移配合腿部绝对旋转实现脚底锁定；站姿死区、One Euro 和速度限制抑制上下抽动。仅上半身模式不写 Hips 旋转或位移。
- **躯干转体**：肩线、髋线和髋肩竖轴组成三维身体坐标系，水平朝向按世界系绝对角驱动 Hips、Spine、Chest 与 UpperChest；Neck/Head 先跟随肩胸转向，再叠加头部相对动作，鼻部短时丢失也不会锁死世界正面。支持接近 180° 的侧身/背身和肩髋分离扭转；上半身模式仍不写 Hips。
- **直播间导入**：默认加载 Kenney CC0 家具直播间；本地支持 GLB、嵌入式 glTF、FBX 和 OBJ，模型完成解析与边界检查后才替换当前房间。
- **骨架动作抗抖**：导入人物的动画按 StandardRig 父链世界旋转增量和模型绑定姿态重定向；坐下/站起共用严格互逆关键帧，单次播放保持末帧，动作切换使用 0.35 秒交叉淡化。
- **面部表情追踪**：Face Landmarker（单脸 478 点 + 52 blendshape）→ 中性脸中位数标定 → 偏置/死区消除 → One Euro 平滑 → VRM 1.0 Expression、VRM 0.x BlendShapeGroup 或普通 GLB Morph。面部丢失后先短暂保持，再平滑回中性。
- **手部追踪（实验性）**：虚拟直播间面板中的开关（默认关）。Hand Landmarker（21 点 × 双手，24 FPS）→ 左右手时序身份稳定 → 关键点滤波 → 手掌/手指映射 → 四元数平滑与异常角速度限制 → VRM 手指扩展骨骼。handedness 保持解剖学对应；内置底模无手指骨骼时仅手掌朝向生效。

## 动作识别调试（/pose-lab 隐藏路由）

`/pose-lab`（不进导航）：用与生产完全相同的管线分析本地视频文件（默认
`/samples/broadcast-gymnastics.mp4`），量化「骨骼世界方向 vs 关键点世界方向」夹角误差，
页面画 2D 骨架叠加，结果挂到 `window.__poseLabResult`。

```bash
node scripts/pose-video-lab.mjs            # playwright + 本机 Chrome，报告存 tmp/pose-lab-report.json
# 常用参数：--query "auto=1&start=0&end=20&interval=0.2&calibSec=2&model=heavy&delegate=CPU&smooth=1&complete=1"
```

误差解读：主指标 `errors`（vs 图像关键点）受图像 z 噪声限制；自检 `errorsWorld`
（vs worldLandmarks）验证管线一致性（无 clamp 段应≈0）。回归夹具在
`packages/rig-mapping/test/fixtures/`（广播体操真实帧），由 vitest 断言方向语义。
`complete=1` 额外报告原始/有效置信度、≥80% 有效帧覆盖、人物追踪覆盖和每个有效帧
的推理点数；超过 1.2 秒且没有弱检测可重锚时停止推理，避免人物离场后继续“幻觉动作”。

## MediaPipe 本地化

`public/mediapipe/` 下的资源由 `scripts/setup-mediapipe.sh` 生成：

- `pose_landmarker_full.task`（约 9MB，流畅档姿态模型）
- `pose_landmarker_heavy.task`（约 29MB，精准档姿态模型，虚拟直播间默认档）
- `hand_landmarker.task`（约 7.8MB，手部追踪模型，实验性）
- `face_landmarker.task`（约 3.8MB，478 点与 52 项表情系数）
- `wasm/`（约 32MB，从 `node_modules/@mediapipe/tasks-vision/wasm` 拷贝）

`FilesetResolver.forVisionTasks('/mediapipe/wasm')` 指向本地路径，比赛现场可完全离线运行。
