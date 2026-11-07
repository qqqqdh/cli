// Image support: vision-model discovery, describing images, and clipboard capture.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { listModels, modelCapabilities, OllamaError, ollamaFetch } from './ollama.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
export const IMAGES_DIR = path.join(CONFIG_DIR, 'images');
export const SUGGESTED_VISION_MODELS = ['qwen2.5vl:7b', 'gemma3:4b', 'llama3.2-vision:11b'];

export const isImagePath = (p) => IMAGE_EXT.has(path.extname(p).toLowerCase());

export function readImageBase64(file) {
  const st = fs.statSync(file);
  if (st.size > 20_000_000) throw new Error(`이미지가 너무 큽니다 (${(st.size / 1e6).toFixed(1)}MB, 최대 20MB)`);
  return fs.readFileSync(file).toString('base64');
}

let visionCache;
/** Picks config.visionModel, else the current model if it sees images, else any installed vision model. */
export async function findVisionModel(config) {
  if (config.visionModel) return config.visionModel;
  const caps = await modelCapabilities(config.ollamaHost, config.model);
  if (caps?.includes('vision')) return config.model;
  if (visionCache !== undefined) return visionCache;
  visionCache = null;
  try {
    for (const m of await listModels(config.ollamaHost)) {
      if ((await modelCapabilities(config.ollamaHost, m.name))?.includes('vision')) { visionCache = m.name; break; }
    }
  } catch {}
  return visionCache;
}

export function noVisionModelMessage() {
  return `이미지를 읽을 수 있는 비전 모델이 설치되어 있지 않습니다. 예: \`ollama pull ${SUGGESTED_VISION_MODELS[0]}\` ` +
    `(또는 ${SUGGESTED_VISION_MODELS.slice(1).join(', ')}). 설치 후 자동으로 사용되며, 설정의 "visionModel"로 지정할 수도 있습니다.`;
}

export async function describeImages({ config, files, prompt, signal }) {
  const model = await findVisionModel(config);
  if (!model) throw new Error(noVisionModelMessage());
  const images = files.map(readImageBase64);
  const res = await ollamaFetch(`${config.ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: config.keepAlive,
      options: { temperature: 0.1, num_ctx: Math.max(config.numCtx, 8192) },
      messages: [{
        role: 'user',
        content: prompt || 'Describe this image in detail. Transcribe all visible text exactly. If it is a screenshot of code, an error or a UI, reproduce the important content.',
        images,
      }],
    }),
  });
  if (!res.ok) throw new OllamaError(`Ollama ${res.status}: ${await res.text()}`, res.status);
  const json = await res.json();
  return { model, text: json.message?.content ?? '' };
}

/** Saves the clipboard image to ~/.ollacode/images and returns its path, or null if there is none. */
export function clipboardImage() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const file = path.join(IMAGES_DIR, `clip-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15_000, windowsHide: true, encoding: 'buffer', maxBuffer: 50e6 }, (err, stdout) => resolve(err ? null : stdout)));
  return (async () => {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`;
      const out = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', ps]);
      return out && String(out).includes('ok') ? file : null;
    }
    const data = process.platform === 'darwin'
      ? await run('osascript', ['-e', `set f to open for access POSIX file "${file}" with write permission`, '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'close access f']).then((o) => (o ? fs.readFileSync(file) : null))
      : (await run('wl-paste', ['--type', 'image/png'])) ?? (await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
    if (!data?.length) return null;
    if (process.platform !== 'darwin') fs.writeFileSync(file, data);
    return file;
  })();
}

/** Tool definition for the agent. */
export function imageTool(config) {
  return {
    name: 'view_image',
    description: 'Only when the user refers to an image: look at an existing image file (png/jpg/webp/gif/bmp: screenshots, diagrams, photos, scanned text) with a vision model. ' +
      'Returns a description and transcribed text. Use a specific question to focus it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image file path' },
        question: { type: 'string', description: 'What to look for, e.g. "transcribe the error message" or "list the UI buttons"' },
      },
      required: ['path'],
    },
    readOnly: true,
    preview: (a) => `${a.path}${a.question ? ` — ${a.question}` : ''}`,
    async run(a, ctx) {
      const file = path.resolve(ctx.cwd, a.path);
      if (!isImagePath(file)) return `ERROR: not a supported image type: ${a.path}`;
      if (!fs.existsSync(file)) return `ERROR: file not found: ${file}. Only call view_image for image files that exist (use glob to find them).`;
      const { model, text } = await describeImages({ config, files: [file], prompt: a.question, signal: ctx.signal });
      return `[${model}이(가) 본 ${path.basename(file)}]\n${text}`;
    },
  };
}
