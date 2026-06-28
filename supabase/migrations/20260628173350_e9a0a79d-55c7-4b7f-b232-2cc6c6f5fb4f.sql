CREATE TABLE public.transcriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  file_hash text NOT NULL,
  model text NOT NULL DEFAULT 'openai/whisper',
  language text,
  duration_sec numeric,
  text text,
  chunks jsonb NOT NULL DEFAULT '[]'::jsonb,
  prediction_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, file_hash, model)
);

CREATE INDEX transcriptions_user_hash_idx ON public.transcriptions (user_id, file_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transcriptions TO authenticated;
GRANT ALL ON public.transcriptions TO service_role;

ALTER TABLE public.transcriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own transcriptions" ON public.transcriptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own transcriptions" ON public.transcriptions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own transcriptions" ON public.transcriptions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own transcriptions" ON public.transcriptions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER transcriptions_set_updated_at
  BEFORE UPDATE ON public.transcriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();