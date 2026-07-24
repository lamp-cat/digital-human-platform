# API 契约（V1）——前后端集成唯一依据

前缀 `/api/v1`。认证：`Authorization: Bearer <token>`（注册/登录返回）。
错误统一：`{ "code": "...", "message": "...", "requestId": "...", "details": ... }`，错误码见 `packages/avatar-schema/src/errors.ts`。

## 认证

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{email, password, displayName?}` | `{token, user:{id,email,displayName,role}}` |
| POST | `/auth/login` | `{email, password}` | 同上 |
| GET | `/auth/me` | — | `{user:{id,email,displayName,role}}` |

角色：`user` / `asset_admin` / `system_admin`。种子账号：`demo@dhp.local / demo123456`（user），`admin@dhp.local / admin123456`（system_admin）。

## 角色（avatars）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/avatars` | `{name}` 创建默认人物 → `{avatar}` |
| GET | `/avatars` | 当前用户人物列表 → `{avatars:[AvatarSummary]}` |
| GET | `/avatars/{id}` | 完整 Profile 与资产引用 → `{avatar}` |
| PATCH | `/avatars/{id}` | `{expectedVersion, profile, name?}` 乐观锁保存 → `{avatar}`；冲突返回 409 `AVATAR_VERSION_CONFLICT` + `{details:{latestVersion, latestProfile}}` |
| POST | `/avatars/{id}/duplicate` | 复制 → `{avatar}` |
| DELETE | `/avatars/{id}` | 软删除 → 204 |
| POST | `/avatars/{id}/cover` | 上传封面（multipart 文件或 `{imageBase64}`）→ `{avatar}` 更新 cover_url |

```jsonc
// AvatarSummary
{ "id": "uuid", "name": "…", "baseAvatarId": "base-adult-v1", "version": 3,
  "coverUrl": "/api/v1/avatars/{id}/cover" 或 null, "visibility": "private",
  "createdAt": "…", "updatedAt": "…" }
// avatar（详情）= AvatarSummary + { "profile": AvatarProfile, "assetSource": {...} }
```

## 资产目录（assets）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/assets?type=garment&status=published` | → `{assets:[AssetEntry]}` |
| GET | `/assets/{id}` | → `{asset:AssetEntry}` |

```jsonc
// AssetEntry：GarmentManifest 超集
{ "id": "top-hoodie-01", "version": "1.0.0", "displayName": "…", "type": "garment|hair|accessory|shoes|base_avatar|animation",
  "category": "top", "slots": ["top"], "layer": 20, "rigVersion": "standard-rig-1",
  "compatibleBaseAvatars": ["base-adult-v1"], "shapeConstraints": {...}, "bodyMask": [...],
  "replacesSlots": [], "restrictsTraits": {}, "license": {...}, "status": "published",
  "assets": { "model": "procedural:top-hoodie-01",   // 内置资产：由 avatar-runtime 程序化生成
              "thumbnail": "/api/v1/assets/top-hoodie-01/thumbnail" } }
```

`assets.model` 为 `procedural:<id>` 时由前端 `avatar-runtime` 程序化构建；为 URL 时按 GLB 加载（导入人物预览等场景）。

管理端（`asset_admin` / `system_admin`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/assets/import` | `{manifest}` 提交资产校验任务 → `{job}` |
| POST | `/admin/assets/{id}/publish` | 发布 |
| POST | `/admin/assets/{id}/archive` | 下架 |
| GET | `/admin/assets` | 全部状态资产列表 |

## 外部模型导入（imports）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/imports` | multipart：`model`（.vrm/.glb 必传）、`manifest`（manifest.json 可选）、`rightsConfirmed=true` → 创建导入记录并启动校验任务 `{importRecord, job}` |
| GET | `/imports` | → `{imports:[ImportSummary]}` |
| GET | `/imports/{id}` | → `{importRecord}` 含 `status, compatibility, modelUrl(短时签名), previewUrl, displayName` |
| GET | `/imports/{id}/report` | → `{report}` 结构化校验报告（校验项、错误码、修复建议≤3 条） |
| POST | `/imports/{id}/activate` | `{name}` 用通过校验的资产创建私有人物 → `{avatar}` |
| DELETE | `/imports/{id}` | 删除私有导入及派生产物 → 204 |
| GET | `/jobs/{id}` | → `{job:{id,type,status,progress,resultJson,errorCode}}` |

导入状态机：`uploaded → validating → accepted_full | accepted_pose_only | rejected → activated`。
兼容等级：`FULL`（可换装）、`POSE_ONLY`（仅动作）、`REJECTED`。
错误码：`IMPORT_FILE_INVALID / IMPORT_FORMAT_UNSUPPORTED / IMPORT_RIG_INCOMPLETE / IMPORT_LIMIT_EXCEEDED / IMPORT_LICENSE_MISSING`。

## 健康检查

`GET /healthz` → `{status:"ok"}`；`GET /readyz` → `{status:"ready"}`。

## 其他约定

- 所有时间 ISO8601 UTC。
- 私有导入文件通过 `/api/v1/imports/{id}/model`（带 token 鉴权、短时有效）访问，绝不使用永久公开 URL。
- 摄像头视频/关键点 V1 完全不上传。
