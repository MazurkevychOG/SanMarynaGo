// Операції над каталогом: додавання/оновлення карток, порядок, фото
import fs from 'node:fs';
import path from 'node:path';
import { readTypes, PHOTOS, DATA, readAllPlaces, stripMeta, writeJson, placePath, today, round7, parseCoords, slugify, uniqueSlug, haversine, processImage, nn, relData, writeIndex, MAX_FILE_BYTES } from './common.mjs';

export function loadAll() { return readAllPlaces().map(stripMeta); }

// position: 'auto' (поряд із найближчою карткою ≤ 25 км, інакше в кінець) | 'end' | 'start' | N | {after: id}
export function resolveInsertIndex(all, place, position = 'auto') {
    if (position === 'end') return all.length;
    if (position === 'start') return 0;
    if (typeof position === 'number') return Math.max(0, Math.min(all.length, position - 1));
    if (position && position.after) { const i = all.findIndex(p => p.id === position.after); if (i < 0) throw new Error(`Картку «${position.after}» не знайдено`); return i + 1; }
    let best = -1, bd = Infinity;
    all.forEach((p, i) => { const d = haversine([place.lat, place.lng], [p.lat, p.lng]); if (d < bd) { bd = d; best = i; } });
    return best >= 0 && bd <= 25000 ? best + 1 : all.length;   // «поряд зі схожим по території»
}
export function renumber(all) {
    let changed = 0;
    all.forEach((p, i) => { if (p.order !== i + 1) { p.order = i + 1; writeJson(placePath(p.id), p); changed++; } });
    return changed;
}
export async function addPhotos(place, files) {
    place.media ||= [];
    const used = place.media.map(m => parseInt(m.file.match(/(\d{2})\.\w+$/)?.[1] || '0', 10));
    let k = used.length ? Math.max(...used) : 0;
    for (const f of files) {
        if (!fs.existsSync(f)) throw new Error(`Файл не знайдено: ${f}`);
        const buf = fs.readFileSync(f), ext = path.extname(f).toLowerCase();
        k++;
        const base = path.join(PHOTOS, place.id, nn(k));
        if (ext === '.mp4') {
            if (buf.length > MAX_FILE_BYTES) throw new Error(`${f}: відео більше 25 МБ`);
            fs.mkdirSync(path.dirname(base), { recursive: true });
            fs.writeFileSync(base + '.mp4', buf);
            place.media.push({ type: 'video', file: relData(base + '.mp4'), mime: 'video/mp4', bytes: buf.length });
        } else {
            const info = await processImage(buf, base);
            place.media.push({ type: 'image', file: relData(base + '.webp'), thumb: relData(base + '_thumb.webp'), width: info.width, height: info.height, bytes: info.bytes });
        }
    }
}
export function removePhoto(place, number) {
    const key = nn(number);
    const i = (place.media || []).findIndex(m => new RegExp(`/${key}\\.\\w+$`).test(m.file));
    if (i < 0) throw new Error(`У картці «${place.id}» немає медіа №${key}`);
    const [m] = place.media.splice(i, 1);
    for (const f of [m.file, m.thumb]) if (f) fs.rmSync(path.join(DATA, f), { force: true });
}
export function coordsFrom(spec) {
    const c = spec.lat != null && spec.lng != null ? [Number(spec.lat), Number(spec.lng)] : parseCoords(spec.coords);
    if (!c || !isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180)
        throw new Error('Координати не розпізнано. Приклади: «41.047, 19.496», «40°43\'16.5"N 19°28\'11.5"E», «8FGXPFC9+GX».');
    return [round7(c[0]), round7(c[1])];
}
export async function createPlace(spec) {
    if (!spec.name || !String(spec.name).trim()) throw new Error('Потрібна назва (name)');
    const all = loadAll();
    const [lat, lng] = coordsFrom(spec);
    const taken = new Set(all.map(p => p.id));
    const id = spec.id ? String(spec.id) : uniqueSlug(slugify(spec.name), taken);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Некоректний id «${id}»: лише a-z, 0-9 та дефіси`);
    if (taken.has(id)) throw new Error(`Картка з id «${id}» вже існує (використайте update-place)`);
    const place = { id, order: 0, name: String(spec.name).trim(), lat, lng, desc: spec.desc || '', gmapsUrl: spec.gmapsUrl || spec.url || '' };
    if (spec.near) place.near = String(spec.near);
    if (spec.country) place.country = String(spec.country).trim();
    const tl = (Array.isArray(spec.types) ? spec.types : String(spec.types || '').split(',')).map(x => String(x).trim()).filter(Boolean);
    if (tl.length) { const known = new Set(readTypes().map(t => t.id)); const bad = tl.filter(t => !known.has(t)); if (bad.length) throw new Error(`невідомі типи: ${bad.join(', ')} (доступні: ${[...known].join(', ') || '—'})`); place.types = [...new Set(tl)]; }
    place.category = spec.category || null;
    place.media = [];
    place.updated = today();
    await addPhotos(place, [].concat(spec.photos || spec.photo || []));
    const at = resolveInsertIndex(all, place, spec.position);
    all.splice(at, 0, place);
    renumber(all.filter(p => p.id !== id));
    place.order = at + 1;
    writeJson(placePath(id), place);
    renumber(all);
    writeIndex(all);
    return { place, position: at + 1, total: all.length };
}
export { writeIndex, placePath, today, writeJson };
