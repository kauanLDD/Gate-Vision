export default function Modal({ open, title, onClose, children }) {
  if (!open) return null;

  return (
    <div className="modal-shell">
      <div className="modal-backdrop" onClick={onClose} role="presentation" />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div className="modal-head">
          <strong id="modalTitle">{title}</strong>
          <button className="btn modal-close-btn" onClick={onClose} type="button" aria-label="Fechar">
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
