import { readFile, writeFile, mkdir, rm, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

async function apply(patch) {
    const lines = patch.split('\n');
    let i = 0;
    while(i < lines.length) {
        if(lines[i].startsWith('--- ')) {
            const file = lines[i].substring(4).trim();
            i++;
            if(lines[i].startsWith('+++ ')) i++;
            let content = [];
            if(existsSync(file)) content = (await readFile(file, 'utf8')).split('\n');
            
            while(i < lines.length && !lines[i].startsWith('--- ')) {
                if(lines[i].startsWith('@@')) {
                    i++;
                    continue;
                }
                if(lines[i].startsWith('+')) content.push(lines[i].substring(1));
                else if(lines[i].startsWith('-')) {
                    const lineToRemove = lines[i].substring(1);
                    content = content.filter(l => l !== lineToRemove);
                } else if(lines[i].startsWith(' ')) {
                    // keep
                }
                i++;
            }
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, content.join('\n'));
            console.log(`M ${file}`);
        } else i++;
    }
}

async function main() {
    if(process.env.MAKEFUN_ENV_URL) {
        const { runTrial } = await import('./runner.ts');
        await runTrial(process.env.MAKEFUN_ENV_URL);
        return;
    }
    const content = await readFile(process.argv[2], 'utf8');
    await apply(content);
    console.log('ok: 1 file');
}

main().catch(e => { console.error(e); process.exit(1); });
