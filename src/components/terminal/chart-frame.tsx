import { useEffect, useState, type ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

/**
 * ResponsiveContainer logs a "width(-1) and height(-1)" warning when it
 * mounts before layout (common inside iframes / first paint). Deferring one
 * frame lets the container measure real dimensions first.
 */
export function ChartFrame({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={className}>
      {ready ? (
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
