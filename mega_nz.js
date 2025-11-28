// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v2.0 Final Fix Gemini)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      2.0
// @author       Alex Tol
// @description  Автоматический индексатор MEGA (Grid+List fix with Scroll Reset)
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v1:';
    let isRunning = false;
    let initDone = false;

    // Настройки
    const SCROLL_DELAY = 1000;
    const SCROLL_STEP = 600;
    const NAVIGATION_DELAY = 3500;

    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    console.log('🕷️📷 Mega.nz Deep Indexer v2.0 Loaded.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================
    let uiBtn = null;
    let cancelBtn = null;
    let statusDiv = null;

    function createUI(initialCount) {
        if (!uiBtn) {
            uiBtn = document.createElement('button');
            updateButtonText(initialCount);
            uiBtn.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; z-index: 9999;
                padding: 15px 20px; background-color: #6f42c1; color: white;
                border: none; border-radius: 8px; cursor: pointer; font-weight: bold;
                font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', sans-serif;
            `;
            uiBtn.onclick = startDeepIndexing;
            document.body.appendChild(uiBtn);
        }
        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Отмена';
            cancelBtn.style.cssText = `
                position: fixed; bottom: 70px; right: 20px; z-index: 9999;
                padding: 10px 14px; background-color: #d9534f; color: white;
                border: none; border-radius: 6px; cursor: pointer; font-weight: bold;
                font-size: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.4); opacity: 0.5;
            `;
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => {
                if (!isRunning || cancelRequested) return;
                console.log('⏹ Пользователь запросил отмену.');
                cancelRequested = true;
                cancelBtn.innerText = '⏳ Останавливаем...';
            };
            document.body.appendChild(cancelBtn);
        }
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = `
                position: fixed; bottom: 110px; right: 20px; z-index: 9999;
                padding: 8px 12px; background-color: rgba(0,0,0,0.8); color: #0f0;
                border-radius: 6px; font-size: 11px; font-family: monospace;
                max-width: 300px; display: none;
            `;
            document.body.appendChild(statusDiv);
        }
    }

    function updateButtonText(count) { if (uiBtn) uiBtn.innerText = `📷 Scan All Folders (DB: ${count})`; }
    function updateStatus(text) {
        if (statusDiv) { statusDiv.innerText = text; statusDiv.style.display = text ? 'block' : 'none'; }
        console.log(`📊 ${text}`);
    }

    // ==============================================
    // --- 2. База Данных ---
    // ==============================================
    async function getDBCount() {
        try { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; }
        catch (e) { return 0; }
    }
    async function addFileToDB(fileData) {
        try { await GM.setValue(DB_PREFIX + fileData.nodeId, fileData); } catch (e) {}
    }
    unsafeWindow.checkDB = async function() {
        const keys = (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX));
        console.log(`📊 Всего записей: ${keys.length}`);
        return keys.length;
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
                        const b = imageData[i] * 0.299 + imageData[i+1] * 0.587 + imageData[i+2] * 0.114;
                        const bn = imageData[iNext] * 0.299 + imageData[iNext+1] * 0.587 + imageData[iNext+2] * 0.114;
                        hash += (b > bn) ? '1' : '0';
                    }
                }
                resolve(binToHex(hash));
            } catch (e) { reject(e); }
        });
    }
    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) hex += parseInt(bin.substring(i, i + 4), 2).toString(16);
        return hex;
    }

    // ==============================================
    // --- 4. Сканнер текущей папки ---
    // ==============================================
    async function scanCurrentFolder(label = "CURRENT") {
        console.log(`📸 [Scan: ${label}]`);
        updateStatus(`Сканирую файлы...`);

        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) { console.log('⚠️ Не найден скролл'); return 0; }

        scroller.scrollTop = 0;
        await delay(800);

        let processedCount = 0;
        const processedIDs = new Set();
        let stuckCounter = 0;

        while (true) {
            if (cancelRequested) break;
            const images = scroller.querySelectorAll('.fm-item-img img');

            for (let img of images) {
                if (cancelRequested) break;
                try {
                    let fileContainer = img.closest('[id^="th_"]') || img.closest('.mega-item-square') || img.closest('a.mega-node') || (img.parentElement && img.parentElement.parentElement);
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') || fileContainer.querySelector('.file-name') || fileContainer.querySelector('.fm-item-name');
                        if (nameEl) name = (nameEl.innerText || '').split('\n')[0].trim();
                    }

                    let nodeId = null;
                    if (fileContainer?.id?.startsWith('th_')) nodeId = fileContainer.id;
                    else if (fileContainer?.dataset?.nodeId) nodeId = fileContainer.dataset.nodeId;

                    if (!nodeId) {
                        if (name !== 'Unknown' && name.length > 3) nodeId = "name_" + name;
                        else nodeId = "src_" + img.src.substring(img.src.length - 20);
                    }

                    if (processedIDs.has(nodeId)) continue;

                    const hash = await getImageHash(img);
                    await addFileToDB({ nodeId, name, path: getCurrentPath(), hash, timestamp: Date.now() });
                    processedIDs.add(nodeId);
                    processedCount++;
                } catch (err) {}
            }

            if (cancelRequested) break;

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
        return processedCount;
    }

    // ==============================================
    // --- 5. Навигация и Утилиты ---
    // ==============================================
    function triggerDoubleClick(element) {
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: unsafeWindow }));
    }
    function goBack() {
        const crumbs = document.querySelectorAll('.fm-breadcrumbs');
        if (crumbs.length >= 2) { crumbs[crumbs.length - 2].click(); return true; }
        return false;
    }
    function waitForContentChange() { return new Promise(r => setTimeout(r, NAVIGATION_DELAY)); }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    function getCurrentPath() {
        const crumbs = document.querySelectorAll('.fm-breadcrumbs');
        let path = '';
        crumbs.forEach(c => {
            const text = (c.innerText || c.textContent || '').trim();
            if (text) path += '/' + text;
        });
        return path || '/root';
    }

    function getFolderName(elem) {
        if (!elem) return null;
        // Важно: fm-item-name используется в Grid
        const selectors = ['.fm-item-name', '.tranfer-filetype-txt', '.block-view-file-name', '.file-name', '.name', 'span.name'];
        for (const sel of selectors) {
            const nameEl = elem.querySelector(sel);
            if (nameEl) {
                const text = (nameEl.innerText || nameEl.textContent || '').trim();
                if (text) return text.replace(/[\r\n]+/g, '').trim();
            }
        }
        return (elem.innerText || '').split('\n')[0].trim();
    }

    function makeFolderKey(folderName) {
        return `${getCurrentPath()}::${folderName}`;
    }

    // === ИСПРАВЛЕННАЯ ФУНКЦИЯ ПОИСКА ПАПОК ===
    function getAllFolderContainers() {
        const result = [];
        const seenNames = new Set();

        // Универсальный селектор для Grid и List в современном интерфейсе Mega
        // Ищем элементы, которые имеют класс 'mega-node' и 'folder'
        // Это работает и для <tr> (список) и для <a> (сетка)
        const allFolders = document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder');

        allFolders.forEach(node => {
            // Если нашли иконку (.folder), берем родителя-контейнер
            let container = node;
            if (!node.classList.contains('mega-node') && !node.classList.contains('megaListItem')) {
                container = node.closest('.mega-node') || node.closest('tr.megaListItem') || node.closest('.mega-item-square');
            }

            if (container) {
                const name = getFolderName(container);
                if (name && !seenNames.has(name)) {
                    seenNames.add(name);
                    result.push({ element: container, name: name });
                }
            }
        });

        return result;
    }

    function findNextUnvisitedFolder() {
        const folders = getAllFolderContainers();
        const currentPath = getCurrentPath();

        console.log(`🔍 Путь: ${currentPath} | Папок: ${folders.length} | Посещено: ${visitedFolderKeys.size}`);

        for (const folder of folders) {
            const key = makeFolderKey(folder.name);
            if (!visitedFolderKeys.has(key)) {
                console.log(`✅ Найдена новая папка: "${folder.name}"`);
                return { element: folder.element, name: folder.name, key: key };
            }
        }
        return null;
    }

    unsafeWindow.debugFolders = function() {
        const folders = getAllFolderContainers();
        console.log('=== DEBUG FOLDERS ===');
        folders.forEach((f, i) => console.log(`[${i}] "${f.name}"`, f.element));
        return folders;
    };

    // ==============================================
    // --- 6. Рекурсивный обход ---
    // ==============================================
    async function deepScanCurrentFolder(depth = 0, maxDepth = 50) {
        if (cancelRequested || depth > maxDepth) return;

        const currentPath = getCurrentPath();
        const indent = '  '.repeat(depth);
        console.log(`${indent}📁 [Level ${depth}] ${currentPath}`);

        // 1. Сканируем файлы (это уведет скролл вниз)
        await scanCurrentFolder(currentPath);

        // 2. !!! ВАЖНО !!! СБРАСЫВАЕМ СКРОЛЛ ВВЕРХ
        // В Grid режиме MEGA удаляет верхние элементы из DOM, когда скролл внизу.
        // Чтобы найти папки (которые обычно сверху), нужно вернуть скролл.
        const scroller = document.querySelector('.file-block-scrolling');
        if (scroller) {
            console.log(`${indent}⬆️ Сброс скролла для поиска папок...`);
            scroller.scrollTop = 0;
            await delay(1500); // Даем время на отрисовку DOM
        }

        // 3. Ищем подпапки
        while (!cancelRequested) {
            const nextFolder = findNextUnvisitedFolder();
            if (!nextFolder) {
                console.log(`${indent}✔️ Папок больше нет.`);
                break;
            }

            visitedFolderKeys.add(nextFolder.key);
            updateStatus(`Вход: ${nextFolder.name}`);
            console.log(`${indent}➡️ Вход: "${nextFolder.name}"`);

            try {
                nextFolder.element.style.outline = '3px solid #28a745';
            } catch (e) {}

            await delay(500);
            triggerDoubleClick(nextFolder.element);
            await waitForContentChange();

            await deepScanCurrentFolder(depth + 1, maxDepth);

            if (cancelRequested) break;

            console.log(`${indent}⬅️ Назад`);
            if (!goBack()) {
                console.error(`${indent}❌ Ошибка возврата!`);
                return;
            }
            await waitForContentChange();
        }
    }

    // ==============================================
    // --- 7. Старт ---
    // ==============================================
    async function startDeepIndexing() {
        if (isRunning) return;
        isRunning = true;
        cancelRequested = false;
        visitedFolderKeys.clear();

        uiBtn.disabled = true; uiBtn.innerText = '⏳ Working...';
        cancelBtn.disabled = false; cancelBtn.style.opacity = '1';

        console.clear();
        console.log('🚀 START DEEP INDEXING');

        try {
            await deepScanCurrentFolder(0);
            alert(cancelRequested ? "⏹ Остановлено." : "✅ Готово!");
        } finally {
            isRunning = false;
            cancelRequested = false;
            updateStatus('');
            uiBtn.disabled = false;
            updateButtonText(await getDBCount());
            cancelBtn.disabled = true; cancelBtn.style.opacity = '0.5';
        }
    }

    async function init() {
        const total = await getDBCount();
        const check = setInterval(() => {
            if (document.querySelector('.file-block-scrolling')) {
                clearInterval(check);
                createUI(total);
                console.log('✅ Ready.');
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
// @description 28.11.2025, 23:46:29
// ==/UserScript==
