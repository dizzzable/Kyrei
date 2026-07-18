/** Converts a resolved browser RGB color into Electron's safe overlay format. */
export function cssColorToHex(value: string): string | null {
  const match = value.trim().match(/^rgba?\(\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)$/i);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}
