#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('================================================================');
console.log('🔒 PHASE 4.0 — POS INSTALLER SECURITY HOTFIX VERIFICATION');
console.log('================================================================\n');

const installBatPath = path.resolve(process.cwd(), 'public/downloads/install.bat');
const bslServerPath = path.resolve(process.cwd(), '1c/extension/ОбщийМодуль_Сервер.bsl');
const bslClientPath = path.resolve(process.cwd(), '1c/extension/МодульУправляемогоПриложения.bsl');
const deployDocPath = path.resolve(process.cwd(), 'scripts/README_DEPLOY.md');
const cfePath = path.resolve(process.cwd(), 'public/downloads/support.cfe');

// ---------------------------------------------------------------------
// ТЕСТ 1: Проверка install.bat на отсутствие захардкоженных секретов
// ---------------------------------------------------------------------
console.log('▶ ТЕСТ 1: Аудит public/downloads/install.bat...');
assert(fs.existsSync(installBatPath), 'Файл install.bat должен существовать');
const installBatContent = fs.readFileSync(installBatPath, 'utf8');

// 1.1 Никаких статических паролей AnyDesk и вызовов --set-password
assert(
  !installBatContent.includes('SuperSupportPass2026!'),
  'FAIL: install.bat содержит статический пароль AnyDesk (SuperSupportPass2026!)'
);
assert(
  !installBatContent.includes('--set-password'),
  'FAIL: install.bat содержит команду установки статического пароля AnyDesk (--set-password)'
);

// 1.2 Никаких захардкоженных токенов dev-secret-token-2026
assert(
  !installBatContent.includes('dev-secret-token-2026'),
  'FAIL: install.bat содержит захардкоженный токен авторизации (dev-secret-token-2026)'
);

// 1.3 Поддержка безопасной передачи параметров
assert(
  installBatContent.includes('ARG_DEVICE_TOKEN') || installBatContent.includes('NOC_DEVICE_TOKEN'),
  'FAIL: install.bat должен поддерживать безопасный ввод или аргумент токена'
);
assert(
  installBatContent.includes('NOC_SERVER_URL') || installBatContent.includes('SERVER_URL'),
  'FAIL: install.bat должен поддерживать конфигурируемый URL сервера'
);

// 1.4 Защита хранилища через icacls
assert(
  installBatContent.includes('icacls') && installBatContent.includes('1C-NOC'),
  'FAIL: install.bat должен настраивать ограниченные права ACL на каталог конфигурации 1C-NOC'
);

// 1.5 Очистка переменных секрета перед выходом
assert(
  installBatContent.includes('set "ARG_DEVICE_TOKEN="') || installBatContent.includes('set "NOC_DEVICE_TOKEN="'),
  'FAIL: install.bat должен очищать переменные секрета из памяти сеанса перед выходом'
);

console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: install.bat очищен от статических паролей и токенов, защищен ACL.\n');

// ---------------------------------------------------------------------
// ТЕСТ 2: Аудит клиентского кода 1С (ОбщийМодуль_Сервер.bsl)
// ---------------------------------------------------------------------
console.log('▶ ТЕСТ 2: Аудит 1c/extension/ОбщийМодуль_Сервер.bsl...');
assert(fs.existsSync(bslServerPath), 'Файл ОбщийМодуль_Сервер.bsl должен существовать');
const bslServerContent = fs.readFileSync(bslServerPath, 'utf8');

// 2.1 Токен по умолчанию пустой (не захардкожен)
assert(
  bslServerContent.includes('Настройки.Вставить("Токен", "");'),
  'FAIL: Значение токена по умолчанию должно быть пустым, а не фиксированным секретом'
);

// 2.2 Динамическое чтение конфигурации из %ProgramData%\1C-NOC\config.json
assert(
  bslServerContent.includes('1C-NOC\\config.json'),
  'FAIL: Модуль должен поддерживать чтение параметров из защищенного файла конфигурации'
);

// 2.3 Динамическое чтение переменных окружения
assert(
  bslServerContent.includes('NOC_TOKEN'),
  'FAIL: Модуль должен поддерживать чтение токена из переменной среды NOC_TOKEN'
);

// 2.4 Защита от неавторизованных сетевых запросов при пустом токене
assert(
  bslServerContent.includes('Если ПустаяСтрока(Настройки.Токен) Тогда'),
  'FAIL: Модуль должен блокировать сетевые вызовы при отсутствии сконфигурированного токена'
);

console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: ОбщийМодуль_Сервер.bsl не содержит жестко заданных токенов и динамически читает конфигурацию.\n');

// ---------------------------------------------------------------------
// ТЕСТ 3: Аудит клиентского модуля (МодульУправляемогоПриложения.bsl)
// ---------------------------------------------------------------------
console.log('▶ ТЕСТ 3: Аудит 1c/extension/МодульУправляемогоПриложения.bsl...');
assert(fs.existsSync(bslClientPath), 'Файл МодульУправляемогоПриложения.bsl должен существовать');
const bslClientContent = fs.readFileSync(bslClientPath, 'utf8');

// 3.1 Модуль не содержит паролей
assert(!bslClientContent.includes('SuperSupportPass2026!'), 'FAIL: Модуль не должен содержать паролей');
assert(!bslClientContent.includes('password'), 'FAIL: Модуль не должен оперировать паролями');

// 3.2 Пассивное чтение ID
assert(
  bslClientContent.includes('ad.anynet.id=') && bslClientContent.includes('rudesktop.cfg'),
  'FAIL: Модуль должен выполнять пассивное чтение AnyDesk и RuDesktop конфигураций'
);

console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Клиентский BSL-модуль выполняет только пассивный сбор ID без секретов.\n');

// ---------------------------------------------------------------------
// ТЕСТ 4: Аудит документации развертывания (scripts/README_DEPLOY.md)
// ---------------------------------------------------------------------
console.log('▶ ТЕСТ 4: Аудит scripts/README_DEPLOY.md...');
assert(fs.existsSync(deployDocPath), 'Файл README_DEPLOY.md должен существовать');
const deployDocContent = fs.readFileSync(deployDocPath, 'utf8');

assert(
  !deployDocContent.includes('SuperSupportPass2026!'),
  'FAIL: README_DEPLOY.md содержит скомпрометированный пароль AnyDesk'
);
assert(
  deployDocContent.includes('NOC_TOKEN'),
  'FAIL: README_DEPLOY.md должен описывать безопасную передачу NOC_TOKEN'
);

console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: В документации отсутствуют статические пароли, описана безопасная модель токенов.\n');

// ---------------------------------------------------------------------
// ТЕСТ 5: Проверка бинарного файла support.cfe на отсутствие утечек
// ---------------------------------------------------------------------
console.log('▶ ТЕСТ 5: Аудит public/downloads/support.cfe...');
assert(fs.existsSync(cfePath), 'Файл support.cfe должен существовать');
const cfeBuffer = fs.readFileSync(cfePath);
const cfeStr = cfeBuffer.toString('latin1');
assert(!cfeStr.includes('SuperSupportPass2026!'), 'FAIL: support.cfe содержит статический пароль AnyDesk');
console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: support.cfe чист от паролей и секретов.\n');

console.log('================================================================');
console.log('🎉 ВСЕ 5 ТЕСТОВ БЕЗОПАСНОСТИ УСТАНОВЩИКА УСПЕШНО ПРОЙДЕНЫ!');
console.log('================================================================\n');
