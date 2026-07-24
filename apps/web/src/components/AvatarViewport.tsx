import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AvatarSceneController } from '../three/AvatarSceneController';

/**
 * 三维视窗：挂载 AvatarSceneController，支持加载/错误覆盖层。
 */
export function AvatarViewport(props: {
  onInit: (controller: AvatarSceneController) => void;
  overlay?: ReactNode;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AvatarSceneController(hostRef.current!);
    controller.onStateChange = () => setLoading(controller.loading);
    controller.init();
    props.onInit(controller);
    setReady(true);
    return () => controller.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`viewport ${props.className ?? ''}`} ref={hostRef}>
      {loading && (
        <div className="viewport-overlay">
          <div className="spinner" />
          <p>加载中…</p>
        </div>
      )}
      {ready && props.overlay}
    </div>
  );
}
