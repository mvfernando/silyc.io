import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { SiteHeader } from "@/components/site-header";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { HowItWorks } from "@/components/how-it-works";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Silyc — Edição limpa em um clique" },
      { name: "description", content: "Remove silêncios, pausas e ruídos do seu vídeo em minutos. Pós-produção automatizada com IA." },
      { property: "og:title", content: "Silyc — Edição limpa em um clique" },
      { property: "og:description", content: "Pós-produção automatizada: remove silêncios, otimiza áudio e aplica color grading cinematográfico." },
    ],
  }),
  component: Index,
});

function Index() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      <SiteHeader />
      <main>
        <Hero t={t} />
        <FeaturesBento t={t} />
        <HowItWorks />
        <Impact t={t} />
        <CtaStrip t={t} />
      </main>
      <footer className="border-t border-border/60 py-10 text-center text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        © {new Date().getFullYear()} · {t.footer}
      </footer>
    </div>
  );
}

function Hero({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="relative overflow-hidden">
      {/* Ember glow */}
      <motion.div
        aria-hidden
        animate={{ opacity: [0.45, 0.7, 0.45], scale: [1, 1.06, 1] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[840px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[140px]"
        style={{ background: "color-mix(in oklab, var(--color-primary) 22%, transparent)" }}
      />
      <div className="relative mx-auto flex min-h-[88vh] max-w-6xl flex-col items-center justify-center px-6 py-28 text-center">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-10 inline-flex items-center gap-2 rounded-full border border-border/80 bg-white/[0.03] px-3 py-1 backdrop-blur"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            {t.hero_eyebrow}
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="font-display text-[14vw] font-extrabold leading-[0.85] tracking-[-0.04em] md:text-[9rem]"
        >
          Silyc<span className="text-primary">.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-8 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground md:text-xl"
        >
          {t.hero_sub}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.25 }}
          className="mt-12 flex flex-col items-center gap-3 sm:flex-row"
        >
          <Button
            asChild
            size="lg"
            className="rounded-sm px-8 shadow-[0_0_60px_-15px_color-mix(in_oklab,var(--color-primary)_70%,transparent)]"
          >
            <Link to="/app">{t.hero_cta}</Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-sm border-border/80 bg-white/[0.03] px-8">
            <a href="#features">{t.hero_secondary}</a>
          </Button>
        </motion.div>

        <h2 className="sr-only">{t.hero_title}</h2>
      </div>

      {/* Waveform line */}
      <div className="pointer-events-none absolute bottom-0 left-0 w-full opacity-30">
        <svg viewBox="0 0 1440 320" className="h-32 w-full md:h-40">
          <motion.path
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="1.5"
            d="M0,160 C120,200 240,120 360,160 C480,200 600,240 720,160 C840,80 960,120 1080,160 C1200,200 1320,240 1440,160"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 2.4, ease: "easeInOut", delay: 0.4 }}
          />
        </svg>
      </div>
    </section>
  );
}

function FeaturesBento({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section id="features" className="border-t border-border/60 py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 flex items-end justify-between gap-6">
          <h2 className="font-display text-4xl font-bold tracking-tight md:text-5xl">{t.feat_title}</h2>
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground md:block">
            ／ 01 — 03
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {/* Large feature: timeline cleanup */}
          <BentoCard className="md:col-span-8 md:row-span-2" delay={0}>
            <BentoNum>01</BentoNum>
            <h3 className="mt-6 font-display text-3xl font-bold tracking-tight">{t.feat_1_t}</h3>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{t.feat_1_d}</p>
            <WaveformVisual />
          </BentoCard>

          {/* Audio AI */}
          <BentoCard className="md:col-span-4" delay={0.05}>
            <BentoNum>02</BentoNum>
            <h3 className="mt-6 font-display text-2xl font-bold tracking-tight">{t.feat_2_t}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t.feat_2_d}</p>
          </BentoCard>

          {/* Ember stat tile */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="rounded-3xl bg-primary p-10 text-primary-foreground md:col-span-4"
          >
            <p className="font-display text-5xl font-extrabold tracking-tight">~ minutos</p>
            <p className="mt-4 text-sm font-medium opacity-80">
              {t.impact_after} — {t.impact_after_list[t.impact_after_list.length - 1]}
            </p>
          </motion.div>

          {/* Color */}
          <BentoCard className="md:col-span-8" delay={0.15}>
            <div className="flex items-start justify-between gap-6">
              <div>
                <BentoNum>03</BentoNum>
                <h3 className="mt-6 font-display text-3xl font-bold tracking-tight">{t.feat_3_t}</h3>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{t.feat_3_d}</p>
              </div>
              <ColorChips />
            </div>
          </BentoCard>
        </div>
      </div>
    </section>
  );
}

