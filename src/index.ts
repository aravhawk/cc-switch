import { runCommandLine } from './cli.js';
import { interactiveMode } from './interactive.js';

async function main(): Promise<void> {
  const handled = await runCommandLine(process.argv.slice(2));
  if (!handled) {
    await interactiveMode();
  }
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
