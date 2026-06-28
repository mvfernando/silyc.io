CREATE TABLE public.pipeline_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  run_id uuid not null,
  version_id uuid references public.project_versions(id) on delete cascade,
  rating smallint check (rating in (1, 2, 3)),
  refinement_choice text check (refinement_choice in ('none','more_dynamic','more_natural','cut_more','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, run_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_feedback TO authenticated;
GRANT ALL ON public.pipeline_feedback TO service_role;
ALTER TABLE public.pipeline_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own feedback select" ON public.pipeline_feedback
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own feedback insert" ON public.pipeline_feedback
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own feedback update" ON public.pipeline_feedback
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own feedback delete" ON public.pipeline_feedback
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TRIGGER pipeline_feedback_set_updated_at
  BEFORE UPDATE ON public.pipeline_feedback
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();