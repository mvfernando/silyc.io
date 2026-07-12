/**
 * Aspect ratio classification & preservation helpers.
 *
 * The whole point of this module: whatever the user uploaded (9:16 vertical
 * from a phone, 16:9 landscape from a camera, 1:1 square social) we detect
 * the *displayed* dimensions here and then propagate them end-to-end so
 * the render pipeline never implicitly stretches, crops, or letterboxes.
 *
 * Kept intentionally free of DOM / FFmpeg dependencies so it is trivially
 * unit-testable and safe to import from both client and server code.
 */

export type AspectRatioLabel =
  | "9:16"
  | "16:9"
  | "1:1"
  | "4:5"
  | "5:4"
  | "4:3"
  | "3:4"
  | "21:9"
  | "other"
  | "unknown";

export type Orientation = "portrait" | "landscape" | "square" | "unknown";

export type AspectClassification = {
  ratio: AspectRatioLabel;
  orientation: Orientation;
  /** Numeric width / height, or null when unknown. */
  numeric: number | null;
};

/** Standard ratios we tag explicitly. Order matters — first close match wins. */
const KNOWN_RATIOS: Array<{ label: Exclude<AspectRatioLabel, "other" | "unknown">; value: number }> = [
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
  { label: "5:4", value: 5 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "21:9", value: 21 / 9 },
];

const TOLERANCE = 0.02;

export function classifyAspect(width: number, height: number): AspectClassification {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ratio: "unknown", orientation: "unknown", numeric: null };
  }
  const numeric = width / height;
  for (const { label, value } of KNOWN_RATIOS) {
    if (Math.abs(numeric - value) < TOLERANCE) {
      return {
        ratio: label,
        orientation:
          Math.abs(numeric - 1) < TOLERANCE
            ? "square"
            : numeric < 1
              ? "portrait"
              : "landscape",
        numeric,
      };
    }
  }
  return {
    ratio: "other",
    orientation: Math.abs(numeric - 1) < TOLERANCE ? "square" : numeric < 1 ? "portrait" : "landscape",
    numeric,
  };
}

/**
 * Map our numeric resolution ceilings to Shotstack's `output.aspectRatio`
 * enum. Returns null when we don't want to force one (i.e. classification
 * failed and we should let Shotstack derive from source).
 */
export function shotstackAspectRatio(label: AspectRatioLabel): string | null {
  switch (label) {
    case "9:16":
      return "9:16";
    case "16:9":
      return "16:9";
    case "1:1":
      return "1:1";
    case "4:5":
      return "4:5";
    case "5:4":
      return "5:4";
    case "4:3":
      return "4:3";
    case "3:4":
      return "3:4";
    default:
      return null;
  }
}