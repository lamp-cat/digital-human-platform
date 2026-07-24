import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { api, ApiError } from '../api/client';
import type { OpenAvatarEntry } from '../api/types';

/** 创建向导：手动捏人 / 导入外部模型。 */
export function CreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<OpenAvatarEntry[] | null>(null);
  const workspace = searchParams.get('workspace');
  const targetPath = (id: string) => {
    if (workspace === 'studio') return `/motion/${id}`;
    if (workspace === 'video') return `/video/${id}`;
    return `/editor/${id}`;
  };

  useEffect(() => {
    api.listOpenAvatars()
      .then(({ avatars }) => setCatalog(avatars))
      .catch((err) => setError(err instanceof ApiError ? err.message : '开源人物库加载失败'));
  }, []);

  const groupedCatalog = useMemo(() => {
    const order = ['拟真人物', '卡通人物', 'VTuber / 动漫', '二头身动物'];
    const groups = new Map<string, OpenAvatarEntry[]>();
    for (const item of catalog ?? []) {
      const items = groups.get(item.category) ?? [];
      items.push(item);
      groups.set(item.category, items);
    }
    return [...groups.entries()].sort(
      ([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)),
    );
  }, [catalog]);

  const createManual = async () => {
    setBusyId('built-in');
    setError('');
    try {
      const { avatar } = await api.createAvatar('我的数字人');
      navigate(targetPath(avatar.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
      setBusyId(null);
    }
  };

  const createFromCatalog = async (item: OpenAvatarEntry) => {
    setBusyId(item.id);
    setError('');
    try {
      const { avatar } = await api.createAvatar(item.displayName, item.id);
      navigate(targetPath(avatar.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main">
        <h1 className="page-title">创建数字人</h1>
        <p className="page-subtitle">从开源人物库直接使用，或选择手动捏人和外部导入。</p>
        {error && <p className="form-error">{error}</p>}

        <section className="creation-methods">
          <button className="path-card as-button compact" onClick={createManual} disabled={busyId !== null}>
            <h2>手动捏人</h2>
            <p>
              使用内置标准底模（StandardRig · T-Pose · 1.70m），通过脸型、体型、肤色参数
              与程序化衣物自由创作，支持撤销/重做与版本化保存。
            </p>
            <span className="path-card-cta">{busyId === 'built-in' ? '创建中…' : '立即创建 →'}</span>
          </button>
          <Link to="/import" className="path-card compact">
            <h2>导入外部 VRM / GLB</h2>
            <p>
              导入你自己拥有合法使用权的 3D 人物模型，平台将校验骨架兼容性并分级开放能力
              （FULL 可换装 / POSE_ONLY 仅动作）。
            </p>
            <span className="path-card-cta">进入导入向导 →</span>
          </Link>
        </section>

        <section className="open-avatar-library">
          <div className="section-head-row">
            <div>
              <h2>开源人物库</h2>
              <p className="muted">已核验来源和许可证；创建后可直接进入动作、直播与视频复现。</p>
            </div>
            <span className="badge badge-compat-full">{catalog?.length ?? 0} 个可用角色</span>
          </div>
          {!catalog && !error && <p className="muted">正在加载人物库…</p>}
          {groupedCatalog.map(([category, items]) => (
            <div className="catalog-category" key={category}>
              <h3>{category}</h3>
              <div className="catalog-avatar-grid">
                {items.map((item) => (
                  <article className="catalog-avatar-card" key={item.id}>
                    <div className="catalog-avatar-image-wrap">
                      <img src={item.thumbnailUrl} alt={item.displayName} loading="lazy" />
                      <span className="catalog-license">{item.licenseId}</span>
                    </div>
                    <div className="catalog-avatar-body">
                      <div>
                        <h4>{item.displayName}</h4>
                        <p>{item.description}</p>
                      </div>
                      <div className="catalog-capabilities">
                        {item.capabilities.map((capability) => (
                          <span key={capability}>{capability}</span>
                        ))}
                      </div>
                      <div className="catalog-avatar-footer">
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                          {item.creator} · 查看来源
                        </a>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={busyId !== null}
                          onClick={() => void createFromCatalog(item)}
                        >
                          {busyId === item.id ? '创建中…' : '使用这个角色'}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
