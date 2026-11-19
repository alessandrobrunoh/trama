// Quoted replies: a comment that starts with a markdown quote (`> text`) answers that text.

/**
 * Splits a comment into its leading quote and the reply. Without a leading quote `quote` is null and `rest`
 * is the whole body.
 */
export function splitQuote(body: string): { quote: string | null; rest: string } {
  const lines = body.split('\n');
  let n = 0;
  while (n < lines.length && /^\s{0,3}>/.test(lines[n])) n++;
  if (n === 0) return { quote: null, rest: body };
  const quote = lines
    .slice(0, n)
    .map((l) => l.replace(/^\s{0,3}>\s?/, ''))
    .join('\n')
    .trim();
  const rest = lines.slice(n).join('\n').trim();
  return quote ? { quote, rest } : { quote: null, rest: body };
}

/** `text` as a markdown quote block, ready to start a reply with. */
export function toQuote(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n')}\n\n`;
}
