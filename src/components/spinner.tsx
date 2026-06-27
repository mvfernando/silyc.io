export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  // Purely decorative — the loading state is announced via aria-busy and the
  // button's text (or an sr-only live region) for assistive tech.
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-[1.5px] border-current border-r-transparent align-[-2px] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}