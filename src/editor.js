// A small terminal line editor: live completion menu, multi-line input, history,
// bracketed paste, wide-character (Korean) aware cursor math, and arrow-key selection prompts.
import readline from 'node:readline';
import { cyan, gray, inverse, fitWidth, strWidth, stripAnsi, padEnd } from './ui.js';

const MENU_ROWS = 8;

export class Editor {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.in = input;
    this.out = output;
    this.handler = null;
    this.rowsAbove = 0; // cursor row inside the currently drawn region
    this.drawn = false;
    this.chunk = '';
    this.typeahead = [];
    readline.emitKeypressEvents(input);
    input.prependListener('data', (d) => { this.chunk = String(d); });
    input.on('keypress', (s, key) => this.handler?.(s, key ?? {}));
    input.setRawMode?.(true);
    input.resume();
    this.out.write('\x1b[?2004h'); // bracketed paste
    process.on('exit', () => this.restore());
    this.out.on?.('resize', () => this.drawn && this.redraw?.());
  }

  restore() {
    this.out.write('\x1b[?2004l');
    try { this.in.setRawMode?.(false); } catch {}
  }

  get cols() { return Math.max(20, this.out.columns || 80); }

  /** Clears the drawn region so other output can be printed. */
  clearRegion() {
    if (!this.drawn) return;
    this.out.write((this.rowsAbove ? `\x1b[${this.rowsAbove}A` : '') + '\r\x1b[J');
    this.rowsAbove = 0;
    this.drawn = false;
  }

  /** Print a line above the active prompt/menu, then redraw it. */
  printAbove(text) {
    const active = this.drawn;
    this.clearRegion();
    this.out.write(text + '\n');
    if (active) this.redraw?.();
  }

  /**
   * Draw `lines` as the live region. The cursor is placed at (cursorLine, cursorCol) where
   * cursorCol is a display-column offset inside that line. Returns nothing.
   */
  draw(lines, cursorLine = lines.length - 1, cursorCol = null, final = false) {
    const cols = this.cols;
    let out = (this.rowsAbove ? `\x1b[${this.rowsAbove}A` : '') + '\r\x1b[J';
    let row = 0, targetRow = 0, targetCol = 0;
    lines.forEach((line, i) => {
      const w = strWidth(line);
      if (i === cursorLine) {
        const cw = cursorCol ?? w;
        targetRow = row + Math.floor(cw / cols);
        targetCol = cw % cols;
      }
      out += line;
      if (w > 0 && w % cols === 0) out += ' \r'; // leave the pending-wrap state predictably
      row += Math.floor(w / cols);
      if (i < lines.length - 1) { out += '\r\n'; row += 1; }
    });
    if (final) {
      out += '\r\n';
      this.rowsAbove = 0;
      this.drawn = false;
    } else {
      const up = row - targetRow;
      out += (up > 0 ? `\x1b[${up}A` : '') + '\r' + (targetCol ? `\x1b[${targetCol}C` : '');
      this.rowsAbove = targetRow;
      this.drawn = true;
    }
    this.out.write(out);
  }

  /**
   * Read one input. Resolves with the text, `null` on Ctrl+C with empty input, or `undefined` on Ctrl+D.
   * @param {object} o
   * @param {() => string} o.prompt
   * @param {string[]} o.history  oldest first
   * @param {(ctx:{before:string, text:string}) => ({items:{label:string, value:string, desc?:string, submit?:boolean}[], replace:number}|null)} [o.complete]
   * @param {(text:string) => string[]} [o.footer]  lines under the input when no menu is open
   * @param {() => void} [o.onShiftTab]
   */
  readLine(o) {
    const prevHandler = this.handler;
    return new Promise((resolve) => {
      let chars = o.keepTypeahead === false ? [] : this.typeahead.splice(0);
      let cur = chars.length;
      let histIdx = null, draft = null;
      let menu = null, sel = 0, dismissed = null, historySearch = false;
      let pasting = false, lastWasReturn = false, escAt = 0;

      const text = () => chars.join('');
      const setText = (t) => { chars = Array.from(t); cur = chars.length; };
      const insert = (s) => { const a = Array.from(s); chars.splice(cur, 0, ...a); cur += a.length; };

      const updateMenu = () => {
        const t = text();
        if (dismissed === t) { menu = null; return; }
        dismissed = null;
        const before = chars.slice(0, cur).join('');
        if (historySearch) {
          const q = t.toLowerCase();
          const items = [...new Set([...o.history].reverse())].filter((h) => h.toLowerCase().includes(q))
            .slice(0, 50).map((h) => ({ label: h.replace(/\n/g, ' ⏎ '), value: h }));
          menu = { items, replace: chars.length, title: 'history (ctrl+r)', whole: true };
        } else {
          menu = o.complete?.({ before, text: t }) ?? null;
        }
        if (!menu?.items.length) menu = null;
        if (sel >= (menu?.items.length ?? 0)) sel = 0;
      };

      const accept = (submitIfAsked) => {
        const item = menu.items[sel];
        if (menu.whole) { setText(item.value); }
        else {
          chars.splice(cur - menu.replace, menu.replace, ...Array.from(item.value));
          cur = cur - menu.replace + Array.from(item.value).length;
        }
        historySearch = false;
        const submit = submitIfAsked && item.submit;
        menu = null;
        if (!submit) { updateMenu(); }
        return submit;
      };

      const render = (final = false) => {
        const prompt = o.prompt(text());
        const cont = ' '.repeat(Math.min(strWidth(prompt), 4));
        const lines = text().split('\n').map((l, i) => (i === 0 ? prompt : cont) + colorInput(l, i));
        const beforeLines = chars.slice(0, cur).join('').split('\n');
        const cursorLine = beforeLines.length - 1;
        const cursorCol = strWidth(cursorLine === 0 ? prompt : cont) + strWidth(beforeLines.at(-1));
        if (final) return this.draw(lines, lines.length - 1, null, true);
        const width = this.cols - 1;
        const extra = [];
        if (menu) {
          const start = Math.max(0, Math.min(sel - Math.floor(MENU_ROWS / 2), menu.items.length - MENU_ROWS));
          const visible = menu.items.slice(start, start + MENU_ROWS);
          const labelW = Math.min(28, Math.max(...visible.map((it) => strWidth(it.label))) + 2);
          visible.forEach((it, i) => {
            const active = start + i === sel;
            const label = padEnd(it.label, labelW);
            const line = `${active ? cyan('❯ ') : '  '}${active ? cyan(label) : label}${it.desc ? gray(it.desc) : ''}`;
            extra.push(fitWidth(active ? line : line, width));
          });
          const pos = menu.items.length > MENU_ROWS ? ` ${sel + 1}/${menu.items.length}` : '';
          extra.push(gray(fitWidth(`  ↑↓ 선택 · tab 완성 · enter 실행 · esc 닫기${pos}${menu.title ? ` · ${menu.title}` : ''}`, width)));
        } else {
          for (const l of o.footer?.(text()) ?? []) extra.push(fitWidth(l, width));
        }
        this.draw([...lines, ...extra], cursorLine, cursorCol);
      };
      this.redraw = () => render();

      const finish = (value) => {
        this.handler = prevHandler;
        this.redraw = null;
        menu = null;
        if (value === undefined || value === null) this.clearRegion();
        else render(true);
        resolve(value);
      };

      this.handler = (s, key) => {
        const name = key.name;
        if (name === 'paste-start') { pasting = true; return; }
        if (name === 'paste-end') { pasting = false; updateMenu(); return render(); }
        const pasteLike = pasting || this.chunk.length > 2;

        if (name === 'return' || name === 'enter') {
          if (pasteLike) {
            if (!(name === 'enter' && lastWasReturn)) insert('\n');
            lastWasReturn = name === 'return';
            return render();
          }
          lastWasReturn = false;
          if (key.meta || name === 'enter') { insert('\n'); updateMenu(); return render(); }
          if (menu) {
            // The token is already complete (e.g. "@file.png"): send instead of re-accepting.
            const typed = chars.slice(cur - menu.replace, cur).join('');
            if (!menu.whole && typed === menu.items[sel].value.trimEnd()) return finish(text());
            if (accept(true)) return finish(text());
            return render();
          }
          if (chars[cur - 1] === '\\') { chars.splice(cur - 1, 1, '\n'); return render(); }
          if (text() === '?') { setText(''); return render(); }
          return finish(text());
        }
        lastWasReturn = false;

        if (key.ctrl && name === 'c') {
          if (chars.length) { setText(''); historySearch = false; updateMenu(); return render(); }
          return finish(null);
        }
        if (key.ctrl && name === 'd') { if (!chars.length) return finish(undefined); }
        if (name === 'escape') {
          if (menu || historySearch) { dismissed = text(); historySearch = false; menu = null; return render(); }
          if (chars.length && Date.now() - escAt < 600) { setText(''); escAt = 0; updateMenu(); return render(); }
          escAt = Date.now();
          return;
        }
        if (key.shift && name === 'tab') { o.onShiftTab?.(); return render(); }
        if (name === 'tab') { if (menu) accept(false); return render(); }
        if (key.ctrl && name === 'r') { historySearch = true; sel = 0; updateMenu(); return render(); }
        if (key.ctrl && name === 'l') { this.clearRegion(); this.out.write('\x1b[2J\x1b[H'); return render(); }

        if (name === 'up' || name === 'down') {
          if (menu) {
            const n = menu.items.length;
            sel = (sel + (name === 'up' ? n - 1 : 1)) % n;
            return render();
          }
          const lines = text().split('\n');
          const curLine = chars.slice(0, cur).join('').split('\n').length - 1;
          if (lines.length > 1 && ((name === 'up' && curLine > 0) || (name === 'down' && curLine < lines.length - 1))) {
            const col = Array.from(chars.slice(0, cur).join('').split('\n').at(-1)).length;
            const target = curLine + (name === 'up' ? -1 : 1);
            let idx = 0;
            for (let i = 0; i < target; i++) idx += Array.from(lines[i]).length + 1;
            cur = idx + Math.min(col, Array.from(lines[target]).length);
            return render();
          }
          if (!o.history.length) return;
          if (name === 'up') {
            if (histIdx === null) { draft = text(); histIdx = o.history.length; }
            if (histIdx > 0) histIdx--;
            setText(o.history[histIdx]);
          } else {
            if (histIdx === null) return;
            histIdx++;
            if (histIdx >= o.history.length) { histIdx = null; setText(draft ?? ''); } else setText(o.history[histIdx]);
          }
          dismissed = text();
          menu = null;
          return render();
        }

        if (name === 'left') { cur = key.ctrl || key.meta ? wordLeft(chars, cur) : Math.max(0, cur - 1); return render(); }
        if (name === 'right') { cur = key.ctrl || key.meta ? wordRight(chars, cur) : Math.min(chars.length, cur + 1); return render(); }
        if (name === 'home' || (key.ctrl && name === 'a')) { cur = lineStart(chars, cur); return render(); }
        if (name === 'end' || (key.ctrl && name === 'e')) { cur = lineEnd(chars, cur); return render(); }

        let changed = false;
        if (name === 'backspace') {
          if (key.ctrl || key.meta) { const to = wordLeft(chars, cur); chars.splice(to, cur - to); cur = to; }
          else if (cur > 0) { chars.splice(cur - 1, 1); cur--; }
          changed = true;
        } else if (name === 'delete') {
          chars.splice(cur, 1); changed = true;
        } else if (key.ctrl && name === 'u') {
          const st = lineStart(chars, cur); chars.splice(st, cur - st); cur = st; changed = true;
        } else if (key.ctrl && name === 'k') {
          chars.splice(cur, lineEnd(chars, cur) - cur); changed = true;
        } else if (key.ctrl && name === 'w') {
          const to = wordLeft(chars, cur); chars.splice(to, cur - to); cur = to; changed = true;
        } else if (s && !key.ctrl && !key.meta && !/^[\x00-\x08\x0b-\x1f\x7f]$/.test(s) && !s.startsWith('\x1b')) {
          insert(s.replace(/\r\n?/g, '\n')); changed = true;
        }
        if (changed) {
          histIdx = null;
          if (!pasting) { updateMenu(); render(); }
        }
      };

      updateMenu();
      render();
    });
  }

  /**
   * Arrow-key selection. Resolves with the chosen index, or -1 on Esc / Ctrl+C.
   * items: [{label, hint?}]
   */
  select(title, items, { initial = 0, detail = [] } = {}) {
    const prev = this.handler;
    return new Promise((resolve) => {
      let sel = initial;
      const render = () => {
        const w = this.cols - 1;
        const lines = [...detail.map((l) => fitWidth(l, w)), fitWidth(title, w)];
        items.forEach((it, i) => {
          const label = `${i + 1}. ${it.label}`;
          lines.push(fitWidth(i === sel ? cyan(`❯ ${label}`) : `  ${label}`, w) + (it.hint ? gray(` ${it.hint}`) : ''));
        });
        lines.push(gray(fitWidth('  ↑↓ 이동 · enter 선택 · 숫자 바로 선택 · esc 취소', w)));
        this.draw(lines, lines.length - 1, 0);
      };
      this.redraw = render;
      const done = (i) => {
        this.clearRegion();
        this.handler = prev;
        this.redraw = null;
        resolve(i);
      };
      this.handler = (s, key) => {
        if (key.name === 'up') { sel = (sel + items.length - 1) % items.length; return render(); }
        if (key.name === 'down' || key.name === 'tab') { sel = (sel + 1) % items.length; return render(); }
        if (key.name === 'return') return done(sel);
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(-1);
        const n = Number(s);
        if (n >= 1 && n <= items.length) return done(n - 1);
      };
      render();
    });
  }

  /**
   * While the agent works: Esc / Ctrl+C call onAbort; other typing is kept for the next prompt.
   * Returns a function that stops watching.
   */
  watch(onAbort) {
    this.handler = (s, key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return onAbort();
      if (key.name === 'backspace') { this.typeahead.pop(); return; }
      if (s && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/u.test(s)) this.typeahead.push(...Array.from(s));
    };
    return () => { this.handler = null; };
  }
}

function colorInput(line, i) {
  if (i !== 0) return line;
  if (line.startsWith('!')) return line;
  // Highlight a leading slash command and @mentions.
  return line
    .replace(/^(\/\S+)/, (m) => cyan(m))
    .replace(/(^|\s)(@\S+)/g, (m, sp, at) => sp + cyan(at));
}

const isWord = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
function wordLeft(chars, cur) {
  let i = cur;
  while (i > 0 && !isWord(chars[i - 1])) i--;
  while (i > 0 && isWord(chars[i - 1])) i--;
  return i;
}
function wordRight(chars, cur) {
  let i = cur;
  while (i < chars.length && !isWord(chars[i])) i++;
  while (i < chars.length && isWord(chars[i])) i++;
  return i;
}
function lineStart(chars, cur) {
  let i = cur;
  while (i > 0 && chars[i - 1] !== '\n') i--;
  return i;
}
function lineEnd(chars, cur) {
  let i = cur;
  while (i < chars.length && chars[i] !== '\n') i++;
  return i;
}

export { stripAnsi };
