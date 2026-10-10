/**
 * Mitra's mark: a pixel-block "M" on a 7×7 grid (style after the brand reference in logo.jpg),
 * drawn in the current text colour. The pink pixel at the tip of the M is the "voice" Mitra listens for.
 * `animated` builds the M square by square and makes the pink pixel pulse.
 */
const GRID = 7;
const M_CELLS: [number, number][] = [
  // [column, row]: both legs top to bottom, then the V stepping in toward the centre
  ...Array.from({ length: GRID }, (_, r) => [0, r] as [number, number]),
  [1, 1], [2, 2],
  [5, 1], [4, 2],
  ...Array.from({ length: GRID }, (_, r) => [6, r] as [number, number]),
];
const VOICE_CELL: [number, number] = [3, 3];

export function LogoMark({ size = 40, animated = false, className = "" }: { size?: number; animated?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 70 70" className={`shrink-0 ${className}`} role="img" aria-label="Mitra AI">
      {M_CELLS.map(([c, r], i) => (
        <rect
          key={`${c}-${r}`}
          x={c * 10}
          y={r * 10}
          width="10.4"
          height="10.4"
          fill="currentColor"
          className={animated ? "logo-cell" : undefined}
          style={animated ? { animationDelay: `${i * 45}ms` } : undefined}
        />
      ))}
      <rect
        x={VOICE_CELL[0] * 10}
        y={VOICE_CELL[1] * 10}
        width="10"
        height="10"
        fill="var(--logo-accent)"
        className={animated ? "logo-voice" : undefined}
      />
    </svg>
  );
}

/** Mark + "Mitra", optionally with the small side note, as in the reference lockup. */
export function Wordmark({ size = 28, tagline = false, className = "" }: { size?: number; tagline?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: size * 0.4 }}>
      <LogoMark size={size} />
      <span className="font-display font-medium leading-none tracking-tight" style={{ fontSize: size * 1.05 }}>
        Mitra
      </span>
      {tagline && (
        <span className="self-start leading-tight text-[var(--fg-2)]" style={{ fontSize: Math.max(10, size * 0.3) }}>
          ©
          <br />
          AI grocery
          <br />
          assistant
        </span>
      )}
    </span>
  );
}
