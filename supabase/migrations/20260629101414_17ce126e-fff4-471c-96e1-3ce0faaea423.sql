
CREATE SCHEMA IF NOT EXISTS private;

-- Move check_and_record_usage to private; accept explicit user_id
DROP FUNCTION IF EXISTS public.check_and_record_usage(text,int,int);

CREATE OR REPLACE FUNCTION private.check_and_record_usage(
  _user_id uuid,
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
  _hour_count int;
  _day_count int;
BEGIN
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  SELECT count(*) INTO _hour_count
  FROM public.integration_usage
  WHERE user_id = _user_id AND integration = _integration
    AND called_at > now() - interval '1 hour';

  IF _hour_count >= _hour_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'hour_limit',
      'hour_count', _hour_count, 'hour_limit', _hour_limit);
  END IF;

  SELECT count(*) INTO _day_count
  FROM public.integration_usage
  WHERE user_id = _user_id AND integration = _integration
    AND called_at > now() - interval '1 day';

  IF _day_count >= _day_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'day_limit',
      'day_count', _day_count, 'day_limit', _day_limit);
  END IF;

  INSERT INTO public.integration_usage (user_id, integration)
  VALUES (_user_id, _integration);

  RETURN jsonb_build_object('allowed', true,
    'hour_count', _hour_count + 1, 'day_count', _day_count + 1);
END;
$$;

REVOKE ALL ON FUNCTION private.check_and_record_usage(uuid,text,int,int) FROM public;
GRANT EXECUTE ON FUNCTION private.check_and_record_usage(uuid,text,int,int) TO service_role;

-- Move handle_new_user to private (the trigger keeps working because triggers reference functions by qualified name)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION private.handle_new_user()
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

REVOKE ALL ON FUNCTION private.handle_new_user() FROM public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();
