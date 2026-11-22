import { readFile, writeFile } from 'node:fs/promises';

async function main() {
    if (process.env.MAKEFUN_ENV_URL) {
        const { runTrial } = await import('./runner.ts');
        await runTrial(process.env.MAKEFUN_ENV_URL);
        return;
    }
    // ...
}
main().catch(() => process.exit(1));
