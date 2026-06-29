import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg" | "hero";

const sizeMap: Record<Size, string> = {
  sm: "text-lg",
  md: "text-xl",
  lg: "text-3xl",
  hero: "font-display text-[14vw] leading-[0.85] tracking-[-0.04em] md:text-[9rem]",
};

export function Wordmark({
  size = "md",
  className,
  ...rest
}: { size?: Size } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-label="silyc."
      className={cn(
        "inline-flex items-baseline font-black tracking-tight leading-none text-foreground",
        sizeMap[size],
        className,
      )}
      {...rest}
    >
      <span>silyc</span>
      <span className="text-primary">.</span>
    </span>
  );
}