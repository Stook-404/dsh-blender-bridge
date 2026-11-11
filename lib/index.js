/**
 * dsh-blender-bridge
 *
 * 把 Blender 接进 DSH：
 *  - 工具 blender_build / blender_status 让 agent 真在 Blender 里建模并渲染预览
 *  - HTTP 面板 /blender-bridge/panel 实时显示建模过程与结果
 *  - 系统提示注入：用户提到「建模」「建…的模型」时引导使用本插件
 *
 * 所有产物落在 ~/.dsh/blender-out/<jobId>/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const DRIVER = path.join(PKG_ROOT, 'python', 'build_scene.py');
const PANEL_HTML = path.join(PKG_ROOT, 'panel.html');

const BLENDER_CANDIDATES = [
  process.env.BLENDER_EXE,
  'D:\\Blender\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
].filter(Boolean);

function resolveBlender() {
  for (const c of BLENDER_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return BLENDER_CANDIDATES[0];
}

const OUT_ROOT = process.env.BLENDER_OUT_DIR || path.join(os.homedir(), '.dsh', 'blender-out');
const JOBS_FILE = path.join(OUT_ROOT, 'jobs.json');
const MAX_JOBS = 40;

function ensureRoot() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
}

function readJobs() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeJobs(jobs) {
  try {
    ensureRoot();
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(0, MAX_JOBS), null, 2), 'utf8');
  } catch { /* ignore */ }
}

function updateJob(id, patch) {
  const jobs = readJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i >= 0) { jobs[i] = { ...jobs[i], ...patch }; writeJobs(jobs); return jobs[i]; }
  return null;
}

function nowId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
}

/** 调 Blender 无头执行一次建模 + 渲染 */
function runBlender(spec, jobDir, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const specPath = path.join(jobDir, 'spec.json');
    const blendPath = path.join(jobDir, 'scene.blend');
    const pngPath = path.join(jobDir, 'preview.png');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const exe = resolveBlender();
    const started = Date.now();
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(exe, ['--background', '--factory-startup', '--python', DRIVER, '--', specPath, blendPath, pngPath], {
        cwd: jobDir, windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message, stdout: '', stderr: '' });
      return;
    }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout: out, stderr: err }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT '));
      let parsed = null;
      if (line) { try { parsed = JSON.parse(line.slice(7)); } catch { /* ignore */ } }
      const previewExists = fs.existsSync(pngPath);
      const blendExists = fs.existsSync(blendPath);
      resolve({
        ok: code === 0 && previewExists,
        exitCode: code,
        durationMs: Date.now() - started,
        result: parsed,
        preview: previewExists ? pngPath : null,
        blend: blendExists ? blendPath : null,
        error: parsed && parsed.ok === false ? parsed.error : (code !== 0 ? (err.trim().split(/\r?\n/).slice(-6).join('\n') || 'blender exited ' + code) : null),
        stdoutTail: out.trim().split(/\r?\n/).slice(-8).join('\n'),
        stderrTail: err.trim().split(/\r?\n/).slice(-8).join('\n'),
      });
    });
  });
}

const OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', description: 'cube | sphere | cylinder | cone | torus | plane | circle' },
    name: { type: 'string', description: '对象名，便于在面板里辨认' },
    location: { type: 'array', items: { type: 'number' }, description: '[x,y,z]，单位米' },
    scale: { type: 'array', items: { type: 'number' }, description: '[x,y,z] 缩放' },
    rotation: { type: 'array', items: { type: 'number' }, description: '[rx,ry,rz] 弧度' },
    radius: { type: 'number', description: '球/圆柱/圆锥半径' },
    segments: { type: 'number', description: '细分段数，默认 32' },
    color: { type: 'string', description: '十六进制颜色，如 #4C72B0' },
    metallic: { type: 'number', description: '0-1' },
    roughness: { type: 'number', description: '0-1' },
  },
};

const BUILD_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['objects'],
  properties: {
    objects: { type: 'array', items: OBJECT_SCHEMA, description: '要建的对象列表' },
    title: { type: 'string', description: '这次建模的标题，显示在侧边栏' },
    ground: { type: 'boolean', description: '是否加地面' },
    background: { type: 'string', description: '背景色十六进制，默认 #101014' },
    width: { type: 'number', description: '渲染宽度，默认 720' },
    height: { type: 'number', description: '渲染高度，默认 720' },
    samples: { type: 'number', description: 'Cycles 采样数，默认 32（越大越慢越干净）' },
    engine: { type: 'string', description: 'CYCLES（默认，稳定） / BLENDER_EEVEE_NEXT（快但需 GPU 上下文）' },
  },
};

