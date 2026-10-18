// Спільні функції для скриптів каталогу (Node >= 18, без залежностей; sharp підключається лише для фото)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.join(ROOT, 'data');
export const PLACES = path.join(DATA, 'places');
export const PHOTOS = path.join(DATA, 'photos');
export const INDEX = path.join(DATA, 'index.json');
export const SCHEMA = path.join(ROOT, 'schema', 'place.schema.json');

export const MAX_FILE_BYTES = 25 * 1024 * 1024;   // жоден файл у data/ не більший за 25 МБ
export const MAIN_MAX_SIDE = 1600, THUMB_MAX_SIDE = 320;
export const TARGET_MAX = 400 * 1024;

export const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
export function writeJson(f, obj) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
}
export const today = () => new Date().toISOString().slice(0, 10);
export const round7 = n => Math.round(n * 1e7) / 1e7;

export function listPlaceFiles() {
    if (!fs.existsSync(PLACES)) return [];
    return fs.readdirSync(PLACES).filter(f => f.endsWith('.json')).sort();
}
export function readAllPlaces() {
    const out = listPlaceFiles().map(f => ({ ...readJson(path.join(PLACES, f)), __file: f }));
    out.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    return out;
}
export const stripMeta = p => { const { __file, ...rest } = p; return rest; };
export const placePath = id => path.join(PLACES, id + '.json');

