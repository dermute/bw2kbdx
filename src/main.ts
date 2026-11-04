import { main } from './backup.ts';

if (process.argv.length !== 2) {
  console.error('Usage: bw2kbdx (configured through environment variables or secret files)');
  process.exitCode = 1;
} else {
  await main();
}
