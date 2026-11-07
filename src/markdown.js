// Streams model output to the terminal and re-renders each finished line as styled markdown.
import { bold, cyan, gray, italic, magenta, underline, strWidth } from './ui.js';

export class MarkdownStream {
  constructor({ out = process.stdout, bullet = cyan('● '), indent = '  ' } = {}) {
    this.out = out;
    this.bullet = bullet;
    this.indent = indent;
    this.buf = '';
    this.inCode = false;
    this.started = false;
    this.partialWidth = 0;
  }

  get cols() { return Math.max(20, this.out.columns || 80); }

  prefix() {
    const p = this.started ? this.indent : this.bullet;
    this.started = true;
    return p;
  }

  push(text) {
    if (!this.out.isTTY) { this.out.write(text); this.started = true; return; }
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') this.endLine();
      else if (part) {
        if (!this.buf) { this.linePrefix = this.prefix(); this.out.write(this.linePrefix); this.partialWidth = strWidth(this.linePrefix); }
        this.buf += part;
        this.out.write(this.inCode ? part : part);
        this.partialWidth += strWidth(part);
      }
    }
  }

  endLine() {
    if (!this.buf) {
      // Empty line: keep paragraph spacing but avoid a dangling bullet.
      if (this.started) this.out.write('\n');
      return;
    }
    // Rewind over the raw text and print the formatted line.
    const up = Math.floor((this.partialWidth - 1) / this.cols);
    this.out.write((up > 0 ? `\x1b[${up}A` : '') + '\r\x1b[J' + this.linePrefix + this.format(this.buf) + '\n');
    this.buf = '';
    this.partialWidth = 0;
  }

  end() {
    if (!this.out.isTTY) { if (this.started) this.out.write('\n'); return; }
    if (this.buf) this.endLine();
  }

  format(line) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      this.inCode = !this.inCode;
      return gray(this.inCode ? `┌─ ${fence[1].trim() || 'code'}` : '└─');
    }
    if (this.inCode) return gray('│ ') + line;
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) return bold(m[1].length <= 2 ? magenta(inline(m[2])) : inline(m[2]));
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return gray('─'.repeat(Math.min(40, this.cols - 4)));
    if ((m = line.match(/^(\s*)>\s?(.*)$/))) return `${m[1]}${gray('│ ')}${italic(inline(m[2]))}`;
    if ((m = line.match(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/))) {
      const box = m[2] ? (/x/i.test(m[2]) ? '☑ ' : '☐ ') : '';
      return `${m[1]}${cyan('•')} ${box}${inline(m[3])}`;
    }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) return `${m[1]}${cyan(m[2] + '.')} ${inline(m[3])}`;
    return inline(line);
  }
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => bold(b))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, (_, p, i) => p + italic(i))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${underline(t)} ${gray(`(${u})`)}`);
}

/** Indented dim stream for "thinking" output. */
export class ThinkingStream {
  constructor(out = process.stdout) { this.out = out; this.started = false; }
  push(text) {
    if (!this.started) { this.out.write(gray('✻ ')); this.started = true; }
    this.out.write(gray(text.replace(/\n/g, '\n  ')));
  }
  end() { if (this.started) this.out.write('\n'); }
}
