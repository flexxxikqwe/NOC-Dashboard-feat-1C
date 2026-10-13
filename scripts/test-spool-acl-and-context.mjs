#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('================================================================');
console.log('🔒 PHASE 4.1.3 — SPOOL DACL CORRECTION & EXECUTION-CONTEXT TESTS');
console.log('================================================================\n');

const installBatPath = path.resolve(process.cwd(), 'public/downloads/install.bat');
const spoolContractPath = path.resolve(process.cwd(), '1c/extension/SPOOL_CONTRACT.md');
const buildGuidePath = path.resolve(process.cwd(), '1c/extension/BUILD_GUIDE.md');
const bslServerPath = path.resolve(process.cwd(), '1c/extension/ОбщийМодуль_Сервер.bsl');
const bslClientPath = path.resolve(process.cwd(), '1c/extension/МодульУправляемогоПриложения.bsl');

assert(fs.existsSync(installBatPath), 'FAIL: install.bat должен существовать');
assert(fs.existsSync(spoolContractPath), 'FAIL: SPOOL_CONTRACT.md должен существовать');
assert(fs.existsSync(buildGuidePath), 'FAIL: BUILD_GUIDE.md должен существовать');
assert(fs.existsSync(bslServerPath), 'FAIL: ОбщийМодуль_Сервер.bsl должен существовать');
assert(fs.existsSync(bslClientPath), 'FAIL: МодульУправляемогоПриложения.bsl должен существовать');

const bat = fs.readFileSync(installBatPath, 'utf8');
const contract = fs.readFileSync(spoolContractPath, 'utf8');
const buildGuide = fs.readFileSync(buildGuidePath, 'utf8');
const bslServer = fs.readFileSync(bslServerPath, 'utf8');
const bslClient = fs.readFileSync(bslClientPath, 'utf8');

// ---------------------------------------------------------------------
// БЛОК 1: Проверка коррекции DACL на каталог spool и карантин
// ---------------------------------------------------------------------
console.log('▶ БЛОК 1: Аудит правил icacls и изоляции дочерних файлов...');

// 1.1 Наличие Well-Known SID в правилах spool
assert(
  bat.includes('*S-1-5-32-544":(OI)(CI)F'),
  'FAIL: install.bat должен предоставлять полный доступ Администраторам (*S-1-5-32-544) с наследованием'
);
assert(
  bat.includes('*S-1-5-18":(OI)(CI)F'),
  'FAIL: install.bat должен предоставлять полный доступ SYSTEM (*S-1-5-18) с наследованием'
);
assert(
  bat.includes('*S-1-3-0":(OI)(CI)(IO)F') || bat.includes('*S-1-3-0":(OI)(IO)F'),
  'FAIL: install.bat должен предоставлять права CREATOR OWNER (*S-1-3-0) с Inherit Only (IO) для создателя'
);

// 1.2 Исправление уязвимости наследования для Users (*S-1-5-32-545)
// КРИТИЧНО: ACE для Users НЕ ДОЛЖЕН содержать (OI) или (CI)!
// Если (OI) присутствует, право WD (FILE_ADD_FILE) транслируется в FILE_WRITE_DATA на файлы,
// позволяя обычным пользователям перезаписывать или модифицировать чужие файлы событий.
const spoolIcaclsLineMatch = bat.match(/icacls\s+"%SPOOL_DIR%"[^\r\n]+/i);
assert(spoolIcaclsLineMatch, 'FAIL: Не найдена строка вызова icacls для %SPOOL_DIR% в install.bat');
const spoolIcaclsLine = spoolIcaclsLineMatch[0];

assert(
  spoolIcaclsLine.includes('*S-1-5-32-545":(RD,WD,RA,REA,X,S)'),
  'FAIL: install.bat должен предоставлять группе Users (*S-1-5-32-545) права (RD,WD,RA,REA,X,S) ТОЛЬКО на папку (без OI/CI)'
);
assert(
  !spoolIcaclsLine.includes('*S-1-5-32-545":(OI)') && !spoolIcaclsLine.includes('*S-1-5-32-545":(CI)'),
  'FAIL: КРИТИЧЕСКИЙ ДЕФЕКТ БЕЗОПАСНОСТИ! ACE для Users содержит (OI)/(CI), что дает права записи в чужие дочерние файлы!'
);

// 1.3 Изоляция каталога карантина (quarantine)
const quarantineIcaclsLineMatch = bat.match(/icacls\s+"%QUARANTINE_DIR%"[^\r\n]+/i);
assert(quarantineIcaclsLineMatch, 'FAIL: Не найдена строка вызова icacls для %QUARANTINE_DIR%');
const quarantineIcaclsLine = quarantineIcaclsLineMatch[0];

assert(
  quarantineIcaclsLine.includes('*S-1-5-32-544":(OI)(CI)F') && quarantineIcaclsLine.includes('*S-1-5-18":(OI)(CI)F'),
  'FAIL: Каталог карантина должен быть доступен исключительно Администраторам и SYSTEM'
);
assert(
  !quarantineIcaclsLine.includes('*S-1-5-32-545') && !quarantineIcaclsLine.includes('Users'),
  'FAIL: Каталог карантина НЕ ДОЛЖЕН предоставлять никаких прав обычным пользователям (Users)!'
);

// 1.4 Контроль ошибок вызовов icacls
assert(
  bat.includes('Не удалось настроить права доступа ACL (icacls) на каталог очереди "%SPOOL_DIR%"'),
  'FAIL: install.bat должен обрабатывать ошибку применения ACL к каталогу очереди'
);
assert(
  bat.includes('Не удалось настроить права доступа ACL (icacls) на каталог карантина "%QUARANTINE_DIR%"'),
  'FAIL: install.bat должен обрабатывать ошибку применения ACL к каталогу карантина'
);

