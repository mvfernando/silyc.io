<p align="center">
  <img src="docs/logo.png" alt="silyc." width="280" />
</p>

<p align="center">
  <strong>Open-source AI post-production for video editors.</strong><br/>
  Word-accurate silence removal, broadcast-grade audio mastering, and precise cuts — straight in the browser.
</p>

<p align="center">
  <a href="https://silycio.lovable.app"><img alt="Live demo" src="https://img.shields.io/badge/demo-silycio.app-FF7A1A?style=flat-square" /></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-0b0b0c?style=flat-square" />
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-0b0b0c?style=flat-square" />
  <img alt="Stack" src="https://img.shields.io/badge/TanStack_Start-React_19-0b0b0c?style=flat-square" />
</p>

---

## Why silyc.

Editors spend hours on the boring parts: trimming dead air, cleaning noisy room tone, normalizing levels. silyc. automates that loop with a transparent, inspectable pipeline — no black box, no upload-and-pray. The core engine runs in your browser via **FFmpeg.wasm**, so your footage never has to leave your machine. Heavier jobs (AI denoise, transcription, cloud render) escalate to opt-in providers only when the material actually needs it.

Built to be hackable. Every step of the pipeline is a discrete task you can read, replace, or extend.

## Features

- **Word-accurate silence detection** with WhisperX, plus a heuristic SNR fallback that runs fully offline.
- **Precise cuts** with configurable padding and audio fade-in to kill clicks at edit points.
- **Pro audio mastering** — FFmpeg chain `highpass → afftdn → dynaudnorm → loudnorm` targeting −14 LUFS.
- **Tiered denoise** — local FFmpeg first, then Replicate → fal.ai with retry/backoff for hard cases.
- **A/B preview** — synchronized side-by-side and slider modes, fullscreen.
- **Project history** — versions, configs, and public execution logs per project.
- **Session recovery** — `localStorage` snapshot + `beforeunload` guard so you don't lose a run.
- **Realtime status**, **i18n** (EN/PT), and server-side **rate limits + quotas**.

## Architecture

```text
┌──────────────┐   upload    ┌─────────────────────┐
│  Browser UI  │ ──────────► │ PostProductionAgent │
│   (React)    │             │  ├─ AnalyzeAudio    │
└──────┬───────┘             │  ├─ DetectSilence   │
       │                     │  ├─ CutTimeline     │
       │ Realtime            │  ├─ MasterAudio     │
       ▼                     │  └─ Export          │
┌──────────────┐             └──────┬──────────────┘
│   Backend    │ ◄── server fns ────┤
│ (Postgres,   │                    │ cloud fallback
│  Auth, RT)   │                    ▼
└──────────────┘         ┌─────────────────────┐
                         │ Replicate · fal.ai  │
                         │      Shotstack      │
                         └─────────────────────┘
```

## Tech stack

**Frontend** — TanStack Start v1 (React 19, SSR + server functions), Vite 7, Tailwind CSS v4, shadcn/ui + Radix, TanStack Query, `motion` for 60fps animations, Syne + Plus Jakarta Sans.

**Video engine** — `@ffmpeg/ffmpeg` 0.12 (WASM, served locally). Unified pipeline via `PostProductionAgent` composed of discrete `TaskRunner`s.

**Backend** — Postgres with RLS, Google OAuth + email/password, 1 GB Storage, Realtime channels, and authenticated server functions. The deployed instance uses managed Postgres; self-hosters can point at any Supabase-compatible stack.

**AI & render providers** — Replicate (`victor-upmeet/whisperx`, `resemble-ai/resemble-enhance`), fal.ai (denoise fallback), Shotstack (optional cloud render).

## Repository layout

