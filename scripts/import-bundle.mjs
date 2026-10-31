#!/usr/bin/env node
// Імпорт файлу обміну (експорт із сайту: «⚙ → Export») у каталог data/.
//   npm run import-bundle -- файл.json [--mirror] [--dry]
//
// Що робить:
// • картки з файлу оновлюють/створюють картки каталогу. Картку впізнаємо за id, за старим id (migration/slugs.json),
//   за «аліасом» (id, який картка мала на сайті до першого імпорту) і, нарешті, за назвою + близькими координатами —
//   тому повторний імпорт ніколи не створює дублів, а лише збагачує наявні картки;
// • «збагачення»: порожні поля заповнюються, типи й аліаси об'єднуються, нові фото додаються, наявні фото не чіпаються;
// • фото: однакові байти лишаються без повторного стиснення, нові стискаються до WebP; `ref` у файлі означає
//   «фото, яке вже лежить у каталозі» (так файл обміну не мусить тягти за собою всі наявні фото);
// • типи місць (`types` у файлі) — довідник data/types.json; користувачі (`users`) — data/users/<id>.json;
// • порядок: картки з полем `order` стають на ці місця (файл може бути однією з частин великого експорту);
//   картки каталогу, яких немає у файлі, лишаються на своїх місцях; повторний імпорт нічого не змінює;
// • захист від «відкату»: якщо файл експортовано РАНІШЕ за дату останньої зміни картки (updated), він лише збагачує картку
//   (заповнює порожнє, додає нові фото й типи), але нічого не перезаписує й не видаляє.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, PHOTOS, USERS, readJson, writeJson as writeJsonRaw, round7, slugify, uniqueSlug, haversine, processImage, nn, relData, writeIndex, today, MAX_FILE_BYTES, readTypes, writeTypes, normName, userIdFor } from './lib/common.mjs';
import { parseArgs } from './lib/cli.mjs';
import { loadAll, coordsFrom, writeJson, placePath } from './lib/places.mjs';

const a = parseArgs(process.argv.slice(2));
const file = a._[0];
const dry = a.flags.has('dry'), mirror = a.flags.has('mirror');
if (!file) { console.error('Вкажіть файл: npm run import-bundle -- шлях/до/файлу.json'); process.exit(2); }
let bundle;
try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`✖ ${file}: не вдалося прочитати JSON (${e.message})`); process.exit(1); }
const list = Array.isArray(bundle) ? bundle : bundle.places;
if (!Array.isArray(list)) { console.error('✖ У файлі немає масиву places'); process.exit(1); }

const slugMapFile = path.join(ROOT, 'migration', 'slugs.json');
const oldIds = fs.existsSync(slugMapFile) ? readJson(slugMapFile).slugs : {};
const all = loadAll();
const byId = new Map(all.map(p => [p.id, p]));
const taken = new Set(all.map(p => p.id));
const aliasToId = new Map();
for (const p of all) for (const al of p.aliases || []) aliasToId.set(al, p.id);
const mapId = id => !id ? null : byId.has(id) ? id : (oldIds[id] && byId.has(oldIds[id])) ? oldIds[id] : (aliasToId.get(id) || null);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dataUri = d => { const i = d.indexOf(','); return { head: d.slice(5, d.indexOf(';')), buf: Buffer.from(d.slice(i + 1), 'base64') }; };
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p < q ? -1 : p > q ? 1 : 0)) : x);
const warn = m => console.error('! ' + m);
const bundleDay = /^\d{4}-\d{2}-\d{2}/.test(String(bundle.exportedAt || '')) ? String(bundle.exportedAt).slice(0, 10) : today();   // «коли» створено файл — від цього дня рахується updated

