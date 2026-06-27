export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={`inline-block animate-spin rounded-full border-[1.5px] border-current border-r-transparent align-[-2px] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}