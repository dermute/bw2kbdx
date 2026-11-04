import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Config {
  server: string;
  clientId: string;
  clientSecret: string;
  masterPassword: string;
  backupPassword: string;
  outputDir: string;
}

export class SafeError extends Error {}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  async function secret(name: string): Promise<string> {
    if (env[name] !== undefined && env[`${name}_FILE`] !== undefined) throw new SafeError(`Set only ${name} or ${name}_FILE`);
    let value = env[name];
    if (env[`${name}_FILE`] !== undefined) {
      try {
        value = (await readFile(env[`${name}_FILE`]!, 'utf8')).replace(/\r?\n$/, '');
      } catch { throw new SafeError(`Cannot read ${name}_FILE`); }
    }
    if (!value || /[\r\n\0]/.test(value)) throw new SafeError(`${name} must be a nonempty single-line secret`);
    return value;
  }
  const server = env.BW_SERVER || 'https://vault.bitwarden.com';
  try {
    const url = new URL(server);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new SafeError('BW_SERVER must be an HTTPS base URL without credentials, query, or fragment'); }
  return {
    server, clientId: await secret('BW_CLIENTID'), clientSecret: await secret('BW_CLIENTSECRET'),
    masterPassword: await secret('BW_PASSWORD'), backupPassword: await secret('KDBX_PASSWORD'),
    outputDir: resolve(env.BACKUP_DIR || '/backups'),
  };
}

export function subprocessEnv(workdir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: workdir, TMPDIR: workdir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    if (env[name]) result[name] = env[name];
  }
  return result;
}
