import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { log } from './logger';
import { AutodevSettings, SETTINGS_DEFAULTS, parseWsUrl, loadSettingsForRoot } from './core/settingsLoader';
import { installHooks, areHooksInstalled } from './hooksManager';
import { ConfigManager } from './configManager';

// ---------------------------------------------------------------------------
// CLI ⇄ pixel-office wire protocol
//
// 1. `--connect=<wsurl>` — the user already has a wsUrl with token+endpoint
//    embedded (e.g. wss://host?token=xxx&endpoint=slug). Save it and we're
//    done.
//
// 2. `--setup-url=<url>` — the pixel-office UI generated a short-lived signed
//    URL that returns the credentials JSON. Fetch, parse, save.
// ---------------------------------------------------------------------------

interface SetupResponse {
  success: boolean;
  data?: {
    agentId?: string;
    agentName?: string;
    slug?: string;
    apiKey?: string;
    wsUrl?: string;
    serverBaseUrl?: string;
    officeId?: number;
  };
  error?: string;
}

function configWritePath(cwd: string): string {
  return path.join(cwd, '.autodev', 'settings.json');
}

function saveSettings(cwd: string, settings: AutodevSettings): void {
  const file = configWritePath(cwd);
  const dir  = path.dirname(file);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function loadOrDefault(cwd: string): AutodevSettings {
  return { ...SETTINGS_DEFAULTS, ...loadSettingsForRoot(cwd) };
}

/** Fetch JSON from a URL using the built-in http/https module (no deps). */
function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { reject(new Error(`Invalid URL: ${url}`)); return; }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'autodev-cli' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body) as T); }
            catch (e) { reject(new Error(`Invalid JSON from ${url}: ${(e as Error).message}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 300)}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timed out after ${timeoutMs}ms fetching ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

/** Save a full WS URL (with token+endpoint query params) into the workspace settings. */
export function applyWsUrl(cwd: string, wsUrl: string): void {
  const parsed = parseWsUrl(wsUrl);
  if (!parsed) {
    throw new Error(`--connect URL must be a ws:// or wss:// URL with token & endpoint params, got: ${wsUrl}`);
  }
  const settings = loadOrDefault(cwd);
  settings.wsUrl         = wsUrl;
  settings.serverBaseUrl = parsed.serverBaseUrl;
  settings.serverApiKey  = parsed.serverApiKey;
  settings.webhookSlug   = parsed.webhookSlug;
  // Connecting to pixel-office implies we want hook events flowing back AND
  // the agent to auto-start when the IDE opens this workspace.
  settings.hooksEnabled  = true;
  settings.autoStartLoop = true;
  saveSettings(cwd, settings);
  ensureHooksInstalled(cwd);
  // Same as applySetupUrl: write the office MCP server as part of binding.
  try {
    ConfigManager.syncProjectMcpServers(cwd, (m) => log.gray(`  ${m}`));
    // Grant the managed MCP tools (permissions.allow) so a copy-paste
    // `claude -p` / MCP-client agent can OPERATE, not just connect — the bind is
    // often the only setup step before the agent runs (no `autodev start`/IDE
    // activation to apply permissions later).
    ConfigManager.applyClaudePermissions(cwd, (m) => log.gray(`  ${m}`));
  } catch (e) {
    log.warn(`MCP config sync skipped: ${(e as Error).message}`);
  }
  log.success(`Connected → ${parsed.serverBaseUrl}`);
  log.gray(`  endpoint: ${parsed.webhookSlug}`);
  log.gray(`  saved to: ${configWritePath(cwd)}`);
}

function ensureHooksInstalled(cwd: string): void {
  try {
    if (!areHooksInstalled('project', cwd)) {
      installHooks('project', cwd);
      log.gray('  hooks installed (Claude + Copilot)');
    }
  } catch (err) {
    log.warn(`  hooks install skipped: ${(err as Error).message}`);
  }
}

/** Fetch credentials from a signed setup URL and apply them to the workspace. */
export async function applySetupUrl(cwd: string, setupUrl: string): Promise<void> {
  log.info(`Fetching credentials from ${setupUrl}…`);
  const json = await fetchJson<SetupResponse>(setupUrl);
  if (!json.success || !json.data) {
    throw new Error(json.error ?? 'Setup endpoint returned an error');
  }
  const d = json.data;
  if (!d.wsUrl) {
    throw new Error('Setup response did not include a wsUrl');
  }
  const settings = loadOrDefault(cwd);
  settings.wsUrl = d.wsUrl;
  if (d.apiKey)        { settings.serverApiKey  = d.apiKey; }
  if (d.slug)          { settings.webhookSlug   = d.slug; }
  if (d.serverBaseUrl) { settings.serverBaseUrl = d.serverBaseUrl; }
  // Override the parsed values from the wsUrl (in case the server reports a
  // different externally-visible base URL than the WS URL host).
  const parsed = parseWsUrl(d.wsUrl);
  if (parsed && !d.serverBaseUrl) { settings.serverBaseUrl = parsed.serverBaseUrl; }
  // Binding to pixel-office implies we want hook events flowing back AND
  // the agent to auto-start when the IDE opens this workspace.
  settings.hooksEnabled = true;
  settings.autoStartLoop = true;

  saveSettings(cwd, settings);
  ensureHooksInstalled(cwd);
  // Write the office (pixel-office) MCP server into the provider configs NOW, as
  // part of binding — not lazily on the first loop start. Settings were just
  // saved, so serverApiKey + serverBaseUrl are present and the pixel-office entry
  // passes its (origin && key) guard. Without this, `--setup-url` set up the
  // credential-free built-ins (memory/playwright/…) but left the office MCP
  // unconfigured until something happened to start the loop. Matches what the
  // `autodev connect` command already does.
  try {
    ConfigManager.syncProjectMcpServers(cwd, (m) => log.gray(`  ${m}`));
    // Grant the managed MCP tools (permissions.allow) so a copy-paste
    // `claude -p` / MCP-client agent can OPERATE, not just connect — the bind is
    // often the only setup step before the agent runs (no `autodev start`/IDE
    // activation to apply permissions later).
    ConfigManager.applyClaudePermissions(cwd, (m) => log.gray(`  ${m}`));
  } catch (e) {
    log.warn(`MCP config sync skipped: ${(e as Error).message}`);
  }
  log.success(`Connected → ${settings.serverBaseUrl}`);
  log.gray(`  agent:    ${d.agentName ?? d.agentId ?? d.slug}`);
  log.gray(`  endpoint: ${d.slug ?? settings.webhookSlug}`);
  log.gray(`  saved to: ${configWritePath(cwd)}`);
}
