import { stateDir } from '../utils/state.dir';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Logger } from '../utils';

const execFileAsync = promisify(execFile);

// Only accept well-formed https / git / ssh repo URLs. This is a defence-in-depth check on top of the
// argv-level execFile call below (no shell), so a URL can never inject flags or shell metacharacters.
const SAFE_REPO_URL = /^(https:\/\/|git:\/\/|ssh:\/\/|git@)[\w.@:/~+-]+$/;

export class GithubReader {
  async fetchRepo(url: string): Promise<string> {
    Logger.info(`[GithubReader] Fetching repository: ${url}`);

    const trimmed = (url || '').trim();
    if (!SAFE_REPO_URL.test(trimmed)) {
      throw new Error(`[GithubReader] Refusing to clone — "${url}" is not a valid https/git/ssh repository URL.`);
    }

    const rootDir = path.join(stateDir('.breakglass'), 'plugins_staging');
    await fs.mkdir(rootDir, { recursive: true });

    const pluginId = `plugin_${Date.now()}`;
    const tempDir = path.join(rootDir, pluginId);

    try {
      Logger.info(`[GithubReader] Executing: git clone --depth 1 <url> ${tempDir}`);
      // execFile (no shell) + a leading `--` so the URL can never be parsed as a git flag.
      await execFileAsync('git', ['clone', '--depth', '1', '--', trimmed, tempDir]);
      
      // Verification Step: Integrity & Safety Check (PLUG-002)
      Logger.info(`[GithubReader] Verifying package integrity...`);
      const pkgPath = path.join(tempDir, 'package.json');
      
      try {
        const pkgData = await fs.readFile(pkgPath, 'utf8');
        const pkg = JSON.parse(pkgData);
        
        if (pkg.scripts && (pkg.scripts.preinstall || pkg.scripts.postinstall)) {
          throw new Error('Dangerous lifecycle scripts (preinstall/postinstall) detected.');
        }
      } catch (err: any) {
        // Cleanup if validation fails
        await fs.rm(tempDir, { recursive: true, force: true });
        throw new Error(`Integrity check failed: ${err.message}`, { cause: err });
      }

      Logger.info(`[GithubReader] ✅ Cloned and verified successfully into ${tempDir}`);
      return tempDir;
    } catch (e: any) {
      throw new Error(`[GithubReader] Failed to clone or verify repo: ${e.message}`, { cause: e });
    }
  }
}
