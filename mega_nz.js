// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v1.9 Fix GPT)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      1.9
// @author       Alex Tol
// @description  Автоматический индексатор MEGA с навигацией по папкам и сохранением хешей изображений
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v1:';
    let isRunning = false;
    let initDone = false;

    // Настройки
    const SCROLL_DELAY = 1000;
    const SCROLL_STEP = 600;
    const NAVIGATION_DELAY = 3000; // Увеличил для надёжности

    // Отмена и учёт уже посещённых папок
    let cancelRequested = false;
    const visitedFolderKeys = new Set(); // Теперь храним КЛЮЧИ (путь + имя)

    console.log('🕷️📷 Mega.nz Deep Indexer v1.9 Loaded.');

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

        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Отмена';
            cancelBtn.style.cssText = `
                position: fixed;
                bottom: 70px;
                right: 20px;
                z-index: 9999;
                padding: 10px 14px;
                background-color: #d9534f;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-weight: bold;
                font-size: 12px;
                box-shadow: 0 4px 10px rgba(0,0,0,0.4);
                opacity: 0.5;
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
                position: fixed;
                bottom: 110px;
                right: 20px;
                z-index: 9999;
                padding: 8px 12px;
                background-color: rgba(0,0,0,0.8);
                color: #0f0;
                border-radius: 6px;
                font-size: 11px;
                font-family: monospace;
                max-width: 300px;
                display: none;
            `;
            document.body.appendChild(statusDiv);
        }
    }

    function updateButtonText(count) {
        if (uiBtn) uiBtn.innerText = `📷 Scan All Folders (DB: ${count})`;
    }

    function updateStatus(text) {
        if (statusDiv) {
            statusDiv.innerText = text;
            statusDiv.style.display = text ? 'block' : 'none';
        }
        console.log(`📊 ${text}`);
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

    unsafeWindow.checkDB = async function() {
        const keys = await GM.listValues();
        const ours = keys.filter(k => k.startsWith(DB_PREFIX));
        const data = [];
        for (const key of ours) {
            data.push(await GM.getValue(key));
        }
        console.log(`📊 Всего записей: ${data.length}`);
        console.table(data.slice(-10));
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
    // --- 4. Сканнер текущей папки ---
    // ==============================================

    async function scanCurrentFolder(label = "CURRENT") {
        console.log(`📸 [Scan: ${label}]`);
        updateStatus(`Сканирую: ${label}`);

        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) {
            console.log('⚠️ Не найден .file-block-scrolling');
            return 0;
        }

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
                    let fileContainer = img.closest('[id^="th_"]') ||
                                        img.closest('.mega-item-square') ||
                                        (img.parentElement && img.parentElement.parentElement);

                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name') ||
                                       fileContainer.querySelector('.file-name');
                        if (nameEl) {
                            name = (nameEl.innerText || '').split('\n')[0].trim();
                        }
                    }

                    let nodeId = null;
                    if (fileContainer && fileContainer.id && fileContainer.id.startsWith('th_')) {
                        nodeId = fileContainer.id;
                    } else if (fileContainer && fileContainer.dataset && fileContainer.dataset.nodeId) {
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
                        path: getCurrentPath(),
                        hash: hash,
                        timestamp: Date.now()
                    });

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

        console.log(`🎉 [Scan] +${processedCount} файлов`);
        return processedCount;
    }

    // ==============================================
    // --- 5. Навигация ---
    // ==============================================

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
            setTimeout(resolve, NAVIGATION_DELAY);
        });
    }

    function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ==============================================
    // --- 6. Идентификация папок (КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ) ---
    // ==============================================

    // Получаем текущий путь из breadcrumbs
    function getCurrentPath() {
        const crumbs = document.querySelectorAll('.fm-breadcrumbs');
        let path = '';
        crumbs.forEach(c => {
            const text = (c.innerText || c.textContent || '').trim();
            if (text) path += '/' + text;
        });
        return path || '/root';
    }

    // Получаем ИМЯ папки из элемента (это КЛЮЧЕВАЯ функция)