// ---------- slug ----------
const UK = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'yu', я: 'ya', ы: 'y', э: 'e', ё: 'yo' };
const EXTRA = { ł: 'l', đ: 'd', ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', ð: 'd', þ: 'th' };
export function slugify(name) {
    let n = String(name);
    const m = n.match(/\(([^()]*[A-Za-z][^()]*)\)/);                 // «Фортеця (Gjirokastër Castle)» → латинська частина
    if (/[\u0400-\u04ff]/.test(n) && m && !/[\u0400-\u04ff]/.test(m[1])) n = m[1];
    n = [...n.toLowerCase()].map(c => UK[c] !== undefined ? UK[c] : (EXTRA[c] !== undefined ? EXTRA[c] : c)).join('');
    n = n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’`]/g, '');   // апостроф не розриває слово
    n = n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
    return n || 'place';
}
export function uniqueSlug(base, taken) {
    let s = base, i = 2;
    while (taken.has(s)) s = base + '-' + (i++);
    return s;
}

// ---------- координати: «lat, lng», «lat lng», градуси/хвилини/секунди, повний Plus Code ----------
const OLC = '23456789CFGHJMPQRVWX';
export function olcDecode(code) {
    const c = String(code).toUpperCase().replace('+', '').replace(/0+$/, '');
    if (c.length < 2 || c.length > 15 || [...c].some(ch => OLC.indexOf(ch) < 0)) return null;
    const PP = 8000, FLAT = 25000000, FLNG = 8192000;
    let nLat = -90 * PP, nLng = -180 * PP, gLat = 0, gLng = 0, digits = Math.min(c.length, 10), pv = 160000;
    for (let i = 0; i < digits; i += 2) {
        nLat += OLC.indexOf(c[i]) * pv; nLng += OLC.indexOf(c[i + 1] === undefined ? '2' : c[i + 1]) * pv;
        if (i < digits - 2) pv /= 20;
    }
    let latP = pv / PP, lngP = pv / PP;
    if (c.length > 10) {
        let rowpv = 625, colpv = 256; digits = Math.min(c.length, 15);
        for (let i = 10; i < digits; i++) {
            const dv = OLC.indexOf(c[i]); gLat += Math.floor(dv / 4) * rowpv; gLng += (dv % 4) * colpv;
            if (i < digits - 1) { rowpv /= 5; colpv /= 4; }
        }
        latP = rowpv / FLAT; lngP = colpv / FLNG;
    }
    return [Math.min(nLat / PP + gLat / FLAT + latP / 2, 90), nLng / PP + gLng / FLNG + lngP / 2];
}
export function parseCoords(str) {
    const s = String(str ?? '').trim();
    const ok = (la, ln) => (isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) ? [la, ln] : null;
    const p = s.replace(/\s/g, '').split(',');
    if (p.length === 2 && /^-?\d+(\.\d+)?$/.test(p[0]) && /^-?\d+(\.\d+)?$/.test(p[1])) return ok(+p[0], +p[1]);
    let m = s.match(/^(-?\d+(?:\.\d+)?)[\s;]+(-?\d+(?:\.\d+)?)$/);
    if (m) return ok(+m[1], +m[2]);
    m = s.match(/^([23456789CFGHJMPQRVWX]{8})\+([23456789CFGHJMPQRVWX]{0,7})$/i);
    if (m && m[2].length !== 1) { const c = olcDecode(s); return c && ok(c[0], c[1]); }
    m = s.match(/^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')\s*([NSns])[\s,;]*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')\s*([EWew])$/);
    if (m) return ok((+m[1] + m[2] / 60 + m[3] / 3600) * (/s/i.test(m[4]) ? -1 : 1), (+m[5] + m[6] / 60 + m[7] / 3600) * (/w/i.test(m[8]) ? -1 : 1));
    return null;
}
export function haversine(a, b) {
    const R = 6371000, t = Math.PI / 180;
    const x = Math.sin((b[0] - a[0]) * t / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin((b[1] - a[1]) * t / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- index.json ----------
export function indexEntry(p) {
    const media = p.media || [];
    const firstImg = media.find(m => m.type === 'image' && m.thumb);
    const e = { id: p.id, order: p.order, name: p.name, lat: p.lat, lng: p.lng, category: p.category ?? null, desc: p.desc || '' };
    if (p.near) e.near = p.near;
    e.gmapsUrl = p.gmapsUrl || '';
    e.thumb = firstImg ? firstImg.thumb : null;
    e.photos = media.length;
    e.updated = p.updated;
    return e;
}
export function buildIndexObject(places) {
    const sorted = [...places].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    return { version: 1, count: sorted.length, places: sorted.map(indexEntry) };
}
export function writeIndex(places) {
    const next = JSON.stringify(buildIndexObject(places), null, 2) + '\n';
    const prev = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : null;
    if (prev !== next) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(INDEX, next); return true; }
    return false;
}

// ---------- фото (sharp підключається лише тут) ----------
export async function processImage(buf, outBase) {
    let sharp;
    try { sharp = (await import('sharp')).default; }
    catch { throw new Error('Для обробки фото потрібен пакет sharp: виконайте `npm install`.'); }
    const base = sharp(buf, { failOn: 'none' }).rotate();                   // враховує орієнтацію з EXIF
    let main = null;
    outer: for (const side of [MAIN_MAX_SIDE, 1400, 1200, 1000]) {          // ціль 200–400 КБ: спершу знижуємо якість, потім розмір (лише якщо файл більший за 400 КБ)
        for (const q of [85, 80, 74, 68, 62, 56]) {
            main = await base.clone().resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true }).webp({ quality: q }).toBuffer({ resolveWithObject: true });
            if (main.data.length <= TARGET_MAX) break outer;
        }
    }
    const thumb = await base.clone().resize({ width: THUMB_MAX_SIDE, height: THUMB_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + '.webp', main.data);
    fs.writeFileSync(outBase + '_thumb.webp', thumb);
    return { width: main.info.width, height: main.info.height, bytes: main.data.length };
}
export const nn = n => String(n).padStart(2, '0');
export const relData = f => path.relative(DATA, f).split(path.sep).join('/');

// ---------- міні-валідатор JSON Schema (type, required, properties, additionalProperties, enum, pattern, min/max, items, minItems) ----------
export function validateSchema(schema, data, at = '') {
    const errs = [];
    const types = [].concat(schema.type || []);
    const tOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    if (types.length) {
        const t = tOf(data);
        if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) return [`${at || '/'}: очікується ${types.join('|')}, а є ${t}`];
    }
    if (schema.enum && !schema.enum.includes(data)) errs.push(`${at}: значення має бути одним із ${JSON.stringify(schema.enum)}`);
    if (typeof data === 'string') {
        if (schema.minLength != null && data.length < schema.minLength) errs.push(`${at}: надто коротке`);
        if (schema.maxLength != null && data.length > schema.maxLength) errs.push(`${at}: надто довге (> ${schema.maxLength})`);
        if (schema.pattern && !new RegExp(schema.pattern).test(data)) errs.push(`${at}: не відповідає шаблону ${schema.pattern}`);
    }
    if (typeof data === 'number') {
        if (schema.minimum != null && data < schema.minimum) errs.push(`${at}: менше ${schema.minimum}`);
        if (schema.maximum != null && data > schema.maximum) errs.push(`${at}: більше ${schema.maximum}`);
    }
    if (Array.isArray(data)) {
        if (schema.minItems != null && data.length < schema.minItems) errs.push(`${at}: потрібно щонайменше ${schema.minItems} елементів`);
        if (schema.items) data.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${at}[${i}]`)));
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const r of schema.required || []) if (!(r in data)) errs.push(`${at}/${r}: обов'язкове поле відсутнє`);
        const props = schema.properties || {};
        for (const k of Object.keys(data)) {
            if (props[k]) errs.push(...validateSchema(props[k], data[k], `${at}/${k}`));
            else if (schema.additionalProperties === false) errs.push(`${at}/${k}: невідоме поле (схема його не передбачає)`);
        }
    }
    return errs;
}
