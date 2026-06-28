import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { SiteHeader } from "@/components/site-header";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

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
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main>
        <Hero t={t} />
        <Features t={t} />
        <Impact t={t} />
        <CtaStrip t={t} />
      </main>
      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {t.footer}
      </footer>
    </div>
  );
}

function Hero({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 50% at 70% 20%, color-mix(in oklab, var(--color-primary) 18%, transparent) 0%, transparent 60%), radial-gradient(40% 40% at 20% 80%, color-mix(in oklab, var(--color-primary) 10%, transparent) 0%, transparent 60%)",
        }}
      />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-20 md:grid-cols-[1.1fr_0.9fr] md:py-28">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-block rounded-full border border-border/80 bg-muted/50 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
          >
            {t.hero_eyebrow}
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-5 text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl"
          >
            {t.hero_title}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-5 max-w-xl text-lg text-muted-foreground"
          >
            {t.hero_sub}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button asChild size="lg">
              <Link to="/app">{t.hero_cta}</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <a href="#features">{t.hero_secondary}</a>
            </Button>
          </motion.div>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

function HeroVisual() {
  const bars = Array.from({ length: 56 });
  return (
    <div className="relative">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="rounded-2xl border border-border/80 bg-card/60 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)] grain-overlay"
      >
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono">interview.mp4</span>
          <span className="font-mono tabular-nums">00:14:32</span>
        </div>
        <div className="mt-4 flex h-28 items-end gap-[3px]">
          {bars.map((_, i) => {
            const silent = i % 9 === 3 || i % 9 === 4 || i === 22 || i === 23 || i === 41;
            const h = silent ? 8 : 20 + Math.abs(Math.sin(i * 1.3)) * 70;
            return (
              <motion.span
                key={i}
                initial={{ scaleY: 0.2, opacity: 0 }}
                animate={{ scaleY: 1, opacity: silent ? 0.2 : 1 }}
                transition={{ duration: 0.4, delay: 0.4 + i * 0.012 }}
                className={`flex-1 origin-bottom rounded-sm ${silent ? "bg-muted-foreground/30" : "bg-foreground/80"}`}
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> silent
            <span className="ml-3 h-2 w-2 rounded-full bg-foreground/80" /> voice
          </div>
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4 }}
            className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary tabular-nums"
          >
            −4:18 trimmed
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}

function Features({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  const items = [
    { num: "01", title: t.feat_1_t, desc: t.feat_1_d },
    { num: "02", title: t.feat_2_t, desc: t.feat_2_d },
    { num: "03", title: t.feat_3_t, desc: t.feat_3_d },
  ];
  return (
    <section id="features" className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">{t.feat_title}</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {items.map((it, i) => (
            <motion.div
              key={it.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              className="rounded-xl border border-border/80 bg-card/60 p-6"
            >
              <span className="font-mono text-[11px] tracking-widest text-primary">{it.num}</span>
              <h3 className="mt-3 text-lg font-semibold">{it.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{it.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Impact({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">{t.impact_t}</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border/80 bg-card/40 p-6">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {t.impact_before}
            </div>
            <ul className="mt-4 space-y-3">
              {t.impact_before_list.map((line) => (
                <li key={line} className="flex items-center gap-3 text-sm text-muted-foreground/90">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" /> {line}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-2xl font-semibold text-muted-foreground">~ 1–2h</p>
          </div>
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
            <div className="text-[11px] uppercase tracking-[0.18em] text-primary">
              {t.impact_after}
            </div>
            <ul className="mt-4 space-y-3">
              {t.impact_after_list.map((line) => (
                <li key={line} className="flex items-center gap-3 text-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {line}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-2xl font-semibold text-primary">~ minutos</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function CtaStrip({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-4xl px-4 text-center">
        <h2 className="text-4xl font-semibold tracking-tight">{t.hero_title}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">{t.hero_sub}</p>
        <Button asChild size="lg" className="mt-8">
          <Link to="/app">{t.hero_cta}</Link>
        </Button>
      </div>
    </section>
  );
}
