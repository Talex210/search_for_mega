// ==UserScript==
// @name         Mega.nz Indexer (Step 4: The Crawler v2)
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
    let initDone = false;

    // Настройки
    const SCROLL_DELAY = 1000; // Чуть увеличили задержку для надежности
    const SCROLL_STEP = 600;   

    console.log('🔧 Скрипт (v2) загружен. Ждем интерфейс...');

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
            btn.innerText = '⏳ Working...';
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
    // --- 2. База Данных ---
    // ==============================================

    async function getDB() {
        return await idb.openDB(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'nodeId' });
                    store.createIndex('hash', 'hash');
                }
            },
        });
    }

    async function addFileToDB(fileData) {
        try {
            const db = await getDB();
            await db.put(STORE_NAME, fileData);
        } catch (e) { console.error('DB Error:', e); }
    }

    // ==============================================
    // --- 3. Хеширование ---
    // ==============================================

    function getImageHash(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                // Игнорируем мелкие иконки и незагруженные
                if (!imgElement || imgElement.naturalWidth < 50) return reject("Too small or not loaded");

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
    // --- 4. Логика Сканера (FIXED) ---
    // ==============================================

    async function scanCurrentFolder() {
        console.log('🚀 Начинаем сканирование...');

        // 1. ПРАВИЛЬНЫЙ СЕЛЕКТОР СКРОЛЛА
        const scroller = document.querySelector('.file-block-scrolling');

        if (!scroller) {
            console.error('❌ ОШИБКА: Не найден .file-block-scrolling! Попробуй переключить вид папки в список и обратно в сетку.');
            alert('Ошибка: Не найден скролл-контейнер Mega. Проверь консоль.');
            return;
        }

        console.log('✅ Скролл-контейнер найден:', scroller);

        // Сброс вверх
        scroller.scrollTop = 0;
        await new Promise(r => setTimeout(r, 1000));

        let processedCount = 0;
        const processedIDs = new Set();
        let stuckCounter = 0;

        while (true) {
            // --- А. Поиск картинок ---
            // Ищем теги IMG строго внутри блоков .fm-item-img
            const images = scroller.querySelectorAll('.fm-item-img img');
            
            console.log(`👁️ Видимых картинок в блоке скролла: ${images.length}`);

            for (let img of images) {
                try {
                    // 1. Пытаемся найти родительский контейнер файла, чтобы взять ID и Имя
                    // Обычно ID висит на div, который выше на 1-3 уровня
                    let fileContainer = img.closest('[id^="th_"]') || // ID начинается с th_
                                        img.closest('[id^="b_"]') ||  // Иногда b_
                                        img.closest('.mega-item-square') || 
                                        img.closest('.block-view-file') ||
                                        img.parentElement.parentElement; // Fallback

                    let nodeId = fileContainer ? fileContainer.id : null;
                    
                    // Если ID нет в атрибуте id, ищем в dataset
                    if (!nodeId && fileContainer && fileContainer.dataset.nodeId) {
                        nodeId = fileContainer.dataset.nodeId;
                    }

                    // Если ID всё еще нет, берем src картинки как уникальный ключ (костыль, но рабочий)
                    if (!nodeId) nodeId = img.src; 

                    // Пропуск дублей
                    if (processedIDs.has(nodeId)) continue;

                    // Получение имени файла (ищем текстовый блок рядом)
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') || 
                                       fileContainer.querySelector('.file-name') || 
                                       fileContainer.innerText; // На крайний случай берем весь текст блока
                        if (nameEl && typeof nameEl === 'string') name = nameEl.split('\n')[0]; // Берем первую строку
                        else if (nameEl && nameEl.innerText) name = nameEl.innerText;
                    }

                    // Хеширование
                    const hash = await getImageHash(img);
                    
                    await addFileToDB({
                        nodeId: nodeId,
                        name: name,
                        path: document.title,
                        hash: hash,
                        timestamp: Date.now()
                    });

                    processedIDs.add(nodeId);
                    processedCount++;

                } catch (err) {
                    // Ошибки часто бывают на иконках папок или мелких заглушках, это нормально
                }
            }

            // --- Б. Скроллинг ---
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, SCROLL_STEP);
            await new Promise(r => setTimeout(r, SCROLL_DELAY)); // Ждем подгрузку

            // --- В. Проверка дна ---
            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) {
                    console.log('🛑 Достигнут конец списка.');
                    break;
                }
            } else {
                stuckCounter = 0;
            }
        }

        console.log(`🎉 Готово! Обработано файлов: ${processedCount}`);
        console.log(`ℹ️ Всего в базе: ${(await window.checkDB()).length}`);
    }

    window.checkDB = async function() {
        const db = await getDB();
        const data = await db.getAll(STORE_NAME);
        console.table(data.slice(-5)); // Показать последние 5
        return data;
    };

    // ==============================================
    // --- 5. Старт ---
    // ==============================================

    function waitForApp() {
        const checkInterval = setInterval(() => {
            if (initDone) { clearInterval(checkInterval); return; }

            // Ждем именно контейнер скролла
            const scroller = document.querySelector('.file-block-scrolling');
            
            if (scroller) {
                initDone = true;
                clearInterval(checkInterval);
                createUI();
                console.log('✅ Интерфейс найден. Кнопка добавлена.');
            }
        }, 1000);
    }

    waitForApp();

})();