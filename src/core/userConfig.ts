import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileSecure } from './secureFile';

// ---------------------------------------------------------------------------
// User-level login config — ~/.autodev/config.json (mode 0600).
//
// `autodev login` mints/stores a pixel-office `pat_` personal-access token here
// so `autodev office <slug>` works with no --url/--token afterwards. This file
// carries a live secret, so it is ALWAYS written owner-only via writeFileSecure.
// ---------------------------------------------------------------------------

/** Default pixel-office server used when the user passes no --url. */
export const DEFAULT_BASE_URL = 'https://app.pixeloffice.org';

export interface UserConfig {
  /** Pixel-office base URL (no trailing slash), e.g. https://app.pixeloffice.org */
  baseUrl?: string;
  /** Personal-access token (pat_…) minted by `autodev login`. */
  token?: string;
}

/** Absolute path to the user login config (~/.autodev/config.json). */
export function userConfigPath(): string {
  return path.join(os.homedir(), '.autodev', 'config.json');
}

/** Load the stored login config; returns {} if none/invalid. */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(userConfigPath(), 'utf8');
    const obj = JSON.parse(raw) as UserConfig;
    if (obj && typeof obj === 'object') {
      return {
        baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl.replace(/\/+$/, '') : undefined,
        token: typeof obj.token === 'string' ? obj.token : undefined,
      };
    }
  } catch { /* missing / unreadable / bad JSON → treat as unconfigured */ }
  return {};
}

/** Persist the login config owner-only (0600). Never logged. */
export function saveUserConfig(cfg: UserConfig): void {
  const file = userConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const clean: UserConfig = {
    baseUrl: cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') : undefined,
    token: cfg.token,
  };
  writeFileSecure(file, JSON.stringify(clean, null, 2) + '\n');
}
