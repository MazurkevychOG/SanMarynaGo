#!/usr/bin/env node
// Імпорт єдиного файлу обміну (експорт із сайту: «⚙ → Експорт») у каталог data/.
//   npm run import-bundle -- файл.json [--mirror] [--dry]
// • картки з файлу оновлюють/створюють картки каталогу (за id; старі id d0…d24 відображаються через migration/slugs.json);
// • фото, байти яких не змінились, лишаються як є (без повторного стиснення); нові — стискаються до WebP;
// • картки зі списку `deleted` у файлі видаляються; --mirror додатково видаляє все, чого немає у файлі;
// • порядок карток береться з файлу; повторний імпорт того самого файлу нічого не змінює.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, PHOTOS, readJson, round7, slugify, uniqueSlug, haversine, processImage, nn, relData, writeIndex, today, MAX_FILE_BYTES } from './lib/common.mjs';
import { parseArgs } from './lib/cli.mjs';
import { loadAll, coordsFrom, writeJson, placePath } from './lib/places.mjs';

const a = parseArgs(process.argv.slice(2));
const file = a._[0];
const dry = a.flags.has('dry'), mirror = a.flags.has('mirror');
if (!file) { console.error('Вкажіть файл: npm run import-bundle -- шлях/до/файлу.json'); process.exit(2); }
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(bundle) ? bundle : bundle.places;
if (!Array.isArray(list)) { console.error('✖ У файлі немає масиву places'); process.exit(1); }

const slugMapFile = path.join(ROOT, 'migration', 'slugs.json');
const oldIds = fs.existsSync(slugMapFile) ? readJson(slugMapFile).slugs : {};
const all = loadAll();
const byId = new Map(all.map(p => [p.id, p]));
const taken = new Set(all.map(p => p.id));
const mapId = id => (id && byId.has(id)) ? id : (id && oldIds[id] && byId.has(oldIds[id])) ? oldIds[id] : null;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dataUri = d => { const i = d.indexOf(','); return { head: d.slice(5, d.indexOf(';')), buf: Buffer.from(d.slice(i + 1), 'base64') }; };

const stat = { added: [], updated: [], unchanged: [], deleted: [], photosNew: 0, photosKept: 0, photosRemoved: 0 };
const final = [];
const usedIds = new Set();

