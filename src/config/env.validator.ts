import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

// Strict runtime schema for environment configuration
const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(20, "API Key must be at least 20 chars long").optional(),
  OPENAI_API_KEYS: z.string().optional(),
  NVIDIA_API_KEY: z.string().min(8, "NVIDIA API key must be at least 8 chars long").optional(),
  GITHUB_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string URL").optional(),
  AGENT_PORT: z.coerce.number().min(1).max(65535).optional()
}).refine(data => data.OPENAI_API_KEY || data.OPENAI_API_KEYS || data.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY, {
  message: "Must provide an API key for the selected model provider",
  path: ["OPENAI_API_KEY"]
});

export class EnvValidator {
  
  public loadAndValidate(): boolean {
    console.log(`[EnvValidator] Booting up... Loading system environment variables.`);
    
    // 1. Physically read .env if it exists
    const envPath = path.join(process.cwd(), '.env');
    const loadedConfig: Record<string, string> = { ...process.env } as any;

    try {
      if (fs.existsSync(envPath)) {
        const fileData = fs.readFileSync(envPath, 'utf-8');
        const parsed = dotenv.parse(fileData);
        for (const [key, value] of Object.entries(parsed)) {
          loadedConfig[key] = value;
        }
        console.log(`[EnvValidator] Physical .env file successfully loaded into memory using dotenv.`);
      }
    } catch (e: any) {
      console.warn(`[EnvValidator] Failed to read .env file: ${e.message}`);
    }

    // 2. Strict Zod parsing
    try {
      const validated = envSchema.parse(loadedConfig);
      console.log(`[EnvValidator] ✅ Environment validated perfectly!`);
      // Attach back to process.env safely (avoiding "undefined" string coercion)
      if (validated.OPENAI_API_KEYS) {
        if (!process.env.OPENAI_API_KEYS) process.env.OPENAI_API_KEYS = validated.OPENAI_API_KEYS;
        process.env.OPENAI_API_KEYS_ARRAY = JSON.stringify(validated.OPENAI_API_KEYS.split(',').map(k => k.trim()));
      } else if (validated.OPENAI_API_KEY) {
        if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = validated.OPENAI_API_KEY;
        process.env.OPENAI_API_KEYS_ARRAY = JSON.stringify([validated.OPENAI_API_KEY]);
      }

      if (validated.NVIDIA_API_KEY && !process.env.NVIDIA_API_KEY) {
        process.env.NVIDIA_API_KEY = validated.NVIDIA_API_KEY;
      }
      
      if (validated.GITHUB_TOKEN && !process.env.GITHUB_TOKEN) {
        process.env.GITHUB_TOKEN = validated.GITHUB_TOKEN;
      }
      
      if (validated.DATABASE_URL && !process.env.DATABASE_URL) {
        process.env.DATABASE_URL = validated.DATABASE_URL;
      }
      
      if (validated.AGENT_PORT !== undefined && !process.env.AGENT_PORT) {
        process.env.AGENT_PORT = validated.AGENT_PORT.toString();
      }
      
      return true;
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        console.error(`[EnvValidator] ❌ FATAL ERROR: Configuration is invalid!`);
        const zodErr = error as any;
        const issues = zodErr.errors || zodErr.issues || [];
        issues.forEach((err: any) => {
          console.error(`  - Field '${err.path.join('.')}': ${err.message}`);
        });
      } else {
        console.error(`[EnvValidator] FATAL ERROR: ${error.message}`);
      }
      return false;
    }
  }
}
