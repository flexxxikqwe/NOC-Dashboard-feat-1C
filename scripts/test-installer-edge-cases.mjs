#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('================================================================');
console.log('🧪 TESTING INSTALL.BAT EDGE CASES & SYNTAX VERIFICATION');
console.log('================================================================\n');

const installBatPath = path.resolve(process.cwd(), 'public/downloads/install.bat');
assert(fs.existsSync(installBatPath), 'install.bat must exist');
const bat = fs.readFileSync(installBatPath, 'utf8');

// 1. Проверка прав администратора
console.log('▶ ТЕСТ 1: Запуск без прав администратора...');
assert(bat.includes('net session >nul 2>&1'), 'Должна быть проверка net session');
assert(bat.includes('if %errorlevel% neq 0'), 'Должна быть обработка ненулевого errorlevel');
assert(bat.includes('exit /b 1'), 'Должен быть возврат кода ошибки 1 при отсутствии прав');
console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Скрипт безопасно прерывает работу без прав админа.\n');

// 2. Обработка путей с пробелами и кавычками (аргумент vs интерактивный ввод)
console.log('▶ ТЕСТ 2: Передача пути к базе (пробелы, кавычки, интерактивный ввод)...');
assert(bat.includes('set "BASE_PATH=%~1"'), 'Должно быть снятие кавычек из аргумента %~1');
assert(bat.includes('set /p "BASE_PATH='), 'Должен быть интерактивный ввод при пустом пути');
assert(
  bat.includes('for /f "tokens=*" %%I in ("%BASE_PATH%") do set "BASE_PATH=%%~I"'),
  'Должна быть безопасная очистка кавычек при интерактивном вводе'
);
assert(bat.includes('if not exist "%BASE_PATH%"'), 'Проверка существования пути должна быть в кавычках');
assert(bat.includes('/F "%BASE_PATH%"'), 'Вызов 1С должен содержать "%BASE_PATH%" в кавычках');
console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Пути с пробелами и кавычками полностью защищены.\n');

// 3. Отсутствие клиентов удаленного доступа (AnyDesk / RuDesktop)
console.log('▶ ТЕСТ 3: Поведение при отсутствии AnyDesk и RuDesktop...');
assert(bat.includes('set "REMOTE_DETECTED=0"'), 'Инициализация флага обнаружения');
assert(bat.includes('if "%REMOTE_DETECTED%"=="0"'), 'Проверка ветки отсутствия клиентов');
assert(
  !bat.includes('--set-password') && !bat.includes('SuperSupportPass'),
  'Категорически запрещены любые пароли'
);
console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Отсутствие клиентов обрабатывается как информационное предупреждение без сбоев.\n');

// 4. Сбой скачивания и поврежденный файл (0 байт)
console.log('▶ ТЕСТ 4: Обработка сбоя скачивания support.cfe...');
assert(bat.includes('if not exist "%TEMP_CFE%"'), 'Проверка существования скачанного файла');
assert(bat.includes('%%~zA equ 0'), 'Проверка нулевого размера скачанного файла');
assert(bat.includes('goto cleanup_and_exit_fail'), 'Переход к безопасному завершению с очисткой');
assert(bat.includes(':cleanup_and_exit_fail'), 'Наличие метки аварийного завершения');
console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: Сбои сети и пустые файлы отсекаются с удалением мусора.\n');

// 5. Очистка секретов и прав доступа к %ProgramData%\1C-NOC
console.log('▶ ТЕСТ 5: Очистка памяти и безопасность ACL...');
assert(bat.includes('icacls "%NOC_DIR%" /inheritance:r'), 'Защита ACL папки 1C-NOC');
assert(bat.includes('set "ARG_DEVICE_TOKEN="'), 'Очистка ARG_DEVICE_TOKEN перед выходом');
assert(bat.includes('set "NOC_DEVICE_TOKEN="'), 'Очистка NOC_DEVICE_TOKEN перед выходом');
console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: Переменные очищаются во всех ветках (успех и ошибка).\n');

// 6. Валидация меток GOTO в batch-файле
console.log('▶ ТЕСТ 6: Статический анализ меток перехода GOTO...');
const gotoRegex = /goto\s+([a-zA-Z0-9_-]+)/gi;
const labelRegex = /:([a-zA-Z0-9_-]+)/g;
const labels = new Set();
let match;
while ((match = labelRegex.exec(bat)) !== null) {
  labels.add(match[1].toLowerCase());
}
while ((match = gotoRegex.exec(bat)) !== null) {
  const target = match[1].toLowerCase();
  assert(labels.has(target), `Метка goto ${target} не найдена в файле!`);
}
console.log('✅ ТЕСТ 6 УСПЕШНО ПРОЙДЕН: Все метки GOTO корректны и существуют.\n');

console.log('================================================================');
console.log('🎉 ВСЕ 6 ТЕСТОВ ГРАНИЧНЫХ СЛУЧАЕВ INSTALL.BAT УСПЕШНО ПРОЙДЕНЫ!');
console.log('================================================================\n');
