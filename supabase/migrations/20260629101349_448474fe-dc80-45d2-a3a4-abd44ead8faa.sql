
-- Profiles table for user preferences
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  preferred_language text NOT NULL DEFAULT 'pt' CHECK (preferred_language IN ('pt','en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Rate limiting table (per user, per integration, time-windowed)
CREATE TABLE public.integration_usage (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_integration_usage_user_int_time
  ON public.integration_usage (user_id, integration, called_at DESC);

GRANT SELECT, INSERT ON public.integration_usage TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.integration_usage_id_seq TO authenticated;
GRANT ALL ON public.integration_usage TO service_role;
GRANT ALL ON SEQUENCE public.integration_usage_id_seq TO service_role;

ALTER TABLE public.integration_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_select_own" ON public.integration_usage
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "usage_insert_own" ON public.integration_usage
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Atomic check + record in one SECURITY DEFINER call
CREATE OR REPLACE FUNCTION public.check_and_record_usage(
  _integration text,
  _hour_limit int,
  _day_limit int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _hour_count int;
  _day_count int;
BEGIN
  IF _uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  SELECT count(*) INTO _hour_count
  FROM public.integration_usage
  WHERE user_id = _uid AND integration = _integration
    AND called_at > now() - interval '1 hour';

  IF _hour_count >= _hour_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'hour_limit',
      'hour_count', _hour_count, 'hour_limit', _hour_limit);
  END IF;

  SELECT count(*) INTO _day_count
  FROM public.integration_usage
  WHERE user_id = _uid AND integration = _integration
    AND called_at > now() - interval '1 day';

  IF _day_count >= _day_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'day_limit',
      'day_count', _day_count, 'day_limit', _day_limit);
  END IF;

  INSERT INTO public.integration_usage (user_id, integration)
  VALUES (_uid, _integration);

  RETURN jsonb_build_object('allowed', true,
    'hour_count', _hour_count + 1, 'day_count', _day_count + 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_and_record_usage(text,int,int) FROM public;
GRANT EXECUTE ON FUNCTION public.check_and_record_usage(text,int,int) TO authenticated;

-- Backfill profiles for existing users
INSERT INTO public.profiles (id)
SELECT id FROM auth.users
ON CONFLICT (id) DO NOTHING;
