// ==UserScript==
// @name         Mega.nz Indexer (Merged: Hash + SmartDB)
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

    console.log('🔧 Скрипт инициализирован. Ожидание загрузки интерфейса Mega...');

    // ==============================================
    // --- 1. Логика Базы Данных (IndexedDB) ---
    // ==============================================

    // Создаем/Открываем базу
    async function getDB() {
        return await idb.openDB(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'nodeId' });
                    store.createIndex('hash', 'hash');
                    console.log('✨ Создано новое хранилище файлов (files)!');
                }
            },
        });
    }

    // Функция добавления файла (доступна в консоли)
    window.addFileToDB = async function(fileData) {
        try {
            const db = await getDB();
            await db.put(STORE_NAME, fileData);
            console.log(`✅ [БД] Записан файл: ${fileData.name} (ID: ${fileData.nodeId})`);
        } catch (e) {
            console.error('❌ Ошибка записи в БД:', e);
        }
    };

    // Функция просмотра всей базы (доступна в консоли)
    window.checkDB = async function() {
        const db = await getDB();
        const allFiles = await db.getAll(STORE_NAME);
        console.log(`📂 Файлов в базе: ${allFiles.length}`);
        console.table(allFiles);
        return allFiles;
    };

    // ==============================================
    // --- 2. Логика Хеширования (Perceptual Hash) ---
    // ==============================================

    window.getImageHash = function(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                if (!imgElement) return reject("Нет элемента изображения");
                const size = 32;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = size + 1; canvas.height = size;
                ctx.imageSmoothingEnabled = true;
                
                // Рисуем картинку на маленький канвас
                ctx.drawImage(imgElement, 0, 0, size + 1, size);
                const imageData = ctx.getImageData(0, 0, size + 1, size).data;
                
                let hash = '';
                // Вычисляем разницу яркости пикселей
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

    // Вспомогательная функция перевода бинарного кода в HEX
    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            hex += parseInt(bin.substring(i, i + 4), 2).toString(16);
        }
        return hex;
    }

    // ==============================================
    // --- 3. Умный старт (Waiting Logic) ---
    // ==============================================

    function waitForApp() {
        // Проверяем наличие интерфейса каждые 1000мс (1 сек)
        const checkInterval = setInterval(() => {
            
            const isLoaded = document.querySelector('.fm-files-view') || 
                             document.querySelector('.grid-view-resize-container') ||
                             document.querySelector('.avatar-wrapper') ||
                             document.querySelector('.main-file-manager');

            if (isLoaded) {
                clearInterval(checkInterval); // Останавливаем таймер
                console.log('🚀 Mega.nz загружена! Запуск тестов...');
                
                // Запускаем авто-тест базы данных
                runAutoTest();
            }
        }, 1000);
    }

    function runAutoTest() {
        // Тестовая запись при каждом запуске с уникальным ID
        window.addFileToDB({
            nodeId: 'AUTO_TEST_' + Date.now(), // Уникальный ID (Timestamp)
            name: 'system_check.jpg',
            path: 'System/AutoCheck',
            hash: 'TEST_HASH_DEADBEEF'
        });

        console.log('ℹ️ Хеширование готово. Для проверки хеша вручную используй window.getImageHash()');
        console.log('ℹ️ Для просмотра базы введи: window.checkDB()');
    }

    // Запуск скрипта
    waitForApp();

})();