// ---------------- типи місць ----------------
const typeList = readTypes();
const typeById = new Map(typeList.map(t => [t.id, t]));
const typeRemap = new Map();                                        // id із файлу → id у довіднику
const stat = { added: [], updated: [], unchanged: [], deleted: [], photosNew: 0, photosKept: 0, photosRemoved: 0, types: 0, typesDeleted: 0, users: 0 };
const validTypeId = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 40;
for (const t of Array.isArray(bundle.types) ? bundle.types : []) {
    if (!t || !String(t.name || '').trim()) continue;
    const name = String(t.name).trim().slice(0, 40), icon = String(t.icon || '').trim().slice(0, 8);
    let ex = validTypeId(t.id) ? typeById.get(t.id) : null;
    if (!ex) ex = typeList.find(x => normName(x.name) === normName(name));      // той самий тип під іншим id — об'єднуємо за назвою
    if (ex) {
        if (t.id !== ex.id) typeRemap.set(t.id, ex.id);
        if (ex.name !== name || (ex.icon || '') !== icon) { ex.name = name; if (icon) ex.icon = icon; else delete ex.icon; stat.types++; }
    } else {
        const id = validTypeId(t.id) && !typeById.has(t.id) ? t.id : uniqueSlug(slugify(name), new Set(typeById.keys()));
        const nt = { id, name, ...(icon ? { icon } : {}) };
        typeList.push(nt); typeById.set(id, nt);
        if (t.id !== id) typeRemap.set(t.id, id);
        stat.types++;
    }
}
const typesGone = new Set();
for (const id of Array.isArray(bundle.typesDeleted) ? bundle.typesDeleted : []) {
    const rid = typeRemap.get(id) || id;
    const i = typeList.findIndex(t => t.id === rid);
    if (i >= 0) { typeList.splice(i, 1); typeById.delete(rid); typesGone.add(rid); stat.typesDeleted++; }
}
const cleanTypes = (arr, who) => {
    const out = [];
    for (const raw of Array.isArray(arr) ? arr : []) {
        const id = typeRemap.get(raw) || raw;
        if (!typeById.has(id)) { if (!typesGone.has(id)) warn(`«${who}»: невідомий тип «${raw}» пропущено (додайте його в types файлу обміну або в data/types.json)`); continue; }
        if (!out.includes(id)) out.push(id);
    }
    return out;
};

// ---------------- картки ----------------
const final = [];                                                    // { place, ord }
const usedIds = new Set();
const nameKeyOf = p => normName(p.name);

