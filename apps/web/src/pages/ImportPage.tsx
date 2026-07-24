import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IMPORT_LIMITS } from '@dhp/avatar-schema';
import { createDefaultProfile } from '@dhp/avatar-schema';
import { api, ApiError, fetchAuthedObjectUrl, uploadImport } from '../api/client';
import type { ImportRecord, ImportReport } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { AvatarViewport } from '../components/AvatarViewport';
import { useTaskStore } from '../stores/taskStore';
import { useUiStore } from '../stores/uiStore';
import type { AvatarSceneController } from '../three/AvatarSceneController';

type Step = 'select' | 'rights' | 'upload' | 'validate' | 'report' | 'preview';

const STEP_TITLES: Record<Step, string> = {
  select: '1. 选择文件',
  rights: '2. 权属确认',
  upload: '3. 上传',
  validate: '4. 校验',
  report: '5. 校验报告',
  preview: '6. 预览与激活',
};
const STEP_ORDER = Object.keys(STEP_TITLES) as Step[];

/** 报告检查项状态 → 图标/样式（兼容 pass/passed、warn/warning、fail/failed）。 */
const CHECK_STATUS_META: Record<string, { cls: string; icon: string; label: string }> = {
  pass: { cls: 'pass', icon: '✓', label: '通过' },
  passed: { cls: 'pass', icon: '✓', label: '通过' },
  warn: { cls: 'warn', icon: '⚠', label: '警告' },
  warning: { cls: 'warn', icon: '⚠', label: '警告' },
  fail: { cls: 'fail', icon: '✕', label: '未通过' },
  failed: { cls: 'fail', icon: '✕', label: '未通过' },
};

function checkStatusMeta(status: string) {
  return CHECK_STATUS_META[status] ?? { cls: 'warn', icon: '•', label: status };
}

