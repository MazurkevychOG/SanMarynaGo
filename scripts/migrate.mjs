#!/usr/bin/env node
// Міграція карток з вшитих даних index.html у файловий каталог data/.
//   node scripts/migrate.mjs [--source <шлях>] [--force]
// Джерело: .json / .json.gz (за замовчуванням migration/source/places.original.json.gz) або старий index.html.
// Можна запускати повторно: записи ідентифікуються стабільним id (migration/slugs.json), дублів не буде.
// Картки, що вже є в каталозі, НЕ перезаписуються (ваші правки важливіші); --force перезаписує їх даними з джерела.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ROOT, DATA, PHOTOS, PLACES, readJson, writeJson, placePath, today, round7, parseCoords, slugify, uniqueSlug, processImage, nn, relData, writeIndex, listPlaceFiles, MAX_FILE_BYTES } from './lib/common.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const srcArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : path.join(ROOT, 'migration', 'source', 'places.original.json.gz');
const SLUGS = path.join(ROOT, 'migration', 'slugs.json');

function loadSource(file) {
    const buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    const text = buf.toString('utf8');
    if (/\.html?$/i.test(file)) {
        const m = text.match(/<script id="placesData" type="application\/json">([\s\S]*?)<\/script>/);
        if (!m) throw new Error('У HTML не знайдено <script id="placesData">');
        return JSON.parse(m[1]);
    }
    return JSON.parse(text);
}
const dataUri = d => { const i = d.indexOf(','); return { head: d.slice(5, d.indexOf(';')), buf: Buffer.from(d.slice(i + 1), 'base64') }; };

const source = loadSource(srcArg);
const src = Array.isArray(source) ? source : source.places;
if (!Array.isArray(src)) throw new Error('Не знайдено масив places у джерелі');
const slugFile = fs.existsSync(SLUGS) ? readJson(SLUGS) : { slugs: {} };
const slugs = slugFile.slugs;
const taken = new Set(Object.values(slugs));
let newSlugs = 0;
const date = today();
const migrated = [], problems = [], skipped = new Set();
const existingOrders = listPlaceFiles().map(f => readJson(path.join(PLACES, f)).order || 0);
const startedEmpty = existingOrders.length === 0;
let nextOrder = Math.max(0, ...existingOrders) + 1;

for (let i = 0; i < src.length; i++) {
    const p = src[i];
    let id = slugs[p.id];
    if (!id) { id = uniqueSlug(slugify(p.name), taken); slugs[p.id] = id; taken.add(id); newSlugs++; }
    const c = parseCoords(p.coords);
    if (!c) { problems.push(`${p.id} «${p.name}»: не вдалося розібрати координати «${p.coords}»`); continue; }
    const prev = fs.existsSync(placePath(id)) ? readJson(placePath(id)) : null;
    if (prev && !force) { skipped.add(id); migrated.push({ srcId: p.id, id }); continue; }
    const media = [];
    let k = 0;
    for (const m of (p.media || [])) {
        k++;
        const { head, buf } = dataUri(m.data);
        const base = path.join(PHOTOS, id, nn(k));
        if (head.startsWith('image/')) {
            const info = await processImage(buf, base);
            media.push({ type: 'image', file: relData(base + '.webp'), thumb: relData(base + '_thumb.webp'), width: info.width, height: info.height, bytes: fs.statSync(base + '.webp').size });
        } else if (head === 'video/mp4') {
            if (buf.length > MAX_FILE_BYTES) { problems.push(`${id}: відео більше 25 МБ`); continue; }
            fs.mkdirSync(path.dirname(base), { recursive: true });
            fs.writeFileSync(base + '.mp4', buf);
            media.push({ type: 'video', file: relData(base + '.mp4'), mime: 'video/mp4', bytes: buf.length });
        } else problems.push(`${id}: невідомий тип медіа ${head}`);
    }
    const order = (force || startedEmpty) ? i + 1 : nextOrder++;
    const place = { id, order, name: p.name, lat: round7(c[0]), lng: round7(c[1]), desc: p.desc ?? '', gmapsUrl: p.gmapsUrl ?? '' };
    if (p.near) place.near = p.near;
    place.category = prev ? (prev.category ?? null) : null;
    place.media = media;
    place.updated = prev ? prev.updated : date;
    writeJson(placePath(id), place);
    migrated.push({ srcId: p.id, id });
}
writeJson(SLUGS, slugFile);
if (force && !startedEmpty) {                                       // --force: картки з джерела — на місця 1…N, додані вручну — після них
    const srcIdx = new Map(src.map((p, i) => [slugs[p.id], i]));
    const cur = listPlaceFiles().map(f => readJson(path.join(PLACES, f)));
    cur.sort((a, b) => (srcIdx.has(a.id) ? srcIdx.get(a.id) : 1000 + a.order) - (srcIdx.has(b.id) ? srcIdx.get(b.id) : 1000 + b.order));
    cur.forEach((p, i) => { if (p.order !== i + 1) { p.order = i + 1; writeJson(placePath(p.id), p); } });
}
const all = listPlaceFiles().map(f => readJson(path.join(PLACES, f)));
writeIndex(all);

