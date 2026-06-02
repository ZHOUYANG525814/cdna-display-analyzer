// Defer mounting an expensive subtree until the user scrolls it into view.
//
// Why: the Results dashboard mounts ~6 chart cards on the same render commit.
// Each runs its own heavy `useMemo` (binning, sorting, fitting) when first
// mounted, so the combined first-paint cost on a 758 MB CSV is several
// seconds of unresponsive UI. Wrapping each card in <LazyMount> spreads the
// per-card work across user-driven scroll moments instead of stacking it.
//
// Implementation notes:
// - IntersectionObserver fires once on scroll-into-view; we set `mounted` and
//   never re-toggle it (so the chart's own useMemo cache survives scrolling
//   away + back).
// - Placeholder height is configurable via `minHeight` so the page layout
//   doesn't shift dramatically when the chart hydrates.
// - rootMargin defaults to "200px" so we start mounting before the card is
//   actually on-screen — feels instant to the user instead of a visible
//   flash-then-render.
//
// Falls back to immediate mount when IntersectionObserver isn't available
// (vitest jsdom, old browsers) so tests + SSR don't see an empty page.

import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Placeholder height while unmounted. Keeps page layout stable. */
  minHeight?: number;
  /** Margin around the viewport that triggers mount. Default "200px". */
  rootMargin?: string;
}

export function LazyMount({ children, minHeight = 300, rootMargin = "200px" }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setMounted(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [mounted, rootMargin]);

  if (mounted) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} aria-hidden="true" />;
}
