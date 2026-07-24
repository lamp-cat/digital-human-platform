import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { EmptyState } from '../components/controls';
import { api, ApiError, fetchAuthedObjectUrl } from '../api/client';
import type { AvatarSummary } from '../api/types';
import { useUiStore } from '../stores/uiStore';

type WorkspaceKind = 'style' | 'studio' | 'video';

const WORKSPACE_CONFIG: Record<
  WorkspaceKind,
  {
    title: string;
    subtitle: string;
    action: string;
    path: (id: string) => string;
  }
> = {
  style: {
    title: '选择要装扮的人物',
    subtitle: '选择后进入人物装扮工作区，只显示外观与服装编辑工具。',
    action: '开始装扮',
    path: (id) => `/editor/${id}`,
  },
  studio: {
    title: '选择直播人物',
    subtitle: '选择后进入虚拟直播间，进行布景、自由机位和实时动作驱动。',
    action: '进入直播间',
    path: (id) => `/motion/${id}`,
  },
  video: {
    title: '选择视频复现人物',
    subtitle: '选择后进入独立视频工作区，导入真人舞蹈并导出数字人视频。',
    action: '进入视频复现',
    path: (id) => `/video/${id}`,
  },
};

/** 封面图（带鉴权 blob 加载）。 */
function Cover({ url, alt }: { url: string | null; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    if (url) {
      fetchAuthedObjectUrl(url)
        .then((u) => {
          revoked = u;
          setSrc(u);
        })
        .catch(() => setSrc(null));
    }
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [url]);
  if (!src) return <div className="cover placeholder">{alt.slice(0, 2)}</div>;
  return <img className="cover" src={src} alt={alt} />;
}

/** 列表加载占位。 */
function SkeletonGrid() {
  return (
    <div className="avatar-grid">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton skeleton-cover" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

/** 我的数字人列表。 */
export function AvatarsPage() {
  const [avatars, setAvatars] = useState<AvatarSummary[] | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useUiStore((s) => s.toast);
  const requestedWorkspace = searchParams.get('workspace');
  const workspace: WorkspaceKind | null =
    requestedWorkspace === 'style' ||
    requestedWorkspace === 'studio' ||
    requestedWorkspace === 'video'
      ? requestedWorkspace
      : null;
  const workspaceConfig = workspace ? WORKSPACE_CONFIG[workspace] : null;

  const load = useCallback(async () => {
    try {
      const { avatars } = await api.listAvatars();
      setAvatars(avatars);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createNew = async () => {
    try {
      const { avatar } = await api.createAvatar('我的数字人');
      navigate(`/editor/${avatar.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '创建失败', 'error');
    }
  };

  const duplicate = async (id: string) => {
    try {
      await api.duplicateAvatar(id);
      toast('已复制');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '复制失败', 'error');
    }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`确定删除「${name}」吗？此操作不可恢复。`)) return;
    try {
      await api.deleteAvatar(id);
      toast('已删除');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '删除失败', 'error');
    }
  };

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main">
        <div className="page-head-row">
          <div>
            {workspaceConfig && (
              <Link className="workspace-back-link" to="/">
                ← 返回工作区首页
              </Link>
            )}
            <h1 className="page-title">{workspaceConfig?.title ?? '我的数字人'}</h1>
            <p className="page-subtitle">
              {workspaceConfig?.subtitle ?? '管理你创建的所有数字人，随时继续编辑或驱动。'}
            </p>
          </div>
          <button className="btn btn-primary" onClick={createNew}>
            + 新建数字人
          </button>
        </div>
        {workspaceConfig && (
          <div className="workflow-step-banner">
            <span className="workflow-step-number">步骤 1 / 3</span>
            <div>
              <strong>先选择一个数字人</strong>
              <p>后续页面会自动带入这个人物，不需要重复选择。</p>
            </div>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        {!avatars && !error && <SkeletonGrid />}
        {avatars && avatars.length === 0 && (
          <EmptyState text="还没有数字人，从创建向导开始吧。">
            <Link className="btn btn-primary" to="/create">
              去创建
            </Link>
          </EmptyState>
        )}
        {avatars && avatars.length > 0 && (
          <div className="avatar-grid">
            {avatars.map((a) => (
              <div key={a.id} className="avatar-card">
                <div className="avatar-card-cover-wrap">
                  <Cover url={a.coverUrl} alt={a.name} />
                  <div className="avatar-card-overlay">
                    {workspaceConfig ? (
                      <Link className="btn btn-primary workspace-enter-btn" to={workspaceConfig.path(a.id)}>
                        {workspaceConfig.action} →
                      </Link>
                    ) : (
                      <>
                        <Link className="btn btn-sm btn-primary" to={`/editor/${a.id}`}>
                          装扮
                        </Link>
                        <Link className="btn btn-sm" to={`/motion/${a.id}`}>
                          直播
                        </Link>
                        <Link className="btn btn-sm" to={`/video/${a.id}`}>
                          视频
                        </Link>
                        <button className="btn btn-sm" onClick={() => void duplicate(a.id)}>
                          复制
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => void remove(a.id, a.name)}>
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="avatar-card-body">
                  <h3>{a.name}</h3>
                  <p className="muted">
                    v{a.version} · 更新于 {new Date(a.updatedAt).toLocaleString('zh-CN')}
                  </p>
                </div>
              </div>
            ))}
            <button className="avatar-card-new" onClick={createNew}>
              <span className="plus">+</span>
              新建数字人
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
