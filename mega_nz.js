// ==UserScript==
// @name         Mega.nz Indexer (Merged: Hash + SmartDB) Fix infiniti console
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

    // --- ПРЕДОХРАНИТЕЛЬ ---
    // Эта переменная гарантирует, что скрипт запустится только 1 раз
    let initDone = false;

    console.log('🔧 Скрипт инициализирован. Ожидание загрузки интерфейса Mega...');

    // ==============================================
    // --- 1. Логика Базы Данных (IndexedDB) ---
    // ==============================================

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

    window.addFileToDB = async function(fileData) {
        try {
            const db = await getDB();
            await db.put(STORE_NAME, fileData);
            console.log(`✅ [БД] Записан файл: ${fileData.name} (ID: ${fileData.nodeId})`);
        } catch (e) {
            console.error('❌ Ошибка записи в БД:', e);
        }
    };

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

    // ==============================================
    // --- 3. Умный старт (Waiting Logic) ---
    // ==============================================

    function waitForApp() {
        const checkInterval = setInterval(() => {

            // 1. Дополнительная проверка: если уже запустились, убиваем таймер и выходим
            if (initDone) {
                clearInterval(checkInterval);
                return;
            }

            const isLoaded = document.querySelector('.fm-files-view') ||
                             document.querySelector('.grid-view-resize-container') ||
                             document.querySelector('.avatar-wrapper') ||
                             document.querySelector('.main-file-manager');

            if (isLoaded) {
                // 2. Сразу ставим флаг, чтобы предотвратить повторный запуск
                initDone = true;
                clearInterval(checkInterval);

                console.log('🚀 Mega.nz загружена! Запуск тестов...');
                runAutoTest();
            }
        }, 1000);
    }

    function runAutoTest() {
        // Теперь эта функция вызовется строго ОДИН раз
        const testId = 'AUTO_TEST_' + Date.now();

        window.addFileToDB({
            nodeId: testId,
            name: 'system_check.jpg',
            path: 'System/AutoCheck',
            hash: 'TEST_HASH_DEADBEEF'
        });

        console.log('ℹ️ [INFO] Тестовая запись отправлена. Хеширование готово.');
        console.log('ℹ️ Введи window.checkDB() для просмотра базы.');
    }

    // Запуск скрипта
    waitForApp();

})();// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      Alex Tol
// @description 27.11.2025, 19:25:44
// ==/UserScript==
