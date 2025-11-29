// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v2.7 Dark UI + DragDrop + Fixes)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      2.7
// @author       Alex Tol
// @description  Индексатор MEGA + Поиск (Drag&Drop Fix, Text Select Fix, Search Fix)
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

    // Инъекция стилей
    const style = document.createElement('style');
    style.textContent = `
        .mega-indexer-modal {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 600px; max-height: 85vh;
            background: #1c1c1e; color: #e0e0e0;
            z-index: 10000; padding: 0; border-radius: 12px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.7);
            font-family: 'Source Sans Pro', 'Segoe UI', sans-serif;
            display: flex; flex-direction: column;
            border: 1px solid #333;
            user-select: text !important; /* РАЗРЕШАЕМ ВЫДЕЛЕНИЕ */
            cursor: auto;
        }
        .mega-indexer-header {
            padding: 15px 20px; border-bottom: 1px solid #333;
            display: flex; justify-content: space-between; align-items: center;
            background: #252527; border-radius: 12px 12px 0 0;
            user-select: none;
        }
        .mega-indexer-title { font-size: 18px; font-weight: 600; margin: 0; color: #fff; }
        .mega-indexer-close {
            cursor: pointer; font-size: 20px; color: #aaa; transition: 0.2s;
            width: 30px; height: 30px; text-align: center; line-height: 30px;
        }
        .mega-indexer-close:hover { color: #fff; background: #d9534f; border-radius: 50%; }

        .mega-indexer-body {
            padding: 20px; overflow-y: auto; flex-grow: 1;
            scrollbar-width: thin; scrollbar-color: #444 #1c1c1e;
        }
        .mega-indexer-body::-webkit-scrollbar { width: 8px; }
        .mega-indexer-body::-webkit-scrollbar-track { background: #1c1c1e; }
        .mega-indexer-body::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }

        .mega-file-input-label {
            display: block; padding: 20px; background: #2a2a2c; border: 2px dashed #444;
            text-align: center; border-radius: 8px; cursor: pointer; transition: 0.2s;
            color: #aaa; margin-bottom: 20px;
        }
        .mega-file-input-label:hover, .mega-file-input-label.drag-over {
            border-color: #6f42c1; color: #fff; background: #333;
            box-shadow: 0 0 10px rgba(111, 66, 193, 0.3);
        }

        .search-result-item {
            background: #252527; padding: 12px; margin-bottom: 10px;
            border-radius: 8px; border: 1px solid #333;
            display: flex; gap: 15px; align-items: flex-start;
            cursor: text; /* Курсор текста */
        }
        .search-result-info { flex-grow: 1; overflow: hidden; }
        .search-result-name { font-size: 15px; color: #fff; font-weight: 500; margin-bottom: 4px; word-break: break-all; }
        .search-result-path { font-size: 12px; color: #888; margin-bottom: 8px; font-family: monospace; word-break: break-all; }
        .search-result-meta { font-size: 12px; display: flex; gap: 15px; align-items: center; user-select: none; }

        .sim-badge { padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px; }
        .sim-high { background: rgba(40, 167, 69, 0.2); color: #4cd964; }
        .sim-med { background: rgba(253, 126, 20, 0.2); color: #ff9f43; }
        .sim-low { background: rgba(220, 53, 69, 0.2); color: #ff5252; }

        .btn-find-mega {
            background: #007bff; color: white; border: none; padding: 5px 10px;
            border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s;
        }
        .btn-find-mega:hover { background: #0056b3; }
    `;
    document.head.appendChild(style);

    console.log('🕷️📷 Mega.nz Deep Indexer v2.7 Loaded.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================
    let uiBtn = null;
    let searchBtn = null;
    let cancelBtn = null;
    let statusDiv = null;
    let searchPanel = null;

    function createUI(initialCount) {
        if (!uiBtn) {
            uiBtn = document.createElement('button');
            updateButtonText(initialCount);
            uiBtn.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; z-index: 9999;
                padding: 12px 18px; background-color: #6f42c1; color: white;
                border: none; border-radius: 8px; cursor: pointer; font-weight: bold;
                font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', sans-serif;
            `;
            uiBtn.onclick = startDeepIndexing;
            document.body.appendChild(uiBtn);
        }
        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.cssText = `
                position: fixed; bottom: 20px; right: 265px; z-index: 9999;
                padding: 12px 18px; background-color: #007bff; color: white;
                border: none; border-radius: 8px; cursor: pointer; font-weight: bold;
                font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', sans-serif;
            `;
            searchBtn.onclick = toggleSearchUI;
            document.body.appendChild(searchBtn);
        }
        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Stop';
            cancelBtn.style.cssText = `
                position: fixed; bottom: 75px; right: 20px; z-index: 9999;
                padding: 6px 12px; background-color: #d9534f; color: white;
                border: none; border-radius: 6px; cursor: pointer; font-weight: bold;
                font-size: 11px; box-shadow: 0 2px 5px rgba(0,0,0,0.4); opacity: 0.5;
            `;
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => {
                if (!isRunning || cancelRequested) return;
                cancelRequested = true;
                cancelBtn.innerText = 'Stopping...';
            };
            document.body.appendChild(cancelBtn);
        }
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = `
                position: fixed; bottom: 110px; right: 20px; z-index: 9999;
                padding: 5px 10px; background-color: rgba(0,0,0,0.8); color: #0f0;
                border-radius: 4px; font-size: 10px; font-family: monospace;
                max-width: 250px; display: none; pointer-events: none;
            `;
            document.body.appendChild(statusDiv);
        }
    }

    // === SEARCH UI PANEL (Enhanced) ===
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }

        searchPanel = document.createElement('div');
        searchPanel.className = 'mega-indexer-modal';

        // ВАЖНО: Предотвращаем всплытие событий мыши, чтобы Mega не сбрасывала выделение
        searchPanel.onmousedown = (e) => e.stopPropagation();
        searchPanel.onmouseup = (e) => e.stopPropagation();
        searchPanel.onclick = (e) => e.stopPropagation();

        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Image Reverse Search</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <label class="mega-file-input-label" id="megaDropZone">
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span>📁 Click to Upload or <b>Drag & Drop</b> Image Here</span>
                </label>

                <div id="megaSearchPreview" style="text-align: center; margin-bottom: 20px; display:none;">
                    <div style="font-size: 12px; color: #888; margin-bottom: 5px;">Source Image:</div>
                    <img id="previewImg" style="max-width: 120px; max-height: 120px; border-radius: 6px; border: 2px solid #444;">
                </div>

                <div id="megaSearchResults">
                    <div style="text-align:center; color: #666; padding: 20px;">
                        Waiting for image...
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(searchPanel);

        // Elements
        const closeBtn = document.getElementById('btnSearchClose');
        const fileInput = document.getElementById('megaSearchInput');
        const dropZone = document.getElementById('megaDropZone');

        // Events
        closeBtn.onclick = () => searchPanel.style.display = 'none';
        fileInput.addEventListener('change', (e) => processFile(e.target.files[0]));

        // === DRAG AND DROP LOGIC ===
        // Мы должны предотвратить всплытие, чтобы Mega не открыла файл сама
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'), false);
        dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'), false);
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'), false);

        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('drag-over');
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files && files.length > 0) {
                processFile(files[0]);
            }
        }, false);
    }

    async function processFile(file) {
        if (!file) return;

        const resultsDiv = document.getElementById('megaSearchResults');
        const previewDiv = document.getElementById('megaSearchPreview');
        const previewImg = document.getElementById('previewImg');

        // 1. Очищаем предыдущий ObjectURL (Fix Preview)
        if (previewImg.src) {
            URL.revokeObjectURL(previewImg.src);
        }

        resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Analyzing image...</div>';

        // 2. Создаем новый URL
        const imgUrl = URL.createObjectURL(file);
        previewImg.src = imgUrl;
        previewDiv.style.display = 'block';

        // Пауза для рендера UI
        await new Promise(r => setTimeout(r, 100));

        try {
            // Хэш
            const tempImg = new Image();
            tempImg.src = imgUrl;
            await new Promise(resolve => tempImg.onload = resolve);

            const searchHash = await getImageHash(tempImg);

            // Поиск
            resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Searching database...</div>';
            const matches = await searchInDB(searchHash);

            // Рендер
            if (matches.length === 0) {
                resultsDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#d9534f;">❌ No matches found.</div>';
            } else {
                let html = '';
                matches.forEach((m, idx) => {
                    const maxDist = 1024;
                    let similarity = ((maxDist - m.dist) / maxDist) * 100;
                    similarity = Math.max(0, similarity).toFixed(1);

                    let simClass = 'sim-low';
                    if (similarity > 95) simClass = 'sim-high';
                    else if (similarity > 80) simClass = 'sim-med';

                    html += `
                        <div class="search-result-item">
                            <div style="font-size: 24px;">🖼️</div>
                            <div class="search-result-info">
                                <div class="search-result-name">${m.name}</div>
                                <div class="search-result-path">${m.path}</div>
                                <div class="search-result-meta">
                                    <span class="sim-badge ${simClass}">Match: ${similarity}%</span>
                                    <button class="btn-find-mega" data-filename="${m.name.replace(/"/g, '&quot;')}">🔍 Найти в Mega</button>
                                </div>
                            </div>
                        </div>
                    `;
                });
                resultsDiv.innerHTML = html;

                // Обработчики кнопок
                const findButtons = resultsDiv.querySelectorAll('.btn-find-mega');
                findButtons.forEach(btn => {
                    btn.onclick = function() {
                        const name = this.getAttribute('data-filename');
                        triggerMegaSearch(name);
                    };
                });
            }
        } catch (e) {
            console.error(e);
            resultsDiv.innerHTML = `<div style="color:red; padding:10px;">Error: ${e.message}</div>`;
        }
    }

    // === MEGA SEARCH TRIGGER (Fix based on DOM) ===
    function triggerMegaSearch(filename) {
        console.log(`🤖 Auto-searching for: ${filename}`);

        // 1. Пытаемся найти input по классу, который ты дал
        let input = document.querySelector('.js-filesearcher');

        // Если не нашли, ищем запасные варианты
        if (!input) input = document.querySelector('input[placeholder*="Поиск"]');
        if (!input) input = document.querySelector('input[name="search"]');

        if (input) {
            if(searchPanel) searchPanel.style.display = 'none';

            // Эмуляция React ввода (важно, иначе поле визуально заполнится, но поиск не сработает)
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            nativeInputValueSetter.call(input, filename);

            // Отправляем события
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();

            // Эмуляция нажатия Enter
            setTimeout(() => {
                const enterEvent = new KeyboardEvent('keydown', {
                    bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
                });
                input.dispatchEvent(enterEvent);

                // Иногда нужно и keyup
                input.dispatchEvent(new KeyboardEvent('keyup', {
                    bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
                }));

            }, 200);

            updateStatus('Запущен поиск в Mega...');
        } else {
            alert('Ошибка: Поле поиска Mega не найдено. Попробуйте обновить страницу.');
        }
    }

    // === SEARCH LOGIC ===
    async function searchInDB(targetHash) {
        const keys = await GM.listValues();
        const results = [];
        for (let key of keys) {
            if (!key.startsWith(DB_PREFIX)) continue;
            const record = await GM.getValue(key);
            if (!record || !record.hash) continue;
            const dist = calculateHammingDistance(targetHash, record.hash);
            if (dist < 300) results.push({ ...record, dist });
        }
        results.sort((a, b) => a.dist - b.dist);
        return results.slice(0, 5);
    }
    function calculateHammingDistance(hex1, hex2) {
        if (hex1.length !== hex2.length) return 1024;
        let distance = 0;
        for (let i = 0; i < hex1.length; i++) {
            let xor = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
            while (xor) { distance += xor & 1; xor >>= 1; }
        }
        return distance;
    }

    // === DB & HASHING UTILS ===
    function updateButtonText(count) { if (uiBtn) uiBtn.innerText = `📷 Scan All Folders (DB: ${count})`; }
    function updateStatus(text) {
        if (statusDiv) { statusDiv.innerText = text; statusDiv.style.display = text ? 'block' : 'none'; }
    }
    async function getDBCount() {
        try { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; } catch (e) { return 0; }
    }
    async function addFileToDB(fileData) {
        try { await GM.setValue(DB_PREFIX + fileData.nodeId, fileData); } catch (e) {}
    }
    async function checkFileExists(nodeId) {
        try { return !!(await GM.getValue(DB_PREFIX + nodeId)); } catch (e) { return false; }
    }
    function getImageHash(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                if (!imgElement || (imgElement.naturalWidth < 10 && imgElement.width < 10)) return reject("Too small");
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

    // === SCANNER CORE ===
    async function scanCurrentFolder(label = "CURRENT") {
        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) return 0;
        scroller.scrollTop = 0;
        await delay(1000);
        let processedCount = 0;
        let stuckCounter = 0;
        const processedIDs = new Set();

        while (true) {
            if (cancelRequested) break;
            const images = scroller.querySelectorAll('.fm-item-img img');
            for (let img of images) {
                if (cancelRequested) break;
                try {
                    let fileContainer = img.closest('[id^="th_"]') || img.closest('.mega-item-square') || img.closest('a.mega-node');
                    if (!fileContainer && img.parentElement) fileContainer = img.parentElement.parentElement;
                    let name = 'Unknown';
                    if (fileContainer) {
                        const nameEl = fileContainer.querySelector('.block-view-file-name, .file-name, .fm-item-name');
                        if (nameEl) name = (nameEl.innerText || '').split('\n')[0].trim();
                    }
                    let nodeId = fileContainer?.id?.startsWith('th_') ? fileContainer.id : (fileContainer?.dataset?.nodeId || null);
                    if (!nodeId) nodeId = name.length > 3 ? "name_" + name : "src_" + img.src.slice(-20);
                    if (processedIDs.has(nodeId)) continue;
                    if (await checkFileExists(nodeId)) { processedIDs.add(nodeId); continue; }
                    const hash = await getImageHash(img);
                    await addFileToDB({ nodeId, name, path: getCurrentPath(), hash, timestamp: Date.now() });
                    processedIDs.add(nodeId);
                    processedCount++;
                    updateStatus(`Scan: ${processedCount} new...`);
                } catch (err) {}
            }
            if (cancelRequested) break;
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);
            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) break;
            } else stuckCounter = 0;
        }
        return processedCount;
    }

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
        let path = '';
        document.querySelectorAll('.fm-breadcrumbs').forEach(c => path += '/' + (c.innerText||'').trim());
        return path || '/root';
    }
    function getFolderName(elem) {
        const nameEl = elem.querySelector('.fm-item-name, .tranfer-filetype-txt, .block-view-file-name, .file-name, span.name');
        return nameEl ? (nameEl.innerText || '').trim() : (elem.innerText || '').split('\n')[0].trim();
    }
    function getAllFolderContainers() {
        const result = [];
        const seen = new Set();
        document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder').forEach(node => {
            const container = node.closest('.mega-node, tr.megaListItem, .mega-item-square') || node;
            const name = getFolderName(container);
            if (name && !seen.has(name)) { seen.add(name); result.push({ element: container, name: name }); }
        });
        return result;
    }
    function findNextUnvisitedFolder() {
        for (const f of getAllFolderContainers()) {
            const key = getCurrentPath() + '::' + f.name;
            if (!visitedFolderKeys.has(key)) return { ...f, key };
        }
        return null;
    }

    async function deepScanCurrentFolder(depth = 0, maxDepth = 50) {
        if (cancelRequested || depth > maxDepth) return;
        console.log(`📁 [Level ${depth}] ${getCurrentPath()}`);
        await scanCurrentFolder();
        const scroller = document.querySelector('.file-block-scrolling');
        if (scroller) { scroller.scrollTop = 0; await delay(1000); }
        while (!cancelRequested) {
            const nextFolder = findNextUnvisitedFolder();
            if (!nextFolder) {
                if (scroller && (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 50)) {
                    const prev = scroller.scrollTop;
                    scroller.scrollBy(0, FOLDER_SEARCH_STEP);
                    await delay(FOLDER_SEARCH_DELAY);
                    if (Math.abs(scroller.scrollTop - prev) < 5) break;
                    continue;
                } else break;
            }
            visitedFolderKeys.add(nextFolder.key);
            updateStatus(`>>> ${nextFolder.name}`);
            await delay(500);
            triggerDoubleClick(nextFolder.element);
            await waitForContentChange();
            await deepScanCurrentFolder(depth + 1, maxDepth);
            if (cancelRequested) break;
            goBack();
            await waitForContentChange();
        }
    }

    async function startDeepIndexing() {
        if (isRunning) return;
        isRunning = true; cancelRequested = false; visitedFolderKeys.clear();
        uiBtn.disabled = true; uiBtn.innerText = '⏳ ...'; cancelBtn.disabled = false; cancelBtn.style.opacity = '1'; cancelBtn.innerText = '✖ Stop';
        if(searchBtn) searchBtn.disabled = true;
        try { await deepScanCurrentFolder(0); alert("Done!"); }
        finally {
            isRunning = false; cancelRequested = false; updateStatus('');
            uiBtn.disabled = false; updateButtonText(await getDBCount());
            cancelBtn.disabled = true; cancelBtn.style.opacity = '0.5';
            if(searchBtn) searchBtn.disabled = false;
        }
    }

    async function init() {
        const total = await getDBCount();
        const check = setInterval(() => {
            if (document.querySelector('.file-block-scrolling')) { clearInterval(check); createUI(total); }
        }, 1000);
    }
    init();
})();