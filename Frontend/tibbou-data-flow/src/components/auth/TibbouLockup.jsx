import TibbouMark from "./TibbouMark";

/**
 * TibbouLockup — the mark fused with the wordmark, as one unit.
 *
 * The mark forms the "T" (crossbar + stem); the wordmark that follows is
 * "ıbbou" using the dotless ı (U+0131), so the mark's own dot reads as the
 * tittle instead of a second, redundant one. Always forces the mark's dot
 * on regardless of size, since the lockup doesn't work without it.
 *
 * Props
 *   size      number   mark bar-height in px (S) — wordmark scales from it
 *   theme     "dark" | "light"
 *   animated  boolean
 */
export default function TibbouLockup({ size = 20, theme = "dark", animated = true, className = "" }) {
  return (
    <div className={`tb-lockup tb-lockup--${theme} ${className}`} style={/** @type {import("react").CSSProperties} */ ({ "--s": `${size}px` })}>
      <TibbouMark size={size} theme={theme} animated={animated} forceDot />
      <span className="tb-lockup__word">{"ıbbou"}</span>
    </div>
  );
}
