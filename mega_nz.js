// ==UserScript==
// @name         Mega.nz Indexer (Step 4: The Crawler v3 - DB Fix)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @require      https://cdn.jsdelivr.net/npm/idb@7/build/umd.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = 'MegaSearchDB';
    const DB_VERSION = 2; // 🔥 Подняли версию, чтобы обновить структуру
    const STORE_NAME = 'files';
    let initDone = false;

    // Настройки
    const SCROLL_DELAY = 1000;
    const SCROLL_STEP = 600;

    console.log('🔧 Скрипт v3 (DB Fix) загружен.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================
    
    function createUI() {
        const btn = document.createElement('button');
        btn.innerText = '📷 Scan Folder';
        btn.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            padding: 15px 20px; background-color: #d9272e; color: white;
            border: none; border-radius: 8px; cursor: pointer;
            font-weight: bold; font-size: 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        `;

        btn.onclick = async () => {
            btn.disabled = true;
            btn.innerText = '⏳ Scanning...';
            btn.style.backgroundColor = '#555';
            await scanCurrentFolder();
            btn.innerText = '✅ Done';
            btn.disabled = false;
            btn.style.backgroundColor = '#28a745';
            setTimeout(() => { btn.innerText = '📷 Scan Folder'; btn.style.backgroundColor = '#d9272e'; }, 3000);
        };

        document.body.appendChild(btn);
    }

    // ==============================================
    // --- 2. База Данных (Улучшенная) ---
    // ==============================================

    async function getDB() {
        return await idb.openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                // Если старой таблицы нет - создаем
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'nodeId' });
                    store.createIndex('hash', 'hash');
                    console.log('✨ Создана таблица files');
                }
            },
        });
    }

    async function addFileToDB(fileData) {
        try {
            const db = await getDB();
            // Используем put (создаст или обновит)
            await db.put(STORE_NAME, fileData);
            // Логируем успешную запись (можно закомментировать, если мешает)
            console.log(`💾 [DB Saved] ${fileData.name} (ID: ${fileData.nodeId})`);
        } catch (e) {
            console.error('❌ Ошибка записи в БД:', e, fileData);
        }
    }

    // ==============================================
    // --- 3. Хеширование ---
    // ==============================================

    function getImageHash(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                if (!imgElement || imgElement.naturalWidth < 50) return reject("Too small");

                const size = 32;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = size + 1; canvas.height = size;
                
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
    }

    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            hex += parseInt(bin.substring(i, i + 4), 2).toString(16);
        }
        return hex;
    }

    // ==============================================
    // --- 4. Логика Сканера ---
    // ==============================================

    async function scanCurrentFolder() {
        console.log('🚀 Start Scanning...');
        const scroller = document.querySelector('.file-block-scrolling');

        if (!scroller) {
            alert('❌ Не найден скролл! Убедись, что ты в режиме сетки.');
            return;
        }

        scroller.scrollTop = 0;
        await new Promise(r => setTimeout(r, 800));

        let processedCount = 0;
        const processedIDs = new Set();
        let stuckCounter = 0;

        while (true) {
            // Ищем картинки внутри ячеек
            const images = scroller.querySelectorAll('.fm-item-img img');
            
            for (let img of images) {
                try {
                    // 1. Поиск контейнера с ID
                    let fileContainer = img.closest('[id^="th_"]') || 
                                        img.closest('[id^="b_"]') ||
                                        img.closest('.mega-item-square') ||
                                        img.parentElement.parentElement;

                    // 2. Извлечение ID
                    let nodeId = fileContainer ? fileContainer.id : null;
                    if (!nodeId && fileContainer && fileContainer.dataset.nodeId) nodeId = fileContainer.dataset.nodeId;

                    // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ:
                    // Если ID не найден, генерируем временный уникальный ID, чтобы БД не ругалась
                    if (!nodeId || nodeId === "") {
                        const cleanSrc = img.src.substring(0, 50); // Берем часть ссылки
                        nodeId = "generated_" + cleanSrc.replace(/[^a-zA-Z0-9]/g, '') + "_" + Date.now() + Math.random().toString(36).substring(7);
                    }

                    if (processedIDs.has(nodeId)) continue;

                    // 3. Извлечение имени
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') || 
                                       fileContainer.querySelector('.file-name') || 
                                       fileContainer.innerText;
                        if (nameEl) {
                             // Берем текст и чистим от переносов строк
                             name = (typeof nameEl === 'string' ? nameEl : nameEl.innerText).split('\n')[0].trim();
                        }
                    }

                    // 4. Хешируем и сохраняем
                    const hash = await getImageHash(img);
                    
                    await addFileToDB({
                        nodeId: nodeId, // Теперь это поле точно заполнено
                        name: name,
                        path: document.title,
                        hash: hash,
                        timestamp: Date.now()
                    });

                    processedIDs.add(nodeId);
                    processedCount++;

                } catch (err) {
                    // Ошибки хеширования
                }
            }

            // Скроллим
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, SCROLL_STEP);
            await new Promise(r => setTimeout(r, SCROLL_DELAY));

            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) {
                    console.log('🛑 Конец списка.');
                    break;
                }
            } else {
                stuckCounter = 0;
            }
        }

        console.log(`🎉 Сканирование завершено! Обработано: ${processedCount}`);
        const total = (await window.checkDB()).length;
        console.log(`ℹ️ Итого в базе: ${total}`);
        alert(`Готово! Собрано ${processedCount} файлов. Всего в базе: ${total}`);
    }

    window.checkDB = async function() {
        const db = await getDB();
        const data = await db.getAll(STORE_NAME);
        console.table(data.slice(-5)); 
        return data;
    };

    function waitForApp() {
        const checkInterval = setInterval(() => {
            if (initDone) { clearInterval(checkInterval); return; }
            const scroller = document.querySelector('.file-block-scrolling');
            if (scroller) {
                initDone = true;
                clearInterval(checkInterval);
                createUI();
                console.log('✅ Ready to scan.');
            }
        }, 1000);
    }

    waitForApp();

})();