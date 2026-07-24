# 手部追踪开源方案评估

评估日期：2026-07-24。目标是在浏览器本地实时运行、维持现有 MediaPipe/Three.js/VRM
架构的前提下，提高指节屈曲、景深动作和左右手身份稳定性。

| 方案 | 能力与成熟度 | 许可证/体积 | 结论 |
| --- | --- | --- | --- |
| [MediaPipe Hands](https://github.com/google/mediapipe/blob/master/docs/solutions/hands.md) | 21 个 3D 手部关键点、双手、移动端实时；现有链路已经使用 | Apache-2.0；模型约 7.5 MB | 保留为主检测器 |
| [KalidoKit](https://github.com/yeemachine/kalidokit) | 面向 MediaPipe 与 VRM 的手腕/指节运动学解算，社区实践成熟；官方已标记 deprecated | MIT；npm 解包约 150 KB | 冻结 1.1.5，仅引入稳定的 Hand solver 作为局部关节角先验 |
| [Human](https://github.com/vladmandic/human) | 活跃的浏览器人体/手/脸统一检测栈，支持 WebGPU/WebGL/WASM | MIT；npm 解包约 44 MB | 与现有检测模型重复，暂不引入 |
| [TensorFlow.js Hand Pose Detection](https://github.com/tensorflow/tfjs-models/tree/master/hand-pose-detection) | 可选 MediaPipeHands/TFJS 运行时，同为 21 点输出 | Apache-2.0 | 替换接口但不增加关键点信息，暂不引入 |
| [WiLoR](https://github.com/rolpotamias/WiLoR) | 高精度 3D 手网格与 MANO 参数恢复 | 模型 CC-BY-NC-ND，依赖 GPU/MANO | 不满足当前纯浏览器与许可边界 |

## 最终融合设计

1. MediaPipe Hand Landmarker 继续输出 21 点图像坐标、米制世界坐标和左右手标签。
2. Pose Landmarker 的左右腕点参与 Hand Landmarker 双手身份分配，降低交叉和遮挡时串手概率。
3. 手掌使用严格右手坐标系构造世界朝向，避免反射矩阵造成“向内变向外”；启动后的
   10 个可靠帧再以 Pose 的 wrist/index/pinky 掌根方向校正 Hand Landmarker 的固定偏差。
4. KalidoKit Hand solver 提供相邻三点的局部指节屈曲角；四指按 40% 权重融合为运动学先验。
5. 拇指继续使用平台三维掌坐标系解算，避免 KalidoKit 的通用 Euler 轴与不同 VRM 模型局部轴冲突。
6. 最终输出继续经过 One Euro 关键点平滑、旋转死区、角速度限制和丢失回退；Hand
   骨骼使用 120 ms 低通、1.5° 死区和 300°/s 限速，手指保留更高响应，避免整手抽搐。

此方案只增加约 8.4 KB 的生产 JavaScript（gzip 约 2.3 KB），不增加第二套视觉模型，
也不上传摄像头画面或关键点。
