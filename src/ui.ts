import pc from 'picocolors';
import type { ProfileInfo, SettingsSummary } from './types.js';
import type { Provider } from './providers/types.js';
import { PROVIDER_CATEGORY_LABELS } from './providers/types.js';
import { providerNeedsKey } from './providers/index.js';
import type { ProfileDetails } from './profiles.js';

export { pc };

/** Where to point users when an operation needs a terminal. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Short, human description of where a profile sends requests. */
export function describeTarget(summary: SettingsSummary): string {
  if (summary.unreadable) return 'settings.json unreadable';
  if (summary.providerLabel) return summary.providerLabel;
  return hostOf(summary.baseUrl) ?? 'Anthropic';
}

/** The model a profile effectively uses, for list views. */
export function primaryModel(summary: SettingsSummary): string | undefined {
  const { models } = summary;
  return models.main ?? models.sonnet ?? models.opus ?? models.haiku;
}

export function formatCurrentLine(name: string, exists: boolean): string {
  return `Current profile: "${name}"${exists ? '' : ' (missing)'}`;
}

export function formatProfileTable(profiles: ProfileInfo[]): string[] {
  const nameWidth = Math.max(...profiles.map(p => p.name.length), 4);
  const typeWidth = 8;
  const targetWidth = Math.max(...profiles.map(p => describeTarget(p.summary).length), 6);

  return profiles.map(profile => {
    const marker = profile.isActive ? pc.green('*') : ' ';
    const name = profile.isActive ? pc.bold(pc.green(padEnd(profile.name, nameWidth))) : padEnd(profile.name, nameWidth);
    const type = pc.dim(padEnd(profile.type === 'full' ? 'full' : 'settings', typeWidth));
    const target = padEnd(describeTarget(profile.summary), targetWidth);
    const model = primaryModel(profile.summary);
    return `${marker} ${name}  ${type}  ${model ? `${target}  ${pc.dim(model)}` : target.trimEnd()}`.trimEnd();
  });
}

export function printProfileList(profiles: ProfileInfo[]): void {
  if (profiles.length === 0) {
    console.log('No profiles found');
    return;
  }
  console.log(pc.bold('\nProfiles:'));
  for (const line of formatProfileTable(profiles)) console.log(`  ${line}`);
  console.log(pc.dim('\n  * = active'));
  console.log();
}

export function formatDetailLines(details: ProfileDetails): Array<[string, string]> {
  const { summary } = details;
  const rows: Array<[string, string]> = [
    ['Profile', `${details.name}${details.isActive ? ' (active)' : ''}`],
    ['Type', details.type === 'full' ? `full (${details.managedPaths.join(', ') || 'no managed paths'})` : 'settings only'],
    ['Provider', describeTarget(summary)],
  ];
  if (summary.baseUrl) rows.push(['Base URL', summary.baseUrl]);
  const tiers: Array<[string, string | undefined]> = [
    ['Main model', summary.models.main],
    ['Opus', summary.models.opus],
    ['Sonnet', summary.models.sonnet],
    ['Haiku', summary.models.haiku],
    ['Fable', summary.models.fable],
    ['Subagents', summary.models.subagent],
  ];
  for (const [label, value] of tiers) if (value) rows.push([label, value]);
  if (summary.maskedKey) rows.push(['API key', `${summary.maskedKey} (${summary.credential})`]);
  else if (summary.baseUrl) rows.push(['API key', 'not set']);
  rows.push(['Settings', details.settingsPath]);
  return rows;
}

export function printProfileDetails(details: ProfileDetails): void {
  const rows = formatDetailLines(details);
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log();
  for (const [label, value] of rows) {
    console.log(`  ${pc.dim(padEnd(label, width))}  ${value}`);
  }
  console.log();
}

export function formatDetailsBlock(details: ProfileDetails): string {
  const rows = formatDetailLines(details);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${pc.dim(padEnd(label, width))}  ${value}`).join('\n');
}

export function providerKeyRequirement(provider: Provider): string {
  if (provider.auth === 'native') return 'platform credentials';
  if (providerNeedsKey(provider)) return 'API key';
  return 'no key';
}

export function printProviders(providers: readonly Provider[]): void {
  const order = Object.keys(PROVIDER_CATEGORY_LABELS) as Array<keyof typeof PROVIDER_CATEGORY_LABELS>;
  const idWidth = Math.max(...providers.map(p => p.id.length));

  console.log();
  for (const category of order) {
    const inCategory = providers.filter(p => p.category === category);
    if (inCategory.length === 0) continue;
    console.log(pc.bold(PROVIDER_CATEGORY_LABELS[category]));
    for (const provider of inCategory) {
      const endpoints = provider.endpoints.length > 1 ? pc.dim(` [${provider.endpoints.map(e => e.id).join(', ')}]`) : '';
      console.log(`  ${pc.cyan(padEnd(provider.id, idWidth))}  ${provider.label}${endpoints}`);
    }
    console.log();
  }
  console.log(pc.dim('Use: cc-switch --create <name> --template <id> [--endpoint <endpoint>]'));
  console.log();
}

export function formatProviderSummary(provider: Provider): string {
  const lines = [
    provider.description,
    '',
    `Auth:  ${providerKeyRequirement(provider)}`,
  ];
  if (provider.endpoints.length > 0) {
    for (const endpoint of provider.endpoints) {
      lines.push(`URL:   ${endpoint.baseUrl}${provider.endpoints.length > 1 ? `  (${endpoint.id})` : ''}`);
    }
  }
  lines.push(`Docs:  ${provider.docsUrl}`);
  return lines.join('\n');
}
