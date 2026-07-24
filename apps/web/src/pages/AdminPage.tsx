import { useCallback, useEffect, useRef, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { Badge } from '../components/controls';
import { api, ApiError } from '../api/client';
import type { AssetEntry, Job } from '../api/types';
import { useUiStore } from '../stores/uiStore';

const TYPE_OPTIONS = ['', 'garment', 'hair', 'accessory', 'shoes', 'base_avatar', 'animation'];
const STATUS_OPTIONS = ['', 'draft', 'published', 'archived'];

/** 管理后台：资产列表 / 发布下架 / manifest 校验任务。 */
export function AdminPage() {
  const toast = useUiStore((s) => s.toast);
  const [assets, setAssets] = useState<AssetEntry[] | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [manifestText, setManifestText] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const { assets } = await api.adminListAssets();
      setAssets(assets);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '资产列表加载失败', 'error');
      setAssets([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const publish = async (id: string) => {
    try {
      await api.adminPublishAsset(id);
      toast(`已发布 ${id}`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '发布失败', 'error');
    }
  };

  const archive = async (id: string) => {
    try {
      await api.adminArchiveAsset(id);
      toast(`已下架 ${id}`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '下架失败', 'error');
    }
  };

  const pollJob = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { job: j } = await api.getJob(jobId);
        setJob(j);
        if (j.status === 'succeeded' || j.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (j.status === 'succeeded') void load();
        }
      } catch {
        // 轮询失败忽略，等待下一次
      }
    }, 1200);
  };

  const submitManifest = () => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      toast('manifest JSON 解析失败', 'error');
      return;
    }
    setSubmitting(true);
    api
      .adminImportAsset(manifest)
      .then(({ job: j }) => {
        setJob(j);
        pollJob(j.id);
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : '提交失败', 'error'))
      .finally(() => setSubmitting(false));
  };

  const filtered = (assets ?? []).filter(
    (a) => (!typeFilter || a.type === typeFilter) && (!statusFilter || a.status === statusFilter),
  );

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main wide">
        <div className="page-head-row">
          <div>
            <h1 className="page-title">管理后台</h1>
            <p className="page-subtitle">资产审核、发布与下架管理。</p>
          </div>
        </div>

        <section className="admin-section">
          <div className="page-head-row">
            <h2>资产列表</h2>
            <div className="filters">
              <div className="seg">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s || 'all'}
                    className={`seg-btn ${statusFilter === s ? 'active' : ''}`}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s === '' ? '全部状态' : s}
                  </button>
                ))}
              </div>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">全部类型</option>
                {TYPE_OPTIONS.filter(Boolean).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!assets && <p className="muted">加载中…</p>}
          {assets && (
            <table className="report-table admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <code>{a.id}</code>
                    </td>
                    <td>{a.displayName}</td>
                    <td>{a.type}</td>
                    <td>
                      <Badge
                        kind={
                          a.status === 'published'
                            ? 'success'
                            : a.status === 'archived'
                              ? 'error'
                              : 'info'
                        }
                      >
                        {a.status}
                      </Badge>
                    </td>
                    <td className="admin-actions">
                      {a.status !== 'published' && (
                        <button className="btn btn-xs btn-primary" onClick={() => void publish(a.id)}>
                          发布
                        </button>
                      )}
                      {a.status === 'published' && (
                        <button className="btn btn-xs btn-danger" onClick={() => void archive(a.id)}>
                          下架
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      无匹配资产
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>

        <section className="admin-section">
          <h2>提交 manifest 校验任务</h2>
          <textarea
            className="manifest-input"
            rows={10}
            placeholder='粘贴 GarmentManifest JSON，例如 {"id":"top-tee-02", ...}'
            value={manifestText}
            onChange={(e) => setManifestText(e.target.value)}
          />
          <div className="wizard-actions">
            <button
              className="btn btn-primary"
              disabled={submitting || !manifestText.trim()}
              onClick={submitManifest}
            >
              提交校验
            </button>
          </div>
          {job && (
            <div className="job-status">
              <p>
                任务 <code>{job.id}</code>：{job.status}（{Math.round((job.progress ?? 0) * 100)}%）
              </p>
              {job.status === 'failed' && <p className="form-error">失败原因：{job.errorCode ?? '未知'}</p>}
              {job.status === 'succeeded' && (
                <pre className="job-result">{JSON.stringify(job.resultJson ?? {}, null, 2)}</pre>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
