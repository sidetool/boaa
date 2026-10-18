/** Formatting-only lines have no speech; punctuation remains meaningful content. */
export function hasSpokenContent(text: string): boolean {
  return text.replace(/[\s\p{Cf}]/gu, '').length > 0;
}
