
CREATE TABLE public.project_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  label TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  export_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_path TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'done',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_versions TO authenticated;
GRANT ALL ON public.project_versions TO service_role;

ALTER TABLE public.project_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own versions" ON public.project_versions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own versions" ON public.project_versions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own versions" ON public.project_versions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own versions" ON public.project_versions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX project_versions_project_id_idx ON public.project_versions (project_id, created_at DESC);
