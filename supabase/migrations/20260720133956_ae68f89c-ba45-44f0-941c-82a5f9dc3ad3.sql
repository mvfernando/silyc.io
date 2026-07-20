DROP POLICY IF EXISTS "caps_read_authenticated" ON public.integration_caps;
CREATE POLICY "caps_read_admin" ON public.integration_caps
  FOR SELECT TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::public.app_role));