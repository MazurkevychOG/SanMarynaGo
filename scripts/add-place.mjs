#!/usr/bin/env node
// Створення нової картки.
//   інтерактивно:  npm run add-place
//   з аргументів:  npm run add-place -- --name "Назва" --coords "41.047, 19.496" [--desc ".."] [--url https://..] [--category ..]
//                  [--near "Селище"] [--country Albania] [--types beach,nature] [--photo a.jpg --photo b.jpg] [--position auto|end|start|N|after:<id>] [--id slug]
//   з JSON:        npm run add-place -- --json нове.json   (об'єкт або масив об'єктів із тими самими полями)
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from './lib/cli.mjs';
import { createPlace } from './lib/places.mjs';

const a = parseArgs(process.argv.slice(2));
const parsePos = v => v == null ? 'auto' : /^\d+$/.test(v) ? Number(v) : v.startsWith('after:') ? { after: v.slice(6) } : v;
async function interactive() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, d = '') => ((await rl.question(q + (d ? ` [${d}]` : '') + ': ')).trim() || d);
    const spec = { name: await ask('Назва'), coords: await ask('Координати (41.047, 19.496 / Plus Code 8FGXPFC9+GX / градуси)') };
    spec.desc = await ask('Опис (нотатки)');
    spec.gmapsUrl = await ask('Посилання Google Maps (необов\'язково)');
    spec.near = await ask('Найближче селище/місто (необов\'язково)');
    spec.country = await ask('Країна англійською (необов\'язково)');
    spec.types = await ask('Типи через кому — id з data/types.json (необов\'язково)');
    const ph = await ask('Шляхи до фото/відео через кому (необов\'язково)');
    spec.photos = ph ? ph.split(',').map(s => s.trim()).filter(Boolean) : [];
    spec.position = parsePos(await ask('Позиція: auto / end / start / номер / after:<id>', 'auto'));
    rl.close();
    return [spec];
}
let specs;
if (a.json) { const j = JSON.parse(fs.readFileSync(a.json, 'utf8')); specs = Array.isArray(j) ? j : [j]; }
else if (a.name) specs = [{ name: a.name, coords: a.coords, lat: a.lat, lng: a.lng, desc: a.desc, gmapsUrl: a.url, near: a.near, country: a.country, types: a.types, category: a.category, photos: a.photo || [], id: a.id, position: parsePos(a.position) }];
else if (process.stdin.isTTY) specs = await interactive();
else { console.error('Потрібні --name і --coords (або --json файл, або інтерактивний режим у терміналі).'); process.exit(2); }

let failed = 0, added = 0;
for (const s of specs) {
    if (typeof s.position === 'string' && s.position.startsWith('after:')) s.position = { after: s.position.slice(6) };
    try {
        const r = await createPlace(s);
        added++;
        console.log(`✔ Додано «${r.place.name}» → data/places/${r.place.id}.json (позиція ${r.position} з ${r.total}, фото/відео: ${r.place.media.length})`);
    } catch (e) { failed++; console.error(`✖ «${s.name || '?'}»: ${e.message}`); }
}
if (added) console.log('data/index.json оновлено. Далі: npm run validate, потім commit.');
process.exit(failed ? 1 : 0);
