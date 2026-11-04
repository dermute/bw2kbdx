import { spawn } from 'node:child_process';

export interface CommandOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
export type Runner = (program: string, args: string[], options: CommandOptions) => Promise<Buffer>;

export const run: Runner = async (program, args, options) => new Promise((resolve, reject) => {
  const output: Buffer[] = [];
  let size = 0;
  let failed = false;
  let settled = false;
  const command = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  function finish(error?: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    if (error) reject(error); else resolve(Buffer.concat(output));
  }
  const stop = () => {
    failed = true;
    if (!command.kill('SIGKILL')) finish(new Error('Unable to stop subprocess'));
  };
  const timer = setTimeout(stop, options.timeoutMs ?? 300_000);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  // Raw stderr can include credentials or item contents. Drain it without retaining it.
  command.stderr.resume();
  command.stdout.on('data', (data: Buffer) => {
    size += data.length;
    if (size > (options.maxBytes ?? 512 * 1024 * 1024)) stop();
    else output.push(data);
  });
  command.stdin.on('error', (error: NodeJS.ErrnoException) => {
    // A command may finish successfully without consuming stdin. Its exit status
    // and (for backups) content verification remain authoritative.
    if (error.code !== 'EPIPE') failed = true;
  });
  command.on('error', () => finish(new Error('Could not execute subprocess')));
  command.on('close', code => {
    finish(failed || code !== 0 ? new Error('Subprocess failed, timed out, or exceeded output limit') : undefined);
  });
  command.stdin.end(options.input ?? '');
});
