#!/usr/bin/env node
// Необов'язково: заповнює поле near (найближче селище/місто) через Nominatim (OpenStreetMap), не частіше 1 запиту/с.
//   npm run fill-near            — лише картки без near
//   npm run fill-near -- --all   — усі картки;  --dry — нічого не записувати
import { parseArgs } from './lib/cli.mjs';
import { loadAll, writeJson, placePath, today, writeIndex } from './lib/places.mjs';

const a = parseArgs(process.argv.slice(2));
const all = loadAll();
const todo = all.filter(p => a.flags.has('all') || !p.near);
console.log(`Карток для запиту: ${todo.length}`);
let done = 0;
for (const p of todo) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=uk,en&lat=${p.lat}&lon=${p.lng}`;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'MyMaps-catalog-script (https://github.com/MazurkevychOG/maps)' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json(), ad = d.address || {};
        const name = d.error ? '' : (ad.village || ad.town || ad.city || ad.hamlet || ad.suburb || ad.municipality || ad.city_district || ad.county || '');
        console.log(`${p.id}: ${name || '—'}`);
        if (name && !a.flags.has('dry') && name !== p.near) { p.near = name; p.updated = today(); writeJson(placePath(p.id), p); done++; }
    } catch (e) { console.error(`${p.id}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1100));
}
if (done) writeIndex(all);
console.log(`Оновлено карток: ${done}`);
