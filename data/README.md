# data/

Каталог місць — єдине джерело правди для сайту.

- `places/<id>.json` — картки (поля описані в головному `README.md`; схема — `schema/place.schema.json`);
- `photos/<id>/` — фото й відео карток;
- `types.json` — довідник типів місць (`schema/types.schema.json`);
- `users/<id>.json`, `users/index.json` — особисті кабінети користувачів (`schema/user.schema.json`);
- `index.json` — згенерований список для швидкого завантаження.

Файли `index.json` та `users/index.json` **не редагуйте вручну** — вони будуються командою `npm run build-index`.
Решту можна змінювати через сайт + файл обміну (`inbox/`), скрипти (`npm run add-place`, `update-place`) або вручну з подальшим `npm run check`.
