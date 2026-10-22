import { useEffect, useRef, useState } from "react";

const DURATION_MS = 700;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Counts a number up from its previous value (0 on first render), easing
// out, then renders it with `format`. Shows the final value straight away
// when the user has asked for reduced motion.
export default function CountUp({ value, format = (number) => String(Math.round(number)) }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(prefersReducedMotion() ? target : 0);
  const fromRef = useRef(shown);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(target);
      return undefined;
    }
    const from = fromRef.current;
    const started = performance.now();
    let frame;
    function tick(now) {
      const progress = Math.min(1, (now - started) / DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      const current = from + (target - from) * eased;
      fromRef.current = current;
      setShown(current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return <>{format(shown)}</>;
}
