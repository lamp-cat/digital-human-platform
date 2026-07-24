# 第三方组件与许可证清单

| 组件 | 版本 | 用途 | 许可证 | 仓库 |
| --- | --- | --- | --- | --- |
| Three.js | ^0.169.0 | Web 三维渲染 | MIT | https://github.com/mrdoob/three.js |
| @pixiv/three-vrm | ^3 | VRM 人形模型加载与控制 | MIT | https://github.com/pixiv/three-vrm |
| @mediapipe/tasks-vision | ^0.10 | 浏览器端人体姿态关键点（Pose Landmarker） | Apache-2.0 | https://github.com/google-ai-edge/mediapipe |
| Mediabunny | ^1.51 | 浏览器端视频逐帧解码、WebCodecs 编码与 MP4/WebM 封装 | MPL-2.0 | https://github.com/Vanilagy/mediabunny |
| KalidoKit | 1.1.5 | MediaPipe 手部关键点的 VRM 指节运动学先验解算 | MIT | https://github.com/yeemachine/kalidokit |
| Pose Landmarker 模型 | float16 latest | 端侧姿态估计模型（本地打包，不上传视频/关键点） | 遵循 MediaPipe 模型条款 | https://storage.googleapis.com/mediapipe-models/ |
| Hand Landmarker 模型 | float16 latest | 端侧手部关键点估计模型（21 点 × 双手，本地打包；虚拟直播间“手部追踪”实验性功能） | Apache-2.0 | https://storage.googleapis.com/mediapipe-models/ |
| Face Landmarker 模型 | float16 latest | 端侧单人面部关键点与 52 项 blendshape 估计（本地打包，不上传视频/关键点） | Apache-2.0 | https://storage.googleapis.com/mediapipe-models/ |
| Quaternius Universal Base Characters | 2025-08 | 人物库拟真比例男女角色 | CC0 1.0 | https://quaternius.com/packs/universalbasecharacters.html |
| KayKit Adventurers | 1.0 | 人物库卡通法师、骑士 | CC0 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 |
| Open Source Avatars / 100Avatars R3 | — | 人物库二头身小熊、狐狸、柴犬 | CC0 1.0（模型内嵌元数据亦允许再分发） | https://github.com/ToxSam/open-source-avatars |
| Seed-san（VRM 样例人物） | — | 人物库科幻角色（`apps/web/public/open-avatars/models/seed-san.vrm`） | VRM Public License 1.0（VirtualCast, Inc.，要求署名） | https://github.com/madjin/vrm-samples |
| AvatarSample_A（VRM 样例人物） | — | 人物库动漫角色（`apps/web/public/open-avatars/models/avatar-sample-a.vrm`） | VRoid 样例模型使用条款 | https://github.com/madjin/vrm-samples |
| Kenney Furniture Kit | 2.0 | 默认虚拟直播间的 11 件家具 GLB（`apps/web/public/rooms/kenney/`） | CC0 1.0 | https://kenney.nl/assets/furniture-kit |
| React / React DOM | ^18 | 前端 UI | MIT | https://github.com/facebook/react |
| Vite | ^5 | 前端构建 | MIT | https://github.com/vitejs/vite |
| Zustand | ^4 | 前端状态管理 | MIT | https://github.com/pmndrs/zustand |
| React Router | ^6 | 前端路由 | MIT | https://github.com/remix-run/react-router |
| zod | ^3 | Schema 校验 | MIT | https://github.com/colinhacks/zod |
| FastAPI | 0.115.x | 后端 API | MIT | https://github.com/fastapi/fastapi |
| SQLAlchemy | 2.0.x | ORM | MIT | https://github.com/sqlalchemy/sqlalchemy |
| Pydantic | 2.9.x | 数据校验 | MIT | https://github.com/pydantic/pydantic |
| PyJWT | 2.x | JWT 鉴权 | MIT | https://github.com/jpadilla/pyjwt |
| Uvicorn | 0.3x | ASGI 服务器 | BSD-3-Clause | https://github.com/encode/uvicorn |

说明：

- 内置底模、衣物、配件与动作是本项目程序化生成的自有资产（`license: self-created / project-owned`）；默认直播间家具来自上表 Kenney Furniture Kit，原始许可证随文件保存在 `apps/web/public/rooms/kenney/LICENSE.txt`。
- 9 个内置开源人物的逐文件来源、许可、骨架能力与 SHA-256 见 `apps/web/public/open-avatars/README.md`。
- CharacterStudio 仅作为 Trait/Culling 设计思路参考，未携带其任何代码、NFT/钱包相关概念。
- 模型权重与代码分别记录；MediaPipe 模型资产条款以其官方发布页为准，比赛演示前需复核。
