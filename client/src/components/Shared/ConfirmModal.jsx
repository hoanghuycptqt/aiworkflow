import Icon from '../../services/icons.jsx';

/**
 * Reusable confirmation modal.
 * @param {string} title - Modal heading
 * @param {string} message - Description text
 * @param {string} confirmLabel - Confirm button text (default: "Delete")
 * @param {string} variant - "danger" | "warning" | "default"
 * @param {Function} onConfirm - Called when user confirms
 * @param {Function} onCancel - Called when user cancels (or clicks overlay)
 */
export default function ConfirmModal({
    title = 'Are you sure?',
    message,
    confirmLabel = 'Delete',
    variant = 'danger',
    onConfirm,
    onCancel,
}) {
    const iconName = variant === 'danger' ? 'trash' : variant === 'warning' ? 'alert-triangle' : 'help-circle';
    const iconColor = variant === 'danger' ? '#ef4444' : variant === 'warning' ? '#f59e0b' : 'var(--accent-primary)';
    const btnStyle =
        variant === 'danger'
            ? { background: '#ef4444', color: '#fff', border: 'none' }
            : variant === 'warning'
              ? { background: '#f59e0b', color: '#000', border: 'none' }
              : {};

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: 380, textAlign: 'center', padding: '28px 32px' }}
            >
                <div style={{ marginBottom: 16 }}>
                    <Icon name={iconName} size={36} color={iconColor} />
                </div>
                <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--text-primary)' }}>{title}</h3>
                {message && (
                    <p style={{ margin: '0 0 24px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {message}
                    </p>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="btn" onClick={onCancel} style={{ padding: '8px 24px', fontSize: 13 }}>
                        Cancel
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={onConfirm}
                        style={{ padding: '8px 24px', fontSize: 13, ...btnStyle }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
