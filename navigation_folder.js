// ==UserScript==
// @name         Mega.nz Spider (Step 5: One-Step-Deep v1.5 Grid+List Unified)
// @namespace    Violentmonkey Scripts
// @match        https://mega.nz/*
// @match        https://mega.io/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const DB_PREFIX = 'MegaSearchDB_v1:';
    let isRunning = false;

    console.log('🕷️ Spider v1.5 (Grid+List Unified) Loaded.');

    // ==============================================
    // --- 1. UI ---
    // ==============================================
    setTimeout(() => {
        const btn = document.createElement('button');
        btn.innerText = '🕷️ Start Spider Test';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            padding: 15px;
            background-color: #6f42c1;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `;
        btn.onclick = runSpiderTest;
        document.body.appendChild(btn);
    }, 2000);

    // ==============================================
    // --- 2. Логика Паука ---
    // ==============================================
    async function runSpiderTest() {
        if (isRunning) return;
        isRunning = true;

        console.clear();
        console.log('🚀 [Spider] START TEST: Scan -> Enter -> Scan -> Back');

        try {
            // 1. Скан корня
            await scanCurrentFolder("ROOT");

            // 2. Поиск папки — УНИВЕРСАЛЬНЫЙ метод (как в v1.1, но с логированием режима)
            const firstFolder = findFolderElement();
            if (!firstFolder) {
                console.warn('⚠️ [Spider] Папок не найдено.');
                alert('В текущей папке нет подпапок. Перейди туда, где они есть.');
                return;
            }

            console.log('📂 [Spider] Найдена папка:', firstFolder);
            firstFolder.style.border = "3px solid #6f42c1";
            firstFolder.style.backgroundColor = "rgba(111, 66, 193, 0.1)";

            await delay(500);

            // ВХОД
            triggerDoubleClick(firstFolder);

            // Ждем смены контента
            await waitForContentChange();

            // 3. Скан внутри
            console.log('📂 [Spider] Внутри! Сканируем...');
            await scanCurrentFolder("SUBFOLDER");

            // 4. Выход
            console.log('⬅️ [Spider] Выходим назад...');
            const goneBack = goBack();
            if (goneBack) {
                await waitForContentChange();
                console.log('✅ [Spider] ТЕСТ ПРОЙДЕН!');
                alert('Успех! Навигация работает в обоих режимах.');
            } else {
                console.error('❌ [Spider] Не нашел кнопку "Назад".');
            }
        } finally {
            isRunning = false;
        }
    }

    // ==============================================
    // --- 3. Навигация (Универсальная + с логированием режима) ---
    // ==============================================
    function findFolderElement() {
        // Сначала попробуем специфичные селекторы для LIST и GRID
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

        // Если ничего не нашли — fallback как в v1.1 (универсальный поиск)
        console.log('🔎 Режим: Fallback (универсальный поиск)');
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
            console.log('⏳ Ждем загрузки (2.5 сек)...');
            setTimeout(resolve, 2500); // чуть дольше для надёжности
        });
    }

    function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ==============================================
    // --- 4. Сканнер (Hybrid из v1.3) ---
    // ==============================================
    async function scanCurrentFolder(label) {
        console.log(`📸 [Scan: ${label}] ...`);

        const scroller = document.querySelector('.file-block-scrolling');
        if (!scroller) {
            console.log('⚠️ [Scan] Не найден контейнер .file-block-scrolling');
            return;
        }

        scroller.scrollTop = 0;
        await delay(500);

        // 1. Попытка для СПИСКА
        const allRows = Array.from(document.querySelectorAll('tr.megaListItem'));
        const fileRows = allRows.filter(row =>
            !row.querySelector('.icon-folder-24') &&
            !row.querySelector('.folder')
        );

        if (fileRows.length > 0) {
            console.log(`👁️ [Scan: ${label}] Найдено файлов (Список): ${fileRows.length}`);
            await GM.setValue(DB_PREFIX + 'test_list_' + label, {
                count: fileRows.length,
                ts: Date.now()
            });
            return;
        }

        // 2. Попытка для СЕТКИ
        const gridImages = document.querySelectorAll('.fm-item-img img');
        let validImages = 0;
        gridImages.forEach(img => {
            if (img.naturalWidth > 50) validImages++;
        });

        if (validImages > 0) {
            console.log(`👁️ [Scan: ${label}] Найдено файлов (Сетка): ${validImages}`);
            await GM.setValue(DB_PREFIX + 'test_grid_' + label, {
                count: validImages,
                ts: Date.now()
            });
            return;
        }

        console.log(`⚠️ [Scan: ${label}] Файлов не найдено (пустая папка или одни папки).`);
    }

})();// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      -
// @description 28.11.2025, 18:10:15
// ==/UserScript==
