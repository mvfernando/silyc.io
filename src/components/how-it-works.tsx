import { motion } from "motion/react";
import { useI18n } from "@/lib/i18n";

export function HowItWorks() {
  const { t } = useI18n();
  const steps = [
    { num: "01", title: t.how_step1_t, desc: t.how_step1_d, Illustration: UploadIllustration },
    { num: "02", title: t.how_step2_t, desc: t.how_step2_d, Illustration: AnalysisIllustration },
    { num: "03", title: t.how_step3_t, desc: t.how_step3_d, Illustration: FinalEditIllustration },
  ];

  return (
    <section id="how" className="border-t border-border/60 py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 flex flex-col gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
            ／ {t.how_eyebrow}
          </span>
          <h2 className="font-display text-4xl font-bold tracking-tight md:text-5xl">{t.how_title}</h2>
          <p className="max-w-xl text-muted-foreground">{t.how_sub}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <motion.div
              key={s.num}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.55, delay: i * 0.12 }}
              className="group relative overflow-hidden rounded-3xl border border-border/80 bg-card/40 p-8 transition-colors hover:border-primary/30"
            >
              {/* Connector line */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-[-2px] top-1/2 hidden h-px w-8 -translate-y-1/2 bg-gradient-to-r from-border to-transparent md:block"
                />
              )}

              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
                  {s.num}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  step / 03
                </span>
              </div>

              <div className="mt-6 overflow-hidden rounded-2xl border border-border/60 bg-background/60">
                <s.Illustration />
              </div>

              <h3 className="mt-6 font-display text-2xl font-bold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Step 1: Upload ───────────────────────────────────────── */
function UploadIllustration() {
  return (
    <div className="relative h-44 w-full overflow-hidden">
      {/* Dashed dropzone */}
      <div className="absolute inset-4 rounded-xl border border-dashed border-border/80" />

      {/* File card dropping */}
      <motion.div
        initial={{ y: -60, opacity: 0 }}
        animate={{ y: [-60, 0, 0, -60], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", times: [0, 0.35, 0.85, 1] }}
        className="absolute left-1/2 top-6 -translate-x-1/2"
      >
        <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-card px-3 py-2 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)]">
          <span className="h-6 w-5 rounded-sm bg-primary/80" />
          <div className="flex flex-col">
            <span className="font-mono text-[10px] tracking-wider text-foreground">interview.mp4</span>
            <span className="font-mono text-[9px] text-muted-foreground">218 MB · 14:32</span>
          </div>
        </div>
      </motion.div>

      {/* Progress bar at bottom */}
      <div className="absolute inset-x-6 bottom-6">
        <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
          <span>uploading</span>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 0] }}
            transition={{ duration: 4, repeat: Infinity, times: [0.35, 0.4, 0.85, 0.9] }}
          >
            100%
          </motion.span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <motion.div
            initial={{ width: "0%" }}
            animate={{ width: ["0%", "100%", "100%", "0%"] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", times: [0.05, 0.7, 0.85, 0.95] }}
            className="h-full bg-primary"
          />
        </div>
      </div>
    </div>
  );
}

/* ── Step 2: Analysis ─────────────────────────────────────── */
function AnalysisIllustration() {
  const bars = Array.from({ length: 28 });
  const silentSet = new Set([4, 5, 12, 13, 14, 21]);
  return (
    <div className="relative h-44 w-full overflow-hidden">
      {/* Waveform bars */}
      <div className="absolute inset-x-5 top-6 flex h-24 items-end gap-[3px]">
        {bars.map((_, i) => {
          const silent = silentSet.has(i);
          const h = silent ? 8 : 25 + Math.abs(Math.sin(i * 1.4)) * 75;
          return (
            <motion.span
              key={i}
              initial={{ scaleY: 0.3, opacity: 0.4 }}
              animate={
                silent
                  ? { scaleY: 0.3, opacity: [0.4, 0.15] }
                  : { scaleY: 1, opacity: [0.6, 1] }
              }
              transition={{
                duration: 0.5,
                delay: 0.7 + i * 0.05,
                repeat: Infinity,
                repeatType: "reverse",
                repeatDelay: 3.2,
              }}
              className={`flex-1 origin-bottom rounded-sm ${silent ? "bg-muted-foreground/40" : "bg-foreground/80"}`}
              style={{ height: `${h}%` }}
            />
          );
        })}
      </div>

      {/* Scan line */}
      <motion.div
        initial={{ left: "0%" }}
        animate={{ left: ["0%", "100%"] }}
        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
        className="absolute top-4 h-28 w-px bg-primary shadow-[0_0_18px_2px_color-mix(in_oklab,var(--color-primary)_70%,transparent)]"
      />

      {/* Legend */}
      <div className="absolute inset-x-6 bottom-5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground/80" /> voice
        </span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" /> silence
        </span>
        <span className="text-primary">scanning</span>
      </div>
    </div>
  );
}

/* ── Step 3: Final edit ───────────────────────────────────── */
function FinalEditIllustration() {
  return (
    <div className="relative h-44 w-full overflow-hidden">
      {/* "Before" full timeline */}
      <div className="absolute inset-x-5 top-6">
        <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
          <span>before</span>
          <span className="tabular-nums">14:32</span>
        </div>
        <div className="relative h-3 overflow-hidden rounded-sm bg-muted">
          {/* removed silent chunks (lighter overlay segments) */}
          {[10, 32, 58, 78].map((left, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 1, 0] }}
              transition={{
                duration: 4,
                repeat: Infinity,
                ease: "easeInOut",
                times: [0.1, 0.35, 0.7, 0.85],
                delay: i * 0.08,
              }}
              className="absolute top-0 h-full bg-muted-foreground/40"
              style={{ left: `${left}%`, width: "6%" }}
            />
          ))}
          <span className="absolute inset-0 bg-foreground/80 mix-blend-multiply opacity-0" />
          <span className="absolute inset-0 bg-foreground/80" />
        </div>
      </div>

      {/* Collapse arrow */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: [0, 1, 1, 0], y: [4, 0, 0, 4] }}
        transition={{ duration: 4, repeat: Infinity, times: [0.3, 0.45, 0.85, 0.95] }}
        className="absolute left-1/2 top-[78px] -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.22em] text-primary"
      >
        ↓ trim ↓
      </motion.div>

      {/* "After" timeline shrinking from full to trimmed */}
      <div className="absolute inset-x-5 bottom-6">
        <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em]">
          <span className="text-primary">after</span>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.4, 1, 1, 0.4] }}
            transition={{ duration: 4, repeat: Infinity, times: [0, 0.6, 0.85, 1] }}
            className="tabular-nums text-primary"
          >
            10:14
          </motion.span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-sm bg-muted">
          <motion.div
            initial={{ width: "100%" }}
            animate={{ width: ["100%", "100%", "70%", "70%"] }}
            transition={{
              duration: 4,
              repeat: Infinity,
              ease: "easeInOut",
              times: [0, 0.3, 0.65, 1],
            }}
            className="h-full bg-primary"
          />
        </div>
      </div>
    </div>
  );
}