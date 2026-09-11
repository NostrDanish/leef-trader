import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Chart container with its own measurement. recharts' ResponsiveContainer
 * renders once with width/height -1 before its ResizeObserver fires and logs
 * a "width(-1) and height(-1)" warning every mount — noisy inside hidden
 * iframes and tab switches. Instead we measure ourselves and mount the chart
 * with explicit pixel dimensions only once they exist.
 */
export function ChartFrame({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 2 && rect.height > 2) {
        setSize((prev) =>
          prev &&
          Math.abs(prev.width - rect.width) < 2 &&
          Math.abs(prev.height - rect.height) < 2
            ? prev
            : { width: Math.floor(rect.width), height: Math.floor(rect.height) },
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chart =
    size && isValidElement(children)
      ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
          width: size.width,
          height: size.height,
        })
      : null;

  return (
    <div ref={ref} className={className} style={{ minWidth: 0, minHeight: 0 }}>
      {chart}
    </div>
  );
}
