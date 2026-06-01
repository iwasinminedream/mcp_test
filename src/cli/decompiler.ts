import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveCliPath } from '../config.js';
import { withTempDir } from '../cache.js';

const pExecFile = promisify(execFile);

export class CliUnavailableError extends Error {
  constructor() {
    super(
      'Source2Viewer-CLI not found. Set the S2V_CLI env var to its path, or place it under vendor/Source2Viewer-CLI/. ' +
        'Model attachment introspection still works without it.',
    );
    this.name = 'CliUnavailableError';
  }
}

export function cliAvailable(): boolean {
  return resolveCliPath() !== null;
}

/** Reads the CLI version string (best-effort; empty on failure). */
export async function cliVersion(): Promise<string> {
  const cli = resolveCliPath();
  if (!cli) return '';
  try {
    const { stdout, stderr } = await pExecFile(cli, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    const m = (stdout + stderr).match(/Version:\s*([^\s]+)/i);
    return m ? m[1]! : '';
  } catch {
    return '';
  }
}

/** Writes bytes to an ephemeral temp file and runs the CLI against it. */
async function withTempResource<T>(
  bytes: Buffer,
  fileName: string,
  fn: (cli: string, inPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const cli = resolveCliPath();
  if (!cli) throw new CliUnavailableError();
  const base = basename(fileName);
  return withTempDir(async (dir) => {
    const inPath = join(dir, base);
    writeFileSync(inPath, bytes);
    return fn(cli, inPath, dir);
  });
}

/**
 * Decompiles a single compiled resource to its KV3 source text. Runs
 * `Source2Viewer-CLI -i <file> -o <dir> -d`, reads back the produced non-`_c`
 * text file, and deletes the temp dir.
 *
 * @param bytes  raw compiled resource bytes (e.g. from VpkArchive.readFile)
 * @param fileName  the in-archive file name including the `_c` extension
 */
export async function decompileToText(bytes: Buffer, fileName: string): Promise<string> {
  return withTempResource(bytes, fileName, async (cli, inPath, dir) => {
    const base = basename(fileName);
    try {
      await pExecFile(cli, ['-i', inPath, '-o', dir, '-d'], {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 64 << 20,
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: unknown };
      throw new Error(`decompile failed (code=${String(e.code)}): ${e.stderr || e.message}`);
    }

    // The decompiled text is the produced file WITHOUT the _c extension (not the
    // original _c copy we wrote). Prefer the exact name, else newest non-_c file.
    const expected = base.replace(/_c$/i, '');
    const produced = readdirSync(dir)
      .filter((f) => f !== base)
      .map((f) => ({ f, full: join(dir, f) }))
      .filter((x) => {
        try {
          return statSync(x.full).isFile();
        } catch {
          return false;
        }
      });

    const exact = produced.find((x) => x.f === expected);
    const chosen =
      exact ??
      produced
        .filter((x) => !x.f.endsWith('_c'))
        .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs)[0];

    if (!chosen) {
      throw new Error(
        `decompile produced no readable output for ${base} (unsupported resource type/version)`,
      );
    }
    return readFileSync(chosen.full, 'utf8');
  });
}

/**
 * Dumps a single resource block (e.g. RERL, DATA) to text via `-b <block>`.
 * Best-effort: returns whatever the CLI prints to stdout, even on a non-zero exit.
 */
export async function dumpBlock(bytes: Buffer, fileName: string, block: string): Promise<string> {
  return withTempResource(bytes, fileName, async (cli, inPath) => {
    try {
      const { stdout } = await pExecFile(cli, ['-i', inPath, '-b', block], {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 64 << 20,
      });
      return stdout;
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? '';
    }
  });
}

/**
 * Dumps ALL resource blocks to text via `-a`. For models this is the only path
 * that reveals attachment names and other DATA fields: the DATA block is
 * LZ4-compressed binary KV3, so `-b DATA` prints nothing and a raw strings scan
 * finds nothing — but `-a` decompresses and prints it.
 */
export async function dumpAllBlocks(bytes: Buffer, fileName: string): Promise<string> {
  return withTempResource(bytes, fileName, async (cli, inPath) => {
    try {
      const { stdout } = await pExecFile(cli, ['-i', inPath, '-a'], {
        timeout: 90_000,
        windowsHide: true,
        maxBuffer: 128 << 20,
      });
      return stdout;
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? '';
    }
  });
}
