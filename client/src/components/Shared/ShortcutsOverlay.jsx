import { useState, useEffect } from 'react';
import Icon from '../../services/icons.jsx';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut.js';

const SECTIONS = [
    {
        title: 'Global',
        rows: [
            { desc: 'Command palette', keys: ['⌘', 'K'] },
            { desc: 'Show shortcuts', keys: ['?'] },
            { desc: 'Toggle light / dark', keys: ['⌘', '\\'] },
            { desc: 'Quick search', keys: ['/'] },
            { desc: 'Toggle tweaks', keys: ['⌘', '.'] },
        ],
    },
    {
        title: 'Navigation',
        rows: [
            { desc: 'Go to Dashboard', keys: ['G', 'D'] },
            { desc: 'Go to Credentials', keys: ['G', 'C'] },
            { desc: 'Go to Telegram', keys: ['G', 'T'] },
            { desc: 'Go to Admin', keys: ['G', 'A'] },
            { desc: 'Back', keys: ['esc'] },
        ],
    },
    {
        title: 'Workflow canvas',
        rows: [
            { desc: 'Add node', keys: ['N'] },
            { desc: 'Duplicate selected', keys: ['⌘', 'D'] },
            { desc: 'Delete selected', keys: ['⌫'] },
            { desc: 'Run flow', keys: ['⌘', '↵'] },
            { desc: 'Save', keys: ['⌘', 'S'] },
            { desc: 'Fit to view', keys: ['F'] },
            { desc: 'Toggle results panel', keys: ['⌘', 'J'] },
        ],
    },
    {
        title: 'Batch & history',
        rows: [
            { desc: 'Run selected jobs', keys: ['⌘', '⇧', '↵'] },
            { desc: 'Select all jobs', keys: ['⌘', 'A'] },
            { desc: 'Stop running batch', keys: ['⌘', '.'] },
            { desc: 'Open last execution', keys: ['L'] },
            { desc: 'Download all outputs', keys: ['⌘', '⇧', 'D'] },
        ],
    },
];

export default function ShortcutsOverlay() {
    const [open, setOpen] = useState(false);

    useKeyboardShortcut('?', () => setOpen(true));
    useKeyboardShortcut('escape', () => setOpen(false), { allowInInput: true });

    // Also close when clicking outside the modal — handled via overlay onClick

    // Reset on close so re-opens don't carry stale state (currently none, but defensive)
    useEffect(() => {
        if (!open) return;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = ''; };
    }, [open]);

    if (!open) return null;

    return (
        <div className="ks-overlay" onClick={() => setOpen(false)}>
            <div className="ks-wrap" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
                <div className="ks-head">
                    <div>
                        <h2>Keyboard <em>shortcuts.</em></h2>
                        <div className="sub">PRESS ? FROM ANYWHERE TO REOPEN THIS PANEL</div>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                        <Icon name="x" size={12} /> Close · esc
                    </button>
                </div>
                <div className="ks-grid">
                    {SECTIONS.map((sec) => (
                        <div className="ks-section" key={sec.title}>
                            <h4>{sec.title}</h4>
                            {sec.rows.map((row) => (
                                <div className="ks-row" key={row.desc}>
                                    <span className="desc">{row.desc}</span>
                                    <KeyCombo keys={row.keys} />
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function KeyCombo({ keys }) {
    return (
        <span className="ks-keys">
            {keys.map((k, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {i > 0 && <span className="plus">+</span>}
                    <kbd>{k}</kbd>
                </span>
            ))}
        </span>
    );
}
