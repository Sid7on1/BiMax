import { Logger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import jwt from 'jsonwebtoken';
import { ensureJwtSecret } from '../engine/env.loader';

export class AuthAutomator {
  private readonly AUTH_DIR = path.join(os.homedir(), '.breakglass', 'auth');
  private readonly TOKEN_FILE = path.join(this.AUTH_DIR, 'session.jwt');
  private readonly JWT_SECRET = ensureJwtSecret();

  constructor() {
    if (!fsSync.existsSync(this.AUTH_DIR)) {
      fsSync.mkdirSync(this.AUTH_DIR, { recursive: true });
    }
  }

  async ensureAuthenticated(cliTool: string) {
    Logger.info(`[AuthAutomator] Checking cryptographic authentication state for ${cliTool}...`);
    
    try {
      // 1. Check if token exists physically
      const stat = await fs.stat(this.TOKEN_FILE);
      
      // 2. Check file permissions
      const modeStr = (stat.mode & 0o777).toString(8);
      if (modeStr !== '600') {
        Logger.warn(`[AuthAutomator] Token file permissions are too open (${modeStr}). Fixing to 600...`);
        await fs.chmod(this.TOKEN_FILE, 0o600);
      }

      // 3. Read and validate token expiration/signature
      const token = await fs.readFile(this.TOKEN_FILE, 'utf-8');
      jwt.verify(token, this.JWT_SECRET);
      
      Logger.info(`[AuthAutomator] Valid local session token found. ${cliTool} is authenticated.`);
    } catch (e: any) {
      if (e.name === 'TokenExpiredError') {
        Logger.warn(`[AuthAutomator] Session expired. Regenerating cryptographic offline token for ${cliTool}...`);
      } else {
        // Token missing, invalid, or stat failed
        Logger.warn(`[AuthAutomator] Session missing or invalid (${e.message}). Generating cryptographic offline token for ${cliTool}...`);
      }
      
      await fs.mkdir(this.AUTH_DIR, { recursive: true });
      
      const token = jwt.sign(
        { sub: 'agent-system', tool: cliTool },
        this.JWT_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );
      
      // Physically write to disk securely
      await fs.writeFile(this.TOKEN_FILE, token, { encoding: 'utf-8', mode: 0o600 });
      Logger.info(`[AuthAutomator] Headless cryptographic authentication successful. Token saved to disk.`);
    }
  }
}