console.log('✅ БЛОК 1 УСПЕШНО ПРОЙДЕН: Уязвимость наследования Users устранена, карантин изолирован, ошибки icacls контролируются.\n');

// ---------------------------------------------------------------------
// БЛОК 2: Документирование модели безопасности в SPOOL_CONTRACT и BUILD_GUIDE
// ---------------------------------------------------------------------
console.log('▶ БЛОК 2: Проверка спецификации модели безопасности и атомарности...');

// 2.1 Описание устранения дефекта наследования в SPOOL_CONTRACT.md
assert(
  contract.includes('Устранение уязвимости наследования ACE') || contract.includes('Аудит Phase 4.1.3'),
  'FAIL: SPOOL_CONTRACT.md должен явно документировать устранение уязвимости наследования ACE группы Users'
);
assert(
  contract.includes('FILE_WRITE_DATA') && contract.includes('FILE_ADD_FILE'),
  'FAIL: SPOOL_CONTRACT.md должен объяснять разницу семантики FILE_ADD_FILE для папки и FILE_WRITE_DATA для файла'
);
assert(
  contract.includes('Матрица эффективных прав доступа') || contract.includes('Эффективные права NTFS'),
  'FAIL: SPOOL_CONTRACT.md должен содержать матрицу эффективных прав для каталога и дочерних файлов'
);

// 2.2 Семантика MoveFileExW и коллизий
assert(
  contract.includes('MoveFileExW') && contract.includes('DELETE'),
  'FAIL: SPOOL_CONTRACT.md должен документировать требование права DELETE на дескриптор исходного файла'
);
assert(
  contract.includes('ERROR_ALREADY_EXISTS') || contract.includes('существующем целевом файле'),
  'FAIL: SPOOL_CONTRACT.md должен описывать поведение при наличии существующего целевого файла'
);

// 2.3 Соответствие документации сборки BUILD_GUIDE.md
assert(
  buildGuide.includes('*S-1-5-32-545') && buildGuide.includes('Users'),
  'FAIL: BUILD_GUIDE.md должен указывать правильный Well-Known SID группы Users'
);
assert(
  !buildGuide.includes('*S-1-5-32-545` (Users): `(OI)(CI)'),
  'FAIL: BUILD_GUIDE.md не должен предписывать флаги (OI)(CI) для Users'
);

console.log('✅ БЛОК 2 УСПЕШНО ПРОЙДЕН: Спецификация контракта и руководство по сборке точно отражают модель DACL.\n');

// ---------------------------------------------------------------------
// БЛОК 3: Аудит контекста исполнения 1С и топологии развертывания
// ---------------------------------------------------------------------
console.log('▶ БЛОК 3: Аудит контекста исполнения BSL, временных файлов и отказоустойчивости...');

// 3.1 Определение топологии (FILE vs CLIENT_SERVER) в коде 1С
assert(
  bslServer.includes('ib_mode') && bslServer.includes('СтрокаСоединенияИнформационнойБазы'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен определять ib_mode (FILE / CLIENT_SERVER) через СтрокаСоединенияИнформационнойБазы'
);

// 3.2 Безопасное определение пути к spool без падений при его отсутствии
assert(
  bslServer.includes('_МС_ПолучитьКаталогSpool'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен реализовывать _МС_ПолучитьКаталогSpool'
);
assert(
  bslServer.includes('ФайлКаталога.Существует()'),
  'FAIL: _МС_ПолучитьКаталогSpool должен проверять физическое существование каталога'
);

// 3.3 Проверка готовности очереди
assert(
  bslServer.includes('Если ПустаяСтрока(КаталогSpool) Тогда') && bslServer.includes('Возврат Ложь;'),
  'FAIL: _МС_ПроверитьГотовностьИЛимитSpool должен возвращать Ложь при пустом каталоге'
);

// 3.4 Место создания временного файла и атомарное переименование
assert(
  bslServer.includes('ВременныйПуть = КаталогSpool + "\\temp_" + EventID + ".tmp"'),
  'FAIL: Временный файл должен создаваться строго внутри КаталогSpool для гарантии одного тома NTFS'
);
assert(
  bslServer.includes('ПереместитьФайл(ВременныйПуть, ГотовыйПуть)'),
  'FAIL: Публикация должна выполняться через атомарный вызов ПереместитьФайл'
);

// 3.5 Очистка временного файла при исключении (включая коллизию целевого файла)
assert(
  bslServer.includes('УдалитьФайлы(ВременныйПуть)') && bslServer.includes('Исключение'),
  'FAIL: При сбое переименования или коллизии временный файл должен гарантированно удаляться'
);

// 3.6 Stealth Fail-Safe в клиентском модуле
assert(
  bslClient.includes('_МС_ПриНачалеРаботыСистемы') && bslClient.includes('ПродолжитьВызов();'),
  'FAIL: Клиентский модуль не должен блокировать открытие интерфейса РМК кассы'
);
assert(
  bslClient.includes('_МС_ОтложенныйСтартовыйМониторинг') && bslClient.includes('Попытка'),
  'FAIL: Клиентские обработчики должны быть обернуты в Попытка...Исключение для гарантированной защиты кассира'
);

console.log('✅ БЛОК 3 УСПЕШНО ПРОЙДЕН: Контекст исполнения, временные файлы и Stealth Fail-Safe полностью верифицированы.\n');

console.log('================================================================');
console.log('🎉 ВСЕ ПРОВЕРКИ PHASE 4.1.3 (DACL & CONTEXT) УСПЕШНО ВЫПОЛНЕНЫ (PASS)!');
console.log('================================================================\n');