/** 导入向导（文档 §8.6 六步）。 */
export function ImportPage() {
  const navigate = useNavigate();
  const toast = useUiStore((s) => s.toast);
  const task = useTaskStore();

  const [step, setStep] = useState<Step>('select');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [activating, setActivating] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<AvatarSceneController | null>(null);

  const importRecord = task.importRecord;
  const job = task.job;

  // 校验阶段：轮询任务直至终态，然后取报告
  useEffect(() => {
    if (step !== 'validate' || !job) return;
    if (job.status === 'succeeded') {
      void (async () => {
        try {
          const [{ importRecord: rec }, { report: rep }] = await Promise.all([
            api.getImport(task.importId!),
            api.getImportReport(task.importId!),
          ]);
          task.setImportRecord(rec);
          setReport(rep);
          setName(rec.displayName || '导入人物');
          setStep('report');
        } catch (err) {
          setError(err instanceof ApiError ? err.message : '获取校验报告失败');
        }
      })();
    } else if (job.status === 'failed') {
      // 校验任务失败也可能已生成报告
      void (async () => {
        try {
          const [{ importRecord: rec }, { report: rep }] = await Promise.all([
            api.getImport(task.importId!),
            api.getImportReport(task.importId!),
          ]);
          task.setImportRecord(rec);
          setReport(rep);
          setStep('report');
        } catch {
          setError(`校验失败：${job.errorCode ?? '未知错误'}`);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, job?.status]);

  // 离开向导时停止轮询
  useEffect(() => () => useTaskStore.getState().stopPolling(), []);

  // ---------- 步骤 1：文件选择 ----------
  const pickFile = (f: File | null) => {
    setFileError('');
    if (!f) {
      setFile(null);
      return;
    }
    const lower = f.name.toLowerCase();
    const extOk = IMPORT_LIMITS.allowedExtensions.some((ext) => lower.endsWith(ext));
    if (!extOk) {
      setFile(null);
      setFileError('仅支持 .vrm / .glb 格式（FBX/OBJ 等请先在 Blender 转换）');
      return;
    }
    if (f.size > IMPORT_LIMITS.maxBytes) {
      setFile(null);
      setFileError(`文件超过 ${IMPORT_LIMITS.maxBytes / 1024 / 1024}MB 上限`);
      return;
    }
    setFile(f);
  };

  // ---------- 步骤 3：上传 ----------
  const startUpload = () => {
    if (!file) return;
    setStep('upload');
    setError('');
    const { promise, cancel } = uploadImport(file, rightsConfirmed, (r) => task.setUploadProgress(r));
    cancelUploadRef.current = cancel;
    promise
      .then(({ importRecord: rec, job: j }) => {
        task.beginImport(rec, j);
        setStep('validate');
        task.pollJob(j.id);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.message === '上传已取消') {
          setStep('rights');
          return;
        }
        setError(err instanceof ApiError ? err.message : '上传失败');
        setStep('rights');
      });
  };

  // ---------- 步骤 6：预览 ----------
  const loadPreview = useCallback(
    async (controller: AvatarSceneController, rec: ImportRecord) => {
      const modelUrl = rec.modelUrl ?? `/api/v1/imports/${rec.id}/model`;
      const objectUrl = await fetchAuthedObjectUrl(modelUrl);
      const profile = createDefaultProfile(`imported:${rec.id}`);
      const ok = await controller.loadAvatar({
        profile,
        knownGarments: new Map(),
        importedModelUrl: objectUrl,
      });
      if (!ok) throw new Error('模型加载失败');
      controller.pkg?.playAnimation('idle-01');
      setPreviewReady(true);
    },
    [],
  );

  const activate = async () => {
    if (!importRecord || !name.trim()) return;
    setActivating(true);
    try {
      const { avatar } = await api.activateImport(importRecord.id, name.trim());
      task.reset();
      navigate(`/editor/${avatar.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '激活失败', 'error');
      setActivating(false);
    }
  };

  const restart = () => {
    task.reset();
    setFile(null);
    setRightsConfirmed(false);
    setReport(null);
    setError('');
    setStep('select');
  };

  const compatibility = importRecord?.compatibility ?? report?.compatibility ?? null;

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main narrow">
        <h1 className="page-title">导入外部 3D 人物</h1>
        <div className="step-indicator">
          {STEP_ORDER.map((s) => {
            const state =
              s === step ? 'active' : STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(step) ? 'done' : '';
            return (
              <span key={s} className={`step-dot ${state}`}>
                {state === 'done' ? '✓ ' : ''}
                {STEP_TITLES[s]}
              </span>
            );
          })}
        </div>
        {error && <p className="form-error">{error}</p>}

        {step === 'select' && (
          <section className="wizard-card">
            <h2>选择模型文件</h2>
            <ul className="rule-list">
              <li>仅支持 VRM 1.0（.vrm）与 glTF 2.0 Binary（.glb），单文件 ≤ 100MB。</li>
              <li>模型需包含完整人形骨架；平台按 StandardRig（22 根骨骼）校验兼容等级。</li>
              <li>FULL：可换装 + 动作；POSE_ONLY：仅动作；REJECTED：不可创建。</li>
            </ul>
            <input
              type="file"
              accept=".vrm,.glb"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {fileError && <p className="form-error">{fileError}</p>}
            {file && (
              <p className="muted">
                已选择：{file.name}（{(file.size / 1024 / 1024).toFixed(1)}MB）
              </p>
            )}
            <div className="wizard-actions">
              <button className="btn btn-primary" disabled={!file} onClick={() => setStep('rights')}>
                下一步
              </button>
            </div>
          </section>
        )}

        {step === 'rights' && (
          <section className="wizard-card">
            <h2>权属确认</h2>
            <p>
              请确认你拥有该模型文件、贴图及其中角色形象的合法使用权。
              导入文件仅作为你的私有资产，不会公开分发。
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={rightsConfirmed}
                onChange={(e) => setRightsConfirmed(e.target.checked)}
              />
              我确认拥有该模型及其角色形象的合法使用权
            </label>
            <div className="wizard-actions">
              <button className="btn" onClick={() => setStep('select')}>
                上一步
              </button>
              <button className="btn btn-primary" disabled={!rightsConfirmed} onClick={startUpload}>
                确认并上传
              </button>
            </div>
          </section>
        )}

        {step === 'upload' && (
          <section className="wizard-card">
            <h2>上传中</h2>
            <p className="muted">{file?.name}</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${task.uploadProgress * 100}%` }} />
            </div>
            <p>{Math.round(task.uploadProgress * 100)}%</p>
            <div className="wizard-actions">
              <button
                className="btn btn-danger"
                onClick={() => {
                  cancelUploadRef.current?.();
                  setStep('rights');
                }}
              >
                取消上传
              </button>
            </div>
          </section>
        )}

        {step === 'validate' && (
          <section className="wizard-card">
            <h2>校验中</h2>
            <p className="muted">正在解析模型、校验骨架与蒙皮…</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${(job?.progress ?? 0) * 100}%` }} />
            </div>
            <p className="muted">任务状态：{job?.status ?? '排队中'}</p>
          </section>
        )}

        {step === 'report' && (
          <section className="wizard-card">
            <h2>校验报告</h2>
            <p style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {compatibility === 'FULL' && (
                <span className="compat-hero compat-full">FULL · 可换装</span>
              )}
              {compatibility === 'POSE_ONLY' && (
                <span className="compat-hero compat-pose">POSE_ONLY · 仅动作</span>
              )}
              {(compatibility === 'REJECTED' || !compatibility) && (
                <span className="compat-hero compat-rejected">REJECTED · 不可创建</span>
              )}
            </p>
            {compatibility === 'POSE_ONLY' && (
              <p className="muted">该模型可动作控制，不支持 V1 通用换装。</p>
            )}
            {report?.errorCode && <p className="form-error">错误码：{report.errorCode}</p>}
            {report?.suggestions && report.suggestions.length > 0 && (
              <div>
                <h3>修复建议</h3>
                <ul className="rule-list">
                  {report.suggestions.slice(0, 3).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {report?.checks && report.checks.length > 0 && (
              <table className="report-table">
                <thead>
                  <tr>
                    <th style={{ width: '22%' }}>检查项</th>
                    <th style={{ width: '14%' }}>结果</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {report.checks.map((c, i) => {
                    const meta = checkStatusMeta(c.status);
                    return (
                      <tr key={i}>
                        <td>{c.name ?? c.key ?? `检查 ${i + 1}`}</td>
                        <td>
                          <span className={`report-status ${meta.cls}`}>
                            {meta.icon} {meta.label}
                          </span>
                        </td>
                        <td>
                          {c.message ?? '—'}
                          {c.suggestion && <div className="muted">建议：{c.suggestion}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="wizard-actions">
              <button className="btn" onClick={restart}>
                重新导入
              </button>
              {compatibility !== 'REJECTED' && compatibility && (
                <button className="btn btn-primary" onClick={() => setStep('preview')}>
                  下一步：预览
                </button>
              )}
            </div>
          </section>
        )}

        {step === 'preview' && importRecord && (
          <section className="wizard-card">
            <h2>预览与激活</h2>
            {compatibility === 'POSE_ONLY' && (
              <p className="compat-notice">该模型为 POSE_ONLY：可动作控制，不支持 V1 通用换装。</p>
            )}
            <div className="preview-viewport">
              <AvatarViewport
                onInit={(controller) => {
                  controllerRef.current = controller;
                  loadPreview(controller, importRecord).catch((err) =>
                    setError(err instanceof Error ? err.message : '预览加载失败'),
                  );
                }}
              />
            </div>
            <label className="name-row">
              名称
              <input
                type="text"
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                placeholder="给数字人起个名字"
              />
            </label>
            <div className="wizard-actions">
              <button className="btn" onClick={() => setStep('report')}>
                上一步
              </button>
              <button
                className="btn btn-primary"
                disabled={!previewReady || !name.trim() || activating}
                onClick={() => void activate()}
              >
                {activating ? '创建中…' : '创建为我的数字人'}
              </button>
            </div>
          </section>
        )}

        <p className="muted">
          也可以回到 <Link to="/create">创建向导</Link> 选择其他方式。
        </p>
      </main>
    </div>
  );
}
