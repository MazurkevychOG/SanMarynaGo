# github-setup/ — запасні копії файлів папки `.github/`

Папки, назва яких починається з крапки (`.github`), **часто не потрапляють в архів/завантаження через веб-інтерфейс GitHub**
(Finder на Mac і Провідник ховають їх, а «перетягування» папки їх пропускає). Саме через це робот імпорту (`import-inbox.yml`)
міг не з'явитися в репозиторії, і файли з `inbox/` не обробляються.

Тут лежать **точні копії** цих файлів без крапки в назві теки. Якщо в репозиторії на github.com немає папки `.github/workflows/`:

1. Відкрийте репозиторій → **Add file → Create new file**.
2. У полі імені введіть `.github/workflows/import-inbox.yml` (слеші створять теки автоматично).
3. Відкрийте тут `workflows/import-inbox.yml`, скопіюйте весь вміст і вставте в нове поле. **Commit changes**.
4. Так само створіть `.github/workflows/validate.yml` і (необов'язково) `.github/ISSUE_TEMPLATE/new-place.yml`.
5. Дозвольте роботу писати в репозиторій: **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**.

Після цього вкладка **Actions** покаже «Імпорт файлів обміну з inbox/» і «Перевірка каталогу».
Саму теку `github-setup/` після налаштування можна видалити.