function getFolderName(elem) {
    if (!elem) return null;

    // Пробуем разные селекторы (добавили .fm-item-name)
    const selectors = [
        '.tranfer-filetype-txt',
        '.block-view-file-name',
        '.file-name',
        '.fm-item-name',      // <== ВАЖНО для GRID
        '.name',
        'span.name'
    ];

    for (const sel of selectors) {
        const nameEl = elem.querySelector(sel);
        if (nameEl) {
            const text = (nameEl.innerText || nameEl.textContent || '').trim();
            if (text && text.length > 0) {
                return text.split('\n')[0].trim();
            }
        }
    }

    // Fallback: берём текст элемента
    const text = (elem.innerText || elem.textContent || '').trim();
    if (text) {
        return text.split('\n')[0].trim();
    }

    return null;
}

    // Создаём уникальный ключ: ПУТЬ + ИМЯ
    function makeFolderKey(folderName) {
        const parentPath = getCurrentPath();
        return `${parentPath}::${folderName}`;
    }

    // Возвращает ВСЕ контейнеры-папки
function getAllFolderContainers() {
    const result = [];
    const seenNames = new Set();

    // 1) РЕЖИМ СПИСОК (как было — работает хорошо)
    const listRows = document.querySelectorAll('tr.megaListItem');
    if (listRows.length > 0) {
        console.log(`🧾 Режим: СПИСОК, найдено строк: ${listRows.length}`);
        listRows.forEach(row => {
            const hasFolder = row.querySelector('.icon-folder-24, .folder, .sprite-fm-mono.icon-folder-filled');
            if (hasFolder) {
                const name = getFolderName(row);
                if (name && !seenNames.has(name)) {
                    seenNames.add(name);
                    result.push({ element: row, name: name });
                }
            }
        });
        return result;
    }

    // 2) РЕЖИМ GRID / BLOCKS
    // Судя по debugGridDOM, папки — это <a class="mega-node fm-item folder megaListItem ...">
    const gridFolders = document.querySelectorAll(
        '.file-block-scrolling .megaList-content a.mega-node.fm-item.folder,' +
        '.file-block-scrolling a.mega-node.fm-item.folder'
    );

    console.log(`🧊 Режим: GRID, найдено a.mega-node.fm-item.folder: ${gridFolders.length}`);

    gridFolders.forEach(a => {
        const name = getFolderName(a);
        if (name && !seenNames.has(name)) {
            seenNames.add(name);
            result.push({ element: a, name });
        }
    });

    return result;
}

    // Находит следующую НЕ посещённую папку
    function findNextUnvisitedFolder() {
        const folders = getAllFolderContainers();
        const currentPath = getCurrentPath();

        console.log(`🔍 Папка: ${currentPath}`);
        console.log(`🔍 Найдено подпапок: ${folders.length}`);
        console.log(`🔍 Уже посещено ключей: ${visitedFolderKeys.size}`);

        for (const folder of folders) {
            const key = makeFolderKey(folder.name);
            const isVisited = visitedFolderKeys.has(key);

            console.log(`   📂 "${folder.name}" => key="${key}" - ${isVisited ? '❌ БЫЛА' : '✅ НОВАЯ'}`);

            if (!isVisited) {
                return {
                    element: folder.element,
                    name: folder.name,
                    key: key
                };
            }
        }

        console.log(`🔍 Все подпапки уже посещены.`);
        return null;
    }

    // Функция отладки - вызывай из консоли: debugFolders()
    unsafeWindow.debugFolders = function() {
        const folders = getAllFolderContainers();
        const currentPath = getCurrentPath();

        console.log('=== DEBUG FOLDERS ===');
        console.log('Текущий путь:', currentPath);
        console.log('Найдено папок:', folders.length);
        console.log('Посещённые ключи:', Array.from(visitedFolderKeys));

        folders.forEach((f, i) => {
            const key = makeFolderKey(f.name);
            const visited = visitedFolderKeys.has(key);
            console.log(`[${i}] "${f.name}" | key: ${key} | visited: ${visited}`);
            console.log('    Element:', f.element);
        });

        return folders;
    };

    // ==============================================
    // --- 7. Рекурсивный обход папок ---
    // ==============================================

    async function deepScanCurrentFolder(depth = 0, maxDepth = 50) {
        if (cancelRequested) return;
        if (depth > maxDepth) {
            console.warn(`⚠️ Макс. глубина: ${maxDepth}`);
            return;
        }

        const currentPath = getCurrentPath();
        const indent = '  '.repeat(depth);

        console.log(`${indent}📁 [Depth ${depth}] ${currentPath}`);
        updateStatus(`[${depth}] ${currentPath}`);

        // Сканируем файлы
        await scanCurrentFolder(currentPath);

        // Обходим подпапки
        while (!cancelRequested) {
            // Каждый раз заново получаем список папок (DOM мог измениться)
            const nextFolder = findNextUnvisitedFolder();

            if (!nextFolder) {
                console.log(`${indent}✔️ Все подпапки обработаны`);
                break;
            }

            // ВАЖНО: Помечаем КЛЮЧ как посещённый ДО входа
            visitedFolderKeys.add(nextFolder.key);

            console.log(`${indent}➡️ Вход: "${nextFolder.name}"`);
            updateStatus(`Вхожу: ${nextFolder.name}`);

            // Визуальный хайлайт
            try {
                nextFolder.element.style.outline = '3px solid #28a745';
                nextFolder.element.style.backgroundColor = 'rgba(40, 167, 69, 0.2)';
            } catch (e) {}

            await delay(500);

            // Входим
            triggerDoubleClick(nextFolder.element);
            await waitForContentChange();

            // Рекурсия
            await deepScanCurrentFolder(depth + 1, maxDepth);

            if (cancelRequested) break;

            // Выходим назад
            console.log(`${indent}⬅️ Выход из: "${nextFolder.name}"`);
            updateStatus(`Выхожу: ${nextFolder.name}`);

            const backOk = goBack();
            if (!backOk) {
                console.error(`${indent}❌ Не удалось вернуться!`);
                return;
            }

            await waitForContentChange();
        }
    }

    // ==============================================
    // --- 8. Главная логика ---
    // ==============================================

    async function startDeepIndexing() {
        if (isRunning) return;
        isRunning = true;
        cancelRequested = false;
        visitedFolderKeys.clear();

        if (uiBtn) {
            uiBtn.disabled = true;
            uiBtn.style.backgroundColor = '#555';
            uiBtn.innerText = '⏳ Scanning...';
        }
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.style.opacity = '1';
            cancelBtn.innerText = '✖ Отмена';
        }

        console.clear();
        console.log('🚀 [DEEP INDEXER v1.9] START');
        console.log('📍 Стартовая папка:', getCurrentPath());

        try {
            await deepScanCurrentFolder(0);

            const total = await getDBCount();
            if (cancelRequested) {
                console.log('⏹ Остановлено пользователем.');
                alert(`⏹ Остановлено. В БД: ${total} файлов`);
            } else {
                console.log('✅ Завершено!');
                alert(`✅ Готово! В БД: ${total} файлов`);
            }
        } finally {
            isRunning = false;
            cancelRequested = false;
            updateStatus('');

            if (uiBtn) {
                uiBtn.disabled = false;
                uiBtn.style.backgroundColor = '#6f42c1';
                const total = await getDBCount();
                updateButtonText(total);
            }
            if (cancelBtn) {
                cancelBtn.disabled = true;
                cancelBtn.style.opacity = '0.5';
                cancelBtn.innerText = '✖ Отмена';
            }
        }
    }

    // ==============================================
    // --- 9. Инициализация ---
    // ==============================================

    async function init() {
        const totalFiles = await getDBCount();
        console.log(`💾 [STARTUP] База: ${totalFiles} файлов`);

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
                console.log('💡 Для отладки вызови: debugFolders()');
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
// @description 28.11.2025, 21:57:16
// ==/UserScript==
// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      -
// @description 28.11.2025, 22:38:22
// ==/UserScript==
