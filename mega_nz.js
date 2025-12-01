// ==UserScript==
// @name         Mega.nz Deep Indexer — Unified v9.6 (Precision & UI Fix)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      9.6
// @author       Alex Tol (Fixed by Assistant)
// @description  🕷️📷 v9.6: UI fixed (Mega style), Limit 5 results, High-Detail priority for PSD matching
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v5_Hybrid:';
    let isRunning = false;
    let RAM_DB = null;
    let searchWorker = null;

    // Debug pointers
    window.LAST_SEARCH_DESC = null;
    window.LAST_DB_RECORD = null;
    window.LAST_SEARCH_RESULTS = null;

    const IMAGE_LOAD_TIMEOUT = 3500;
    const FILE_SCROLL_DELAY = 1000;
    const FILE_SCROLL_STEP = 600;
    const FOLDER_SEARCH_DELAY = 200;
    const FOLDER_SEARCH_STEP = 1200;
    const NAVIGATION_DELAY = 3000;

    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    // ==============================================
    // --- v9.6 CONFIG - PRECISION TUNING ---
    // ==============================================
    const CONFIG = {
        GLOBAL_HASH_SIZE: 16,
        PATCH_GRID: 9,
        PATCH_HASH_SIZE: 8,
        PATCH_GOOD_DIST: 10,

        // Extended MultiScale sizes
        MULTI_SCALE_SIZES: [4, 6, 8, 10, 12, 16, 20, 24, 32],

        // v9.6 TWEAK: Увеличены веса для детальных масштабов (High-Freq),
        // чтобы "похожие пятна" проигрывали "похожим деталям".
        SCALE_WEIGHTS: {
            4:  0.4, // Low detail (blur) - понижен вес
            6:  0.6,
            8:  0.8,
            10: 1.0,
            12: 1.0,
            16: 1.4, // ! Важный масштаб
            20: 1.5, // ! Детали
            24: 1.5, // ! Мелкие детали
            32: 1.6  // ! Максимальная детализация (важно для PSD)
        },

        // Если разница в MS меньше этого значения, смотрим на общий балл.
        // Уменьшено, чтобы мелкие преимущества в деталях играли роль.
        MS_PRIORITY_DIFF: 0.02,

        // Weights for combined score
        WEIGHT_STRUCT:    0.25,
        WEIGHT_COLOR:     0.20, // Цвет менее важен (в PSD превью цвета могут "плыть")
        WEIGHT_MULTISCALE: 0.55, // MS теперь главный король (55%)

        // Boosts
        COLOR_BOOST_THRESHOLD: 0.75,
        COLOR_BOOST_MAX: 0.05,

        STRUCT_PRIORITY_THRESHOLD: 0.70,
        STRUCT_PRIORITY_BOOST: 0.02,

        TRIPLE_STRUCT_MIN: 0.65,
        TRIPLE_COLOR_MIN: 0.70,
        TRIPLE_MS_MIN: 0.60,
        TRIPLE_BOOST: 0.05,

        // Thresholds
        MIN_FINAL_SCORE: 0.65,
        MIN_STRUCT_SCORE: 0.35,
        MIN_MS_SCORE: 0.45,

        MS_PERFECT_THRESHOLD: 0.85,
        MS_GOOD_THRESHOLD: 0.70,

        // v9.6: Увеличен бонус за консистентность (если все масштабы похожи)
        MS_SCALE_CONSISTENCY_BONUS: 0.08
    };

    // ==============================================
    // --- WORKER CODE (Optimized) ---
    // ==============================================
    const WORKER_CODE = `
    self.onmessage = function(e) {
        const { type, payload } = e.data;
        if (type === 'SEARCH') {
            const { db, query, config } = payload;
            const results = [];

            // --- Helper Functions inside Worker ---
            function getDist(h1, h2) {
                if(!h1 || !h2) return 256;
                let d = 0;
                const len = Math.min(h1.length, h2.length);
                for(let i=0; i<len; i++) {
                    let x = parseInt(h1[i],16) ^ parseInt(h2[i],16);
                    while(x) { d+=x&1; x>>=1; }
                }
                return d;
            }

            function getColorSim(c1, c2) {
                if (!c1 || !c2 || c1.length !== c2.length) return -1;
                let total = 0;
                for (let i = 0; i < c1.length; i++) {
                    const [h1,s1,v1] = c1[i], [h2,s2,v2] = c2[i];
                    let dh = Math.abs(h1-h2);
                    if(dh>0.5) dh=1-dh; dh*=2;
                    total += 1 - ((dh + Math.abs(s1-s2) + Math.abs(v1-v2)) / 3);
                }
                return total / c1.length;
            }

            function getMultiScaleSim(ms1, ms2, config) {
                if (!ms1 || !ms2) return { sim: 0, min: 0, max: 0, consistency: false };
                let weightedTotal = 0;
                let totalWeight = 0;
                const similarities = [];

                for (const size of config.MULTI_SCALE_SIZES) {
                    if (ms1[size] && ms2[size]) {
                        const dist = getDist(ms1[size], ms2[size]);
                        const maxDist = parseInt(size) * parseInt(size);
                        const sim = 1 - (dist / maxDist);

                        const weight = config.SCALE_WEIGHTS[size] || 1.0;

                        similarities.push(sim);
                        weightedTotal += sim * weight;
                        totalWeight += weight;
                    }
                }

                if (totalWeight === 0) return { sim: 0, min: 0, max: 0, consistency: false };

                const avgSim = weightedTotal / totalWeight;
                const minSim = Math.min(...similarities);
                const maxSim = Math.max(...similarities);

                // Consistency: low deviation across scales
                const range = maxSim - minSim;
                // v9.6: Stricter consistency check
                const consistency = range < 0.14 && similarities.length >= 5;

                return { sim: avgSim, min: minSim, max: maxSim, consistency };
            }

            // --- Main Loop ---
            for (let i = 0; i < db.length; i++) {
                const record = db[i];
                if (!record.globalHash || !record.blocks) continue;

                // 1. MultiScale (Most important)
                const msResult = getMultiScaleSim(query.multiScale, record.multiScale, config);
                const multiScaleSim = msResult.sim;

                // 2. Structural (Global + Local Blocks)
                const gDist = getDist(query.globalHash, record.globalHash);
                const gSim = 1 - (gDist / (config.GLOBAL_HASH_SIZE * config.GLOBAL_HASH_SIZE));

                let strongMatches = 0;
                const blocksA = query.blocks || [], blocksB = record.blocks || [];
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
                const structScore = Math.max(gSim, lSim);

                // Early exit for bad matches
                if (structScore < config.MIN_STRUCT_SCORE && multiScaleSim < config.MIN_MS_SCORE) continue;

                // 3. Color
                const colorScore = getColorSim(query.colorSig, record.colorSig);

                // Boosts
                let structPriorityBoost = structScore >= config.STRUCT_PRIORITY_THRESHOLD ? config.STRUCT_PRIORITY_BOOST : 0;

                let colorBoost = 0;
                if (colorScore >= 0 && colorScore > config.COLOR_BOOST_THRESHOLD) {
                    colorBoost = Math.min((colorScore - config.COLOR_BOOST_THRESHOLD) * 0.3, config.COLOR_BOOST_MAX);
                }

                let tripleBoost = 0;
                if (structScore >= config.TRIPLE_STRUCT_MIN && colorScore >= config.TRIPLE_COLOR_MIN && multiScaleSim >= config.TRIPLE_MS_MIN) {
                    tripleBoost = config.TRIPLE_BOOST;
                }

                let consistencyBonus = msResult.consistency ? config.MS_SCALE_CONSISTENCY_BONUS : 0;

                // Final Score Calculation
                let finalScore;
                if (colorScore >= 0 && multiScaleSim > 0) {
                    finalScore = (structScore * config.WEIGHT_STRUCT) +
                                 (colorScore * config.WEIGHT_COLOR) +
                                 (multiScaleSim * config.WEIGHT_MULTISCALE) +
                                 structPriorityBoost + colorBoost + tripleBoost + consistencyBonus;
                } else if (colorScore >= 0) {
                    finalScore = (structScore * 0.55) + (colorScore * 0.45) + colorBoost;
                } else {
                    finalScore = structScore;
                }

                if (finalScore >= config.MIN_FINAL_SCORE || multiScaleSim >= 0.55) {
                    let matchType = 'High';
                    if (multiScaleSim > config.MS_PERFECT_THRESHOLD) matchType = 'Perfect';
                    else if (multiScaleSim > config.MS_GOOD_THRESHOLD) matchType = 'MS';
                    else if (structScore > 0.85 && (colorScore > 0.85 || colorScore < 0)) matchType = 'Exact';
                    else if (tripleBoost > 0) matchType = 'Triple';
                    else if (lSim >= 0.70) matchType = 'Crop';
                    else if (colorBoost > 0) matchType = 'Color';
                    else if (msResult.consistency) matchType = 'Consistent';

                    results.push({
                        name: record.name,
                        path: record.path,
                        nodeId: record.nodeId,
                        structSim: structScore,
                        colorSim: colorScore,
                        multiScaleSim: multiScaleSim,
                        msMin: msResult.min,
                        msMax: msResult.max,
                        msConsistent: msResult.consistency,
                        finalScore: finalScore,
                        matchType: matchType
                    });
                }

                if (i % 1000 === 0) {
                    self.postMessage({ type: 'PROGRESS', loaded: i, total: db.length });
                }
            }

            // Sort Strategy: Priority to MS, then Combined
            results.sort((a, b) => {
                const msDiff = b.multiScaleSim - a.multiScaleSim;
                // If one result is significantly better in MultiScale, it wins immediately
                if (Math.abs(msDiff) > config.MS_PRIORITY_DIFF) {
                    return msDiff;
                }
                // Otherwise use the tweaked combined score
                return b.finalScore - a.finalScore;
            });

            // v9.6: LIMIT RESULT TO 5
            self.postMessage({ type: 'DONE', results: results.slice(0, 5) });
        }
    };
    `;

    function initWorker() {
        if (searchWorker) return;
        searchWorker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: 'application/javascript' })));
    }

    // ==============================================
    // --- STYLES (Mega-styled, Fixed Scrolls) ---
    // ==============================================
    const style = document.createElement('style');
    style.textContent = `
        /* UI Variables */
        :root {
            --mega-bg-dark: #181818;
            --mega-bg-panel: #252525;
            --mega-border: #333;
            --mega-text: #e0e0e0;
            --mega-blue: #007bff;
            --mega-green: #28a745;
            --mega-red: #dc3545;
            --mega-scroll-track: #111;
            --mega-scroll-thumb: #444;
        }

        /* Modal Container - Fixed Flexbox Layout */
        .mega-indexer-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 600px;
            max-height: 80vh;
            background: var(--mega-bg-dark);
            color: var(--mega-text);
            z-index: 10000;
            border-radius: 8px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.8);
            font-family: 'Segoe UI', 'Open Sans', sans-serif;
            display: flex;
            flex-direction: column; /* Important for scroll fix */
            border: 1px solid var(--mega-border);
            box-sizing: border-box;
            outline: none;
        }

        /* Header - Static */
        .mega-indexer-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--mega-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: var(--mega-bg-panel);
            border-radius: 8px 8px 0 0;
            flex: 0 0 auto;
        }

        .mega-indexer-title {
            font-size: 16px;
            font-weight: 600;
            color: #fff;
            margin: 0;
        }

        .mega-indexer-close {
            cursor: pointer;
            font-size: 18px;
            color: #888;
            width: 24px;
            height: 24px;
            text-align: center;
            line-height: 24px;
            transition: color 0.2s;
        }
        .mega-indexer-close:hover { color: #fff; }

        /* Body - Scrollable area */
        .mega-indexer-body {
            padding: 16px;
            overflow-y: auto; /* Vertical scroll only */
            overflow-x: hidden; /* Kill bottom scroll */
            flex: 1 1 auto; /* Grow to fill space */
            display: flex;
            flex-direction: column;
            gap: 12px;
            min-height: 0; /* Firefox flexbox fix */
        }

        /* Mega-style Scrollbar */
        .mega-indexer-body::-webkit-scrollbar { width: 8px; }
        .mega-indexer-body::-webkit-scrollbar-track { background: var(--mega-scroll-track); }
        .mega-indexer-body::-webkit-scrollbar-thumb {
            background: var(--mega-scroll-thumb);
            border-radius: 4px;
        }
        .mega-indexer-body::-webkit-scrollbar-thumb:hover { background: #555; }

        /* Controls & Elements */
        .progress-container {
            width: 100%;
            background: #333;
            border-radius: 4px;
            height: 20px;
            overflow: hidden;
            display: none;
            position: relative;
            flex: 0 0 auto;
        }
        .progress-bar {
            height: 100%;
            background: var(--mega-green);
            width: 0%;
            transition: width 0.1s;
        }
        .progress-text {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: bold; color: #fff; text-shadow: 0 1px 2px #000;
        }

        .mega-file-input-label {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            padding: 25px;
            background: #1e1e1e;
            border: 2px dashed #444;
            border-radius: 6px;
            cursor: pointer;
            color: #888;
            transition: all 0.2s;
            flex: 0 0 auto;
        }
        .mega-file-input-label:hover {
            border-color: #666;
            background: #222;
            color: #fff;
        }

        .search-result-item {
            background: var(--mega-bg-panel);
            padding: 10px;
            border-radius: 6px;
            border: 1px solid #2f2f2f;
            display: flex;
            gap: 12px;
            align-items: flex-start;
            transition: background 0.2s;
        }
        .search-result-item:hover {
            background: #2a2a2a;
            border-color: #444;
        }

        .search-result-info {
            flex-grow: 1;
            overflow: hidden;
            min-width: 0; /* Flex text overflow fix */
        }
        .search-result-name {
            font-size: 13px; color: #fff; font-weight: 600;
            margin-bottom: 2px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-result-path {
            font-size: 11px; color: #777;
            margin-bottom: 6px; font-family: monospace;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-result-meta {
            font-size: 11px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        }

        /* Badges */
        .sim-badge { padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px; text-transform: uppercase; }
        .sim-perfect { background: rgba(46,204,113,0.15); color: #2ecc71; border: 1px solid #2ecc71; }
        .sim-ms { background: rgba(52,152,219,0.15); color: #3498db; border: 1px solid #3498db; }
        .sim-consistent { background: rgba(26,188,156,0.15); color: #1abc9c; border: 1px solid #1abc9c; }
        .sim-high { background: rgba(149,165,166,0.15); color: #95a5a6; border: 1px solid #95a5a6; }

        .btn-find-mega {
            background: #2a2a2a; color: #aaa; border: 1px solid #444;
            padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;
            margin-left: auto; transition: all 0.2s;
        }
        .btn-find-mega:hover { background: var(--mega-blue); color: white; border-color: var(--mega-blue); }

        /* Bottom Controls */
        #mega-indexer-controls {
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            display: flex; gap: 8px; pointer-events: none;
        }
        #mega-indexer-controls button {
            pointer-events: auto;
            box-shadow: 0 2px 5px rgba(0,0,0,0.4);
            border: none; border-radius: 4px; cursor: pointer;
            font-weight: 600; font-size: 13px; padding: 8px 14px;
            font-family: inherit;
        }

        .mega-btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; color: white; }
        .btn-primary { background: var(--mega-blue); }
        .btn-success { background: var(--mega-green); }
        .btn-danger { background: var(--mega-red); }
    `;
    document.head.appendChild(style);
    console.log('[Mega Indexer] v9.6 - High Detail Priority & UI Fixes');

    // ==============================================
    // --- UI LOGIC ---
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
            dbBtn.style.background = '#28a745';
            dbBtn.style.color = 'white';
            dbBtn.onclick = toggleDBUI;
            controlsContainer.appendChild(dbBtn);
        }

        if (!searchBtn) {
            searchBtn = document.createElement('button');
            searchBtn.innerText = '🔍 Search';
            searchBtn.style.background = '#007bff';
            searchBtn.style.color = 'white';
            searchBtn.onclick = toggleSearchUI;
            controlsContainer.appendChild(searchBtn);
        }

        if (!uiBtn) {
            uiBtn = document.createElement('button');
            updateButtonText(initialCount);
            uiBtn.style.background = '#6f42c1';
            uiBtn.style.color = 'white';
            uiBtn.onclick = startDeepIndexing;
            controlsContainer.appendChild(uiBtn);
        }

        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.innerText = '✖ Stop';
            cancelBtn.style.cssText = 'position:fixed;bottom:70px;right:20px;z-index:9999;padding:6px 12px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;opacity:0.5;';
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => { cancelRequested = true; cancelBtn.innerText = 'Stopping...'; };
            document.body.appendChild(cancelBtn);
        }

        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'position:fixed;bottom:100px;right:20px;z-index:9999;padding:5px 10px;background:rgba(0,0,0,0.8);color:#0f0;border-radius:4px;font-size:10px;font-family:monospace;max-width:250px;display:none;';
            document.body.appendChild(statusDiv);
        }

        initWorker();
    }

    function updateProgress(cur, total, msg) {
        if (!progressContainer) return;
        progressContainer.style.display = 'block';
        const pct = Math.floor((cur / total) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.innerText = `${msg} ${pct}%`;
    }

    function hideProgress() {
        if (progressContainer) setTimeout(() => progressContainer.style.display = 'none', 300);
    }

    // ========== DATABASE ==========
    async function loadDatabaseToMemory() {
        if (RAM_DB !== null) return;
        const keys = await GM.listValues();
        const dbKeys = keys.filter(k => k.startsWith(DB_PREFIX));
        RAM_DB = [];
        for (let i = 0; i < dbKeys.length; i += 500) {
            if (cancelRequested) break;
            const batch = dbKeys.slice(i, i + 500);
            const vals = await Promise.all(batch.map(k => GM.getValue(k)));
            vals.forEach(v => { if (v?.blocks) RAM_DB.push(v); });
            updateProgress(i + batch.length, dbKeys.length, "Loading DB...");
        }
    }

    function performWorkerSearch(queryDesc) {
        return new Promise((resolve, reject) => {
            if (!searchWorker) initWorker();
            searchWorker.onmessage = e => {
                if (e.data.type === 'PROGRESS') updateProgress(e.data.loaded, e.data.total, "Searching...");
                else if (e.data.type === 'DONE') {
                    window.LAST_SEARCH_RESULTS = e.data.results;
                    resolve(e.data.results);
                }
            };
            searchWorker.onerror = e => reject(e.message);
            searchWorker.postMessage({ type: 'SEARCH', payload: { db: RAM_DB, query: queryDesc, config: CONFIG } });
        });
    }

    // ========== SEARCH UI ==========
    function toggleSearchUI() {
        if (searchPanel) {
            searchPanel.style.display = searchPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }
        searchPanel = document.createElement('div');
        searchPanel.className = 'mega-indexer-modal';
        // Prevent clicks passing through
        ['mousedown','mouseup','click'].forEach(ev => searchPanel.addEventListener(ev, e => e.stopPropagation()));

        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Scan v9.6 (Precision)</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div class="progress-container" id="megaProgressBar">
                    <div class="progress-bar" id="megaProgressFill"></div>
                    <div class="progress-text" id="megaProgressText">0%</div>
                </div>

                <label class="mega-file-input-label" id="megaDropZone">
                    <div style="font-size:24px;margin-bottom:10px;opacity:0.7;">📂</div>
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span style="font-size:13px;">Drop image or Click to upload</span>
                </label>

                <div id="megaSearchPreview" style="text-align:center;display:none;flex:0 0 auto;">
                    <img id="previewImg" style="max-width:150px;max-height:100px;border-radius:4px;border:1px solid #444;">
                </div>

                <div id="megaSearchResults">
                    <div style="text-align:center;color:#666;padding:20px;font-size:12px;">
                        Upload image to search<br>
                        (Limit: 5 results)
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(searchPanel);

        progressContainer = document.getElementById('megaProgressBar');
        progressBar = document.getElementById('megaProgressFill');
        progressText = document.getElementById('megaProgressText');

        document.getElementById('btnSearchClose').onclick = () => searchPanel.style.display = 'none';
        document.getElementById('megaSearchInput').addEventListener('change', e => processFile(e.target.files[0]));

        const dz = document.getElementById('megaDropZone');
        ['dragenter','dragover','dragleave','drop'].forEach(n => dz.addEventListener(n, e => {e.preventDefault();e.stopPropagation()}, false));
        dz.addEventListener('drop', e => {
            if(e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
        });
    }

    async function processFile(file) {
        if(!file) return;
        const res = document.getElementById('megaSearchResults');
        const prev = document.getElementById('previewImg');
        const prevDiv = document.getElementById('megaSearchPreview');

        res.innerHTML = '<div style="text-align:center;padding:20px;color:#aaa;">⏳ Analyzing image...</div>';

        const url = URL.createObjectURL(file);
        prev.src = url;
        prevDiv.style.display = 'block';

        try {
            if(!RAM_DB?.length) {
                res.innerHTML = '<div style="text-align:center;padding:20px;color:#aaa;">⏳ Loading Database...</div>';
                await loadDatabaseToMemory();
            }

            const img = new Image();
            img.src = url;
            await new Promise((r,j) => { img.onload = r; img.onerror = j; });

            const q = await getImageDescriptor(img);
            window.LAST_SEARCH_DESC = q;

            if(!q) {
                res.innerHTML = '<div style="color:#d9534f;text-align:center;">Image too small</div>';
                hideProgress();
                return;
            }

            const matches = await performWorkerSearch(q);
            hideProgress();

            if(!matches.length) {
                res.innerHTML = `<div style="text-align:center;color:#d9534f;padding:20px;">No matches found</div>`;
            } else {
                let html = '';
                // Worker already limits to 5, but explicit check here
                matches.slice(0, 5).forEach((m,i) => {
                    const ms = Math.round(m.multiScaleSim*100);
                    const s = Math.round(m.structSim*100);
                    const c = m.colorSim>=0 ? Math.round(m.colorSim*100)+'%' : '-';
                    const comb = Math.round(m.finalScore*100);

                    let bc = 'sim-high';
                    if(m.matchType==='Perfect') bc='sim-perfect';
                    else if(m.matchType==='MS') bc='sim-ms';
                    else if(m.matchType==='Consistent') bc='sim-consistent';

                    html += `
                    <div class="search-result-item">
                        <div style="font-size:18px;color:#555;font-weight:bold;">${i+1}</div>
                        <div class="search-result-info">
                            <div class="search-result-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
                            <div class="search-result-path" title="${escapeHtml(m.path)}">${escapeHtml(m.path)}</div>
                            <div class="search-result-meta">
                                <span class="sim-badge ${bc}">${m.matchType}: ${ms}%</span>
                                <span style="color:#888;font-size:10px;">S:${s} C:${c} Comb:${comb}%</span>
                                <button class="btn-find-mega" data-filename="${escapeHtml(m.name)}">Go ➜</button>
                            </div>
                        </div>
                    </div>`;
                });
                res.innerHTML = html;

                res.querySelectorAll('.btn-find-mega').forEach(b => {
                    b.onclick = function() {
                        triggerMegaSearch(this.getAttribute('data-filename'));
                    };
                });
                console.log(`🔍 Top 5 shown. Debug with MegaDebug.whyNotFirst("${matches[0].name}")`);
            }
        } catch(e) {
            console.error(e);
            hideProgress();
            res.innerHTML = `<div style="color:red;text-align:center;">Error: ${e}</div>`;
        }
    }

    function triggerMegaSearch(filename) {
        let inp = document.querySelector('.js-filesearcher') || document.querySelector('input[name="search"]');
        if(inp) {
            if(searchPanel) searchPanel.style.display = 'none';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            setter.call(inp, filename);
            inp.dispatchEvent(new Event('input',{bubbles:true}));
            inp.focus();
            setTimeout(() => inp.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',keyCode:13})), 150);
        }
    }

    // ========== DB UI ==========
    function toggleDBUI() {
        if (dbPanel) {
            dbPanel.style.display = dbPanel.style.display === 'none' ? 'flex' : 'none';
            if (dbPanel.style.display === 'flex') refreshDBStats();
            return;
        }
        dbPanel = document.createElement('div');
        dbPanel.className = 'mega-indexer-modal';
        ['mousedown','click'].forEach(ev => dbPanel.addEventListener(ev, e => e.stopPropagation()));

        dbPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">💾 Database</h3>
                <div class="mega-indexer-close" id="btnDBClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div style="background:#2a2a2a;padding:15px;border-radius:6px;text-align:center;border:1px solid #333;">
                    <div style="font-size:12px;color:#888;">Total Indexed Files</div>
                    <div style="font-size:28px;color:#2ecc71;font-weight:bold;margin:5px 0;" id="dbTotalCount">0</div>
                    <div style="font-size:10px;color:#666;" id="dbDetailStat"></div>
                </div>

                <div style="display:flex;gap:10px;justify-content:center;margin-top:10px;">
                    <button class="mega-btn btn-primary" id="btnExportDB">Export JSON</button>
                    <button class="mega-btn btn-success" id="btnImportTrigger">Import JSON</button>
                    <button class="mega-btn btn-danger" id="btnClearDB">Clear DB</button>
                </div>

                <input type="file" id="fileImportDB" accept=".json" style="display:none">
                <div id="dbOpStatus" style="text-align:center;font-size:11px;color:#aaa;"></div>
            </div>
        `;
        document.body.appendChild(dbPanel);

        document.getElementById('btnDBClose').onclick = () => dbPanel.style.display = 'none';
        document.getElementById('btnExportDB').onclick = exportDatabase;
        document.getElementById('btnClearDB').onclick = clearDatabase;

        const imp = document.getElementById('fileImportDB');
        document.getElementById('btnImportTrigger').onclick = () => imp.click();
        imp.onchange = e => importDatabase(e.target.files[0]);

        refreshDBStats();
    }

    async function refreshDBStats() {
        await loadDatabaseToMemory();
        const cnt = RAM_DB?.length || 0;
        document.getElementById('dbTotalCount').innerText = cnt;
        document.getElementById('dbDetailStat').innerText = `v9.6 Optimized`;
        updateButtonText(cnt);
    }

    async function exportDatabase() {
        await loadDatabaseToMemory();
        const blob = new Blob([JSON.stringify(RAM_DB)], {type:"application/json"});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `MegaIndex_v9.6_${RAM_DB.length}.json`;
        a.click();
    }

    async function importDatabase(file) {
        if(!file) return;
        const st = document.getElementById('dbOpStatus');
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                const data = JSON.parse(e.target.result);
                st.innerText = `Importing ${data.length} items...`;
                for(let i=0;i<data.length;i++) {
                    await addFileToDB(data[i]);
                    if(i%500===0) await delay(0);
                }
                RAM_DB = null;
                st.innerText = `✅ Imported ${data.length}`;
                refreshDBStats();
            } catch(err) { st.innerText = "Error importing"; }
        };
        reader.readAsText(file);
    }

    async function clearDatabase() {
        if(!confirm("Delete all index data?")) return;
        const keys = await GM.listValues();
        for(const k of keys) if(k.startsWith(DB_PREFIX)) await GM.deleteValue(k);
        RAM_DB = null;
        refreshDBStats();
    }

    // ========== IMAGE PROCESSING ==========
    async function getImageDescriptor(img) {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if(!w || !h || w < 32 || h < 32) return null;

        const globalHash = computeHash(img,0,0,w,h,CONFIG.GLOBAL_HASH_SIZE,1);

        const blocks = [], grid = CONFIG.PATCH_GRID, tw = w/grid, th = h/grid;
        for(let gy=0;gy<grid;gy++)
            for(let gx=0;gx<grid;gx++)
                blocks.push(computeHash(img,gx*tw,gy*th,tw,th,CONFIG.PATCH_HASH_SIZE,0.5));

        const colorSig = computeHSVGrid(img,3);

        const multiScale = {};
        for(const sz of CONFIG.MULTI_SCALE_SIZES)
            multiScale[sz] = computeHash(img,0,0,w,h,sz,0.5);

        return { globalHash, blocks, colorSig, multiScale };
    }

    function computeHash(img,sx,sy,sw,sh,size,blur) {
        const c = document.createElement('canvas'), ctx = c.getContext('2d');
        c.width = size+1; c.height = size;
        if(blur>0) ctx.filter = `grayscale(100%) blur(${blur}px)`;
        else ctx.filter = 'grayscale(100%)';

        ctx.drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);
        const d = ctx.getImageData(0,0,c.width,c.height).data;

        let bits = '';
        for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
            const i=(y*(size+1)+x)*4, j=(y*(size+1)+(x+1))*4;
            bits += d[i]>d[j]?'1':'0';
        }
        return binToHex(bits);
    }

    function binToHex(b) {
        let h='';
        for(let i=0;i<b.length;i+=4) h+=parseInt(b.substring(i,i+4),2).toString(16);
        return h;
    }

    function computeHSVGrid(img,gs) {
        const c = document.createElement('canvas'), ctx = c.getContext('2d'), ws = 30;
        c.width = ws; c.height = ws;
        ctx.drawImage(img,0,0,ws,ws);
        const px = ctx.getImageData(0,0,ws,ws).data, zs = ws/gs, sig = [];
        for(let zy=0;zy<gs;zy++) for(let zx=0;zx<gs;zx++) {
            let sH=0,sS=0,sV=0,cnt=0;
            for(let y=Math.floor(zy*zs);y<Math.floor((zy+1)*zs);y++)
                for(let x=Math.floor(zx*zs);x<Math.floor((zx+1)*zs);x++) {
                    const i=(y*ws+x)*4, [h,s,v]=rgbToHsv(px[i],px[i+1],px[i+2]);
                    sH+=h;sS+=s;sV+=v;cnt++;
                }
            sig.push(cnt?[sH/cnt,sS/cnt,sV/cnt]:[0,0,0]);
        }
        return sig;
    }

    function rgbToHsv(r,g,b) {
        r/=255;g/=255;b/=255;
        const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
        let h,s=mx===0?0:d/mx,v=mx;
        if(mx===mn) h=0;
        else {
            switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}
            h/=6;
        }
        return [h,s,v];
    }

    // ========== UTILS & SCANNING ==========
    function updateButtonText(c) { if(uiBtn) uiBtn.innerText = `📷 Scan (DB: ${c})`; }
    function updateStatus(t) { if(statusDiv) { statusDiv.innerText = t; statusDiv.style.display = t ? 'block' : 'none'; } }
    async function getDBCount() { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; }
    async function addFileToDB(d) { await GM.setValue(DB_PREFIX + d.nodeId, d); }
    async function checkFileExists(id) { return !!(await GM.getValue(DB_PREFIX + id)); }
    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getCurrentPath() {
        let p='';
        document.querySelectorAll('.fm-breadcrumbs').forEach(c => { p += '/' + (c.innerText||'').trim(); });
        return p || '/root';
    }

    async function waitForBatchLoading(imgs, timeout=3000) {
        if(!imgs.length) return;
        const start = Date.now();
        while(Date.now()-start < timeout) {
            if(imgs.every(i => i.src?.startsWith('blob:') && i.complete && i.naturalWidth>0)) return;
            await delay(200);
        }
    }

    async function scanCurrentFolder() {
        const scroller = document.querySelector('.file-block-scrolling');
        if(!scroller) return 0;
        scroller.scrollTop = 0;
        await delay(1000);
        let count=0, stuck=0;
        const processed = new Set();

        while(!cancelRequested) {
            const images = Array.from(scroller.querySelectorAll('.fm-item-img img')), candidates = [];

            for(let img of images) {
                let container = img.closest('[id^="th_"]') || img.closest('.mega-item-square') || img.closest('a.mega-node');
                if(!container && img.parentElement) container = img.parentElement.parentElement;

                let name = 'Unknown';
                if(container) {
                    const ne = container.querySelector('.block-view-file-name, .file-name, .fm-item-name');
                    if(ne) name = (ne.innerText||'').split('\n')[0].trim();
                }

                let nodeId = container?.id?.startsWith('th_') ? container.id : (container?.dataset?.nodeId || null);
                if(!nodeId) nodeId = 'gen_' + getCurrentPath() + '_' + name;

                if(!processed.has(nodeId) && !(await checkFileExists(nodeId))) candidates.push({img,nodeId,name});
                else processed.add(nodeId);
            }

            if(candidates.length) await waitForBatchLoading(candidates.map(c=>c.img), IMAGE_LOAD_TIMEOUT);

            for(let {img,nodeId,name} of candidates) {
                if(cancelRequested) break;
                if(!img.complete || !img.naturalWidth || !img.src?.startsWith('blob:')) continue;
                try {
                    const desc = await getImageDescriptor(img);
                    if(!desc) continue;
                    const rec = {
                        nodeId, name, path: getCurrentPath(),
                        globalHash: desc.globalHash, blocks: desc.blocks,
                        colorSig: desc.colorSig, multiScale: desc.multiScale,
                        timestamp: Date.now()
                    };
                    await addFileToDB(rec);
                    if(RAM_DB) RAM_DB.push(rec);
                    processed.add(nodeId);
                    count++;
                    updateStatus(`Indexed: ${count}`);
                } catch(e) { console.error(e); }
            }

            if(cancelRequested) break;
            const prev = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);
            if(Math.abs(scroller.scrollTop - prev) < 5) { stuck++; if(stuck >= 2) break; } else stuck = 0;
        }
        return count;
    }

    function triggerDoubleClick(el) { el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:unsafeWindow})); }
    function goBack() { const c = document.querySelectorAll('.fm-breadcrumbs'); if(c.length>=2){c[c.length-2].click();return true;} return false; }
    function waitForContentChange() { return delay(NAVIGATION_DELAY); }
    function getFolderName(el) {
        const n = el.querySelector('.fm-item-name, .tranfer-filetype-txt, .block-view-file-name, .file-name, span.name');
        return n ? (n.innerText||'').trim() : (el.innerText||'').split('\n')[0].trim();
    }

    function getAllFolderContainers() {
        const result = [], seen = new Set();
        document.querySelectorAll('.mega-node.folder, tr.megaListItem .folder, .mega-item-square .folder').forEach(node => {
            const container = node.closest('.mega-node, tr.megaListItem, .mega-item-square') || node;
            const name = getFolderName(container);
            if(name && !seen.has(name)) { seen.add(name); result.push({element:container,name}); }
        });
        return result;
    }

    function findNextUnvisitedFolder() {
        for(const f of getAllFolderContainers()) {
            const key = getCurrentPath()+'::'+f.name;
            if(!visitedFolderKeys.has(key)) return {...f,key};
        }
        return null;
    }

    async function deepScanCurrentFolder(depth=0, maxDepth=50) {
        if(cancelRequested || depth > maxDepth) return;
        await scanCurrentFolder();

        const scroller = document.querySelector('.file-block-scrolling');
        if(scroller) { scroller.scrollTop = 0; await delay(1000); }

        while(!cancelRequested) {
            const next = findNextUnvisitedFolder();
            if(!next) {
                if(scroller && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 50) {
                    const prev = scroller.scrollTop;
                    scroller.scrollBy(0, FOLDER_SEARCH_STEP);
                    await delay(FOLDER_SEARCH_DELAY);
                    if(Math.abs(scroller.scrollTop - prev) < 5) break;
                    continue;
                }
                break;
            }
            visitedFolderKeys.add(next.key);
            updateStatus(`>>> ${next.name}`);
            await delay(500);
            triggerDoubleClick(next.element);
            await waitForContentChange();
            await deepScanCurrentFolder(depth + 1, maxDepth);
            if(cancelRequested) break;
            goBack();
            await waitForContentChange();
        }
    }

    async function startDeepIndexing() {
        if(isRunning) return;
        isRunning = true; cancelRequested = false; visitedFolderKeys.clear();
        uiBtn.disabled = true; uiBtn.innerText = '⏳ Scanning...';
        cancelBtn.disabled = false; cancelBtn.style.opacity = '1'; cancelBtn.innerText = '✖ Stop';
        if(searchBtn) searchBtn.disabled = true;

        try {
            updateStatus('Starting v9.6...');
            await deepScanCurrentFolder(0);
            alert('✅ Done!');
        } catch(e) { console.error(e); alert('Error: ' + e.message); }
        finally {
            isRunning = false; cancelRequested = false; updateStatus('');
            uiBtn.disabled = false; updateButtonText(await getDBCount());
            cancelBtn.disabled = true; cancelBtn.style.opacity = '0.5';
            if(searchBtn) searchBtn.disabled = false;
        }
    }

    const check = setInterval(async () => {
        if(document.querySelector('.file-block-scrolling')) {
            clearInterval(check);
            createUI(await getDBCount());
        }
    }, 1000);

    // DEBUG TOOLS
    unsafeWindow.MegaDebug = {
        getSearchHash: () => window.LAST_SEARCH_DESC ? console.log(window.LAST_SEARCH_DESC) : console.log("No search desc"),
        whyNotFirst: (name) => {
            if(!window.LAST_SEARCH_RESULTS) return console.log("No results");
            const t = window.LAST_SEARCH_RESULTS.find(r=>r.name.includes(name));
            const w = window.LAST_SEARCH_RESULTS[0];
            console.log("Winner:", w.name, w.finalScore.toFixed(4), "Target:", t?t.name:"NA", t?t.finalScore.toFixed(4):"NA");
        }
    };

})();