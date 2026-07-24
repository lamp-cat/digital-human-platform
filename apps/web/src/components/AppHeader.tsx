import { Link, NavLink, useNavigate } from 'react-router-dom';
import { isAdminRole, useAuthStore } from '../stores/authStore';

/** 顶栏导航：品牌、主导航（含"我的数字人"常驻入口）、用户信息。 */
export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">浪</span>
        造浪数字人平台
      </Link>
      <nav className="app-nav">
        <NavLink to="/" end>
          首页
        </NavLink>
        <NavLink to="/avatars">我的数字人</NavLink>
        <NavLink to="/create">创建</NavLink>
        {isAdminRole(user) && <NavLink to="/admin">管理后台</NavLink>}
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
