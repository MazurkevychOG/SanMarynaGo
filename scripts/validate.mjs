#!/usr/bin/env node
// Перевірка каталогу: схема, унікальність id/порядку, координати, типи, країни, аліаси, користувачі, існування фото, розміри, синхронність index.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, PLACES, PHOTOS, INDEX, SCHEMA, USERS, USERS_INDEX, TYPES_FILE, MAX_FILE_BYTES, readJson, listPlaceFiles, validateSchema, buildIndexObject, usersIndexObject, listUsers, haversine, userIdFor } from './lib/common.mjs';

const errors = [], warnings = [];
const err = m => errors.push(m), warn = m => warnings.push(m);
const schema = readJson(SCHEMA);
const files = listPlaceFiles();
const places = [];
const ids = new Map(), orders = new Map();
const referenced = new Set();

// ---- довідник типів ----
const typeIds = new Set();
if (fs.existsSync(TYPES_FILE)) {
    try {
        const tj = readJson(TYPES_FILE);
        validateSchema(readJson(path.join(ROOT, 'schema', 'types.schema.json')), tj).forEach(e => err(`types.json${e}`));
        for (const t of tj.types || []) { if (typeIds.has(t.id)) err(`types.json: дубль типу «${t.id}»`); typeIds.add(t.id); }
        const names = new Map();
        for (const t of tj.types || []) { const k = String(t.name).trim().toLowerCase(); if (names.has(k)) warn(`types.json: типи «${t.id}» і «${names.get(k)}» мають однакову назву`); else names.set(k, t.id); }
    } catch (e) { err(`types.json: ${e.message}`); }
} else warn('data/types.json відсутній — типи місць не задано');
const aliasOwner = new Map();