export function apply(ctx) {
  const blender = resolveBlender();

  // ── 工具：建模 ────────────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'blender_build',
      description: [
        '在本地 Blender 里真实建模并渲染预览图。',
        '当用户的消息里出现「建模」「建一个…的模型」「做一个…的模型」「搭个…的场景」「三维模型」这类明确要求时，必须调用本工具，不要只用文字描述模型。',
        '把用户描述的物体拆成基本几何体（cube/sphere/cylinder/cone/torus/plane）的组合，带上位置、缩放、颜色。',
        '返回 jobId、预览图路径、.blend 路径；侧边栏面板会同步显示这次建模的过程与结果。',
      ].join(' '),
      parameters: BUILD_PARAMS,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            jobId: { type: 'string' },
            preview: { type: 'string' },
            blend: { type: 'string' },
            objectCount: { type: 'number' },
            durationMs: { type: 'number' },
            summary: { type: 'string' },
          },
          required: ['ok', 'jobId', 'summary'],
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 330000,
      async execute(args) {
        ensureRoot();
        const id = nowId();
        const jobDir = path.join(OUT_ROOT, id);
        fs.mkdirSync(jobDir, { recursive: true });

        const jobs = readJobs();
        jobs.unshift({
          id, title: args.title || (args.objects || []).map((o) => o.name || o.type).slice(0, 3).join(' + ') || '未命名',
          status: 'running', startedAt: new Date().toISOString(),
          objectCount: (args.objects || []).length, jobDir,
        });
        writeJobs(jobs);

        const res = await runBlender(args, jobDir);
        updateJob(id, {
          status: res.ok ? 'done' : 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: res.durationMs,
          preview: res.preview ? path.relative(OUT_ROOT, res.preview).split(path.sep).join('/') : null,
          blend: res.blend ? path.relative(OUT_ROOT, res.blend).split(path.sep).join('/') : null,
          error: res.error || null,
        });

        const lines = [];
        if (res.ok) {
          lines.push(`建模完成：${(args.objects || []).length} 个对象，耗时 ${(res.durationMs / 1000).toFixed(1)} 秒`);
          lines.push(`预览图：${res.preview}`);
          lines.push(`工程文件：${res.blend}`);
        } else {
          lines.push(`建模失败：${res.error || '未知错误'}`);
          if (res.stderrTail) lines.push('stderr:\n' + res.stderrTail);
        }
        return {
          ok: res.ok,
          jobId: id,
          preview: res.preview || '',
          blend: res.blend || '',
          objectCount: (args.objects || []).length,
          durationMs: res.durationMs,
          summary: lines.join('\n'),
        };
      },
    }), 'dsh-blender-bridge: blender_build');
  });

  // ── 工具：任务状态 ───────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'blender_status',
      description: '查看 dsh-blender-bridge 最近的建模任务（状态、耗时、预览与工程文件路径）。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' }, summary: { type: 'string' } },
          required: ['count', 'summary'],
        },
        render: (_a, v) => [{ type: 'text', text: v.summary }],
      },
      async execute() {
        const jobs = readJobs();
        const summary = jobs.length === 0
          ? '还没有建模任务。'
          : jobs.slice(0, 10).map((j) => `${j.id}  ${j.status}  ${j.title}  ${j.durationMs ? (j.durationMs / 1000).toFixed(1) + 's' : ''}`).join('\n');
        return { count: jobs.length, summary };
      },
    }), 'dsh-blender-bridge: blender_status');
  });

  // ── 系统提示：触发规则 ───────────────────────────────────────
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: 'dsh-blender-bridge:guidance',
      order: 72,
      text: () => [
        '## Blender 建模桥',
        '当用户明确要求「建模」「建一个…的模型」「做一个…的模型」「搭个三维场景」时：调用 blender_build 在本地 Blender 真实建模并渲染，',
        '不要只回文字或代码。把需求拆成基本几何体（cube/sphere/cylinder/cone/torus）的组合并给出位置、缩放、颜色；',
        '完成后把 preview 图片路径告知用户并展示。Blender 可执行文件当前解析为：' + resolveBlender() + '。',
      ].join(''),
    }), 'dsh-blender-bridge: guidance');
  });

  // ── HTTP 面板 ────────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/blender-bridge',
      handler: (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const route = url.pathname.slice('/blender-bridge'.length) || '/';
        try {
          if (route === '/jobs' || route === '/jobs.json') {
            const jobs = readJobs();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ blender: resolveBlender(), outRoot: OUT_ROOT, jobs }));
            return;
          }
          if (route === '/panel' || route === '/') {
            const html = fs.readFileSync(PANEL_HTML, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
          const m = route.match(/^\/preview\/(.+)$/);
          if (m) {
            const rel = decodeURIComponent(m[1]).replace(/\.\./g, '');
            const file = path.join(OUT_ROOT, rel);
            if (fs.existsSync(file)) {
              res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
              fs.createReadStream(file).pipe(res);
              return;
            }
            res.writeHead(404); res.end('not found'); return;
          }
          res.writeHead(404); res.end('not found');
        } catch (e) {
          res.writeHead(500); res.end('error: ' + e.message);
        }
      },
    }), 'dsh-blender-bridge: panel routes');
  });

  ctx.logger?.('dsh-blender-bridge')?.info?.('dsh-blender-bridge ready · blender=' + blender + ' · out=' + OUT_ROOT);
}

export default { name: 'dsh-blender-bridge', apply };
