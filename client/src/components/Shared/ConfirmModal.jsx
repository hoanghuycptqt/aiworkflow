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
    const iconName =
        variant === 'danger' ? 'alert-triangle' :
        variant === 'warning' ? 'alert-triangle' :
        'help-circle';

    const circleClass =
        variant === 'danger' ? 'auth-state-circle--butter' :
        variant === 'warning' ? 'auth-state-circle--butter' :
        'auth-state-circle--sage';

    const confirmClass =
        variant === 'danger' ? 'btn btn-danger-solid' :
        variant === 'warning' ? 'btn btn-primary' :
        'btn btn-primary';

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                style={{ textAlign: 'center' }}
            >
                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Close"
                    style={{
                        position: 'absolute',
                        top: 14,
                        right: 14,
                        width: 28,
                        height: 28,
                        borderRadius: 'var(--r-md)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--ink-muted)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <Icon name="x" size={16} />
                </button>
                <div
                    className={`auth-state-circle ${circleClass}`}
                    style={{ width: 52, height: 52, marginBottom: 16 }}
                >
                    <Icon name={iconName} size={22} />
                </div>
                <h2 style={{ marginBottom: 8 }}>{title}</h2>
                {message && (
                    <p style={{ margin: '0 0 24px', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                        {message}
                    </p>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="btn btn-ghost" onClick={onCancel}>
                        Cancel
                    </button>
                    <button className={confirmClass} onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
