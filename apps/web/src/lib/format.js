export const LANGUAGES = [
  { code: "hi", label: "Hindi" },
  { code: "gu", label: "Gujarati" },
  { code: "en", label: "English" },
];

/** 65 → "1:05", 3725 → "1:02:05" */
export function fmtTime(s) {
  if (s == null || !isFinite(s)) return "";
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtDuration(s) {
  if (!s || s < 0) return "";
  const m = Math.round(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m} min` : `${Math.round(s)} s`;
}

/** Text of a line in the chosen script: "roman" | "native". */
export function lineText(line, script) {
  return script === "native" ? line.textNative || line.textRoman : line.textRoman || line.textNative;
}
