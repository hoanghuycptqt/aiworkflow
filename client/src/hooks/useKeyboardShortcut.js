import { useEffect, useRef } from 'react';

/**
 * useKeyboardShortcut(combo, handler, options?)
 *
 * `combo` is a `+`-separated string of modifiers + a single key:
 *   - "mod+s"        → ⌘ S on macOS, Ctrl+S elsewhere
 *   - "mod+shift+r"  → ⌘⇧R / Ctrl+Shift+R
 *   - "n"            → just N
 *   - "?"            → Shift+/ (the literal "?" key)
 *   - "backspace", "enter", "escape", "arrowdown" … by `e.key` name
 *
 * Skips when an `<input>`, `<textarea>` or `[contenteditable]` has focus
 * unless `options.allowInInput === true`.
 *
 * Pass an array of combos as the first arg to bind multiple aliases.
 */
export function useKeyboardShortcut(combo, handler, options = {}) {
    // Latest-handler ref so callers don't need useCallback
    const handlerRef = useRef(handler);
    useEffect(() => { handlerRef.current = handler; }, [handler]);

    useEffect(() => {
        const combos = Array.isArray(combo) ? combo : [combo];
        const parsed = combos.map(parseCombo);

        function onKey(e) {
            const target = e.target;
            const tag = target?.tagName;
            const editable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
            if (editable && !options.allowInInput) return;

            for (const p of parsed) {
                if (matches(e, p)) {
                    if (options.preventDefault !== false) e.preventDefault();
                    handlerRef.current(e);
                    return;
                }
            }
        }

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // Re-bind when combo string(s) change. The handler ref keeps the latest.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Array.isArray(combo) ? combo.join('|') : combo, options.allowInInput, options.preventDefault]);
}

const KEY_ALIASES = {
    enter: 'enter',
    '↵': 'enter',
    return: 'enter',
    esc: 'escape',
    escape: 'escape',
    space: ' ',
    backspace: 'backspace',
    '⌫': 'backspace',
    del: 'delete',
    delete: 'delete',
    tab: 'tab',
    arrowdown: 'arrowdown',
    arrowup: 'arrowup',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
    '↓': 'arrowdown',
    '↑': 'arrowup',
    '←': 'arrowleft',
    '→': 'arrowright',
};

function parseCombo(combo) {
    const raw = String(combo || '').trim().toLowerCase();
    if (!raw) return { mod: false, shift: false, alt: false, key: '' };

    // Special-case the bare "?" combo so we don't lose the "?" in the +-split
    if (raw === '?') return { mod: false, shift: true, alt: false, key: '/' };

    const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
    let mod = false, shift = false, alt = false, key = '';
    for (const p of parts) {
        if (p === 'mod' || p === 'cmd' || p === 'ctrl' || p === 'meta' || p === '⌘') { mod = true; continue; }
        if (p === 'shift' || p === '⇧') { shift = true; continue; }
        if (p === 'alt' || p === 'option' || p === '⌥') { alt = true; continue; }
        key = KEY_ALIASES[p] || p;
    }
    return { mod, shift, alt, key };
}

function matches(e, p) {
    const isMod = e.metaKey || e.ctrlKey;
    if (!!p.mod !== !!isMod) return false;
    if (!!p.shift !== !!e.shiftKey) return false;
    if (!!p.alt !== !!e.altKey) return false;
    return (e.key || '').toLowerCase() === p.key;
}
