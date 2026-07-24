import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isAdminRole, useAuthStore } from '../stores/authStore';

/** 顶栏导航：品牌、主导航（含"我的数字人"常驻入口）、用户信息。 */
export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const workspace = new URLSearchParams(location.search).get('workspace');
  const isWorkspaceActive = (kind: 'style' | 'studio' | 'video') => {
    if (kind === 'style') {
      return location.pathname.startsWith('/editor/') || (location.pathname === '/avatars' && workspace === 'style');
    }
    if (kind === 'studio') {
      return location.pathname.startsWith('/motion/') || (location.pathname === '/avatars' && workspace === 'studio');
    }
    return location.pathname.startsWith('/video/') || (location.pathname === '/avatars' && workspace === 'video');
  };

  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">浪</span>
        <span className="brand-label">造浪数字人平台</span>
      </Link>
      <nav className="app-nav">
        <Link className={location.pathname === '/' ? 'active' : ''} to="/">
          首页
        </Link>
        <Link className={isWorkspaceActive('style') ? 'active' : ''} to="/avatars?workspace=style">
          人物装扮
        </Link>
        <Link className={isWorkspaceActive('studio') ? 'active' : ''} to="/avatars?workspace=studio">
          虚拟直播间
        </Link>
        <Link className={isWorkspaceActive('video') ? 'active' : ''} to="/avatars?workspace=video">
          视频复现
        </Link>
        <Link
          className={location.pathname === '/avatars' && !workspace ? 'active' : ''}
          to="/avatars"
        >
          人物管理
        </Link>
        {isAdminRole(user) && (
          <Link className={location.pathname === '/admin' ? 'active' : ''} to="/admin">
            管理后台
          </Link>
        )}
      </nav>
      <div className="app-user">
        <span className="user-name">{user?.displayName ?? user?.email}</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          退出登录
        </button>
      </div>
    </header>
  );
}
