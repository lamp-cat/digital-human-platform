import type { ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

/** 通用小组件：滑杆行 / 色板 / 徽标 / 弹窗 / 提示。 */

export function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue: number;
  onChange: (v: number) => void;
  onReset: () => void;
  format?: (v: number) => string;
}) {
  const fmt = props.format ?? ((v: number) => v.toFixed(2));
  return (
    <div className="slider-row">
      <div className="slider-row-head">
        <span className="slider-label">{props.label}</span>
        <span className="slider-value">{fmt(props.value)}</span>
        <button
          className="btn btn-ghost btn-xs"
          title={`恢复默认（${fmt(props.defaultValue)}）`}
          onClick={props.onReset}
        >
          恢复默认
        </button>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function SwatchGroup(props: {
  label: string;
  items: readonly { id: string; label: string; color: string }[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="swatch-group">
      <div className="param-group-label">{props.label}</div>
      <div className="swatch-list">
        {props.items.map((item) => (
          <button
            key={item.id}
            className={`swatch ${item.id === props.activeId ? 'active' : ''}`}
            style={{ backgroundColor: item.color }}
            title={item.label}
            onClick={() => props.onSelect(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function Badge(props: { kind: 'success' | 'warning' | 'error' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${props.kind}`}>{props.children}</span>;
}

export function Modal(props: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h3>{props.title}</h3>
          {props.onClose && (
            <button className="btn btn-ghost btn-xs" onClick={props.onClose}>
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function EmptyState(props: { text: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p>{props.text}</p>
      {props.children}
    </div>
  );
}