```text
src/
├─ routes/              # File-based routing (TanStack)
│  ├─ __root.tsx        # HTML shell + providers
│  ├─ index.tsx         # Landing
│  ├─ app.tsx           # Workspace (upload + processing)
│  ├─ _authenticated/   # Protected routes (projects, admin)
│  └─ api/public/       # Webhooks / health checks
├─ components/          # UI (shadcn + custom)
├─ lib/
│  ├─ agent/            # PostProductionAgent + tasks
│  ├─ ffmpeg-processor.ts
│  ├─ cloud-denoise.ts
│  ├─ resume-store.ts
│  ├─ credits.ts
│  └─ i18n.tsx
└─ integrations/supabase/  # Auto-generated — do not edit
```

## Getting started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (or Node 20 + npm/pnpm)
- A Supabase project (free tier is enough) — or any Postgres + PostgREST + GoTrue stack
- Optional: Replicate, fal.ai, and Shotstack accounts for cloud features

### 1. Clone and install

```bash
git clone https://github.com/mvfernando/silyc.git
cd silyc
bun install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```bash
# Public (client-safe)
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon-key>
VITE_SUPABASE_PROJECT_ID=<project-id>

# Server-only (never exposed to the client)
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
REPLICATE_API_TOKEN=<optional>
FAL_KEY=<optional>
SHOTSTACK_API_KEY=<optional>
```

### 3. Apply database migrations

```bash
supabase link --project-ref <your-ref>
supabase db push
```

Migrations live in `supabase/migrations/` and create every table, RLS policy, and security-definer function the app needs.

### 4. Run the dev server

```bash
bun run dev
```

Open <http://localhost:8080>.

### Health check

```bash
curl http://localhost:8080/api/public/health/denoise
```

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server |
| `bun run build` | Production build |
| `bun run build:dev` | Preview build |
| `bun run lint` | ESLint |
| `bunx vitest run` | Unit + integration tests |

## Security

- Every sensitive server function is wrapped in `requireSupabaseAuth`.
- `has_role` lives in a private schema (no client-exposed RPC).
- HIBP password protection enabled; anonymous sign-ins disabled.
- Postgres-backed rate limiting + per-user `integration_caps`.
- Service-role key is read inside server handlers only — never bundled to the client.

Found something concerning? See **Security** below to report privately.

## Roadmap

- [ ] Server-side persisted jobs (truly leave-and-come-back)
- [ ] Restructure `/app` → `/projects/new`
- [ ] Email notification on completion
- [ ] Cinematic color grading
- [ ] Self-hosted Docker compose for the full stack

## Contributing

silyc. is fully open source and PRs are very welcome. You do **not** need any proprietary tooling to contribute — clone, install, and you're ready.

### Workflow

1. Fork the repo and create a feature branch: `git checkout -b feat/my-thing`.
2. Follow the **Getting started** steps above.
3. Keep changes focused. One PR = one concern.
4. Run `bun run lint` and `bunx vitest run` before pushing.
5. Open a PR against `main` with a clear description, screenshots for UI work, and any migration notes.

### Good first issues

- New audio mastering presets (podcast, music, dialogue)
- Additional language for i18n (`src/lib/i18n.tsx`)
- New `TaskRunner` (e.g. captions burn-in, chapter detection)
- Docs improvements

### Code style

- TypeScript strict mode, no `any` without a comment.
- Functional React, hooks, shadcn primitives.
- Tailwind tokens via `src/styles.css` — never hardcode colors in components.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).

### Reporting bugs

Open an issue with reproduction steps, the source video duration/codec when relevant, and browser console logs. For runtime errors, the public log link from the project page is gold.

## Security disclosure

Please **do not** open public issues for vulnerabilities. Email <email@mvfernando.rf.gd> with details and we'll coordinate a fix and disclosure timeline.

## Community & contact

- Maintainer: **Elio Fernandes** — <email@mvfernando.rf.gd>
- Twitter / X: [@mvfernando_](https://x.com/mvfernando_)
- Issues & discussions: GitHub

## License

[MIT](LICENSE) © mvfernando and silyc. contributors.
