// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v1.0)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      1.6
// @author       Alex Tol
// @description  Автоматический индексатор MEGA с навигацией по папкам и сохранением хешей изображений
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v1:';
    let isRunning = false;
    let initDone = false;

    // Настройки скролла
    const SCROLL_DELAY = 1000;
    const SCROLL_STEP = 600;

    console.log('🕷️📷 Mega.nz Deep Indexer v1.0 Loaded.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================

    let uiBtn = null;

    function createUI(initialCount) {
        if (uiBtn) return;
        uiBtn = document.createElement('button');
        updateButtonText(initialCount);
        uiBtn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            padding: 15px 20px;
            background-color: #6f42c1;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            transition: all 0.3s;
            font-family: 'Segoe UI', sans-serif;
        `;
        uiBtn.onclick = startDeepIndexing;
        document.body.appendChild(uiBtn);
    }

    function updateButtonText(count) {
        if(uiBtn) uiBtn.innerText = `📷 Scan All Folders (DB: ${count})`;
    }

    // ==============================================
    // --- 2. База Данных ---
    // ==============================================

    async function getDBCount() {
        try {
            const keys = await GM.listValues();
            return keys.filter(k => k.startsWith(DB_PREFIX)).length;
        } catch (e) {
            console.error('❌ DB Count Error:', e);
            return 0;
        }
    }

    async function addFileToDB(fileData) {
        try {
            await GM.setValue(DB_PREFIX + fileData.nodeId, fileData);
        } catch (e) {
            console.error('❌ DB Write Error:', e);
        }
    }

    // Глобальная функция для проверки из консоли
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
    // --- 3. Хеширование изображений ---
    // ==============================================

    function getImageHash(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                if (!imgElement || imgElement.naturalWidth < 50) return reject("Too small");
                const size = 32;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = size + 1;
                canvas.height = size;
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
            } catch (e) {
                reject(e);
            }
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
    // --- 4. Сканнер текущей папки (с прокруткой) ---
    // ==============================================

    async function scanCurrentFolder(label = "CURRENT") {
        console.log(`📸 [Scan: ${label}] ...`);
        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) {
            console.log('⚠️ [Scan] Не найден контейнер .file-block-scrolling');
            return 0;
        }

        scroller.scrollTop = 0;
        await delay(800);

        let processedCount = 0;
        const processedIDs = new Set();
        let stuckCounter = 0;

        while (true) {
            const images = scroller.querySelectorAll('.fm-item-img img');
            for (let img of images) {
                try {
                    // 1. Поиск блока и имени
                    let fileContainer = img.closest('[id^="th_"]') ||
                                        img.closest('.mega-item-square') ||
                                        img.parentElement.parentElement;

                    // 2. Достаем ИМЯ
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') ||
                                       fileContainer.querySelector('.file-name') ||
                                       (fileContainer.innerText && fileContainer.innerText.split('\n')[0].trim());
                        if (nameEl) name = (typeof nameEl === 'string' ? nameEl : nameEl.innerText).split('\n')[0].trim();
                    }

                    // 3. Определение ID (Node ID > Name > Src)
                    let nodeId = null;
                    if (fileContainer && fileContainer.id && fileContainer.id.startsWith('th_')) {
                        nodeId = fileContainer.id;
                    } else if (fileContainer && fileContainer.dataset.nodeId) {
                        nodeId = fileContainer.dataset.nodeId;
                    }
                    if (!nodeId) {
                        if (name !== 'Unknown' && name.length > 3) {
                            nodeId = "name_" + name;
                        } else {
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
                } catch (err) {
                    console.warn('⚠️ Ошибка при обработке файла:', err);
                }
            }

            // Скроллим дальше
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, SCROLL_STEP);
            await delay(SCROLL_DELAY);

            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) break;
            } else {
                stuckCounter = 0;
            }
        }

        console.log(`🎉 [Scan: ${label}] Завершено. +${processedCount} файлов.`);
        return processedCount;
    }

    // ==============================================
    // --- 5. Навигация по папкам (универсальная) ---
    // ==============================================

    function findFolderElement() {
        const listFolders = document.querySelectorAll('tr.megaListItem .icon-folder-24, tr.megaListItem .folder');
        if (listFolders.length > 0) {
            console.log('🔎 Режим: СПИСОК');
            return listFolders[0].closest('tr');
        }
        const gridFolders = document.querySelectorAll('.mega-item-square .icon-folder-90, .mega-item-square .folder');
        if (gridFolders.length > 0) {
            console.log('🔎 Режим: СЕТКА');
            return gridFolders[0].closest('.mega-item-square');
        }
        console.log('🔎 Режим: Fallback');
        const icons = document.querySelectorAll('.icon-folder-90, .icon-folder-24, .folder');
        if (icons.length > 0) {
            const icon = icons[0];
            return (
                icon.closest('.mega-item-square') ||
                icon.closest('tr') ||
                icon.closest('.fm-item-img') ||
                icon
            );
        }
        return null;
    }

    function triggerDoubleClick(element) {
        const evt = new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            view: unsafeWindow
        });
        element.dispatchEvent(evt);
    }

    function goBack() {
        const crumbs = document.querySelectorAll('.fm-breadcrumbs');
        if (crumbs.length >= 2) {
            crumbs[crumbs.length - 2].click();
            return true;
        }
        return false;
    }

    function waitForContentChange() {
        return new Promise(resolve => {
            console.log('⏳ Ждем загрузки нового содержимого...');
            setTimeout(resolve, 2500);
        });
    }

    function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ==============================================
    // --- 6. Главная логика: Deep Indexing ---
    // ==============================================

    async function startDeepIndexing() {
        if (isRunning) return;
        isRunning = true;

        if (uiBtn) {
            uiBtn.disabled = true;
            uiBtn.style.backgroundColor = '#555';
            uiBtn.innerText = '⏳ Starting...';
        }

        console.clear();
        console.log('🚀 [DEEP INDEXER] START');

        try {
            // Сначала сканируем корень
            await scanCurrentFolder("ROOT");

            // Получаем первую папку
            const firstFolder = findFolderElement();
            if (!firstFolder) {
                console.warn('⚠️ Папок не найдено.');
                alert('В текущей папке нет подпапок.');
                return;
            }

            console.log('📂 Найдена первая папка:', firstFolder);
            firstFolder.style.border = "3px solid #6f42c1";
            firstFolder.style.backgroundColor = "rgba(111, 66, 193, 0.1)";
            await delay(500);

            // Переходим внутрь
            triggerDoubleClick(firstFolder);
            await waitForContentChange();

            // Сканируем внутри
            await scanCurrentFolder("SUBFOLDER");

            // Возвращаемся назад
            console.log('⬅️ Выходим назад...');
            const goneBack = goBack();
            if (goneBack) {
                await waitForContentChange();
                console.log('✅ [DEEP INDEXER] Успешно завершено!');
                alert('✅ Индексация завершена: корень + 1 подпапка просканированы.');
            } else {
                console.error('❌ Не удалось вернуться назад.');
            }

        } finally {
            isRunning = false;
            if (uiBtn) {
                uiBtn.disabled = false;
                uiBtn.style.backgroundColor = '#6f42c1';
                const total = await getDBCount();
                updateButtonText(total);
            }
        }
    }

    // ==============================================
    // --- 7. Инициализация ---
    // ==============================================

    async function init() {
        const totalFiles = await getDBCount();
        console.log(`💾 [STARTUP] База подключена. Сохраненных файлов: ${totalFiles}`);

        const checkInterval = setInterval(() => {
            if (initDone) {
                clearInterval(checkInterval);
                return;
            }
            const scroller = document.querySelector('.file-block-scrolling');
            if (scroller) {
                initDone = true;
                clearInterval(checkInterval);
                createUI(totalFiles);
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
// @version     1.6
// @author      Alex Tol
// @description 28.11.2025, 19:41:06
// ==/UserScript==
