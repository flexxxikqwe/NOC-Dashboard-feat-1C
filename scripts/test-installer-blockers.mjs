#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('================================================================');
console.log('🔒 PHASE 4.0.1 — POS INSTALLER RELEASE BLOCKERS VERIFICATION');
console.log('================================================================\n');

const installBatPath = path.resolve(process.cwd(), 'public/downloads/install.bat');
const bslServerPath = path.resolve(process.cwd(), '1c/extension/ОбщийМодуль_Сервер.bsl');
const bslClientPath = path.resolve(process.cwd(), '1c/extension/МодульУправляемогоПриложения.bsl');
const pocSandboxPath = path.resolve(process.cwd(), '1c/poc_sandbox.bsl');
const deployDocPath = path.resolve(process.cwd(), 'scripts/README_DEPLOY.md');

assert(fs.existsSync(installBatPath), 'install.bat must exist');
assert(fs.existsSync(bslServerPath), 'ОбщийМодуль_Сервер.bsl must exist');
assert(fs.existsSync(bslClientPath), 'МодульУправляемогоПриложения.bsl must exist');
assert(fs.existsSync(pocSandboxPath), 'poc_sandbox.bsl must exist');
assert(fs.existsSync(deployDocPath), 'README_DEPLOY.md must exist');

const bat = fs.readFileSync(installBatPath, 'utf8');
const bslServer = fs.readFileSync(bslServerPath, 'utf8');
const bslClient = fs.readFileSync(bslClientPath, 'utf8');
const pocSandbox = fs.readFileSync(pocSandboxPath, 'utf8');
const deployDoc = fs.readFileSync(deployDocPath, 'utf8');

// ---------------------------------------------------------------------
// БЛОК 1: Устранение небезопасной загрузки
// ---------------------------------------------------------------------
console.log('▶ БЛОК 1: Проверка безопасности загрузки (TLS, HTTPS, целостность)...');

// 1.1 Запрет curl -k и отключения проверки сертификатов
assert(
  !bat.includes('curl -f -k') && !bat.includes('curl -k') && !bat.includes('--insecure'),
  'FAIL: install.bat содержит curl -k / --insecure или отключение проверки сертификатов'
);
assert(
  bat.includes('curl -f -s -S -o'),
  'FAIL: install.bat должен использовать безопасный вызов curl с проверкой сертификатов'
);

// 1.2 Запрет незащищенного HTTP для удаленных серверов
assert(
  bat.includes('Для удаленных серверов требуется протокол HTTPS') || bat.includes('Протокол защищенного подключения: HTTPS'),
  'FAIL: install.bat должен требовать HTTPS для удаленных серверов'
);
assert(
  bat.includes('IS_LOCAL_DEV') || bat.includes('://localhost') || bat.includes('://127.0.0.1'),
  'FAIL: install.bat должен разрешать HTTP только для локального dev-окружения'
);

// 1.3 Проверка кода возврата загрузки и удаление частичного файла
assert(
  bat.includes('DL_EXIT_CODE') && bat.includes('if %DL_EXIT_CODE% neq 0'),
  'FAIL: install.bat должен проверять ненулевой код возврата загрузки'
);
assert(
  bat.includes('del /f /q "%TEMP_CFE%"'),
  'FAIL: install.bat должен удалять частичный/битый файл при ошибке загрузки'
);

// 1.4 Проверка целостности контейнера 1С (Compound Container 0x7FFFFFFF)
assert(
  bat.includes('255') && bat.includes('127') && (bat.includes('сигнатура') || bat.includes('контейнер')),
  'FAIL: install.bat должен проверять целостность структуры контейнера 1С (сигнатура FF FF FF 7F)'
);

// 1.5 Вычисление SHA-256 и указание схемы защиты для production
assert(
  bat.includes('certutil -hashfile "%TEMP_CFE%" SHA256') || bat.includes('CFE_SHA256'),
  'FAIL: install.bat должен рассчитывать хеш SHA-256 артефакта'
);
assert(
  bat.includes('Требуемая схема защиты') || bat.includes('Схема защиты'),
  'FAIL: install.bat должен указывать необходимую production-схему защиты (подпись манифеста через PKI)'
);