function BentoCard({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay }}
      className={`group relative overflow-hidden rounded-3xl border border-border/80 bg-card/40 p-10 transition-colors hover:border-primary/30 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function BentoNum({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">{children}</span>
  );
}

function WaveformVisual() {
  const bars = Array.from({ length: 40 });
  return (
    <div className="mt-10 flex h-32 items-end gap-[3px] rounded-xl border border-border/60 bg-background/40 p-4">
      {bars.map((_, i) => {
        const silent = i % 8 === 3 || i % 11 === 5;
        const h = silent ? 6 : 18 + Math.abs(Math.sin(i * 1.3)) * 80;
        return (
          <span
            key={i}
            className={`flex-1 origin-bottom rounded-sm ${silent ? "bg-muted-foreground/25" : "bg-foreground/80 group-hover:bg-primary"} transition-colors`}
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

function ColorChips() {
  const swatches = [
    "oklch(0.22 0.02 30)",
    "oklch(0.55 0.18 35)",
    "oklch(0.78 0.12 60)",
    "oklch(0.9 0.05 80)",
  ];
  return (
    <div className="hidden shrink-0 flex-col gap-2 md:flex">
      {swatches.map((c) => (
        <span key={c} className="h-10 w-16 rounded-md border border-border/60" style={{ background: c }} />
      ))}
    </div>
  );
}

function Impact({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="border-t border-border/60 bg-card/20 py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-start gap-16 md:grid-cols-2">
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">／ Impact</span>
            <h2 className="mt-4 font-display text-4xl font-bold leading-tight tracking-tight md:text-5xl">
              {t.impact_t}
            </h2>
            <p className="mt-6 max-w-md text-muted-foreground">{t.hero_sub}</p>

            <div className="mt-10 space-y-5">
              <ImpactRow label={t.impact_before} duration="~ 1–2h" items={t.impact_before_list} muted />
              <ImpactRow label={t.impact_after} duration="~ minutos" items={t.impact_after_list} />
            </div>
          </div>

          <ImpactVisual />
        </div>
      </div>
    </section>
  );
}

function ImpactRow({
  label,
  duration,
  items,
  muted = false,
}: {
  label: string;
  duration: string;
  items: readonly string[];
  muted?: boolean;
}) {
  return (
    <div className="border-l-2 pl-5" style={{ borderColor: muted ? "var(--color-border)" : "var(--color-primary)" }}>
      <div className="flex items-baseline justify-between gap-4">
        <span
          className={`text-[11px] uppercase tracking-[0.22em] ${muted ? "text-muted-foreground" : "text-primary"}`}
        >
          {label}
        </span>
        <span
          className={`font-display text-2xl font-bold tabular-nums ${muted ? "text-muted-foreground" : "text-primary"}`}
        >
          {duration}
        </span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {items.map((line) => (
          <li key={line} className="font-mono text-xs tabular-nums">
            · {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImpactVisual() {
  const cols = [24, 32, 16, 40, 56, 32, 48, 20, 36, 28, 44, 18];
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-3xl border border-border/80 bg-background/60 grain-overlay">
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-6 py-4 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        <span>interview.mp4</span>
        <span className="tabular-nums">00:14:32 → 00:10:14</span>
      </div>
      <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
      <div className="absolute inset-0 flex items-end px-6 pb-10">
        <div className="grid w-full grid-cols-12 items-end gap-1">
          {cols.map((h, i) => {
            const after = i >= 6;
            const targetH = `${(h / 56) * 60}%`;
            return (
              <motion.span
                key={i}
                initial={{ height: after ? "6px" : targetH, opacity: 0.4 }}
                whileInView={{
                  height: after ? targetH : "6px",
                  opacity: 1,
                }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{
                  duration: 0.6,
                  delay: after ? 0.6 + (i - 6) * 0.08 : i * 0.08,
                  ease: "easeOut",
                }}
                className={`rounded-sm ${after ? "bg-primary" : "bg-muted-foreground/30"}`}
                style={{ minHeight: 6 }}
              />
            );
          })}
        </div>
      </div>
      <div className="absolute bottom-4 left-6 right-6 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        <span>{`/ ${"BEFORE"}`}</span>
        <span className="text-primary">{`AFTER /`}</span>
      </div>
    </div>
  );
}

function CtaStrip({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="py-32">
      <div className="mx-auto max-w-4xl px-6">
        <div className="relative overflow-hidden rounded-[40px] border border-border/80 bg-gradient-to-b from-card/80 to-transparent p-12 text-center md:p-20">
          <motion.span
            aria-hidden
            initial={{ width: 0 }}
            whileInView={{ width: "16rem" }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.9, ease: "easeOut" }}
            className="absolute left-1/2 top-0 h-[3px] -translate-x-1/2 bg-primary"
          />
          <h2 className="mx-auto max-w-2xl font-display text-4xl font-bold tracking-tight md:text-6xl">
            {t.hero_title}
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-muted-foreground">{t.hero_sub}</p>
          <Button asChild size="lg" className="mt-10 rounded-sm px-10">
            <Link to="/app">{t.hero_cta}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
