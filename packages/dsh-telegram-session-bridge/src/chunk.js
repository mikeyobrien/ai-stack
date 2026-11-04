/** Telegram's hard text limit, in UTF-16 code units. */
export const TELEGRAM_MAX_TEXT = 4096;

/**
 * Hard-split one oversized run by code points, counting UTF-16 units so a
 * surrogate pair never straddles a chunk boundary.
 */
function hardSplit(text, limit) {
  const pieces = [];
  let current = '';
  let units = 0;
  for (const codePoint of text) {
    const width = codePoint.length;
    if (units > 0 && units + width > limit) {
      pieces.push(current);
      current = '';
      units = 0;
    }
    current += codePoint;
    units += width;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Split assistant text into Telegram-sized chunks. Joining the result always
 * reproduces the input; boundaries prefer a newline inside the limit so
 * paragraphs and fenced blocks stay together when they fit.
 */
export function chunkText(text, limit = TELEGRAM_MAX_TEXT) {
  if (typeof text !== 'string') text = text === undefined || text === null ? '' : String(text);
  if (!(Number.isSafeInteger(limit) && limit > 0)) throw new RangeError('chunk limit must be a positive integer');
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  const lines = text.split(/(?<=\n)/);
  let current = '';

  const pushCurrent = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const line of lines) {
    if (line.length > limit) {
      pushCurrent();
      const pieces = hardSplit(line, limit);
      for (let index = 0; index < pieces.length - 1; index += 1) chunks.push(pieces[index]);
      current = pieces[pieces.length - 1] ?? '';
      continue;
    }
    if (current.length + line.length > limit) pushCurrent();
    current += line;
  }
  pushCurrent();
  return chunks;
}
