import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';

// All cp-icon backgrounds use *-soft tints so they flip dark in dark
// mode and the `var(--ink)` foreground stays readable in both themes.
const ITEM_TINTS = {
    workflow1: 'var(--butter-soft)',
    workflow2: 'var(--lav-soft)',
    workflow3: 'var(--sage-soft)',
    workflow4: 'var(--sky-soft)',
    workflow5: 'var(--peach-soft)',
    actionNew: 'var(--peach-soft)',
    actionRun: 'var(--butter-soft)',
    actionCreds: 'var(--sage-soft)',
    pageDash: 'var(--lav-soft)',
    pageTelegram: 'var(--sky-soft)',
};

function formatRelative(iso) {
    if (!iso) return 'unknown';
    const d = new Date(iso);
    const seconds = (Date.now() - d.getTime()) / 1000;
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
    if (seconds < 604800) return `${Math.round(seconds / 86400)} d ago`;
    return d.toLocaleDateString();
}

export default function CommandPalette() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIdx, setActiveIdx] = useState(0);
    const [workflows, setWorkflows] = useState([]);
    const inputRef = useRef(null);
    const navigate = useNavigate();

    // Global open/close keybinding
    useEffect(() => {
        function onKey(e) {
            const cmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
            if (cmdK) {
                e.preventDefault();
                setOpen((o) => !o);
            } else if (e.key === 'Escape' && open) {
                e.preventDefault();
                setOpen(false);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    // Lazy-load workflows when the palette first opens
    useEffect(() => {
        if (!open) return;
        if (workflows.length > 0) return;
        api.getWorkflows()
            .then((data) => setWorkflows(data.workflows || []))
            .catch(() => { /* ignore */ });
    }, [open, workflows.length]);

    // Reset state on close, focus input on open
    useEffect(() => {
        if (open) {
            setActiveIdx(0);
            const t = setTimeout(() => inputRef.current?.focus(), 50);
            return () => clearTimeout(t);
        } else {
            setQuery('');
        }
    }, [open]);

    function close() { setOpen(false); }
    function go(action) { close(); setTimeout(action, 0); }

    function dispatchCreate() {
        // Dashboard listens for this and opens its inline create modal
        window.dispatchEvent(new CustomEvent('vcw:create-workflow'));
    }

    const sections = useMemo(() => {
        const q = query.trim().toLowerCase();

        const wfMatches = workflows
            .filter((wf) => !q || wf.name.toLowerCase().includes(q) || (wf.description || '').toLowerCase().includes(q))
            .slice(0, 5)
            .map((wf, i) => ({
                id: `wf-${wf.id}`,
                kind: 'workflow',
                label: wf.name,
                sub: `edited ${formatRelative(wf.updatedAt)} · ${wf._count?.executions || 0} runs`,
                icon: 'workflow',
                tint: ITEM_TINTS[`workflow${(i % 5) + 1}`],
                onSelect: () => navigate(`/workflow/${wf.id}`),
            }));

        const actions = [
            {
                id: 'act-new',
                kind: 'action',
                label: 'Create new workflow…',
                sub: 'blank canvas · or from template',
                icon: 'plus',
                tint: ITEM_TINTS.actionNew,
                kbd: '⌘N',
                onSelect: () => { navigate('/'); dispatchCreate(); },
            },
            {
                id: 'act-run',
                kind: 'action',
                label: 'Run last batch again',
                sub: workflows[0] ? `${workflows[0].name} · re-runs newest jobs` : 'rerun the most recent batch',
                icon: 'play',
                tint: ITEM_TINTS.actionRun,
                kbd: '⌘⇧R',
                onSelect: () => { if (workflows[0]) navigate(`/workflow/${workflows[0].id}`); },
            },
            {
                id: 'act-creds',
                kind: 'action',
                label: 'Manage credentials',
                sub: 'view, refresh, add API keys',
                icon: 'key',
                tint: ITEM_TINTS.actionCreds,
                kbd: 'G C',
                onSelect: () => navigate('/credentials'),
            },
        ].filter((a) => !q || a.label.toLowerCase().includes(q) || a.sub.toLowerCase().includes(q));

        const pages = [
            {
                id: 'pg-dash',
                kind: 'page',
                label: 'Dashboard',
                sub: 'all workflows · /',
                icon: 'workflow',
                tint: ITEM_TINTS.pageDash,
                kbd: 'G D',
                onSelect: () => navigate('/'),
            },
            {
                id: 'pg-tg',
                kind: 'page',
                label: 'Telegram link',
                sub: 'link a chat to run flows from your phone',
                icon: 'bot',
                tint: ITEM_TINTS.pageTelegram,
                kbd: 'G T',
                onSelect: () => navigate('/credentials'),
            },
        ].filter((p) => !q || p.label.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q));

        const out = [];
        if (wfMatches.length) out.push({ title: `Workflows · ${wfMatches.length} ${wfMatches.length === 1 ? 'match' : 'matches'}`, items: wfMatches });
        if (actions.length) out.push({ title: 'Actions', items: actions });
        if (pages.length) out.push({ title: 'Pages · jump to', items: pages });
        return out;
    }, [workflows, query, navigate]);

    const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

    // Re-clamp active idx
    useEffect(() => {
        if (activeIdx >= flatItems.length) setActiveIdx(Math.max(0, flatItems.length - 1));
    }, [activeIdx, flatItems.length]);

    // Nav keys when open
    useEffect(() => {
        if (!open) return;
        function onKey(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(flatItems.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = flatItems[activeIdx];
                if (item) go(item.onSelect);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, flatItems, activeIdx]);

    if (!open) return null;

    // Translate flat active index → which section/item is highlighted
    let activeCounter = 0;

    return (
        <div className="cp-overlay" onClick={close}>
            <div className="cp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
                <div className="cp-search">
                    <Icon name="search" size={18} color="var(--ink-muted)" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
                        placeholder="Search flows, actions, pages…"
                        spellCheck={false}
                        autoComplete="off"
                    />
                    <span className="cp-shortcut">⌘K</span>
                </div>

                <div className="cp-body">
                    {sections.length === 0 ? (
                        <div className="cp-empty">Nothing matches &ldquo;{query}&rdquo;.</div>
                    ) : (
                        sections.map((sec) => (
                            <div className="cp-section" key={sec.title}>
                                <div className="cp-section-title">{sec.title}</div>
                                {sec.items.map((item) => {
                                    const isActive = activeCounter === activeIdx;
                                    activeCounter += 1;
                                    return (
                                        <div
                                            key={item.id}
                                            className={`cp-item${isActive ? ' active' : ''}`}
                                            onClick={() => go(item.onSelect)}
                                            onMouseEnter={() => setActiveIdx(flatItems.findIndex((f) => f.id === item.id))}
                                        >
                                            <span className="cp-icon" style={{ background: item.tint }}>
                                                <Icon name={item.icon} size={14} />
                                            </span>
                                            <div className="cp-main">
                                                <div className="label">{item.label}</div>
                                                <div className="sub">{item.sub}</div>
                                            </div>
                                            {item.kbd ? (
                                                <span className="cp-shortcut">{item.kbd}</span>
                                            ) : (
                                                <span className="cp-arrow"><Icon name="chevron-right" size={14} /></span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>

                <div className="cp-foot">
                    <span>Powered by ⌘K · v0.14</span>
                    <span className="cp-hints">
                        <span className="key-hint"><kbd>↑↓</kbd> navigate</span>
                        <span className="key-hint"><kbd>↵</kbd> open</span>
                        <span className="key-hint"><kbd>esc</kbd> close</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
