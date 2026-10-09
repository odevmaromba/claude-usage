// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Text that came from the API, the cache file or Claude Code's config, made
 * safe for a terminal: no C0/C1 controls (ESC, BEL, CR: OSC 52, titles, line
 * forgery) and no bidi overrides.
 */
export function stripControl(text: string): string {
  return text.replace(UNSAFE, '');
}
