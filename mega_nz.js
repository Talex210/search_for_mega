// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v2.3 Fast Folder Search + Search UI)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      2.4
// @author       Alex Tol
// @description  Автоматический индексатор MEGA + Поиск по картинке (Image Reverse Search)
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v1:';
    let isRunning = false;

    // === НАСТРОЙКИ ===
    const FILE_SCROLL_DELAY = 1500;
    const FILE_SCROLL_STEP = 600;
    const FOLDER_SEARCH_DELAY = 200;
    const FOLDER_SEARCH_STEP = 1200;
    const NAVIGATION_DELAY = 3000;

    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    console.log('🕷️📷 Mega.nz Deep Indexer v2.4 Loaded.');

    // ==============================================
    // --- 1. UI (Buttons & Search Panel) ---
    // ==============================================
    let uiBtn = null;
    let searchBtn = null;
    let cancelBtn = null;
    let statusDiv = null;
    let searchPanel = null;

    function createUI(initialCount) {
        // 1. Кнопка сканирования
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

        // 2. Кнопка Поиска (НОВАЯ)
        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.cssText = `
                position: fixed; bottom: 20px; right: 260px; z-index: 9999;
                padding: 15px 20px; background-color: #007bff; color: white;
                border: none; border-radius: 8px; cursor: pointer; font-weight: bold;
                font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', sans-serif;
            `;
            searchBtn.onclick = toggleSearchUI;
            document.body.appendChild(searchBtn);
        }

        // 3. Кнопка Отмены
        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Отмена';
            cancelBtn.style.cssText = `
                position: fixed; bottom: 75px; right: 20px; z-index: 9999;
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

        // 4. Статус бар
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

    // === SEARCH UI PANEL ===
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'block' : 'none';
            return;
        }

        searchPanel = document.createElement('div');
        searchPanel.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 500px; max-height: 80vh; background: #fff; color: #333;
            z-index: 10000; padding: 20px; border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow-y: auto;
            font-family: 'Segoe UI', sans-serif; display: block;
        `;

        searchPanel.innerHTML = `
            <h3 style="margin-top:0; border-bottom: 1px solid #ccc; padding-bottom: 10px;">📷 Поиск по картинке</h3>
            <div style="margin-bottom: 15px;">
                <input type="file" id="megaSearchInput" accept="image/*" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
            </div>
            <div id="megaSearchPreview" style="text-align: center; margin-bottom: 15px; display:none;">
                <img id="previewImg" style="max-width: 150px; max-height: 150px; border: 1px solid #ccc;">
            </div>
            <div id="megaSearchResults" style="background: #f9f9f9; padding: 10px; border-radius: 5px; min-height: 50px;">
                <i>Выберите файл для поиска...</i>
            </div>
            <button id="closeSearch" style="margin-top: 15px; padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Закрыть</button>
        `;

        document.body.appendChild(searchPanel);

        searchPanel.querySelector('#closeSearch').onclick = () => searchPanel.style.display = 'none';
        searchPanel.querySelector('#megaSearchInput').addEventListener('change', handleFileSelect);
    }

    async function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const resultsDiv = document.getElementById('megaSearchResults');
        const previewDiv = document.getElementById('megaSearchPreview');
        const previewImg = document.getElementById('previewImg');

        resultsDiv.innerHTML = '⏳ Обработка изображения и поиск в базе...';

        // Показать превью
        const imgUrl = URL.createObjectURL(file);
        previewImg.src = imgUrl;
        previewDiv.style.display = 'block';

        // Ждем загрузки картинки для хэширования
        await new Promise(r => setTimeout(r, 100)); // Даем UI обновиться

        try {
            // 1. Считаем хэш загруженного файла (создаем временный Image объект)
            const tempImg = new Image();
            tempImg.src = imgUrl;
            await new Promise(resolve => tempImg.onload = resolve);

            const searchHash = await getImageHash(tempImg);

            // 2. Поиск
            resultsDiv.innerHTML = '⏳ Сравниваем хэши (Hamming Distance)...';
            const matches = await searchInDB(searchHash);

            // 3. Вывод
            if (matches.length === 0) {
                resultsDiv.innerHTML = '❌ Ничего не найдено или база пуста.';
            } else {
                let html = '<ul style="list-style: none; padding: 0;">';
                matches.forEach((m, idx) => {
                    const color = m.dist === 0 ? '#28a745' : (m.dist < 10 ? '#fd7e14' : '#dc3545');
                    // Генерируем ссылку (для Mega это обычно nodeId, но полная ссылка зависит от контекста)
                    // Сделаем ссылку на файл в формате /fm/nodeId (работает если вы залогинены)
                    const link = `https://mega.nz/fm/${m.nodeId.replace('th_', '')}`;

                    html += `
                        <li style="border-bottom: 1px solid #eee; padding: 8px 0; font-size: 13px;">
                            <div style="font-weight: bold; color: #007bff;">#${idx+1} [Dist: <span style="color:${color}">${m.dist}</span>]</div>
                            <div>📁 ${m.name}</div>
                            <div style="color: #666; font-size: 11px;">Path: ${m.path}</div>
                            <a href="${link}" target="_blank" style="font-size: 11px; color: #6f42c1;">🔗 Открыть (может потребоваться поиск)</a>
                        </li>
                    `;
                });
                html += '</ul>';
                resultsDiv.innerHTML = html;
            }

        } catch (e) {
            console.error(e);
            resultsDiv.innerHTML = `❌ Ошибка: ${e.message}`;
        }
    }

    // === SEARCH LOGIC (HAMMING) ===
    async function searchInDB(targetHash) {
        const keys = await GM.listValues();
        const results = [];

        // Проходим по всем ключам базы
        for (let key of keys) {
            if (!key.startsWith(DB_PREFIX)) continue;

            const record = await GM.getValue(key);
            if (!record || !record.hash) continue;

            const dist = calculateHammingDistance(targetHash, record.hash);

            // Собираем результаты (можно ограничить, например distance < 20)
            results.push({ ...record, dist });
        }

        // Сортируем: меньше дистанция = лучше совпадение
        results.sort((a, b) => a.dist - b.dist);

        // Возвращаем топ-5
        return results.slice(0, 5);
    }

    function calculateHammingDistance(hex1, hex2) {
        if (hex1.length !== hex2.length) return 9999; // Разная длина хэшей - ошибка

        let distance = 0;
        for (let i = 0; i < hex1.length; i++) {
            const val1 = parseInt(hex1[i], 16);
            const val2 = parseInt(hex2[i], 16);

            // XOR показывает битовые различия
            let xor = val1 ^ val2;

            // Считаем количество единиц в бинарном представлении XOR
            while (xor) {
                distance += xor & 1;
                xor >>= 1;
            }
        }
        return distance;
    }

    function updateButtonText(count) { if (uiBtn) uiBtn.innerText = `📷 Scan All Folders (DB: ${count})`; }
    function updateStatus(text) {
        if (statusDiv) { statusDiv.innerText = text; statusDiv.style.display = text ? 'block' : 'none'; }
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
    async function checkFileExists(nodeId) {
        try {
            const val = await GM.getValue(DB_PREFIX + nodeId);
            return !!val;
        } catch (e) { return false; }
    }

    // ==============================================
    // --- 3. Хеширование ---
    // ==============================================
    function getImageHash(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                // Если картинка не загружена или слишком мала (и это не превью)
                if (!imgElement || (imgElement.naturalWidth < 10 && imgElement.width < 10)) return reject("Image not ready or too small");

                const size = 32;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = size + 1; canvas.height = size;

                // Рисуем картинку сжатой до 33x32
                ctx.drawImage(imgElement, 0, 0, size + 1, size);

                const imageData = ctx.getImageData(0, 0, size + 1, size).data;
                let hash = '';

                // Сравниваем пиксель с соседом справа
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        const i = (y * (size + 1) + x) * 4;
                        const iNext = (y * (size + 1) + (x + 1)) * 4;

                        // Перевод в оттенки серого (Luma)
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
    // --- 4. Сканнер текущей папки (Файлы) ---
    // ==============================================
    async function scanCurrentFolder(label = "CURRENT") {
        console.log(`📸 [Scan: ${label}]`);
        updateStatus(`Сканирую файлы...`);

        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) { console.log('⚠️ Не найден скролл'); return 0; }

        scroller.scrollTop = 0;
        await delay(1000);

        let processedCount = 0;
        let skippedCount = 0;
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

                    // Проверка в БД
                    const alreadyInDB = await checkFileExists(nodeId);
                    if (alreadyInDB) {
                        skippedCount++;
                        processedIDs.add(nodeId);
                        continue;
                    }

                    const hash = await getImageHash(img);
                    // Сохраняем в базу
                    await addFileToDB({ nodeId, name, path: getCurrentPath(), hash, timestamp: Date.now() });

                    processedIDs.add(nodeId);
                    processedCount++;
                } catch (err) {}
            }

            if (cancelRequested) break;

            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);

            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) break;
            } else {
                stuckCounter = 0;
            }
        }

        console.log(`📊 Итог папки: +${processedCount} новых, ${skippedCount} пропущено.`);
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

    function getAllFolderContainers() {
        const result = [];
        const seenNames = new Set();
        const allFolders = document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder');
        allFolders.forEach(node => {
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
        for (const folder of folders) {
            const key = makeFolderKey(folder.name);
            if (!visitedFolderKeys.has(key)) {
                console.log(`✅ Найдена новая папка: "${folder.name}"`);
                return { element: folder.element, name: folder.name, key: key };
            }
        }
        return null;
    }

    // ==============================================
    // --- 6. Рекурсивный обход ---
    // ==============================================
    async function deepScanCurrentFolder(depth = 0, maxDepth = 50) {
        if (cancelRequested || depth > maxDepth) return;

        const currentPath = getCurrentPath();
        const indent = '  '.repeat(depth);
        console.log(`${indent}📁 [Level ${depth}] ${currentPath}`);

        await scanCurrentFolder(currentPath);

        const scroller = document.querySelector('.file-block-scrolling');
        if (scroller) {
            scroller.scrollTop = 0;
            await delay(1000);
        }

        while (!cancelRequested) {
            const nextFolder = findNextUnvisitedFolder();

            if (!nextFolder) {
                if (scroller && (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 50)) {
                    const prevScroll = scroller.scrollTop;
                    scroller.scrollBy(0, FOLDER_SEARCH_STEP);
                    await delay(FOLDER_SEARCH_DELAY);
                    if (Math.abs(scroller.scrollTop - prevScroll) < 5) break;
                    continue;
                } else {
                    console.log(`${indent}✔️ Папок больше нет.`);
                    break;
                }
            }

            visitedFolderKeys.add(nextFolder.key);
            updateStatus(`Вход: ${nextFolder.name}`);
            console.log(`${indent}➡️ Вход: "${nextFolder.name}"`);

            try { nextFolder.element.style.outline = '3px solid #28a745'; } catch (e) {}

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
        if(searchBtn) searchBtn.disabled = true;

        console.clear();
        console.log('🚀 START DEEP INDEXING (Fast Folder Search)');

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
            if(searchBtn) searchBtn.disabled = false;
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
})();