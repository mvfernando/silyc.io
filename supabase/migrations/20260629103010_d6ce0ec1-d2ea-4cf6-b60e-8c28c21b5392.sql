
-- 1) integration_caps table
CREATE TABLE IF NOT EXISTS public.integration_caps (
  integration text PRIMARY KEY,
  hour_limit int NOT NULL CHECK (hour_limit > 0),
  day_limit int NOT NULL CHECK (day_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.integration_caps TO authenticated;
GRANT ALL ON public.integration_caps TO service_role;

ALTER TABLE public.integration_caps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "caps_read_authenticated" ON public.integration_caps;
CREATE POLICY "caps_read_authenticated" ON public.integration_caps
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "caps_admin_write" ON public.integration_caps;
CREATE POLICY "caps_admin_write" ON public.integration_caps
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_integration_caps_updated
  BEFORE UPDATE ON public.integration_caps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.integration_caps(integration, hour_limit, day_limit) VALUES
  ('replicate', 30, 200),
  ('fal', 30, 200),
  ('shotstack', 10, 50)
ON CONFLICT (integration) DO NOTHING;

-- 2) Rewrite check_and_record_usage: caps fallback + advisory lock for atomicity
CREATE OR REPLACE FUNCTION private.check_and_record_usage(
  _user_id uuid,
  _integration text,
  _hour_limit integer DEFAULT NULL,
  _day_limit integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _hour_count int;
  _day_count int;
  _hl int;
  _dl int;
BEGIN
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  -- Resolve effective limits: explicit override > integration_caps row > sane default
  SELECT c.hour_limit, c.day_limit INTO _hl, _dl
  FROM public.integration_caps c
  WHERE c.integration = _integration;

  _hl := coalesce(_hour_limit, _hl, 30);
  _dl := coalesce(_day_limit, _dl, 200);

  -- Serialize concurrent calls per (user, integration) for atomic check+insert.
  -- Two int32 keys derived from the inputs avoid collisions across users.
  PERFORM pg_advisory_xact_lock(
    hashtext(_user_id::text),
    hashtext(_integration)
  );

  SELECT count(*) INTO _hour_count
  FROM public.integration_usage
  WHERE user_id = _user_id AND integration = _integration
    AND called_at > now() - interval '1 hour';

  IF _hour_count >= _hl THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'hour_limit',
      'hour_count', _hour_count, 'hour_limit', _hl,
      'day_count', NULL, 'day_limit', _dl);
  END IF;

  SELECT count(*) INTO _day_count
  FROM public.integration_usage
  WHERE user_id = _user_id AND integration = _integration
    AND called_at > now() - interval '1 day';

  IF _day_count >= _dl THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'day_limit',
      'hour_count', _hour_count, 'hour_limit', _hl,
      'day_count', _day_count, 'day_limit', _dl);
  END IF;

  INSERT INTO public.integration_usage (user_id, integration)
  VALUES (_user_id, _integration);

  RETURN jsonb_build_object('allowed', true,
    'hour_count', _hour_count + 1, 'hour_limit', _hl,
    'day_count', _day_count + 1, 'day_limit', _dl);
END;
$$;

REVOKE ALL ON FUNCTION private.check_and_record_usage(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.check_and_record_usage(uuid, text, integer, integer) TO service_role;

-- 3) Helper to read remaining quota for the caller (used by header chip and 429 UI)
CREATE OR REPLACE FUNCTION private.get_quota(_user_id uuid, _integration text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _hl int; _dl int; _h int; _d int;
BEGIN
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('reason','unauthenticated');
  END IF;
  SELECT c.hour_limit, c.day_limit INTO _hl, _dl
  FROM public.integration_caps c WHERE c.integration = _integration;
  _hl := coalesce(_hl, 30);
  _dl := coalesce(_dl, 200);

  SELECT count(*) INTO _h FROM public.integration_usage
   WHERE user_id=_user_id AND integration=_integration
     AND called_at > now() - interval '1 hour';
  SELECT count(*) INTO _d FROM public.integration_usage
   WHERE user_id=_user_id AND integration=_integration
     AND called_at > now() - interval '1 day';

  RETURN jsonb_build_object(
    'hour_used', _h, 'hour_limit', _hl,
    'day_used', _d, 'day_limit', _dl
  );
END;
$$;

REVOKE ALL ON FUNCTION private.get_quota(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_quota(uuid, text) TO service_role;