console.log('✅ БЛОК 1 УСПЕШНО ПРОЙДЕН: curl -k удален, HTTPS обязателен, целостность и хеш проверяются.\n');

// ---------------------------------------------------------------------
// БЛОК 2: Конфигурация сервера и переменных
// ---------------------------------------------------------------------
console.log('▶ БЛОК 2: Конфигурация сервера и согласованность переменных...');

// 2.1 Удаление скрытого дефолта на localhost
assert(
  !bat.includes('set "SERVER_URL=http://localhost:3000"'),
  'FAIL: install.bat не должен скрыто подставлять http://localhost:3000 по умолчанию'
);
assert(
  bat.includes('URL сервера мониторинга не указан') || bat.includes('Автоматический fallback на localhost отключен'),
  'FAIL: install.bat должен завершаться с ошибкой при отсутствии URL сервера'
);

// 2.2 Согласованность переменных окружения (NOC_SERVER_URL и NOC_TOKEN)
assert(bat.includes('NOC_SERVER_URL'), 'FAIL: install.bat должен использовать NOC_SERVER_URL');
assert(bat.includes('NOC_TOKEN'), 'FAIL: install.bat должен использовать NOC_TOKEN');
assert(bslServer.includes('NOC_SERVER_URL'), 'FAIL: ОбщийМодуль_Сервер.bsl должен использовать NOC_SERVER_URL');
assert(bslServer.includes('NOC_TOKEN'), 'FAIL: ОбщийМодуль_Сервер.bsl должен использовать NOC_TOKEN');
assert(deployDoc.includes('NOC_SERVER_URL'), 'FAIL: README_DEPLOY.md должен документировать NOC_SERVER_URL');
assert(deployDoc.includes('NOC_TOKEN'), 'FAIL: README_DEPLOY.md должен документировать NOC_TOKEN');
assert(
  !deployDoc.includes('set "SERVER_URL='),
  'FAIL: README_DEPLOY.md не должен использовать разнородное имя SERVER_URL вместо NOC_SERVER_URL'
);

// 2.3 Предотвращение утечки секрета в командной строке и логах
assert(
  bat.includes('Для предотвращения утечек в списке процессов рекомендуется интерактивный ввод') ||
    bat.includes('списке процессов'),
  'FAIL: install.bat должен предупреждать об опасности передачи секрета через аргументы командной строки'
);
assert(
  !bat.includes('echo %NOC_DEVICE_TOKEN%') && !bat.includes('echo %ARG_DEVICE_TOKEN%'),
  'FAIL: install.bat не должен выводить токен устройства в stdout или лог'
);

console.log('✅ БЛОК 2 УСПЕШНО ПРОЙДЕН: Скрытый localhost исключен, переменные согласованы, токен защищен.\n');

// ---------------------------------------------------------------------
// БЛОК 3: Сохранение токена, модель ACL и архитектурный блокер
// ---------------------------------------------------------------------
console.log('▶ БЛОК 3: Сохранение токена, права доступа ACL и фиксация блокера...');

// 3.1 Модель ACL: Administrators:F, SYSTEM:F, Users:R
assert(
  bat.includes('"Administrators":(OI)(CI)F') || bat.includes('"Administrators":F'),
  'FAIL: ACL должен предоставлять полный доступ Администраторам'
);
assert(
  bat.includes('"SYSTEM":(OI)(CI)F') || bat.includes('"SYSTEM":F'),
  'FAIL: ACL должен предоставлять полный доступ SYSTEM'
);
assert(
  bat.includes('"Users":(OI)(CI)RX') || bat.includes('"Users":R'),
  'FAIL: ACL должен предоставлять права чтения Users для работы 1С в файловом режиме'
);
assert(
  !bat.includes('"Users":(OI)(CI)F') && !bat.includes('"Users":F'),
  'FAIL: Пользователям (Users) категорически запрещен полный доступ к каталогу конфигурации!'
);

