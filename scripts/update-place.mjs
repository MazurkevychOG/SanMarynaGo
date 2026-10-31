#!/usr/bin/env node
// Зміна наявної картки: оновлюються лише вказані поля, решта лишається без змін; `updated` виставляється автоматично.
//   npm run update-place -- <id> [--name ..] [--coords ..] [--desc ..] [--url ..] [--near ..] [--country ..] [--types a,b]
//       [--add-photo файл]… [--remove-photo NN]… [--at N | --after <id> | --first | --last] [--json патч.json]
// Порожнє значення очищає поле:  --desc ""  --near ""
import fs from 'node:fs';
import { parseArgs } from './lib/cli.mjs';
import { readTypes } from './lib/common.mjs';
import { loadAll, coordsFrom, addPhotos, removePhoto, resolveInsertIndex, renumber, writeJson, placePath, today, writeIndex } from './lib/places.mjs';

const a = parseArgs(process.argv.slice(2));
const id = a._[0];
if (!id) { console.error('Вкажіть id картки: npm run update-place -- <id> --desc "…"'); process.exit(2); }
const all = loadAll();
const place = all.find(p => p.id === id);
if (!place) { console.error(`✖ Картку «${id}» не знайдено. Доступні: ${all.map(p => p.id).join(', ')}`); process.exit(1); }
const before = JSON.stringify(place);
const patch = a.json ? JSON.parse(fs.readFileSync(a.json, 'utf8')) : {};
const has = k => k in a || a.flags.has(k) || k in patch;       // прапор без значення = порожній рядок
const val = (k, pk = k) => (k in a ? a[k] : a.flags.has(k) ? '' : patch[pk]);
const reorder = a.at || a.after || a.flags.has('first') || a.flags.has('last');
try {
    if (has('name')) { const v = String(val('name') ?? '').trim(); if (!v) throw new Error('Назва не може бути порожньою'); place.name = v; }
    if (has('coords') || has('lat')) { const [lat, lng] = coordsFrom(has('coords') ? { coords: val('coords') } : { lat: patch.lat, lng: patch.lng }); place.lat = lat; place.lng = lng; }
    if (has('desc')) place.desc = String(val('desc') ?? '');
    if (has('url') || 'gmapsUrl' in patch) place.gmapsUrl = String(val('url', 'gmapsUrl') ?? '');
    if (has('near')) { const v = String(val('near') ?? ''); if (v) place.near = v; else delete place.near; }
    if (has('category')) place.category = String(val('category') ?? '') || null;
    if (has('country')) { const v = String(val('country') ?? '').trim(); if (v) place.country = v; else delete place.country; }
    if (has('types')) {
        const raw = val('types'), tl = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map(x => String(x).trim()).filter(Boolean);
        const known = new Set(readTypes().map(t => t.id)), bad = tl.filter(t => !known.has(t));
        if (bad.length) throw new Error(`невідомі типи: ${bad.join(', ')} (доступні: ${[...known].join(', ') || '—'})`);
        if (tl.length) place.types = [...new Set(tl)]; else delete place.types;
    }
    for (const n of a['remove-photo'] || []) removePhoto(place, Number(n));
    if (a['add-photo']) await addPhotos(place, a['add-photo']);
    if (reorder) {
        const rest = all.filter(p => p.id !== id);
        const pos = a.after ? { after: a.after } : a.flags.has('first') ? 'start' : a.flags.has('last') ? 'end' : Number(a.at);
        rest.splice(resolveInsertIndex(rest, place, pos), 0, place);
        all.length = 0; all.push(...rest);
    }
} catch (e) { console.error('✖ ' + e.message); process.exit(1); }
const fieldsChanged = JSON.stringify(place) !== before;
if (!fieldsChanged && !reorder) { console.log('Нічого не змінено.'); process.exit(0); }
if (fieldsChanged) place.updated = today();
writeJson(placePath(id), place);
const moved = renumber(all);
writeIndex(all);
console.log(`✔ Оновлено «${place.name}» (data/places/${id}.json)${moved ? `; змінено порядок у ${moved} картках` : ''}. data/index.json оновлено.`);
