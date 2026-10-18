#!/usr/bin/env node
// Перебудовує data/index.json з data/places/*.json (єдине джерело правди — окремі файли).
// --check: нічого не пише, завершується з помилкою, якщо index.json застарів (для CI).
import fs from 'node:fs';
import { INDEX, readAllPlaces, buildIndexObject, writeIndex } from './lib/common.mjs';

const check = process.argv.includes('--check');
const places = readAllPlaces();
if (check) {
    const expected = JSON.stringify(buildIndexObject(places), null, 2) + '\n';
    const actual = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
    if (expected !== actual) {
        console.error('✖ data/index.json застарів відносно data/places/*.json.\n  Виконайте `npm run build-index` і закомітьте оновлений data/index.json.');
        process.exit(1);
    }
    console.log(`✔ data/index.json актуальний (${places.length} карток)`);
} else {
    const changed = writeIndex(places);
    console.log(changed ? `✔ data/index.json оновлено (${places.length} карток)` : `✔ data/index.json без змін (${places.length} карток)`);
}
