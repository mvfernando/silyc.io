
-- 1. Roles enum + table
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 2. has_role security definer
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

-- 3. Admin access to all roles (for admin dashboard listing)
CREATE POLICY "admins read all roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 4. Add format column to pipeline_feedback
ALTER TABLE public.pipeline_feedback
  ADD COLUMN format text;

ALTER TABLE public.pipeline_feedback
  ADD CONSTRAINT pipeline_feedback_format_check
  CHECK (format IS NULL OR format = ANY (ARRAY['podcast','interview','vlog','short','unknown']));

-- 5. Admin SELECT policy on pipeline_feedback (for analytics)
CREATE POLICY "admins read all feedback" ON public.pipeline_feedback
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
