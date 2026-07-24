import { Link, useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { useAuthStore } from '../stores/authStore';

const FEATURES = [
  {
    icon: '人',
    title: '参数捏人',
    desc: '脸型、体型、肤色全参数化调节，实时预览，随时撤销重做。',
  },
  {
    icon: '衣',
    title: '智能换装',
    desc: '槽位与层级驱动的程序化穿搭，自动处理冲突与防穿透。',
  },
  {
    icon: '模',
    title: '模型导入',
    desc: '支持 VRM / GLB，骨架兼容性自动校验并分级开放能力。',
  },
  {
    icon: '动',
    title: '摄像头驱动',
    desc: '姿态识别完全在浏览器本地运行，视频与关键点不上传。',
  },
];

/** 首页：产品定位、主 CTA、特性矩阵、公开示例占位。 */
export function HomePage() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);

  /** "我的数字人"入口：已登录进列表，未登录去登录页。 */
  const goMyAvatars = () => navigate(token ? '/avatars' : '/login');

  return (
    <div className="page">
      <AppHeader />
      <main className="page-main">
        <section className="hero">
          <p className="hero-eyebrow">自主可控 · 模块化数字人平台</p>
          <h1>创造属于你的数字人</h1>
          <p>
            基于统一 StandardRig 骨架规范的网页三维创作台：手动捏人、程序化换装、
            外部 VRM/GLB 导入，以及完全在浏览器本地运行的摄像头姿态驱动。
          </p>
          <div className="hero-cta">
            <Link to="/create" className="btn btn-primary btn-lg">
              开始创作
            </Link>
            <button className="btn btn-secondary btn-lg" onClick={goMyAvatars}>
              我的数字人
            </button>
          </div>
        </section>

        <section>
          <h2 className="section-title">平台能力</h2>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature-card">
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="section-title">公开示例</h2>
          <div className="example-grid">
            {[1, 2, 3].map((i) => (
              <div key={i} className="example-card placeholder">
                <div className="example-thumb">?</div>
                <p>公开示例位（后续版本开放分享）</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <footer className="site-footer">© 2026 造浪数字人平台 · 自主可控模块化数字人平台 V1</footer>
    </div>
  );
}
