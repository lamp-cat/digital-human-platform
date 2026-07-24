import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ToastHost } from './components/controls';
import { isAdminRole, useAuthStore } from './stores/authStore';
import { AdminPage } from './pages/AdminPage';
import { AvatarsPage } from './pages/AvatarsPage';
import { CoverShotPage } from './pages/CoverShotPage';
import { CreatePage } from './pages/CreatePage';
import { EditorPage } from './pages/EditorPage';
import { HomePage } from './pages/HomePage';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { MotionPage } from './pages/MotionPage';
import { PoseLabPage } from './pages/PoseLabPage';

/** 未登录跳转 /login。 */
function RequireAuth({ children }: { children: React.ReactElement }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

/** 仅管理员可见。 */
function RequireAdmin({ children }: { children: React.ReactElement }) {
  const user = useAuthStore((s) => s.user);
  if (!isAdminRole(user)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const loadMe = useAuthStore((s) => s.loadMe);
  useEffect(() => {
    void loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 隐藏调试路由（不进主导航、无需登录）：动作映射视频分析 */}
        <Route path="/pose-lab" element={<PoseLabPage />} />
        {/* 隐藏路由（不进主导航）：数字人正面封面拍摄，供 regenerate-covers 脚本使用 */}
        <Route path="/cover-shot/:id" element={<CoverShotPage />} />
        <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
        <Route path="/create" element={<RequireAuth><CreatePage /></RequireAuth>} />
        <Route path="/import" element={<RequireAuth><ImportPage /></RequireAuth>} />
        <Route path="/editor/:id" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/avatars" element={<RequireAuth><AvatarsPage /></RequireAuth>} />
        <Route path="/motion/:id" element={<RequireAuth><MotionPage /></RequireAuth>} />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </BrowserRouter>
  );
}