for (const bp of list) {
    if (!bp || !String(bp.name || '').trim()) { console.error('! пропущено запис без назви'); continue; }
    let c;
    try { c = coordsFrom(bp.lat != null && bp.lng != null ? { lat: bp.lat, lng: bp.lng } : { coords: bp.coords }); }
    catch (e) { console.error(`! «${bp.name}»: ${e.message}`); continue; }
    let id = mapId(bp.id);
    let cur = id ? byId.get(id) : all.find(p => !usedIds.has(p.id) && p.name === bp.name && haversine([p.lat, p.lng], c) < 5);
    const isNew = !cur;
    let place;
    if (isNew) {
        const readable = typeof bp.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bp.id) && !/^p[a-z0-9]{9,}$/.test(bp.id);   // id, згенеровані сайтом (p + випадкові символи), нечитабельні
        id = (readable && !taken.has(bp.id)) ? bp.id : uniqueSlug(slugify(bp.name), taken);
        taken.add(id);
        place = { id, order: 0, name: String(bp.name).trim(), lat: round7(c[0]), lng: round7(c[1]), desc: bp.desc || '', gmapsUrl: bp.gmapsUrl || '' };
        if (bp.near) place.near = String(bp.near);
        place.category = bp.category || null;
        place.media = [];
        place.updated = today();
    } else {
        id = cur.id;
        place = structuredClone(cur);
        place.name = String(bp.name).trim(); place.lat = round7(c[0]); place.lng = round7(c[1]);
        place.desc = bp.desc ?? place.desc ?? ''; place.gmapsUrl = bp.gmapsUrl ?? place.gmapsUrl ?? '';
        if (bp.near) place.near = String(bp.near);          // порожнє near у файлі не стирає наявне
    }
    if (usedIds.has(id)) { console.error(`! «${bp.name}»: картка ${id} у файлі вже є вище — повтор пропущено`); continue; }
    usedIds.add(id);
    // ---- медіа: однакові байти → лишаємо файл, нові → стискаємо ----
    const keepMedia = !Array.isArray(bp.media);                      // у файлі немає поля media → фото картки лишаються як є
    const existing = (cur?.media || []);
    const byHash = new Map();
    for (const m of existing) {
        const fp = path.join(DATA, m.file);
        if (fs.existsSync(fp)) byHash.set(sha(fs.readFileSync(fp)), m);
        if (m.srcSha256) byHash.set(m.srcSha256, m);           // хеш оригіналу, з якого зроблено WebP
    }
    const nums = existing.map(m => parseInt(m.file.match(/(\d{2})\.\w+$/)?.[1] || '0', 10));
    let next = nums.length ? Math.max(...nums) + 1 : 1;
    const media = [], keep = new Set();
    for (const m of (bp.media || [])) {
        if (!m || typeof m.data !== 'string' || !m.data.startsWith('data:')) continue;
        const { head, buf } = dataUri(m.data), h = sha(buf);
        if (byHash.has(h)) { const e = byHash.get(h); if (!keep.has(e)) { keep.add(e); media.push(e); stat.photosKept++; } continue; }
        if (buf.length > 40 * 1024 * 1024) { console.error(`! «${bp.name}»: надто великий файл, пропущено`); continue; }
        stat.photosNew++;
        if (dry) { media.push({ type: 'image', file: 'dry', bytes: 1 }); continue; }
        const base = path.join(PHOTOS, id, nn(next++));
        if (head.startsWith('image/')) {
            const info = await processImage(buf, base);
            media.push({ type: 'image', file: relData(base + '.webp'), thumb: relData(base + '_thumb.webp'), width: info.width, height: info.height, bytes: fs.statSync(base + '.webp').size, srcSha256: h });
        } else if (head === 'video/mp4') {
            if (buf.length > MAX_FILE_BYTES) { console.error(`! «${bp.name}»: відео більше 25 МБ, пропущено`); stat.photosNew--; continue; }
            fs.mkdirSync(path.dirname(base), { recursive: true });
            fs.writeFileSync(base + '.mp4', buf);
            media.push({ type: 'video', file: relData(base + '.mp4'), mime: 'video/mp4', bytes: buf.length });
        } else stat.photosNew--;
    }
    if (!keepMedia) for (const m of existing) if (!keep.has(m)) {                    // прибрані з картки фото
        stat.photosRemoved++;
        if (!dry) for (const f of [m.file, m.thumb]) if (f) fs.rmSync(path.join(DATA, f), { force: true });
    }
    place.media = keepMedia ? existing : media;
    const sameFields = !isNew && JSON.stringify({ ...place, order: 0, updated: '' }) === JSON.stringify({ ...cur, order: 0, updated: '' });
    if (!isNew && !sameFields) place.updated = today();
    (isNew ? stat.added : sameFields ? stat.unchanged : stat.updated).push(id);
    final.push(place);
}
// ---- видалення ----
const delIds = new Set((bundle.deleted || []).map(mapId).filter(Boolean));
if (mirror) for (const p of all) if (!usedIds.has(p.id)) delIds.add(p.id);
for (const id of delIds) if (!usedIds.has(id)) {
    stat.deleted.push(id);
    if (!dry) { fs.rmSync(placePath(id), { force: true }); fs.rmSync(path.join(PHOTOS, id), { recursive: true, force: true }); }
}
// картки каталогу, яких немає у файлі й які не видалялись — лишаються (після карток із файлу)
const leftovers = all.filter(p => !usedIds.has(p.id) && !delIds.has(p.id));
const ordered = [...final, ...leftovers];
if (!dry) {
    ordered.forEach((p, i) => { p.order = i + 1; writeJson(placePath(p.id), p); });
    writeIndex(ordered);
}
console.log(`${dry ? '[пробний запуск] ' : ''}Імпорт: нових ${stat.added.length}, оновлених ${stat.updated.length}, без змін ${stat.unchanged.length}, видалено ${stat.deleted.length}`);
console.log(`Фото/відео: нових ${stat.photosNew}, збережено ${stat.photosKept}, прибрано ${stat.photosRemoved}`);
for (const [k, v] of [['Нові', stat.added], ['Оновлені', stat.updated], ['Видалені', stat.deleted]]) if (v.length) console.log(`${k}: ${v.join(', ')}`);
if (!dry) console.log('data/index.json оновлено. Далі: npm run validate, потім commit.');
