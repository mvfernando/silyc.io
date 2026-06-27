ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.project_versions REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.project_versions;