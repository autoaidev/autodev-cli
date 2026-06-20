// Hand-written declarations for the autoaidev package exports consumed by this CLI.
// The actual implementations live in the compiled extension (autoaidev/out/...).

declare module 'autoaidev/sdk' {
  export type ProviderId = 'claude-cli' | 'claude-tui' | 'copilot-cli' | 'copilot-tui' | 'opencode-cli' | 'opencode-sdk' | 'grok-tui';

  export interface LoopStartOptions {
    provider?: ProviderId;
    cwd?: string;
    log?: (msg: string) => void;
  }

  export declare const AutoDev: {
    loop: {
      start(opts?: LoopStartOptions): Promise<void>;
      stop(): void;
    };
  };
}

declare module 'autoaidev/settings' {
  export type ProviderId = 'claude-cli' | 'claude-tui' | 'copilot-cli' | 'copilot-tui' | 'opencode-cli' | 'opencode-sdk' | 'grok-tui';

  export interface AutodevSettings {
    provider: ProviderId;
    wsUrl: string;
    serverBaseUrl: string;
    serverApiKey: string;
    webhookSlug: string;
    discordToken: string;
    discordChannelId: string;
    discordOwners: string;
    loopInterval: number;
    taskTimeoutMinutes: number;
    taskCheckInMinutes: number;
    retryOnTimeout: boolean;
    autoResetPendingTasks: boolean;
    profilePath: string;
    todoPath: string;
    resumeSession: boolean;
    gitEnabled: boolean;
    hooksEnabled: boolean;
    hooksScope: 'project' | 'global';
    autoStartLoop: boolean;
  }

  export declare const SETTINGS_DEFAULTS: AutodevSettings;
  export declare function loadSettingsForRoot(root: string): AutodevSettings;
  export declare function parseWsUrl(wsUrl: string): { serverBaseUrl: string; serverApiKey: string; webhookSlug: string } | null;
}

declare module 'autoaidev/todo' {
  export type TaskStatus = 'todo' | 'in-progress' | 'done';

  export interface Task {
    id?: string;
    status: TaskStatus;
    text: string;
    completedDate?: string;
    line: number;
  }

  export declare function parseTodo(filePath: string): Task[];
  export declare function countRemaining(tasks: Task[]): number;
}

declare module 'autoaidev/providers' {
  export type ProviderId = 'claude-cli' | 'claude-tui' | 'copilot-cli' | 'copilot-tui' | 'opencode-cli' | 'opencode-sdk' | 'grok-tui';
}

declare module 'autoaidev/hooks' {
  export function installHooks(scope: 'project' | 'global', workspaceRoot: string): void;
  export function uninstallHooks(scope: 'project' | 'global', workspaceRoot: string): void;
  export function areHooksInstalled(scope: 'project' | 'global', workspaceRoot: string): boolean;
  export function installClaudeHooks(workspaceRoot: string): void;
  export function installCopilotHooks(workspaceRoot: string): void;
}

declare module 'autoaidev/agentBackup' {
  export type Portability = 'full' | 'partial' | 'none';

  export interface ProviderManifestEntry {
    portability: Portability;
    note: string;
    discoveredSessionIds: string[];
    connectedSessionIds: Record<string, string | null>;
    tracesCaptured: boolean;
  }

  export interface SessionManifest {
    exportedAt: string;
    workspaceRoot: string;
    providers: Record<string, ProviderManifestEntry>;
  }

  export interface ExportResult {
    destPath: string;
    capturedProviders: string[];
    providers: Record<string, ProviderManifestEntry>;
  }

  export interface ImportResult {
    destRoot: string;
    workspaceFiles: number;
    restoredByProvider: Record<string, number>;
    manifestRestored: boolean;
  }

  export function createAgentBackup(root: string, destPath: string): Promise<ExportResult>;
  export function restoreAgentBackup(zipPath: string, destRoot: string): Promise<ImportResult>;
}
