/**
 * External destinations of the Grok usage surfaces.
 *
 * The Host owns the account endpoints; the Client only needs the human-facing
 * usage console. Opening is guarded because the page may render in
 * environments without a browser window object.
 */

/** Grok subscription usage console. */
export const SUPERGROK_URL = 'https://grok.com/supergrok';

/**
 * Whether a value is a valid absolute http(s) URL.
 * @param value - candidate URL string.
 * @returns true when the value can be opened safely.
 */
export function isSafeUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    // Relative or malformed input is not an external destination.
    return false;
  }
}

/**
 * Open an external destination in a new tab, ignoring a missing window or a
 * blocked popup (callers also render a plain link when the URL is important).
 * @param url - absolute URL.
 * @returns nothing.
 */
export function openExternal(url) {
  if (!isSafeUrl(url)) {
    return;
  }
  try {
    if (typeof window === 'undefined' || window === null) {
      return;
    }
    window.open(url, '_blank', 'noopener');
  } catch {
    // A blocked popup is not an error the page can recover from; the visible
    // fallback link remains available next to the action.
  }
}