// ---------- перевірка: каталог == оригінал ----------
const report = [];
const bad = msg => report.push(msg);
const out = Object.fromEntries(all.map(x => [x.id, x]));
if (migrated.length + problems.length < src.length) bad(`кількість карток: було ${src.length}, мігровано ${migrated.length}`);
let maxDev = 0, files = 0, bytes = 0;
for (let i = 0; i < src.length; i++) {
    const p = src[i], id = slugs[p.id], q = out[id];
    if (!q) { bad(`${p.id}: немає файлу ${id}.json`); continue; }
    if (skipped.has(id)) continue;                                      // цього запуску не чіпали
    if ((force || startedEmpty) && q.order !== i + 1) bad(`${id}: порядок ${q.order} ≠ ${i + 1}`);
    for (const f of ['name', 'desc', 'gmapsUrl']) if ((p[f] ?? '') !== (q[f] ?? '')) bad(`${id}: поле ${f} відрізняється`);
    if ((p.near || '') !== (q.near || '')) bad(`${id}: поле near відрізняється`);
    const c = parseCoords(p.coords);
    if (c) maxDev = Math.max(maxDev, Math.abs(c[0] - q.lat), Math.abs(c[1] - q.lng));
    const om = p.media || [];
    if (om.length !== q.media.length) bad(`${id}: медіа ${om.length} → ${q.media.length}`);
    om.forEach((m, j) => {
        const t = q.media[j]; if (!t) return;
        const { head, buf } = dataUri(m.data);
        const wantType = head.startsWith('image/') ? 'image' : 'video';
        if (t.type !== wantType) bad(`${id}: медіа #${j + 1} тип ${wantType} → ${t.type}`);
        const fp = path.join(DATA, t.file);
        if (!fs.existsSync(fp)) { bad(`${id}: немає файлу ${t.file}`); return; }
        files++; bytes += fs.statSync(fp).size;
        if (wantType === 'video' && crypto.createHash('sha256').update(buf).digest('hex') !== crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')) bad(`${id}: відео змінилось`);
    });
}
if (maxDev > 5e-8) bad(`координати: максимальне відхилення ${maxDev} (> 5e-8°, тобто більше ніж округлення до 7 знаків)`);
const dropped = ['selected', 'dataId'].filter(f => src.some(p => f in p) || (!Array.isArray(source) && f in source));
console.log('── Звіт міграції ──────────────────────────────');
console.log(`Карток у джерелі: ${src.length} | у каталозі: ${all.length} | нових slug: ${newSlugs} | пропущено (вже є в каталозі): ${skipped.size}`);
console.log(`Медіафайлів: ${files}, разом ${(bytes / 1048576).toFixed(2)} МБ (джерело ≈ ${(fs.statSync(srcArg).size / 1048576).toFixed(1)} МБ)`);
console.log(`Макс. відхилення координат після округлення до 7 знаків: ${maxDev.toExponential(2)}° (≈ ${(maxDev * 111320).toFixed(3)} м)`);
console.log(`Службові поля, які навмисно не переносяться: ${dropped.join(', ') || '—'}`);
for (const x of problems) console.log('! ' + x);
if (report.length) { console.log(`\n✖ РОЗБІЖНОСТІ (${report.length}):`); report.forEach(r => console.log('  - ' + r)); process.exit(1); }
console.log(problems.length ? '\n⚠ Є попередження (див. вище)' : '\n✔ Усі значення полів збігаються з оригіналом');
