ALTER TABLE public.pipeline_feedback
  ADD COLUMN IF NOT EXISTS audio_profile_used text
    CHECK (audio_profile_used IS NULL OR audio_profile_used IN ('ffmpeg-light','ffmpeg-aggressive','cloud-denoise','skip')),
  ADD COLUMN IF NOT EXISTS audio_snr_db numeric;