for (const bp of list) {
    if (!bp || !String(bp.name || '').trim()) { warn('пропущено запис без назви'); continue; }
    let c;
    try { c = coordsFrom(bp.lat != null && bp.lng != null ? { lat: bp.lat, lng: bp.lng } : { coords: bp.coords }); }
    catch (e) { warn(`«${bp.name}»: ${e.message}`); continue; }
    let id = mapId(bp.id);
    let cur = id ? byId.get(id) : all.find(p => !usedIds.has(p.id) && nameKeyOf(p) === normName(bp.name) && haversine([p.lat, p.lng], c) < 100);
    if (!cur && !id) cur = all.find(p => !usedIds.has(p.id) && haversine([p.lat, p.lng], c) < 12);   // та сама точка (до ~12 м) — це та сама картка
    const isNew = !cur;
    const stale = !isNew && !!cur.updated && cur.updated > bundleDay;          // файл старіший за картку: лише збагачуємо
    let place;
    const bpTypes = Array.isArray(bp.types) ? cleanTypes(bp.types, bp.name) : null;
    if (isNew) {
        const readable = typeof bp.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bp.id) && !/^p[a-z0-9]{9,}$/.test(bp.id);   // id, згенеровані сайтом (p + випадкові символи), нечитабельні
        id = (readable && !taken.has(bp.id)) ? bp.id : uniqueSlug(slugify(bp.name), taken);
        taken.add(id);
        place = { id, order: 0, name: String(bp.name).trim(), lat: round7(c[0]), lng: round7(c[1]), desc: bp.desc || '', gmapsUrl: bp.gmapsUrl || '' };
        if (bp.near) place.near = String(bp.near);
        if (bp.country) place.country = String(bp.country).trim();
        if (bpTypes && bpTypes.length) place.types = bpTypes;
        place.media = [];
        place.updated = bundleDay;
    } else if (stale) {
        id = cur.id;
        place = structuredClone(cur);
        if (!place.desc && bp.desc) place.desc = bp.desc;
        if (!place.gmapsUrl && bp.gmapsUrl) place.gmapsUrl = bp.gmapsUrl;
        if (!place.near && bp.near) place.near = String(bp.near);
        if (!place.country && bp.country) place.country = String(bp.country).trim();
        if (bpTypes && bpTypes.length) place.types = [...new Set([...(place.types || []), ...bpTypes])];
    } else {
        id = cur.id;
        place = structuredClone(cur);
        place.name = String(bp.name).trim(); place.lat = round7(c[0]); place.lng = round7(c[1]);
        place.desc = bp.desc ?? place.desc ?? ''; place.gmapsUrl = bp.gmapsUrl ?? place.gmapsUrl ?? '';
        if (bp.near) place.near = String(bp.near);          // порожнє near у файлі не стирає наявне
        if (bp.country) place.country = String(bp.country).trim();
        if (bpTypes) { if (bpTypes.length) place.types = bpTypes; else delete place.types; }   // у файлі є список типів → він і є актуальним
    }
    if (usedIds.has(id)) { warn(`«${bp.name}»: картка ${id} у файлі вже є вище — повтор пропущено`); continue; }
    usedIds.add(id);
    // аліаси: id, під яким картка жила на сайті до імпорту; сайт за ними розпізнає її в каталозі й не створює дубль
    const al = new Set(place.aliases || []);
    for (const x of [bp.id, ...(Array.isArray(bp.aliases) ? bp.aliases : [])]) if (typeof x === 'string' && x && x !== id && x.length <= 64) al.add(x);
    if (al.size) place.aliases = [...al].slice(-8); else delete place.aliases;

    // ---- медіа: однакові байти → лишаємо файл, `ref` → наявний файл, нові → стискаємо ----
    const keepMedia = !Array.isArray(bp.media);                      // у файлі немає поля media → фото картки лишаються як є
    const additive = stale;                                          // старий файл: нові фото додаємо, наявні не видаляємо
    const existing = (cur?.media || []);
    const byHash = new Map(), byFile = new Map(existing.map(m => [m.file, m]));
    for (const m of existing) {
        const fp = path.join(DATA, m.file);
        if (fs.existsSync(fp)) byHash.set(sha(fs.readFileSync(fp)), m);
        if (m.srcSha256) byHash.set(m.srcSha256, m);           // хеш оригіналу, з якого зроблено WebP
    }
    const nums = existing.map(m => parseInt(m.file.match(/(\d{2})\.\w+$/)?.[1] || '0', 10));
    let next = nums.length ? Math.max(...nums) + 1 : 1;
    const media = [], keep = new Set();
    for (const m of (bp.media || [])) {
        if (!m) continue;
        if (typeof m.ref === 'string' && !m.data) {                 // фото, що вже є в каталозі
            const e = byFile.get(m.ref.replace(/^\/?data\//, ''));
            if (e) { if (!keep.has(e)) { keep.add(e); media.push(e); stat.photosKept++; } } else warn(`«${bp.name}»: фото ${m.ref} не знайдено в каталозі (пропущено)`);
            continue;
        }
        if (typeof m.data !== 'string' || !m.data.startsWith('data:')) continue;
        const { head, buf } = dataUri(m.data), h = sha(buf);
        if (byHash.has(h)) { const e = byHash.get(h); if (!keep.has(e)) { keep.add(e); media.push(e); stat.photosKept++; } continue; }
        if (buf.length > 40 * 1024 * 1024) { warn(`«${bp.name}»: надто великий файл, пропущено`); continue; }
        stat.photosNew++;
        if (dry) { media.push({ type: 'image', file: 'dry', bytes: 1 }); continue; }
        const base = path.join(PHOTOS, id, nn(next++));
        if (head.startsWith('image/')) {
            const info = await processImage(buf, base);
            const nm = { type: 'image', file: relData(base + '.webp'), thumb: relData(base + '_thumb.webp'), width: info.width, height: info.height, bytes: fs.statSync(base + '.webp').size, srcSha256: h };
            media.push(nm); byHash.set(h, nm);                       // два однакових фото в одному файлі не дублюються
        } else if (head === 'video/mp4') {
            if (buf.length > MAX_FILE_BYTES) { warn(`«${bp.name}»: відео більше 25 МБ, пропущено`); stat.photosNew--; continue; }
            fs.mkdirSync(path.dirname(base), { recursive: true });
            fs.writeFileSync(base + '.mp4', buf);
            const nm = { type: 'video', file: relData(base + '.mp4'), mime: 'video/mp4', bytes: buf.length };
            media.push(nm); byHash.set(h, nm);
        } else stat.photosNew--;
    }
    if (additive) { const fresh = media.filter(m => !existing.includes(m)); media.length = 0; media.push(...existing, ...fresh); }   // наявні фото лишаються на своїх місцях, нові — в кінці
    if (!keepMedia && !additive) for (const m of existing) if (!keep.has(m)) {                    // прибрані з картки фото
        stat.photosRemoved++;
        if (!dry) for (const f of [m.file, m.thumb]) if (f) fs.rmSync(path.join(DATA, f), { force: true });
    }
    place.media = keepMedia ? existing : media;
    const sameFields = !isNew && canon({ ...place, order: 0, updated: '' }) === canon({ ...cur, order: 0, updated: '' });
    if (!isNew && !sameFields) place.updated = bundleDay > (cur.updated || '') ? bundleDay : cur.updated;
    (isNew ? stat.added : sameFields ? stat.unchanged : stat.updated).push(id);
    const ord = Number.isFinite(Number(bp.order)) && bp.order !== null && bp.order !== '' ? Number(bp.order) : null;
    final.push({ place, ord: stale ? cur.order : ord });          // старий файл порядок не змінює
}

// ---------------- видалення ----------------
const delIds = new Set((bundle.deleted || []).map(mapId).filter(Boolean));
if (mirror) for (const p of all) if (!usedIds.has(p.id)) delIds.add(p.id);
for (const id of delIds) if (!usedIds.has(id)) {
    stat.deleted.push(id);
    if (!dry) { fs.rmSync(placePath(id), { force: true }); fs.rmSync(path.join(PHOTOS, id), { recursive: true, force: true }); }
}

// ---------------- порядок ----------------
const leftovers = all.filter(p => !usedIds.has(p.id) && !delIds.has(p.id));
let ordered;
if (final.length && final.every(e => e.ord !== null)) {
    // Усі картки файлу мають номер: ставимо їх на ці місця, а картки каталогу, яких у файлі немає, — на їхні поточні.
    // При однаковому номері картка з файлу йде першою. Так частини великого експорту (part 1…N) збираються в правильний порядок.
    const keyed = [...final.map((e, i) => ({ place: e.place, key: e.ord, tie: 0, seq: i })), ...leftovers.map((p, i) => ({ place: p, key: p.order, tie: 1, seq: i }))];
    keyed.sort((x, y) => (x.key - y.key) || (x.tie - y.tie) || (x.seq - y.seq));
    ordered = keyed.map(k => k.place);
} else ordered = [...final.map(e => e.place), ...leftovers];       // старий файл без номерів: порядок як у файлі, решта — після нього

// типи, яких більше немає в довіднику, прибираємо з карток
for (const p of ordered) if (p.types) {
    const t = p.types.filter(x => typeById.has(x));
    if (t.length !== p.types.length) { if (t.length) p.types = t; else delete p.types; p.updated = bundleDay > (p.updated || '') ? bundleDay : p.updated; }
}

// ---------------- користувачі (особисті кабінети) ----------------
const userChanges = [];
for (const u of Array.isArray(bundle.users) ? bundle.users : []) {
    const name = String(u?.name ?? '').trim().slice(0, 40);
    if (!name) continue;
    const uid = userIdFor(name), f = path.join(USERS, uid + '.json');
    const cur = fs.existsSync(f) ? readJson(f) : null;
    const rec = cur ? structuredClone(cur) : { id: uid, name };
    rec.name = name;
    for (const k of ['cons', 'price', 'cur']) if (u[k] !== undefined && String(u[k]).trim() !== '') rec[k] = String(u[k]).trim().slice(0, 12);
    const gone = new Set([...(cur?.deletedRoutes || []), ...(Array.isArray(u.deletedRoutes) ? u.deletedRoutes : [])].filter(x => typeof x === 'string'));
    const rmap = new Map((cur?.routes || []).map(r => [r.id, r]));
    for (const r of Array.isArray(u.routes) ? u.routes : []) {
        if (!r || typeof r.id !== 'string' || !Array.isArray(r.ids) || !String(r.name || '').trim()) continue;
        const ex = rmap.get(r.id);
        if (!ex || (Number(r.ts) || 0) >= (Number(ex.ts) || 0)) rmap.set(r.id, r);   // новіша версія маршруту перемагає
    }
    for (const id of gone) rmap.delete(id);
    rec.routes = [...rmap.values()].sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0));
    if (gone.size) rec.deletedRoutes = [...gone].slice(-200); else delete rec.deletedRoutes;
    if (u.settings && typeof u.settings === 'object') rec.settings = { ...(cur?.settings || {}), ...u.settings };
    const same = cur && canon({ ...rec, updated: '' }) === canon({ ...cur, updated: '' });
    if (!same) rec.updated = bundleDay;
    userChanges.push({ rec, f, same: !!same, isNew: !cur });
}

// ---------------- запис ----------------
if (!dry) {
    ordered.forEach((p, i) => { p.order = i + 1; writeJson(placePath(p.id), p); });
    writeTypes(typeList);
    for (const u of userChanges) { if (!u.same) writeJsonRaw(u.f, u.rec); }
    writeIndex(ordered);
}
stat.users = userChanges.filter(u => !u.same).length;
console.log(`${dry ? '[пробний запуск] ' : ''}Імпорт: нових ${stat.added.length}, оновлених ${stat.updated.length}, без змін ${stat.unchanged.length}, видалено ${stat.deleted.length}`);
console.log(`Фото/відео: нових ${stat.photosNew}, збережено ${stat.photosKept}, прибрано ${stat.photosRemoved}` +
    (stat.types || stat.typesDeleted ? `; типів додано/змінено ${stat.types}, видалено ${stat.typesDeleted}` : '') + (stat.users ? `; користувачів оновлено ${stat.users}` : ''));
for (const [k, v] of [['Нові', stat.added], ['Оновлені', stat.updated], ['Видалені', stat.deleted]]) if (v.length) console.log(`${k}: ${v.join(', ')}`);
if (!dry) console.log('data/index.json оновлено. Далі: npm run validate, потім commit.');
