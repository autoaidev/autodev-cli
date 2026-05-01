// Hand-written declarations for the autoaidev package exports consumed by this CLI.
// The actual implementations live in the compiled extension (autoaidev/out/...).

declare module 'autoaidev/sdk' {
  export type ProviderId = 'claude-cli' | 'copilot-cli' | 'opencode-cli';

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
  export type ProviderId = 'claude-cli' | 'copilot-cli' | 'opencode-cli';

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
  export type ProviderId = 'claude-cli' | 'copilot-cli' | 'opencode-cli';
}

declare module 'autoaidev/hooks' {
  export function installHooks(scope: 'project' | 'global', workspaceRoot: string): void;
  export function uninstallHooks(scope: 'project' | 'global', workspaceRoot: string): void;
  export function areHooksInstalled(scope: 'project' | 'global', workspaceRoot: string): boolean;
  export function installClaudeHooks(workspaceRoot: string): void;
  export function installCopilotHooks(workspaceRoot: string): void;
}
