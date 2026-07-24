import { Link } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';

const WORKSPACES = [
  {
    key: 'style',
    index: '01',
    icon: '衣',
    title: '人物装扮',
    subtitle: '创建与编辑数字人',
    description: '专注完成脸型、体型、肤色、发型与服装搭配，实时查看三维效果。',
    steps: ['选择人物', '调整外观', '保存造型'],
    to: '/avatars?workspace=style',
    action: '进入人物装扮',
  },
  {
    key: 'studio',
    index: '02',
    icon: '播',
    title: '虚拟直播间',
    subtitle: '布景、机位与实时驱动',
    description: '导入三维房间，自由摆放人物和相机，再通过摄像头进行身体、手部与面部驱动。',
    steps: ['选择人物', '布置直播间', '开始实时驱动'],
    to: '/avatars?workspace=studio',
    action: '进入虚拟直播间',
  },
  {
    key: 'video',
    index: '03',
    icon: '影',
    title: '真人视频复现',
    subtitle: '导入舞蹈并导出数字人视频',
    description: '在独立工作区导入真人全身视频，本地识别动作并导出数字人 WebM。',
    steps: ['选择人物', '导入真人视频', '预览并导出'],
    to: '/avatars?workspace=video',
    action: '进入视频复现',
  },
] as const;

/** 首页：三个相互独立的一级工作流入口。 */
export function HomePage() {
  return (
    <div className="page">
      <AppHeader />
      <main className="page-main home-main">
        <section className="hero workspace-hero">
          <p className="hero-eyebrow">数字人创作工作台</p>
          <h1>今天想完成什么？</h1>
          <p>
            三个工作区各自聚焦一项任务。先选择目标，再选择要使用的数字人，
            页面只展示当前任务需要的工具。
          </p>
          <div className="hero-cta">
            <Link to="/create" className="btn btn-primary btn-lg">
              + 创建新数字人
            </Link>
            <Link to="/avatars" className="btn btn-secondary btn-lg">
              查看全部人物
            </Link>
          </div>
        </section>

        <section aria-labelledby="workspace-title">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">WORKSPACES</p>
              <h2 id="workspace-title" className="section-title">
                选择工作区
              </h2>
            </div>
            <p className="muted">每个工作区都可以随时从顶部导航切换。</p>
          </div>
          <div className="workspace-grid">
            {WORKSPACES.map((workspace) => (
              <Link
                key={workspace.key}
                className={`workspace-card workspace-card-${workspace.key}`}
                to={workspace.to}
              >
                <div className="workspace-card-topline">
                  <span className="workspace-index">{workspace.index}</span>
                  <span className="workspace-icon">{workspace.icon}</span>
                </div>
                <p className="workspace-subtitle">{workspace.subtitle}</p>
                <h3>{workspace.title}</h3>
                <p className="workspace-description">{workspace.description}</p>
                <ol className="workspace-steps">
                  {workspace.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <span className="workspace-action">
                  {workspace.action} <span aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="home-privacy-note">
          <div className="feature-icon">隐</div>
          <div>
            <h3>视觉数据默认留在本机</h3>
            <p>
              摄像头、真人视频与人体关键点由浏览器本地 MediaPipe 处理；
              房间和导出视频也不会自动上传。
            </p>
          </div>
        </section>
      </main>
      <footer className="site-footer">© 2026 造浪数字人平台 · 自主可控模块化数字人平台</footer>
    </div>
  );
}
