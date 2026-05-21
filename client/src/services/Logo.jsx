/**
 * thhflow logo — drop-in replacement for the old /icon.png gradient logo.
 *
 * Usage:
 *
 *   import Logo, { Wordmark } from '../../services/Logo.jsx';
 *
 *   <Logo size={32} />                    // mark + transparent chip, uses currentColor
 *   <Logo size={32} chip />                // ink chip background (recommended for nav)
 *   <Logo size={32} chip dark />           // cream chip (when on dark surface)
 *   <Wordmark size={22} />                 // italic serif "thhflow" text
 */

export default function Logo({ size = 28, chip = false, dark = false, accent = 'var(--peach, #F4A381)', style }) {
    const chipBg = chip ? (dark ? 'var(--cream-50)' : 'var(--ink)') : 'transparent';
    const inkColor = chip ? (dark ? 'var(--ink)' : 'var(--cream-50)') : 'currentColor';
    const r = chip ? size * 0.25 : 0;

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 40 40"
            aria-label="thhflow logo"
            style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
        >
            {chip && <rect width="40" height="40" rx={(r * 40) / size} fill={chipBg} />}
            {/* t crossbar */}
            <path
                d="M 9 13.5 L 26 13.5"
                stroke={inkColor}
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
            />
            {/* t stem turning into a flow arrow */}
            <path
                d="M 17.5 8 L 17.5 24 Q 17.5 28.5 22 28.5 L 28 28.5"
                stroke={inkColor}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            {/* Arrow head */}
            <path
                d="M 25.5 26 L 28 28.5 L 25.5 31"
                stroke={inkColor}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            {/* Peach accent dot at the t junction */}
            <circle cx="17.5" cy="13.5" r="2.2" fill={accent} />
        </svg>
    );
}

/**
 * Wordmark — the italic serif "thhflow" text that pairs with the mark.
 * Use as: <Logo chip size={28} /> <Wordmark />
 */
export function Wordmark({ size = 22, color = 'var(--ink)', style }) {
    return (
        <span
            style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontStyle: 'italic',
                fontSize: size,
                lineHeight: 1,
                color,
                letterSpacing: '-0.005em',
                ...style,
            }}
        >
            thhflow
        </span>
    );
}
