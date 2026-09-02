import { Command } from 'commander';
import { log } from '../logger';
import { ProviderModels } from '../providers/base/ProviderModels';
import { ClaudeProviderModels } from '../providers/claude/ProviderModels';
import { GrokProviderModels } from '../providers/grok/ProviderModels';
import { OpencodeProviderModels } from '../providers/opencode/ProviderModels';
import { CopilotProviderModels } from '../providers/copilot/ProviderModels';
import { DummyProviderModels } from '../providers/dummy/ProviderModels';

/**
 * `autodev models [--json]` — the single source of truth for the model catalog
 * the app's per-agent model pickers consume.
 *
 * It instantiates every provider family's ProviderModels and emits their
 * `list()` verbatim (id/label/contextLimit). Nothing is hardcoded here: the
 * lists live next to each provider, so the app never drifts from the CLI that
 * actually runs the loop. `default` is the family's first (recommended) model —
 * an empty per-agent model always means "provider default" regardless.
 */

// The five families the app can launch, in a stable display order.
const FAMILIES: ProviderModels[] = [
  new ClaudeProviderModels(),
  new GrokProviderModels(),
  new OpencodeProviderModels(),
  new CopilotProviderModels(),
  new DummyProviderModels(),
];

export interface ModelCatalogEntry {
  family: string;
  default: string;
  models: Array<{ id: string; label: string; contextLimit: number }>;
}

/** Build the catalog array (reused by the app IPC via `--json`). */
export function buildModelCatalog(): ModelCatalogEntry[] {
  return FAMILIES.map((m) => {
    const models = m.list();
    return {
      family: m.family,
      default: models[0]?.id ?? '',
      models,
    };
  });
}

const fmtCtx = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`;

export function modelsCommand(program: Command): void {
  program
    .command('models')
    .description('List the model catalog every provider family supports (id, label, context)')
    .option('--json', 'Output JSON (the shape the app consumes)')
    .action((opts: { json?: boolean }) => {
      const catalog = buildModelCatalog();
      if (opts.json) {
        process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
        return;
      }
      log.section('🤖  Model catalog');
      for (const entry of catalog) {
        log.plain(`  ${entry.family}${entry.default ? `  (default: ${entry.default})` : ''}`);
        for (const md of entry.models) {
          log.gray(`    ${md.id.padEnd(34)} ${md.label.padEnd(14)} · ${fmtCtx(md.contextLimit)} ctx`);
        }
      }
    });
}
