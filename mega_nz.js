// ==UserScript==
// @name         Mega.nz Deep Indexer — Unified v5.5 (Flex UI)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      5.5
// @author       Alex Tol (Fixed by Assistant)
// @description  🕷️📷 v5.1 Crawler + v5.2 Matcher. Flexbox UI for buttons. Matches > 70%.
// ==/UserScript==

(function() {
    'use strict';

    // НОВАЯ БД
    const DB_PREFIX = 'MegaSearchDB_v5_Hybrid:';
    let isRunning = false;

    // === НАСТРОЙКИ СКОЛЛИНГА ===
    const FILE_SCROLL_DELAY = 1500;
    const FILE_SCROLL_STEP = 600;
    const FOLDER_SEARCH_DELAY = 200;
    const FOLDER_SEARCH_STEP = 1200;
    const NAVIGATION_DELAY = 3000;
    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    // === НАСТРОЙКИ АЛГОРИТМА ПОИСКА ===
    const GLOBAL_HASH_SIZE = 16;
    const PATCH_GRID = 9;
    const PATCH_HASH_SIZE = 8;
    const PATCH_GOOD_DIST = 10;
    const SIM_THRESHOLD = 0.70;
    const MAX_RESULTS = 20;

    // ==============================================
    // --- STYLES ---
    // ==============================================
    const style = document.createElement('style');
    style.textContent = `
        .mega-indexer-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 650px; max-height: 85vh; background: #181818; color: #e0e0e0; z-index: 10000; padding: 0; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.9); font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; border: 1px solid #333; user-select: text !important; cursor: auto; }
        .mega-indexer-header { padding: 15px 20px; border-bottom: 1px solid #2a2a2a; display: flex; justify-content: space-between; align-items: center; background: #202020; border-radius: 12px 12px 0 0; user-select: none; }
        .mega-indexer-title { font-size: 18px; font-weight: 600; margin: 0; color: #fff; }
        .mega-indexer-close { cursor: pointer; font-size: 20px; color: #888; width: 30px; height: 30px; text-align: center; line-height: 30px; }
        .mega-indexer-close:hover { color: #fff; background: #c0392b; border-radius: 50%; }
        .mega-indexer-body { padding: 20px; overflow-y: auto; flex-grow: 1; scrollbar-width: thin; scrollbar-color: #444 #181818; }

        .mega-file-input-label { display: block; padding: 25px; background: #222; border: 2px dashed #444; text-align: center; border-radius: 8px; cursor: pointer; transition: 0.2s; color: #aaa; margin-bottom: 20px; }
        .mega-file-input-label:hover, .mega-file-input-label.drag-over { border-color: #8e44ad; color: #fff; background: #292929; }

        .search-result-item { background: #222; padding: 10px; margin-bottom: 8px; border-radius: 6px; border: 1px solid #333; display: flex; gap: 12px; align-items: flex-start; }
        .search-result-info { flex-grow: 1; overflow: hidden; }
        .search-result-name { font-size: 14px; color: #fff; font-weight: 600; margin-bottom: 4px; word-break: break-all; }
        .search-result-path { font-size: 11px; color: #888; margin-bottom: 6px; font-family: monospace; word-break: break-all; }
        .search-result-meta { font-size: 11px; display: flex; gap: 10px; align-items: center; user-select: none; flex-wrap: wrap; }

        .sim-badge { padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px; text-transform: uppercase; }
        .sim-exact { background: rgba(46, 204, 113, 0.15); color: #2ecc71; border: 1px solid #2ecc71; }
        .sim-crop  { background: rgba(52, 152, 219, 0.15); color: #3498db; border: 1px solid #3498db; }
        .sim-high  { background: rgba(230, 126, 34, 0.15); color: #e67e22; border: 1px solid #e67e22; }

        .btn-find-mega { background: #2980b9; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: auto; }
        .btn-find-mega:hover { background: #3498db; }

        /* UI Container Styles */
        #mega-indexer-controls {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            display: flex;
            flex-direction: row;
            gap: 10px;
            align-items: center;
            pointer-events: none; /* Allows clicking through gaps */
        }
        #mega-indexer-controls button {
            pointer-events: auto; /* Re-enable clicks on buttons */
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            font-family: 'Segoe UI', sans-serif;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
            padding: 12px 18px;
            transition: transform 0.1s;
        }
        #mega-indexer-controls button:active { transform: scale(0.96); }
    `;
    document.head.appendChild(style);
    console.log('[Mega Unified] v5.5 loaded. Flexbox UI.');

    // ==============================================
    // --- UI ELEMENTS ---
    // ==============================================
    let uiBtn = null;
    let searchBtn = null;
    let cancelBtn = null;
    let statusDiv = null;
    let searchPanel = null;
    let controlsContainer = null;

    function createUI(initialCount) {
        // 1. Create Container
        if (!controlsContainer) {
            controlsContainer = document.createElement('div');
            controlsContainer.id = 'mega-indexer-controls';
            document.body.appendChild(controlsContainer);
        }

        // 2. Create Search Button
        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.backgroundColor = '#007bff';
            searchBtn.style.color = 'white';
            searchBtn.onclick = toggleSearchUI;
            controlsContainer.appendChild(searchBtn);
        }

        // 3. Create Scan Button
        if (!uiBtn) {
            uiBtn = document.createElement('button');
            updateButtonText(initialCount);
            uiBtn.style.backgroundColor = '#6f42c1';
            uiBtn.style.color = 'white';
            uiBtn.onclick = startDeepIndexing;
            controlsContainer.appendChild(uiBtn);
        }

        // 4. Cancel Button (Separate, absolute positioned above)
        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Stop';
            cancelBtn.style.cssText = `
                position: fixed; bottom: 75px; right: 20px; z-index: 9999;
                padding: 6px 12px; background-color: #d9534f; color: white;
                border: none; border-radius: 6px; cursor: pointer;
                font-weight: bold; font-size: 11px; box-shadow: 0 2px 5px rgba(0,0,0,0.4);
                opacity: 0.5;
            `;
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => { if (!isRunning || cancelRequested) return; cancelRequested = true; cancelBtn.innerText = 'Stopping...'; };
            document.body.appendChild(cancelBtn);
        }

        // 5. Status Div
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

    // ========== SEARCH PANEL ==========
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }
        searchPanel = document.createElement('div');
        searchPanel.className = 'mega-indexer-modal';
        ['mousedown', 'mouseup', 'click'].forEach(ev => { searchPanel.addEventListener(ev, e => e.stopPropagation()); });
        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Smart Image Search (>70%)</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <label class="mega-file-input-label" id="megaDropZone">
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span>📁 Click to Upload or <b>Drag & Drop</b> Image</span>
                </label>
                <div id="megaSearchPreview" style="text-align: center; margin-bottom: 20px; display:none;">
                    <img id="previewImg" style="max-width: 150px; max-height: 150px; border-radius: 6px; border: 2px solid #444;">
                </div>
                <div id="megaSearchResults">
                    <div style="text-align:center; color: #666; padding: 20px;">Upload an image to search...</div>
                </div>
            </div>
        `;
        document.body.appendChild(searchPanel);

        const closeBtn = document.getElementById('btnSearchClose');
        const fileInput = document.getElementById('megaSearchInput');
        const dropZone = document.getElementById('megaDropZone');

        closeBtn.onclick = () => searchPanel.style.display = 'none';
        fileInput.addEventListener('change', (e) => processFile(e.target.files[0]));

        ['dragenter','dragover','dragleave','drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
        });
        dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
        dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) processFile(e.dataTransfer.files[0]);
        });
    }

    async function processFile(file) {
        if (!file) return;
        const resultsDiv = document.getElementById('megaSearchResults');
        const previewDiv = document.getElementById('megaSearchPreview');
        const previewImg = document.getElementById('previewImg');

        if (previewImg.src) { try { URL.revokeObjectURL(previewImg.src); } catch(e) {} }
        resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Analyzing...</div>';

        const imgUrl = URL.createObjectURL(file);
        previewImg.src = imgUrl;
        previewDiv.style.display = 'block';
        await delay(50);

        try {
            const tempImg = new Image();
            tempImg.src = imgUrl;
            await new Promise((resolve, reject) => { tempImg.onload = resolve; tempImg.onerror = reject; });

            const queryDesc = await getImageDescriptor(tempImg);
            if (!queryDesc) {
                resultsDiv.innerHTML = '<div style="color:#d9534f; padding:10px;">Image too small.</div>';
                return;
            }

            const matches = await searchInDB(queryDesc);

            if (!matches.length) {
                resultsDiv.innerHTML = `<div style="text-align:center; padding:20px; color:#d9534f;">❌ No matches > 70%.<br><span style="font-size:11px; color:#888;">DB: ${await getDBCount()} items.</span></div>`;
            } else {
                let html = '';
                matches.forEach(m => {
                    const similarity = Math.round(m.finalScore * 100);

                    let badge = '';
                    if (m.matchType === 'Exact') badge = `<span class="sim-badge sim-exact">Exact: ${similarity}%</span>`;
                    else if (m.matchType === 'Crop/Part') badge = `<span class="sim-badge sim-crop">Inside: ${similarity}%</span>`;
                    else badge = `<span class="sim-badge sim-high">High: ${similarity}%</span>`;

                    html += `
                        <div class="search-result-item">
                            <div style="font-size: 24px;">🖼️</div>
                            <div class="search-result-info">
                                <div class="search-result-name">${escapeHtml(m.name)}</div>
                                <div class="search-result-path">${escapeHtml(m.path)}</div>
                                <div class="search-result-meta">
                                    ${badge}
                                    <span style="color:#666; font-size:10px;">Global: ${(m.globalSim*100).toFixed(0)}% | Local: ${(m.localSim*100).toFixed(0)}%</span>
                                    <button class="btn-find-mega" data-filename="${escapeHtml(m.name)}">🔍 Find</button>
                                </div>
                            </div>
                        </div>
                    `;
                });
                resultsDiv.innerHTML = html;
                resultsDiv.querySelectorAll('.btn-find-mega').forEach(btn => {
                    btn.onclick = function() { triggerMegaSearch(this.getAttribute('data-filename')); };
                });
            }
        } catch (e) {
            console.error(e);
            resultsDiv.innerHTML = `<div style="color:red; padding:10px;">Error: ${e.message}</div>`;
        }
    }

    function triggerMegaSearch(filename) {
        let input = document.querySelector('.js-filesearcher') || document.querySelector('input[placeholder*="Поиск"]') || document.querySelector('input[placeholder*="Search"]') || document.querySelector('input[name="search"]');
        if (input) {
            if (searchPanel) searchPanel.style.display = 'none';
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, filename);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
            setTimeout(() => {
                ['keydown', 'keyup'].forEach(type => {
                    input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
                });
            }, 150);
        } else { alert('Search field not found.'); }
    }

    // ==============================================
    // --- MATCHING ENGINE ---
    // ==============================================
    async function searchInDB(queryDesc) {
        const keys = await GM.listValues();
        const results = [];
        const qGlobal = queryDesc.globalHash;
        const qBlocks = queryDesc.blocks;

        for (const key of keys) {
            if (!key.startsWith(DB_PREFIX)) continue;
            const record = await GM.getValue(key);
            if (!record || !record.globalHash || !record.blocks) continue;

            const globalDist = calculateHammingDistance(qGlobal, record.globalHash);
            const globalSim = 1 - (globalDist / (GLOBAL_HASH_SIZE * GLOBAL_HASH_SIZE));

            const localSim = calculateSubsetScore(qBlocks, record.blocks);
            const finalScore = Math.max(globalSim, localSim);

            if (finalScore < SIM_THRESHOLD) continue;

            let matchType = 'High';
            if (globalSim > 0.85) matchType = 'Exact';
            else if (localSim >= 0.70) matchType = 'Crop/Part';

            results.push({ ...record, globalSim, localSim, finalScore, matchType });
        }
        results.sort((a, b) => b.finalScore - a.finalScore);
        return results.slice(0, MAX_RESULTS);
    }

    function calculateSubsetScore(blocksA, blocksB) {
        if (!blocksA.length || !blocksB.length) return 0;
        let strongMatches = 0;
        for (const hashA of blocksA) {
            let bestDist = 64;
            for (const hashB of blocksB) {
                const d = calculateHammingDistance(hashA, hashB);
                if (d < bestDist) bestDist = d;
                if (bestDist === 0) break;
            }
            if (bestDist <= PATCH_GOOD_DIST) strongMatches++;
        }
        return strongMatches / blocksA.length;
    }

    function calculateHammingDistance(hex1, hex2) {
        if (!hex1 || !hex2) return 256;
        let d = 0;
        for (let i = 0; i < hex1.length; i++) {
            let xor = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
            while (xor) { d += xor & 1; xor >>= 1; }
        }
        return d;
    }

    // ==============================================
    // --- HASHING ---
    // ==============================================
    async function getImageDescriptor(img) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h || w < 32 || h < 32) return null;

        const globalHash = computeHash(img, 0, 0, w, h, GLOBAL_HASH_SIZE, 1);

        const blocks = [];
        const grid = PATCH_GRID;
        const tileW = w / grid;
        const tileH = h / grid;
        for (let gy = 0; gy < grid; gy++) {
            for (let gx = 0; gx < grid; gx++) {
                blocks.push(computeHash(img, gx * tileW, gy * tileH, tileW, tileH, PATCH_HASH_SIZE, 0.5));
            }
        }
        return { globalHash, blocks };
    }

    function computeHash(img, sx, sy, sw, sh, size, blur) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = size + 1; canvas.height = size;
        ctx.filter = `grayscale(100%) blur(${blur}px)`;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let bits = '';
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = (y * (size + 1) + x) * 4;
                const j = (y * (size + 1) + (x + 1)) * 4;
                bits += (data[i] > data[j]) ? '1' : '0';
            }
        }
        return binToHex(bits);
    }

    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            hex += parseInt(bin.substring(i, i + 4), 2).toString(16);
        }
        return hex;
    }

    // ==============================================
    // --- DATABASE & UTILS ---
    // ==============================================
    function updateButtonText(count) { if (uiBtn) uiBtn.innerText = `📷 Scan Folders (DB: ${count})`; }
    function updateStatus(text) { if (statusDiv) { statusDiv.innerText = text; statusDiv.style.display = text ? 'block' : 'none'; } }
    async function getDBCount() { try { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; } catch (e) { return 0; } }
    async function addFileToDB(fileData) { try { await GM.setValue(DB_PREFIX + fileData.nodeId, fileData); } catch (e) {} }
    async function checkFileExists(nodeId) { try { return !!(await GM.getValue(DB_PREFIX + nodeId)); } catch (e) { return false; } }
    function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ==============================================
    // --- CRAWLER CORE ---
    // ==============================================
    function getCurrentPath() {
        let path = '';
        document.querySelectorAll('.fm-breadcrumbs').forEach(c => { path += '/' + (c.innerText || '').trim(); });
        return path || '/root';
    }

    async function scanCurrentFolder() {
        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) return 0;
        scroller.scrollTop = 0;
        await delay(1000);

        let processedCount = 0;
        let stuckCounter = 0;
        const processedIDs = new Set();

        while (!cancelRequested) {
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
                    if (!nodeId) nodeId = name.length > 3 ? 'name_' + name : 'src_' + img.src.slice(-20);

                    if (processedIDs.has(nodeId)) continue;
                    if (await checkFileExists(nodeId)) { processedIDs.add(nodeId); continue; }
                    if (!img.complete || img.naturalWidth === 0) continue;

                    const desc = await getImageDescriptor(img);
                    if (!desc) { processedIDs.add(nodeId); continue; }

                    await addFileToDB({ nodeId, name, path: getCurrentPath(), globalHash: desc.globalHash, blocks: desc.blocks, timestamp: Date.now() });
                    processedIDs.add(nodeId);
                    processedCount++;
                    updateStatus(`Indexed: ${processedCount}`);
                } catch (err) { console.error(err); }
            }

            if (cancelRequested) break;
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);

            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) {
                stuckCounter++;
                if (stuckCounter >= 2) break;
            } else { stuckCounter = 0; }
        }
        return processedCount;
    }

    function triggerDoubleClick(element) {
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: unsafeWindow }));
    }

    function goBack() {
        const crumbs = document.querySelectorAll('.fm-breadcrumbs');
        if (crumbs.length >= 2) {
            crumbs[crumbs.length - 2].click();
            return true;
        }
        return false;
    }

    function waitForContentChange() { return delay(NAVIGATION_DELAY); }

    function getFolderName(elem) {
        const nameEl = elem.querySelector('.fm-item-name, .tranfer-filetype-txt, .block-view-file-name, .file-name, span.name');
        return nameEl ? (nameEl.innerText || '').trim() : (elem.innerText || '').split('\n')[0].trim();
    }

    function getAllFolderContainers() {
        const result = [];
        const seen = new Set();
        document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder')
            .forEach(node => {
                const container = node.closest('.mega-node, tr.megaListItem, .mega-item-square') || node;
                const name = getFolderName(container);
                if (name && !seen.has(name)) { seen.add(name); result.push({ element: container, name }); }
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
        console.log(`[Mega Unified] 📁 [Level ${depth}] ${getCurrentPath()}`);

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
                } else { break; }
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
        isRunning = true;
        cancelRequested = false;
        visitedFolderKeys.clear();
        uiBtn.disabled = true;
        uiBtn.innerText = '⏳ Scanning...';
        cancelBtn.disabled = false;
        cancelBtn.style.opacity = '1';
        cancelBtn.innerText = '✖ Stop';
        if (searchBtn) searchBtn.disabled = true;

        try {
            updateStatus('Starting hybrid indexer...');
            await deepScanCurrentFolder(0);
            alert('✅ Indexing complete!');
        } catch (e) {
            console.error(e);
            alert('Error: ' + e.message);
        } finally {
            isRunning = false;
            cancelRequested = false;
            updateStatus('');
            uiBtn.disabled = false;
            updateButtonText(await getDBCount());
            cancelBtn.disabled = true;
            cancelBtn.style.opacity = '0.5';
            if (searchBtn) searchBtn.disabled = false;
        }
    }

    const check = setInterval(async () => {
        if (document.querySelector('.file-block-scrolling')) {
            clearInterval(check);
            createUI(await getDBCount());
        }
    }, 1000);
})();