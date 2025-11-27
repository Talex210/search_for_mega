// ==UserScript==
// @name         Mega.nz Indexer (Step 4: The Crawler v5 - GM Storage)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = 'MegaSearchDB';
    const DB_VERSION = 2;
    const STORE_NAME = 'files';
    let initDone = false;

    // Настройки
    const SCROLL_DELAY = 1000;
    const SCROLL_STEP = 600;

    console.log('🔧 Скрипт v4 (Persistent) загружен.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================

    let uiBtn = null;

    function createUI(initialCount) {
        if (uiBtn) return; // Защита от дублей

        uiBtn = document.createElement('button');
        updateButtonText(initialCount);

        uiBtn.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            padding: 12px 18px; background-color: #d9272e; color: white;
            border: none; border-radius: 8px; cursor: pointer;
            font-weight: bold; font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            transition: all 0.3s; font-family: 'Segoe UI', sans-serif;
        `;

        uiBtn.onclick = async () => {
            uiBtn.disabled = true;
            uiBtn.style.backgroundColor = '#555';
            uiBtn.innerText = '⏳ Scanning...';

            await scanCurrentFolder();

            uiBtn.disabled = false;
            uiBtn.style.backgroundColor = '#28a745';
            const count = await getDBCount();
            uiBtn.innerText = `✅ Done (Saved: ${count})`;

            setTimeout(() => {
                uiBtn.style.backgroundColor = '#d9272e';
                updateButtonText(count);
            }, 3000);
        };

        document.body.appendChild(uiBtn);
    }

    function updateButtonText(count) {
        if(uiBtn) uiBtn.innerText = `📷 Scan Folder (DB: ${count})`;
    }

    // ==============================================
    // --- 2. База Данных (GM Storage, не IndexedDB) ---
    // ==============================================

    // Все записи храним в хранилище Violentmonkey с префиксом
    const DB_PREFIX = 'MegaSearchDB_v1:';

    async function getDBCount() {
        try {
            const keys = await GM.listValues();
            // На всякий случай фильтруем по префиксу, если в этом же скрипте
            // когда‑нибудь будут другие ключи.
            return keys.filter(k => k.startsWith(DB_PREFIX)).length;
        } catch (e) {
            console.error('❌ DB Count Error:', e);
            return 0;
        }
    }

    async function addFileToDB(fileData) {
        try {
            // Ключ — префикс + nodeId, значение — сам объект fileData
            await GM.setValue(DB_PREFIX + fileData.nodeId, fileData);
        } catch (e) {
            console.error('❌ DB Write Error:', e);
        }
    }

    // Глобальная функция для проверки из консоли
    // Важно: так как скрипт теперь в sandbox-е, публикуем её на unsafeWindow
    unsafeWindow.checkDB = async function() {
        const keys = await GM.listValues();
        const ours = keys.filter(k => k.startsWith(DB_PREFIX));
        const data = [];
        for (const key of ours) {
            data.push(await GM.getValue(key));
        }
        console.log(`📊 Статистика БД: Всего записей: ${data.length}`);
        console.table(data.slice(-5));
        return data;
    };

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
        console.log('🚀 Scanning...');
        const scroller = document.querySelector('.file-block-scrolling');

        if (!scroller) {
            alert('❌ Скролл не найден! Переключи вид папки.');
            return;
        }

        scroller.scrollTop = 0;
        await new Promise(r => setTimeout(r, 800));

        let processedCount = 0;
        const processedIDs = new Set();
        let stuckCounter = 0;

        while (true) {
            const images = scroller.querySelectorAll('.fm-item-img img');

            for (let img of images) {
                try {
                    // 1. Поиск блока и имени
                    let fileContainer = img.closest('[id^="th_"]') || img.closest('.mega-item-square') || img.parentElement.parentElement;

                    // 2. Достаем ИМЯ (оно критически важно для ID)
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') ||
                                       fileContainer.querySelector('.file-name') ||
                                       fileContainer.innerText;
                        if (nameEl) name = (typeof nameEl === 'string' ? nameEl : nameEl.innerText).split('\n')[0].trim();
                    }

                    // 3. Определение ID (Node ID > Name > Src)
                    let nodeId = null;
                    if (fileContainer && fileContainer.id && fileContainer.id.startsWith('th_')) {
                        nodeId = fileContainer.id;
                    } else if (fileContainer && fileContainer.dataset.nodeId) {
                        nodeId = fileContainer.dataset.nodeId;
                    }

                    // 🔥 ВАЖНО: Если нет ID от Меги, используем ИМЯ ФАЙЛА как ID
                    // Это гарантирует, что при перезагрузке мы обновим запись, а не создадим дубль
                    if (!nodeId) {
                        if (name !== 'Unknown' && name.length > 3) {
                            nodeId = "name_" + name;
                        } else {
                            // Крайний случай - используем часть URL
                            nodeId = "src_" + img.src.substring(img.src.length - 20);
                        }
                    }

                    if (processedIDs.has(nodeId)) continue;

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

                } catch (err) {}
            }

            // Скролл
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, SCROLL_STEP);
            await new Promise(r => setTimeout(r, SCROLL_DELAY));

            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) break;
            } else { stuckCounter = 0; }
        }

        console.log(`🎉 Сканирование завершено. +${processedCount} файлов.`);
        const total = await getDBCount();
        console.log(`ℹ️ Всего в базе: ${total}`);
        updateButtonText(total);
    }

    // ==============================================
    // --- 5. Старт ---
    // ==============================================

    async function init() {
        // Сразу проверяем базу
        const totalFiles = await getDBCount();
        console.log(`💾 [STARTUP] База подключена. Сохраненных файлов: ${totalFiles}`);

        const checkInterval = setInterval(() => {
            if (initDone) { clearInterval(checkInterval); return; }

            const scroller = document.querySelector('.file-block-scrolling');
            if (scroller) {
                initDone = true;
                clearInterval(checkInterval);
                createUI(totalFiles); // Передаем количество в UI
                console.log('✅ UI Ready.');
            }
        }, 1000);
    }

    init();

})();// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      -
// @description 28.11.2025, 00:47:06
// ==/UserScript==
