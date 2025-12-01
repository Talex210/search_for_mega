// ==UserScript==
// @name         Mega.nz Deep Indexer — Unified v10.0 (Hybrid Precision)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @version      10.0
// @author       Alex Tol
// @description  🕷️📷 v10.0: Hybrid approach - Perceptual Hash + Pixel Fingerprint for exact matching
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v5_Hybrid:';
    let isRunning = false;
    let RAM_DB = null;
    let searchWorker = null;

    window.LAST_SEARCH_DESC = null;
    window.LAST_DB_RECORD = null;
    window.LAST_SEARCH_RESULTS = null;
    window.LAST_ALL_CANDIDATES = null; // NEW: All candidates before filtering

    const IMAGE_LOAD_TIMEOUT = 3500;
    const FILE_SCROLL_DELAY = 1000;
    const FILE_SCROLL_STEP = 600;
    const FOLDER_SEARCH_DELAY = 200;
    const FOLDER_SEARCH_STEP = 1200;
    const NAVIGATION_DELAY = 3000;

    let cancelRequested = false;
    const visitedFolderKeys = new Set();

    // ==============================================
    // --- v10.0 CONFIG - HYBRID PRECISION ---
    // ==============================================
    const CONFIG = {
        GLOBAL_HASH_SIZE: 16,
        PATCH_GRID: 9,
        PATCH_HASH_SIZE: 8,
        PATCH_GOOD_DIST: 10,

        // MultiScale sizes
        MULTI_SCALE_SIZES: [4, 6, 8, 10, 12, 16, 20, 24, 32],

        SCALE_WEIGHTS: {
            4:  0.5,
            6:  0.7,
            8:  0.9,
            10: 1.0,
            12: 1.0,
            16: 1.2,
            20: 1.1,
            24: 1.0,
            32: 0.9
        },

        // NEW v10.0: Pixel Fingerprint settings
        FINGERPRINT_SIZE: 32,        // 32x32 center sample
        FINGERPRINT_WEIGHT: 0.35,    // Weight in final score
        FINGERPRINT_EXACT_THRESHOLD: 0.92, // Above this = exact match bonus
        FINGERPRINT_EXACT_BONUS: 0.25,     // Huge bonus for exact match

        MS_PRIORITY_DIFF: 0.025,

        // Adjusted weights for v10
        WEIGHT_STRUCT:      0.20,
        WEIGHT_COLOR:       0.15,
        WEIGHT_MULTISCALE:  0.30,
        WEIGHT_FINGERPRINT: 0.35,  // NEW: Fingerprint is important!

        // Boosts
        COLOR_BOOST_THRESHOLD: 0.75,
        COLOR_BOOST_MAX: 0.04,

        STRUCT_PRIORITY_THRESHOLD: 0.70,
        STRUCT_PRIORITY_BOOST: 0.02,

        TRIPLE_STRUCT_MIN: 0.60,
        TRIPLE_COLOR_MIN: 0.65,
        TRIPLE_MS_MIN: 0.55,
        TRIPLE_BOOST: 0.04,

        // Thresholds - lowered to catch more candidates
        MIN_FINAL_SCORE: 0.55,
        MIN_STRUCT_SCORE: 0.30,
        MIN_MS_SCORE: 0.40,

        MS_PERFECT_THRESHOLD: 0.85,
        MS_GOOD_THRESHOLD: 0.65,
        MS_SCALE_CONSISTENCY_BONUS: 0.05,

        // Display
        MAX_RESULTS: 10
    };

    // ==============================================
    // --- WORKER CODE v10.0 ---
    // ==============================================
    const WORKER_CODE = `
    self.onmessage = function(e) {
        const { type, payload } = e.data;
        if (type === 'SEARCH') {
            const { db, query, config } = payload;
            const results = [];

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
                const range = maxSim - minSim;
                const consistency = range < 0.15 && similarities.length >= 5;

                return { sim: avgSim, min: minSim, max: maxSim, consistency };
            }

            // NEW v10.0: Fingerprint similarity
            function getFingerprintSim(fp1, fp2) {
                if (!fp1 || !fp2 || fp1.length !== fp2.length) return -1;

                let matching = 0;
                for (let i = 0; i < fp1.length; i++) {
                    // Compare with tolerance (pixel values 0-255)
                    if (Math.abs(fp1[i] - fp2[i]) <= 15) matching++;
                }
                return matching / fp1.length;
            }

            // --- Main Loop ---
            for (let i = 0; i < db.length; i++) {
                const record = db[i];
                if (!record.globalHash || !record.blocks) continue;

                // 1. MultiScale
                const msResult = getMultiScaleSim(query.multiScale, record.multiScale, config);
                const multiScaleSim = msResult.sim;

                // 2. Structural
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

                // 3. NEW: Fingerprint
                const fpSim = getFingerprintSim(query.fingerprint, record.fingerprint);
                const hasFingerprint = fpSim >= 0;

                // Early exit - but consider fingerprint
                if (structScore < config.MIN_STRUCT_SCORE &&
                    multiScaleSim < config.MIN_MS_SCORE &&
                    (!hasFingerprint || fpSim < 0.5)) continue;

                // 4. Color
                const colorScore = getColorSim(query.colorSig, record.colorSig);

                // Boosts
                let structPriorityBoost = structScore >= config.STRUCT_PRIORITY_THRESHOLD ? config.STRUCT_PRIORITY_BOOST : 0;

                let colorBoost = 0;
                if (colorScore >= 0 && colorScore > config.COLOR_BOOST_THRESHOLD) {
                    colorBoost = Math.min((colorScore - config.COLOR_BOOST_THRESHOLD) * 0.3, config.COLOR_BOOST_MAX);
                }

                let tripleBoost = 0;
                if (structScore >= config.TRIPLE_STRUCT_MIN &&
                    colorScore >= config.TRIPLE_COLOR_MIN &&
                    multiScaleSim >= config.TRIPLE_MS_MIN) {
                    tripleBoost = config.TRIPLE_BOOST;
                }

                let consistencyBonus = msResult.consistency ? config.MS_SCALE_CONSISTENCY_BONUS : 0;

                // NEW v10.0: Exact match bonus
                let exactMatchBonus = 0;
                if (hasFingerprint && fpSim >= config.FINGERPRINT_EXACT_THRESHOLD) {
                    exactMatchBonus = config.FINGERPRINT_EXACT_BONUS;
                }

                // Final Score with Fingerprint
                let finalScore;
                if (hasFingerprint && colorScore >= 0 && multiScaleSim > 0) {
                    finalScore = (structScore * config.WEIGHT_STRUCT) +
                                 (colorScore * config.WEIGHT_COLOR) +
                                 (multiScaleSim * config.WEIGHT_MULTISCALE) +
                                 (fpSim * config.WEIGHT_FINGERPRINT) +
                                 structPriorityBoost + colorBoost + tripleBoost +
                                 consistencyBonus + exactMatchBonus;
                } else if (colorScore >= 0 && multiScaleSim > 0) {
                    // No fingerprint - use old formula
                    finalScore = (structScore * 0.25) +
                                 (colorScore * 0.20) +
                                 (multiScaleSim * 0.55) +
                                 structPriorityBoost + colorBoost + tripleBoost + consistencyBonus;
                } else if (colorScore >= 0) {
                    finalScore = (structScore * 0.55) + (colorScore * 0.45) + colorBoost;
                } else {
                    finalScore = structScore;
                }

                // Determine match type
                let matchType = 'Similar';
                if (exactMatchBonus > 0) matchType = 'EXACT';
                else if (hasFingerprint && fpSim >= 0.85) matchType = 'VeryClose';
                else if (multiScaleSim > config.MS_PERFECT_THRESHOLD) matchType = 'Perfect';
                else if (multiScaleSim > config.MS_GOOD_THRESHOLD) matchType = 'Good';
                else if (tripleBoost > 0) matchType = 'Triple';
                else if (lSim >= 0.70) matchType = 'Crop';
                else if (msResult.consistency) matchType = 'Consistent';

                if (finalScore >= config.MIN_FINAL_SCORE ||
                    multiScaleSim >= 0.50 ||
                    (hasFingerprint && fpSim >= 0.70)) {
                    results.push({
                        name: record.name,
                        path: record.path,
                        nodeId: record.nodeId,
                        structSim: structScore,
                        colorSim: colorScore,
                        multiScaleSim: multiScaleSim,
                        fingerprintSim: fpSim,
                        msMin: msResult.min,
                        msMax: msResult.max,
                        msConsistent: msResult.consistency,
                        exactMatchBonus: exactMatchBonus,
                        finalScore: finalScore,
                        matchType: matchType
                    });
                }

                if (i % 1000 === 0) {
                    self.postMessage({ type: 'PROGRESS', loaded: i, total: db.length });
                }
            }

            // v10.0 Sorting: Exact matches first, then by combined score
            results.sort((a, b) => {
                // EXACT matches always first
                if (a.matchType === 'EXACT' && b.matchType !== 'EXACT') return -1;
                if (b.matchType === 'EXACT' && a.matchType !== 'EXACT') return 1;

                // VeryClose matches second
                if (a.matchType === 'VeryClose' && b.matchType !== 'VeryClose' && b.matchType !== 'EXACT') return -1;
                if (b.matchType === 'VeryClose' && a.matchType !== 'VeryClose' && a.matchType !== 'EXACT') return 1;

                // Then by final score
                return b.finalScore - a.finalScore;
            });

            self.postMessage({
                type: 'DONE',
                results: results.slice(0, config.MAX_RESULTS),
                totalCandidates: results.length
            });
        }
    };
    `;

    function initWorker() {
        if (searchWorker) return;
        searchWorker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: 'application/javascript' })));
    }

    // ==============================================
    // --- STYLES ---
    // ==============================================
    const style = document.createElement('style');
    style.textContent = `
        :root {
            --mega-bg-dark: #181818;
            --mega-bg-panel: #252525;
            --mega-border: #333;
            --mega-text: #e0e0e0;
            --mega-blue: #007bff;
            --mega-green: #28a745;
            --mega-red: #dc3545;
            --mega-gold: #f1c40f;
            --mega-scroll-track: #111;
            --mega-scroll-thumb: #444;
        }

        .mega-indexer-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 620px;
            max-height: 85vh;
            background: var(--mega-bg-dark);
            color: var(--mega-text);
            z-index: 10000;
            border-radius: 8px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.8);
            font-family: 'Segoe UI', 'Open Sans', sans-serif;
            display: flex;
            flex-direction: column;
            border: 1px solid var(--mega-border);
            box-sizing: border-box;
            outline: none;
        }

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
            font-size: 15px;
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

        .mega-indexer-body {
            padding: 16px;
            overflow-y: auto;
            overflow-x: hidden;
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-height: 0;
        }

        .mega-indexer-body::-webkit-scrollbar { width: 6px; }
        .mega-indexer-body::-webkit-scrollbar-track { background: var(--mega-scroll-track); }
        .mega-indexer-body::-webkit-scrollbar-thumb {
            background: var(--mega-scroll-thumb);
            border-radius: 3px;
        }
        .mega-indexer-body::-webkit-scrollbar-thumb:hover { background: #555; }

        .progress-container {
            width: 100%;
            background: #333;
            border-radius: 4px;
            height: 18px;
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
            padding: 20px;
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
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid #2f2f2f;
            display: flex;
            gap: 10px;
            align-items: flex-start;
            transition: background 0.2s;
        }
        .search-result-item:hover {
            background: #2a2a2a;
            border-color: #444;
        }
        .search-result-item.exact-match {
            border-color: var(--mega-gold);
            background: rgba(241, 196, 15, 0.08);
        }

        .search-result-info {
            flex-grow: 1;
            overflow: hidden;
            min-width: 0;
        }
        .search-result-name {
            font-size: 12px; color: #fff; font-weight: 600;
            margin-bottom: 2px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-result-path {
            font-size: 10px; color: #666;
            margin-bottom: 4px; font-family: monospace;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-result-meta {
            font-size: 10px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        }

        .sim-badge {
            padding: 2px 5px; border-radius: 3px; font-weight: bold;
            font-size: 9px; text-transform: uppercase;
        }
        .sim-exact { background: rgba(241,196,15,0.25); color: #f1c40f; border: 1px solid #f1c40f; }
        .sim-veryclose { background: rgba(46,204,113,0.20); color: #2ecc71; border: 1px solid #2ecc71; }
        .sim-perfect { background: rgba(46,204,113,0.15); color: #2ecc71; border: 1px solid #27ae60; }
        .sim-good { background: rgba(52,152,219,0.15); color: #3498db; border: 1px solid #3498db; }
        .sim-similar { background: rgba(149,165,166,0.15); color: #95a5a6; border: 1px solid #95a5a6; }

        .btn-find-mega {
            background: #2a2a2a; color: #aaa; border: 1px solid #444;
            padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px;
            margin-left: auto; transition: all 0.2s;
        }
        .btn-find-mega:hover { background: var(--mega-blue); color: white; border-color: var(--mega-blue); }

        #mega-indexer-controls {
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            display: flex; gap: 8px; pointer-events: none;
        }
        #mega-indexer-controls button {
            pointer-events: auto;
            box-shadow: 0 2px 5px rgba(0,0,0,0.4);
            border: none; border-radius: 4px; cursor: pointer;
            font-weight: 600; font-size: 12px; padding: 8px 12px;
            font-family: inherit;
        }

        .mega-btn { padding: 8px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; color: white; }
        .btn-primary { background: var(--mega-blue); }
        .btn-success { background: var(--mega-green); }
        .btn-danger { background: var(--mega-red); }

        .results-info {
            font-size: 10px;
            color: #666;
            text-align: center;
            padding: 5px;
        }
    `;
    document.head.appendChild(style);
    console.log('[Mega Indexer] v10.0 - Hybrid Precision (Perceptual + Fingerprint)');

    // ==============================================
    // --- UI ---
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
            cancelBtn.style.cssText = 'position:fixed;bottom:70px;right:20px;z-index:9999;padding:6px 10px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:10px;opacity:0.5;';
            cancelBtn.disabled = true;
            cancelBtn.onclick = () => { cancelRequested = true; cancelBtn.innerText = 'Stopping...'; };
            document.body.appendChild(cancelBtn);
        }

        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'position:fixed;bottom:100px;right:20px;z-index:9999;padding:5px 10px;background:rgba(0,0,0,0.85);color:#0f0;border-radius:4px;font-size:10px;font-family:monospace;max-width:250px;display:none;';
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
                    resolve({ results: e.data.results, totalCandidates: e.data.totalCandidates });
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
        ['mousedown','mouseup','click'].forEach(ev => searchPanel.addEventListener(ev, e => e.stopPropagation()));

        searchPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">📷 Search v10.0 (Hybrid)</h3>
                <div class="mega-indexer-close" id="btnSearchClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div class="progress-container" id="megaProgressBar">
                    <div class="progress-bar" id="megaProgressFill"></div>
                    <div class="progress-text" id="megaProgressText">0%</div>
                </div>

                <label class="mega-file-input-label" id="megaDropZone">
                    <div style="font-size:22px;margin-bottom:8px;opacity:0.7;">📂</div>
                    <input type="file" id="megaSearchInput" accept="image/*" style="display:none">
                    <span style="font-size:12px;">Drop image or Click</span>
                </label>

                <div id="megaSearchPreview" style="text-align:center;display:none;flex:0 0 auto;">
                    <img id="previewImg" style="max-width:120px;max-height:80px;border-radius:4px;border:1px solid #444;">
                </div>

                <div id="megaSearchResults">
                    <div style="text-align:center;color:#666;padding:15px;font-size:11px;">
                        Upload image to find matches<br>
                        <span style="color:#888;font-size:10px;">v10.0: Exact matching + Similar search</span>
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

        res.innerHTML = '<div style="text-align:center;padding:15px;color:#aaa;">⏳ Analyzing...</div>';

        const url = URL.createObjectURL(file);
        prev.src = url;
        prevDiv.style.display = 'block';

        try {
            if(!RAM_DB?.length) {
                res.innerHTML = '<div style="text-align:center;padding:15px;color:#aaa;">⏳ Loading Database...</div>';
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

            const { results: matches, totalCandidates } = await performWorkerSearch(q);
            hideProgress();

            if(!matches.length) {
                res.innerHTML = `<div style="text-align:center;color:#d9534f;padding:15px;">No matches found</div>`;
            } else {
                let html = `<div class="results-info">Found ${totalCandidates} candidates, showing top ${matches.length}</div>`;

                matches.forEach((m, i) => {
                    const ms = Math.round(m.multiScaleSim * 100);
                    const fp = m.fingerprintSim >= 0 ? Math.round(m.fingerprintSim * 100) + '%' : '-';
                    const s = Math.round(m.structSim * 100);
                    const c = m.colorSim >= 0 ? Math.round(m.colorSim * 100) + '%' : '-';
                    const comb = Math.round(m.finalScore * 100);

                    let bc = 'sim-similar';
                    if (m.matchType === 'EXACT') bc = 'sim-exact';
                    else if (m.matchType === 'VeryClose') bc = 'sim-veryclose';
                    else if (m.matchType === 'Perfect') bc = 'sim-perfect';
                    else if (m.matchType === 'Good') bc = 'sim-good';

                    const isExact = m.matchType === 'EXACT' || m.matchType === 'VeryClose';

                    html += `
                    <div class="search-result-item ${isExact ? 'exact-match' : ''}">
                        <div style="font-size:16px;color:#555;font-weight:bold;min-width:20px;">${i + 1}</div>
                        <div class="search-result-info">
                            <div class="search-result-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
                            <div class="search-result-path" title="${escapeHtml(m.path)}">${escapeHtml(m.path)}</div>
                            <div class="search-result-meta">
                                <span class="sim-badge ${bc}">${m.matchType}</span>
                                <span style="color:#888;">FP:${fp} MS:${ms}% S:${s} C:${c}</span>
                                <span style="color:#aaa;font-weight:bold;">${comb}%</span>
                                <button class="btn-find-mega" data-filename="${escapeHtml(m.name)}">Go ➜</button>
                            </div>
                        </div>
                    </div>`;
                });
                res.innerHTML = html;

                res.querySelectorAll('.btn-find-mega').forEach(b => {
                    b.onclick = function () {
                        triggerMegaSearch(this.getAttribute('data-filename'));
                    };
                });
                console.log(`🔍 v10.0: ${totalCandidates} candidates, ${matches.length} shown. MegaDebug.findTarget("filename")`);
            }
        } catch (e) {
            console.error(e);
            hideProgress();
            res.innerHTML = `<div style="color:red;text-align:center;">Error: ${e}</div>`;
        }
    }

    function triggerMegaSearch(filename) {
        let inp = document.querySelector('.js-filesearcher') || document.querySelector('input[name="search"]');
        if (inp) {
            if (searchPanel) searchPanel.style.display = 'none';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, filename);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.focus();
            setTimeout(() => inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 })), 150);
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
        ['mousedown', 'click'].forEach(ev => dbPanel.addEventListener(ev, e => e.stopPropagation()));

        dbPanel.innerHTML = `
            <div class="mega-indexer-header">
                <h3 class="mega-indexer-title">💾 Database v10</h3>
                <div class="mega-indexer-close" id="btnDBClose">✖</div>
            </div>
            <div class="mega-indexer-body">
                <div style="background:#2a2a2a;padding:12px;border-radius:6px;text-align:center;border:1px solid #333;">
                    <div style="font-size:11px;color:#888;">Indexed Files</div>
                    <div style="font-size:26px;color:#2ecc71;font-weight:bold;margin:5px 0;" id="dbTotalCount">0</div>
                    <div style="font-size:10px;color:#666;" id="dbDetailStat"></div>
                </div>

                <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
                    <button class="mega-btn btn-primary" id="btnExportDB">Export</button>
                    <button class="mega-btn btn-success" id="btnImportTrigger">Import</button>
                    <button class="mega-btn btn-danger" id="btnClearDB">Clear</button>
                </div>

                <input type="file" id="fileImportDB" accept=".json" style="display:none">
                <div id="dbOpStatus" style="text-align:center;font-size:10px;color:#aaa;margin-top:5px;"></div>
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
        const withFP = RAM_DB?.filter(r => r.fingerprint)?.length || 0;
        document.getElementById('dbTotalCount').innerText = cnt;
        document.getElementById('dbDetailStat').innerText = `${withFP} with fingerprint (v10)`;
        updateButtonText(cnt);
    }

    async function exportDatabase() {
        await loadDatabaseToMemory();
        const blob = new Blob([JSON.stringify(RAM_DB)], { type: "application/json" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `MegaIndex_v10_${RAM_DB.length}.json`;
        a.click();
    }

    async function importDatabase(file) {
        if (!file) return;
        const st = document.getElementById('dbOpStatus');
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                const data = JSON.parse(e.target.result);
                st.innerText = `Importing ${data.length}...`;
                for (let i = 0; i < data.length; i++) {
                    await addFileToDB(data[i]);
                    if (i % 500 === 0) await delay(0);
                }
                RAM_DB = null;
                st.innerText = `✅ Imported ${data.length}`;
                refreshDBStats();
            } catch (err) { st.innerText = "Import error"; }
        };
        reader.readAsText(file);
    }

    async function clearDatabase() {
        if (!confirm("Delete all?")) return;
        const keys = await GM.listValues();
        for (const k of keys) if (k.startsWith(DB_PREFIX)) await GM.deleteValue(k);
        RAM_DB = null;
        refreshDBStats();
    }

    // ========== IMAGE PROCESSING v10.0 ==========
    async function getImageDescriptor(img) {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h || w < 32 || h < 32) return null;

        const globalHash = computeHash(img, 0, 0, w, h, CONFIG.GLOBAL_HASH_SIZE, 1);

        const blocks = [], grid = CONFIG.PATCH_GRID, tw = w / grid, th = h / grid;
        for (let gy = 0; gy < grid; gy++)
            for (let gx = 0; gx < grid; gx++)
                blocks.push(computeHash(img, gx * tw, gy * th, tw, th, CONFIG.PATCH_HASH_SIZE, 0.5));

        const colorSig = computeHSVGrid(img, 3);

        const multiScale = {};
        for (const sz of CONFIG.MULTI_SCALE_SIZES)
            multiScale[sz] = computeHash(img, 0, 0, w, h, sz, 0.5);

        // NEW v10.0: Pixel Fingerprint
        const fingerprint = computeFingerprint(img, CONFIG.FINGERPRINT_SIZE);

        return { globalHash, blocks, colorSig, multiScale, fingerprint };
    }

    // NEW v10.0: Compute pixel fingerprint from center region
    function computeFingerprint(img, size) {
        const c = document.createElement('canvas'), ctx = c.getContext('2d');
        c.width = size;
        c.height = size;

        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;

        // Extract center region
        const cropSize = Math.min(w, h) * 0.7;
        const sx = (w - cropSize) / 2;
        const sy = (h - cropSize) / 2;

        ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, size, size);

        const d = ctx.getImageData(0, 0, size, size).data;

        // Create compact fingerprint: average of RGB for each pixel
        const fp = [];
        for (let i = 0; i < d.length; i += 4) {
            // Store grayscale value (0-255)
            fp.push(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3));
        }

        return fp;
    }

    function computeHash(img, sx, sy, sw, sh, size, blur) {
        const c = document.createElement('canvas'), ctx = c.getContext('2d');
        c.width = size + 1; c.height = size;
        if (blur > 0) ctx.filter = `grayscale(100%) blur(${blur}px)`;
        else ctx.filter = 'grayscale(100%)';

        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;

        let bits = '';
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const i = (y * (size + 1) + x) * 4, j = (y * (size + 1) + (x + 1)) * 4;
            bits += d[i] > d[j] ? '1' : '0';
        }
        return binToHex(bits);
    }

    function binToHex(b) {
        let h = '';
        for (let i = 0; i < b.length; i += 4) h += parseInt(b.substring(i, i + 4), 2).toString(16);
        return h;
    }

    function computeHSVGrid(img, gs) {
        const c = document.createElement('canvas'), ctx = c.getContext('2d'), ws = 30;
        c.width = ws; c.height = ws;
        ctx.drawImage(img, 0, 0, ws, ws);
        const px = ctx.getImageData(0, 0, ws, ws).data, zs = ws / gs, sig = [];
        for (let zy = 0; zy < gs; zy++) for (let zx = 0; zx < gs; zx++) {
            let sH = 0, sS = 0, sV = 0, cnt = 0;
            for (let y = Math.floor(zy * zs); y < Math.floor((zy + 1) * zs); y++)
                for (let x = Math.floor(zx * zs); x < Math.floor((zx + 1) * zs); x++) {
                    const i = (y * ws + x) * 4, [h, s, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
                    sH += h; sS += s; sV += v; cnt++;
                }
            sig.push(cnt ? [sH / cnt, sS / cnt, sV / cnt] : [0, 0, 0]);
        }
        return sig;
    }

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h, s = mx === 0 ? 0 : d / mx, v = mx;
        if (mx === mn) h = 0;
        else {
            switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; }
            h /= 6;
        }
        return [h, s, v];
    }

    // ========== UTILS & SCANNING ==========
    function updateButtonText(c) { if (uiBtn) uiBtn.innerText = `📷 Scan (${c})`; }
    function updateStatus(t) { if (statusDiv) { statusDiv.innerText = t; statusDiv.style.display = t ? 'block' : 'none'; } }
    async function getDBCount() { return (await GM.listValues()).filter(k => k.startsWith(DB_PREFIX)).length; }
    async function addFileToDB(d) { await GM.setValue(DB_PREFIX + d.nodeId, d); }
    async function checkFileExists(id) { return !!(await GM.getValue(DB_PREFIX + id)); }
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getCurrentPath() {
        let p = '';
        document.querySelectorAll('.fm-breadcrumbs').forEach(c => { p += '/' + (c.innerText || '').trim(); });
        return p || '/root';
    }

    async function waitForBatchLoading(imgs, timeout = 3000) {
        if (!imgs.length) return;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (imgs.every(i => i.src?.startsWith('blob:') && i.complete && i.naturalWidth > 0)) return;
            await delay(200);
        }
    }

    async function scanCurrentFolder() {
        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) return 0;
        scroller.scrollTop = 0;
        await delay(1000);
        let count = 0, stuck = 0;
        const processed = new Set();

        while (!cancelRequested) {
            const images = Array.from(scroller.querySelectorAll('.fm-item-img img')), candidates = [];

            for (let img of images) {
                let container = img.closest('[id^="th_"]') || img.closest('.mega-item-square') || img.closest('a.mega-node');
                if (!container && img.parentElement) container = img.parentElement.parentElement;

                let name = 'Unknown';
                if (container) {
                    const ne = container.querySelector('.block-view-file-name, .file-name, .fm-item-name');
                    if (ne) name = (ne.innerText || '').split('\n')[0].trim();
                }

                let nodeId = container?.id?.startsWith('th_') ? container.id : (container?.dataset?.nodeId || null);
                if (!nodeId) nodeId = 'gen_' + getCurrentPath() + '_' + name;

                if (!processed.has(nodeId) && !(await checkFileExists(nodeId))) candidates.push({ img, nodeId, name });
                else processed.add(nodeId);
            }

            if (candidates.length) await waitForBatchLoading(candidates.map(c => c.img), IMAGE_LOAD_TIMEOUT);

            for (let { img, nodeId, name } of candidates) {
                if (cancelRequested) break;
                if (!img.complete || !img.naturalWidth || !img.src?.startsWith('blob:')) continue;
                try {
                    const desc = await getImageDescriptor(img);
                    if (!desc) continue;
                    const rec = {
                        nodeId, name, path: getCurrentPath(),
                        globalHash: desc.globalHash, blocks: desc.blocks,
                        colorSig: desc.colorSig, multiScale: desc.multiScale,
                        fingerprint: desc.fingerprint, // NEW v10.0
                        timestamp: Date.now()
                    };
                    await addFileToDB(rec);
                    if (RAM_DB) RAM_DB.push(rec);
                    processed.add(nodeId);
                    count++;
                    updateStatus(`Indexed: ${count}`);
                } catch (e) { console.error(e); }
            }

            if (cancelRequested) break;
            const prev = scroller.scrollTop;
            scroller.scrollBy(0, FILE_SCROLL_STEP);
            await delay(FILE_SCROLL_DELAY);
            if (Math.abs(scroller.scrollTop - prev) < 5) { stuck++; if (stuck >= 2) break; } else stuck = 0;
        }
        return count;
    }

    function triggerDoubleClick(el) { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: unsafeWindow })); }
    function goBack() { const c = document.querySelectorAll('.fm-breadcrumbs'); if (c.length >= 2) { c[c.length - 2].click(); return true; } return false; }
    function waitForContentChange() { return delay(NAVIGATION_DELAY); }
    function getFolderName(el) {
        const n = el.querySelector('.fm-item-name, .tranfer-filetype-txt, .block-view-file-name, .file-name, span.name');
        return n ? (n.innerText || '').trim() : (el.innerText || '').split('\n')[0].trim();
    }

    function getAllFolderContainers() {
        const result = [], seen = new Set();
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
        await scanCurrentFolder();

        const scroller = document.querySelector('.file-block-scrolling');
        if (scroller) { scroller.scrollTop = 0; await delay(1000); }

        while (!cancelRequested) {
            const next = findNextUnvisitedFolder();
            if (!next) {
                if (scroller && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 50) {
                    const prev = scroller.scrollTop;
                    scroller.scrollBy(0, FOLDER_SEARCH_STEP);
                    await delay(FOLDER_SEARCH_DELAY);
                    if (Math.abs(scroller.scrollTop - prev) < 5) break;
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
            if (cancelRequested) break;
            goBack();
            await waitForContentChange();
        }
    }

    async function startDeepIndexing() {
        if (isRunning) return;
        isRunning = true; cancelRequested = false; visitedFolderKeys.clear();
        uiBtn.disabled = true; uiBtn.innerText = '⏳ Scanning...';
        cancelBtn.disabled = false; cancelBtn.style.opacity = '1'; cancelBtn.innerText = '✖ Stop';
        if (searchBtn) searchBtn.disabled = true;

        try {
            updateStatus('Starting v10.0...');
            await deepScanCurrentFolder(0);
            alert('✅ Done!');
        } catch (e) { console.error(e); alert('Error: ' + e.message); }
        finally {
            isRunning = false; cancelRequested = false; updateStatus('');
            uiBtn.disabled = false; updateButtonText(await getDBCount());
            cancelBtn.disabled = true; cancelBtn.style.opacity = '0.5';
            if (searchBtn) searchBtn.disabled = false;
        }
    }

    const check = setInterval(async () => {
        if (document.querySelector('.file-block-scrolling')) {
            clearInterval(check);
            createUI(await getDBCount());
        }
    }, 1000);

    // ==============================================
    // --- DEBUG TOOLS v10.0 ---
    // ==============================================
    unsafeWindow.MegaDebug = {
        getSearchHash: () => {
            if (!window.LAST_SEARCH_DESC) return console.log("❌ No search");
            console.log("📋 Search descriptor:", window.LAST_SEARCH_DESC);
            console.log("   Fingerprint length:", window.LAST_SEARCH_DESC.fingerprint?.length || 0);
        },

        findTarget: async (namePart) => {
            if (!RAM_DB) await loadDatabaseToMemory();
            const matches = RAM_DB.filter(r => r.name.toLowerCase().includes(namePart.toLowerCase()));
            if (!matches.length) return console.log(`❌ "${namePart}" not in DB`);

            console.log(`📂 Found ${matches.length} matches for "${namePart}":`);
            matches.forEach((m, i) => {
                console.log(`  ${i + 1}. ${m.name} @ ${m.path}`);
                console.log(`     FP: ${m.fingerprint ? 'YES (' + m.fingerprint.length + ')' : 'NO'}`);
                console.log(`     MS: ${Object.keys(m.multiScale || {}).join(',')}`);
            });

            if (matches.length === 1) {
                window.LAST_DB_RECORD = matches[0];
                console.log("✅ Set as LAST_DB_RECORD for compare()");
            }
            return matches;
        },

        compare: () => {
            if (!window.LAST_SEARCH_DESC || !window.LAST_DB_RECORD) {
                return console.log("❌ Need both search and DB record. Use findTarget() first");
            }

            const q = window.LAST_SEARCH_DESC;
            const r = window.LAST_DB_RECORD;

            // Fingerprint
            let fpSim = -1;
            if (q.fingerprint && r.fingerprint && q.fingerprint.length === r.fingerprint.length) {
                let matching = 0;
                for (let i = 0; i < q.fingerprint.length; i++) {
                    if (Math.abs(q.fingerprint[i] - r.fingerprint[i]) <= 15) matching++;
                }
                fpSim = matching / q.fingerprint.length;
            }

            console.group(`📊 Compare: Query vs "${r.name}"`);
            console.log(`🔑 Fingerprint: ${fpSim >= 0 ? (fpSim * 100).toFixed(1) + '%' : 'N/A'}`);
            if (fpSim >= CONFIG.FINGERPRINT_EXACT_THRESHOLD) {
                console.log(`   ⭐ EXACT MATCH BONUS APPLIED!`);
            }
            console.log(`📐 Global Hash dist: check manually`);
            console.log(`🎨 Has color sig: ${q.colorSig && r.colorSig ? 'YES' : 'NO'}`);
            console.groupEnd();

            return { fpSim };
        },

        showResults: () => {
            if (!window.LAST_SEARCH_RESULTS) return console.log("❌ No results");
            console.table(window.LAST_SEARCH_RESULTS.map(r => ({
                name: r.name.substring(0, 30),
                type: r.matchType,
                FP: r.fingerprintSim >= 0 ? Math.round(r.fingerprintSim * 100) + '%' : '-',
                MS: Math.round(r.multiScaleSim * 100) + '%',
                final: Math.round(r.finalScore * 100) + '%'
            })));
        },

        dbStats: async () => {
            if (!RAM_DB) await loadDatabaseToMemory();
            const total = RAM_DB.length;
            const withFP = RAM_DB.filter(r => r.fingerprint).length;
            const withMS = RAM_DB.filter(r => r.multiScale).length;
            console.log(`📊 DB: ${total} total, ${withFP} with fingerprint, ${withMS} with multiScale`);
        }
    };

})();