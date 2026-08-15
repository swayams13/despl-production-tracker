"use client";

import { useEffect, useRef, useState } from "react";

/**
 * §7 "Count-up KPIs (once)". Animates 0 → value on mount only (no re-trigger
 * on re-render/revalidation — a KPI ticking every time a server action calls
 * router.refresh() would read as jittery, not polished). Honors
 * prefers-reduced-motion by skipping straight to the final value.
 */
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [display, setDisplay] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? value : 0,
  );
  const played = useRef(false);

  useEffect(() => {
    if (played.current) return;
    played.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }
    const duration = 600;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- animates once from the value seen on mount
  }, []);

  return <>{display.toFixed(decimals)}</>;
}