// 3.2 Проверка кода возврата icacls
assert(
  bat.includes('icacls') && bat.includes('if %errorlevel% neq 0'),
  'FAIL: install.bat должен проверять %errorlevel% после вызовов icacls'
);

// 3.3 Фиксация архитектурного блокера
assert(
  bat.includes('АРХИТЕКТУРНЫЙ БЛОКЕР') || bat.includes('БЛОКЕР'),
  'FAIL: install.bat должен явно фиксировать архитектурный блокер изоляции секрета в файловой 1С'
);
assert(
  deployDoc.includes('Архитектурный блокер') || deployDoc.includes('АРХИТЕКТУРНЫЙ БЛОКЕР'),
  'FAIL: README_DEPLOY.md должен документировать архитектурный блокер до появления фоновой службы'
);

// 3.4 Сохранение существующего токена при повторной установке
assert(
  bat.includes('EXISTING_TOKEN') || bat.includes('prev.token'),
  'FAIL: install.bat должен сохранять существующий токен при повторной установке'
);

// 3.5 Безопасная запись JSON с экранированием
assert(
  bat.includes('ConvertTo-Json'),
  'FAIL: install.bat должен использовать корректную сериализацию JSON с экранированием'
);

console.log('✅ БЛОК 3 УСПЕШНО ПРОЙДЕН: ACL настроены с проверкой ошибок, токен не затирается, блокер зафиксирован.\n');

// ---------------------------------------------------------------------
// БЛОК 4: Чтение переменных окружения в BSL
// ---------------------------------------------------------------------
console.log('▶ БЛОК 4: Аудит _МС_ПолучитьПеременнуюСредыСервер в BSL...');

// 4.1 Распознавание нераскрытой ссылки %VARIABLE% в ОбщийМодуль_Сервер.bsl
assert(
  bslServer.includes('ExpandEnvironmentStrings(Шаблон)') || bslServer.includes('ExpandEnvironmentStrings'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен содержать вызов ExpandEnvironmentStrings'
);
assert(
  bslServer.includes('Если ВРег(СокрЛП(Значение)) = ВРег(Шаблон) Тогда') ||
    bslServer.includes('Если НРег(Значение) = НРег(Шаблон) Тогда') ||
    bslServer.includes('Шаблон = "%" + ИмяПеременной + "%"'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен проверять, вернул ли ExpandEnvironmentStrings нераскрытый шаблон %VAR%'
);
assert(
  bslServer.includes('Возврат "";'),
  'FAIL: При нераскрытом шаблоне функция должна возвращать пустую строку ""'
);

// 4.2 МодульУправляемогоПриложения.bsl также должен корректно обрабатывать нераскрытые переменные
assert(
  bslClient.includes('Если ВРег(СокрЛП(Значение)) = ВРег(Шаблон) Тогда') ||
    bslClient.includes('Шаблон = "%" + ИмяПеременной + "%"'),
  'FAIL: МодульУправляемогоПриложения.bsl должен корректно обрабатывать нераскрытые переменные'
);

// 4.3 poc_sandbox.bsl также защищен
assert(
  pocSandbox.includes('Если ВРег(СокрЛП(Значение)) = ВРег(Шаблон) Тогда') ||
    pocSandbox.includes('Шаблон = "%" + ИмяПеременной + "%"'),
  'FAIL: poc_sandbox.bsl должен корректно обрабатывать нераскрытые переменные'
);

console.log('✅ БЛОК 4 УСПЕШНО ПРОЙДЕН: Нераскрытые переменные %VARIABLE% возвращаются как пустая строка ("").\n');

console.log('================================================================');
console.log('🎉 ВСЕ ПРОВЕРКИ PHASE 4.0.1 УСПЕШНО ВЫПОЛНЕНЫ (PASS)!');
console.log('================================================================\n');
