const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close = 0) => (s) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);
export const bgRed = wrap('48;5;52', 49);
export const bgGreen = wrap('48;5;22', 49);

export const write = (s) => process.stdout.write(s);
export const println = (s = '') => process.stdout.write(s + '\n');

export function truncate(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[${s.length - max} chars truncated]`;
}

export function oneLine(s, max = 120) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------- terminal width helpers (Korean/CJK and emoji take two columns) ----------

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g, '');

export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Cut a (possibly colored) string to at most `max` columns. */
export function fitWidth(s, max) {
  if (strWidth(s) <= max) return s;
  let out = '', w = 0;
  const re = /(\x1b\[[0-9;?]*[A-Za-z])|([\s\S])/gu;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { out += m[1]; continue; }
    const cw = charWidth(m[2].codePointAt(0));
    if (w + cw > max - 1) break;
    out += m[2];
    w += cw;
  }
  return out + '…\x1b[0m';
}

export const padEnd = (s, width) => s + ' '.repeat(Math.max(0, width - strWidth(s)));

export function box(lines, color = gray) {
  const inner = Math.max(...lines.map(strWidth)) + 2;
  return [
    color(`╭${'─'.repeat(inner)}╮`),
    ...lines.map((l) => `${color('│')} ${padEnd(l, inner - 2)} ${color('│')}`),
    color(`╰${'─'.repeat(inner)}╯`),
  ].join('\n');
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(text) {
  if (!tty) return { stop() {}, set() {} };
  let i = 0;
  const start = Date.now();
  const render = () => {
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r\x1b[2K${cyan(FRAMES[i++ % FRAMES.length])} ${dim(`${text} (${secs}s · esc 중단)`)}`);
  };
  render();
  const timer = setInterval(render, 100);
  return {
    set(t) { text = t; },
    stop() {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
  };
}