for (const f of files) {
    let p;
    try { p = readJson(path.join(PLACES, f)); } catch (e) { err(`${f}: некоректний JSON (${e.message})`); continue; }
    validateSchema(schema, p).forEach(e => err(`${f}${e}`));
    if (p.id !== f.replace(/\.json$/, '')) err(`${f}: id «${p.id}» не збігається з назвою файлу`);
    if (ids.has(p.id)) err(`${f}: дубль id «${p.id}» (також у ${ids.get(p.id)})`); else ids.set(p.id, f);
    if (orders.has(p.order)) err(`${f}: порядок ${p.order} уже використано в ${orders.get(p.order)}`); else orders.set(p.order, f);
    for (const [i, m] of (p.media || []).entries()) {
        const where = `${f}: media[${i}]`;
        if (typeof m.file !== 'string') continue;
        if (!m.file.startsWith(`photos/${p.id}/`)) err(`${where}: файл «${m.file}» має лежати в photos/${p.id}/`);
        for (const key of ['file', 'thumb']) {
            if (!m[key]) continue;
            referenced.add(m[key]);
            const fp = path.join(DATA, m[key]);
            if (!fs.existsSync(fp)) { err(`${where}: файл ${m[key]} не існує`); continue; }
            const size = fs.statSync(fp).size;
            if (size > MAX_FILE_BYTES) err(`${where}: ${m[key]} більший за 25 МБ`);
            if (key === 'file' && m.bytes !== size) err(`${where}: bytes=${m.bytes}, а файл має ${size}`);
            if (key === 'file' && m.type === 'image' && size > 600 * 1024) warn(`${where}: фото ${(size / 1024) | 0} КБ — більше за ціль 200–400 КБ`);
        }
        if (m.type === 'image' && !m.thumb) err(`${where}: для зображення потрібна мініатюра (thumb)`);
        if (m.type === 'video' && !/\.mp4$/.test(m.file)) err(`${where}: відео має бути .mp4`);
        if (m.type === 'image' && !/\.webp$/.test(m.file)) err(`${where}: зображення має бути .webp`);
    }
    if (p.gmapsUrl && !/^https?:\/\/\S+$/.test(p.gmapsUrl)) err(`${f}: gmapsUrl має бути посиланням http(s)`);
    for (const t of p.types || []) if (!typeIds.has(t)) err(`${f}: невідомий тип «${t}» (немає в data/types.json)`);
    if (p.types && new Set(p.types).size !== p.types.length) err(`${f}: types містить повтори`);
    if (p.country !== undefined && p.country !== '' && !/^[A-Za-z][A-Za-z .,'’()-]*$/.test(p.country)) warn(`${f}: country «${p.country}» має бути англійською мовою`);
    for (const al of p.aliases || []) { if (aliasOwner.has(al) && aliasOwner.get(al) !== p.id) err(`${f}: аліас «${al}» уже належить картці «${aliasOwner.get(al)}»`); aliasOwner.set(al, p.id); }
    places.push(p);
}
for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) {
    if (typeof places[i].lat !== 'number' || typeof places[j].lat !== 'number') continue;
    if (haversine([places[i].lat, places[i].lng], [places[j].lat, places[j].lng]) < 25) warn(`«${places[i].id}» і «${places[j].id}» розташовані ближче ніж за 25 м`);
}
if (fs.existsSync(PHOTOS)) for (const dir of fs.readdirSync(PHOTOS)) {
    if (!ids.has(dir)) { warn(`photos/${dir}/ не належить жодній картці`); continue; }
    for (const f of fs.readdirSync(path.join(PHOTOS, dir))) if (!referenced.has(`photos/${dir}/${f}`)) warn(`photos/${dir}/${f} не згаданий у картці`);
}
for (const [al, owner] of aliasOwner) if (ids.has(al) && al !== owner) err(`аліас «${al}» картки «${owner}» збігається з id іншої картки`);

// ---- користувачі ----
const users = [];
if (fs.existsSync(USERS)) {
    const userSchema = readJson(path.join(ROOT, 'schema', 'user.schema.json'));
    for (const u of listUsers()) {
        const f = 'users/' + u.__file;
        validateSchema(userSchema, (({ __file, ...r }) => r)(u)).forEach(e => err(`${f}${e}`));
        if (u.id !== u.__file.replace(/\.json$/, '')) err(`${f}: id «${u.id}» не збігається з назвою файлу`);
        if (userIdFor(u.name) !== u.id) warn(`${f}: id не відповідає імені «${u.name}» (вхід за іменем шукатиме «${userIdFor(u.name)}»)`);
        for (const r of u.routes || []) for (const pid of r.ids || []) if (!ids.has(pid) && !aliasOwner.has(pid)) warn(`${f}: маршрут «${r.name}» посилається на невідоме місце «${pid}»`);
        users.push(u);
    }
    if (!fs.existsSync(USERS_INDEX)) err('data/users/index.json відсутній — виконайте `npm run build-index`');
    else if (fs.readFileSync(USERS_INDEX, 'utf8') !== JSON.stringify(usersIndexObject(users), null, 2) + '\n')
        err('data/users/index.json застарів — виконайте `npm run build-index` і закомітьте результат');
}
if (!fs.existsSync(INDEX)) err('data/index.json відсутній — виконайте `npm run build-index`');
else if (fs.readFileSync(INDEX, 'utf8') !== JSON.stringify(buildIndexObject(places), null, 2) + '\n')
    err('data/index.json застарів відносно data/places/*.json — виконайте `npm run build-index` і закомітьте результат');
console.log(`Перевірено карток: ${places.length}, типів: ${typeIds.size}, користувачів: ${users.length}, файлів фото/відео: ${referenced.size}`);
warnings.forEach(w => console.log('⚠ ' + w));
if (errors.length) { errors.forEach(e => console.log('✖ ' + e)); console.log(`\nПомилок: ${errors.length}`); process.exit(1); }
console.log(`✔ Каталог коректний${warnings.length ? ` (попереджень: ${warnings.length})` : ''}`);
