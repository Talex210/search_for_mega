// ==UserScript==
// @name         Mega.nz Deep Indexer — Unified v8.1 (UI Polish)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      8.1
// @author       Alex Tol (UI Polish by Assistant)
// @description  🕷️📷 Web Worker Search + Symmetrical UI + No Scrolling bugs.
// ==/UserScript==

(function() {
    'use strict';

    // === CONFIG ===
    const DB_PREFIX = 'MegaSearchDB_v5_Hybrid:';
    let isRunning = false;

    // GLOBAL RAM CACHE
    let RAM_DB = null;
    let searchWorker = null;

    // Crawler Settings
    const FILE_SCROLL_DELAY = 1500;
    const FILE_SCROLL_STEP = 600;
    const FOLDER_SEARCH_DELAY = 200;
    const FOLDER_SEARCH_STEP = 1200;
    const NAVIGATION_DELAY = 3000;
    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    // Matcher Settings
    const CONFIG = {
        GLOBAL_HASH_SIZE: 16,
        PATCH_GRID: 9,
        PATCH_HASH_SIZE: 8,
        PATCH_GOOD_DIST: 10,
        SIM_THRESHOLD: 0.70,
        MAX_RESULTS: 20
    };

    // ==============================================
    // --- WEB WORKER CODE ---
    // ==============================================
    const WORKER_CODE = `
    self.onmessage = function(e) {
        const { type, payload } = e.data;

        if (type === 'SEARCH') {
            const { db, query, config } = payload;
            const results = [];
            const qGlobal = query.globalHash;
            const qBlocks = query.blocks;
            const total = db.length;

            function getDist(h1, h2) {
                if(!h1 || !h2) return 256;
                let d = 0;
                for(let i=0; i<h1.length; i++) {
                    let x = parseInt(h1[i],16) ^ parseInt(h2[i],16);
                    while(x) { d+=x&1; x>>=1; }
                }
                return d;
            }

            for (let i = 0; i < total; i++) {
                const record = db[i];
                if (!record.globalHash || !record.blocks) continue;

                const gDist = getDist(qGlobal, record.globalHash);
                const gSim = 1 - (gDist / (config.GLOBAL_HASH_SIZE * config.GLOBAL_HASH_SIZE));

                let strongMatches = 0;
                const blocksA = qBlocks;
                const blocksB = record.blocks;

                if (blocksA.length && blocksB.length) {
                    for (let a = 0; a < blocksA.length; a++) {
                        let best = 64;
                        for (let b = 0; b < blocksB.length; b++) {
                            const d = getDist(blocksA[a], blocksB[b]);
                            if (d < best) best = d;
                            if (best === 0) break;
                        }
                        if (best <= config.PATCH_GOOD_DIST) strongMatches++;
                    }
                }
                const lSim = blocksA.length ? (strongMatches / blocksA.length) : 0;

                const finalScore = Math.max(gSim, lSim);

                if (finalScore >= config.SIM_THRESHOLD) {
                    let matchType = 'High';
                    if (gSim > 0.85) matchType = 'Exact';
                    else if (lSim >= 0.70) matchType = 'Crop/Part';

                    results.push({
                        name: record.name,
                        path: record.path,
                        nodeId: record.nodeId,
                        globalSim: gSim,
                        localSim: lSim,
                        finalScore: finalScore,
                        matchType: matchType
                    });
                }

                if (i % 1000 === 0) {
                    self.postMessage({ type: 'PROGRESS', loaded: i, total: total });
                }
            }

            results.sort((a, b) => b.finalScore - a.finalScore);
            const top = results.slice(0, config.MAX_RESULTS);
            self.postMessage({ type: 'DONE', results: top });
        }
    };
    `;

    function initWorker() {
        if (searchWorker) return;
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        searchWorker = new Worker(URL.createObjectURL(blob));
    }

    // ==============================================
    // --- STYLES (FIXED LAYOUT) ---
    // ==============================================
    const style = document.createElement('style');
    style.textContent = `
        /* Modal Base */
        .mega-indexer-modal {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 600px; max-height: 85vh;
            background: #181818; color: #e0e0e0; z-index: 10000; padding: 0;
            border-radius: 12px; box-shadow: 0 25px 80px rgba(0,0,0,0.95);
            font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column;
            border: 1px solid #333; user-select: text !important; cursor: auto;
            box-sizing: border-box;
        }
        .mega-indexer-header {
            padding: 15px 20px; border-bottom: 1px solid #2a2a2a;
            display: flex; justify-content: space-between; align-items: center;
            background: #202020; border-radius: 12px 12px 0 0; user-select: none;
        }
        .mega-indexer-title { font-size: 18px; font-weight: 600; margin: 0; color: #fff; }
        .mega-indexer-close { cursor: pointer; font-size: 20px; color: #888; width: 30px; height: 30px; text-align: center; line-height: 30px; transition: 0.2s; }
        .mega-indexer-close:hover { color: #fff; background: #c0392b; border-radius: 50%; }

        /* Body & Scroll Fixes */
        .mega-indexer-body {
            padding: 20px;
            overflow-y: auto;
            overflow-x: hidden;
            flex-grow: 1;
            scrollbar-width: thin;
            scrollbar-color: #444 #181818;
            display: flex;
            flex-direction: column;
            gap: 15px; /* Uniform spacing between elements */
            box-sizing: border-box;
        }

        /* Progress Bar (Centered) */
        .progress-container {
            width: 100%; background-color: #333; border-radius: 10px;
            height: 24px; overflow: hidden; display: none; position: relative;
            box-sizing: border-box;
        }
        .progress-bar { height: 100%; background-color: #28a745; width: 0%; transition: width 0.1s; }
        .progress-text {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            display: flex; align-items: center; justify-content: center;
            font-size: 11px; font-weight: bold; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.8);
        }

        /* Inputs */
        .mega-file-input-label {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            padding: 30px; background: #222; border: 2px dashed #444;
            border-radius: 8px; cursor: pointer; transition: 0.2s; color: #aaa;
            width: 100%; box-sizing: border-box;
        }
        .mega-file-input-label:hover, .mega-file-input-label.drag-over { border-color: #8e44ad; color: #fff; background: #292929; }

        /* Buttons */
        .mega-btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px; color: white; transition: 0.2s; display: inline-block; margin-right: 10px; }
        .btn-primary { background: #007bff; } .btn-primary:hover { background: #0056b3; }
        .btn-success { background: #28a745; } .btn-success:hover { background: #218838; }
        .btn-danger  { background: #dc3545; } .btn-danger:hover  { background: #c82333; }

        /* Results (Symmetrical) */
        .search-result-item {
            background: #222; padding: 12px; border-radius: 8px;
            border: 1px solid #333; display: flex; gap: 15px; align-items: flex-start;
            width: 100%; box-sizing: border-box;
        }
        .search-result-info { flex-grow: 1; overflow: hidden; }
        .search-result-name { font-size: 14px; color: #fff; font-weight: 600; margin-bottom: 4px; word-break: break-all; }
        .search-result-path { font-size: 11px; color: #888; margin-bottom: 8px; font-family: monospace; word-break: break-all; }
        .search-result-meta { font-size: 11px; display: flex; gap: 10px; align-items: center; user-select: none; flex-wrap: wrap; }

        .sim-badge { padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 10px; text-transform: uppercase; }
        .sim-exact { background: rgba(46, 204, 113, 0.15); color: #2ecc71; border: 1px solid #2ecc71; }
        .sim-crop  { background: rgba(52, 152, 219, 0.15); color: #3498db; border: 1px solid #3498db; }
        .sim-high  { background: rgba(230, 126, 34, 0.15); color: #e67e22; border: 1px solid #e67e22; }

        .btn-find-mega { background: #2980b9; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: auto; }
        .btn-find-mega:hover { background: #3498db; }

        /* Controls */
        #mega-indexer-controls { position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: row; gap: 10px; align-items: center; pointer-events: none; }
        #mega-indexer-controls button { pointer-events: auto; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-family: 'Segoe UI', sans-serif; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; padding: 12px 18px; transition: transform 0.1s; }
        #mega-indexer-controls button:active { transform: scale(0.96); }

        /* DB Manager */
        .db-stat-box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid #333; text-align: center; width: 100%; box-sizing: border-box; }
        .db-stat-number { font-size: 24px; color: #2ecc71; font-weight: bold; }
        .db-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; width: 100%; }
        .import-status { margin-top: 10px; color: #aaa; font-size: 12px; text-align: center; }
    `;
    document.head.appendChild(style);
    console.log('[Mega Unified] v8.1 loaded. UI Polished.');

    // ==============================================
    // --- UI ELEMENTS ---
    // ==============================================
    let uiBtn, searchBtn, dbBtn, cancelBtn, statusDiv, searchPanel, dbPanel, controlsContainer;
    let progressBar, progressText, progressContainer;

    function createUI(initialCount) {
        if (!controlsContainer) {
            controlsContainer = document.createElement('div');
            controlsContainer.id = 'mega-indexer-controls';
            document.body.appendChild(controlsContainer);
        }

        if (!dbBtn) {
            dbBtn = document.createElement('button');
            dbBtn.innerText = '💾 DB';
            dbBtn.style.backgroundColor = '#28a745';
            dbBtn.style.color = 'white';
            dbBtn.onclick = toggleDBUI;
            controlsContainer.appendChild(dbBtn);
        }

        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.backgroundColor = '#007bff';
            searchBtn.style.color = 'white';
            searchBtn.onclick = toggleSearchUI;
            controlsContainer.appendChild(searchBtn);
        }

        if (!uiBtn) {
            uiBtn = document.createElement('button');
            updateButtonText(initialCount);
            uiBtn.style.backgroundColor = '#6f42c1';
            uiBtn.style.color = 'white';
            uiBtn.onclick = startDeepIndexing;
            controlsContainer.appendChild(uiBtn);
        }

        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Stop';
            cancelBtn.style.cssText = `position: fixed; bottom: 75px; right: 20px; z-index: 9999; padding: 6px 12px; background-color: #d9534f; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 11px; box-shadow: 0 2px 5px rgba(0,0,0,0.4); opacity: 0.5;`;
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => { cancelRequested = true; cancelBtn.innerText = 'Stopping...'; };
            document.body.appendChild(cancelBtn);
        }

        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = `position: fixed; bottom: 110px; right: 20px; z-index: 9999; padding: 5px 10px; background-color: rgba(0,0,0,0.8); color: #0f0; border-radius: 4px; font-size: 10px; font-family: monospace; max-width: 250px; display: none; pointer-events: none;`;
            document.body.appendChild(statusDiv);
        }

        initWorker();
    }

    // ========== PROGRESS HELPERS ==========
    function updateProgress(current, total, message) {
        if (!progressContainer) return;
        progressContainer.style.display = 'block';
        const pct = Math.floor((current / total) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.innerText = `${message} ${pct}%`;
    }
    function hideProgress() { if (progressContainer) setTimeout(() => { progressContainer.style.display = 'none'; }, 300); }

    // ========== DATABASE LOADING (Cached) ==========
    async function loadDatabaseToMemory() {
        if (RAM_DB !== null) return;
        const keys = await GM.listValues();
        const dbKeys = keys.filter(k => k.startsWith(DB_PREFIX));
        const total = dbKeys.length;
        RAM_DB = [];
        const batchSize = 500;
        for (let i = 0; i < total; i += batchSize) {
            if (cancelRequested) break;
            const batchKeys = dbKeys.slice(i, i + batchSize);
            const values = await Promise.all(batchKeys.map(k => GM.getValue(k)));
            values.forEach(v => { if (v && v.blocks) RAM_DB.push(v); });
            updateProgress(i + batchKeys.length, total, "Loading DB...");
        }
    }

    // ========== SEARCH LOGIC (WORKER) ==========
    function performWorkerSearch(queryDesc) {
        return new Promise((resolve, reject) => {
            if (!searchWorker) initWorker();
            searchWorker.onmessage = function(e) {
                const { type, results, loaded, total } = e.data;
                if (type === 'PROGRESS') {
                    updateProgress(loaded, total, "Searching...");
                } else if (type === 'DONE') {
                    resolve(results);
                }
            };
            searchWorker.onerror = function(e) { reject(e.message); };
            searchWorker.postMessage({ type: 'SEARCH', payload: { db: RAM_DB, query: queryDesc, config: CONFIG } });
        });
    }

    // ========== DB MANAGER UI ==========
    async function toggleDBUI() {
        if (dbPanel) {
            dbPanel.style.display = dbPanel.style.display === 'none' ? 'flex' : 'none';
            if (dbPanel.style.display === 'flex') refreshDBStats();
            return;
        }
        dbPanel = document.createElement('div');
        dbPanel.className = 'mega-indexer-modal';
        ['mousedown', 'click'].forEach(ev => dbPanel.addEventListener(ev, e => e.stopPropagation()));
        dbPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">💾 Database Manager</h3>
                <div class="mega-indexer-close" id="btnDBClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div class="db-stat-box">
                    <div style="font-size:12px; color:#888; margin-bottom:5px;">Total Indexed Images</div>
                    <div class="db-stat-number" id="dbTotalCount">0</div>
                </div>
                <div class="db-actions">
                    <button class="mega-btn btn-primary" id="btnExportDB">⬇ Export</button>
                    <button class="mega-btn btn-success" id="btnImportTrigger">⬆ Import</button>
                    <button class="mega-btn btn-danger" id="btnClearDB">🗑 Clear</button>
                </div>
                <input type="file" id="fileImportDB" accept=".json" style="display:none">
                <div id="dbOpStatus" class="import-status"></div>
            </div>
        `;
        document.body.appendChild(dbPanel);
        document.getElementById('btnDBClose').onclick = () => dbPanel.style.display = 'none';
        document.getElementById('btnExportDB').onclick = exportDatabase;
        document.getElementById('btnClearDB').onclick = clearDatabase;
        const importInput = document.getElementById('fileImportDB');
        document.getElementById('btnImportTrigger').onclick = () => importInput.click();
        importInput.onchange = (e) => importDatabase(e.target.files[0]);
        refreshDBStats();
    }

    async function refreshDBStats() {
        const count = await getDBCount();
        const el = document.getElementById('dbTotalCount');
        if(el) el.innerText = count;
        updateButtonText(count);
    }

    async function exportDatabase() {
        const status = document.getElementById('dbOpStatus');
        status.innerText = 'Loading DB...';
        await loadDatabaseToMemory();
        const data = RAM_DB;
        const blob = new Blob([JSON.stringify(data)], {type: "application/json"});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `MegaIndex_${data.length}.json`;
        a.click();
        status.innerText = `✅ Exported ${data.length} items.`;
    }

    async function importDatabase(file) {
        if (!file) return;
        const status = document.getElementById('dbOpStatus');
        status.innerText = 'Parsing...';
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                status.innerText = `Importing ${data.length} items...`;
                let count = 0;
                for (let i = 0; i < data.length; i++) {
                    await addFileToDB(data[i]);
                    count++;
                    if(i % 200 === 0) { status.innerText = `Writing ${i}/${data.length}...`; await delay(0); }
                }
                RAM_DB = null; // Clear cache to force reload
                status.innerText = `✅ Imported ${count} items.`;
                refreshDBStats();
            } catch (err) { status.innerText = `Error: ${err.message}`; }
        };
        reader.readAsText(file);
    }

    async function clearDatabase() {
        if (!confirm("Delete Database?")) return;
        const keys = await GM.listValues();
        for (const key of keys) if (key.startsWith(DB_PREFIX)) await GM.deleteValue(key);
        RAM_DB = null;
        refreshDBStats();
        alert("Database Cleared");
    }

    // ========== SEARCH PANEL ==========
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }
        searchPanel = document.createElement('div');
        searchPanel.className = 'mega-indexer-modal';
        ['mousedown', 'mouseup', 'click'].forEach(ev => searchPanel.addEventListener(ev, e => e.stopPropagation()));
        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Smart Search (Web Worker)</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div class="progress-container" id="megaProgressBar">
                    <div class="progress-bar" id="megaProgressFill"></div>
                    <div class="progress-text" id="megaProgressText">0%</div>
                </div>

                <label class="mega-file-input-label" id="megaDropZone">
                    <div style="font-size:24px; margin-bottom:10px">📂</div>
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span>Click to Upload or <b>Drag & Drop</b> Image</span>
                </label>

                <div id="megaSearchPreview" style="text-align: center; display:none;">
                    <img id="previewImg" style="max-width: 200px; max-height: 150px; border-radius: 6px; border: 2px solid #444; display:block; margin:0 auto;">
                </div>

                <div id="megaSearchResults">
                    <div style="text-align:center; color: #666; padding: 20px;">Upload an image to search...</div>
                </div>
            </div>
        `;
        document.body.appendChild(searchPanel);

        progressContainer = document.getElementById('megaProgressBar');
        progressBar = document.getElementById('megaProgressFill');
        progressText = document.getElementById('megaProgressText');

        const closeBtn = document.getElementById('btnSearchClose');
        const fileInput = document.getElementById('megaSearchInput');
        const dropZone = document.getElementById('megaDropZone');

        closeBtn.onclick = () => searchPanel.style.display = 'none';
        fileInput.addEventListener('change', (e) => processFile(e.target.files[0]));

        ['dragenter','dragover','dragleave','drop'].forEach(n => dropZone.addEventListener(n, e => {e.preventDefault();e.stopPropagation()}, false));
        dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
        });
    }

    async function processFile(file) {
        if (!file) return;
        const resultsDiv = document.getElementById('megaSearchResults');
        const previewDiv = document.getElementById('megaSearchPreview');
        const previewImg = document.getElementById('previewImg');

        if (previewImg.src) { try { URL.revokeObjectURL(previewImg.src); } catch(e) {} }
        resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Preparing...</div>';

        const imgUrl = URL.createObjectURL(file);
        previewImg.src = imgUrl;
        previewDiv.style.display = 'block';
        await delay(50);

        try {
            if (!RAM_DB || RAM_DB.length === 0) {
                resultsDiv.innerHTML = '<div style="text-align:center; padding:20px;">⏳ Loading DB into RAM...</div>';
                await loadDatabaseToMemory();
            }
            if (RAM_DB.length === 0) {
                resultsDiv.innerHTML = '<div style="color:#d9534f; text-align:center;">Database Empty.</div>';
                hideProgress(); return;
            }

            const tempImg = new Image();
            tempImg.src = imgUrl;
            await new Promise((resolve, reject) => { tempImg.onload = resolve; tempImg.onerror = reject; });

            const queryDesc = await getImageDescriptor(tempImg);
            if (!queryDesc) {
                resultsDiv.innerHTML = '<div style="color:#d9534f; padding:10px;">Image too small.</div>';
                hideProgress(); return;
            }

            const matches = await performWorkerSearch(queryDesc);
            hideProgress();

            if (!matches.length) {
                resultsDiv.innerHTML = `<div style="text-align:center; padding:20px; color:#d9534f;">❌ No matches > 70%.<br><span style="font-size:11px; color:#888;">DB: ${RAM_DB.length}</span></div>`;
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
                                    <span style="color:#666; font-size:10px;">G: ${(m.globalSim*100).toFixed(0)}% | L: ${(m.localSim*100).toFixed(0)}%</span>
                                    <button class="btn-find-mega" data-filename="${escapeHtml(m.name)}">🔍 Find</button>
                                </div>
                            </div>
                        </div>`;
                });
                resultsDiv.innerHTML = html;
                resultsDiv.querySelectorAll('.btn-find-mega').forEach(btn => {
                    btn.onclick = function() { triggerMegaSearch(this.getAttribute('data-filename')); };
                });
            }
        } catch (e) {
            console.error(e);
            hideProgress();
            resultsDiv.innerHTML = `<div style="color:red; padding:10px;">Error: ${e}</div>`;
        }
    }

    function triggerMegaSearch(filename) {
        let input = document.querySelector('.js-filesearcher') || document.querySelector('input[name="search"]');
        if (input) {
            if (searchPanel) searchPanel.style.display = 'none';
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, filename);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
            setTimeout(() => {
                const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 });
                input.dispatchEvent(ev);
            }, 150);
        } else { alert('Search field not found.'); }
    }

    // ==============================================
    // --- HASHING ---
    // ==============================================
    async function getImageDescriptor(img) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h || w < 32 || h < 32) return null;
        const globalHash = computeHash(img, 0, 0, w, h, CONFIG.GLOBAL_HASH_SIZE, 1);
        const blocks = [];
        const grid = CONFIG.PATCH_GRID;
        const tileW = w / grid;
        const tileH = h / grid;
        for (let gy = 0; gy < grid; gy++) {
            for (let gx = 0; gx < grid; gx++) {
                blocks.push(computeHash(img, gx * tileW, gy * tileH, tileW, tileH, CONFIG.PATCH_HASH_SIZE, 0.5));
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
    // --- UTILS & CRAWLER ---
    // ==============================================
    function updateButtonText(count) { if (uiBtn) uiBtn.innerText = `📷 Scan Folders (DB: ${count})`; }
    function updateStatus(text) { if (statusDiv) { statusDiv.innerText = text; statusDiv.style.display = text ? 'block' : 'none'; } }
    async function getDBCount() { try { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; } catch (e) { return 0; } }
    async function addFileToDB(fileData) { try { await GM.setValue(DB_PREFIX + fileData.nodeId, fileData); } catch (e) {} }
    async function checkFileExists(nodeId) { try { return !!(await GM.getValue(DB_PREFIX + nodeId)); } catch (e) { return false; } }
    function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getCurrentPath() { let path = ''; document.querySelectorAll('.fm-breadcrumbs').forEach(c => { path += '/' + (c.innerText || '').trim(); }); return path || '/root'; }

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
                    const record = { nodeId, name, path: getCurrentPath(), globalHash: desc.globalHash, blocks: desc.blocks, timestamp: Date.now() };
                    await addFileToDB(record);
                    if (RAM_DB) RAM_DB.push(record);
                    processedIDs.add(nodeId);
                    processedCount++;
                    updateStatus(`Indexed: ${processedCount}`);
                } catch (err) { console.error(err); }
            }
            if (cancelRequested) break;
            const prevScrollTop = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);
            if (Math.abs(scroller.scrollTop - prevScrollTop) < 5) { stuckCounter++; if (stuckCounter >= 2) break; } else { stuckCounter = 0; }
        }
        return processedCount;
    }

    function triggerDoubleClick(element) { element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: unsafeWindow })); }
    function goBack() { const crumbs = document.querySelectorAll('.fm-breadcrumbs'); if (crumbs.length >= 2) { crumbs[crumbs.length - 2].click(); return true; } return false; }
    function waitForContentChange() { return delay(NAVIGATION_DELAY); }
    function getFolderName(elem) { const nameEl = elem.querySelector('.fm-item-name, .tranfer-filetype-txt, .block-view-file-name, .file-name, span.name'); return nameEl ? (nameEl.innerText || '').trim() : (elem.innerText || '').split('\n')[0].trim(); }
    function getAllFolderContainers() {
        const result = []; const seen = new Set();
        document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder').forEach(node => {
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