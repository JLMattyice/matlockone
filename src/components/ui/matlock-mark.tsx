import { MARK_GREEN, MARK_M, MARK_O, MARK_OUTLINE } from "@/lib/brand-mark.mjs";

/**
 * The MO badge beside "Matlock One" — the same drawing as the browser tab's
 * icon, cropped to its rounded square. Size it with the className (h-8 w-8).
 *
 * Fixed green rather than --brand: it is the product's mark, and a business
 * re-skinning its own workspace does not re-skin Matlock One's.
 */
export function MatlockMark({ className }: { className?: string }) {
  const { x, y, size, radius } = MARK_OUTLINE;
  return (
    <svg
      viewBox={`${x} ${y} ${size} ${size}`}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x={x} y={y} width={size} height={size} rx={radius} fill={MARK_GREEN} />
      <path d={MARK_M} fill="#fff" />
      <ellipse
        cx={MARK_O.cx}
        cy={MARK_O.cy}
        rx={MARK_O.rx}
        ry={MARK_O.ry}
        fill="none"
        stroke="#fff"
        strokeWidth={MARK_O.stroke}
      />
    </svg>
  );
}
