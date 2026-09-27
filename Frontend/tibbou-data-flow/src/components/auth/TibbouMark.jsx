/**
 * TibbouMark — the animated cost-bar "T".
 *
 * Geometry is driven by one number, `size` = bar height in px (S).
 * Everything else is a ratio of S, taken from the approved design:
 *   gap between segments ....... 0.34 S
 *   segment 1 + segment 2 ...... 4.00 S (split 2.30 / 1.70, animates to 1.50 / 2.50)
 *   dot (third segment) ........ 1.00 S
 *   gap bar -> stem ............ 0.18 S
 *   stem length ................ 2.66 S
 *   total: 5.68 S wide x 3.84 S tall (4.34 S wide without the dot)
 *
 * The two segments always sum to 4 S, so the dot and the stem never move;
 * only the split between the first two segments changes.
 *
 * Brand rule: below 32px the mark drops to two segments — the third,
 * palest segment (the dot) goes first. Pass `forceDot` to keep it anyway —
 * needed when the mark is fused into the "Tibbou" wordmark lockup, where
 * the dot is doing double duty as the tittle over a dotless "ı".
 *
 * Styles and keyframes live in login.css (classes prefixed `tb-`).
 */
export default function TibbouMark({ size = 44, theme = "dark", animated = true, className = "", forceDot = false }) {
  const showDot = size >= 32 || forceDot;
  return (
    <div
      className={`tb-mark tb-mark--${theme} ${animated ? "tb-mark--animated" : ""} ${showDot ? "" : "tb-mark--no-dot"} ${className}`}
      style={{ "--s": `${size}px` }}
      role="img"
      aria-label="Tibbou"
    >
      <div className="tb-mark__bar">
        <span className="tb-mark__seg tb-mark__seg--a" />
        <span className="tb-mark__seg tb-mark__seg--b" />
        {showDot && <span className="tb-mark__seg tb-mark__seg--dot" />}
      </div>
      <span className="tb-mark__stem" />
    </div>
  );
}
