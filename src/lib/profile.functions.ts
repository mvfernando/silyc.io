import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ProfilePrefs = { preferredLanguage: "pt" | "en" };

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProfilePrefs> => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("preferred_language")
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { preferredLanguage: (data?.preferred_language as "pt" | "en") ?? "pt" };
  });

export const updateMyLanguage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { language: "pt" | "en" }) => {
    if (input.language !== "pt" && input.language !== "en") {
      throw new Error("Invalid language");
    }
    return input;
  })
  .handler(async ({ data, context }): Promise<ProfilePrefs> => {
    const { error } = await context.supabase
      .from("profiles")
      .upsert({ id: context.userId, preferred_language: data.language }, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return { preferredLanguage: data.language };
  });