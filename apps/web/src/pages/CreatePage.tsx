import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { api, ApiError } from '../api/client';

/** 创建向导：手动捏人 / 导入外部模型。 */
export function CreatePage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const createManual = async () => {
    setBusy(true);
    setError('');
    try {
      const { avatar } = await api.createAvatar('我的数字人');
      navigate(`/editor/${avatar.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main narrow">
        <h1 className="page-title">创建数字人</h1>
        <p className="page-subtitle">选择一种创建方式开始。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="path-cards">
          <button className="path-card as-button" onClick={createManual} disabled={busy}>
            <h2>手动捏人</h2>
            <p>
              使用内置标准底模（StandardRig · T-Pose · 1.70m），通过脸型、体型、肤色参数
              与程序化衣物自由创作，支持撤销/重做与版本化保存。
            </p>
            <span className="path-card-cta">{busy ? '创建中…' : '立即创建 →'}</span>
          </button>
          <Link to="/import" className="path-card">
            <h2>导入外部 VRM / GLB</h2>
            <p>
              导入你自己拥有合法使用权的 3D 人物模型，平台将校验骨架兼容性并分级开放能力
              （FULL 可换装 / POSE_ONLY 仅动作）。
            </p>
            <span className="path-card-cta">进入导入向导 →</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
