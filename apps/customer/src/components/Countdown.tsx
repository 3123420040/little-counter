export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function Countdown({
  seconds,
  expired,
  className = "",
}: {
  seconds: number;
  expired?: boolean;
  className?: string;
}) {
  return (
    <span className={`tnum ${className}`} aria-live={expired ? "polite" : "off"}>
      {expired ? "Expired" : formatCountdown(seconds)}
    </span>
  );
}
