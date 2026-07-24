import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { ApiError } from '../api/client';

/** 登录 / 注册页：左侧品牌区 + 右侧表单卡片。 */
export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@dhp.local');
  const [password, setPassword] = useState('demo123456');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, displayName || undefined);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-split">
        <aside className="auth-brand">
          <span className="brand-mark">浪</span>
          <h1>造浪数字人平台</h1>
          <p className="auth-tagline">在浏览器里创造、装扮并驱动你的 3D 数字人</p>
          <ul className="auth-points">
            <li>参数化捏人，程序化换装</li>
            <li>VRM / GLB 模型导入与兼容分级</li>
            <li>摄像头姿态驱动，完全本地运行</li>
          </ul>
        </aside>
        <div className="auth-form-side">
          <form className="auth-card" onSubmit={submit}>
            <h1>{mode === 'login' ? '欢迎回来' : '创建账号'}</h1>
            <p className="auth-sub">
              {mode === 'login' ? '登录以继续你的创作' : '注册一个全新的创作账号'}
            </p>
            <div className="auth-tabs">
              <button
                type="button"
                className={mode === 'login' ? 'active' : ''}
                onClick={() => setMode('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'active' : ''}
                onClick={() => setMode('register')}
              >
                注册
              </button>
            </div>

            <label>
              邮箱
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            {mode === 'register' && (
              <label>
                昵称（可选）
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="展示名称"
                />
              </label>
            )}
            <label>
              密码
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
              />
            </label>

            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
            </button>
            <p className="auth-hint">演示账号：demo@dhp.local / demo123456</p>
          </form>
        </div>
      </div>
    </div>
  );
}
