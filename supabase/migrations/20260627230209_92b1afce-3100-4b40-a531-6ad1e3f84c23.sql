CREATE TABLE public.audio_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  prediction_id text,
  status text NOT NULL DEFAULT 'running',
  attempt integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  error text,
  version_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audio_jobs_project_idx ON public.audio_jobs (project_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.audio_jobs TO authenticated;
GRANT ALL ON public.audio_jobs TO service_role;

ALTER TABLE public.audio_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_jobs REPLICA IDENTITY FULL;

CREATE POLICY "users read own audio jobs" ON public.audio_jobs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own audio jobs" ON public.audio_jobs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own audio jobs" ON public.audio_jobs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own audio jobs" ON public.audio_jobs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER set_audio_jobs_updated_at
  BEFORE UPDATE ON public.audio_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
