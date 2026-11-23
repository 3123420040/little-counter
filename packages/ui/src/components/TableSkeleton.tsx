/**
 * Skeleton loader for table views.
 * Shows N rows of pulsing ghost cells matching table column count.
 */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true" className="space-y-2 p-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-4 flex-1 rounded bg-surface-subtle animate-pulse"
              style={{ animationDelay: `${r * 80}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
