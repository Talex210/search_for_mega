// ==UserScript==
// @name         Mega.nz Deep Indexer (Spider+Crawler Unified v2.5 Dark UI + Smart Search)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      2.5
// @author       Alex Tol
// @description  Индексатор MEGA + Продвинутый поиск (Dark Mode, % Similarity, Auto-Search)
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

    // Инъекция стилей для Dark Mode
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
        }
        .mega-indexer-header {
            padding: 15px 20px; border-bottom: 1px solid #333;
            display: flex; justify-content: space-between; align-items: center;
            background: #252527; border-radius: 12px 12px 0 0;
        }
        .mega-indexer-title { font-size: 18px; font-weight: 600; margin: 0; color: #fff; }
        .mega-indexer-close {
            cursor: pointer; font-size: 20px; color: #aaa; transition: 0.2s;
            width: 30px; height: 30px; text-align: center; line-height: 30px;
        }
        .mega-indexer-close:hover { color: #fff; background: #d9534f; border-radius: 50%; }
        
        .mega-indexer-body {
            padding: 20px; overflow-y: auto; flex-grow: 1;
            /* Custom Scrollbar */
            scrollbar-width: thin; scrollbar-color: #444 #1c1c1e;
        }
        .mega-indexer-body::-webkit-scrollbar { width: 8px; }
        .mega-indexer-body::-webkit-scrollbar-track { background: #1c1c1e; }
        .mega-indexer-body::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .mega-indexer-body::-webkit-scrollbar-thumb:hover { background: #555; }

        .mega-file-input-label {
            display: block; padding: 15px; background: #2a2a2c; border: 2px dashed #444;
            text-align: center; border-radius: 8px; cursor: pointer; transition: 0.2s;
            color: #aaa; margin-bottom: 20px;
        }
        .mega-file-input-label:hover { border-color: #6f42c1; color: #fff; background: #333; }
        
        .search-result-item {
            background: #252527; padding: 12px; margin-bottom: 10px;
            border-radius: 8px; border: 1px solid #333;
            display: flex; gap: 15px; align-items: flex-start;
            user-select: text; /* Позволяет выделять текст */
        }
        .search-result-info { flex-grow: 1; overflow: hidden; }
        .search-result-name { font-size: 15px; color: #fff; font-weight: 500; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .search-result-path { font-size: 12px; color: #888; margin-bottom: 8px; font-family: monospace; }
        .search-result-meta { font-size: 12px; display: flex; gap: 15px; align-items: center; }
        
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

    console.log('🕷️📷 Mega.nz Deep Indexer v2.5 Loaded.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================
    let uiBtn = null;
    let searchBtn = null;
    let cancelBtn = null;
    let statusDiv = null;
    let searchPanel = null;

    function createUI(initialCount) {
        // Кнопка Сканирования
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

        // Кнопка Поиска
        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.cssText = `
                position: fixed; bottom: 20px; right: 255px; z-index: 9999;
                padding: 12px 18px; background-color: #007bff; color: white;
                border: none; border-radius: 8px; cursor: pointer; font-weight: bold;
                font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', sans-serif;
            `;
            searchBtn.onclick = toggleSearchUI;
            document.body.appendChild(searchBtn);
        }

        // Кнопка Отмены
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

        // Статус
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

    // === SEARCH UI PANEL (Dark Mode) ===
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }

        searchPanel = document.createElement('div');
        searchPanel.className = 'mega-indexer-modal';
        
        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Image Reverse Search</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <label class="mega-file-input-label">
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span>📁 Click to Upload Image or Drag & Drop</span>
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

        // События
        document.getElementById('btnSearchClose').onclick = () => searchPanel.style.display = 'none';
        document.getElementById('megaSearchInput').addEventListener('change', handleFileSelect);
    }

    async function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const resultsDiv = document.getElementById('megaSearchResults');
        const previewDiv = document.getElementById('megaSearchPreview');
        const previewImg = document.getElementById('previewImg');

        resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Analyzing image...</div>';
        
        // Превью
        const imgUrl = URL.createObjectURL(file);
        previewImg.src = imgUrl;
        previewDiv.style.display = 'block';

        await new Promise(r => setTimeout(r, 100)); // Пауза для рендера

        try {
            // 1. Хэш входного файла
            const tempImg = new Image();
            tempImg.src = imgUrl;
            await new Promise(resolve => tempImg.onload = resolve);
            
            const searchHash = await getImageHash(tempImg);
            
            // 2. Поиск
            resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Searching database...</div>';
            const matches = await searchInDB(searchHash);

            // 3. Рендер результатов
            if (matches.length === 0) {
                resultsDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#d9534f;">❌ No matches found.</div>';
            } else {
                let html = '';
                matches.forEach((m, idx) => {
                    // Расчет процентов
                    // Максимальное расстояние = 32*32 = 1024.
                    // Процент сходства = (1024 - dist) / 1024 * 100
                    const maxDist = 1024;
                    let similarity = ((maxDist - m.dist) / maxDist) * 100;
                    similarity = Math.max(0, similarity).toFixed(1); // Округляем до 1 знака

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

                // Навешиваем события на кнопки "Найти"
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

    // === АВТО-ПОИСК В MEGA ===
    function triggerMegaSearch(filename) {
        console.log(`🤖 Auto-searching for: ${filename}`);
        
        // Пытаемся найти поле ввода поиска Mega (селекторы могут меняться, пробуем разные)
        // Обычно это input внутри .search-wrapper или .top-search
        const selectors = [
            'input[name="search"]', 
            '.search-bar input', 
            '.top-head .search-wrapper input',
            'input[placeholder*="Search"]',
            'input[placeholder*="Поиск"]'
        ];
        
        let input = null;
        for(let sel of selectors) {
            input = document.querySelector(sel);
            if(input) break;
        }

        if (input) {
            // Вставка значения и триггер событий (React требует событий)
            // Скрываем наше окно, чтобы было видно результат
            if(searchPanel) searchPanel.style.display = 'none';
            
            // Эмуляция ввода
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            nativeInputValueSetter.call(input, filename);
            
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            
            // Эмуляция нажатия Enter
            setTimeout(() => {
                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', charCode: 13 }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', charCode: 13 }));
                
                // Если есть кнопка лупы рядом, кликаем её
                const searchBtn = input.parentElement.querySelector('button, i.sprite-fm-mono-search');
                if(searchBtn) searchBtn.click();
                
            }, 200);
            
            updateStatus('Запущен поиск в Mega...');
        } else {
            alert('Не удалось найти поле поиска Mega. Попробуйте скопировать имя файла вручную.');
        }
    }

    // === SEARCH LOGIC (HAMMING) ===
    async function searchInDB(targetHash) {
        const keys = await GM.listValues();
        const results = [];
        
        for (let key of keys) {
            if (!key.startsWith(DB_PREFIX)) continue;
            
            const record = await GM.getValue(key);
            if (!record || !record.hash) continue;

            const dist = calculateHammingDistance(targetHash, record.hash);
            
            // Оставляем только более-менее похожие (dist < 300 из 1024)
            if (dist < 300) { 
                results.push({ ...record, dist });
            }
        }

        // Сортируем: меньше дистанция = больше %
        results.sort((a, b) => a.dist - b.dist);
        return results.slice(0, 5);
    }

    function calculateHammingDistance(hex1, hex2) {
        if (hex1.length !== hex2.length) return 1024; 
        let distance = 0;
        for (let i = 0; i < hex1.length; i++) {
            const val1 = parseInt(hex1[i], 16);
            const val2 = parseInt(hex2[i], 16);
            let xor = val1 ^ val2;
            while (xor) { distance += xor & 1; xor >>= 1; }
        }
        return distance;
    }

    // ==============================================
    // --- DB & HASHING UTILS ---
    // ==============================================
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

    // ==============================================
    // --- SCANNER CORE ---
    // ==============================================
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