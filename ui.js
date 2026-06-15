/* ============================================================
   KPSS ATLAS — UI Patch v2 (Neo-Academic Redesign)
   Bu dosya, script.js'deki renderMenu ve diğer render
   fonksiyonlarını yeni tasarıma uyarlar.
   script.js'den SONRA yüklenmeli.
   ============================================================ */

(function() {
    'use strict';

    /* ── Yardımcı: back butonunu yeni tasarımla güncelle ── */
    function updateBackBtn(show) {
        const btn = document.getElementById('back-btn');
        if (!btn) return;
        if (show) {
            btn.classList.add('visible');
            // İkon + metin
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 11L5 7L9 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg> Geri Dön`;
        } else {
            btn.classList.remove('visible');
        }
    }

    /* ── renderMenu override ── */
    const _origRenderMenu = window.renderMenu;
    window.renderMenu = function(items) {
        const menuArea   = document.getElementById('menu-area');
        const gameArea   = document.getElementById('game-area');
        const currentTitle = document.getElementById('current-title');
        const backBtn    = document.getElementById('back-btn');
        if (!menuArea) return _origRenderMenu && _origRenderMenu(items);

        menuArea.innerHTML = '';
        menuArea.style.display = 'grid';
        if (gameArea) gameArea.style.display = 'none';

        // Daily widget kaldır
        const dw = document.getElementById('daily-widget');
        if (dw) dw.remove();

        // findMenuIdByItems ve findParentMenuId script.js'de tanımlı
        const currentMenuId = typeof findMenuIdByItems === 'function' ? findMenuIdByItems(items) : 'main';
        const parentId = typeof findParentMenuId === 'function' ? findParentMenuId(currentMenuId) : null;

        if (currentMenuId === 'main') {
            updateBackBtn(false);
            if (currentTitle) currentTitle.innerText = 'Dersler';
        } else {
            updateBackBtn(true);
            if (backBtn) {
                backBtn.onclick = () => {
                    if (parentId && appData[parentId]) {
                        renderMenu(appData[parentId]);
                        if (typeof updateTitleForMenu === 'function') updateTitleForMenu(parentId);
                    } else {
                        renderMenu(appData.main);
                        if (currentTitle) currentTitle.innerText = 'Dersler';
                    }
                };
            }
        }

        // İlk render — ana menü ise hero banner ekle
        if (currentMenuId === 'main') {
            _injectHeroBanner(menuArea);
        }

        items.forEach((item, idx) => {
            const card = document.createElement('div');
            card.className = 'menu-card';
            card.style.animationDelay = `${idx * 0.04}s`;

            const isDisabled = item.type === 'none';
            const badgeText = item.type === 'quiz' ? 'Quiz' :
                              item.type === 'menu' ? 'Menü' :
                              item.type === 'game' ? 'Harita' :
                              item.type === 'turkce-mini' ? 'Kart' : '';

            // Progress yükle
            let progressPct = 0;
            if (!isDisabled && typeof loadQuizStats === 'function' && appData.quizData && appData.quizData[item.id]) {
                const stats  = loadQuizStats(item.id);
                const totalQ = (appData.quizData[item.id] || []).length;
                if (stats && stats.sessions > 0 && totalQ > 0) {
                    progressPct = Math.min(100, Math.round(((stats.correct || 0) / totalQ) * 100));
                }
            }

            card.innerHTML = `
                ${badgeText ? `<span class="menu-card-badge ${item.type === 'quiz' ? 'quiz' : ''}">${isDisabled ? 'Yakında' : badgeText}</span>` : (isDisabled ? '<span class="menu-card-badge">Yakında</span>' : '')}
                <div class="menu-card-icon">${item.icon || '📚'}</div>
                <div class="menu-card-content">
                    <div class="menu-card-title">${item.title}</div>
                    ${item.desc ? `<div class="menu-card-desc">${item.desc}</div>` : ''}
                </div>
                ${progressPct > 0 ? `<div class="menu-card-progress"><div class="menu-card-progress-fill" style="width:${progressPct}%"></div></div>` : ''}
                ${!isDisabled ? `<div class="menu-card-arrow">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                        <path d="M4 10L8 6.5L4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>` : ''}
            `;

            if (!isDisabled) {
                card.onclick = () => typeof handleSelection === 'function' ? handleSelection(item) : null;
            } else {
                card.style.opacity = '0.5';
                card.style.cursor = 'default';
                card.style.pointerEvents = 'none';
            }

            menuArea.appendChild(card);
        });
    };

    /* ── Ana menü hero banner ── */
    function _injectHeroBanner(menuArea) {
        // Üst kısma hero ekle — grid dışında bir container ile
        const hero = document.createElement('div');
        hero.id = 'home-hero';
        hero.style.cssText = `
            grid-column: 1 / -1;
            background: var(--panel-2);
            border: 1px solid var(--line-2);
            border-radius: var(--r-xl);
            padding: 24px 28px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 20px;
            overflow: hidden;
            position: relative;
            margin-bottom: 4px;
            animation: cardEnter 0.4s var(--ease-out) both;
        `;

        // Günlük hedef bilgisi
        const todayStr = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

        hero.innerHTML = `
            <div style="position:relative;z-index:1;">
                <div style="font-family:Playfair Display, serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">${todayStr}</div>
                <div style="font-family:Playfair Display, serif;font-size:22px;font-weight:800;color:var(--t-100);letter-spacing:-0.02em;line-height:1.15;">
                    Derse Devam Et
                </div>
                <div style="font-size:13px;color:var(--t-400);margin-top:4px;">Çalışmak istediğin dersi seç</div>
            </div>
            <div style="position:absolute;right:-20px;top:-20px;width:160px;height:160px;border-radius:50%;border:1px solid var(--gold-line);opacity:0.3;pointer-events:none;"></div>
            <div style="position:absolute;right:20px;top:20px;width:80px;height:80px;border-radius:50%;border:1px solid var(--gold-line);opacity:0.2;pointer-events:none;"></div>
        `;

        menuArea.insertBefore(hero, menuArea.firstChild);
    }

    /* ── renderTopicSelection override ── */
    const _origRenderTopicSelection = window.renderTopicSelection;
    window.renderTopicSelection = function(dersId, dersTitle) {
        const menuArea     = document.getElementById('menu-area');
        const currentTitle = document.getElementById('current-title');
        const backBtn      = document.getElementById('back-btn');
        if (!menuArea) return _origRenderTopicSelection && _origRenderTopicSelection(dersId, dersTitle);

        // Daily widget kaldır
        const dw = document.getElementById('daily-widget');
        if (dw) dw.remove();

        window.activeTopicDersId = dersId;
        const topics = (appData[dersId] || []).filter(t => t.type === 'quiz');
        const weakTopics = [];

        const topicItemsHtml = topics.map(topic => {
            let progressPct = 0;
            let seenLabel   = '';
            let cardClass   = '';
            let statHtml    = '';

            if (typeof loadQuizStats === 'function') {
                const stats  = loadQuizStats(topic.id);
                const totalQ = (appData.quizData && appData.quizData[topic.id] || []).length;
                if (stats && stats.sessions > 0 && totalQ > 0) {
                    const correct = stats.correct || 0;
                    progressPct = Math.min(100, Math.round((correct / totalQ) * 100));
                    const seen  = Math.min(correct + (stats.wrong||0) + (stats.shown||0), totalQ);
                    seenLabel   = `${seen}/${totalQ}`;
                    if (progressPct < 50)  { weakTopics.push(topic); cardClass = 'weak'; }
                    else if (progressPct >= 80) cardClass = 'strong';

                    const pColor = progressPct >= 80 ? 'var(--green)' : progressPct >= 50 ? 'var(--amber)' : 'var(--gold)';
                    statHtml = `
                        <span style="font-family:Playfair Display, serif;font-size:10px;font-weight:700;color:${pColor};background:${pColor}22;padding:2px 7px;border-radius:var(--r-full);">%${progressPct}</span>
                        <button class="topic-reset-btn" title="Sıfırla" data-topic-id="${topic.id}" data-topic-title="${topic.title.replace(/"/g,'&quot;')}"
                            style="font-size:12px;color:var(--t-400);background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px;transition:color 0.1s;"
                            onmouseenter="this.style.color='var(--t-100)'" onmouseleave="this.style.color='var(--t-400)'">↺</button>
                    `;
                }
            }

            const totalQ2 = (appData.quizData && appData.quizData[topic.id] || []).length;

            return `
                <label class="topic-item ${cardClass}" data-title="${topic.title.toLocaleLowerCase('tr')}">
                    <input type="checkbox" name="history-topic" value="${topic.id}" style="display:none;">
                    <div class="topic-check">
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>
                    <span class="topic-icon">${topic.icon || '📚'}</span>
                    <div class="topic-info">
                        <div class="topic-name">${topic.title}</div>
                        ${topic.desc ? `<div class="topic-desc">${topic.desc}</div>` : ''}
                        ${progressPct > 0 ? `<div class="menu-card-progress" style="margin-top:5px;"><div class="menu-card-progress-fill" style="width:${progressPct}%;background:${progressPct>=80?'var(--green)':progressPct>=50?'var(--amber)':'var(--gold)'};"></div></div>` : ''}
                    </div>
                    <div class="topic-meta">
                        ${totalQ2 > 0 ? `<span class="topic-count">${totalQ2}</span>` : ''}
                        ${statHtml}
                    </div>
                </label>
            `;
        }).join('');

        // Zayıf konu banner
        const weakBannerHtml = weakTopics.length > 0 ? `
            <div style="background:var(--amber-bg);border:1px solid rgba(240,160,48,0.25);border-radius:var(--r-md);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:18px;">⚠️</span>
                    <div>
                        <div style="font-family:Playfair Display, serif;font-size:12px;font-weight:700;color:var(--amber);">${weakTopics.length} zayıf konu</div>
                        <div style="font-size:11px;color:var(--t-400);margin-top:1px;">${weakTopics.map(t=>t.title).slice(0,3).join(', ')}${weakTopics.length>3?'...':''}</div>
                    </div>
                </div>
                <button id="btn-weak-topics" style="padding:7px 14px;border-radius:var(--r-full);background:var(--amber);border:none;color:#fff;font-family:Playfair Display, serif;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:opacity 0.1s;" onmouseenter="this.style.opacity='0.8'" onmouseleave="this.style.opacity='1'">Tekrar Çalış</button>
            </div>
        ` : '';

        menuArea.innerHTML = `
            <div class="selection-container">
                <div class="selection-header">
                    <div class="selection-header-left">
                        <div class="selection-title">${dersTitle}</div>
                        <div class="selection-sub">Çalışmak istediğin konuları seç</div>
                    </div>
                    <div class="selection-header-right">
                        <button class="btn-start-quiz" id="btn-start-mixed" disabled style="opacity:0.4;cursor:not-allowed;">
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 6.5H10M7 3.5L10 6.5L7 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            Başlat
                        </button>
                    </div>
                </div>

                ${weakBannerHtml}

                <div class="selection-controls">
                    <div style="display:flex;gap:8px;">
                        <button class="select-all-btn" id="btn-select-all">Tümünü Seç</button>
                        <button class="select-all-btn" id="btn-select-none" style="color:var(--t-400);">Temizle</button>
                    </div>
                    <div class="selected-count" id="selected-count">0 konu seçili</div>
                </div>

                <div style="margin-bottom:10px;">
                    <input type="text" id="topic-search" placeholder="Konu ara..."
                        style="width:100%;padding:9px 14px;border-radius:var(--r-md);background:var(--bg-2);border:1.5px solid var(--line-2);color:var(--t-100);font-family:DM Sans, sans-serif;font-size:13px;outline:none;transition:border-color 0.2s;"
                        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                        onfocus="this.style.borderColor='var(--gold-line)'" onblur="this.style.borderColor='var(--line-2)'">
                </div>

                <div class="topic-list" id="topic-list">
                    ${topicItemsHtml}
                </div>
            </div>
        `;

        // Event binding
        const weakBtn = menuArea.querySelector('#btn-weak-topics');
        if (weakBtn && typeof selectWeakTopics === 'function') {
            weakBtn.addEventListener('click', () => selectWeakTopics(weakTopics.map(t => t.id)));
        }

        const selectAllBtn = menuArea.querySelector('#btn-select-all');
        if (selectAllBtn && typeof selectAllTopics === 'function') selectAllBtn.addEventListener('click', selectAllTopics);

        const selectNoneBtn = menuArea.querySelector('#btn-select-none');
        if (selectNoneBtn && typeof selectNoTopics === 'function') selectNoneBtn.addEventListener('click', selectNoTopics);

        const startBtn = menuArea.querySelector('#btn-start-mixed');
        if (startBtn && typeof startMixedQuiz === 'function') {
            startBtn.addEventListener('click', () => {
                const anyChecked = menuArea.querySelectorAll('input[name="history-topic"]:checked').length > 0;
                if (anyChecked) startMixedQuiz();
            });
        }

        const searchInput = menuArea.querySelector('#topic-search');
        if (searchInput && typeof filterTopics === 'function') {
            searchInput.addEventListener('input', e => filterTopics(e.target.value));
        }

        // Reset butonları
        menuArea.querySelector('#topic-list').addEventListener('click', e => {
            const resetBtn = e.target.closest('.topic-reset-btn');
            if (resetBtn) {
                e.preventDefault(); e.stopPropagation();
                if (typeof confirmResetTopic === 'function') confirmResetTopic(resetBtn.dataset.topicId, resetBtn.dataset.topicTitle);
            }
        });

        // Checkbox sync
        menuArea.querySelector('#topic-list').addEventListener('change', e => {
            if (e.target.matches('input[name="history-topic"]')) {
                const item = e.target.closest('.topic-item');
                if (item) item.classList.toggle('selected', e.target.checked);
                _updateSelectionUI();
            }
        });

        // Mobil tap
        (function attachTap(list) {
            let sy = 0, sx = 0, sl = null;
            list.addEventListener('touchstart', e => {
                const label = e.target.closest('.topic-item');
                if (!label || e.target.closest('.topic-reset-btn')) { sl = null; return; }
                sl = label; sy = e.touches[0].clientY; sx = e.touches[0].clientX;
            }, { passive: true });
            list.addEventListener('touchmove', e => {
                if (!sl) return;
                if (Math.abs(e.touches[0].clientY-sy) > 8 || Math.abs(e.touches[0].clientX-sx) > 8) sl = null;
            }, { passive: true });
            list.addEventListener('touchend', () => {
                if (!sl) return;
                const cb = sl.querySelector('input[name="history-topic"]');
                if (!cb) { sl = null; return; }
                sl.classList.toggle('selected', !cb.checked);
                _updateSelectionUI();
                sl = null;
            }, { passive: true });
        })(menuArea.querySelector('#topic-list'));

        function _updateSelectionUI() {
            const checkboxes = menuArea.querySelectorAll('input[name="history-topic"]');
            const checked = [...checkboxes].filter(c => c.checked).length;
            const startBtn2 = menuArea.querySelector('#btn-start-mixed');
            const countEl  = menuArea.querySelector('#selected-count');
            if (countEl) countEl.textContent = `${checked} konu seçili`;
            if (startBtn2) {
                const enabled = checked > 0;
                startBtn2.disabled = !enabled;
                startBtn2.style.opacity = enabled ? '1' : '0.4';
                startBtn2.style.cursor  = enabled ? 'pointer' : 'not-allowed';
            }
            // script.js'deki updateSelectionCounter ile senkron kal
            if (typeof updateSelectionCounter === 'function') updateSelectionCounter();
        }

        menuArea.style.display = 'block';
        if (currentTitle) currentTitle.innerText = dersTitle + ' — Konu Seçimi';
        updateBackBtn(true);
        if (backBtn) {
            backBtn.onclick = () => {
                menuArea.style.display = 'grid';
                const parentId = typeof findParentMenuId === 'function' ? findParentMenuId(dersId) : null;
                if (parentId && appData[parentId]) {
                    renderMenu(appData[parentId]);
                    if (typeof updateTitleForMenu === 'function') updateTitleForMenu(parentId);
                } else {
                    renderMenu(appData.main);
                    if (currentTitle) currentTitle.innerText = 'Dersler';
                }
            };
        }
    };

    /* ── Modal animasyonu — overlay + modal aktifleştirme ── */
    // Orijinal showModal / closeModal'ı hook et
    const _patchModal = () => {
        const overlay = document.getElementById('modal-overlay');
        const modal   = document.getElementById('question-modal');
        if (!overlay || !modal) return;

        // MutationObserver ile script.js'in display değişikliğini yakala
        const styleObserver = new MutationObserver(() => {
            const isVisible = modal.style.display !== 'none' && modal.style.display !== '';
            overlay.classList.toggle('active', isVisible);
            modal.classList.toggle('active', isVisible);
        });
        styleObserver.observe(modal, { attributes: true, attributeFilter: ['style'] });

        // overlay tıklandığında kapat
        overlay.addEventListener('click', () => {
            if (typeof closeModal === 'function') closeModal();
        });
    };

    /* ── Tema toggle — yeni ikon ── */
    const _patchThemeIcon = () => {
        const origToggle = window.toggleTheme;
        window.toggleTheme = function() {
            if (origToggle) origToggle();
            _syncThemeIcon();
        };

        function _syncThemeIcon() {
            const iconEl = document.getElementById('mh-theme-icon');
            if (!iconEl) return;
            const isDark = document.documentElement.getAttribute('data-theme') !== 'light' &&
                           !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
            iconEl.innerHTML = isDark
                ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 10.5C12.5 12.5 10.5 14 8 14C4.686 14 2 11.314 2 8C2 5.5 3.5 3.5 5.5 2.5C4.5 3.5 4 4.7 4 6C4 9.314 6.686 12 10 12C11.3 12 12.5 11.5 13.5 10.5Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
                : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1V2M8 14V15M1 8H2M14 8H15M3.05 3.05L3.76 3.76M12.24 12.24L12.95 12.95M3.05 12.95L3.76 12.24M12.24 3.76L12.95 3.05M11 8C11 9.657 9.657 11 8 11C6.343 11 5 9.657 5 8C5 6.343 6.343 5 8 5C9.657 5 11 6.343 11 8Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
        }
    };

    /* ── Leaflet harita stil patch ── */
    const _patchLeaflet = () => {
        // Harita başlatıldığında GeoJSON stil override
        const origStartGame = window.startGame;
        if (origStartGame) {
            window.startGame = function(...args) {
                origStartGame.apply(this, args);
                // Kısa gecikme sonra layer stillerini tema ile güncelle
                // CSS variable'lar Leaflet'e string olarak geçilemez — getComputedStyle kullan
                setTimeout(() => {
                    const mapObj = window.map; // script.js'deki global 'map' değişkeni
                    if (!mapObj) return;
                    const cs = getComputedStyle(document.documentElement);
                    const fillColor = cs.getPropertyValue('--bg-3').trim() || '#1c1c21';
                    const strokeColor = cs.getPropertyValue('--line-3').trim() || 'rgba(255,255,255,0.16)';
                    mapObj.eachLayer(layer => {
                        if (layer.setStyle) {
                            layer.setStyle({
                                fillColor,
                                color: strokeColor,
                                weight: 1,
                                fillOpacity: 0.8
                            });
                        }
                    });
                }, 500);
            };
        }
    };

    /* ── Feedback class normalizasyonu ── */
    // script.js feedback'i doğrudan innerHTML + color ile set ediyor.
    // Biz bunu class bazlı sisteme çekiyoruz.
    const _patchFeedback = () => {
        const fb = document.getElementById('feedback');
        if (!fb) return;

        const fbObserver = new MutationObserver(() => {
            // script.js inline style kullandıysa sil, class ile yönet
            if (fb.style.color && fb.style.color.includes('green')) {
                fb.className = 'correct';
                fb.style.cssText = '';
            } else if (fb.style.color && (fb.style.color.includes('red') || fb.style.color.includes('#c9'))) {
                fb.className = 'wrong';
                fb.style.cssText = '';
            } else if (fb.style.color && fb.style.color.includes('blue')) {
                fb.className = 'info';
                fb.style.cssText = '';
            }
        });
        fbObserver.observe(fb, { attributes: true, attributeFilter: ['style'] });
    };

    /* ── showStatsModal / showSettingsModal / showProfileModal ─
       Bu modallar script.js'de oluşturuluyor.
       Oluşturulan .modal elementine yeni tasarım class'ı ekle ── */
    const _patchModalSheets = () => {
        const body = document.body;
        const bodyObserver = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    if (node.classList && node.classList.contains('modal')) {
                        _styleModal(node);
                    }
                });
            });
        });
        bodyObserver.observe(body, { childList: true });
    };

    function _styleModal(modalEl) {
        // backdrop
        const backdrop = modalEl.querySelector('.modal-backdrop') || modalEl.querySelector('[class*="backdrop"]');
        // inner sheet
        const sheet = modalEl.querySelector('.modal-content') || modalEl.querySelector('[class*="content"]') || modalEl.querySelector('[class*="card"]') || modalEl.firstElementChild;
        if (sheet && !sheet.classList.contains('modal-sheet')) {
            sheet.classList.add('modal-sheet');
        }
    }

    /* ── DOMContentLoaded sonrası patch'leri uygula ── */
    function applyPatches() {
        _patchModal();
        _patchThemeIcon();
        _patchLeaflet();
        _patchFeedback();
        _patchModalSheets();
        console.log('[KPSS Atlas] UI Patch v2 aktif');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyPatches);
    } else {
        applyPatches();
    }

})();