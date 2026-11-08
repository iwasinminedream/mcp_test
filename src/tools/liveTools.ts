import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveHelperScript(): string {
  const candidates = [
    path.resolve(__dirname, 'live_helper.py'),
    path.resolve(__dirname, '../../src/tools/live_helper.py'),
    path.resolve(__dirname, '../src/tools/live_helper.py'),
    'C:\\Users\\Admin\\Documents\\project\\mcp_test\\src\\tools\\live_helper.py',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

function resolvePythonExe(): string {
  if (process.env.PYTHON_EXE && fs.existsSync(process.env.PYTHON_EXE)) {
    return process.env.PYTHON_EXE;
  }
  const candidates = [
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'python';
}

export interface LiveHelperResult {
  ok: boolean;
  error?: string;
  pngBase64?: string;
  shot?: {
    ok?: boolean;
    pngBase64?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function runLiveHelper(
  action:
    | 'window_list'
    | 'window_shot'
    | 'ui_tree'
    | 'ui_click'
    | 'ui_type'
    | 'console'
    | 'tools_open'
    | 'particle_shot',
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<LiveHelperResult> {
  const py = resolvePythonExe();
  const script = resolveHelperScript();
  const payload = JSON.stringify(args);

  return new Promise((resolve) => {
    execFile(
      py,
      ['-I', script, action, payload],
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      },
      (err, stdout, stderr) => {
        const out = (stdout ?? '').trim();
        if (out) {
          try {
            const parsed = JSON.parse(out) as LiveHelperResult;
            resolve(parsed);
            return;
          } catch {
            // Fall through to error reporting
          }
        }
        resolve({
          ok: false,
          error: err
            ? `${err.message}${stderr ? ` | stderr: ${stderr.trim()}` : ''}`
            : `Invalid JSON output from live_helper.py: ${out.slice(0, 400)}`,
        });
      },
    );
  });
}

export function formatLiveMcpResult(res: LiveHelperResult) {
  if (!res.ok) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
      structuredContent: res as Record<string, unknown>,
      isError: true,
    };
  }

  // Extract inline pngBase64 either at top-level (window_shot, particle_shot)
  // or nested inside res.shot (tools_open, ui_click, ui_type with shotAfter=true)
  let pngBase64: string | undefined;
  const clean: Record<string, unknown> = { ...res };

  if (typeof clean.pngBase64 === 'string' && clean.pngBase64.length > 0) {
    pngBase64 = clean.pngBase64;
    delete clean.pngBase64;
  } else if (clean.shot && typeof clean.shot === 'object') {
    const shotCopy = { ...(clean.shot as Record<string, unknown>) };
    if (typeof shotCopy.pngBase64 === 'string' && shotCopy.pngBase64.length > 0) {
      pngBase64 = shotCopy.pngBase64;
      delete shotCopy.pngBase64;
    }
    clean.shot = shotCopy;
  }

  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text' as const, text: JSON.stringify(clean, null, 2) }];

  if (pngBase64) {
    content.push({
      type: 'image' as const,
      data: pngBase64,
      mimeType: 'image/png',
    });
  }

  return {
    content,
    structuredContent: clean,
  };
}
