// ==UserScript==
// @name         Mega.nz Indexer (Steps 2+3)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @require      https://cdn.jsdelivr.net/npm/idb@7/build/umd.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = 'MegaSearchDB';
    const STORE_NAME = 'files';

    console.log('💾 Инициализация базы данных...');

    // --- 1. Логика Базы Данных (IndexedDB) ---

    // Создаем/Открываем базу
    async function getDB() {
        // idb - глобальная переменная из подключенной библиотеки @require
        return await idb.openDB(DB_NAME, 1, {
            upgrade(db) {
                // Если базы нет, создаем хранилище 'files'
                // keyPath: 'nodeId' - это уникальный ID файла, чтобы не было дублей
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'nodeId' });
                    // Создаем индекс для быстрого поиска по хешу (на будущее)
                    store.createIndex('hash', 'hash');
                    console.log('✨ Создано новое хранилище файлов!');
                }
            },
        });
    }

    // Функция добавления файла
    window.addFileToDB = async function(fileData) {
        try {
            const db = await getDB();
            // put - добавит или обновит запись, если такой ID уже есть
            await db.put(STORE_NAME, fileData);
            console.log(`✅ Файл сохранен в БД: ${fileData.name}`);
        } catch (e) {
            console.error('Ошибка записи в БД:', e);
        }
    };

    // Функция просмотра всей базы (для теста)
    window.checkDB = async function() {
        const db = await getDB();
        const allFiles = await db.getAll(STORE_NAME);
        console.log('📂 Всего файлов в базе:', allFiles.length);
        console.table(allFiles); // Выведет красивую таблицу
        return allFiles;
    };


    // --- 2. Твой код хеширования из Шага 2 (оставляем его) ---
    window.getImageHash = function(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                if (!imgElement) return reject("Нет элемента");
                const size = 32;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = size + 1; canvas.height = size;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(imgElement, 0, 0, size + 1, size);
                const imageData = ctx.getImageData(0, 0, size + 1, size).data;
                let hash = '';
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        const i = (y * (size + 1) + x) * 4;
                        const iNext = (y * (size + 1) + (x + 1)) * 4;
                        const bright = imageData[i] * 0.299 + imageData[i+1] * 0.587 + imageData[i+2] * 0.114;
                        const brightNext = imageData[iNext] * 0.299 + imageData[iNext+1] * 0.587 + imageData[iNext+2] * 0.114;
                        hash += (bright > brightNext) ? '1' : '0';
                    }
                }
                resolve(binToHex(hash));
            } catch (e) { reject(e); }
        });
    };
    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            hex += parseInt(bin.substring(i, i + 4), 2).toString(16);
        }
        return hex;
    }

    // --- 3. АВТОМАТИЧЕСКИЙ ТЕСТ ---
    // Ждем пару секунд и пробуем записать тестовые данные
    setTimeout(() => {
        console.log('🧪 Запуск теста записи...');
        window.addFileToDB({
            nodeId: 'TEST_ID_12345',
            name: 'test_image_001.jpg',
            path: 'Корневая папка / Проекты',
            hash: 'deadbeef0000111122223333'
        });
        console.log('ℹ️ Чтобы проверить базу, введи в консоль: window.checkDB()');
    }, 3000);

})();// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      -
// @description 27.11.2025, 16:54:21
// ==/UserScript==
