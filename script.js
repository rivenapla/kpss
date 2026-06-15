/* ==============================================
   UYGULAMA MANTIĞI (DERSLER & KONULAR)
   ============================================== */

let map = null;
let currentMarkers = [];
let currentMountain = null;
let currentGameId = null;
let score = { correct: 0, wrong: 0, shown: 0 };

// --- QUIZ STATE — tüm quiz değişkenleri tek objede ---
// Getter/setter bridge: mevcut kod değişmeden çalışır, reset güvenli olur
const _quizStateDefaults = () => ({
    currentQuiz:        [],
    questionIndex:      0,
    quizHistory:        [],
    historyViewIndex:   -1,
    currentHistoryItem: null,
    quizFinished:       false,
    requeuedIds:        new Set(),
    originalQuizLength: 0,
    hintTokens:         3,
    hintLevel:          0,
    wrongAttempts:      0,
    _pendingAnswerTimeout: null,
});

const _qs = _quizStateDefaults();

// Proxy: mevcut global isimler _qs'e yönlenir
Object.defineProperties(window, {
    currentQuiz:        { get(){ return _qs.currentQuiz;        }, set(v){ _qs.currentQuiz = v;        }, configurable:true },
    questionIndex:      { get(){ return _qs.questionIndex;      }, set(v){ _qs.questionIndex = v;      }, configurable:true },
    quizHistory:        { get(){ return _qs.quizHistory;        }, set(v){ _qs.quizHistory = v;        }, configurable:true },
    historyViewIndex:   { get(){ return _qs.historyViewIndex;   }, set(v){ _qs.historyViewIndex = v;   }, configurable:true },
    currentHistoryItem: { get(){ return _qs.currentHistoryItem; }, set(v){ _qs.currentHistoryItem = v; }, configurable:true },
    quizFinished:       { get(){ return _qs.quizFinished;       }, set(v){ _qs.quizFinished = v;       }, configurable:true },
    requeuedIds:        { get(){ return _qs.requeuedIds;        }, set(v){ _qs.requeuedIds = v;        }, configurable:true },
    originalQuizLength: { get(){ return _qs.originalQuizLength; }, set(v){ _qs.originalQuizLength = v; }, configurable:true },
    hintTokens:         { get(){ return _qs.hintTokens;        }, set(v){ _qs.hintTokens = v;        }, configurable:true },
    hintLevel:          { get(){ return _qs.hintLevel;         }, set(v){ _qs.hintLevel = v;         }, configurable:true },
    wrongAttempts:      { get(){ return _qs.wrongAttempts;     }, set(v){ _qs.wrongAttempts = v;     }, configurable:true },
    _pendingAnswerTimeout: { get(){ return _qs._pendingAnswerTimeout; }, set(v){ _qs._pendingAnswerTimeout = v; }, configurable:true },
});

// Tek noktadan güvenli sıfırlama — artık tüm state garantili temizlenir
function _resetQuizState() {
    if (_qs._pendingAnswerTimeout) {
        clearTimeout(_qs._pendingAnswerTimeout);
    }
    const fresh = _quizStateDefaults();
    Object.assign(_qs, fresh);
    // BUG FIX: Object.assign Set'i reference ile kopyalar, yeni instance oluşturmaz.
    // Explicit atama garantili sıfırlar.
    _qs.requeuedIds = new Set();
    _qs.currentQuiz = [];
    _qs.quizHistory = [];
}

const MAX_WRONG_ATTEMPTS = 3;

// --- İPUCU SİSTEMİ ---
// (hintTokens ve hintLevel artık _qs içinde)

// DOM Elementleri
const menuArea = document.getElementById('menu-area');
const gameArea = document.getElementById('game-area');
const backBtn = document.getElementById('back-btn');
const currentTitle = document.getElementById('current-title');

// Cevap sonrası geçiş timeout'u — iptal edilebilmesi için ID saklanır
// Cevap sonrası otomatik geçişte closeModal çağrılıyor — bu "terk etme" sayılmaz
let _isAutoAdvancing = false;

function _scheduleNext(fn, defaultDelay) {
    if (_qs._pendingAnswerTimeout) clearTimeout(_qs._pendingAnswerTimeout);

    // Oto-geçiş ayarı: settings'den oku, fallback defaultDelay
    let delay = defaultDelay;
    const stored = localStorage.getItem('kpss_auto_adv');
    if (stored !== null) {
        const v = parseInt(stored, 10);
        if (!isNaN(v)) {
            if (v === 0) {
                // Kapalı: manuel "Devam" butonu göster
                _showManualNextBtn(fn);
                return;
            }
            delay = v;
        }
    }

    _qs._pendingAnswerTimeout = setTimeout(() => {
        _qs._pendingAnswerTimeout = null;
        // Manuel buton varsa kaldır
        const mb = document.getElementById('manual-next-btn');
        if (mb) mb.remove();
        _isAutoAdvancing = true;
        fn();
        _isAutoAdvancing = false;
    }, delay);
}

// NOT: renderMenu(appData.main) burada KASITLI olarak kaldırıldı.
// İlk renderMenu çağrısı artık dosyanın sonundaki _hookRenderMenu tanımlandıktan SONRA
// yapılır — böylece daily-widget hook'u ilk yüklemede de çalışır.

// ============================================================
// FİREBASE AUTH + FİRESTORE KATMANI
// localStorage tamamen kaldırıldı — tüm veri Firestore'da
// activeProfile: { name, isGuest, uid } — uid Firebase Auth uid'si
// ============================================================

let activeProfile = null;

// In-memory cache — Firestore'dan okunan veri burada tutulur
// Yazma: debounce ile Firestore'a gönderilir
let _profileCache  = null;   // { quizStats: {}, geoProgress: {} }
let _saveDebounceTimer = null;
const _SAVE_DEBOUNCE_MS = 2000; // Her cevap sonrası değil, 2sn sonra tek yazma

// Firestore'a güvenli yaz (uid gerekli), misafir için sessionStorage
async function _fsSet(data) {
    if (!activeProfile || activeProfile.isGuest) {
        try {
            sessionStorage.setItem('kpss_guest_data', JSON.stringify(data));
        } catch(e) {
            console.warn('[KPSS] sessionStorage yazma hatası:', e.message);
        }
        return;
    }
    if (!activeProfile.uid) return;
    try {
        const { db, doc, setDoc } = window._fb;
        await setDoc(doc(db, 'users', activeProfile.uid, 'data', 'profile'), data);
        console.log('[KPSS] Firestore kaydedildi. uid:', activeProfile.uid);
    } catch(e) {
        console.error('[KPSS] FIRESTORE YAZMA HATASI:', e.code, e.message);
        if (typeof showToast === 'function') {
            showToast('⚠️ Veri kaydedilemedi — bağlantını kontrol et', 'error', 4000);
        }
    }
}

// Firestore'dan oku, misafir için sessionStorage
async function _fsGet() {
    if (!activeProfile || activeProfile.isGuest) {
        try {
            const raw = sessionStorage.getItem('kpss_guest_data');
            return raw ? JSON.parse(raw) : null;
        } catch(e) {
            console.warn('[KPSS] sessionStorage okuma hatası:', e.message);
            return null;
        }
    }
    if (!activeProfile.uid) return null;
    try {
        const { db, doc, getDoc } = window._fb;
        const snap = await getDoc(doc(db, 'users', activeProfile.uid, 'data', 'profile'));
        if (snap.exists()) {
            console.log('[KPSS] Firestore veri yüklendi. uid:', activeProfile.uid);
            return snap.data();
        } else {
            console.log('[KPSS] Firestore kayıt yok (ilk kullanım). uid:', activeProfile.uid);
            return null;
        }
    } catch(e) {
        console.error('[KPSS] FIRESTORE OKUMA HATASI:', e.code, e.message);
        return null;
    }
}

// Firestore kaydını tamamen sil
async function _fsDelete() {
    if (!activeProfile || activeProfile.isGuest || !activeProfile.uid) return;
    try {
        const { db, doc, deleteDoc } = window._fb;
        await deleteDoc(doc(db, 'users', activeProfile.uid, 'data', 'profile'));
    } catch(e) {
        console.warn('[KPSS] Firestore silme hatası:', e.message);
    }
}

function getAllProfiles() {
    // Geriye dönük uyumluluk — tek kullanıcı modeli, cache döner
    return _profileCache ? { [activeProfile.name]: _profileCache } : {};
}

function saveAllProfiles(data) {
    // data = { [name]: profileData } formatında gelir (eski API uyumu)
    if (!activeProfile || activeProfile.isGuest) return;
    const profileData = data[activeProfile.name] || data[Object.keys(data)[0]];
    if (!profileData) return;
    _profileCache = profileData;

    if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(() => {
        _saveDebounceTimer = null;
        _fsSet(_profileCache);
    }, _SAVE_DEBOUNCE_MS);
}

function _invalidateProfileCache() {
    // Bekleyen yazma varsa iptal et (kaydetmeden temizle)
    if (_saveDebounceTimer) {
        clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = null;
    }
    _profileCache = null;
}

// Logout öncesi çağrılır: bekleyen veriyi Firestore'a KAYDEDIP cache'i temizler
async function _flushProfileCache() {
    if (_saveDebounceTimer) {
        clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = null;
    }
    if (_profileCache && activeProfile && !activeProfile.isGuest) {
        await _fsSet(_profileCache);
    }
    _profileCache = null;
}

function getProfileData(name) {
    if (!_profileCache) _profileCache = { quizStats: {}, geoProgress: {} };
    return _profileCache;
}

function setActiveProfile(profileObj) {
    activeProfile = profileObj;

    const badge = document.getElementById('header-badge');
    if (badge) {
        const initial = profileObj.isGuest ? '👤' : profileObj.name.charAt(0).toUpperCase();
        const name    = profileObj.isGuest ? 'Misafir' : profileObj.name;
        badge.innerHTML = `<span class="badge-avatar">${initial}</span><span class="badge-name">${name}</span>`;
        badge.style.display = 'flex';
        badge.style.cursor  = 'pointer';
        badge.title = 'İstatistikler & Profil';
        badge.onclick = () => showStatsModal();
    }
}

// ---- Veri okuma / yazma (profile-aware) ----

// Soru bazlı kayıt: her soruyu ID ile takip eder.
// Yapı: p.quizStats[topicId] = { questionMap: {[id]: 'correct'|'wrong'|'shown'}, sessions, lastPlayed }
// loadQuizStats hâlâ { correct, wrong, shown, sessions, lastPlayed } döner — mevcut kod değişmez.
// --- questionMap FORMAT ---
// Her entry obje formatında tutulur:
//   { status: 'correct'|'wrong'|'shown', wrongCount: N, firstSeen: ts, lastSeen: ts }
// Geriye dönük: eski string entry'ler (_qEntry ile) otomatik normalize edilir.

function _qEntry(existing, status, now, attemptsUsed) {
    const prev = (existing && typeof existing === 'object') ? existing : {
        status:          (typeof existing === 'string') ? existing : null,
        wrongCount:      0,
        attemptsToSolve: null,   // kaçıncı denemede bildi (null = henüz bilinmiyor)
        firstSeen:       now,
        lastSeen:        now
    };

    if (prev.status === 'correct' && status !== 'correct') return prev;

    return {
        status,
        wrongCount:      status === 'wrong' ? (prev.wrongCount || 0) + 1 : (prev.wrongCount || 0),
        attemptsToSolve: status === 'correct' ? (attemptsUsed ?? prev.attemptsToSolve) : prev.attemptsToSolve,
        firstSeen:       prev.firstSeen || now,
        lastSeen:        now
    };
}

// entry'den status string'ini güvenli oku (string veya obje her ikisini de destekler)
function _qStatus(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return entry;
    return entry.status || null;
}

function saveQuizStats(topicId, correct, wrong, shown, questionResults) {
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const now  = Date.now();
        const all  = getAllProfiles();
        const p    = all[activeProfile.name] || { quizStats: {}, geoProgress: {} };
        const prev = p.quizStats[topicId]    || { questionMap: {}, sessions: 0 };
        const qMap = (typeof prev.questionMap === 'object' && prev.questionMap) ? { ...prev.questionMap } : {};

        if (Array.isArray(questionResults)) {
            questionResults.forEach(({ id, status }) => {
                if (!id) return;
                qMap[id] = _qEntry(qMap[id], status, now);
            });
        }

        p.quizStats[topicId] = {
            questionMap: qMap,
            sessions:    (prev.sessions || 0) + 1,
            lastPlayed:  now
        };
        all[activeProfile.name] = p;
        saveAllProfiles(all);
    } catch(e) {
        console.warn('[KPSS] saveQuizStats hatası:', e.message);
    }
}

// Anlık kayıt — her cevap sonrası çağrılır, sessions artmaz (finishQuiz'de artar).
function saveQuestionResult(topicId, questionId, status, attemptsUsed) {
    if (!activeProfile || activeProfile.isGuest || !topicId || !questionId) return;
    try {
        const now  = Date.now();
        const all  = getAllProfiles();
        const p    = all[activeProfile.name] || { quizStats: {}, geoProgress: {} };
        const prev = p.quizStats[topicId]    || { questionMap: {}, sessions: 0 };
        const qMap = (typeof prev.questionMap === 'object' && prev.questionMap) ? { ...prev.questionMap } : {};

        qMap[questionId] = _qEntry(qMap[questionId], status, now, attemptsUsed);

        p.quizStats[topicId] = { ...prev, questionMap: qMap, lastPlayed: now };
        all[activeProfile.name] = p;
        saveAllProfiles(all);
    } catch(e) {
        console.warn('[KPSS] saveQuestionResult hatası:', e.message);
    }
}

function loadQuizStats(topicId) {
    if (!activeProfile || activeProfile.isGuest) return null;
    try {
        const p   = getProfileData(activeProfile.name);
        const raw = p.quizStats[topicId];
        if (!raw) return null;

        // Yeni format (questionMap)
        if (raw.questionMap && typeof raw.questionMap === 'object') {
            const qMap = raw.questionMap;
            const vals = Object.values(qMap);
            return {
                correct:     vals.filter(v => _qStatus(v) === 'correct').length,
                wrong:       vals.filter(v => _qStatus(v) === 'wrong').length,
                shown:       vals.filter(v => _qStatus(v) === 'shown').length,
                sessions:    raw.sessions   || 0,
                lastPlayed:  raw.lastPlayed || null,
                questionMap: qMap
            };
        }

        // Eski format (kümülatif sayılar) — migrate et
        if (typeof raw.correct === 'number') {
            const totalQ = (appData && appData.quizData && appData.quizData[topicId])
                ? appData.quizData[topicId].length : 0;
            const seen = (raw.correct||0) + (raw.wrong||0) + (raw.shown||0);
            if (seen === 0) return null;
            const ratio = (totalQ > 0 && seen > totalQ) ? totalQ / seen : 1;
            const normalized = {
                correct:     Math.min(Math.round((raw.correct||0) * ratio), totalQ),
                wrong:       Math.round((raw.wrong||0) * ratio),
                shown:       Math.round((raw.shown||0) * ratio),
                sessions:    raw.sessions   || 0,
                lastPlayed:  raw.lastPlayed || null,
                questionMap: null
            };
            try {
                const all2 = getAllProfiles();
                const p2   = all2[activeProfile.name];
                if (p2 && p2.quizStats && p2.quizStats[topicId] === raw) {
                    p2.quizStats[topicId] = {
                        questionMap: {},
                        sessions:    normalized.sessions,
                        lastPlayed:  normalized.lastPlayed
                    };
                    all2[activeProfile.name] = p2;
                    saveAllProfiles(all2);
                }
            } catch(_) {}
            return normalized;
        }

        return null;
    } catch(e) { return null; }
}


// ── Branş denemesi sonuçlarını kaydet ───────────────────────
function saveBransResult(result) {
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const now = Date.now();
        const all = getAllProfiles();
        const p   = all[activeProfile.name] || { quizStats: {}, geoProgress: {}, bransResults: [] };
        if (!Array.isArray(p.bransResults)) p.bransResults = [];
        p.bransResults.unshift({
            date:        now,
            correct:     result.correct,
            wrong:       result.wrong,
            blank:       result.blank,
            net:         result.net,
            total:       result.total,
            elapsedSec:  result.elapsedSec,
            grupKirilim: result.grupKirilim
        });
        if (p.bransResults.length > 20) p.bransResults = p.bransResults.slice(0, 20);
        all[activeProfile.name] = p;
        saveAllProfiles(all);
    } catch(e) {
        console.warn('[KPSS] saveBransResult hatası:', e.message);
    }
}

function loadBransResults() {
    if (!activeProfile || activeProfile.isGuest) return [];
    try {
        const p = getProfileData(activeProfile.name);
        return Array.isArray(p.bransResults) ? p.bransResults : [];
    } catch(e) { return []; }
}

function saveGeoProgress(gameId, pinId, status) {
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const all = getAllProfiles();
        const p   = all[activeProfile.name] || { quizStats: {}, geoProgress: {} };
        if (!p.geoProgress[gameId]) p.geoProgress[gameId] = {};
        p.geoProgress[gameId][pinId] = status;
        all[activeProfile.name] = p;
        saveAllProfiles(all);
    } catch(e) {
        console.warn('[KPSS] saveGeoProgress hatası:', e.message);
    }
}

function loadGeoProgress(gameId) {
    if (!activeProfile || activeProfile.isGuest) return {};
    try {
        const p = getProfileData(activeProfile.name);
        return p.geoProgress[gameId] || {};
    } catch(e) { return {}; }
}

function clearGeoProgress(gameId) {
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const all = getAllProfiles();
        const p   = all[activeProfile.name];
        if (p && p.geoProgress) {
            delete p.geoProgress[gameId];
            saveAllProfiles(all);
        }
    } catch(e) {
        console.warn('[KPSS] clearGeoProgress hatası:', e.message);
    }
}

// ============================================================
// İSTATİSTİK & PROFİL MODALI — v2 Sekme Bazlı
// ============================================================

// ── Streak hesapla ──────────────────────────────────────────
function _calcStreak(quizStats) {
    const dates = Object.values(quizStats)
        .map(s => s.lastPlayed)
        .filter(Boolean)
        .map(ts => {
            const d = new Date(ts);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        });
    if (dates.length === 0) return 0;
    const uniqueDays = [...new Set(dates)].sort((a, b) => b - a);
    const today = new Date();
    const todayTs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const DAY = 86400000;
    if (uniqueDays[0] < todayTs - DAY) return 0;
    let streak = 1;
    for (let i = 1; i < uniqueDays.length; i++) {
        if (uniqueDays[i - 1] - uniqueDays[i] === DAY) streak++;
        else break;
    }
    return streak;
}

// ── En çok yanlış yapılan sorular ──────────────────────────
function _getHardestQuestions(quizStats, topN) {
    const questions = [];
    Object.entries(quizStats).forEach(([topicId, raw]) => {
        if (!raw || !raw.questionMap) return;
        const topicMeta = [
            ...(appData.tarih       || []),
            ...(appData.vatandaslik || []),
            ...(appData.turkce      || [])
        ].find(t => t.id === topicId);
        Object.entries(raw.questionMap).forEach(([qId, entry]) => {
            if (!entry || typeof entry !== 'object') return;
            if ((entry.wrongCount || 0) < 1) return;
            const qData = (appData.quizData[topicId] || []).find(q => q.id === qId);
            if (!qData) return;
            questions.push({
                topicTitle: topicMeta ? topicMeta.title : topicId,
                topicIcon:  topicMeta ? (topicMeta.icon || '📚') : '📚',
                question:   qData.q || qData.question || '—',
                wrongCount: entry.wrongCount || 0,
            });
        });
    });
    return questions.sort((a, b) => b.wrongCount - a.wrongCount).slice(0, topN || 5);
}

// ── Harita gameId → başlık/kategori eşlemesi ───────────────
function _buildGeoGameMeta() {
    const meta = {};
    function scanMenu(items, categoryLabel) {
        (items || []).forEach(item => {
            if (item.type === 'game' || item.type === 'match') {
                meta[item.id] = { title: item.title, icon: item.icon || '🗺️', category: categoryLabel };
            }
        });
    }
    scanMenu(appData.cografya     || [], 'Coğrafya');
    scanMenu(appData.yersekilleri || [], 'Yer Şekilleri');
    scanMenu(appData.madenler     || [], 'Madenler');
    scanMenu(appData.enerji       || [], 'Enerji');
    scanMenu(appData.daglar       || [], 'Dağlar');
    scanMenu(appData.goller       || [], 'Göller');
    if (appData.gameData) {
        Object.keys(appData.gameData).forEach(gid => {
            if (!meta[gid]) {
                meta[gid] = {
                    title:    gid.charAt(0).toUpperCase() + gid.slice(1).replace(/_/g, ' '),
                    icon:     '🗺️',
                    category: 'Diğer'
                };
            }
        });
    }
    return meta;
}


// ── Branş istatistik tab'ını oluştur ─────────────────────────
function _buildBransTab(results) {
    if (!results || results.length === 0) {
        return `<div class="sm2-empty-state brans-history-empty">
            <div class="bh-empty-icon">📊</div>
            <div class="bh-empty-title">Henüz deneme çözülmedi</div>
            <div class="bh-empty-sub">Tarih branş denemesini çözdükten sonra<br>sonuçların burada görünecek.</div>
        </div>`;
    }

    const totalAttempts = results.length;
    const bestNet  = Math.max(...results.map(r => r.net));
    const avgNet   = results.reduce((s, r) => s + r.net, 0) / totalAttempts;
    const lastNet  = results[0].net;

    const summaryHTML = `
        <div class="brans-history-summary">
            <div class="brans-hs-card">
                <span class="brans-hs-num">${totalAttempts}</span>
                <span class="brans-hs-lbl">Deneme</span>
            </div>
            <div class="brans-hs-card brans-hs-best">
                <span class="brans-hs-num">${bestNet > 0 ? bestNet.toFixed(2) : bestNet}</span>
                <span class="brans-hs-lbl">En İyi Net</span>
            </div>
            <div class="brans-hs-card">
                <span class="brans-hs-num">${avgNet.toFixed(2)}</span>
                <span class="brans-hs-lbl">Ort. Net</span>
            </div>
            <div class="brans-hs-card">
                <span class="brans-hs-num">${lastNet > 0 ? lastNet.toFixed(2) : lastNet}</span>
                <span class="brans-hs-lbl">Son Net</span>
            </div>
        </div>`;

    const cardsHTML = results.map((r, i) => {
        const date = new Date(r.date).toLocaleDateString('tr-TR', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        const mm = String(Math.floor((r.elapsedSec || 0) / 60)).padStart(2, '0');
        const ss = String((r.elapsedSec || 0) % 60).padStart(2, '0');
        const sureStr  = `${mm}:${ss}`;
        const netColor = r.net >= 20 ? 'var(--green)' : r.net >= 10 ? 'var(--amber)' : 'var(--red)';
        const netLabel = r.net > 0 ? r.net.toFixed(2) : r.net;

        let kirilimRows = '';
        if (r.grupKirilim && typeof r.grupKirilim === 'object') {
            kirilimRows = Object.entries(r.grupKirilim).map(([lbl, k]) => {
                const pct = k.total > 0 ? Math.round((k.correct / k.total) * 100) : 0;
                const barColor = pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
                return `<div class="bh-konu-row">
                    <span class="bh-konu-lbl">${lbl}</span>
                    <div class="bh-konu-bar-wrap">
                        <div class="bh-konu-bar" style="width:${pct}%;background:${barColor}"></div>
                    </div>
                    <span class="bh-konu-stats">
                        <span class="brc-d">✓${k.correct}</span>
                        <span class="brc-y">✗${k.wrong}</span>
                        <span class="brc-b">–${k.blank}</span>
                    </span>
                </div>`;
            }).join('');
        }

        return `
        <div class="brans-history-card">
            <div class="bh-header" onclick="document.getElementById('bh-detail-${i}').classList.toggle('bh-detail-open')">
                <div class="bh-header-left">
                    <span class="bh-attempt-label">${i === 0 ? '🔴 Son Deneme' : '#' + (totalAttempts - i)}</span>
                    <span class="bh-date">${date}</span>
                </div>
                <div class="bh-header-right">
                    <div class="bh-net-badge" style="color:${netColor};">${netLabel} net</div>
                    <span class="bh-chevron">›</span>
                </div>
            </div>
            <div class="bh-quick-stats">
                <span class="bh-qs bh-qs-correct">✓ ${r.correct} D</span>
                <span class="bh-qs bh-qs-wrong">✗ ${r.wrong} Y</span>
                <span class="bh-qs bh-qs-blank">– ${r.blank} B</span>
                <span class="bh-qs bh-qs-sure">⏱ ${sureStr}</span>
            </div>
            <div class="bh-detail" id="bh-detail-${i}">
                <div class="bh-konu-list">${kirilimRows || '<span class="bh-no-kirilim">Konu kırılımı yok</span>'}</div>
            </div>
        </div>`;
    }).join('');

    return `
        ${summaryHTML}
        <div class="sm2-section-label" style="margin:16px 16px 6px;">Geçmiş Denemeler</div>
        <div class="brans-history-list">${cardsHTML}</div>`;
}

function showStatsModal() {
    const existing = document.getElementById('stats-modal-overlay');
    if (existing) existing.remove();

    const isGuest     = !activeProfile || activeProfile.isGuest;
    const profileData = isGuest ? null : getProfileData(activeProfile.name);
    const quizStats   = profileData ? (profileData.quizStats   || {}) : {};
    const geoProgress = profileData ? (profileData.geoProgress || {}) : {};

    // ── Genel toplamlar ─────────────────────────────────────
    const allQuizTopics = [
        ...(appData.tarih        || []).filter(t => t.type === 'quiz'),
        ...(appData.vatandaslik  || []).filter(t => t.type === 'quiz'),
        ...(appData.turkce       || []).filter(t => t.type === 'quiz'),
    ];
    let totalCorrect = 0, totalWrong = 0, totalShown = 0, totalSessions = 0, grandTotalQ = 0;
    allQuizTopics.forEach(t => {
        grandTotalQ += (appData.quizData[t.id] || []).length;
        const s = loadQuizStats(t.id);
        if (s) { totalCorrect += s.correct||0; totalWrong += s.wrong||0; totalShown += s.shown||0; totalSessions += s.sessions||0; }
    });
    const totalSeen   = totalCorrect + totalWrong + totalShown;
    const accuracyPct = totalSeen  > 0 ? Math.round((totalCorrect / totalSeen)  * 100) : 0;
    const progressPct = grandTotalQ > 0 ? Math.round((totalSeen   / grandTotalQ) * 100) : 0;

    let geoTotal = 0, geoDone = 0;
    if (appData.gameData) {
        Object.entries(appData.gameData).forEach(([gid, pins]) => {
            geoTotal += pins.length;
            geoDone  += Object.keys(geoProgress[gid] || {}).length;
        });
    }
    const geoPct  = geoTotal > 0 ? Math.round((geoDone / geoTotal) * 100) : 0;
    const streak  = _calcStreak(quizStats);
    const hardQs  = _getHardestQuestions(quizStats, 5);

    // ── TAB 1: Özet ─────────────────────────────────────────
    const circumference = 100.53;
    const offset = circumference - (accuracyPct / 100) * circumference;

    const hardestHTML = hardQs.length === 0
        ? `<div class="sm2-empty-state">Henüz yanlış yapılan soru yok 🎉</div>`
        : hardQs.map(q => `
            <div class="sm2-hard-row">
                <span class="sm2-hard-icon">${q.topicIcon}</span>
                <div class="sm2-hard-body">
                    <div class="sm2-hard-topic">${q.topicTitle}</div>
                    <div class="sm2-hard-q">${q.question.length > 90 ? q.question.slice(0, 90) + '…' : q.question}</div>
                </div>
                <span class="sm2-hard-count">${q.wrongCount}✗</span>
            </div>`).join('');

    const tabSummaryHTML = `
        <div class="sm2-overview-ring-row">
            <div class="sm2-ring-wrap">
                <svg viewBox="0 0 44 44" class="sm2-ring-svg">
                    <circle class="sm2-ring-bg"   cx="22" cy="22" r="16"/>
                    <circle class="sm2-ring-fill" cx="22" cy="22" r="16"
                        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
                </svg>
                <div class="sm2-ring-inner">
                    <span class="sm2-ring-pct">%${accuracyPct}</span>
                    <span class="sm2-ring-sub">doğruluk</span>
                </div>
            </div>
            <div class="sm2-kpi-grid">
                <div class="sm2-kpi sm2-kpi-green"><span class="sm2-kpi-num">${totalCorrect}</span><span class="sm2-kpi-lbl">Doğru</span></div>
                <div class="sm2-kpi sm2-kpi-red"><span class="sm2-kpi-num">${totalWrong}</span><span class="sm2-kpi-lbl">Yanlış</span></div>
                <div class="sm2-kpi sm2-kpi-blue"><span class="sm2-kpi-num">${totalSessions}</span><span class="sm2-kpi-lbl">Oturum</span></div>
                <div class="sm2-kpi sm2-kpi-gold"><span class="sm2-kpi-num">${streak > 0 ? '🔥 ' + streak + ' gün' : '—'}</span><span class="sm2-kpi-lbl">Seri</span></div>
            </div>
        </div>
        <div class="sm2-progress-strip">
            <div class="sm2-ps-row">
                <span class="sm2-ps-label">📚 Quiz İlerlemesi</span>
                <span class="sm2-ps-val">${totalSeen}/${grandTotalQ} — %${progressPct}</span>
            </div>
            <div class="sm2-ps-track"><div class="sm2-ps-fill sm2-fill-blue" style="width:${progressPct}%"></div></div>
            <div class="sm2-ps-row" style="margin-top:10px;">
                <span class="sm2-ps-label">🗺️ Harita İlerlemesi</span>
                <span class="sm2-ps-val">${geoDone}/${geoTotal} — %${geoPct}</span>
            </div>
            <div class="sm2-ps-track"><div class="sm2-ps-fill sm2-fill-gold" style="width:${geoPct}%"></div></div>
        </div>
        <div class="sm2-section-label">En Çok Yanlış Yapılan Sorular</div>
        <div class="sm2-hard-list">${hardestHTML}</div>
    `;

    // ── TAB 2: Quiz ─────────────────────────────────────────
    function buildQuizRows(topics, dersLabel, dersIcon) {
        const rows = topics.map(t => {
            const s      = loadQuizStats(t.id);
            const totalQ = (appData.quizData[t.id] || []).length;
            if (!s || s.sessions === 0) {
                return `<div class="sm2-topic-row sm2-topic-empty">
                    <span class="sm2-topic-icon">${t.icon||'📚'}</span>
                    <span class="sm2-topic-name">${t.title}</span>
                    <span class="sm2-topic-badge sm2-badge-empty">Çalışılmadı</span>
                </div>`;
            }
            const seen       = Math.min((s.correct||0)+(s.wrong||0)+(s.shown||0), totalQ);
            const prgPct     = totalQ > 0 ? Math.round(((s.correct||0) / totalQ) * 100) : 0;
            const accPct     = seen  > 0  ? Math.round(((s.correct||0) / seen)  * 100) : 0;
            const barColor   = prgPct>=80?'var(--green)':prgPct>=50?'var(--amber)':'var(--red)';
            const badgeClass = prgPct>=80?'sm2-badge-green':prgPct>=50?'sm2-badge-amber':'sm2-badge-red';
            const lastDate   = s.lastPlayed ? new Date(s.lastPlayed).toLocaleDateString('tr-TR',{day:'numeric',month:'short'}) : '';
            return `<div class="sm2-topic-row">
                <span class="sm2-topic-icon">${t.icon||'📚'}</span>
                <div class="sm2-topic-info">
                    <span class="sm2-topic-name">${t.title}</span>
                    <div class="sm2-topic-bar-wrap">
                        <div class="sm2-topic-bar" style="width:${prgPct}%;background:${barColor};"></div>
                    </div>
                    <span class="sm2-topic-detail">${s.sessions} oturum · ${seen}/${totalQ} görüldü · %${accPct} doğru${lastDate?' · '+lastDate:''}</span>
                </div>
                <span class="sm2-topic-badge ${badgeClass}">%${prgPct}</span>
            </div>`;
        }).join('');
        return `<div class="sm2-ders-group"><div class="sm2-ders-label">${dersIcon} ${dersLabel}</div>${rows}</div>`;
    }

    const tabQuizHTML = `
        <div class="sm2-topics-wrap">
            ${buildQuizRows((appData.tarih      ||[]).filter(t=>t.type==='quiz'),'Tarih','📜')}
            ${buildQuizRows((appData.vatandaslik||[]).filter(t=>t.type==='quiz'),'Vatandaşlık','🏛️')}
            ${buildQuizRows((appData.turkce     ||[]).filter(t=>t.type==='quiz'),'Türkçe','📝')}
        </div>`;

    // ── TAB 3: Harita ────────────────────────────────────────
    function buildGeoRows() {
        if (!appData.gameData) return `<div class="sm2-empty-state">Harita verisi bulunamadı.</div>`;
        const geoMeta  = _buildGeoGameMeta();
        const catIcons = { 'Coğrafya':'🌍','Yer Şekilleri':'🏔️','Madenler':'⛏️','Enerji':'⚡','Dağlar':'🏔️','Göller':'💧','Diğer':'🗺️' };
        const categories = {};
        Object.entries(appData.gameData).forEach(([gid, pins]) => {
            const m    = geoMeta[gid] || { title: gid, icon: '🗺️', category: 'Diğer' };
            const done = Object.keys(geoProgress[gid] || {}).length;
            const tot  = pins.length;
            const pct  = tot > 0 ? Math.round((done / tot) * 100) : 0;
            if (!categories[m.category]) categories[m.category] = [];
            categories[m.category].push({ gid, title: m.title, icon: m.icon, done, total: tot, pct });
        });
        return Object.entries(categories).map(([cat, games]) => {
            const rows = games.map(g => {
                const barColor   = g.pct>=80?'var(--green)':g.pct>=40?'var(--gold)':'var(--blue)';
                const badgeClass = g.pct>=80?'sm2-badge-green':g.pct>=40?'sm2-badge-amber':'sm2-badge-empty';
                return `<div class="sm2-topic-row${g.done===0?' sm2-topic-empty':''}">
                    <span class="sm2-topic-icon">${g.icon}</span>
                    <div class="sm2-topic-info">
                        <span class="sm2-topic-name">${g.title}</span>
                        <div class="sm2-topic-bar-wrap">
                            <div class="sm2-topic-bar" style="width:${g.pct}%;background:${barColor};"></div>
                        </div>
                        <span class="sm2-topic-detail">${g.done}/${g.total} konum${g.done===0?' · Henüz başlanmadı':''}</span>
                    </div>
                    <span class="sm2-topic-badge ${badgeClass}">%${g.pct}</span>
                </div>`;
            }).join('');
            return `<div class="sm2-ders-group"><div class="sm2-ders-label">${catIcons[cat]||'🗺️'} ${cat}</div>${rows}</div>`;
        }).join('');
    }

    const geoBarColor = geoPct>=80?'var(--green)':geoPct>=40?'var(--gold)':'var(--blue)';
    const tabGeoHTML = `
        <div class="sm2-geo-summary">
            <div class="sm2-geo-sum-row">
                <span class="sm2-geo-sum-label">Genel Harita İlerlemesi</span>
                <span class="sm2-geo-sum-val">${geoDone}/${geoTotal} — %${geoPct}</span>
            </div>
            <div class="sm2-ps-track" style="margin-bottom:0;">
                <div class="sm2-ps-fill" style="width:${geoPct}%;background:${geoBarColor};"></div>
            </div>
        </div>
        <div class="sm2-topics-wrap">${buildGeoRows()}</div>`;

    // ── Branş denemesi geçmişi ─────────────────────────────
    const bransResults  = loadBransResults();
    const tabBransHTML  = _buildBransTab(bransResults);

    // ── HTML ────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'stats-modal-overlay';
    overlay.innerHTML = `
        <div class="stats-modal">
            <div class="stats-modal-header">
                <div class="stats-modal-avatar">${isGuest?'👤':activeProfile.name.charAt(0).toUpperCase()}</div>
                <div class="stats-modal-title-wrap">
                    <h2 class="stats-modal-title">${isGuest?'Misafir':activeProfile.name}</h2>
                    <p class="stats-modal-sub">${totalSessions} oturum${streak>0?' · 🔥 '+streak+' günlük seri':''}</p>
                </div>
                <button id="stats-close-btn" class="stats-modal-close">✕</button>
            </div>

            ${isGuest?'<div class="stat-guest-warn">👤 Misafir modunda istatistikler kaydedilmez.</div>':''}

            <div class="sm2-tabs">
                <button class="sm2-tab sm2-tab-active" data-tab="summary">📊 Özet</button>
                <button class="sm2-tab" data-tab="quiz">📚 Quiz</button>
                <button class="sm2-tab" data-tab="geo">🗺️ Harita</button>
                <button class="sm2-tab" data-tab="brans">📋 Branş</button>
            </div>

            <div class="sm2-tab-panels">
                <div class="sm2-panel sm2-panel-active" data-panel="summary">${tabSummaryHTML}</div>
                <div class="sm2-panel" data-panel="quiz">${tabQuizHTML}</div>
                <div class="sm2-panel" data-panel="geo">${tabGeoHTML}</div>
                <div class="sm2-panel" data-panel="brans">${tabBransHTML}</div>
            </div>

            <div class="sm2-profile-actions">
                <div class="stats-section-label" style="padding:14px 0 6px;">Profil Yönetimi</div>
                <div class="stats-profile-actions">
                    ${isGuest
                        ? `<button id="stats-switch-btn" class="stats-btn-google-inline">
                                <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.2 13 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17z"/><path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.9-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
                                Google ile Giriş Yap
                           </button>`
                        : `<button id="stats-switch-btn" class="stats-btn-switch">🚪 Çıkış Yap</button>
                           <button id="stats-delete-btn" class="stats-btn-delete">🗑️ Verilerimi Sil</button>`
                    }
                </div>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    // Kapat
    overlay.querySelector('#stats-close-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Sekme geçişi
    overlay.querySelectorAll('.sm2-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            overlay.querySelectorAll('.sm2-tab').forEach(b => b.classList.remove('sm2-tab-active'));
            overlay.querySelectorAll('.sm2-panel').forEach(p => p.classList.remove('sm2-panel-active'));
            btn.classList.add('sm2-tab-active');
            overlay.querySelector(`.sm2-panel[data-panel="${tab}"]`).classList.add('sm2-panel-active');
        });
    });

    // Profil butonları
    const switchBtn = overlay.querySelector('#stats-switch-btn');
    if (switchBtn) {
        switchBtn.addEventListener('click', () => {
            overlay.remove();
            if (isGuest) loginWithGoogle(); else logoutFirebase();
        });
    }
    const deleteBtn = overlay.querySelector('#stats-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => confirmDeleteProfile(activeProfile.name));
}

function confirmDeleteProfile(name) {
    const modal = document.createElement('div');
    modal.id = 'delete-confirm-overlay';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);padding:20px;';
    modal.innerHTML = `
        <div class="popup-card" style="border-radius:20px;padding:28px 24px;max-width:320px;width:100%;text-align:center;font-family:'Plus Jakarta Sans',sans-serif;">
            <div style="font-size:2rem;margin-bottom:12px;">⚠️</div>
            <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:8px;">Verileri Sil</h3>
            <p id="delete-confirm-text" style="font-size:0.82rem;color:var(--ink-500);line-height:1.55;margin-bottom:22px;"></p>
            <div style="display:flex;gap:10px;">
                <button id="delete-cancel-btn" class="popup-card-btn-cancel" style="flex:1;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;">İptal</button>
                <button id="delete-confirm-btn" style="flex:1;padding:11px;border-radius:12px;border:none;background:#c94c3a;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;">Sil</button>
            </div>
        </div>`;

    modal.querySelector('#delete-confirm-text').innerHTML = `<b style="color:#c94c3a;">"${name}"</b> hesabına ait tüm quiz ve coğrafya verileri kalıcı olarak silinecek.`;
    modal.querySelector('#delete-cancel-btn').addEventListener('click', () => modal.remove());
    modal.querySelector('#delete-confirm-btn').addEventListener('click', () => {
        modal.remove();
        executeDeleteProfile();
    });
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function executeDeleteProfile() {
    const overlay = document.getElementById('stats-modal-overlay');
    if (overlay) overlay.remove();
    // Firestore verisini sil
    await _fsDelete();
    _invalidateProfileCache();
    // Çıkış yap — onAuthStateChanged login ekranını açacak
    await logoutFirebase();
}

// ============================================================
// PROFİL MODALİ
// ============================================================

function showProfileModal(isFirstTime) {
    // Önceki varsa kaldır
    const existing = document.getElementById('profile-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'profile-modal-overlay';

    overlay.innerHTML = `
        <div class="profile-modal">
            <div class="profile-modal-header">
                <span class="profile-modal-icon">🎓</span>
                <h2 class="profile-modal-title">KPSS Atlas</h2>
                <p class="profile-modal-sub">
                    ${isFirstTime
                        ? 'İlerlemenin her cihazda senkronize olması için giriş yap.'
                        : 'Farklı bir hesapla giriş yap.'}
                </p>
            </div>

            <button id="profile-google-btn" class="profile-google-btn">
                <span class="profile-google-icon">
                    <svg width="20" height="20" viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.2 13 17.7 9.5 24 9.5z"/>
                        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17z"/>
                        <path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.9-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"/>
                        <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>
                    </svg>
                </span>
                <span class="profile-google-label">Google ile devam et</span>
            </button>

            <div class="profile-divider"><span>veya</span></div>

            <button id="profile-guest-btn" class="profile-guest-btn">
                👤 Misafir olarak devam et
                <span class="profile-guest-note">İlerleme kaydedilmez</span>
            </button>

            ${!isFirstTime ? `
            <button id="profile-cancel-btn" class="profile-cancel-btn">İptal</button>
            ` : ''}
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#profile-google-btn').addEventListener('click', loginWithGoogle);
    overlay.querySelector('#profile-guest-btn').addEventListener('click', loginAsGuest);
    const cancelBtn = overlay.querySelector('#profile-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => overlay.remove());
}

async function loginWithGoogle() {
    if (!window._fb) { alert('Firebase yükleniyor, lütfen bekle.'); return; }
    const btn = document.getElementById('profile-google-btn') || document.querySelector('.stats-btn-google-inline');
    if (btn) { btn.disabled = true; }
    const label = btn ? btn.querySelector('.profile-google-label') : null;
    if (label) label.textContent = 'Giriş yapılıyor...';
    try {
        const { auth, GoogleAuthProvider, signInWithPopup } = window._fb;
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
    } catch(e) {
        console.error('Google giriş hatası:', e);
        if (btn) btn.disabled = false;
        if (label) label.textContent = 'Google ile devam et';
        if (e.code !== 'auth/popup-closed-by-user') alert('Giriş başarısız: ' + e.message);
    }
}

function loginAsGuest() {
    _invalidateProfileCache();
    setActiveProfile({ name: 'Misafir', isGuest: true, uid: null });
    removeProfileModal();
    applyProfileSwitch();
}

async function logoutFirebase() {
    if (!window._fb) return;
    // Önce bekleyen tüm veriyi Firestore'a kaydet, sonra çıkış yap
    await _flushProfileCache();
    try {
        await window._fb.signOut(window._fb.auth);
    } catch(e) {
        console.error('[KPSS] Çıkış yapılırken hata:', e.message);
        if (typeof showToast === 'function') {
            showToast('Çıkış yapılamadı, tekrar dene', 'error', 3000);
        }
    }
    // onAuthStateChanged → null → showProfileModal tetiklenecek
}

// ---- Profil değiştiğinde bulunulan ekrana göre tepki ver ----
function applyProfileSwitch() {
    // Coğrafya oyunu aktifse: aynı oyunu yeni profilin verileriyle yeniden başlat
    const isGeoActive = currentGameId !== null
        && document.getElementById('game-area').style.display !== 'none'
        && document.getElementById('map').style.display !== 'none';

    if (isGeoActive) {
        // Açık modal varsa kapat
        document.getElementById('modal-overlay').style.display = 'none';
        document.getElementById('question-modal').style.display = 'none';

        // Tam ekran modunu temizle, startGame yeniden kuracak
        exitGeoFullscreen();

        // Oyunu yeni profille yeniden yükle
        const savedGameId    = currentGameId;
        const savedTitle     = document.getElementById('hud-title')
                               ? document.getElementById('hud-title').innerText
                               : currentTitle.innerText;
        const savedParentId  = findParentMenuId(savedGameId);
        startGame(savedGameId, savedTitle, savedParentId);
        return;
    }

    // Quiz aktifse: quiz'i iptal et, konu seçim ekranına dön
    const isQuizActive = currentQuiz.length > 0 && !quizFinished;
    if (isQuizActive) {
        // Açık modal varsa kapat
        document.getElementById('modal-overlay').style.display = 'none';
        document.getElementById('question-modal').style.display = 'none';
        resetHistoryQuiz();

        gameArea.style.display = 'none';
        menuArea.style.display = 'block';
        const dersTitle = getDersTitle(activeTopicDersId);
        // Yeni profilin istatistiklerini göstermek için konuları yeniden render et
        renderTopicSelection(activeTopicDersId, dersTitle);
        return;
    }

    // Konu seçim ekranındaysa: stat rozetlerini yeni profil için yenile
    const isTopicSelection = !!document.getElementById('topic-list');
    if (isTopicSelection) {
        const dersTitle = getDersTitle(activeTopicDersId);
        renderTopicSelection(activeTopicDersId, dersTitle);
    }

    // Ana menü veya diğer ekranlar — herhangi bir müdahale gerekmez
}

function removeProfileModal() {
    const el = document.getElementById('profile-modal-overlay');
    if (el) {
        el.classList.add('profile-modal-exit');
        setTimeout(() => el.remove(), 280);
    }
}

// ---- Uygulama başlangıcında Firebase Auth dinle ----
function initProfile() {
    // Firebase henüz yüklenmediyse event bekle
    function _startAuthListener() {
        const { auth, onAuthStateChanged } = window._fb;
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                // Giriş yapılmış — Firestore'dan veriyi yükle
                _invalidateProfileCache();
                const name = user.displayName || user.email || 'Kullanıcı';
                setActiveProfile({ name, isGuest: false, uid: user.uid });

                // Firestore'dan mevcut veriyi çek (başarısız olursa tekrar dene)
                let fsData = await _fsGet();
                if (!fsData) {
                    // İlk deneme başarısız — 1 saniye bekle, tekrar dene
                    // (Firestore kuralları veya network gecikmesi olabilir)
                    await new Promise(r => setTimeout(r, 1000));
                    fsData = await _fsGet();
                }
                _profileCache = fsData || { quizStats: {}, geoProgress: {} };

                removeProfileModal();
                applyProfileSwitch();
            } else {
                // Çıkış yapılmış veya ilk açılış
                _invalidateProfileCache();
                activeProfile = null;
                showProfileModal(true);
            }
        });
    }

    if (window._fbReady) {
        _startAuthListener();
    } else {
        window.addEventListener('fb-ready', _startAuthListener, { once: true });
    }
}

// ============================================================
// UYGULAMA BAŞLANGICI
// ============================================================
// initProfile hoisting: profil fonksiyonları yukarıda tanımlandı,
// renderMenu çağrısından hemen sonra profil modalini tetikle.
(function() { initProfile(); })();

// ---- goBack — HTML back-btn onclick="goBack()" için gerekli ----
function goBack() {
    if (typeof backBtn.onclick === 'function') backBtn.onclick();
}

function renderMenu(items) {
    menuArea.innerHTML = "";
    menuArea.style.display = 'grid';
    gameArea.style.display = 'none';

    const currentMenuId = findMenuIdByItems(items);
    const parentId = findParentMenuId(currentMenuId);

    if (currentMenuId === "main") {
        backBtn.style.display = 'none';
        currentTitle.innerText = "Dersler";
    } else {
        backBtn.style.display = 'inline-block';
        backBtn.innerText = "← Geri Dön";
        backBtn.onclick = () => {
            if (parentId && appData[parentId]) {
                renderMenu(appData[parentId]);
                updateTitleForMenu(parentId);
            } else {
                renderMenu(appData.main);
                currentTitle.innerText = "Dersler";
            }
        };
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<span>${item.icon || '📚'}</span><h2>${item.title}</h2>${item.desc ? `<p>${item.desc}</p>` : ''}`;

        if (item.type !== "none") {
            card.onclick = () => handleSelection(item);
        } else {
            card.classList.add('card-disabled');
            card.innerHTML += `<span class="card-soon-badge">Yakında</span>`;
            card.style.cursor = "default";
        }

        menuArea.appendChild(card);
    });
}

function handleSelection(item) {
    // Konu seçim ekranı gösterilecek dersler
    const topicSelectionDersler = ["tarih", "vatandaslik"];

    if (item.id === "turkce") {
        renderMenu(appData.turkce);
        currentTitle.innerText = "Türkçe";
    } else if (topicSelectionDersler.includes(item.id)) {
        renderTopicSelection(item.id, item.title);
    } else if (item.type === "turkce-mini") {
        startTurkceGame(item.id, item.title);
    } else if (appData[item.id]) {
        renderMenu(appData[item.id]);
        currentTitle.innerText = item.title;
    } else if (item.type === "game") {
        const parentId = findParentMenuId(item.id);
        startGame(item.id, item.title, parentId);
    } else if (appData.quizData && appData.quizData[item.id]) {
        // BUG FIX: type field eksik olsa da quizData'da varsa quiz başlat
        // BUG FIX 2: Hangi menüden gelindiğini kaydet
        const _parentIdForQuiz = findParentMenuId(item.id);
        if (_parentIdForQuiz && appData[_parentIdForQuiz]) {
            _quizReturnContext = { type: 'menu', menuId: _parentIdForQuiz };
        }
        startQuiz(item.id);
    }
}

function renderHistorySelection() {
    renderTopicSelection('tarih', 'Tarih');
}

// Aktif ders ID'sini tutar
let activeTopicDersId = 'tarih';

// Quiz bitince nereye döneceğimizi tutar
// null → renderTopicSelection(activeTopicDersId) kullan (tarih/vatandaşlık)
// { type:'menu', menuId } → renderMenu(appData[menuId])
// { type:'main' } → renderMenu(appData.main)
let _quizReturnContext = null;

// Ders ID → okunabilir başlık
function getDersTitle(dersId) {
    const titles = { vatandaslik: 'Vatandaşlık', tarih: 'Tarih', cografya: 'Coğrafya', turkce: 'Türkçe' };
    return titles[dersId] || dersId;
}

function renderTopicSelection(dersId, dersTitle) {
    // Daily widget sadece ana menüde görünmeli — burada her zaman kaldır.
    // (renderMenu hook'u bunu yapar ama renderTopicSelection renderMenu'yu çağırmaz)
    const _dw = document.getElementById('daily-widget');
    if (_dw) _dw.remove();

    activeTopicDersId = dersId;
    const topics = (appData[dersId] || []).filter(t => t.type === 'quiz');
    const weakTopics = [];

    const topicItems = topics.map(topic => {
        const stats  = loadQuizStats(topic.id);
        const totalQ = (appData.quizData[topic.id] || []).length;
        let statsBadge = '', progressBar = '', cardClass = '';
        if (stats && stats.sessions > 0) {
            const seen        = Math.min((stats.correct||0) + (stats.wrong||0) + (stats.shown||0), totalQ);
            // Rozet & çubuk: gerçek ilerleme = doğru / toplam soru
            const progressPct = totalQ > 0 ? Math.round(((stats.correct||0) / totalQ) * 100) : 0;
            const barColor = progressPct >= 80 ? 'var(--green)' : progressPct >= 50 ? 'var(--amber)' : 'var(--brick)';
            const bgColor  = progressPct >= 80 ? 'var(--green-pale)' : progressPct >= 50 ? 'var(--amber-pale)' : 'var(--brick-pale)';
            const seenLabel = `${seen}/${totalQ}`;
            // Rozet sağ üstte absolute, sıfırla butonu rozetin altında aynı sütunda
            statsBadge = `
                <span class="topic-stats-badge" style="color:${barColor};background:${bgColor};">%${progressPct} <span style="font-weight:400;opacity:0.75;font-size:0.85em;">${seenLabel}</span></span>
                <button class="topic-reset-btn" title="Bu konuyu sıfırla"
                    data-topic-id="${topic.id}"
                    data-topic-title="${topic.title.replace(/"/g,'&quot;')}">↺</button>`;
            progressBar = `<div class="topic-progress-bar-wrap"><div class="topic-progress-bar" style="width:${progressPct}%;background:${barColor};"></div></div>`;
            if (progressPct < 50) { weakTopics.push(topic); cardClass = 'topic-box-weak'; }
            else if (progressPct >= 80) { cardClass = 'topic-box-strong'; }
        }
        return `
            <label class="topic-item" data-title="${topic.title.toLocaleLowerCase('tr')}">
                <input type="checkbox" name="history-topic" value="${topic.id}">
                <span class="topic-box ${cardClass}">
                    <span class="topic-icon">${topic.icon || '📚'}</span>
                    <span class="topic-name">${topic.title}</span>
                    ${topic.desc ? `<span class="topic-desc">${topic.desc}</span>` : ''}
                    ${progressBar}
                    ${statsBadge}
                </span>
            </label>`;
    }).join('');

    const weakBanner = weakTopics.length > 0 ? `
        <div class="weak-topics-banner">
            <div class="weak-banner-left">
                <span class="weak-banner-icon">⚠️</span>
                <div class="weak-banner-text">
                    <span class="weak-banner-title">${weakTopics.length} zayıf konu tespit edildi</span>
                    <span class="weak-banner-sub">${weakTopics.map(t => t.title).join(', ')}</span>
                </div>
            </div>
            <button class="weak-banner-btn" id="btn-weak-topics">Tekrar Çalış</button>
        </div>` : '';

    menuArea.innerHTML = `
        <div class="selection-container">
            <div class="selection-header">
                <h3>Konu Seçimi</h3>
                <p>Çalışmak istediğin konuları işaretle, sorular karıştırılarak gelsin.</p>
            </div>

            ${dersId === 'tarih' ? `
            <div class="brans-denemesi-banner" id="brans-denemesi-banner">
                <div class="brans-banner-left">
                    <span class="brans-banner-icon">📊</span>
                    <div class="brans-banner-text">
                        <span class="brans-banner-title">Tarih Branş Denemesi</span>
                        <span class="brans-banner-sub">KPSS ortalama dağılımı · 27 soru · Süreli</span>
                    </div>
                </div>
                <button class="brans-banner-btn" id="btn-brans-denemesi">Deneme Çöz</button>
            </div>` : ''}

            ${weakBanner}

            <div class="selection-search-row">
                <input type="text" id="topic-search" class="topic-search-input"
                    placeholder="🔍 Konu ara..."
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>

            <div class="selection-actions-top">
                <button class="btn-select-all" id="btn-select-all">Tümünü Seç</button>
                <button class="btn-select-none" id="btn-select-none">Temizle</button>
            </div>

            <div id="topic-list" class="topic-grid">
                ${topicItems}
            </div>

            <div class="selection-sticky-footer" id="selection-footer">
                <div class="selection-start-card" id="start-card">
                    <div class="start-card-info">
                        <div class="start-card-icon">🎯</div>
                        <div class="start-card-texts">
                            <span class="start-card-title" id="start-card-title">Konu seçilmedi</span>
                            <span class="start-card-sub"  id="start-card-sub">Çalışmak istediğin konuları işaretle</span>
                        </div>
                    </div>
                    <button class="start-card-btn" id="btn-start-mixed" disabled>
                        Başlat ›
                    </button>
                </div>
            </div>
        </div>
    `;

    // Closure üzerinden event bağla — inline onclick yok
    const weakBtn = menuArea.querySelector('#btn-weak-topics');
    if (weakBtn) weakBtn.addEventListener('click', () => selectWeakTopics(weakTopics.map(t => t.id)));
    menuArea.querySelector('#btn-select-all').addEventListener('click', selectAllTopics);
    menuArea.querySelector('#btn-select-none').addEventListener('click', selectNoTopics);
    menuArea.querySelector('#btn-start-mixed').addEventListener('click', startMixedQuiz);
    menuArea.querySelector('#topic-search').addEventListener('input', e => filterTopics(e.target.value));
    const bransBtn = menuArea.querySelector('#btn-brans-denemesi');
    if (bransBtn) bransBtn.addEventListener('click', _showBransDenemesiInfo);

    // Konu sıfırla butonları — event delegation ile (her buton için ayrı listener gerekmez)
    menuArea.querySelector('#topic-list').addEventListener('click', e => {
        const resetBtn = e.target.closest('.topic-reset-btn');
        if (resetBtn) {
            e.preventDefault();
            e.stopPropagation();
            confirmResetTopic(resetBtn.dataset.topicId, resetBtn.dataset.topicTitle);
            return;
        }
    });

    // MOBİL ANLIK GÖRSEL: tap vs scroll ayrımı yaparak gecikmeyi sıfırla.
    // touchstart + touchend (hareket < 10px) = tap → anında .selected toggle.
    // touchstart + move > 10px = scroll → dokunma sayılmaz.
    (function attachTapDetection(list) {
        let _touchStartY = 0;
        let _touchStartX = 0;
        let _touchLabel  = null;

        list.addEventListener('touchstart', e => {
            const label = e.target.closest('.topic-item');
            if (!label || e.target.closest('.topic-reset-btn')) { _touchLabel = null; return; }
            _touchLabel  = label;
            _touchStartY = e.touches[0].clientY;
            _touchStartX = e.touches[0].clientX;
        }, { passive: true });

        list.addEventListener('touchmove', e => {
            if (!_touchLabel) return;
            const dy = Math.abs(e.touches[0].clientY - _touchStartY);
            const dx = Math.abs(e.touches[0].clientX - _touchStartX);
            // 8px'den fazla hareket = scroll, tap iptal et
            if (dy > 8 || dx > 8) _touchLabel = null;
        }, { passive: true });

        list.addEventListener('touchend', e => {
            if (!_touchLabel) return;
            const label = _touchLabel;
            _touchLabel = null;
            const cb = label.querySelector('input[name="history-topic"]');
            if (!cb) return;
            // Gerçek tıklama: checkbox toggle'ını tahmin et ve anında uygula
            label.classList.toggle('selected', !cb.checked);
            updateSelectionCounter();
            // Not: tarayıcının kendi click→change event'i biraz sonra gelecek,
            // change listener'ı tekrar sync edecek (fark yok, idempotent).
        }, { passive: true });
    })(menuArea.querySelector('#topic-list'));

    // Checkbox değişimlerini izle + .selected class sync (touchstart'ı atlayan cihazlar için)
    menuArea.querySelector('#topic-list').addEventListener('change', e => {
        if (e.target.matches('input[name="history-topic"]')) {
            const item = e.target.closest('.topic-item');
            if (item) item.classList.toggle('selected', e.target.checked);
            updateSelectionCounter();
        }
    });
    menuArea.style.display = 'block';
    currentTitle.innerText = dersTitle + ' Konu Seçimi';
    backBtn.style.display = 'inline-block';
    backBtn.onclick = () => {
        menuArea.style.display = 'grid';
        const parentId = findParentMenuId(dersId);
        if (parentId && appData[parentId]) {
            renderMenu(appData[parentId]);
            updateTitleForMenu(parentId);
        } else {
            renderMenu(appData.main);
            currentTitle.innerText = "Dersler";
        }
    };
}

function filterTopics(query) {
    const q = query.toLocaleLowerCase('tr').trim();
    document.querySelectorAll('#topic-list .topic-item').forEach(item => {
        const title = item.getAttribute('data-title') || '';
        item.style.display = (!q || title.includes(q)) ? '' : 'none';
    });
}

function confirmResetTopic(topicId, topicTitle) {
    const existing = document.getElementById('topic-reset-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'topic-reset-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:20px;';

    const card = document.createElement('div');
    card.className = 'popup-card';
    card.style.cssText = 'border-radius:20px;padding:28px 24px;max-width:320px;width:100%;text-align:center;font-family:\'Plus Jakarta Sans\',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.22);';
    card.innerHTML = `
        <div style="font-size:2rem;margin-bottom:10px;">↺</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:8px;">Konuyu Sıfırla</h3>
        <p style="font-size:0.85rem;color:var(--ink-500);line-height:1.6;margin-bottom:22px;">
            <b style="color:#2d4a7a;">"${topicTitle}"</b> konusundaki tüm ilerleme silinecek.<br>
            Sorular baştan çözülmüş sayılmayacak.
        </p>
        <div style="display:flex;gap:10px;">
            <button id="topic-reset-cancel" class="popup-card-btn-cancel" style="flex:1;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;">İptal</button>
            <button id="topic-reset-confirm" style="flex:1;padding:11px;border-radius:12px;border:none;background:#c94c3a;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;">Sıfırla</button>
        </div>`;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector('#topic-reset-cancel').addEventListener('click', () => overlay.remove());
    card.querySelector('#topic-reset-confirm').addEventListener('click', () => {
        overlay.remove();
        resetTopicStats(topicId);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function resetTopicStats(topicId) {
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const all = getAllProfiles();
        const p   = all[activeProfile.name];
        if (p && p.quizStats) {
            delete p.quizStats[topicId];
            saveAllProfiles(all);
        }
    } catch(e) {
        console.warn('[KPSS] Konu sıfırlama hatası:', e.message);
    }
    // Konu listesini yenile
    const dersTitle = getDersTitle(activeTopicDersId);
    renderTopicSelection(activeTopicDersId, dersTitle);
}

function selectWeakTopics(weakIds) {
    // weakIds: string[] veya geriye dönük uyumluluk için virgüllü string de kabul et
    const ids = Array.isArray(weakIds) ? weakIds : weakIds.split(',');
    document.querySelectorAll('input[name="history-topic"]').forEach(cb => cb.checked = false);
    ids.forEach(id => {
        const cb = document.querySelector(`input[name="history-topic"][value="${id}"]`);
        if (cb) cb.checked = true;
    });
    updateSelectionCounter();
}


function updateSelectionCounter() {
    const checked = document.querySelectorAll('input[name="history-topic"]:checked');
    const startBtn   = document.getElementById('btn-start-mixed');
    const startCard  = document.getElementById('start-card');
    const footer     = document.getElementById('selection-footer');
    const titleEl    = document.getElementById('start-card-title');
    const subEl      = document.getElementById('start-card-sub');

    if (checked.length === 0) {
        if (startBtn)  startBtn.disabled = true;
        if (startCard) startCard.classList.remove('has-selection');
        if (footer)    footer.classList.remove('has-any-selection');
        if (titleEl)   titleEl.textContent = 'Konu seçilmedi';
        if (subEl)     subEl.textContent   = 'Çalışmak istediğin konuları işaretle';
    } else {
        let totalQ = 0;
        checked.forEach(cb => {
            const data = appData.quizData[cb.value];
            if (data) totalQ += data.length;
        });
        if (startBtn)  startBtn.disabled = false;
        if (startCard) startCard.classList.add('has-selection');
        if (footer)    footer.classList.add('has-any-selection');
        if (titleEl)   titleEl.textContent = `${checked.length} konu seçildi`;
        if (subEl)     subEl.textContent   = `${totalQ} soru hazırlanacak`;
    }
}

function selectAllTopics() {
    document.querySelectorAll('input[name="history-topic"]').forEach(cb => {
        cb.checked = true;
        const item = cb.closest('.topic-item');
        if (item) item.classList.add('selected');
    });
    updateSelectionCounter();
}

function selectNoTopics() {
    document.querySelectorAll('input[name="history-topic"]').forEach(cb => {
        cb.checked = false;
        const item = cb.closest('.topic-item');
        if (item) item.classList.remove('selected');
    });
    updateSelectionCounter();
}

// Gerçek rastgele karıştırma (Fisher-Yates algoritması)
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ============================================================
// BRANŞ DENEMESİ MOTORU
// Normal quiz sisteminden tamamen bağımsız çalışır.
// Özellikler:
//   - Sorular konuya göre SIRAYLA gelir (karıştırma yok)
//   - MC only, anlık doğru/yanlış gösterilmez
//   - Boş bırakma hakkı var
//   - Geri dönüp cevap değiştirilebilir
//   - Süre sayacı
//   - Bitiş: D/Y/B/Net/Süre + konu kırılımı
//   - Net: Doğru - (Yanlış / 4)
// ============================================================

const TARIH_BRANS_DAGILIM = [
    { topicIds: ['islamiyet_oncesi'],                                                    quota: 2, label: 'İslamiyet Öncesi Türk Tarihi' },
    { topicIds: ['ilk_turk_islam', 'turkiye_selcuklu'],                                  quota: 2, label: 'İlk Türk-İslam Devletleri' },
    { topicIds: ['osmanli_kurulus', 'osmanli_yukselme', 'osmanli_duraklama_gerileme', 'osmanli_dagilma'], quota: 4, label: 'Osmanlı Devleti Siyaseti' },
    { topicIds: ['osmanli_kultur'],                                                      quota: 4, label: 'Osmanlı Kültür ve Medeniyeti' },
    { topicIds: ['osmanli_20yy'],                                                        quota: 4, label: '20. Yüzyıl Osmanlı' },
    { topicIds: ['milli_mucadele_hazirlik', 'milli_mucadele_muharebeler'],               quota: 2, label: 'Kurtuluş Savaşı' },
    { topicIds: ['ataturk_inkilaplari'],                                                 quota: 4, label: 'İnkılap Tarihi' },
    { topicIds: ['ataturk_hayati_dis_politika'],                                        quota: 2, label: 'Atatürk Dönemi Politikaları' },
    { topicIds: ['dunya_savasi', 'soguk_savas_yumusama', 'kuresellesen_dunya'],         quota: 3, label: 'Çağdaş Türk ve Dünya Tarihi' },
    // TOPLAM: 2+2+4+4+4+2+4+2+3 = 27
];

// Aktif branş denemesi state'i
let _brans = null;

function _showBransDenemesiInfo() {
    const existing = document.getElementById('brans-info-overlay');
    if (existing) { existing.remove(); return; }

    const rows = TARIH_BRANS_DAGILIM.map(g =>
        `<tr>
            <td style="padding:7px 12px;font-size:0.81rem;color:var(--ink-700,var(--t-200));">${g.label}</td>
            <td style="padding:7px 12px;font-size:0.81rem;font-weight:700;color:var(--gold);text-align:center;">${g.quota}</td>
        </tr>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.id = 'brans-info-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);padding:20px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);';
    overlay.innerHTML = `
        <div class="brans-info-card">
            <div class="brans-info-header">
                <span class="brans-info-icon">📊</span>
                <div>
                    <div class="brans-info-title">Tarih Branş Denemesi</div>
                    <div class="brans-info-sub">2015–2024 KPSS ortalama dağılımı · 27 Soru</div>
                </div>
            </div>
            <table class="brans-info-table">
                <thead>
                    <tr>
                        <th>Konu</th>
                        <th>Soru</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr>
                        <td>TOPLAM</td>
                        <td>27</td>
                    </tr>
                </tfoot>
            </table>
            <div class="brans-info-rules">
                <span>⏱ Süreli deneme</span>
                <span>↩ Geri dönülebilir</span>
                <span>⭕ Boş bırakılabilir</span>
                <span>➗ Net: D − (Y÷4)</span>
            </div>
            <button class="brans-info-start-btn" id="brans-info-start">🚀 Denemeyi Başlat</button>
            <button class="brans-info-cancel-btn" id="brans-info-cancel">Vazgeç</button>
        </div>`;

    document.body.appendChild(overlay);
    document.getElementById('brans-info-start').addEventListener('click', () => { overlay.remove(); startBransDenemesi(); });
    document.getElementById('brans-info-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function startBransDenemesi() {
    // Soruları konuya göre SIRAYLA topla (karıştırma sadece kota içinde)
    const questions = [];
    TARIH_BRANS_DAGILIM.forEach(grup => {
        let pool = [];
        grup.topicIds.forEach(tid => {
            (appData.quizData[tid] || []).forEach((q, idx) => {
                // Sadece MC soruları al
                if (!q.options || q.options.length === 0) return;
                pool.push({ ...q, topicId: tid, id: q.id || `${tid}_${idx}`, _bransGrup: grup.label });
            });
        });
        if (pool.length === 0) { console.warn(`[BRANS] ${grup.label}: soru yok`); return; }
        pool = shuffleArray(pool); // Kota içinde rastgele
        questions.push(...pool.slice(0, Math.min(grup.quota, pool.length)));
    });

    if (questions.length === 0) { showToast('Branş denemesi için MC soru bulunamadı.', 'error', 3000); return; }

    // State'i başlat
    _brans = {
        questions,                           // sıralı soru dizisi
        answers: new Array(questions.length).fill(null), // null=boş, string=seçilen
        currentIdx: 0,
        startTime: Date.now(),
        timerInterval: null,
        active: true
    };

    // Shuffle overlay ile başlat (görsellik)
    const overlay  = document.getElementById('shuffle-overlay');
    const iconEl   = document.getElementById('dynamic-shuffle-icon');
    const fillEl   = document.getElementById('shuffle-progress-fill');
    const countEl  = document.getElementById('shuffle-count-label');
    if (iconEl)  iconEl.innerText = '📋';
    if (fillEl)  { fillEl.style.transition = 'none'; fillEl.style.width = '0%'; }
    if (countEl) countEl.innerText = '';
    overlay.style.display = 'flex';

    setTimeout(() => {
        if (fillEl) { fillEl.style.transition = 'width 0.4s ease-out'; fillEl.style.width = '100%'; }
        if (countEl) countEl.innerText = `${questions.length} soru hazır!`;
    }, 100);

    setTimeout(() => {
        overlay.style.display = 'none';
        _bransRenderUI();
        _bransStartTimer();
        _bransShowQuestion(0);
    }, 700);
}

function _bransRenderUI() {
    // Mevcut modal ve overlay'i sıfırla
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('question-modal').style.display = 'none';

    // game-area'yı branş modu için kullan ama haritayı gizle
    document.getElementById('map').style.display = 'none';
    const gameArea = document.getElementById('game-area');
    gameArea.style.display = 'block';

    // DÜZELTME: gameArea.innerHTML = ... YAPILMAZ — orijinal #shuffle-overlay, #map,
    // #status-bar gibi elementleri kalıcı olarak yok eder ve sonraki quiz/konu
    // akışlarında "boş ekran" hatasına yol açar.
    // Bunun yerine branş container'ını appendChild ile ekle, çıkışta remove() ile kaldır.

    // Önceki branş container varsa temizle
    const existingBrans = document.getElementById('brans-container');
    if (existingBrans) existingBrans.remove();

    const bransDiv = document.createElement('div');
    bransDiv.className = 'brans-container';
    bransDiv.id = 'brans-container';
    bransDiv.innerHTML = `
            <!-- Üst bar: ilerleme + süre -->
            <div class="brans-topbar" id="brans-topbar">
                <div class="brans-progress-wrap">
                    <div class="brans-progress-track">
                        <div class="brans-progress-fill" id="brans-progress-fill" style="width:0%"></div>
                    </div>
                    <span class="brans-progress-label" id="brans-progress-label">1 / ${_brans.questions.length}</span>
                </div>
                <div class="brans-timer" id="brans-timer">00:00</div>
                <button class="brans-finish-early-btn" id="brans-finish-early">Testi Bitir</button>
            </div>

            <!-- Soru alanı -->
            <div class="brans-question-area" id="brans-question-area">
                <div class="brans-topic-chip" id="brans-topic-chip"></div>
                <div class="brans-q-num" id="brans-q-num"></div>
                <div class="brans-question-text" id="brans-question-text"></div>
                <div class="brans-options" id="brans-options"></div>
            </div>

            <!-- Alt nav -->
            <div class="brans-bottombar" id="brans-bottombar">
                <button class="brans-nav-btn brans-prev-btn" id="brans-prev">◀ Önceki</button>
                <button class="brans-skip-btn" id="brans-skip">Boş Bırak</button>
                <button class="brans-nav-btn brans-next-btn" id="brans-next">Sonraki ▶</button>
            </div>`;

    gameArea.appendChild(bransDiv);

    // Nav buton event'leri
    document.getElementById('brans-prev').addEventListener('click', () => _bransNavigate(-1));
    document.getElementById('brans-next').addEventListener('click', () => _bransNavigate(1));
    document.getElementById('brans-skip').addEventListener('click', _bransSkip);
    document.getElementById('brans-finish-early').addEventListener('click', _bransFinish);

    // Topbar geri butonu → denemeyi bitir (onaylı)
    backBtn.style.display = 'none'; // Branşta kendi nav'ı var
    menuArea.style.display = 'none';
}

function _bransStartTimer() {
    _brans.timerInterval = setInterval(() => {
        if (!_brans.active) { clearInterval(_brans.timerInterval); return; }
        const elapsed = Math.floor((Date.now() - _brans.startTime) / 1000);
        const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        const el = document.getElementById('brans-timer');
        if (el) el.textContent = `${m}:${s}`;
    }, 1000);
}

function _bransShowQuestion(idx) {
    if (!_brans || idx < 0 || idx >= _brans.questions.length) return;
    _brans.currentIdx = idx;

    const q = _brans.questions[idx];
    const total = _brans.questions.length;
    const pct = Math.round(((idx + 1) / total) * 100);

    // İlerleme
    const fill = document.getElementById('brans-progress-fill');
    const label = document.getElementById('brans-progress-label');
    if (fill)  fill.style.width = pct + '%';
    if (label) label.textContent = `${idx + 1} / ${total}`;

    // Konu chip
    const chip = document.getElementById('brans-topic-chip');
    if (chip) chip.textContent = q._bransGrup || '';

    // Soru numarası + metin
    const qNum = document.getElementById('brans-q-num');
    if (qNum) qNum.textContent = `Soru ${idx + 1}`;
    const qText = document.getElementById('brans-question-text');
    if (qText) qText.textContent = q.q || '';

    // Seçenekleri render et
    const optArea = document.getElementById('brans-options');
    if (!optArea) return;
    optArea.innerHTML = '';
    const labels = ['A', 'B', 'C', 'D', 'E'];
    // Seçenekler karıştırılmış halde geldi (startBransDenemesi'de pool karıştırıldı)
    // Ama seçenek sırası her gösterimde aynı kalsın — shuffle data'da sakla
    if (!q._shuffledOptions) q._shuffledOptions = shuffleArray([...q.options]);

    q._shuffledOptions.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'brans-option';
        btn.dataset.value = opt;
        // Daha önce bu soruya cevap verilmişse işaretle
        if (_brans.answers[idx] === opt) btn.classList.add('brans-option-selected');
        btn.innerHTML = `<span class="brans-option-label">${labels[i]}</span><span class="brans-option-text">${opt}</span>`;
        btn.addEventListener('click', () => _bransSelectOption(idx, opt));
        optArea.appendChild(btn);
    });

    // Prev/Next butonları
    const prevBtn = document.getElementById('brans-prev');
    const nextBtn = document.getElementById('brans-next');
    const skipBtn = document.getElementById('brans-skip');
    const finishBtn = document.getElementById('brans-finish-early');

    if (prevBtn) prevBtn.disabled = (idx === 0);

    const isLast = (idx === total - 1);
    if (nextBtn) {
        nextBtn.style.display = isLast ? 'none' : 'inline-flex';
    }
    if (finishBtn) {
        finishBtn.style.display = isLast ? 'inline-flex' : 'inline-flex';
        finishBtn.textContent = isLast ? '✓ Testi Bitir' : 'Testi Bitir';
        finishBtn.classList.toggle('brans-finish-highlight', isLast);
    }
    if (skipBtn) {
        // Boş bırak durumunu göster
        const already = _brans.answers[idx];
        skipBtn.textContent = already === '' ? '✗ Boş Bırakıldı' : 'Boş Bırak';
        skipBtn.classList.toggle('brans-skip-active', already === '');
    }
}

function _bransSelectOption(idx, value) {
    _brans.answers[idx] = value;
    // Butonları güncelle
    const optArea = document.getElementById('brans-options');
    if (!optArea) return;
    optArea.querySelectorAll('.brans-option').forEach(btn => {
        btn.classList.toggle('brans-option-selected', btn.dataset.value === value);
    });
    // Boş bırak butonunu sıfırla
    const skipBtn = document.getElementById('brans-skip');
    if (skipBtn) { skipBtn.textContent = 'Boş Bırak'; skipBtn.classList.remove('brans-skip-active'); }

    // Son soru değilse otomatik sonrakine git (isteğe bağlı — şimdilik manuel)
}

function _bransSkip() {
    const idx = _brans.currentIdx;
    _brans.answers[idx] = ''; // boş string = boş bırakıldı
    const skipBtn = document.getElementById('brans-skip');
    if (skipBtn) { skipBtn.textContent = '✗ Boş Bırakıldı'; skipBtn.classList.add('brans-skip-active'); }
    // Sonraki soruya geç (son değilse)
    if (idx < _brans.questions.length - 1) {
        setTimeout(() => _bransNavigate(1), 300);
    }
}

function _bransNavigate(dir) {
    const next = _brans.currentIdx + dir;
    if (next < 0 || next >= _brans.questions.length) return;
    _bransShowQuestion(next);
}

function _bransFinish() {
    // Cevaplanmamış (null) soruları say — onay sor
    const unanswered = _brans.answers.filter(a => a === null).length;
    if (unanswered > 0) {
        const ok = confirm(`${unanswered} soruyu henüz işaretlemedin.\nTesti bitirmek istediğine emin misin?\n(Boş bırakılan sorular yanlış saymaz)`);
        if (!ok) return;
        // null olanları boş bırak olarak işaretle
        _brans.answers = _brans.answers.map(a => a === null ? '' : a);
    }

    _brans.active = false;
    clearInterval(_brans.timerInterval);
    const elapsed = Math.floor((Date.now() - _brans.startTime) / 1000);
    _bransShowResult(elapsed);
}

function _bransShowResult(elapsedSec) {
    const { questions, answers } = _brans;
    const total = questions.length;

    // Sonuçları hesapla
    let correct = 0, wrong = 0, blank = 0;
    const grupKirilim = {}; // label → { correct, wrong, blank, total }

    questions.forEach((q, i) => {
        const userAns = answers[i];
        const label = q._bransGrup || 'Diğer';
        if (!grupKirilim[label]) grupKirilim[label] = { correct: 0, wrong: 0, blank: 0, total: 0 };
        grupKirilim[label].total++;

        const correctAnswers = _getCorrectAnswers(q);
        const isBlank = userAns === '' || userAns === null;
        const isCorrect = !isBlank &&
            correctAnswers.some(a => normalizeText(userAns) === normalizeText(a));

        if (isBlank) { blank++; grupKirilim[label].blank++; }
        else if (isCorrect) { correct++; grupKirilim[label].correct++; }
        else { wrong++; grupKirilim[label].wrong++; }
    });

    const net = Math.round((correct - wrong / 4) * 100) / 100;
    saveBransResult({ correct, wrong, blank, net, total, elapsedSec, grupKirilim });
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    const sureStr = `${m}:${s}`;

    // Konu kırılım HTML
    const kirilimRows = Object.entries(grupKirilim).map(([lbl, k]) => {
        const pct = k.total > 0 ? Math.round((k.correct / k.total) * 100) : 0;
        const color = pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
        return `
            <div class="brans-result-konu">
                <div class="brans-result-konu-header">
                    <span class="brans-result-konu-label">${lbl}</span>
                    <span class="brans-result-konu-pct" style="color:${color}">%${pct}</span>
                </div>
                <div class="brans-result-konu-bar-wrap">
                    <div class="brans-result-konu-bar" style="width:${pct}%;background:${color}"></div>
                </div>
                <div class="brans-result-konu-stats">
                    <span class="brc-d">✓ ${k.correct}</span>
                    <span class="brc-y">✗ ${k.wrong}</span>
                    <span class="brc-b">– ${k.blank}</span>
                    <span class="brc-t">/ ${k.total}</span>
                </div>
            </div>`;
    }).join('');

    // Yanlış yapılan soruları listele
    const wrongList = questions.map((q, i) => {
        const userAns = answers[i];
        const correctAnswers = _getCorrectAnswers(q);
        const isBlank = userAns === '' || userAns === null;
        const isCorrect = !isBlank &&
            correctAnswers.some(a => normalizeText(userAns) === normalizeText(a));
        if (isCorrect) return '';
        const statusClass = isBlank ? 'brans-wrong-blank' : 'brans-wrong-wrong';
        const statusLabel = isBlank ? 'Boş' : 'Yanlış';
        return `
            <div class="brans-wrong-item ${statusClass}">
                <div class="brans-wrong-meta">
                    <span class="brans-wrong-num">S${i + 1}</span>
                    <span class="brans-wrong-grup">${q._bransGrup || ''}</span>
                    <span class="brans-wrong-status">${statusLabel}</span>
                </div>
                <div class="brans-wrong-q">${q.q}</div>
                ${!isBlank ? `<div class="brans-wrong-your">Senin cevabın: <b>${userAns}</b></div>` : ''}
                <div class="brans-wrong-correct">Doğru cevap: <b>${correctAnswers[0] || '—'}</b></div>
            </div>`;
    }).filter(Boolean).join('');

    // DÜZELTME: gameArea.innerHTML = ... yerine appendChild kullan.
    // gameArea.innerHTML tüm orijinal elementleri (#shuffle-overlay, #map, #status-bar)
    // kalıcı olarak siler — bu yüzden sonraki quiz akışları boş ekranla karşılaşır.
    const existingResult = document.getElementById('brans-container');
    if (existingResult) existingResult.remove();

    const resultDiv = document.createElement('div');
    resultDiv.id = 'brans-container';
    resultDiv.className = 'brans-result-container';
    resultDiv.innerHTML = `
            <div class="brans-result-header">
                <div class="brans-result-title">📋 Deneme Tamamlandı</div>
                <div class="brans-result-sub">Tarih Branş Denemesi · ${total} Soru</div>
            </div>

            <!-- Ana istatistikler -->
            <div class="brans-result-stats">
                <div class="brans-stat-card brans-stat-correct">
                    <span class="brans-stat-num">${correct}</span>
                    <span class="brans-stat-label">Doğru</span>
                </div>
                <div class="brans-stat-card brans-stat-wrong">
                    <span class="brans-stat-num">${wrong}</span>
                    <span class="brans-stat-label">Yanlış</span>
                </div>
                <div class="brans-stat-card brans-stat-blank">
                    <span class="brans-stat-num">${blank}</span>
                    <span class="brans-stat-label">Boş</span>
                </div>
                <div class="brans-stat-card brans-stat-net">
                    <span class="brans-stat-num">${net > 0 ? net.toFixed(2) : net}</span>
                    <span class="brans-stat-label">Net</span>
                </div>
                <div class="brans-stat-card brans-stat-sure">
                    <span class="brans-stat-num">${sureStr}</span>
                    <span class="brans-stat-label">Süre</span>
                </div>
            </div>

            <!-- Konu kırılımı -->
            <div class="brans-result-section">
                <div class="brans-result-section-title">📊 Konu Kırılımı</div>
                <div class="brans-result-konu-list">${kirilimRows}</div>
            </div>

            <!-- Yanlış / Boş listesi -->
            ${wrongList ? `
            <div class="brans-result-section">
                <div class="brans-result-section-title">🔍 Yanlış ve Boş Sorular</div>
                <div class="brans-wrong-list">${wrongList}</div>
            </div>` : `
            <div class="brans-result-section">
                <div class="brans-result-perfect">🎉 Tüm soruları doğru yanıtladın!</div>
            </div>`}

            <!-- Tekrar / Çık -->
            <div class="brans-result-actions">
                <button class="brans-result-btn brans-result-retry" id="brans-retry">Tekrar Çöz</button>
                <button class="brans-result-btn brans-result-exit"  id="brans-exit">Konulara Dön</button>
            </div>`;

    gameArea.appendChild(resultDiv);

    resultDiv.querySelector('#brans-retry').addEventListener('click', () => {
        // Branş container'ını kaldır — orijinal game-area elementleri korunur
        resultDiv.remove();
        _brans = null;
        startBransDenemesi();
    });
    resultDiv.querySelector('#brans-exit').addEventListener('click', () => {
        // Branş container'ını kaldır — orijinal game-area elementleri korunur
        resultDiv.remove();
        gameArea.style.display = 'none';
        document.getElementById('map').style.display = 'none';
        _brans = null;
        menuArea.style.display = 'block';
        backBtn.style.display = 'none';
        renderTopicSelection('tarih', 'Tarih');
    });
}

function startMixedQuiz() {
    // BUG FIX: Quiz bittiğinde doğru yere dönmek için context kaydet
    _quizReturnContext = { type: 'topicSelection', dersId: activeTopicDersId };

    const selectedCheckboxes = document.querySelectorAll('input[name="history-topic"]:checked');
    if (selectedCheckboxes.length === 0) {
        alert("Lütfen en az bir konu seç!");
        return;
    }

    // Seçili konuların tüm sorularını ve görülmüş ID'leri topla
    let allQuestions = [];
    let seenIds      = new Set();
    let selectedIcons = [];

    selectedCheckboxes.forEach(cb => {
        const topicId  = cb.value;
        const dersData = appData[activeTopicDersId] || [];
        const topic    = dersData.find(t => t.id === topicId);
        if (topic) selectedIcons.push(topic.icon || '📚');

        if (appData.quizData[topicId]) {
            appData.quizData[topicId].forEach((q, idx) => {
                allQuestions.push({
                    ...q,
                    topicId,
                    topicTitle: topic ? topic.title : topicId,
                    id: q.id || `${topicId}_${idx}`
                });
            });
        }

        // Bu konuda görülmüş soru ID'leri
        const stats = loadQuizStats(topicId);
        if (stats && stats.questionMap) {
            Object.keys(stats.questionMap).forEach(id => seenIds.add(id));
        }
    });

    const unseenQuestions = allQuestions.filter(q => !seenIds.has(q.id));
    const hasUnseen       = unseenQuestions.length > 0;
    const hasSeen         = seenIds.size > 0 && allQuestions.length > unseenQuestions.length;

    // Eğer görülmemiş soru varsa seçenek sun
    if (hasUnseen && hasSeen) {
        _showStartOptions(allQuestions, unseenQuestions, selectedIcons);
        return;
    }

    // Hiç görülmemiş (ilk kez) → direkt başlat
    // Hepsi görülmüş → yanlış/tümü seçeneği sun
    if (!hasUnseen && hasSeen) {
        _showAllSeenNotice(allQuestions, selectedIcons);
        return;
    }

    _launchQuiz(allQuestions, selectedIcons);
}

function _showStartOptions(allQuestions, unseenQuestions, selectedIcons) {
    const existing = document.getElementById('start-options-overlay');
    if (existing) existing.remove();

    const seenCount   = allQuestions.length - unseenQuestions.length;
    const unseenCount = unseenQuestions.length;
    const totalCount  = allQuestions.length;

    const overlay = document.createElement('div');
    overlay.id = 'start-options-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:20px;';

    const card = document.createElement('div');
    card.className = 'popup-card';
    card.style.cssText = 'border-radius:22px;padding:26px 22px;max-width:340px;width:100%;font-family:\'Plus Jakarta Sans\',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.22);';
    card.innerHTML = `
        <div style="font-size:1.8rem;text-align:center;margin-bottom:10px;">📖</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:6px;text-align:center;">Nereden devam edelim?</h3>
        <p style="font-size:0.8rem;color:var(--ink-500);margin-bottom:18px;text-align:center;">
            Bu konularda <b>${seenCount}/${totalCount}</b> soruyu daha önce gördün.
        </p>`;

    const btnUnseen = document.createElement('button');
    btnUnseen.style.cssText = 'width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid #dbeafe;background:#eff6ff;color:#1d4ed8;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.88rem;font-weight:600;cursor:pointer;text-align:left;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;';
    btnUnseen.innerHTML = `<span>▶ Kaldığım Yerden Devam</span><span style="background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:8px;font-size:0.78rem;">${unseenCount} soru</span>`;
    btnUnseen.addEventListener('click', () => { overlay.remove(); _launchQuiz(unseenQuestions, selectedIcons); });

    const btnAll = document.createElement('button');
    btnAll.style.cssText = 'width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid var(--border-mid);background:var(--surface-2);color:var(--ink-700);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.88rem;font-weight:600;cursor:pointer;text-align:left;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;';
    btnAll.innerHTML = `<span>🔄 Tüm Sorular</span><span style="background:var(--surface-3);color:var(--ink-500);padding:3px 10px;border-radius:8px;font-size:0.78rem;">${totalCount} soru</span>`;
    btnAll.addEventListener('click', () => { overlay.remove(); _launchQuiz(allQuestions, selectedIcons); });

    const btnCancel = document.createElement('button');
    btnCancel.className = 'popup-card-btn-cancel';
    btnCancel.style.cssText = 'width:100%;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;';
    btnCancel.textContent = 'İptal';
    btnCancel.addEventListener('click', () => overlay.remove());

    card.appendChild(btnUnseen);
    card.appendChild(btnAll);
    card.appendChild(btnCancel);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function _launchQuiz(questions, selectedIcons) {
    if (!questions || questions.length === 0) {
        _showAllSeenNotice();
        return;
    }

    _resetQuizState();
    resetScore();
    restoreModalHTML();

    const overlay  = document.getElementById('shuffle-overlay');
    const iconEl   = document.getElementById('dynamic-shuffle-icon');
    const fillEl   = document.getElementById('shuffle-progress-fill');
    const countEl  = document.getElementById('shuffle-count-label');
    const total    = questions.length;

    // Bar'ı sıfırla (CSS animasyonu yok — JS ile kontrol edeceğiz)
    if (fillEl) { fillEl.style.transition = 'none'; fillEl.style.width = '0%'; }
    if (countEl) countEl.innerText = '';
    overlay.style.display = 'flex';

    // Adım 1 — Soruları karıştır (gerçek işlem, parça parça)
    // CHUNK_SIZE: her frame'de işlenecek soru sayısı
    // Küçük set (<50) → tek seferde, büyük set → parçalı
    const CHUNK_SIZE = Math.max(1, Math.ceil(total / 20));
    const shuffled   = [];
    const pool       = [...questions];

    // Fisher-Yates karıştırmayı adım adım yap
    let i = pool.length - 1;

    // İkon değişimi
    let iconIdx = 0;
    const icons = selectedIcons && selectedIcons.length ? selectedIcons : ['📚'];
    const iconInterval = setInterval(() => {
        iconEl.innerText = icons[iconIdx % icons.length];
        iconIdx++;
    }, 65);

    function processChunk() {
        // Bu frame'de CHUNK_SIZE kadar eleman karıştır
        let processed = 0;
        while (i >= 0 && processed < CHUNK_SIZE) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
            shuffled.push(pool[i]);
            i--;
            processed++;
        }

        // İlerlemeyi göster
        const done = total - i - 1;
        const pct  = Math.round((done / total) * 90); // %90'da dur — son %10 hazırlık için
        if (fillEl) {
            fillEl.style.transition = 'width 0.12s ease-out';
            fillEl.style.width = pct + '%';
        }
        if (countEl) countEl.innerText = done + ' / ' + total + ' soru';

        if (i >= 0) {
            // Henüz bitmedi — bir sonraki frame'de devam et
            requestAnimationFrame(processChunk);
        } else {
            // Karıştırma tamamlandı
            currentQuiz        = shuffled;
            originalQuizLength = currentQuiz.length;

            // %90 → %100 geçişi + kısa bekleme
            if (fillEl) {
                fillEl.style.transition = 'width 0.3s ease-out';
                fillEl.style.width = '100%';
            }
            if (countEl) countEl.innerText = total + ' soru hazır!';

            setTimeout(() => {
                clearInterval(iconInterval);
                overlay.style.display = 'none';
                const modal_fill = document.getElementById('modal-progress-fill');
                if (modal_fill) modal_fill.style.width = '0%';

                document.getElementById('map').style.display = 'none';
                document.getElementById('game-area').style.display = 'block';

                backBtn.style.display = 'inline-block';
                backBtn.innerText = "← Geri Dön";
                backBtn.onclick = () => {
                    document.getElementById('modal-overlay').style.display = 'none';
                    document.getElementById('question-modal').style.display = 'none';
                    resetHistoryQuiz();
                    gameArea.style.display = 'none';
                    menuArea.style.display = 'block';
                    const dersTitle = getDersTitle(activeTopicDersId);
                    renderTopicSelection(activeTopicDersId, dersTitle);
                };

                nextQuestion();
            }, 380);
        }
    }

    // İlk frame'i başlat
    requestAnimationFrame(processChunk);
}

function _showAllSeenNotice(allQuestions, selectedIcons) {
    const existing = document.getElementById('all-seen-overlay');
    if (existing) existing.remove();

    // Yanlış yapılan VE cevap gösterilen soruları questionMap'ten bul
    const wrongQuestions = allQuestions.filter(q => {
        const topicId = q.topicId;
        if (!topicId) return false;
        const stats = loadQuizStats(topicId);
        if (!stats || !stats.questionMap) return false;
        const st = _qStatus(stats.questionMap[q.id]);
        return st === 'wrong' || st === 'shown';
    });
    const wrongCount = wrongQuestions.length;
    const totalCount = allQuestions.length;

    const overlay = document.createElement('div');
    overlay.id = 'all-seen-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:20px;';

    const card = document.createElement('div');
    card.className = 'popup-card';
    card.style.cssText = 'border-radius:22px;padding:26px 22px;max-width:340px;width:100%;font-family:\'Plus Jakarta Sans\',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.22);';
    card.innerHTML = `
        <div style="font-size:1.8rem;text-align:center;margin-bottom:10px;">🏆</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:6px;text-align:center;">Tüm sorular tamamlandı!</h3>
        <p style="font-size:0.8rem;color:var(--ink-500);margin-bottom:18px;text-align:center;">
            ${totalCount} sorunun hepsini gördün. Ne yapmak istersin?
        </p>`;

    if (wrongCount > 0) {
        const btnWrong = document.createElement('button');
        btnWrong.style.cssText = 'width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid #fee2e2;background:var(--brick-pale);color:#c94c3a;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.88rem;font-weight:700;cursor:pointer;text-align:left;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;';
        btnWrong.innerHTML = `<span>🔴 Yanlış & Gösterilen</span><span style="background:#fee2e2;color:#c94c3a;padding:3px 10px;border-radius:8px;font-size:0.78rem;">${wrongCount} soru</span>`;
        btnWrong.addEventListener('click', () => { overlay.remove(); _launchQuiz(wrongQuestions, selectedIcons); });
        card.appendChild(btnWrong);
    } else {
        const noWrong = document.createElement('div');
        noWrong.style.cssText = 'width:100%;padding:11px 16px;border-radius:14px;border:1.5px solid var(--border-soft);background:var(--surface-2);color:var(--ink-300);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.85rem;text-align:center;margin-bottom:10px;';
        noWrong.textContent = '✅ Hiç yanlışın yok!';
        card.appendChild(noWrong);
    }

    const btnAll = document.createElement('button');
    btnAll.style.cssText = 'width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid var(--border-mid);background:var(--surface-2);color:var(--ink-700);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.88rem;font-weight:600;cursor:pointer;text-align:left;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;';
    btnAll.innerHTML = `<span>🔄 Tüm Soruları Tekrar</span><span style="background:var(--surface-3);color:var(--ink-500);padding:3px 10px;border-radius:8px;font-size:0.78rem;">${totalCount} soru</span>`;
    btnAll.addEventListener('click', () => { overlay.remove(); _launchQuiz(allQuestions, selectedIcons); });

    const btnBack = document.createElement('button');
    btnBack.className = 'popup-card-btn-back';
    btnBack.style.cssText = 'width:100%;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;';
    btnBack.textContent = 'Geri Dön';
    btnBack.addEventListener('click', () => overlay.remove());

    card.appendChild(btnAll);
    card.appendChild(btnBack);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// --- YARDIMCI FONKSIYONLAR ---

function findMenuIdByItems(items) {
    for (let key in appData) {
        if (appData[key] === items) return key;
    }
    return "main";
}

function findParentMenuId(childId) {
    if (childId === "main") return null;

    for (let parentKey in appData) {
        if (Array.isArray(appData[parentKey])) {
            if (appData[parentKey].some(item => item.id === childId)) {
                return parentKey;
            }
        }
    }
    return "main";
}

function updateTitleForMenu(menuId) {
    const parentId = findParentMenuId(menuId);
    if (parentId && appData[parentId]) {
        const menuObj = appData[parentId].find(item => item.id === menuId);
        if (menuObj) currentTitle.innerText = menuObj.title;
    } else {
        currentTitle.innerText = "Dersler";
    }
}

// --- HARİTA BAŞLATMA (COĞRAFYA) ---
function showResetConfirm(message, onConfirm) {
    const existing = document.getElementById('reset-confirm-overlay');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'reset-confirm-overlay';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);padding:20px;';
    modal.innerHTML = `
        <div class="popup-card" style="border-radius:20px;padding:28px 24px;max-width:320px;width:100%;text-align:center;font-family:'Plus Jakarta Sans',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.25);">
            <div style="font-size:2rem;margin-bottom:12px;">🗺️</div>
            <p style="font-size:0.9rem;color:var(--ink-700);line-height:1.55;margin-bottom:22px;">${message}</p>
            <div style="display:flex;gap:10px;">
                <button onclick="document.getElementById('reset-confirm-overlay').remove()"
                    class="popup-card-btn-cancel"
                    style="flex:1;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;">İptal</button>
                <button id="reset-confirm-ok"
                    style="flex:1;padding:11px;border-radius:12px;border:none;background:#c94c3a;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;">Sıfırla</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    document.getElementById('reset-confirm-ok').onclick = () => { modal.remove(); onConfirm(); };
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

let _currentParentId = null;

function startGame(gameId, title, parentId) {
    _currentParentId = parentId;
    resetScore();

    // Önceki fullscreen/resize listener'larını temizle (sıfırla→startGame birikimini önle)
    window.removeEventListener('orientationchange', _onGeoResize);
    window.removeEventListener('resize', _onGeoResize);
    document.removeEventListener('fullscreenchange', _onMapFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    // Modal HTML'ini sıfırla ve Enter listener'ı bağla
    restoreModalHTML();

    menuArea.style.display = 'none';
    gameArea.style.display = 'block';
    currentTitle.innerText = title;

    document.getElementById('map').style.display = 'block';

    if (map) {
        map.remove();
        map = null;
    }

    backBtn.style.display = 'inline-block';
    backBtn.innerText = "← Geri Dön";
    backBtn.onclick = () => {
        exitGeoFullscreen();
        gameArea.style.display = 'none';
        menuArea.style.display = 'grid';
        resetScore();
        // HUD ve harita switcher'ı temizle
        const existingHud = document.getElementById('map-hud');
        if (existingHud) existingHud.remove();
        const existingSwitcher = document.getElementById('map-switcher');
        if (existingSwitcher) existingSwitcher.remove();
        // Header badge'i setActiveProfile ile düzgün yenile (avatar + isim span yapısı korunsun)
        if (activeProfile) setActiveProfile(activeProfile);

        if (parentId && appData[parentId]) {
            renderMenu(appData[parentId]);
            updateTitleForMenu(parentId);
        } else {
            renderMenu(appData.main);
            currentTitle.innerText = "Dersler";
        }
    };

    // --- HUD PANELİ — haritanın üstüne inject et ---
    const existingHud = document.getElementById('map-hud');
    if (existingHud) existingHud.remove();

    // Eski map-switcher'ı kaldır (game-area'ya taşınmış olabilir)
    const existingSwitcher = document.getElementById('map-switcher');
    if (existingSwitcher) existingSwitcher.remove();

    const totalPins = (appData.gameData[gameId] || []).length;
    const hudHTML = `
        <div id="map-hud">
            <button class="hud-back-btn" id="hud-back-btn" title="Geri Dön">←</button>
            <div class="hud-left">
                <div class="hud-title" id="hud-title">${title}</div>
                <div class="hud-subtitle" id="hud-subtitle">Bir pine tıklayarak başla</div>
            </div>
            <div class="hud-stats">
                <div class="hud-stat hud-stat-correct">
                    <span class="hud-stat-num" id="hud-correct">0</span>
                    <span class="hud-stat-label">Doğru</span>
                </div>
                <div class="hud-stat hud-stat-wrong">
                    <span class="hud-stat-num" id="hud-wrong">0</span>
                    <span class="hud-stat-label">Yanlış</span>
                </div>
                <div class="hud-stat hud-stat-shown">
                    <span class="hud-stat-num" id="hud-shown">0</span>
                    <span class="hud-stat-label">Gösterildi</span>
                </div>
            </div>
            <div class="hud-right-group">
                <div class="hud-progress-wrap">
                    <svg class="hud-ring" viewBox="0 0 44 44">
                        <circle class="hud-ring-bg" cx="22" cy="22" r="18" />
                        <circle class="hud-ring-fill" id="hud-ring-fill" cx="22" cy="22" r="18"
                            stroke-dasharray="113.1"
                            stroke-dashoffset="113.1" />
                    </svg>
                    <span class="hud-ring-text" id="hud-ring-text">0/${totalPins}</span>
                </div>
            </div>
        </div>
    `;
    gameArea.insertAdjacentHTML('afterbegin', hudHTML);

    // Header badge: setActiveProfile zaten rozeti doğru kuruyor (avatar + isim + onclick).
    // Burada tekrar yazarsak setActiveProfile'ın kurduğu yapıyı bozmuş oluruz.
    // Sadece display'i garantiye alalım.
    const badge = document.getElementById('header-badge');
    if (badge && activeProfile) {
        badge.style.display = 'flex';
    }

    // HUD içindeki geri butonu — sadece tam ekran modda görünür (CSS ile)
    const hudBackBtn = document.getElementById('hud-back-btn');
    if (hudBackBtn) {
        hudBackBtn.addEventListener('click', () => backBtn.onclick());
    }

    const startZoom = window.innerWidth < 768 ? 5 : 6;
    map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], startZoom);

    // --- 3 harita katmanı ---
    const tileLayers = {
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri', maxZoom: 19
        }),
        topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenTopoMap', subdomains: 'abc', maxZoom: 17
        }),
        light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CARTO', subdomains: 'abcd', maxZoom: 19
        })
    };

    let activeLayer = tileLayers.satellite;
    activeLayer.addTo(map);

    // --- Katman seçici — etiketli butonlar ---
    const switcherHTML = `
        <div id="map-switcher">
            <button class="map-btn active" data-layer="satellite" title="Uydu">
                <span class="map-btn-icon">🛰️</span>
                <span class="map-btn-label">Uydu</span>
            </button>
            <button class="map-btn" data-layer="topo" title="Fiziki">
                <span class="map-btn-icon">🗺️</span>
                <span class="map-btn-label">Fiziki</span>
            </button>
            <button class="map-btn" data-layer="light" title="Sade">
                <span class="map-btn-icon">🗾</span>
                <span class="map-btn-label">Sade</span>
            </button>
            <div class="map-btn-divider"></div>
            <button class="map-btn map-btn-action" id="map-fs-btn" title="Tam Ekran">
                <span class="map-btn-icon">⛶</span>
                <span class="map-btn-label">Ekran</span>
            </button>
            <button class="map-btn map-btn-action" id="map-reset-btn" title="İlerlemeyi Sıfırla" disabled
                onclick="handleMapReset()">
                <span class="map-btn-icon">↺</span>
                <span class="map-btn-label">Sıfırla</span>
            </button>
        </div>
    `;
    // Switcher'ı Leaflet'in bottomright control alanına ekle
    // Böylece #map overflow:hidden ile çakışmaz, konumlama Leaflet'e ait olur
    const switcherContainer = L.control({ position: 'bottomright' });
    switcherContainer.onAdd = function() {
        const div = L.DomUtil.create('div', 'leaflet-control');
        div.innerHTML = switcherHTML.replace('<div id="map-switcher">', '<div id="map-switcher" style="position:static;bottom:auto;right:auto;">');
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    switcherContainer.addTo(map);

    document.querySelectorAll('.map-btn[data-layer]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.layer;
            if (activeLayer === tileLayers[key]) return;
            map.removeLayer(activeLayer);
            tileLayers[key].addTo(map);
            activeLayer = tileLayers[key];
            document.querySelectorAll('.map-btn[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Tam ekran butonu
    const mapFsBtn = document.getElementById('map-fs-btn');
    if (mapFsBtn) {
        mapFsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleMapFullscreen(mapFsBtn);
        });
    }

    // Fullscreen değişikliği izle — önce kaldır, sonra ekle (startGame yeniden çağrılınca birikmesini önler)
    document.removeEventListener('fullscreenchange', _onMapFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', _onMapFullscreenChange);
    document.addEventListener('fullscreenchange', _onMapFullscreenChange);
    document.addEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    currentGameId = gameId;
    answeredPinStatus = new Map();
    placePins(gameId);

    // Önceki oturumdan kaydedilen ilerlemeyi geri yükle
    const savedProgress = loadGeoProgress(gameId);
    // Pass 1 — build Map so updateClusterAfterAnswer can consult it
    Object.entries(savedProgress).forEach(([pinId, status]) => {
        answeredPinStatus.set(pinId, status);
        if (status === 'correct') { score.correct++; }
        else if (status === 'passive') { score.shown++; }
    });
    // Pass 2 — apply CSS classes to normal (non-cluster) marker DOM elements
    Object.entries(savedProgress).forEach(([pinId, status]) => {
        const el = document.getElementById(`marker-${pinId}`);
        if (el) el.classList.add(status);
    });
    // Pass 3 — refresh cluster icons (green ✓ if all done)
    Object.keys(savedProgress).forEach(pinId => updateClusterAfterAnswer(pinId));
    if (Object.keys(savedProgress).length > 0) {
        updateScore();
        checkGameCompletion();
    }

    // Mobilde tam ekran yatay moda gir
    if (window.innerWidth < 900) {
        enterGeoFullscreen();
    }
}

// ============================================================
// TAM EKRAN COĞRAFİYA — Mobil yatay mod
// ============================================================

// ============================================================
// TAM EKRAN COĞRAFİYA
// ============================================================

function _onMapFullscreenChange() {
    const btn = document.getElementById('map-fs-btn');
    const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const isCssFs = document.body.classList.contains('geo-fullscreen');
    const isFs = isNativeFs || isCssFs;
    if (btn) {
        btn.querySelector('.map-btn-icon').innerText = isFs ? '⊠' : '⛶';
        btn.querySelector('.map-btn-label').innerText = isFs ? 'Çık' : 'Ekran';
    }
    setTimeout(() => { if (map) map.invalidateSize(); }, 120);
}

function _toggleMapFullscreen(btn) {
    const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const isCssFs = document.body.classList.contains('geo-fullscreen');

    const el = gameArea;
    const reqFS = el.requestFullscreen || el.webkitRequestFullscreen
               || el.mozRequestFullScreen || el.msRequestFullscreen;

    // ── iOS Safari ve requestFullscreen desteklemeyen tarayıcılar ──
    // requestFullscreen API'si yoksa tamamen CSS tabanlı tam ekrana geç
    if (!reqFS) {
        if (isCssFs) {
            // CSS tam ekrandan çık
            document.body.classList.remove('geo-fullscreen');
            document.body.style.overflow = '';
            if (btn) {
                btn.querySelector('.map-btn-icon').innerText = '⛶';
                btn.querySelector('.map-btn-label').innerText = 'Ekran';
            }
        } else {
            // CSS tam ekrana gir
            document.body.classList.add('geo-fullscreen');
            document.body.style.overflow = 'hidden';
            if (btn) {
                btn.querySelector('.map-btn-icon').innerText = '⊠';
                btn.querySelector('.map-btn-label').innerText = 'Çık';
            }
        }
        setTimeout(() => { if (map) map.invalidateSize(); }, 120);
        return;
    }

    // ── Normal tarayıcılar: native fullscreen API ──
    if (!isNativeFs) {
        reqFS.call(el).then(() => {
            if (screen.orientation && typeof screen.orientation.lock === 'function') {
                screen.orientation.lock('landscape').catch(() => {});
            }
        }).catch(() => {
            // Native tam ekran reddedildiyse (izin hatası vs.) CSS'e düş
            document.body.classList.add('geo-fullscreen');
            document.body.style.overflow = 'hidden';
            if (btn) {
                btn.querySelector('.map-btn-icon').innerText = '⊠';
                btn.querySelector('.map-btn-label').innerText = 'Çık';
            }
            setTimeout(() => { if (map) map.invalidateSize(); }, 120);
        });
    } else {
        const exitFS = document.exitFullscreen || document.webkitExitFullscreen
                     || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exitFS) exitFS.call(document).catch(() => {});
        if (screen.orientation && typeof screen.orientation.unlock === 'function') {
            try { screen.orientation.unlock(); } catch(e) {}
        }
    }
}

function enterGeoFullscreen() {
    document.body.classList.add('geo-fullscreen');
    document.body.style.overflow = 'hidden';
    // Buton ikonunu güncelle
    const btn = document.getElementById('map-fs-btn');
    if (btn) {
        btn.querySelector('.map-btn-icon').innerText = '⊠';
        btn.querySelector('.map-btn-label').innerText = 'Çık';
    }
    // Önce kaldır, sonra ekle — startGame yeniden çağrılınca listener birikmesini önler
    window.removeEventListener('orientationchange', _onGeoResize);
    window.removeEventListener('resize', _onGeoResize);
    window.addEventListener('orientationchange', _onGeoResize);
    window.addEventListener('resize', _onGeoResize);
    setTimeout(() => { if (map) map.invalidateSize(); }, 120);
}

function _onGeoResize() {
    setTimeout(() => { if (map) map.invalidateSize(); }, 120);
}

function exitGeoFullscreen() {
    document.body.classList.remove('geo-fullscreen');
    document.body.style.overflow = '';

    // Buton ikonunu güncelle
    const btn = document.getElementById('map-fs-btn');
    if (btn) {
        btn.querySelector('.map-btn-icon').innerText = '⛶';
        btn.querySelector('.map-btn-label').innerText = 'Ekran';
    }

    const exitFS = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exitFS && (document.fullscreenElement || document.webkitFullscreenElement)) {
        exitFS.call(document).catch(() => {});
    }
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        try { screen.orientation.unlock(); } catch(e) {}
    }

    window.removeEventListener('orientationchange', _onGeoResize);
    window.removeEventListener('resize', _onGeoResize);
    document.removeEventListener('fullscreenchange', _onMapFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    const prompt = document.getElementById('geo-rotate-prompt');
    if (prompt) prompt.remove();

    setTimeout(() => { if (map) map.invalidateSize(); }, 120);
}

function updateRotatePrompt() {
    setTimeout(() => { if (map) map.invalidateSize(); }, 80);
}
let spiderfyState = {
    activeGroupId: null,
    virtualMarkers: [],
};

// pinId → 'correct' | 'passive' — source of truth for cluster pins that have
// no persistent marker-${id} DOM element (spider-${id} is removed on collapse)
let answeredPinStatus = new Map();

// Koordinat bazlı çakışma eşiği (~8km)
const SPIDERFY_THRESHOLD = 0.08;
// Yelpaze yarıçapı (px)
const SPIDER_RADIUS = 55;

function getPinStyle(item) {
    let pinColor = '#3498db';
    let pinIcon = '';
    let pinClass = 'pin-body';
    if (item.type === 'cikarim') {
        pinColor = '#7f8c8d';
        pinIcon = '⛏️';
    } else if (item.type === 'isleme') {
        pinColor = '#e74c3c';
        pinIcon = '🏭';
        pinClass = 'pin-body factory-pin';
    }
    return { pinColor, pinIcon, pinClass };
}

function buildPinHTML(item, idPrefix) {
    const { pinColor, pinIcon, pinClass } = getPinStyle(item);
    return `
        <div class="premium-pin" id="${idPrefix}${item.id}">
            <div class="${pinClass}" style="background-color:${pinColor};">
                <span class="pin-number" style="font-size:14px;">${item.label === 'F' ? pinIcon : item.label}</span>
            </div>
        </div>
    `;
}

function placePins(gameId) {
    const pinsData = appData.gameData[gameId];
    currentMarkers = [];
    if (!pinsData) return;

    // Bu gameId spiderfy kullanıyor mu?
    // cikarim/isleme type'ı varsa evet
    const useSpiderfy = pinsData.some(p => p.type === 'cikarim' || p.type === 'isleme');

    if (!useSpiderfy) {
        // Yer şekilleri gibi — eski sade davranış
        pinsData.forEach(item => {
            const { pinColor, pinIcon, pinClass } = getPinStyle(item);
            const icon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: buildPinHTML(item, 'marker-'),
                iconSize: [40, 40], iconAnchor: [20, 42], popupAnchor: [0, -40]
            });
            const marker = L.marker([item.lat, item.lng], { icon }).addTo(map);
            marker.on('click', () => {
                const el = document.getElementById(`marker-${item.id}`);
                if (el && (el.classList.contains('correct') || el.classList.contains('passive'))) {
                    openInfoCard(item);
                    return;
                }
                openQuestion(item, marker);
            });
            currentMarkers.push({ leafletMarker: marker, dataId: item.id });
        });
        return;
    }

    // --- Spiderfy: koordinat bazlı gruplama ---
    const used = new Set();
    const groups = [];

    pinsData.forEach((itemA, i) => {
        if (used.has(i)) return;
        const group = [itemA];
        used.add(i);
        pinsData.forEach((itemB, j) => {
            if (used.has(j)) return;
            if (Math.abs(itemA.lat - itemB.lat) < SPIDERFY_THRESHOLD &&
                Math.abs(itemA.lng - itemB.lng) < SPIDERFY_THRESHOLD) {
                group.push(itemB);
                used.add(j);
            }
        });
        groups.push(group);
    });

    // Her grup için proxy marker bas
    groups.forEach((group, gIdx) => {
        const groupId = `g${gIdx}`;
        const anchor = group[0]; // grubun merkezi ilk pin

        if (group.length === 1) {
            // Tek pin — normal
            const icon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: buildPinHTML(anchor, 'marker-'),
                iconSize: [40, 40], iconAnchor: [20, 42], popupAnchor: [0, -40]
            });
            const marker = L.marker([anchor.lat, anchor.lng], { icon }).addTo(map);
            marker.on('click', () => {
                const el = document.getElementById(`marker-${anchor.id}`);
                if (el && (el.classList.contains('correct') || el.classList.contains('passive'))) {
                    openInfoCard(anchor);
                    return;
                }
                openQuestion(anchor, marker);
            });
            currentMarkers.push({ leafletMarker: marker, dataId: anchor.id });

        } else {
            // Birden fazla pin — cluster ikonu
            // NOT: placePins çağrılırken DOM'da marker-${id} elementleri henüz yok.
            // Kayıtlı ilerleme için answeredPinStatus Map'i kullanılır (startGame'de doldurulur).
            const doneCount = group.filter(item =>
                answeredPinStatus.has(item.id)
            ).length;
            const allDone = doneCount === group.length;
            const remaining = group.length - doneCount;

            const clusterInitStyle = allDone
                ? 'background:radial-gradient(circle at 35% 35%,#2ecc71,#1e8449);box-shadow:0 4px 12px rgba(46,204,113,0.5);'
                : '';
            const clusterInitLabel = allDone ? '✓' : (remaining < group.length ? remaining : group.length);

            const clusterIcon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: `
                    <div class="spider-cluster" id="cluster-${groupId}" style="${clusterInitStyle}">
                        <span class="cluster-count">${clusterInitLabel}</span>
                    </div>
                `,
                iconSize: [42, 42], iconAnchor: [21, 21]
            });

            const clusterMarker = L.marker([anchor.lat, anchor.lng], { icon: clusterIcon }).addTo(map);

            clusterMarker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                if (spiderfyState.activeGroupId === groupId) {
                    collapseSpiderfy();
                } else {
                    collapseSpiderfy();
                    expandSpiderfy(group, groupId, anchor, clusterMarker);
                }
            });

            // currentMarkers'a tüm grup üyelerini ekle (skor takibi için)
            group.forEach(item => {
                currentMarkers.push({ leafletMarker: clusterMarker, dataId: item.id });
            });
        }
    });

    // Haritaya tıklayınca spiderfy'ı kapat
    map.on('click', () => collapseSpiderfy());
}

function expandSpiderfy(group, groupId, anchor, clusterMarker) {
    spiderfyState.activeGroupId = groupId;
    spiderfyState.virtualMarkers = [];

    const centerLatLng = L.latLng(anchor.lat, anchor.lng);
    const centerPx = map.latLngToContainerPoint(centerLatLng);
    const count = group.length;

    // Yelpaze açısı: 100° yay, yukarı ortalanmış
    const FAN_DEG = 100;
    const fanRad = (FAN_DEG * Math.PI) / 180;
    const startAngle = -Math.PI / 2 - fanRad / 2; // Yukarı merkezli
    const angleStep = count > 1 ? fanRad / (count - 1) : 0;

    // Cluster ikonunu soluklaştır
    const clusterEl = document.getElementById(`cluster-${groupId}`);
    if (clusterEl) clusterEl.style.opacity = '0.35';

    group.forEach((item, i) => {
        const angle = count > 1 ? startAngle + angleStep * i : -Math.PI / 2;
        const targetPx = {
            x: centerPx.x + Math.cos(angle) * SPIDER_RADIUS,
            y: centerPx.y + Math.sin(angle) * SPIDER_RADIUS,
        };
        const targetLatLng = map.containerPointToLatLng([targetPx.x, targetPx.y]);

        // Leaflet polyline — zoom'da haritayla birlikte hareket eder
        const line = L.polyline([centerLatLng, targetLatLng], {
            color: 'rgba(255,255,255,0.75)',
            weight: 1.5,
            dashArray: '5 4',
            interactive: false,
        }).addTo(map);

        const savedStatus = answeredPinStatus.get(item.id);
        const alreadyDone = !!savedStatus || (() => {
            const el = document.getElementById(`marker-${item.id}`);
            return el && (el.classList.contains('correct') || el.classList.contains('passive'));
        })();
        const doneClass = alreadyDone
            ? ((savedStatus === 'passive' || (() => { const e = document.getElementById(`marker-${item.id}`); return e && e.classList.contains('passive'); })()) ? 'passive' : 'correct')
            : '';

        const { pinColor, pinIcon, pinClass } = getPinStyle(item);
        const spiderIcon = L.divIcon({
            className: 'custom-leaflet-icon spider-icon',
            html: `
                <div class="premium-pin spider-pin ${doneClass}"
                     id="spider-${item.id}"
                     style="opacity:0; transform:scale(0.3);">
                    <div class="${pinClass}" style="background-color:${pinColor};">
                        <span class="pin-number" style="font-size:14px;">
                            ${item.label === 'F' ? pinIcon : item.label}
                        </span>
                    </div>
                </div>
            `,
            iconSize: [40, 40], iconAnchor: [20, 42],
        });

        const spiderMarker = L.marker(targetLatLng, { icon: spiderIcon, zIndexOffset: 1000 }).addTo(map);

        spiderMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            const el = document.getElementById(`spider-${item.id}`);
            const isDone = !!answeredPinStatus.get(item.id) || alreadyDone || (el && (el.classList.contains('correct') || el.classList.contains('passive')));
            if (isDone) {
                openInfoCard(item);
                return;
            }
            openQuestion(item, spiderMarker);
        });

        spiderfyState.virtualMarkers.push({ marker: spiderMarker, line, item });

        // Gecikimli giriş animasyonu
        setTimeout(() => {
            const el = document.getElementById(`spider-${item.id}`);
            if (el) {
                el.style.transition = 'opacity 0.2s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
                el.style.opacity = '1';
                el.style.transform = 'scale(1)';
            }
        }, i * 60);
    });
}

function collapseSpiderfy() {
    if (!spiderfyState.activeGroupId) return;

    spiderfyState.virtualMarkers.forEach(({ marker, line, item }) => {
        const el = document.getElementById(`spider-${item.id}`);
        if (el) {
            el.style.opacity = '0';
            el.style.transform = 'scale(0.3)';
        }
        setTimeout(() => {
            map.removeLayer(marker);
            map.removeLayer(line);
        }, 200);
    });

    const clusterEl = document.getElementById(`cluster-${spiderfyState.activeGroupId}`);
    if (clusterEl) clusterEl.style.opacity = '1';

    spiderfyState.activeGroupId = null;
    spiderfyState.virtualMarkers = [];
}

// --- CLUSTER GÜNCELLEME (cevap sonrası) ---
// placePins ile BİREBİR aynı gruplama mantığı kullanılır:
// Tüm gruplar (tekli dahil) gIdx ile sayılır → groupId = g{gIdx}
// Tekli pinler index'e dahil edilmezse cluster'lar yanlış id'yi bulur.
function updateClusterAfterAnswer(itemId) {
    const gameId = currentGameId;
    const pinsData = appData.gameData[gameId];
    if (!pinsData) return;

    const THRESHOLD = SPIDERFY_THRESHOLD; // placePins ile aynı sabit: 0.08
    const used = new Set();
    let gIdx = 0;

    pinsData.forEach((itemA, i) => {
        if (used.has(i)) return;
        const group = [itemA];
        used.add(i);
        pinsData.forEach((itemB, j) => {
            if (used.has(j)) return;
            if (Math.abs(itemA.lat - itemB.lat) < THRESHOLD &&
                Math.abs(itemA.lng - itemB.lng) < THRESHOLD) {
                group.push(itemB);
                used.add(j);
            }
        });

        // placePins: groups.forEach((group, gIdx)) — her grup sayılır (tekli dahil)
        if (group.length > 1) {
            const groupId = `g${gIdx}`;
            const hasItem = group.some(p => p.id === itemId);
            if (hasItem) {
                const clusterEl = document.getElementById(`cluster-${groupId}`);
                if (clusterEl) {
                    // answeredPinStatus source of truth; DOM ikinci plan
                    const remaining = group.filter(p => {
                        if (answeredPinStatus.has(p.id)) return false;
                        const mEl = document.getElementById(`marker-${p.id}`);
                        const sEl = document.getElementById(`spider-${p.id}`);
                        return !((mEl && (mEl.classList.contains('correct') || mEl.classList.contains('passive')))
                              || (sEl && (sEl.classList.contains('correct') || sEl.classList.contains('passive'))));
                    }).length;

                    const countEl = clusterEl.querySelector('.cluster-count');
                    if (remaining === 0) {
                        clusterEl.style.background = 'radial-gradient(circle at 35% 35%, #2ecc71, #1e8449)';
                        clusterEl.style.boxShadow = '0 4px 12px rgba(46,204,113,0.5)';
                        if (countEl) countEl.innerText = '\u2713'; // ✓
                    } else {
                        if (countEl) countEl.innerText = remaining;
                    }
                }
            }
        }

        gIdx++; // TEKLİ GRUPLAR DAHİL — placePins forEach gIdx ile eşdeğer
    });
}

// --- OYUN TAMAMLANDI MI? ---
function checkGameCompletion() {
    const gameId = currentGameId;
    const pinsData = appData.gameData[gameId];
    if (!pinsData) return;

    const total = pinsData.length;
    const done = pinsData.filter(p => {
        if (answeredPinStatus.has(p.id)) return true;
        const markerEl = document.getElementById(`marker-${p.id}`);
        const spiderEl = document.getElementById(`spider-${p.id}`);
        return (markerEl && (markerEl.classList.contains('correct') || markerEl.classList.contains('passive')))
            || (spiderEl && (spiderEl.classList.contains('correct') || spiderEl.classList.contains('passive')));
    }).length;

    if (done >= total) {
        setTimeout(() => showCompletionScreen(), 400);
    }
}

function showCompletionScreen(lastItem) {
    const existing = document.getElementById('completion-overlay');
    if (existing) existing.remove();

    // Açık balon varsa kapat
    const existingBubble = document.getElementById('match-info-bubble');
    if (existingBubble) existingBubble.remove();

    const total = score.correct + score.wrong + score.shown;
    const pct = total > 0 ? Math.round((score.correct / total) * 100) : 0;

    let emoji = '🏆';
    let title = 'Mükemmel!';
    let subtitle = 'Tüm noktaları tamamladın!';
    let accentClass = 'completion-accent-gold';
    if (pct < 100 && pct >= 70) { emoji = '🎯'; title = 'Çok İyi!'; subtitle = `${pct}% başarı oranı — az kaldı!`; accentClass = 'completion-accent-blue'; }
    else if (pct < 70) { emoji = '📚'; title = 'Tekrar Çalış!'; subtitle = `${pct}% başarı — bu konuyu pekiştir.`; accentClass = 'completion-accent-amber'; }

    const circumference = 100.53; // 2π × 16
    const offset = circumference - (pct / 100) * circumference;
    const pinsTotal = (appData.gameData[currentGameId] || []).length;

    // Son pin bilgi kartı HTML’i (sadece match modunda ve desc varsa)
    const lastItemHTML = (lastItem && lastItem.desc) ? `
        <div class="completion-last-item">
            <div class="cli-label">Son ö\u011frenilen</div>
            <div class="cli-name">${lastItem.names[0].toLocaleUpperCase('tr')}</div>
            <div class="cli-desc">${lastItem.type === 'isleme' ? '🏭' : '⛏️'} ${lastItem.desc}</div>
        </div>
    ` : '';

    const overlay = document.createElement('div');
    overlay.id = 'completion-overlay';
    overlay.innerHTML = `
        <div class="completion-card ${accentClass}">
            <div class="completion-emoji">${emoji}</div>
            <h2 class="completion-title">${title}</h2>
            <p class="completion-sub">${subtitle}</p>
            ${lastItemHTML}

            <div class="completion-accuracy-ring">
                <svg viewBox="0 0 44 44" class="completion-ring-svg">
                    <circle class="completion-ring-bg" cx="22" cy="22" r="16"/>
                    <circle class="completion-ring-fill" cx="22" cy="22" r="16"
                        stroke-dasharray="${circumference}"
                        stroke-dashoffset="${circumference}"
                        id="completion-ring-anim"/>
                </svg>
                <div class="completion-ring-label">
                    <span class="completion-ring-pct" id="completion-pct-num">0%</span>
                    <span class="completion-ring-sub">doğruluk</span>
                </div>
            </div>

            <div class="completion-stats">
                <div class="cstat cstat-correct">
                    <span class="cstat-num">${score.correct}</span>
                    <span class="cstat-label">Doğru</span>
                </div>
                <div class="cstat cstat-wrong">
                    <span class="cstat-num">${score.wrong}</span>
                    <span class="cstat-label">Yanlış</span>
                </div>
                <div class="cstat cstat-shown">
                    <span class="cstat-num">${score.shown}</span>
                    <span class="cstat-label">Gösterildi</span>
                </div>
            </div>

            <div class="completion-btns">
                <button class="completion-btn completion-btn-secondary" onclick="document.getElementById('completion-overlay').remove()">
                    🗺️ Haritayı Gör
                </button>
                <button class="completion-btn completion-btn-primary" onclick="document.getElementById('completion-overlay').remove(); backBtn.onclick();">
                    Ana Menü
                </button>
            </div>
        </div>
    `;
    // completion-overlay'i gameArea'ya ekle (map container'ına değil)
    // Böylece map-switcher butonları overlay tarafından bloklanmaz
    document.getElementById('game-area').appendChild(overlay);

    // Halka animasyonu
    setTimeout(() => {
        const ring = document.getElementById('completion-ring-anim');
        const pctEl = document.getElementById('completion-pct-num');
        if (ring) ring.style.strokeDashoffset = offset;
        // Sayaç animasyonu
        if (pctEl) {
            let current = 0;
            const interval = setInterval(() => {
                current = Math.min(current + Math.ceil(pct / 30), pct);
                pctEl.innerText = current + '%';
                if (current >= pct) clearInterval(interval);
            }, 40);
        }
    }, 200);
}

// --- HARİTA SIFIRLAMA ---
// Global fonksiyon — onclick attribute ile çağrılır, addEventListener yok
function handleMapReset() {
    const btn = document.getElementById('map-reset-btn');
    if (btn && btn.disabled) return;
    const gameId = currentGameId;
    const hudTitle = document.getElementById('hud-title');
    const title = hudTitle ? hudTitle.innerText : '';
    showResetConfirm(`"${title}" haritasındaki tüm ilerleme silinecek. Emin misin?`, () => {
        clearGeoProgress(gameId);
        // Match modu mu, normal mod mu kontrol et
        if (_matchState) {
            startMatchMode(gameId, title, _currentParentId);
        } else {
            startGame(gameId, title, _currentParentId);
        }
    });
}

// Çözülmüş pin sayısına göre sıfırla butonunu aktif/pasif yap
function updateResetButton() {
    const btn = document.getElementById('map-reset-btn');
    if (!btn) return;
    const hasSolved = (score.correct + score.wrong + score.shown) > 0;
    btn.disabled = !hasSolved;
}


// ─────────────────────────────────────────────────────────────
// GEO SORU MOTORU — meta alanlara göre otomatik MC üretir
// ─────────────────────────────────────────────────────────────

// Doğru/yanlış/göster sonrası gösterilecek meta bilgi HTML'i
function _geoInfoHTML(item, textColor) {
    if (!item || item.q) return ''; // tarih sorusu değil
    const parts = [];
    if (item.river)     parts.push(`⚡ <b>${item.river.charAt(0).toUpperCase()+item.river.slice(1)}</b> üzerinde`);
    if (item.sea)       parts.push(`🌊 <b>${GEO_SEA_LABELS[item.sea]||item.sea}</b>'ye dökülür`);
    if (item.region)    parts.push(`📍 <b>${GEO_REGION_LABELS[item.region]||item.region}</b>`);
    if (item.formation) parts.push(`🗺️ <b>${GEO_FORMATION_LABELS[item.formation]||item.formation}</b> oluşum`);
    if (item.project)   parts.push(`🏗️ <b>${item.project.toUpperCase()}</b>`);
    if (item.regime)    parts.push(`📊 <b>${item.regime}</b> rejim`);

    let html = '';
    if (parts.length) {
        html += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;">` +
            parts.map(p => `<span style="font-size:0.75rem;background:rgba(0,0,0,0.06);padding:2px 7px;border-radius:20px;">${p}</span>`).join('') +
            `</div>`;
    }
    if (item.desc) {
        html += `<div style="font-size:0.82rem;color:${textColor||'var(--ink-500)'};margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.07);">${item.desc}</div>`;
    }
    return html;
}

const GEO_REGION_LABELS = {
    karadeniz: "Karadeniz Bölgesi", marmara: "Marmara Bölgesi",
    ege: "Ege Bölgesi", akdeniz: "Akdeniz Bölgesi",
    ic_anadolu: "İç Anadolu Bölgesi", dogu_anadolu: "Doğu Anadolu Bölgesi",
    guneydogu_anadolu: "Güneydoğu Anadolu Bölgesi"
};
const GEO_SEA_LABELS = {
    karadeniz: "Karadeniz", marmara: "Marmara Denizi",
    ege: "Ege Denizi", akdeniz: "Akdeniz",
    basra_korfezi: "Basra Körfezi (Irak)", hazar: "Hazar Denizi (Azerbaycan)"
};
const GEO_FORMATION_LABELS = {
    karstik: "Karstik (erime)", tektonik: "Tektonik (fay/çöküntü)",
    volkanik: "Volkanik (lav)", delta: "Delta (alüvyal birikme)"
};

function openQuestion(item, markerObject = null) {
    currentMountain = item;
    currentMountain.markerRef = markerObject;
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('question-modal').style.display = 'block';

    const topicLabel = document.getElementById('topic-label');
    if (topicLabel) {
        if (item.topicTitle) {
            topicLabel.innerText = item.topicTitle;
            topicLabel.style.display = 'block';
        } else {
            topicLabel.style.display = 'none';
        }
    }

    const qTitle = document.getElementById('q-title');
    if (item.q) {
        qTitle.innerText = item.q;
    } else {
        qTitle.innerText = (item.label || "?") + " numaralı yer neresidir?";
    }

    // Coğrafya: HUD subtitle güncelle
    if (!item.q) {
        const hudSub = document.getElementById('hud-subtitle');
        if (hudSub) hudSub.innerText = `${item.label} numaralı nokta seçildi`;
    }

    // ── GEO PIN BAĞLAM BALONCUĞU & SEÇİLİ PİN VURGUSU ──────────
    // Sadece coğrafya modunda (item.q yok) göster
    if (!item.q) {
        // Eski balon ve vurguları temizle
        const oldBubble = document.getElementById('geo-pin-bubble');
        if (oldBubble) oldBubble.remove();
        document.querySelectorAll('.geo-pin-selected').forEach(el => el.classList.remove('geo-pin-selected'));

        // Seçili pin DOM elementini vurgula (normal ve spider pinler)
        const pinEl    = document.getElementById(`marker-${item.id}`);
        const spiderEl = document.getElementById(`spider-${item.id}`);
        if (pinEl)    pinEl.classList.add('geo-pin-selected');
        if (spiderEl) spiderEl.classList.add('geo-pin-selected');

        // Haritada mini "seçili" balon — game-area'ya inject et
        const gameArea = document.getElementById('game-area');
        if (gameArea && document.body.classList.contains('geo-fullscreen')) {
            const pinName = (item.names && item.names[0])
                ? item.names[0].toLocaleUpperCase('tr')
                : '';
            // Kategoriye göre ikon
            let catIcon = '📍';
            if (item.type === 'cikarim')  catIcon = '⛏️';
            if (item.type === 'isleme')   catIcon = '🏭';
            if (item.formation === 'volkanik') catIcon = '🌋';
            if (item.sea)    catIcon = '🌊';
            if (item.river)  catIcon = '🏞️';
            if (item.region) catIcon = '🗺️';

            const bubble = document.createElement('div');
            bubble.id = 'geo-pin-bubble';
            bubble.innerHTML = `
                <div class="geo-bubble-pin-dot"></div>
                <span class="geo-bubble-label">${catIcon} ${pinName || ('No. ' + item.label)}</span>
                <span class="geo-bubble-num">${item.label}</span>
            `;
            gameArea.appendChild(bubble);
        }
    }
    // ─────────────────────────────────────────────────────────────

    // Coğrafya: modal'a kategori badge ekle
    const existingBadge = document.getElementById('geo-category-badge');
    if (existingBadge) existingBadge.remove();

    if (!item.q) {
        let badgeLabel = 'Yer Şekli';
        let badgeIcon  = '🏔️';
        let badgeClass = 'geo-badge-geo';
        if (item.type === 'cikarim')  { badgeLabel = 'Maden Çıkarımı'; badgeIcon = '⛏️'; badgeClass = 'geo-badge-mine'; }
        if (item.type === 'isleme')   { badgeLabel = 'İşleme Tesisi';  badgeIcon = '🏭'; badgeClass = 'geo-badge-factory'; }

        const badge = document.createElement('div');
        badge.id = 'geo-category-badge';
        badge.className = `geo-badge ${badgeClass}`;
        badge.innerHTML = `<span>${badgeIcon}</span> ${badgeLabel}`;
        document.getElementById('question-modal').insertBefore(badge, document.getElementById('q-title'));
    }

    const input = document.getElementById('user-answer');
    input.value = "";
    input.readOnly = false;
    document.getElementById('feedback').innerText = "";
    wrongAttempts = 0;
    hintLevel = 0;
    hintTokens = 3;  // Her yeni soruda ipucu hakkı sıfırla

    // Tarih sorusu ise butonları ve UI'yi ayarla
    if (item.q) {
        document.querySelector('.btn-check').style.display = 'block';
        document.querySelector('.btn-giveup').style.display = 'inline-block';
        document.getElementById('btn-finish').style.display = 'block';
        document.querySelector('.btn-close').style.display = 'inline-block';
        // İpucu yalnızca açık uçlu (MC olmayan) sorularda göster
        const isMC = item.options && item.options.length > 0;
        document.getElementById('hint-area').style.display = isMC ? 'none' : 'block';
        if (!isMC) updateHintButton();
        updateHistoryQuizUI(false);
    } else {
        // Coğrafya: tarih özel buton/elementleri gizle
        const prevBtn = document.getElementById('btn-prev-question');
        if (prevBtn) prevBtn.style.display = 'none';
        const progressEl = document.getElementById('quiz-progress');
        if (progressEl) progressEl.style.display = 'none';
        document.getElementById('btn-finish').style.display = 'none';
        document.getElementById('hint-area').style.display = 'none';
        document.querySelector('.btn-check').style.display = 'block';
        document.querySelector('.btn-giveup').style.display = 'inline-block';
        document.querySelector('.btn-close').style.display = 'inline-block';
    }

    // Çoktan seçmeli mi, açık uçlu mu?
    if (item.options && item.options.length) {
        renderMultipleChoice(item);
    } else {
        document.getElementById('mc-area').style.display = 'none';
        input.style.display = 'block';
        document.querySelector('.btn-check').style.display = 'block';
        // iOS: modal display:block olduktan sonra bir frame bekle, sonra focus
        // (display:none → block geçişinde iOS focus'u reddedebilir)
        const isMobile = window.innerWidth <= 640;
        if (isMobile) {
            requestAnimationFrame(() => setTimeout(() => input.focus(), 100));
        } else {
            input.focus();
        }
    }
}

function renderMultipleChoice(item) {
    const input = document.getElementById('user-answer');
    const btnCheck = document.querySelector('.btn-check');
    const btnGiveup = document.querySelector('.btn-giveup');
    const btnClose = document.querySelector('.btn-close');

    // Input ve kontrol et butonunu gizle, diğerleri görünür kalsın
    input.style.display = 'none';
    btnCheck.style.display = 'none';
    btnGiveup.style.display = 'inline-block';
    btnClose.style.display = 'inline-block';
    document.getElementById('hint-area').style.display = 'none';
    document.getElementById('btn-finish').style.display = 'inline-block';

    const labels = ['A', 'B', 'C', 'D', 'E'];
    const shuffled = shuffleArray(item.options); // Fisher-Yates (Math.random-0.5 bias'ını önler)

    const mcArea = document.getElementById('mc-area');
    mcArea.style.display = 'flex';
    mcArea.innerHTML = '';
    shuffled.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'mc-option';
        btn.innerHTML = `<span class="mc-label">${labels[i]}</span><span class="mc-text">${opt}</span>`;
        btn.addEventListener('click', () => selectMCOption(btn, opt));
        mcArea.appendChild(btn);
    });
}

function selectMCOption(btn, selected) {
    // Tıklamayı devre dışı bırak (zaten cevaplanıyor)
    const allBtns = document.querySelectorAll('.mc-option');
    allBtns.forEach(b => b.disabled = true);

    const _correctAnswers = _getCorrectAnswers(currentMountain);
    const correctAnswer = _correctAnswers[0];
    const isCorrect = _correctAnswers.some(a => normalizeText(selected) === normalizeText(a));

    const feedback = document.getElementById('feedback');

    if (isCorrect) {
        btn.classList.add('mc-correct');
        feedback.style.color = '#059669';
        feedback.innerHTML = '<b>DOĞRU!</b>';
        if (typeof playSound === 'function') playSound('correct');
        const _geoInfo = _geoInfoHTML(currentMountain, '#059669');
        if (_geoInfo) {
            feedback.innerHTML += _geoInfo;
        } else if (currentMountain.desc) {
            feedback.innerHTML += `<br><span style="font-size:0.82rem;color:#059669;display:block;margin-top:4px;">${currentMountain.desc}</span>`;
        }
        score.correct++;
        updateScore();
        // Quiz ise history'ye ekle (mapquiz ise bu dala girme)
        if (currentMountain.q && !currentMountain._isMapQuiz) {
            const idx = quizHistory.findIndex(h => h.item.id === currentMountain.id);
            const record = { item: currentMountain, userAnswer: selected, status: 'correct' };
            if (idx !== -1) {
                quizHistory[idx] = record;
            } else {
                quizHistory.push(record);
            }
            // MC doğru: wrongAttempts 0 olduğundan attemptsToSolve=1 (ilk denemede bildi)
            saveQuestionResult(currentMountain.topicId, currentMountain.id, 'correct', wrongAttempts + 1);
            _scheduleNext(() => { closeModal(); nextQuestion(); }, 1000);
        } else {
            _scheduleNext(closeModal, 900);
        }
    } else {
        // BUG FIX: MC'de yanlış seçimde wrongAttempts artırılıyordu eksik — istatistik artık doğru
        wrongAttempts++;
        btn.classList.add('mc-wrong');
        if (typeof playSound === 'function') playSound('wrong');
        // Doğru olanı yeşil yap
        allBtns.forEach(b => {
            const bText = b.querySelector('.mc-text').innerText;
            if (_getCorrectAnswers(currentMountain).some(a => normalizeText(bText) === normalizeText(a))) {
                b.classList.add('mc-correct');
            }
        });
        feedback.style.color = '#e11d48';
        feedback.innerHTML = `<b>YANLIŞ!</b> Doğru cevap işaretlendi.`;
        const _geoInfoW = _geoInfoHTML(currentMountain, '#44403c');
        if (_geoInfoW) {
            feedback.innerHTML += _geoInfoW;
        } else if (currentMountain.desc) {
            feedback.innerHTML += `<br><span style="font-size:0.82rem;color:#44403c;display:block;margin-top:4px;">${currentMountain.desc}</span>`;
        }
        score.wrong++;
        updateScore();
        if (currentMountain.q && !currentMountain._isMapQuiz) {
            const idx = quizHistory.findIndex(h => h.item.id === currentMountain.id);
            const record = { item: currentMountain, userAnswer: selected, status: 'wrong' };
            if (idx !== -1) quizHistory[idx] = record; else quizHistory.push(record);
            // wrongAttempts MC'de artık takip ediliyor — attemptsToSolve doğru kaydedilir
            saveQuestionResult(currentMountain.topicId, currentMountain.id, 'wrong', wrongAttempts);
            _scheduleNext(() => { closeModal(); nextQuestion(); }, currentMountain.desc ? 2500 : 1800);
        } else {
            _scheduleNext(closeModal, 1800);
        }
    }

    // Shake animasyonu yanlışta
    if (!isCorrect) {
        shakeModal();
    }
}

// Shake animasyon yardımcısı: mobil portre bottom-sheet vs ortalanmış modal
function shakeModal() {
    const modal = document.getElementById('question-modal');
    if (!modal) return;
    // Modal'ın gerçek computed transform'una bak:
    // Bottom sheet (mobil portre) → transform: matrix(1,0,0,1,0,0) veya none
    // Ortalanmış modal → transform: matrix içinde -50% translate var (none değil)
    const computed = window.getComputedStyle(modal).transform;
    // "none" veya identity matrix(1,0,0,1,0,0) → bottom sheet
    const isBottomSheet = (computed === 'none' || computed === 'matrix(1, 0, 0, 1, 0, 0)');
    const cls = isBottomSheet ? 'apply-shake-bottom' : 'apply-shake';
    modal.classList.add(cls);
    setTimeout(() => modal.classList.remove(cls), 450);
}

// --- TARİH QUIZ UI (ilerleme + önceki soru butonu) ---

function updateProgressBar() {
    const fill = document.getElementById('modal-progress-fill');
    const total = originalQuizLength || currentQuiz.length;
    if (!fill || total === 0) return;
    const pct = Math.min((questionIndex / total) * 100, 100);
    fill.style.width = pct + '%';

    if (pct < 50) {
        fill.style.background = 'linear-gradient(90deg, #3498db, #2ecc71)';
    } else if (pct < 85) {
        fill.style.background = 'linear-gradient(90deg, #f39c12, #27ae60)';
    } else {
        fill.style.background = 'linear-gradient(90deg, #27ae60, #2ecc71)';
    }
}

function updateHistoryQuizUI(isHistoryView) {
    const prevBtn = document.getElementById('btn-prev-question');
    const progressEl = document.getElementById('quiz-progress');

    if (progressEl) {
        const total = originalQuizLength || currentQuiz.length;
        const current = isHistoryView ? (historyViewIndex + 1) : questionIndex;
        progressEl.innerText = `${Math.min(current, total)} / ${total}`;
        progressEl.style.display = 'block';
    }

    if (prevBtn) {
        if (quizHistory.length > 0 && !isHistoryView) {
            prevBtn.style.display = 'inline-block';
            prevBtn.innerText = '◀ Önceki Soru';
            prevBtn.onclick = goToPrevQuestion;
        } else if (isHistoryView) {
            const idx = quizHistory.indexOf(currentHistoryItem);
            prevBtn.style.display = idx > 0 ? 'inline-block' : 'none';
            if (idx > 0) {
                prevBtn.innerText = '◀ Önceki Soru';
                prevBtn.onclick = goToPrevInHistory;
            }
        } else {
            prevBtn.style.display = 'none';
        }
    }
}

function goToPrevQuestion() {
    historyViewIndex = quizHistory.length - 1;
    currentHistoryItem = quizHistory[historyViewIndex];
    showHistoryQuestion(historyViewIndex);
}

// --- İPUCU SİSTEMİ FONKSİYONLARI ---

// Düğmenin metnini ve durumunu günceller
function updateHintButton() {
    const btn = document.getElementById('btn-hint');
    const badge = document.getElementById('hint-token-badge');
    const label = btn ? btn.querySelector('.hint-text-label') : null;
    if (!btn) return;

    if (badge) badge.innerText = hintTokens;

    if (hintTokens <= 0) {
        if (label) label.innerText = 'İpucu Hakkı Kalmadı';
        btn.disabled = true;
    } else if (hintLevel === 0) {
        if (label) label.innerText = 'İpucu Kullan';
        btn.disabled = false;
    } else if (hintLevel === 1) {
        if (label) label.innerText = 'Daha Fazla İpucu';
        btn.disabled = false;
    } else {
        if (label) label.innerText = 'İpucu Kullanıldı';
        btn.disabled = true;
    }
}

function useHint() {
    if (hintTokens <= 0 || !currentMountain || !_getCorrectAnswers(currentMountain).length) return;

    const correctAnswer = _getCorrectAnswers(currentMountain)[0];
    const feedback = document.getElementById('feedback');
    hintTokens--;
    hintLevel++;

    let hintText = '';

    if (hintLevel === 1) {
        // Seviye 1: İlk harf + kaç harfli olduğu
        const firstLetter = correctAnswer[0].toLocaleUpperCase('tr');
        const wordCount = correctAnswer.trim().split(/\s+/).length;
        const letterCount = correctAnswer.replace(/\s/g, '').length;
        hintText = `💡 <b>İpucu:</b> İlk harf <b style="color:#8e44ad; font-size:1.1rem;">${firstLetter}</b> — ${wordCount} kelime, toplam ${letterCount} harf`;
    } else if (hintLevel === 2) {
        // Seviye 2: Her kelimeyi ___ deseni olarak göster (ilk harf açık)
        const words = correctAnswer.trim().split(/\s+/);
        const pattern = words.map(word => {
            const first = word[0].toLocaleUpperCase('tr');
            const rest = '_ '.repeat(word.length - 1).trim();
            return `<b style="color:#8e44ad">${first}</b>${rest ? rest : ''}`;
        }).join('&nbsp;&nbsp;');
        hintText = `💡 <b>İpucu:</b> ${pattern}`;
    }

    feedback.style.color = '#8e44ad';
    feedback.innerHTML = hintText;
    updateHintButton();
}

function goToPrevInHistory() {
    historyViewIndex--;
    if (historyViewIndex < 0) historyViewIndex = 0;
    currentHistoryItem = quizHistory[historyViewIndex];
    showHistoryQuestion(historyViewIndex);
}

function showHistoryQuestion(idx) {
    const record = quizHistory[idx];
    if (!record) return;

    currentHistoryItem = record;
    currentMountain = record.item;

    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('question-modal').style.display = 'block';

    // ── GÖRSEL: önceki soruya dönünce görseli yeniden inject et ──
    // openQuestion wrap'ı bypass edildiğinden _injectVisualFn manuel çağrılır.
    if (typeof window._injectVisualFn === 'function') {
        window._injectVisualFn(record.item);
    }
    // Görsel Firestore'dan yükleniyor idiyse (url yok, b64 cache/Firestore'da) onu da çek
    if (typeof window._loadFirestoreVisualFn === 'function') {
        window._loadFirestoreVisualFn(record.item);
    }

    const topicLabel = document.getElementById('topic-label');
    if (topicLabel) {
        if (record.item.topicTitle) {
            topicLabel.innerText = record.item.topicTitle;
            topicLabel.style.display = 'block';
        } else {
            topicLabel.style.display = 'none';
        }
    }

    document.getElementById('q-title').innerText = record.item.q || "Soru";

    const input = document.getElementById('user-answer');
    const feedback = document.getElementById('feedback');
    const correctAnswer = (_getCorrectAnswers(record.item)[0] || '').toUpperCase();

    // MC sorusu mu?
    const mcArea = document.getElementById('mc-area');
    if (record.item.options && record.item.options.length && mcArea) {
        // Input gizle, MC şıklarını render et (disabled + renkli)
        input.style.display = 'none';
        const labels = ['A', 'B', 'C', 'D', 'E'];
        // Aynı karıştırma sırasını korumak için option sırası önemli değil — hepsini göster
        const opts = record.item.options;
        mcArea.style.display = 'flex';
        mcArea.innerHTML = opts.map((opt, i) => {
            const isCorrect = _getCorrectAnswers(record.item).some(a => normalizeText(opt) === normalizeText(a));
            const isUserWrong = record.status === 'wrong' && normalizeText(opt) === normalizeText(record.userAnswer);
            let cls = 'mc-option';
            if (isCorrect) cls += ' mc-correct';
            else if (isUserWrong) cls += ' mc-wrong';
            return `<button class="${cls}" disabled>
                <span class="mc-label">${labels[i]}</span>
                <span class="mc-text">${opt}</span>
            </button>`;
        }).join('');
    } else {
        input.value = correctAnswer;
        input.readOnly = true;
        if (mcArea) { mcArea.style.display = 'none'; mcArea.innerHTML = ''; }
    }

    if (record.status === 'correct') {
        feedback.style.color = "#27ae60";
        feedback.innerHTML = `<b>✓ DOĞRU</b>`;
    } else if (record.status === 'wrong') {
        feedback.style.color = "#e74c3c";
        feedback.innerHTML = `<b>✗ YANLIŞ</b> — Seçtiğin: ${record.userAnswer || '(boş)'}`;
    } else {
        feedback.style.color = "#f39c12";
        feedback.innerHTML = `<b>Cevap Gösterildi</b>`;
    }

    if (record.item.desc) {
        feedback.innerHTML += `<br><span style="font-size:0.9rem; color:#555;">${record.item.desc}</span>`;
    }

    const progressEl = document.getElementById('quiz-progress');
    if (progressEl) {
        const total = originalQuizLength || currentQuiz.length;
        progressEl.innerText = `${idx + 1} / ${total}`;
        progressEl.style.display = 'block';
    }

    // Geçmiş modunda: cevap/cevabı göster gizle, önceki + bıraktığın yere dön göster
    document.querySelector('.btn-check').style.display = 'none';
    document.querySelector('.btn-giveup').style.display = 'none';
    document.getElementById('btn-finish').style.display = 'none';
    document.getElementById('hint-area').style.display = 'none';
    document.querySelector('.btn-close').style.display = 'none';

    const prevBtn = document.getElementById('btn-prev-question');
    if (prevBtn) {
        if (idx > 0) {
            prevBtn.style.display = 'inline-block';
            prevBtn.innerText = "◀ Önceki Soru";
            prevBtn.onclick = () => {
                historyViewIndex--;
                currentHistoryItem = quizHistory[historyViewIndex];
                showHistoryQuestion(historyViewIndex);
            };
        } else {
            prevBtn.style.display = 'none';
        }
    }

    const resumeBtn = document.createElement('button');
    resumeBtn.style.cssText = 'background:#3498db; color:white; border:none; border-radius:8px; padding:10px 20px; font-weight:bold; cursor:pointer; margin-top:8px; font-size:1rem;';
    resumeBtn.textContent = 'Bıraktığın Yere Dön ▶';
    resumeBtn.addEventListener('click', resumeQuiz);
    feedback.appendChild(document.createElement('br'));
    feedback.appendChild(document.createElement('br'));
    feedback.appendChild(resumeBtn);
}

function resumeQuiz() {
    historyViewIndex = -1;
    currentHistoryItem = null;

    // mc-area temizle
    const mcArea = document.getElementById('mc-area');
    if (mcArea) { mcArea.style.display = 'none'; mcArea.innerHTML = ''; }

    const input = document.getElementById('user-answer');
    if (input) { input.readOnly = false; input.value = ''; input.style.display = 'block'; }

    const feedback = document.getElementById('feedback');
    if (feedback) feedback.innerHTML = '';

    // questionIndex nextQuestion() içinde AÇILMADAN ÖNCE artırılır.
    // Dolayısıyla kullanıcı N. sorudayken questionIndex = N (1-tabanlı).
    // Önceki soruya geçince quiz N. soruya dönmeli — artırmadan aç.
    if (questionIndex > currentQuiz.length) {
        finishQuiz();
    } else if (questionIndex === 0) {
        // Henüz hiç soru açılmamış
        nextQuestion();
    } else {
        // questionIndex'i değiştirmeden kaldığımız soruyu yeniden aç
        const currentItem = currentQuiz[questionIndex - 1];
        openQuestion(currentItem);
        updateProgressBar();
        updateHistoryQuizUI(false);
    }
}

// --- CEVAP KONTROL ---

// ============================================================
// ÇOKTAN SEÇMELİ YARDIMCI: hem eski a[] hem yeni options+correct formatını destekler
// Döner: doğru cevapların string dizisi (her zaman array)
// ============================================================
function _getCorrectAnswers(item) {
    // Yeni format: options[] + correct (index)
    if (item.options && item.options.length && typeof item.correct === 'number') {
        return [item.options[item.correct]];
    }
    // Eski format: a[]
    if (item.a && item.a.length) return item.a;
    return [];
}

// ============================================================
// NORMALIZE: Türkçe karakter → ASCII, tire/kesme → kaldır,
// Osmanlıca uzun ünlü işaretleri (â,î,û) → normalize
// ============================================================
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLocaleLowerCase('tr')          // İ→i (TR'ye özgü)
        .replace(/ı/g, 'i')               // ı→i
        .replace(/ş/g, 's')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/â/g, 'a')               // harekât, hâkim
        .replace(/î/g, 'i')               // kadî, mîr
        .replace(/û/g, 'u')               // mahkûm
        .replace(/[-''\u2018\u2019\u201B\u2032]/g, '') // tire & kesme: feth-i → fethi
        .trim()
        .replace(/\s+/g, ' ');
}

// ============================================================
// OPSİYONEL SUFFIX LİSTESİ (normalize edilmiş haller)
// Coğrafya: dağı, nehri, ovası... → bunlar yazılmasa da kabul
// Tarih:    savaşı, antlaşması... → bunlar yazılmasa da kabul
// ============================================================
const _OPT_SUFFIXES = new Set([
    // — Coğrafya —
    'dagi', 'daglari', 'daglar', 'dag',
    'denizi', 'deniz',
    'ovasi', 'ova',
    'platosu', 'plato',
    'korfezi', 'korfez',
    'bogazi', 'bogaz',
    'nehri', 'nehir',
    'irmagi', 'irmak',
    'golu', 'gol',
    'yarimadasi', 'yarimada',
    'burnu', 'burun',
    'adasi', 'ada',
    'deltasi', 'delta',
    'havzasi', 'havza',
    'vadisi', 'vadi',
    'kanali', 'kanal',
    'gecidi', 'gecit',
    'tepesi', 'tepe',
    'zirvesi', 'zirve',
    'dorugu', 'doruğu',
    'deresi', 'dere',
    'cayi', 'cay',
    'ormani', 'orman',
    'magarasi', 'magara',
    'koyu', 'koy',
    'limani', 'liman',
    'gecidi', 'gecidi',
    'hatti', 'hat',
    'bolumu', 'bolum',
    // — Tarih —
    'savasi', 'savas', 'muharebesi', 'muharebe',
    'antlasmasi', 'antlasma', 'anlasması', 'anlasma',
    'sulhu', 'barisi', 'baris',
    'devleti', 'devlet',
    'imparatorlugu', 'imparatorluk',
    'sultanigi', 'sultanligi', 'sultanat', 'sultanligı',
    'hanedani', 'hanedan',
    'donemi', 'donem', 'cagi', 'cag',
    'kalesi', 'kale',
    'sehri', 'sehir',
    'harekati', 'harekat',
    'operasyonu', 'operasyon',
    'saltanati', 'saltanat',
    'hilafeti', 'hilafet',
    'beyligı', 'beyligi', 'beylik',
    'donemin', 'halifesi', 'halife',
    'sarayı', 'sarayi', 'saray',
]);

// Son kelime opsiyonel suffix ise çıkar (tek seferlik)
function _stripSuffix(normalized) {
    const words = normalized.split(' ');
    if (words.length <= 1) return normalized;
    if (_OPT_SUFFIXES.has(words[words.length - 1])) {
        return words.slice(0, -1).join(' ');
    }
    return normalized;
}

// "ve" / "ile" bağlaçlarını kaldır
function _stripConnectors(normalized) {
    return normalized
        .replace(/\bve\b/g, ' ')
        .replace(/\bile\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// ANA EŞLEŞTİRME FONKSİYONU
// Kurallar (sırayla):
//   1. Tam eşleşme
//   2. Kullanıcı daha fazlası yazdı (u içinde a var)
//   3. Cevabın sonu opsiyonel suffix → çıkar, tekrar dene
//   4. Tüm anahtar kelimeler yazılmışsa kabul et
// ============================================================
function isAnswerMatch(userText, correctAnswer) {
    if (!userText || !correctAnswer) return false;

    const u = _stripConnectors(normalizeText(userText));
    const a = _stripConnectors(normalizeText(correctAnswer));

    if (u.length < 2) return false;

    // 1. Tam eşleşme
    if (u === a) return true;

    // 2. Kullanıcı cevabın tamamını veya fazlasını yazdı
    if (u.includes(a)) return true;

    // 3. Suffix çıkar → tekrar karşılaştır
    const aCore = _stripSuffix(a);
    if (aCore !== a) {
        if (u === aCore) return true;
        if (u.includes(aCore)) return true;
        // Core da birden fazla kelimeyse keyword eşleşmesi yap
        const coreWords = aCore.split(' ').filter(w => w.length > 1);
        const uWords3   = u.split(' ').filter(w => w.length > 1);
        if (coreWords.length > 0 && uWords3.length > 0) {
            if (coreWords.every(cw => uWords3.some(uw => uw === cw || (uw.length >= 3 && cw.startsWith(uw))))) {
                return true;
            }
        }
    }

    // 4. Çok kelimeli cevap: tüm anahtar kelimeler yazılmışsa kabul et
    const stopWords = new Set(['ve', 'ile', 'de', 'da', 'the', 'of', 'and', 'or', 'bin', 'bey', 'pasa', 'sultan']);
    const aWords = (aCore || a).split(' ').filter(w => w.length > 2 && !stopWords.has(w));
    const uWords = u.split(' ').filter(w => w.length > 1);

    if (aWords.length >= 1 && uWords.length >= 1) {
        const allMatch = aWords.every(aw =>
            uWords.some(uw =>
                uw === aw ||
                (uw.length >= 3 && aw.startsWith(uw)) ||
                (uw.length >= 4 && uw.startsWith(aw))
            )
        );
        if (allMatch) return true;
    }

    return false;
}

function checkAnswer() {
    // Mobilde buton click'i input focus'unu kaybettirir — click event içindeyken geri al
    const inputEl = document.getElementById('user-answer');
    if (inputEl && !inputEl.readOnly && inputEl.style.display !== 'none') inputEl.focus();

    const userText = inputEl ? inputEl.value : document.getElementById('user-answer').value;
    const feedback = document.getElementById('feedback');

    // _getCorrectAnswers: options+correct (yeni MC), a[] (eski açık uçlu), names[] (coğrafya) — hepsini destekler
    const correctAnswers = _getCorrectAnswers(currentMountain).length > 0
        ? _getCorrectAnswers(currentMountain)
        : (currentMountain.names || []);

    const isMatch = correctAnswers.some(ans => isAnswerMatch(userText, ans));

    if (isMatch) {
        feedback.style.color = "var(--green)";
        feedback.innerHTML = "<b>DOĞRU!</b>";

        // Ses
        if (typeof playSound === 'function') playSound('correct');

        // Normal, spider ve cluster pinlerini güncelle
        const pinElement = document.getElementById(`marker-${currentMountain.id}`);
        if (pinElement) pinElement.classList.add('correct');
        const spiderEl = document.getElementById(`spider-${currentMountain.id}`);
        if (spiderEl) spiderEl.classList.add('correct');

        score.correct++;
        updateScore();

        if (currentMountain.q && !currentMountain._isMapQuiz) {
            const existingIdx = quizHistory.findIndex(h => h.item.id === currentMountain.id);
            if (existingIdx !== -1) {
                quizHistory[existingIdx] = { item: currentMountain, userAnswer: userText, status: 'correct' };
            } else {
                quizHistory.push({ item: currentMountain, userAnswer: userText, status: 'correct' });
            }
            saveQuestionResult(currentMountain.topicId, currentMountain.id, 'correct', wrongAttempts + 1);
            _scheduleNext(() => { closeModal(); nextQuestion(); }, 1000);
        } else {
            // Coğrafya/mapquiz: desc varsa göster, sonra kapat
            saveGeoProgress(currentGameId, currentMountain.id, 'correct');
            answeredPinStatus.set(currentMountain.id, 'correct');
            updateClusterAfterAnswer(currentMountain.id);
            const delay = currentMountain.desc ? 1800 : 850;
            _scheduleNext(() => { closeModal(); checkGameCompletion(); }, delay);
        }
    } else {
        wrongAttempts++;
        shakeModal();

        const correctAnswer = currentMountain.a ? currentMountain.a[0] : currentMountain.names[0];
        const remaining = MAX_WRONG_ATTEMPTS - wrongAttempts;

        if (wrongAttempts >= MAX_WRONG_ATTEMPTS) {
            // 3. yanlış — hem Tarih hem Coğrafya için aynı davranış
            const input = document.getElementById('user-answer');
            input.value = correctAnswer.toLocaleUpperCase('tr');
            input.readOnly = true;

            feedback.style.color = "#e74c3c";
            feedback.innerHTML = `<b>Bilemedin!</b> Doğru cevap: <b style="color:var(--red)">${correctAnswer.toLocaleUpperCase('tr')}</b>`;

            // Ses
            if (typeof playSound === 'function') playSound('wrong');
            const _geoInfoCA = _geoInfoHTML(currentMountain, 'var(--ink-500)');
            if (_geoInfoCA) {
                feedback.innerHTML += _geoInfoCA;
            } else if (currentMountain.desc) {
                feedback.innerHTML += `<br><span style="font-size:0.85rem; color:var(--ink-500); margin-top:4px; display:block;">${currentMountain.desc}</span>`;
            }

            // Sadece 1 yanlış say
            score.wrong++;
            updateScore();

            if (currentMountain.q && !currentMountain._isMapQuiz) {
                // Tarih: history'e kaydet
                const existingIdx = quizHistory.findIndex(h => h.item.id === currentMountain.id);
                if (existingIdx === -1) {
                    quizHistory.push({ item: currentMountain, userAnswer: userText, status: 'wrong' });
                } else {
                    quizHistory[existingIdx].userAnswer = userText;
                    quizHistory[existingIdx].status = 'wrong';
                }
                // Anlık kayıt — şimdilik 'wrong', doğru yaparsa üzerine yazılır
                saveQuestionResult(currentMountain.topicId, currentMountain.id, 'wrong');
                _scheduleNext(() => { closeModal(); nextQuestion(); }, 2000);
            } else {
                // Coğrafya: pin'i passive yap, kapat, tamamlanma kontrolü
                const pinElement = document.getElementById(`marker-${currentMountain.id}`);
                if (pinElement) pinElement.classList.add('passive');
                const spiderEl = document.getElementById(`spider-${currentMountain.id}`);
                if (spiderEl) spiderEl.classList.add('passive');
                saveGeoProgress(currentGameId, currentMountain.id, 'passive');
                answeredPinStatus.set(currentMountain.id, 'passive');
                updateClusterAfterAnswer(currentMountain.id);
                _scheduleNext(() => { closeModal(); checkGameCompletion(); }, 2000);
            }

        } else {
            // Henüz hak var — sadece feedback göster, skor değişmez
            feedback.style.color = "#e74c3c";
            feedback.innerHTML = `<b>YANLIŞ!</b> <span style="font-size:0.82rem; color:var(--red);">(${remaining} hakkın kaldı)</span>`;
        }
    }
}
function showAnswer() {
    const input = document.getElementById('user-answer');
    const feedback = document.getElementById('feedback');

    const _correctAnswers = _getCorrectAnswers(currentMountain);
    const correctAnswer = (_correctAnswers[0] || (currentMountain.names ? currentMountain.names[0] : '')).toUpperCase();

    // MC modundaysa şıkları renklendir
    const mcArea = document.getElementById('mc-area');
    // Mobilde buton click'i klavyeyi kapatır — metin modundaysa focus'u koru
    if (input && !input.readOnly && (!mcArea || mcArea.style.display === 'none')) input.focus();
    const mcBtns = mcArea ? mcArea.querySelectorAll('.mc-option') : [];
    if (mcBtns.length > 0) {
        mcBtns.forEach(b => {
            b.disabled = true;
            const bText = b.querySelector('.mc-text').innerText;
            if (_getCorrectAnswers(currentMountain).some(a => normalizeText(bText) === normalizeText(a))) {
                b.classList.add('mc-correct');
            }
        });
        feedback.innerHTML = "✅ Doğru cevap işaretlendi.";
        feedback.style.color = "#f39c12";
    } else {
        input.value = correctAnswer;
        input.readOnly = true;
        feedback.innerHTML = "Cevap gösterildi.";
        feedback.style.color = "#f39c12";
    }

    const pinElement = document.getElementById(`marker-${currentMountain.id}`);
    if (pinElement) pinElement.classList.add('passive');
    const spiderEl = document.getElementById(`spider-${currentMountain.id}`);
    if (spiderEl) spiderEl.classList.add('passive');

    score.shown++;

    // Ses
    if (typeof playSound === 'function') playSound('shown');

    const _geoInfoSA = _geoInfoHTML(currentMountain, '#555');
    if (_geoInfoSA) {
        feedback.innerHTML += _geoInfoSA;
    } else if (currentMountain.desc) {
        feedback.innerHTML += `<br><span style="font-size:0.9rem; color:#555;">${currentMountain.desc}</span>`;
    }

    updateScore();

    if (currentMountain.q && !currentMountain._isMapQuiz) {
        const existingIdx = quizHistory.findIndex(h => h.item.id === currentMountain.id);
        if (existingIdx === -1) {
            quizHistory.push({ item: currentMountain, userAnswer: '', status: 'shown' });
        } else {
            quizHistory[existingIdx].status = 'shown';
        }
        saveQuestionResult(currentMountain.topicId, currentMountain.id, 'shown');
        _scheduleNext(() => { closeModal(); nextQuestion(); }, 2000);
    } else {
        // Coğrafya/mapquiz: cevabı göster → kapat → tamamlanma kontrolü
        saveGeoProgress(currentGameId, currentMountain.id, 'passive');
        answeredPinStatus.set(currentMountain.id, 'passive');
        updateClusterAfterAnswer(currentMountain.id);
        _scheduleNext(() => { closeModal(); checkGameCompletion(); }, 2000);
    }
}

function closeModal() {
    // Bekleyen geçiş timeout'unu iptal et (kullanıcı manuel kapattıysa)
    if (_pendingAnswerTimeout) {
        clearTimeout(_pendingAnswerTimeout);
        _pendingAnswerTimeout = null;
    }

    // Kullanıcı quizi yarıda bırakıyorsa sessions sayacını artır
    // (quizFinished=true ise _doFinishQuiz zaten saydı; _isAutoAdvancing ise otomatik geçiş)
    if (!quizFinished && !_isAutoAdvancing && quizHistory.length > 0) {
        const topicIds = [...new Set(currentQuiz.map(q => q.topicId).filter(Boolean))];
        topicIds.forEach(tid => {
            if (!activeProfile || activeProfile.isGuest) return;
            try {
                const all  = getAllProfiles();
                const p    = all[activeProfile.name] || { quizStats: {}, geoProgress: {} };
                const prev = p.quizStats[tid] || { questionMap: {}, sessions: 0 };
                p.quizStats[tid] = { ...prev, sessions: (prev.sessions || 0) + 1, lastPlayed: Date.now() };
                all[activeProfile.name] = p;
                saveAllProfiles(all);
            } catch(e) {
                console.warn('[KPSS] Session kayıt hatası:', e.message);
            }
        });
    }

    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('question-modal').style.display = 'none';

    // Coğrafya kategori badge'ini temizle
    const geoBadge = document.getElementById('geo-category-badge');
    if (geoBadge) geoBadge.remove();

    // ── Geo pin bağlam baloncuğunu ve seçili pin vurgusunu temizle ──
    const geoBubble = document.getElementById('geo-pin-bubble');
    if (geoBubble) geoBubble.remove();
    document.querySelectorAll('.geo-pin-selected').forEach(el => el.classList.remove('geo-pin-selected'));

    const input = document.getElementById('user-answer');
    if (input) { input.readOnly = false; input.style.display = 'block'; }

    // MC alanını temizle
    const mcArea = document.getElementById('mc-area');
    if (mcArea) { mcArea.style.display = 'none'; mcArea.innerHTML = ''; }

    const btnCheck = document.querySelector('.btn-check');
    if (btnCheck) btnCheck.style.display = 'block';
    const btnGiveup = document.querySelector('.btn-giveup');
    if (btnGiveup) btnGiveup.style.display = 'inline-block';
    const btnFinish = document.getElementById('btn-finish');
    if (btnFinish) btnFinish.style.display = 'block';
    const hintArea = document.getElementById('hint-area');
    if (hintArea) hintArea.style.display = 'block';
    const btnClose = document.querySelector('.btn-close');
    if (btnClose) btnClose.style.display = 'inline-block';

    if (historyViewIndex !== -1) {
        historyViewIndex = -1;
        currentHistoryItem = null;
    }
}

// --- BİLGİ KARTI — Tamamlanmış coğrafya pinlerine tıklayınca ---
function openInfoCard(item) {
    const correctAnswer = (item.a ? item.a[0] : item.names ? item.names[0] : '').toLocaleUpperCase('tr');

    // Pin durumunu bul
    const markerEl = document.getElementById(`marker-${item.id}`);
    const spiderEl = document.getElementById(`spider-${item.id}`);
    const el = markerEl || spiderEl;
    const isCorrect = el && el.classList.contains('correct');

    const statusIcon  = isCorrect ? '✅' : '🟠';
    const statusText  = isCorrect ? 'Doğru bildin' : 'Cevap gösterildi';
    const statusColor = isCorrect ? 'var(--green)' : 'var(--amber)';

    document.getElementById('modal-overlay').style.display = 'block';
    const modal = document.getElementById('question-modal');
    modal.style.display = 'block';

    // Geo badge
    const existingBadge = document.getElementById('geo-category-badge');
    if (existingBadge) existingBadge.remove();

    let badgeLabel = 'Yer Şekli'; let badgeIcon = '🏔️'; let badgeClass = 'geo-badge-geo';
    if (item.type === 'cikarim') { badgeLabel = 'Maden Çıkarımı'; badgeIcon = '⛏️'; badgeClass = 'geo-badge-mine'; }
    if (item.type === 'isleme')  { badgeLabel = 'İşleme Tesisi';  badgeIcon = '🏭'; badgeClass = 'geo-badge-factory'; }

    const badge = document.createElement('div');
    badge.id = 'geo-category-badge';
    badge.className = `geo-badge ${badgeClass}`;
    badge.innerHTML = `<span>${badgeIcon}</span> ${badgeLabel}`;
    modal.insertBefore(badge, document.getElementById('q-title'));

    // Modal içeriğini bilgi moduna ayarla
    document.getElementById('q-title').innerText = `${item.label} numaralı yer`;

    const input = document.getElementById('user-answer');
    input.value = correctAnswer;
    input.readOnly = true;
    input.style.display = 'block';

    document.getElementById('mc-area').style.display = 'none';
    document.getElementById('hint-area').style.display = 'none';
    document.getElementById('btn-finish').style.display = 'none';
    document.getElementById('btn-prev-question').style.display = 'none';
    document.getElementById('quiz-progress').style.display = 'none';
    document.querySelector('.btn-check').style.display = 'none';
    document.querySelector('.btn-giveup').style.display = 'none';
    document.querySelector('.btn-close').style.display = 'inline-block';

    const feedback = document.getElementById('feedback');
    feedback.style.color = statusColor;
    feedback.innerHTML = `<b>${statusIcon} ${statusText}</b>`;

    // Meta etiketleri (river, sea, region, formation)
    const metaParts = [];
    if (item.river)     metaParts.push(`⚡ Nehir: <b>${item.river.charAt(0).toUpperCase()+item.river.slice(1)}</b>`);
    if (item.sea)       metaParts.push(`🌊 Döküldüğü yer: <b>${GEO_SEA_LABELS[item.sea] || item.sea}</b>`);
    if (item.region)    metaParts.push(`📍 Bölge: <b>${GEO_REGION_LABELS[item.region] || item.region}</b>`);
    if (item.formation) metaParts.push(`🗺️ Oluşum: <b>${GEO_FORMATION_LABELS[item.formation] || item.formation}</b>`);
    if (item.project)   metaParts.push(`🏗️ Proje: <b>${item.project.toUpperCase()}</b>`);
    if (item.regime)    metaParts.push(`📊 Rejim: <b>${item.regime}</b>`);

    if (metaParts.length) {
        feedback.innerHTML += `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">` +
            metaParts.map(p => `<span style="font-size:0.78rem;background:var(--ink-50,rgba(0,0,0,0.05));padding:3px 8px;border-radius:20px;">${p}</span>`).join('') +
            `</div>`;
    }

    if (item.desc) {
        feedback.innerHTML += `<div style="font-size:0.82rem;color:var(--ink-500);margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.07);">${item.desc}</div>`;
    }

    // HUD subtitle güncelle
    const hudSub = document.getElementById('hud-subtitle');
    if (hudSub) hudSub.innerText = `${item.label} — ${correctAnswer}`;
}

// --- BİTİR BUTONU & SONUÇ EKRANI ---
function finishQuiz() {
    // nextQuestion() sona ulaşıp çağırdığında quizFinished=false, kalan=0 → direkt bitir
    // Kullanıcı "Bitir" butonuna basarken soru ekrandaysa, questionIndex 1 fazladan artmış
    // olduğundan "kalan" hesabı: currentQuiz.length - questionIndex
    // (questionIndex openQuestion öncesinde artırılır, bu yüzden şu an gösterilen dahil değil)
    const remaining = currentQuiz.length - questionIndex;

    if (!quizFinished && remaining > 0) {
        // Kalan sorular var — kullanıcıya sor
        _showFinishWarning(remaining);
        return;
    }
    _doFinishQuiz();
}

function _showFinishWarning(remaining) {
    const existing = document.getElementById('finish-warn-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'finish-warn-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:20px;';

    const card = document.createElement('div');
    card.className = 'popup-card';
    card.style.cssText = 'border-radius:20px;padding:28px 24px;max-width:330px;width:100%;text-align:center;font-family:\'Plus Jakarta Sans\',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.22);';
    card.innerHTML = `
        <div style="font-size:2rem;margin-bottom:10px;">⏸️</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:8px;">Henüz bitmedi!</h3>
        <p style="font-size:0.85rem;color:var(--ink-500);line-height:1.6;margin-bottom:22px;">
            <b style="color:#2d4a7a;">${remaining} soru</b> daha çözülmedi.<br>
            Şimdi bitirirsen bu sorular istatistiğe<br>dahil <b>edilmez</b>.
        </p>
        <div style="display:flex;gap:10px;">
            <button id="finish-warn-continue" class="popup-card-btn-cancel" style="flex:1;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;">Devam Et</button>
            <button id="finish-warn-confirm" style="flex:1;padding:11px;border-radius:12px;border:none;background:#2d4a7a;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;">Yine de Bitir</button>
        </div>`;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector('#finish-warn-continue').addEventListener('click', () => overlay.remove());
    card.querySelector('#finish-warn-confirm').addEventListener('click', () => {
        overlay.remove();
        closeModal();
        _doFinishQuiz();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function _doFinishQuiz() {
    quizFinished = true;

    const wrongItems   = quizHistory.filter(h => h.status === 'wrong');
    const shownItems   = quizHistory.filter(h => h.status === 'shown');
    const correctCount = quizHistory.filter(h => h.status === 'correct').length;
    const wrongCount   = wrongItems.length;
    const shownCount   = shownItems.length;

    // Her topicId için ayrı istatistik kaydet
    const topicIds = [...new Set(currentQuiz.map(q => q.topicId).filter(Boolean))];
    if (topicIds.length === 1) {
        const results = quizHistory.map(h => ({ id: h.item.id, status: h.status }));
        saveQuizStats(topicIds[0], correctCount, wrongCount, shownCount, results);
    } else if (topicIds.length > 1) {
        topicIds.forEach(tid => {
            const th = quizHistory.filter(h => h.item && h.item.topicId === tid);
            const tc = th.filter(h => h.status === 'correct').length;
            const tw = th.filter(h => h.status === 'wrong').length;
            const ts = th.filter(h => h.status === 'shown').length;
            if (tc + tw + ts > 0) {
                const results = th.map(h => ({ id: h.item.id, status: h.status }));
                saveQuizStats(tid, tc, tw, ts, results);
            }
        });
    }

    const reviewList = [...wrongItems, ...shownItems];

    // Günlük ilerleme kaydet
    if (typeof _trackDailyProgress === 'function') _trackDailyProgress();

    showResultScreen(correctCount, wrongCount, shownCount, reviewList);
}

function showResultScreen(correctCount, wrongCount, shownCount, reviewList) {
    document.getElementById('modal-overlay').style.display = 'block';

    const modal = document.getElementById('question-modal');

    // Apply ALL position/size properties as inline styles.
    // Inline styles always beat CSS rules and media queries — this is the only
    // reliable way to guarantee centering regardless of bottom-sheet or
    // geo-fullscreen CSS overrides that were written into the stylesheet.
    modal.style.cssText = [
        'display: block',
        'position: fixed',
        'top: 50%',
        'left: 50%',
        'right: auto',
        'bottom: auto',
        'transform: translate(-50%, -50%)',
        'width: min(95%, 560px)',
        'max-width: none',
        'max-height: 90vh',
        'overflow-y: auto',
        'padding: 24px',
        'border-radius: 22px',
        '-webkit-overflow-scrolling: touch',
    ].join('; ');

    const total = correctCount + wrongCount + shownCount;
    const pct   = total > 0 ? Math.round((correctCount / total) * 100) : 0;

    let emoji = '🏆', accentClass = 'completion-accent-gold';
    if (pct < 100 && pct >= 70) { emoji = '🎯'; accentClass = 'completion-accent-blue'; }
    else if (pct < 70)          { emoji = '📚'; accentClass = 'completion-accent-amber'; }

    const circumference = 100.53; // 2π × 16
    const offset = circumference - (pct / 100) * circumference;

    // Konu bazlı gruplama
    const groupedByTopic = {};
    reviewList.forEach(record => {
        const topic = record.item.topicTitle || 'Genel';
        if (!groupedByTopic[topic]) groupedByTopic[topic] = [];
        groupedByTopic[topic].push(record);
    });

    let reviewHTML = '';
    if (reviewList.length === 0) {
        reviewHTML = `
            <div class="result-perfect-banner">
                <span style="font-size:1.8rem;">🏆</span>
                <div>
                    <p class="result-perfect-title">Mükemmel! Hiç yanlışın yok!</p>
                    <p class="result-perfect-sub">Tüm soruları doğru cevapladın.</p>
                </div>
            </div>`;
    } else {
        const topicBlocks = Object.entries(groupedByTopic).map(([topic, records]) => {
            const items = records.map(record => {
                const isWrong = record.status === 'wrong';
                const correctAns = (_getCorrectAnswers(record.item)[0] || '').toLocaleUpperCase('tr');
                return `
                    <div class="result-review-item ${isWrong ? 'result-item-wrong' : 'result-item-shown'}">
                        <div class="result-review-question">${record.item.q || 'Soru'}</div>
                        <div class="result-review-answer">
                            <span class="result-correct-ans">✓ ${correctAns}</span>
                            ${record.userAnswer ? `<span class="result-user-ans">✗ ${record.userAnswer.toLocaleUpperCase('tr')}</span>` : ''}
                        </div>
                        ${record.item.desc ? `<div class="result-review-desc">${record.item.desc}</div>` : ''}
                    </div>`;
            }).join('');
            return `
                <div class="result-topic-block">
                    <div class="result-topic-label">📚 ${topic}</div>
                    ${items}
                </div>`;
        }).join('');

        reviewHTML = `
            <div class="result-review-section">
                <p class="result-review-heading">Tekrar Çalışman Gereken Sorular</p>
                ${topicBlocks}
            </div>`;
    }

    modal.innerHTML = `
        <div class="result-screen-wrap">
            <div class="completion-card ${accentClass}" style="max-width:100%;width:100%;box-shadow:none;border:none;padding:20px 0 0;">
                <span class="completion-emoji">${emoji}</span>
                <div class="completion-accuracy-ring">
                    <svg viewBox="0 0 44 44" class="completion-ring-svg">
                        <circle class="completion-ring-bg" cx="22" cy="22" r="16"/>
                        <circle class="completion-ring-fill" cx="22" cy="22" r="16"
                            stroke-dasharray="${circumference}"
                            stroke-dashoffset="${circumference}"
                            id="result-ring-fill"/>
                    </svg>
                    <div class="completion-ring-label">
                        <span class="completion-ring-pct" id="result-pct-num">0%</span>
                        <span class="completion-ring-sub">doğruluk</span>
                    </div>
                </div>
                <div class="completion-stats" style="margin-bottom:16px;">
                    <div class="cstat cstat-correct">
                        <span class="cstat-num">${correctCount}</span>
                        <span class="cstat-label">Doğru</span>
                    </div>
                    <div class="cstat cstat-wrong">
                        <span class="cstat-num">${wrongCount}</span>
                        <span class="cstat-label">Yanlış</span>
                    </div>
                    <div class="cstat cstat-shown">
                        <span class="cstat-num">${shownCount}</span>
                        <span class="cstat-label">Gösterildi</span>
                    </div>
                </div>
            </div>

            ${reviewHTML}

            <div class="result-action-row">
                ${(wrongCount + shownCount > 0) ? `<button id="result-btn-retry" class="completion-btn completion-btn-secondary">🔁 Tekrar Çöz</button>` : ''}
                <button id="result-btn-menu" class="completion-btn completion-btn-primary">Ana Menü</button>
            </div>
        </div>
    `;

    // Buton event'lerini innerHTML sonrası bağla
    const retryBtn = modal.querySelector('#result-btn-retry');
    const menuBtn  = modal.querySelector('#result-btn-menu');
    if (retryBtn) retryBtn.addEventListener('click', showRetryOptions);
    if (menuBtn)  menuBtn.addEventListener('click', closeResultScreen);

    // Halka animasyonu
    setTimeout(() => {
        const ring  = document.getElementById('result-ring-fill');
        const pctEl = document.getElementById('result-pct-num');
        if (ring) ring.style.strokeDashoffset = offset;
        if (pctEl) {
            let cur = 0;
            const iv = setInterval(() => {
                cur = Math.min(cur + Math.ceil(pct / 25), pct);
                pctEl.innerText = cur + '%';
                if (cur >= pct) clearInterval(iv);
            }, 40);
        }
    }, 200);
}

function retryWrongQuestions() {
    const retryItems = quizHistory
        .filter(h => h.status === 'wrong' || h.status === 'shown')
        .map(h => ({ ...h.item }));

    if (retryItems.length === 0) { closeResultScreen(); return; }

    const _savedCtx = _quizReturnContext;
    closeResultScreen();
    _quizReturnContext = _savedCtx;

    setTimeout(() => {
        const prevRequeueIds = new Set(retryItems.map(it => it.id).filter(Boolean));
        _resetQuizState();
        currentQuiz = shuffleArray(retryItems);
        originalQuizLength = currentQuiz.length;
        requeuedIds = prevRequeueIds;
        resetScore();
        restoreModalHTML();

        const fill = document.getElementById('modal-progress-fill');
        if (fill) fill.style.width = '0%';

        document.getElementById('map').style.display = 'none';
        document.getElementById('game-area').style.display = 'block';
        nextQuestion();
    }, 200);
}

// --- Tekrar Çöz seçenek ekranı ---
function showRetryOptions() {
    const existingOverlay = document.getElementById('retry-options-overlay');
    if (existingOverlay) existingOverlay.remove();

    const wrongItems  = quizHistory.filter(h => h.status === 'wrong');
    const shownItems  = quizHistory.filter(h => h.status === 'shown');
    const wrongCount  = wrongItems.length;
    const shownCount  = shownItems.length;

    // Görülmemiş soruları hesapla
    const seenIds    = new Set(quizHistory.map(h => h.item.id));
    const topicIds   = [...new Set(currentQuiz.map(q => q.topicId).filter(Boolean))];
    let unseenItems  = [];
    topicIds.forEach(tid => {
        (appData.quizData[tid] || []).forEach((q, idx) => {
            const id = q.id || `${tid}_${idx}`;
            if (!seenIds.has(id)) {
                const topicObj = (appData[activeTopicDersId]||[]).find(t => t.id === tid);
                unseenItems.push({ ...q, topicId: tid, id, topicTitle: topicObj ? topicObj.title : tid });
            }
        });
    });
    const unseenCount = unseenItems.length;
    const totalCount  = wrongCount + shownCount + quizHistory.filter(h=>h.status==='correct').length + unseenCount;

    const overlay = document.createElement('div');
    overlay.id = 'retry-options-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:20px;';

    const card = document.createElement('div');
    card.className = 'popup-card';
    card.style.cssText = 'border-radius:22px;padding:26px 22px;max-width:340px;width:100%;font-family:\'Plus Jakarta Sans\',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.22);';
    card.innerHTML = `
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink-900);margin-bottom:5px;">Tekrar Çöz</h3>
        <p style="font-size:0.8rem;color:var(--ink-500);margin-bottom:18px;">Hangi soruları çözmek istiyorsun?</p>`;

    const makeBtn = (disabled, mode, icon, label, count, countBg, countColor) => {
        const btn = document.createElement('button');
        btn.disabled = disabled;
        btn.style.cssText = `width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid var(--border-mid);background:${disabled?'var(--surface-2)':'var(--surface-1)'};color:${disabled?'var(--ink-300)':'var(--ink-900)'};font-family:'Plus Jakarta Sans',sans-serif;font-size:0.88rem;font-weight:600;cursor:${disabled?'not-allowed':'pointer'};text-align:left;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;`;
        btn.innerHTML = `<span>${icon} ${label}</span><span style="background:${countBg};color:${countColor};padding:3px 10px;border-radius:8px;font-size:0.78rem;white-space:nowrap;">${count} soru</span>`;
        if (!disabled) btn.addEventListener('click', () => { overlay.remove(); retryFiltered(mode); });
        return btn;
    };

    card.appendChild(makeBtn(wrongCount+shownCount===0, 'wrongshown', '🔴', 'Yanlış & Gösterilen', wrongCount+shownCount, '#fee2e2', '#c94c3a'));
    card.appendChild(makeBtn(unseenCount===0,           'unseen',     '🔵', 'Görülmeyenler',       unseenCount,          '#dbeafe', '#1d4ed8'));
    card.appendChild(makeBtn(false,                     'all',        '🔄', 'Tümünü Baştan',       totalCount,           '#f0fdf4', '#166534'));

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'popup-card-btn-cancel';
    cancelBtn.style.cssText = 'width:100%;padding:11px;border-radius:12px;border:1.5px solid var(--border-mid);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;margin-top:2px;';
    cancelBtn.textContent = 'İptal';
    cancelBtn.addEventListener('click', () => overlay.remove());
    card.appendChild(cancelBtn);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function retryFiltered(mode) {
    const existing = document.getElementById('retry-options-overlay');
    if (existing) existing.remove();

    let retryItems = [];
    const topicIds = [...new Set(currentQuiz.map(q => q.topicId).filter(Boolean))];

    if (mode === 'wrongshown') {
        // Öncelik: bu session'ın quizHistory'si (en güncel)
        // Ek olarak: questionMap'teki kalıcı 'wrong' kayıtları da dahil et
        // (karma quiz / farklı oturumda yanlış yapılmış sorular)
        const sessionWrongIds = new Set(
            quizHistory
                .filter(h => h.status === 'wrong' || h.status === 'shown')
                .map(h => h.item.id)
        );
        // Session'dan al
        retryItems = quizHistory
            .filter(h => h.status === 'wrong' || h.status === 'shown')
            .map(h => ({ ...h.item }));

        // questionMap'ten ek 'wrong' soruları ekle (bu session'da görülmeyenler)
        topicIds.forEach(tid => {
            const stats = loadQuizStats(tid);
            if (!stats || !stats.questionMap) return;
            (appData.quizData[tid] || []).forEach((q, idx) => {
                const id = q.id || `${tid}_${idx}`;
                if (_qStatus(stats.questionMap[id]) === 'wrong' && !sessionWrongIds.has(id)) {
                    const topicObj = (appData[activeTopicDersId]||[]).find(t => t.id === tid);
                    retryItems.push({ ...q, topicId: tid, id, topicTitle: topicObj ? topicObj.title : tid });
                }
            });
        });
    } else if (mode === 'unseen') {
        const seenIds = new Set(quizHistory.map(h => h.item.id));
        topicIds.forEach(tid => {
            (appData.quizData[tid] || []).forEach((q, idx) => {
                const id = q.id || `${tid}_${idx}`;
                if (!seenIds.has(id)) {
                    const topicObj = (appData[activeTopicDersId]||[]).find(t => t.id === tid);
                    retryItems.push({ ...q, topicId: tid, id, topicTitle: topicObj ? topicObj.title : tid });
                }
            });
        });
    } else { // 'all'
        topicIds.forEach(tid => {
            (appData.quizData[tid] || []).forEach((q, idx) => {
                const topicObj = (appData[activeTopicDersId]||[]).find(t => t.id === tid);
                retryItems.push({ ...q, topicId: tid, id: q.id || `${tid}_${idx}`, topicTitle: topicObj ? topicObj.title : tid });
            });
        });
    }

    if (retryItems.length === 0) { closeResultScreen(); return; }

    const _savedCtx2 = _quizReturnContext;
    closeResultScreen();
    _quizReturnContext = _savedCtx2;

    setTimeout(() => {
        const prevRequeueIds = mode === 'wrongshown'
            ? new Set(retryItems.map(it => it.id).filter(Boolean))
            : new Set();
        _resetQuizState();
        currentQuiz = shuffleArray(retryItems);
        originalQuizLength = currentQuiz.length;
        // wrongshown: bu sorular zaten yanlış yapılmış — requeue'a girmesin
        requeuedIds = prevRequeueIds;
        resetScore();
        restoreModalHTML();

        const fill = document.getElementById('modal-progress-fill');
        if (fill) fill.style.width = '0%';

        document.getElementById('map').style.display = 'none';
        document.getElementById('game-area').style.display = 'block';
        nextQuestion();
    }, 200);
}

// Modal HTML'ini sıfırla — sonuç ekranı veya başka bir şey değiştirmişse geri döndür
function restoreModalHTML() {
    const modal = document.getElementById('question-modal');
    if (!modal) return;

    // Eğer modal içi değişmişse (sonuç ekranı vs.) tamamen yeniden yaz
    // Değişmemişse sadece listener'ı güncelle — innerHTML'i sıfırlama
    const needsRebuild = !document.getElementById('q-title') || !document.getElementById('user-answer');

    if (needsRebuild) {
        modal.style.maxWidth = '';
        modal.style.maxHeight = '';
        modal.style.overflowY = '';
        modal.innerHTML = `
            <div id="modal-progress-bar">
                <div id="modal-progress-fill"></div>
            </div>
            <div id="topic-label"></div>
            <div id="quiz-progress" style="display:none;"></div>
            <h3 id="q-title">Soru</h3>
            <input type="text" id="user-answer" placeholder="Cevabı yazın..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <div id="mc-area" style="display:none;"></div>
            <div id="hint-area" style="display:none;">
                <button id="btn-hint" onclick="useHint()">
                    <span class="hint-icon">💡</span>
                    <span class="hint-text-label">İpucu Kullan</span>
                    <span id="hint-token-badge">3</span>
                </button>
            </div>
            <button class="btn-check" onclick="checkAnswer()">KONTROL ET</button>
            <div class="btn-row-secondary">
                <button id="btn-prev-question" style="display:none;" class="btn-secondary btn-prev">◀ Önceki</button>
                <button class="btn-secondary btn-giveup" onclick="showAnswer()">Cevabı Göster</button>
                <button id="btn-finish" onclick="finishQuiz()" class="btn-secondary btn-finish" style="display:none;">✓ Bitir</button>
                <button class="btn-secondary btn-close" onclick="closeModal()">İptal</button>
            </div>
            <p id="feedback"></p>
        `;
    }

    // Enter listener'ı her zaman temiz bir şekilde bağla:
    // eski listener'ı önce kaldır (clone ile), sonra yeniden ekle
    const oldInput = document.getElementById('user-answer');
    if (oldInput) {
        const newInput = oldInput.cloneNode(true);
        oldInput.parentNode.replaceChild(newInput, oldInput);
        newInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') checkAnswer();
        });
    }
}

function closeResultScreen() {
    resetHistoryQuiz(); // bu zaten restoreModalHTML'i çağırır
    const modal = document.getElementById('question-modal');
    modal.style.cssText = '';   // result screen'de set edilen tüm inline stiller temizlendi
    document.getElementById('modal-overlay').style.display = 'none';
    modal.style.display = 'none';

    gameArea.style.display = 'none';
    menuArea.style.display = 'block';

    // BUG FIX: _quizReturnContext yoksa activeTopicDersId kullan (tarih/vatandaşlık).
    // Coğrafya gibi renderMenu üzerinden açılan quizler context'i set eder — doğru yere döner.
    if (_quizReturnContext) {
        const ctx = _quizReturnContext;
        _quizReturnContext = null;
        if (ctx.type === 'menu' && ctx.menuId && appData[ctx.menuId]) {
            menuArea.style.display = 'grid';
            renderMenu(appData[ctx.menuId]);
            updateTitleForMenu(ctx.menuId);
        } else if (ctx.type === 'topicSelection') {
            const dersTitle = getDersTitle(ctx.dersId || activeTopicDersId);
            renderTopicSelection(ctx.dersId || activeTopicDersId, dersTitle);
        } else {
            menuArea.style.display = 'grid';
            renderMenu(appData.main);
            currentTitle.innerText = 'Dersler';
        }
    } else {
        const dersTitle = getDersTitle(activeTopicDersId);
        renderTopicSelection(activeTopicDersId, dersTitle);
    }
}

function updateScore() {
    document.getElementById('score-correct').innerText = score.correct;
    document.getElementById('score-wrong').innerText = score.wrong;
    const shownEl = document.getElementById('score-shown');
    if (shownEl) shownEl.innerText = score.shown;

    // HUD güncellemesi
    const hudCorrect = document.getElementById('hud-correct');
    const hudWrong   = document.getElementById('hud-wrong');
    const hudShown   = document.getElementById('hud-shown');
    if (hudCorrect) { hudCorrect.innerText = score.correct; hudCorrect.classList.add('hud-bump'); setTimeout(() => hudCorrect.classList.remove('hud-bump'), 400); }
    if (hudWrong)   { hudWrong.innerText   = score.wrong;   hudWrong.classList.add('hud-bump');   setTimeout(() => hudWrong.classList.remove('hud-bump'),   400); }
    if (hudShown)   { hudShown.innerText   = score.shown;   hudShown.classList.add('hud-bump');   setTimeout(() => hudShown.classList.remove('hud-bump'),   400); }

    // İlerleme halkası
    if (currentGameId && appData.gameData && appData.gameData[currentGameId]) {
        const pinsData = appData.gameData[currentGameId];
        const total = pinsData.length;
        const done = score.correct + score.shown;
        const ringFill = document.getElementById('hud-ring-fill');
        const ringText = document.getElementById('hud-ring-text');
        if (ringFill) {
            const circumference = 113.1;
            const offset = circumference - (done / total) * circumference;
            ringFill.style.strokeDashoffset = offset;
        }
        if (ringText) ringText.innerText = `${done}/${total}`;
    }

    // Sıfırla butonunu güncelle
    updateResetButton();
}

function resetScore() {
    score.correct = 0;
    score.wrong = 0;
    score.shown = 0;
    updateScore();
}

function resetHistoryQuiz() {
    _resetQuizState();
    resetScore();
    restoreModalHTML();
}

// NOT: user-answer keypress listener, restoreModalHTML() içinde modal sıfırlandığında
// yeni DOM elementine bağlanır. Global listener burada KASITLI OLARAK kaldırıldı:
// restoreModalHTML() innerHTML'i tamamen yeniden yazdığı için bu listener
// artık DOM'da olmayan (orphan) eski elemente bağlı kalır ve giderek çoğalır.
// İlk yüklemede Enter çalışması: restoreModalHTML zaten startQuiz/startMixedQuiz
// tarafından quiz başlamadan hemen önce çağrılıyor, listener orada ekleniyor.

function startQuiz(quizId) {
    // BUG FIX: _quizReturnContext çağıran taraftan set edilmediyse tarih konu seçimine dön
    if (!_quizReturnContext) {
        _quizReturnContext = { type: 'topicSelection', dersId: activeTopicDersId };
    }

    const rawQuestions = (appData.quizData[quizId] || []).map((q, idx) => ({
        ...q,
        topicId: quizId,
        id: q.id || `${quizId}_${idx}`
    }));
    _resetQuizState();
    currentQuiz = shuffleArray(rawQuestions);
    originalQuizLength = currentQuiz.length;
    resetScore();
    restoreModalHTML();

    const fill = document.getElementById('modal-progress-fill');
    if (fill) fill.style.width = '0%';

    document.getElementById('map').style.display = 'none';
    document.getElementById('game-area').style.display = 'block';

    nextQuestion();
}

function nextQuestion() {
    // Quiz zaten bitti veya sıfırlandıysa hiçbir şey yapma
    if (quizFinished || currentQuiz.length === 0) return;

    if (questionIndex < currentQuiz.length) {
        const currentItem = currentQuiz[questionIndex];
        questionIndex++;
        openQuestion(currentItem);
        if (currentItem.q) {
            updateProgressBar();
            updateHistoryQuizUI(false);
        }
    } else {
        // Quiz bitti — finishQuiz üzerinden sonuç göster (istatistikler kaydedilir)
        finishQuiz();
    }
}
// ============================================================
// MOBİL KLAVYE DÜZELTMESİ
// Bottom sheet bottom:0 ile sabitlendiği için klavye açılınca
// modal zaten görünür kalır — ayrıca müdahale gerekmez.
// Sadece odak sonrası modalın en üstüne scroll et.
// ============================================================
document.addEventListener('focusin', function(e) {
    const modal = document.getElementById('question-modal');
    if (!modal || modal.style.display === 'none') return;
    if (!modal.contains(e.target)) return;
    if (window.innerWidth > 640) return;
    // Klavye açıldığında modal içeriğini başa al, butonlar scroll ile görünür
    setTimeout(() => { modal.scrollTop = 0; }, 100);
});
// ============================================================
// SAYFA KAPANMADAN ÖNCE VERİYİ KAYDET
// beforeunload'da async/await çalışmaz — tarayıcı sayfayı hemen kapatır.
// sendBeacon: non-blocking, sayfa kapansa bile isteği tamamlar.
// Firestore REST API üzerinden patch isteği gönderilir.
// ============================================================
window.addEventListener('beforeunload', () => {
    if (!_profileCache || !activeProfile || activeProfile.isGuest || !activeProfile.uid) return;
    if (!_saveDebounceTimer) return; // Bekleyen yazma yoksa gerek yok

    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;

    try {
        // Firestore REST API: PATCH (merge) isteği
        const projectId = 'kpss-atlas';
        const uid = activeProfile.uid;
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/data/profile`;

        // Firestore REST için veriyi fields formatına çevir
        function toFirestoreValue(val) {
            if (val === null || val === undefined) return { nullValue: null };
            if (typeof val === 'boolean') return { booleanValue: val };
            if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
            if (typeof val === 'string') return { stringValue: val };
            if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
            if (typeof val === 'object') {
                const fields = {};
                Object.entries(val).forEach(([k, v]) => { fields[k] = toFirestoreValue(v); });
                return { mapValue: { fields } };
            }
            return { stringValue: String(val) };
        }

        const fields = {};
        Object.entries(_profileCache).forEach(([k, v]) => { fields[k] = toFirestoreValue(v); });
        const body = JSON.stringify({ fields });

        // sendBeacon ile gönder — sayfa kapansa da tarayıcı tamamlar
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(url + '?currentDocument.exists=false', blob) ||
        navigator.sendBeacon(url, blob); // exists=false başarısız olursa düz PATCH dene
    } catch(e) {
        // sendBeacon başarısız olursa sessizce devam et
    }
});
// ============================================================
// TEMA SİSTEMİ
// Öncelik: localStorage override > sistem tercihi
// ============================================================

const _THEME_KEY     = 'kpss_theme';      // 'dark' | 'light' | 'system'
const _FONT_KEY      = 'kpss_font_size';  // 'small' | 'medium' | 'large'
const _SOUND_KEY     = 'kpss_sound';      // '1' | '0'
const _AUTO_ADV_KEY  = 'kpss_auto_adv';   // '0'|'1000'|'2000'|'3000' (ms)
const _DAILY_KEY     = 'kpss_daily';      // JSON { target, sessions: [{date,count}] }

function _getThemeSetting() {
    return localStorage.getItem(_THEME_KEY) || 'system';
}

function _applyTheme(setting) {
    const root = document.documentElement;
    if (setting === 'dark') {
        root.setAttribute('data-theme', 'dark');
    } else if (setting === 'light') {
        root.setAttribute('data-theme', 'light');
    } else {
        // system — data-theme attribute'u kaldır, CSS media query devralır
        root.removeAttribute('data-theme');
    }
    // meta theme-color güncelle
    const isDark = setting === 'dark' ||
        (setting === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = isDark ? '#0d0d0f' : '#faf9f6';
    // Mobil header tema ikonu güncelle
    const themeIcon = document.getElementById('mh-theme-icon');
    if (themeIcon) themeIcon.textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem(_THEME_KEY, setting);
}

function toggleTheme() {
    // Hızlı toggle: koyu ↔ açık
    const current = _getThemeSetting();
    const isDark = current === 'dark' ||
        (current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    _applyTheme(isDark ? 'light' : 'dark');
    // Ayarlar paneli açıksa güncelle
    const panel = document.getElementById('settings-modal-overlay');
    if (panel) {
        const btns = panel.querySelectorAll('[data-theme-btn]');
        btns.forEach(b => b.classList.toggle('active', b.dataset.themeBtn === _getThemeSetting()));
    }
    // PWA theme-color meta'yı güncelle
    const metaTheme = document.getElementById('meta-theme-color');
    if (metaTheme) {
        const nowDark = _getThemeSetting() === 'dark' ||
            (_getThemeSetting() === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        metaTheme.setAttribute('content', nowDark ? '#0d0d0f' : '#f5f4f0');
    }
}

// Sistem tercihi değişince (pil tasarrufu modu vs.) senkronize et
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (_getThemeSetting() === 'system') _applyTheme('system');
});

// Sayfa yüklenince uygula
(function _initTheme() {
    _applyTheme(_getThemeSetting());
    const fontSz = localStorage.getItem(_FONT_KEY) || 'medium';
    document.documentElement.setAttribute('data-font-size', fontSz);
})();

// ============================================================
// SES SİSTEMİ
// Web Audio API ile minimal bip sesleri
// ============================================================
let _audioCtx = null;

function _getAudioCtx() {
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    return _audioCtx;
}

function _isSoundEnabled() {
    return localStorage.getItem(_SOUND_KEY) !== '0';
}

function playSound(type) {
    if (!_isSoundEnabled()) return;
    const ctx = _getAudioCtx();
    if (!ctx) return;
    try {
        // ctx suspended olabilir (autoplay policy) — resume et
        if (ctx.state === 'suspended') ctx.resume();

        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'correct') {
            // Kısa, yükselen iki nota — başarı hissi
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.35);
        } else if (type === 'wrong') {
            // Alçalan, kısa — hata
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(330, ctx.currentTime);
            osc.frequency.setValueAtTime(220, ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.28);
        } else if (type === 'shown') {
            // Nötr tek nota
            osc.type = 'sine';
            osc.frequency.setValueAtTime(360, ctx.currentTime);
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.22);
        }
    } catch(e) {
        // Web Audio API desteklenmiyor veya autoplay kısıtlaması — sessizce geç
        console.debug('[KPSS] Ses çalınamadı:', e.message);
    }
}

function _showManualNextBtn(fn) {
    // feedback alanının altına "Devam →" butonu ekle
    const existing = document.getElementById('manual-next-btn');
    if (existing) { existing.onclick = fn; return; }
    const feedback = document.getElementById('feedback');
    if (!feedback) return;
    const btn = document.createElement('button');
    btn.id = 'manual-next-btn';
    btn.className = 'btn-check';
    btn.style.cssText = 'margin-top:10px;background:var(--bg-4);color:var(--t-200);border:1px solid var(--line-2);';
    btn.textContent = 'Devam →';
    btn.addEventListener('click', () => { btn.remove(); fn(); });
    feedback.insertAdjacentElement('afterend', btn);
}

// ============================================================
// GÜNLÜK HEDEF SİSTEMİ
// ============================================================
function _getDailyData() {
    try {
        const raw = localStorage.getItem(_DAILY_KEY);
        return raw ? JSON.parse(raw) : { target: 20, sessions: [] };
    } catch(e) { return { target: 20, sessions: [] }; }
}

function _saveDailyData(data) {
    try { localStorage.setItem(_DAILY_KEY, JSON.stringify(data)); } catch(e) {}
}

function _getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _addDailyProgress(count) {
    const data = _getDailyData();
    const today = _getTodayKey();
    const existing = data.sessions.find(s => s.date === today);
    if (existing) { existing.count += count; }
    else { data.sessions.push({ date: today, count }); }
    // 30 günden eski kayıtları temizle
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    data.sessions = data.sessions.filter(s => new Date(s.date) >= cutoff);
    _saveDailyData(data);
}

function _getDailyTodayCount() {
    const data = _getDailyData();
    const today = _getTodayKey();
    const s = data.sessions.find(s => s.date === today);
    return s ? s.count : 0;
}

function _getDailyStreak() {
    const data = _getDailyData();
    const target = data.target || 20;
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 60; i++) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const s = data.sessions.find(s => s.date === key);
        if (s && s.count >= target) { streak++; }
        else if (i > 0) break; // bugün henüz tamamlanmamışsa zincir kırılmış sayma
        d.setDate(d.getDate() - 1);
    }
    return streak;
}

// Son 7 günün durumunu döndür
function _getLast7Days() {
    const data = _getDailyData();
    const target = data.target || 20;
    const days = [];
    const dayNames = ['Pz','Pt','Sa','Ça','Pe','Cu','Ct'];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const s = data.sessions.find(s => s.date === key);
        days.push({
            label: dayNames[d.getDay()],
            done: s ? s.count >= target : false,
            isToday: i === 0,
            count: s ? s.count : 0
        });
    }
    return days;
}

// Widget'ı main menüye enjekte et
function renderDailyWidget() {
    const existing = document.getElementById('daily-widget');
    if (existing) existing.remove();

    const data      = _getDailyData();
    const target    = data.target || 20;
    const todayCount = _getDailyTodayCount();
    const streak    = _getDailyStreak();
    const pct       = Math.min(100, Math.round((todayCount / target) * 100));
    const days      = _getLast7Days();

    const widget = document.createElement('div');
    widget.id = 'daily-widget';
    widget.className = 'daily-widget';

    const daysHTML = days.map(d => `
        <div class="daily-day-dot ${d.done ? 'done' : ''} ${d.isToday ? 'today' : ''}" title="${d.label}: ${d.count} soru">
            <span class="dot-label">${d.label}</span>
            <span class="dot-check">${d.done ? '✓' : (d.isToday ? '●' : '·')}</span>
        </div>`).join('');

    widget.innerHTML = `
        <div class="daily-widget-header">
            <div class="daily-widget-left">
                <div class="daily-widget-icon">🎯</div>
                <div>
                    <span class="daily-widget-title">Günlük Hedef</span>
                    <span class="daily-widget-sub">${todayCount} / ${target} soru tamamlandı</span>
                </div>
            </div>
            ${streak > 0 ? `
            <div class="daily-streak-badge">
                🔥 <span class="daily-streak-num">${streak}</span><span style="font-size:0.62rem;font-weight:500;">gün</span>
            </div>` : ''}
        </div>
        <div class="daily-progress-wrap">
            <div class="daily-progress-bar">
                <div class="daily-progress-fill" style="width:${pct}%"></div>
            </div>
            <span class="daily-progress-label">${pct}%</span>
        </div>
        <div class="daily-days-row">${daysHTML}</div>
        <div class="daily-target-row">
            <span class="daily-target-label">Hedef:</span>
            <div class="daily-target-btns">
                ${[10,20,50,100].map(n => `
                <button class="daily-target-btn ${target === n ? 'active' : ''}"
                    data-target="${n}" onclick="setDailyTarget(${n})">${n}</button>`).join('')}
            </div>
        </div>`;

    // widget'ı menuArea'nın hemen altına ekle
    const menuArea = document.getElementById('menu-area');
    if (menuArea) {
        menuArea.insertAdjacentElement('afterend', widget);
    }
}

function setDailyTarget(n) {
    const data = _getDailyData();
    data.target = n;
    _saveDailyData(data);
    // Sadece widget görünüyorsa yenile
    if (document.getElementById('daily-widget')) renderDailyWidget();
}

function _trackDailyProgress() {
    const count = score.correct + score.wrong + score.shown;
    if (count > 0) _addDailyProgress(count);
    // Widget sadece ana menüdeyse güncelle; closeResultScreen zaten main'e döndürüyor
    // widget orada renderMenu → hook ile otomatik render edilecek
}

// renderMenu'ye widget hook — SADECE main menüde widget göster
(function _hookRenderMenu() {
    const _orig = renderMenu;
    window.renderMenu = function(items) {
        _orig(items);
        // Önce mevcut widget'ı her zaman kaldır
        const existing = document.getElementById('daily-widget');
        if (existing) existing.remove();
        // Sadece ana menü (Coğrafya/Tarih/Vatandaşlık) sayfasında ekle
        setTimeout(() => {
            const menuId = typeof findMenuIdByItems === 'function' ? findMenuIdByItems(items) : null;
            if (menuId === 'main') renderDailyWidget();
        }, 80);
    };
})();

// Hook tanımlandıktan sonra ilk renderMenu çağrısı yapılır.
// Böylece daily-widget, sayfa ilk açıldığında da doğru şekilde gösterilir.
renderMenu(appData.main);

// ============================================================
// AYARLAR PANELİ
// ============================================================
function showSettingsModal() {
    const existing = document.getElementById('settings-modal-overlay');
    if (existing) existing.remove();

    const themeSetting = _getThemeSetting();
    const fontSetting  = localStorage.getItem(_FONT_KEY) || 'medium';
    const soundOn      = _isSoundEnabled();
    const autoAdv      = localStorage.getItem(_AUTO_ADV_KEY) ?? '1000';

    const overlay = document.createElement('div');
    overlay.id = 'settings-modal-overlay';
    overlay.innerHTML = `
        <div class="settings-modal">
            <div class="settings-modal-header">
                <div class="settings-modal-icon">⚙️</div>
                <div>
                    <div class="settings-modal-title">Ayarlar</div>
                    <div class="settings-modal-sub">Uygulama tercihleri</div>
                </div>
                <button id="settings-close-btn" class="settings-modal-close">✕</button>
            </div>

            <!-- GÖRÜNÜM -->
            <div class="settings-section-label">Görünüm</div>
            <div class="settings-section">
                <div class="settings-row">
                    <span class="settings-row-icon">🎨</span>
                    <div class="settings-row-info">
                        <span class="settings-row-title">Tema</span>
                        <span class="settings-row-sub">Sistem / Koyu / Açık</span>
                    </div>
                    <div class="settings-segmented">
                        <button class="settings-seg-btn ${themeSetting==='system'?'active':''}" data-theme-btn="system" onclick="_setTheme('system')">Sistem</button>
                        <button class="settings-seg-btn ${themeSetting==='dark'?'active':''}" data-theme-btn="dark" onclick="_setTheme('dark')">🌙</button>
                        <button class="settings-seg-btn ${themeSetting==='light'?'active':''}" data-theme-btn="light" onclick="_setTheme('light')">☀️</button>
                    </div>
                </div>

                <div class="settings-row">
                    <span class="settings-row-icon">🔤</span>
                    <div class="settings-row-info">
                        <span class="settings-row-title">Yazı Boyutu</span>
                        <span class="settings-row-sub">Küçük / Normal / Büyük</span>
                    </div>
                    <div class="settings-segmented">
                        <button class="settings-seg-btn ${fontSetting==='small'?'active':''}" onclick="_setFontSize('small')">K</button>
                        <button class="settings-seg-btn ${fontSetting==='medium'?'active':''}" onclick="_setFontSize('medium')">M</button>
                        <button class="settings-seg-btn ${fontSetting==='large'?'active':''}" onclick="_setFontSize('large')">B</button>
                    </div>
                </div>
            </div>

            <!-- QUIZ -->
            <div class="settings-section-label">Quiz Davranışı</div>
            <div class="settings-section">
                <div class="settings-row">
                    <span class="settings-row-icon">⏱️</span>
                    <div class="settings-row-info">
                        <span class="settings-row-title">Oto-Geçiş Süresi</span>
                        <span class="settings-row-sub">Doğru/yanlış sonrası bekleme</span>
                    </div>
                    <div class="settings-segmented">
                        <button class="settings-seg-btn ${autoAdv==='0'?'active':''}" onclick="_setAutoAdv('0')">Kapalı</button>
                        <button class="settings-seg-btn ${autoAdv==='1000'?'active':''}" onclick="_setAutoAdv('1000')">1s</button>
                        <button class="settings-seg-btn ${autoAdv==='2000'?'active':''}" onclick="_setAutoAdv('2000')">2s</button>
                        <button class="settings-seg-btn ${autoAdv==='3000'?'active':''}" onclick="_setAutoAdv('3000')">3s</button>
                    </div>
                </div>

                <div class="settings-row">
                    <span class="settings-row-icon">🔊</span>
                    <div class="settings-row-info">
                        <span class="settings-row-title">Ses Efektleri</span>
                        <span class="settings-row-sub">Doğru/yanlış cevap sesi</span>
                    </div>
                    <label class="settings-toggle">
                        <input type="checkbox" id="sound-toggle" ${soundOn?'checked':''}>
                        <span class="settings-toggle-track"></span>
                    </label>
                </div>
            </div>

            <!-- HAKKINDA -->
            <div class="settings-section-label">Hakkında</div>
            <div class="settings-section">
                <div class="settings-row" style="opacity:0.7;pointer-events:none;">
                    <span class="settings-row-icon">📱</span>
                    <div class="settings-row-info">
                        <span class="settings-row-title">KPSS Dijital Atlas</span>
                        <span class="settings-row-sub">v4.0 — Coğrafya · Tarih · Vatandaşlık</span>
                    </div>
                </div>
            </div>

            <div style="height:32px;"></div>
        </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector('#settings-close-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Ses toggle
    const soundToggle = overlay.querySelector('#sound-toggle');
    soundToggle.addEventListener('change', () => {
        localStorage.setItem(_SOUND_KEY, soundToggle.checked ? '1' : '0');
        if (soundToggle.checked) playSound('correct');
    });
}

function _setTheme(setting) {
    _applyTheme(setting);
    // Segmented control güncelle
    document.querySelectorAll('[data-theme-btn]').forEach(b => {
        b.classList.toggle('active', b.dataset.themeBtn === setting);
    });
}

function _setFontSize(size) {
    document.documentElement.setAttribute('data-font-size', size);
    localStorage.setItem(_FONT_KEY, size);
    // Segmented control güncelle
    const panel = document.getElementById('settings-modal-overlay');
    if (panel) {
        const btns = panel.querySelectorAll('[onclick*="_setFontSize"]');
        btns.forEach(b => {
            b.classList.toggle('active', b.textContent.trim() === {small:'K',medium:'M',large:'B'}[size]);
        });
    }
}

function _setAutoAdv(ms) {
    localStorage.setItem(_AUTO_ADV_KEY, ms);
    // Segmented control güncelle
    const panel = document.getElementById('settings-modal-overlay');
    if (panel) {
        panel.querySelectorAll('[onclick*="_setAutoAdv"]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('onclick') === `_setAutoAdv('${ms}')`);
        });
    }
}

// Mobil ayarlar paneli için responsive
const _mq480 = window.matchMedia('(max-width: 480px)');
function _applySettingsMobileStyle() {
    const modal = document.querySelector('.settings-modal');
    if (!modal) return;
    if (_mq480.matches) {
        modal.style.cssText = 'width:100%;height:auto;max-height:92vh;border-radius:24px 24px 0 0;margin-top:auto;border-left:none;border-top:1px solid var(--line-2);';
        document.getElementById('settings-modal-overlay').style.alignItems = 'flex-end';
    }
}

// ══════════════════════════════════════════════════════════════
//  TÜRKÇE MİNİ-OYUN MOTORU
//  Adım 1 İskeleti — Yazım Kuralları hub'ı
// ══════════════════════════════════════════════════════════════

function startTurkceGame(topicId, topicTitle) {
    menuArea.innerHTML = '';
    menuArea.style.display = 'block';
    gameArea.style.display = 'none';

    currentTitle.innerText = topicTitle || 'Yazım Kuralları';
    backBtn.style.display = 'inline-block';
    backBtn.innerText = '← Geri Dön';
    backBtn.onclick = () => {
        renderMenu(appData.turkce);
        currentTitle.innerText = 'Türkçe';
    };

    // Mini-oyun hub kartları
    const games = [
        {
            id: 'deda',
            icon: '⚡',
            title: 'de / da · ki / ki',
            desc: 'Doğru mu Yanlış mı? Hızlı kaydırma',
            color: '#e74c3c',
            available: true,
            statsId: 'deda',
            totalQ: (appData.turkceData && appData.turkceData.deda ? appData.turkceData.deda.length : 0)
        },
        {
            id: 'ayri_birlesik',
            icon: '🧩',
            title: 'Ayrı – Birleşik Yazım',
            desc: 'Sürükle & Bırak kategori oyunu',
            color: '#2ecc71',
            available: true,
            statsId: 'ayri_birlesik',
            totalQ: (appData.turkceData && appData.turkceData.ayri_birlesik ? appData.turkceData.ayri_birlesik.length : 0)
        },
        {
            id: 'buyuk_harf',
            icon: '🩺',
            title: 'Büyük Harf Kuralları',
            desc: '"Metni Düzelt" editörü',
            color: '#f39c12',
            available: false   // Adım 4'te açılacak
        },
        {
            id: 'noktalama',
            icon: '🎯',
            title: 'Noktalama İşaretleri',
            desc: 'Eşleştirme & Doldurma',
            color: '#9b59b6',
            available: false   // Adım 5'te açılacak
        }
    ];

    const hub = document.createElement('div');
    hub.className = 'turkce-hub';
    hub.innerHTML = `
        <div class="turkce-hub-header">
            <p class="turkce-hub-sub">Çalışmak istediğin modülü seç</p>
        </div>
        <div class="turkce-hub-grid">
            ${games.map(g => `
                ${(function() {
                    let progressHtml = '';
                    if (g.available && g.statsId) {
                        const _st = loadQuizStats(g.statsId);
                        const _total = g.totalQ || 0;
                        if (_st && _st.sessions > 0 && _total > 0) {
                            const _pct = Math.round(((_st.correct||0) / _total) * 100);
                            const _col = _pct >= 80 ? '#2ecc71' : _pct >= 50 ? '#f39c12' : '#e74c3c';
                            progressHtml = `<div class="tgc-progress-row">
                                <div class="tgc-progress-wrap">
                                    <div class="tgc-progress-bar" style="width:${_pct}%;background:${_col};"></div>
                                </div>
                                <span class="tgc-progress-pct" style="color:${_col}">%${_pct}</span>
                            </div>`;
                        }
                    }
                    return `<div class="turkce-game-card ${g.available ? '' : 'tgc-locked'}"
                         ${g.available ? `onclick="launchTurkceModule('${g.id}')"` : ''}
                         style="--tgc-color:${g.color}">
                        <div class="tgc-icon">${g.icon}</div>
                        <div class="tgc-body">
                            <h3 class="tgc-title">${g.title}</h3>
                            <p class="tgc-desc">${g.desc}</p>
                            ${progressHtml}
                        </div>
                        ${g.available ? '' : '<span class="tgc-soon">Yakında</span>'}
                    </div>`;
                })()}
            `).join('')}
        </div>
    `;
    menuArea.appendChild(hub);
}


function launchTurkceModule(moduleId) {
    if (moduleId === 'deda')          _showDedaStartScreen();
    if (moduleId === 'ayri_birlesik') _showAbStartScreen();
}

// ══════════════════════════════════════════════════════════════
//  DE/DA · Kİ/Kİ — BAŞLANGIÇ EKRANI
// ══════════════════════════════════════════════════════════════

function _showDedaStartScreen() {
    const raw   = (appData.turkceData && appData.turkceData.deda) || [];
    const total = raw.length;

    // İstatistikleri hesapla
    const stats   = loadQuizStats('deda');
    const qMap    = stats && stats.questionMap ? stats.questionMap : {};
    let correct = 0, wrong = 0, shown = 0;
    raw.forEach(q => {
        const st = _qStatus(qMap[q.id]);
        if (st === 'correct') correct++;
        else if (st === 'wrong') wrong++;
        else if (st === 'shown') shown++;
    });
    const seen       = correct + wrong + shown;
    const progressPct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const wrongCount  = wrong + shown;
    const hasProgress = seen > 0;

    const barColor = progressPct >= 80 ? 'var(--green,#2ecc71)' 
                   : progressPct >= 50 ? 'var(--amber,#f39c12)' 
                   : 'var(--brick,#e74c3c)';

    menuArea.innerHTML = '';
    menuArea.style.display = 'block';
    gameArea.style.display = 'none';

    currentTitle.innerText = 'de / da  ·  ki / ki';
    backBtn.style.display  = 'inline-block';
    backBtn.innerText      = '← Geri Dön';
    backBtn.onclick = () => startTurkceGame('yazim_kurallari', 'Yazım Kuralları');

    menuArea.innerHTML = `
        <div class="deda-start-screen">

            <!-- Başlık -->
            <div class="dss-header">
                <span class="dss-icon">⚡</span>
                <h2 class="dss-title">de / da &nbsp;·&nbsp; ki / ki</h2>
                <p class="dss-desc">Kartı sola → Ayrı Yaz &nbsp;|&nbsp; Sağa → Bitişik Yaz</p>
            </div>

            <!-- İlerleme (sadece daha önce çalışıldıysa) -->
            ${hasProgress ? `
            <div class="dss-progress-card">
                <div class="dss-prog-row">
                    <span class="dss-prog-label">İlerleme</span>
                    <span class="dss-prog-pct" style="color:${barColor}">%${progressPct}</span>
                </div>
                <div class="dss-prog-bar-wrap">
                    <div class="dss-prog-bar" style="width:${progressPct}%;background:${barColor};"></div>
                </div>
                <div class="dss-prog-stats">
                    <span class="dss-stat"><span class="dss-stat-val" style="color:#2ecc71">${correct}</span> Doğru</span>
                    <span class="dss-stat"><span class="dss-stat-val" style="color:#e74c3c">${wrongCount}</span> Yanlış</span>
                    <span class="dss-stat"><span class="dss-stat-val">${total - seen}</span> Görülmedi</span>
                    <span class="dss-stat"><span class="dss-stat-val">${total}</span> Toplam</span>
                </div>
            </div>` : `
            <div class="dss-virgin-card">
                <span class="dss-virgin-icon">🆕</span>
                <p>Henüz çalışılmadı. Hadi başlayalım!</p>
            </div>`}

            <!-- Başlat seçenekleri -->
            <div class="dss-btn-group">
                ${hasProgress && wrongCount > 0 ? `
                <button class="dss-btn dss-btn-wrong" onclick="_startDedaGame(true)">
                    <span class="dss-btn-icon">🔴</span>
                    <div class="dss-btn-texts">
                        <span class="dss-btn-title">Yanlışları Çöz</span>
                        <span class="dss-btn-sub">${wrongCount} soru · Sadece yanlış & gösterilenleri</span>
                    </div>
                    <span class="dss-btn-arr">›</span>
                </button>` : ''}

                <button class="dss-btn dss-btn-all" onclick="_startDedaGame(false)">
                    <span class="dss-btn-icon">${hasProgress ? '🔄' : '🚀'}</span>
                    <div class="dss-btn-texts">
                        <span class="dss-btn-title">${hasProgress ? 'Tümünü Tekrar Çöz' : 'Başlat'}</span>
                        <span class="dss-btn-sub">${total} kart · Karışık sırada</span>
                    </div>
                    <span class="dss-btn-arr">›</span>
                </button>
            </div>

        </div>
    `;
}

// ══════════════════════════════════════════════════════════════
//  DE/DA · Kİ/Kİ — KART OYUNU  (Adım 2)
// ══════════════════════════════════════════════════════════════

let _ddState = null;

function _startDedaGame(wrongOnly) {
    const raw = (appData.turkceData && appData.turkceData.deda) || [];
    if (!raw.length) { alert('Veri bulunamadı.'); return; }

    let pool;
    if (wrongOnly) {
        pool = raw.filter(q => {
            const stats = loadQuizStats('deda');
            if (!stats || !stats.questionMap) return false;
            const st = _qStatus(stats.questionMap[q.id]);
            return st === 'wrong' || st === 'shown';
        });
        if (!pool.length) pool = [...raw];
    } else {
        pool = [...raw];
    }

    const cards = pool.sort(() => Math.random() - 0.5);
    _ddState = { cards, index: 0, score: { correct: 0, wrong: 0 }, startTime: Date.now(), locked: false };

    // Shuffle overlay (mevcut sistem)
    const shuffleOverlay = document.getElementById('shuffle-overlay');
    const iconEl  = document.getElementById('dynamic-shuffle-icon');
    const fillEl  = document.getElementById('shuffle-progress-fill');
    const countEl = document.getElementById('shuffle-count-label');
    if (iconEl)  iconEl.innerText = 'de';
    if (fillEl)  { fillEl.style.transition = 'none'; fillEl.style.width = '0%'; }
    if (countEl) countEl.textContent = '';
    if (shuffleOverlay) shuffleOverlay.style.display = 'flex';

    setTimeout(() => {
        if (fillEl)  { fillEl.style.transition = 'width 0.4s ease'; fillEl.style.width = '100%'; }
        if (countEl) countEl.textContent = cards.length + ' kart hazır!';
        setTimeout(() => {
            if (shuffleOverlay) shuffleOverlay.style.display = 'none';
            _ddOpenModal();
        }, 400);
    }, 350);
}

function _ddOpenModal() {
    if (!_ddState) return;
    const cards = _ddState.cards;

    currentTitle.innerText = 'de / da  ·  ki / ki';
    backBtn.style.display = 'inline-block';
    backBtn.innerText = '← Geri Dön';
    backBtn.onclick = () => {
        _ddCloseModal();
        startTurkceGame('yazim_kurallari', 'Yazım Kuralları');
    };

    const modalOverlay  = document.getElementById('modal-overlay');
    const questionModal = document.getElementById('question-modal');

    questionModal.innerHTML = `
        <div class="dd-modal-header">
            <span class="dd-q-counter" id="dd-q-counter">1 / ${cards.length}</span>
            <div class="dd-header-scores">
                <span class="dds-correct" id="dd-correct">✓ 0</span>
                <span class="dds-wrong"   id="dd-wrong">✗ 0</span>
            </div>
            <button class="dd-close-btn" onclick="_ddCloseModal()">✕</button>
        </div>
        <div class="dd-prog-bar-wrap">
            <div class="dd-prog-bar">
                <div class="dd-prog-fill" id="dd-prog-fill" style="width:0%"></div>
            </div>
        </div>
        <div class="dd-card-stage" id="dd-card-stage"></div>
        <div class="dd-btn-row" id="dd-btn-row">
            <button class="dd-btn dd-btn-ayri" onclick="_ddAnswerBtn('ayri')">
                <span class="dd-btn-icon">←</span>
                <span class="dd-btn-label">Ayrı Yaz</span>
            </button>
            <button class="dd-btn dd-btn-birlesik" onclick="_ddAnswerBtn('birlesik')">
                <span class="dd-btn-label">Bitişik Yaz</span>
                <span class="dd-btn-icon">→</span>
            </button>
        </div>
    `;

    modalOverlay.style.display  = 'block';
    questionModal.style.display = 'block';
    questionModal.classList.add('dd-question-modal');

    const shownKey = 'dd_swipe_hint_shown';
    if (!localStorage.getItem(shownKey)) {
        _ddShowTutorial(() => {
            localStorage.setItem(shownKey, '1');
            _ddRenderCard();
            _ddSetupSwipe();
        });
    } else {
        _ddRenderCard();
        _ddSetupSwipe();
    }
}

function _ddCloseModal() {
    const modalOverlay  = document.getElementById('modal-overlay');
    const questionModal = document.getElementById('question-modal');
    if (modalOverlay)  modalOverlay.style.display  = 'none';
    if (questionModal) {
        questionModal.style.display = 'none';
        questionModal.classList.remove('dd-question-modal');
    }
    _ddState = null;
}

function _ddShowTutorial(onDismiss) {
    const stage = document.getElementById('dd-card-stage');
    if (!stage) { onDismiss(); return; }

    stage.innerHTML = `
        <div class="dd-tutorial" id="dd-tutorial">
            <div class="dd-tut-arrows">
                <div class="dd-tut-side dd-tut-left">
                    <span class="dd-tut-arrow">←</span>
                    <span class="dd-tut-word">Ayrı Yaz</span>
                </div>
                <div class="dd-tut-icon">✍️</div>
                <div class="dd-tut-side dd-tut-right">
                    <span class="dd-tut-word">Bitişik Yaz</span>
                    <span class="dd-tut-arrow">→</span>
                </div>
            </div>
            <p class="dd-tut-sub">Kartı sola/sağa kaydır ya da alttaki butonlara bas</p>
            <p class="dd-tut-tap">Ekrana dokun, başlamak için</p>
        </div>
    `;

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        const tut = document.getElementById('dd-tutorial');
        if (tut) tut.classList.add('dd-tut-fade');
        setTimeout(onDismiss, 320);
    };

    // SADECE dokunuş/tıklama ile kapanır — otomatik kapanmaz
    stage.addEventListener('click',      dismiss, { once: true });
    stage.addEventListener('touchstart', dismiss, { once: true, passive: true });
}

function _ddRenderCard() {
    if (!_ddState) return;
    const { cards, index } = _ddState;
    const total = cards.length;

    const pct = (index / total) * 100;
    const fill    = document.getElementById('dd-prog-fill');
    const counter = document.getElementById('dd-q-counter');
    if (fill)    fill.style.width = pct + '%';
    if (counter) counter.textContent = (index + 1) + ' / ' + total;

    const sc = document.getElementById('dd-correct');
    const sw = document.getElementById('dd-wrong');
    if (sc) sc.textContent = '✓ ' + _ddState.score.correct;
    if (sw) sw.textContent = '✗ ' + _ddState.score.wrong;

    const card = cards[index];
    const typeLabel = card.type === 'deda' ? 'de / da' : 'ki / ki';
    const typeClass = card.type === 'deda' ? 'tag-deda' : 'tag-kiki';
    const sentenceHtml = card.sentence.replace(/\[([^\]]+)\]/g,
        '<span class="dd-blank">$1</span>');

    const stage = document.getElementById('dd-card-stage');
    if (!stage) return;

    stage.innerHTML = `
        <div class="dd-card dd-card-enter" id="dd-card">
            <span class="dd-type-tag ${typeClass}">${typeLabel}</span>
            <p class="dd-sentence">${sentenceHtml}</p>
            <p class="dd-question">Bu ek / bağlaç nasıl yazılmalı?</p>
            <div class="dd-feedback" id="dd-feedback" style="display:none;"></div>
        </div>
    `;

    const btnRow = document.getElementById('dd-btn-row');
    if (btnRow) btnRow.style.display = 'grid';

    requestAnimationFrame(() => {
        const c = document.getElementById('dd-card');
        if (c) { c.classList.remove('dd-card-enter'); c.classList.add('dd-card-show'); }
    });

    // Göstergeleri stage'e ekle (kartın dışında, arkasında)
    const existingInd = stage.querySelectorAll('.dd-swipe-indicator');
    existingInd.forEach(el => el.remove());
    const indAyri = document.createElement('div');
    indAyri.className = 'dd-swipe-indicator dd-swipe-ayri';
    indAyri.id = 'dd-ind-ayri';
    const indBir = document.createElement('div');
    indBir.className = 'dd-swipe-indicator dd-swipe-birlesik';
    indBir.id = 'dd-ind-birlesik';
    stage.appendChild(indAyri);
    stage.appendChild(indBir);
}

function _ddAnswerBtn(choice) {
    _ddAnswer(choice, choice === 'birlesik' ? 'right' : 'left');
}

function _ddAnswer(choice, flyDir) {
    if (!_ddState || _ddState.locked) return;
    _ddState.locked = true;

    const card    = _ddState.cards[_ddState.index];
    const correct = choice === card.answer;
    const dir     = flyDir || (correct ? 'right' : 'left');

    const el    = document.getElementById('dd-card');
    const stage = document.getElementById('dd-card-stage');

    // Stage flash — doğruysa yeşil, yanlışsa kırmızı
    if (stage) {
        stage.classList.remove('dd-flash-correct', 'dd-flash-wrong');
        void stage.offsetWidth; // reflow
        stage.classList.add(correct ? 'dd-flash-correct' : 'dd-flash-wrong');
    }

    if (el) {
        el.style.transition  = 'transform 0.35s ease, opacity 0.35s ease';
        el.style.transform   = dir === 'right'
            ? 'translateX(130%) rotate(14deg)'
            : 'translateX(-130%) rotate(-14deg)';
        el.style.opacity = '0';
    }

    const fb = document.getElementById('dd-feedback');
    if (fb) {
        fb.style.display = 'block';
        fb.className = 'dd-feedback ' + (correct ? 'dd-fb-ok' : 'dd-fb-err');
        const correctLabel = card.answer === 'ayri' ? 'AYRI yazılır' : 'BİTİŞİK yazılır';
        fb.innerHTML = '<b>' + (correct ? '✓ Doğru!' : '✗ Yanlış! → ' + correctLabel) + '</b><br><small>' + card.rule + '</small>';
    }

    // Sonucu state'de tut, oyun bitince toplu kaydedeceğiz
    if (!_ddState.results) _ddState.results = {};
    // Aynı kart birden fazla görünmüşse (wrongOnly modunda) son sonucu al
    _ddState.results[card.id] = correct ? 'correct' : 'wrong';
    if (correct) _ddState.score.correct++; else _ddState.score.wrong++;

    setTimeout(() => {
        if (!_ddState) return;
        _ddState.locked = false;
        _ddState.index++;
        if (_ddState.index >= _ddState.cards.length) {
            _ddShowResult();
        } else {
            _ddRenderCard();
        }
    }, 700);
}

function _ddSaveSessionResults(results) {
    // Doğrudan _profileCache üzerinde çalış — getAllProfiles wrapper'ı atlıyoruz
    // çünkü cache null gelirse eski veriyi eziyor
    if (!activeProfile || activeProfile.isGuest) return;
    try {
        const now  = Date.now();
        const p    = getProfileData(activeProfile.name); // cache'i döner, null değil
        if (!p.quizStats) p.quizStats = {};
        const prev = p.quizStats['deda'] || { questionMap: {}, sessions: 0 };
        const qMap = (prev.questionMap && typeof prev.questionMap === 'object')
                   ? { ...prev.questionMap } : {};

        // Bu turun sonuçlarını yaz — her soruyu bu turun gerçek sonucuyla güncelle
        Object.entries(results).forEach(([id, status]) => {
            const existing = qMap[id];
            const prevEntry = (existing && typeof existing === 'object') ? existing
                : { wrongCount: 0, firstSeen: now, lastSeen: now, status: null };
            qMap[id] = {
                status,
                wrongCount:      status === 'wrong' ? (prevEntry.wrongCount || 0) + 1
                                                    : (prevEntry.wrongCount || 0),
                attemptsToSolve: status === 'correct' ? 1 : null,
                firstSeen:       prevEntry.firstSeen || now,
                lastSeen:        now
            };
        });

        p.quizStats['deda'] = {
            questionMap: qMap,
            sessions:    (prev.sessions || 0) + 1,
            lastPlayed:  now
        };

        // Cache güncellendi — Firestore'a debounce ile gönder
        if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = setTimeout(() => {
            _saveDebounceTimer = null;
            _fsSet(p);
        }, _SAVE_DEBOUNCE_MS);

    } catch(e) { console.error('deda kayıt hatası:', e); }
}

function _ddShowResult() {
    // Tüm sonuçları toplu kaydet — her tur temiz başlar
    if (_ddState.results) {
        _ddSaveSessionResults(_ddState.results);
    }

    const { score, cards, startTime } = _ddState;
    const total   = cards.length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins    = Math.floor(elapsed / 60);
    const secs    = elapsed % 60;
    const pct     = Math.round((score.correct / total) * 100);
    const emoji   = pct >= 80 ? '🏆' : pct >= 50 ? '👍' : '💪';
    const msg     = pct >= 80 ? 'Harika gidiyorsun!' : pct >= 50 ? 'İyi iş çıkardın!' : 'Biraz daha pratik yapalım!';

    // Bu turda yanlış yapılan kartları bul
    const wrongInSession = cards.filter((q, i) => {
        const stats = loadQuizStats('deda');
        if (!stats || !stats.questionMap) return false;
        const st = _qStatus(stats.questionMap[q.id]);
        return st === 'wrong' || st === 'shown';
    });
    const wrongCount = wrongInSession.length;

    // Yanlış nedenleri HTML
    const wrongListHtml = wrongInSession.length > 0 ? `
        <div class="ddr-wrong-list">
            <p class="ddr-wrong-list-title">📝 Yanlış yaptıkların:</p>
            ${wrongInSession.map(q => {
                const sentenceHtml = q.sentence.replace(/\[([^\]]+)\]/g,
                    '<span class="ddr-wl-blank">$1</span>');
                const correctLabel = q.answer === 'ayri' ? 'Ayrı yazılır' : 'Bitişik yazılır';
                return `<div class="ddr-wl-item">
                    <p class="ddr-wl-sentence">${sentenceHtml}</p>
                    <p class="ddr-wl-rule"><span class="ddr-wl-answer">${correctLabel}</span> — ${q.rule}</p>
                </div>`;
            }).join('')}
        </div>
    ` : '';

    const stage  = document.getElementById('dd-card-stage');
    const btnRow = document.getElementById('dd-btn-row');
    if (btnRow) btnRow.style.display = 'none';
    if (!stage) return;

    // stage'i scroll edilebilir yap
    stage.style.overflowY = 'auto';
    stage.style.alignItems = 'flex-start';
    stage.style.padding = '4px 20px 16px';

    stage.innerHTML = `
        <div class="dd-result">
            <div class="ddr-emoji">${emoji}</div>
            <h2 class="ddr-title">${msg}</h2>
            <div class="ddr-stats">
                <div class="ddr-stat"><span class="ddr-val ddr-correct">${score.correct}</span><span class="ddr-key">Doğru</span></div>
                <div class="ddr-stat"><span class="ddr-val ddr-wrong">${score.wrong}</span><span class="ddr-key">Yanlış</span></div>
                <div class="ddr-stat"><span class="ddr-val">${pct}%</span><span class="ddr-key">Başarı</span></div>
                <div class="ddr-stat"><span class="ddr-val">${mins}:${String(secs).padStart(2,'0')}</span><span class="ddr-key">Süre</span></div>
            </div>
            ${wrongListHtml}
            <div class="ddr-btns">
                ${wrongCount > 0 ? `<button class="ddr-btn ddr-btn-wrong-retry" onclick="_ddCloseModal(); _startDedaGame(true)">🔴 Yanlışları Tekrar <span class="ddr-badge">${wrongCount}</span></button>` : ''}
                <button class="ddr-btn ddr-btn-retry" onclick="_startDedaGame(false)">🔄 Tekrar Oyna</button>
                <button class="ddr-btn ddr-btn-back"  onclick="_ddCloseModal(); startTurkceGame('yazim_kurallari','Yazım Kuralları')">← Menüye Dön</button>
            </div>
        </div>
    `;
}

function _ddSetupSwipe() {
    const stage = document.getElementById('dd-card-stage');
    if (!stage) return;
    let startX = 0, startY = 0, dragging = false;

    stage.addEventListener('touchstart', e => {
        if (_ddState && _ddState.locked) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dragging = true;
    }, { passive: true });

    stage.addEventListener('touchmove', e => {
        if (!dragging || !_ddState || _ddState.locked) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dy) > Math.abs(dx) + 10) return;

        const card = document.getElementById('dd-card');
        if (!card) return;
        card.style.transform  = 'translateX(' + dx + 'px) rotate(' + (dx * 0.05) + 'deg)';
        card.style.transition = 'none';

        const iA = document.getElementById('dd-ind-ayri');
        const iB = document.getElementById('dd-ind-birlesik');
        const progress = Math.min(1, Math.abs(dx) / 100);
        if (dx < -10) {
            if (iA) iA.style.opacity = progress;
            if (iB) iB.style.opacity = 0;
        } else if (dx > 10) {
            if (iB) iB.style.opacity = progress;
            if (iA) iA.style.opacity = 0;
        } else {
            if (iA) iA.style.opacity = 0;
            if (iB) iB.style.opacity = 0;
        }
    }, { passive: true });

    stage.addEventListener('touchend', e => {
        if (!dragging) return;
        dragging = false;
        const dx = e.changedTouches[0].clientX - startX;

        if (Math.abs(dx) < 60) {
            const card = document.getElementById('dd-card');
            if (card) { 
                card.style.transition = 'transform 0.3s ease'; 
                card.style.transform = '';
            }
            const iA = document.getElementById('dd-ind-ayri');
            const iB = document.getElementById('dd-ind-birlesik');
            if (iA) iA.style.opacity = 0;
            if (iB) iB.style.opacity = 0;
            return;
        }
        _ddAnswer(dx > 0 ? 'birlesik' : 'ayri', dx > 0 ? 'right' : 'left');
    }, { passive: true });
}


// ══════════════════════════════════════════════════════════════
//  AYRI – BİRLEŞİK YAZIM — SÜRÜKLE & BIRAK OYUNU
// ══════════════════════════════════════════════════════════════

let _abState = null;

// ── Başlangıç ekranı ──────────────────────────────────────────
function _showAbStartScreen() {
    const raw   = (appData.turkceData && appData.turkceData.ayri_birlesik) || [];
    const total = raw.length;

    const stats  = loadQuizStats('ayri_birlesik');
    const qMap   = stats && stats.questionMap ? stats.questionMap : {};
    let correct = 0, wrong = 0, shown = 0;
    raw.forEach(q => {
        const st = _qStatus(qMap[q.id]);
        if (st === 'correct') correct++;
        else if (st === 'wrong') wrong++;
        else if (st === 'shown') shown++;
    });
    const seen        = correct + wrong + shown;
    const progressPct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const wrongCount  = wrong + shown;
    const hasProgress = seen > 0;

    const barColor = progressPct >= 80 ? 'var(--green,#2ecc71)'
                   : progressPct >= 50 ? 'var(--amber,#f39c12)'
                   : 'var(--brick,#e74c3c)';

    menuArea.innerHTML = '';
    menuArea.style.display = 'block';
    gameArea.style.display = 'none';

    currentTitle.innerText = 'Ayrı – Birleşik Yazım';
    backBtn.style.display  = 'inline-block';
    backBtn.innerText      = '← Geri Dön';
    backBtn.onclick = () => startTurkceGame('yazim_kurallari', 'Yazım Kuralları');

    menuArea.innerHTML = `
        <div class="deda-start-screen">

            <div class="dss-header">
                <span class="dss-icon">🧩</span>
                <h2 class="dss-title">Ayrı – Birleşik Yazım</h2>
                <p class="dss-desc">Sözcük ayrı mı yazılır, bitişik mi? Kutucuğa sürükle veya dokun.</p>
            </div>

            ${hasProgress ? `
            <div class="dss-progress-card">
                <div class="dss-prog-row">
                    <span class="dss-prog-label">İlerleme</span>
                    <span class="dss-prog-pct" style="color:${barColor}">%${progressPct}</span>
                </div>
                <div class="dss-prog-bar-wrap">
                    <div class="dss-prog-bar" style="width:${progressPct}%;background:${barColor};"></div>
                </div>
                <div class="dss-prog-stats">
                    <span class="dss-stat"><span class="dss-stat-val" style="color:#2ecc71">${correct}</span> Doğru</span>
                    <span class="dss-stat"><span class="dss-stat-val" style="color:#e74c3c">${wrongCount}</span> Yanlış</span>
                    <span class="dss-stat"><span class="dss-stat-val">${total - seen}</span> Görülmedi</span>
                    <span class="dss-stat"><span class="dss-stat-val">${total}</span> Toplam</span>
                </div>
            </div>` : `
            <div class="dss-virgin-card">
                <span class="dss-virgin-icon">🆕</span>
                <p>Henüz çalışılmadı. Hadi başlayalım!</p>
            </div>`}

            <div class="dss-btn-group">
                ${hasProgress && wrongCount > 0 ? `
                <button class="dss-btn dss-btn-wrong" onclick="_startAbGame(true)">
                    <span class="dss-btn-icon">🔴</span>
                    <div class="dss-btn-texts">
                        <span class="dss-btn-title">Yanlışları Çöz</span>
                        <span class="dss-btn-sub">${wrongCount} sözcük · Sadece yanlış yapılanlar</span>
                    </div>
                    <span class="dss-btn-arr">›</span>
                </button>` : ''}

                <button class="dss-btn dss-btn-all" onclick="_startAbGame(false)">
                    <span class="dss-btn-icon">${hasProgress ? '🔄' : '🚀'}</span>
                    <div class="dss-btn-texts">
                        <span class="dss-btn-title">${hasProgress ? 'Tümünü Tekrar Çöz' : 'Başlat'}</span>
                        <span class="dss-btn-sub">${total} kart · Karışık sırada</span>
                    </div>
                    <span class="dss-btn-arr">›</span>
                </button>
            </div>

        </div>
    `;
}

// ── Oyunu başlat ──────────────────────────────────────────────
function _startAbGame(wrongOnly) {
    const allCards = (appData.turkceData && appData.turkceData.ayri_birlesik) || [];
    let deck;

    if (wrongOnly) {
        const stats = loadQuizStats('ayri_birlesik');
        const qMap  = (stats && stats.questionMap) || {};
        deck = allCards.filter(c => {
            const s = qMap[c.id];
            const st = s && typeof s === 'object' ? s.status : s;
            return st === 'wrong';
        });
        if (!deck.length) deck = [...allCards];
    } else {
        deck = [...allCards];
    }

    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    // Her kart için rastgele gösterim belirle (word mu alt mı)
    const showAlts = deck.map(() => Math.random() < 0.5);

    _abState = {
        deck,
        index:     0,
        results:   {},
        score:     { correct: 0, wrong: 0 },
        startTime: Date.now(),
        seen:      new Set(),
        showAlts                // her kartın gösterim versiyonu
    };

    _renderAbGame();
}

// ── Oyun ekranını oluştur ─────────────────────────────────────
function _renderAbGame() {
    menuArea.style.display = 'none';
    gameArea.style.display = 'block';
    gameArea.innerHTML = '';

    backBtn.onclick = () => {
        _abSaveResults();
        gameArea.innerHTML = '';
        gameArea.style.display = 'none';
        _showAbStartScreen();
    };

    const { deck, index, score, showAlts } = _abState;
    const card = deck[index];
    const remaining = deck.length - index;
    // Gösterilecek kelimeyi önceden hesapla
    const _abDisplayWord = (showAlts && showAlts[index] && card.alt) ? card.alt : card.word;
    console.log('[AB]', index, 'showAlt:', showAlts && showAlts[index], '| word:', card.word, '| alt:', card.alt, '| display:', _abDisplayWord);

    gameArea.innerHTML = `
    <div class="ab-game">
        <!-- Üst bilgi -->
        <div class="ab-top-bar">
            <span class="ab-counter">${index + 1} / ${deck.length}</span>
            <div class="ab-score-row">
                <span class="ab-score-correct">✓ ${score.correct}</span>
                <span class="ab-score-wrong">✗ ${score.wrong}</span>
            </div>
        </div>

        <!-- İlerleme çubuğu -->
        <div class="ab-progress-track">
            <div class="ab-progress-fill" style="width:${(index/deck.length)*100}%"></div>
        </div>

        <!-- Sözcük kartı -->
        <div class="ab-word-area">
            <div class="ab-word-card" id="ab-word-card" draggable="true">
                <span class="ab-word-text" id="ab-word-text">${_abDisplayWord}</span>
            </div>
            <div class="ab-category-tag ab-cat-${card.category}" id="ab-cat-tag">
                ${{ 'fiil-isim':'Fiil+İsim', 'sifat':'Bileşik Sıfat', 'pekistirme':'Pekiştirme', 'karisik':'Karışık' }[card.category] || ''}
            </div>
        </div>

        <!-- Drop bölgeleri -->
        <div class="ab-zones">
            <div class="ab-zone ab-zone-ayri" id="ab-zone-ayri" data-answer="ayri" onclick="_abAnswer('ayri')">
                <div class="ab-zone-icon">✂️</div>
                <div class="ab-zone-label">AYRI</div>
                <div class="ab-zone-hint">iki sözcük</div>
            </div>
            <div class="ab-zone ab-zone-birlesik" id="ab-zone-birlesik" data-answer="birlesik" onclick="_abAnswer('birlesik')">
                <div class="ab-zone-icon">🔗</div>
                <div class="ab-zone-label">BİTİŞİK</div>
                <div class="ab-zone-hint">tek sözcük</div>
            </div>
        </div>

        <!-- Geri bildirim alanı (cevap sonrası) -->
        <div class="ab-feedback" id="ab-feedback" style="display:none"></div>
    </div>`;

    _setupAbDrag();

    // İlk girişte tutorial göster
    const _abTutKey = 'kpss_ab_tutorial_seen';
    if (!localStorage.getItem(_abTutKey)) {
        _showAbTutorial(() => localStorage.setItem(_abTutKey, '1'));
    }
}

// ── Tutorial ─────────────────────────────────────────────────
function _showAbTutorial(onDismiss) {
    const overlay = document.createElement('div');
    overlay.id = 'ab-tutorial-overlay';
    overlay.innerHTML = `
    <div class="ab-tutorial-box">
        <div class="ab-tut-title">Nasıl Oynanır?</div>
        <div class="ab-tut-steps">
            <div class="ab-tut-step">
                <div class="ab-tut-demo">
                    <div class="ab-tut-card-demo">ge·ce·kon·du</div>
                    <div class="ab-tut-arrow-anim">
                        <span class="ab-tut-arr-left">← AYRI</span>
                        <span class="ab-tut-arr-right">BİTİŞİK →</span>
                    </div>
                </div>
                <p class="ab-tut-desc">Sözcüğü <strong>sürükleyip</strong> doğru kutucuğa bırak</p>
            </div>
            <div class="ab-tut-divider">ya da</div>
            <div class="ab-tut-step">
                <div class="ab-tut-zones-demo">
                    <div class="ab-tut-zone-l">✂️<br>AYRI</div>
                    <div class="ab-tut-zone-r">🔗<br>BİTİŞİK</div>
                </div>
                <p class="ab-tut-desc">Doğrudan <strong>kutucuğa dokun</strong></p>
            </div>
        </div>
        <button class="ab-tut-btn" id="ab-tut-dismiss">Anladım, Başla ▶</button>
    </div>`;
    document.body.appendChild(overlay);
    document.getElementById('ab-tut-dismiss').addEventListener('click', () => {
        overlay.remove();
        if (onDismiss) onDismiss();
    });
    overlay.addEventListener('click', e => {
        if (e.target === overlay) { overlay.remove(); if (onDismiss) onDismiss(); }
    });
}

// ── Drag & Drop kurulum ───────────────────────────────────────
function _setupAbDrag() {
    const wordCard = document.getElementById('ab-word-card');
    const zoneAyri = document.getElementById('ab-zone-ayri');
    const zoneBir  = document.getElementById('ab-zone-birlesik');
    if (!wordCard || !zoneAyri || !zoneBir) return;

    // Desktop: HTML5 Drag API
    wordCard.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', 'word');
        wordCard.classList.add('ab-dragging');
    });
    wordCard.addEventListener('dragend', () => {
        wordCard.classList.remove('ab-dragging');
        zoneAyri.classList.remove('ab-zone-hover');
        zoneBir.classList.remove('ab-zone-hover');
    });

    [zoneAyri, zoneBir].forEach(zone => {
        zone.addEventListener('dragover', e => {
            e.preventDefault();
            zone.classList.add('ab-zone-hover');
        });
        zone.addEventListener('dragleave', () => {
            zone.classList.remove('ab-zone-hover');
        });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('ab-zone-hover');
            _abAnswer(zone.dataset.answer);
        });
    });

    // Mobile: Touch sürükleme
    let touchStartX, touchStartY, clone = null;

    wordCard.addEventListener('touchstart', e => {
        const t = e.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;

        clone = wordCard.cloneNode(true);
        clone.style.cssText = `
            position:fixed; z-index:9999; opacity:0.9; pointer-events:none;
            left:${t.clientX - wordCard.offsetWidth/2}px;
            top:${t.clientY - wordCard.offsetHeight/2}px;
            width:${wordCard.offsetWidth}px;
            transform:scale(1.05) rotate(3deg);
        `;
        document.body.appendChild(clone);
        wordCard.style.opacity = '0.3';
    }, { passive: true });

    wordCard.addEventListener('touchmove', e => {
        if (!clone) return;
        const t = e.touches[0];
        clone.style.left = `${t.clientX - wordCard.offsetWidth/2}px`;
        clone.style.top  = `${t.clientY - wordCard.offsetHeight/2}px`;

        // Zone highlight
        const el = document.elementFromPoint(t.clientX, t.clientY);
        const inAyri = el && (el === zoneAyri || zoneAyri.contains(el));
        const inBir  = el && (el === zoneBir  || zoneBir.contains(el));
        zoneAyri.classList.toggle('ab-zone-hover', !!inAyri);
        zoneBir.classList.toggle('ab-zone-hover',  !!inBir);
    }, { passive: true });

    wordCard.addEventListener('touchend', e => {
        if (clone) { clone.remove(); clone = null; }
        wordCard.style.opacity = '';
        zoneAyri.classList.remove('ab-zone-hover');
        zoneBir.classList.remove('ab-zone-hover');

        const t = e.changedTouches[0];
        const el = document.elementFromPoint(t.clientX, t.clientY);
        if (!el) return;
        const zone = el.closest('[data-answer]');
        if (zone) _abAnswer(zone.dataset.answer);
    }, { passive: true });
}

// ── Cevap işle ────────────────────────────────────────────────
function _abAnswer(choice) {
    const { deck, index } = _abState;
    const card    = deck[index];
    const correct = choice === card.answer;

    _abState.results[card.id] = correct ? 'correct' : 'wrong';
    if (correct) _abState.score.correct++; else _abState.score.wrong++;

    // Kartı kilitle
    const wordCard = document.getElementById('ab-word-card');
    if (wordCard) { wordCard.draggable = false; wordCard.style.pointerEvents = 'none'; }

    // Zone flash
    const correctZone = document.getElementById(`ab-zone-${card.answer}`);
    const chosenZone  = document.getElementById(`ab-zone-${choice}`);
    if (correct) {
        if (correctZone) correctZone.classList.add('ab-zone-correct');
    } else {
        if (chosenZone)  chosenZone.classList.add('ab-zone-wrong');
        if (correctZone) correctZone.classList.add('ab-zone-correct');
    }

    if (correct) {
        // Doğru: kısa flash, sonra direkt sonraki kart
        if (wordCard) wordCard.classList.add('ab-card-correct');
        setTimeout(() => _abNextCard(), 700);
    } else {
        // Yanlış: cümle göster + devam et butonu
        _abShowWrongFeedback(card);
    }
}

function _abShowWrongFeedback(card) {
    const gameDiv = document.querySelector('.ab-game');
    if (!gameDiv) return;

    // Zones ve kart alanını gizle
    const zones   = gameDiv.querySelector('.ab-zones');
    const wordArea = gameDiv.querySelector('.ab-word-area');
    const topBar  = gameDiv.querySelector('.ab-top-bar');
    const progress = gameDiv.querySelector('.ab-progress-track');
    if (zones)    zones.style.display = 'none';
    if (wordArea) wordArea.style.display = 'none';

    // Feedback ekle
    const fb = document.createElement('div');
    fb.className = 'ab-wrong-feedback';
    fb.innerHTML = `
        <div class="ab-wf-icon">✗</div>
        <div class="ab-wf-label">Yanlış!</div>
        <div class="ab-wf-answer">"${card.word}" → <strong>${card.answer === 'ayri' ? 'AYRI yazılır' : 'BİTİŞİK yazılır'}</strong></div>
        <div class="ab-wf-example">${card.example || ''}</div>
        <div class="ab-wf-rule">${card.rule}</div>
        <button class="ab-wf-btn" onclick="_abNextCard()">Devam Et →</button>
    `;
    gameDiv.appendChild(fb);
}

function _abNextCard() {
    _abState.index++;
    if (_abState.index >= _abState.deck.length) {
        _abSaveResults();
        _abShowResult();
    } else {
        _renderAbGame();
    }
}

// ── Kayıt ─────────────────────────────────────────────────────
function _abSaveResults() {
    if (!activeProfile || activeProfile.isGuest || !_abState || !_abState.results) return;
    const results = _abState.results;
    if (!Object.keys(results).length) return;
    try {
        const now = Date.now();
        const p   = getProfileData(activeProfile.name);
        if (!p.quizStats) p.quizStats = {};
        const prev = p.quizStats['ayri_birlesik'] || { questionMap: {}, sessions: 0 };
        const qMap = (prev.questionMap && typeof prev.questionMap === 'object')
                   ? { ...prev.questionMap } : {};

        Object.entries(results).forEach(([id, status]) => {
            const ex = qMap[id];
            const pe = (ex && typeof ex === 'object') ? ex
                : { wrongCount: 0, firstSeen: now, lastSeen: now, status: null };
            qMap[id] = {
                status,
                wrongCount:      status === 'wrong' ? (pe.wrongCount||0)+1 : (pe.wrongCount||0),
                attemptsToSolve: status === 'correct' ? 1 : null,
                firstSeen:       pe.firstSeen || now,
                lastSeen:        now
            };
        });

        p.quizStats['ayri_birlesik'] = {
            questionMap: qMap,
            sessions:    (prev.sessions||0) + 1,
            lastPlayed:  now
        };

        if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = setTimeout(() => {
            _saveDebounceTimer = null;
            _fsSet(p);
        }, _SAVE_DEBOUNCE_MS);
    } catch(e) { console.error('ab kayıt hatası:', e); }
}

// ── Sonuç ekranı ──────────────────────────────────────────────
function _abShowResult() {
    const { score, deck, startTime, results } = _abState;
    const total   = deck.length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins    = Math.floor(elapsed / 60);
    const secs    = elapsed % 60;
    const pct     = Math.round((score.correct / total) * 100);
    const emoji   = pct >= 80 ? '🏆' : pct >= 50 ? '👍' : '💪';
    const msg     = pct >= 80 ? 'Harika gidiyorsun!' : pct >= 50 ? 'İyi iş çıkardın!' : 'Biraz daha pratik yapalım!';

    // Bu turda yanlış yapılanlar
    const wrongCards = deck.filter(c => results[c.id] === 'wrong');
    const wrongCount = wrongCards.length;

    const wrongListHtml = wrongCount > 0 ? `
        <div class="ddr-wrong-list">
            <p class="ddr-wrong-list-title">📝 Yanlış yaptıkların:</p>
            ${wrongCards.map(c => `
                <div class="ddr-wl-item">
                    <p class="ddr-wl-sentence"><strong>${c.word}</strong></p>
                    <p class="ddr-wl-rule">
                        <span class="ddr-wl-answer">${c.answer === 'ayri' ? 'Ayrı yazılır' : 'Bitişik yazılır'}</span>
                        — ${c.rule}
                    </p>
                </div>
            `).join('')}
        </div>
    ` : '';

    // Sonuç ekranını gameArea'da göster (deda ile aynı pattern)
    gameArea.style.display = 'block';
    menuArea.style.display = 'none';
    gameArea.style.overflowY = 'auto';
    gameArea.style.alignItems = 'flex-start';
    gameArea.style.padding = '4px 20px 16px';

    gameArea.innerHTML = `
        <div class="dd-result">
            <div class="ddr-emoji">${emoji}</div>
            <h2 class="ddr-title">${msg}</h2>
            <div class="ddr-stats">
                <div class="ddr-stat"><span class="ddr-val ddr-correct">${score.correct}</span><span class="ddr-key">Doğru</span></div>
                <div class="ddr-stat"><span class="ddr-val ddr-wrong">${score.wrong}</span><span class="ddr-key">Yanlış</span></div>
                <div class="ddr-stat"><span class="ddr-val">${pct}%</span><span class="ddr-key">Başarı</span></div>
                <div class="ddr-stat"><span class="ddr-val">${mins}:${String(secs).padStart(2,'0')}</span><span class="ddr-key">Süre</span></div>
            </div>
            ${wrongListHtml}
            <div class="ddr-btns">
                ${wrongCount > 0 ? `<button class="ddr-btn ddr-btn-wrong-retry" onclick="_startAbGame(true)">🔴 Yanlışları Tekrar <span class="ddr-badge">${wrongCount}</span></button>` : ''}
                <button class="ddr-btn ddr-btn-retry" onclick="_startAbGame(false)">🔄 Tekrar Oyna</button>
                <button class="ddr-btn ddr-btn-back" onclick="startTurkceGame('yazim_kurallari','Yazım Kuralları')">← Menüye Dön</button>
            </div>
        </div>
    `;
}

/* ============================================================
   KPSS DİJİTAL ATLAS — Tap-to-Match Modu
   
   AKIŞ:
   1. Harita tam ekranda, pinler "?" olarak görünür
   2. Alt panel → karıştırılmış isim kartları
   3. Kullanıcı: bir kart SEÇ → haritada doğru pine TIK
      (veya: haritada pine TIK → kartten seç)
   4. Eşleşme doğruysa → pin yeşillenir, kart kaybolur
   5. Yanlışsa → kırmızı titreme + ipucu olarak şehir bölgesi göster
   6. Hepsi bitince → mevcut completion screen
   
   MEVCUT SİSTEMLE UYUM:
   - startGame() korunur, match modu için startMatchMode() eklendi
   - answeredPinStatus, saveGeoProgress, checkGameCompletion → aynı
   - spiderfy: cluster pin'e tıklanınca kart paneli kart vurgular
   ============================================================ */

// ── Match modu state ─────────────────────────────────────────
let _matchState = null;

// ── Yardımcı: gameData'nın match modu için uygun olup olmadığı
// (cikarim/isleme pin'i olan her gameId match modunu kullanır)
function _isMatchModeGame(gameId) {
    const pins = appData.gameData && appData.gameData[gameId];
    if (!pins || pins.length === 0) return false;
    return pins.some(p => p.type === 'cikarim' || p.type === 'isleme');
}

// ── Ana giriş noktası ────────────────────────────────────────
function startMatchMode(gameId, title, parentId) {
    _currentParentId = parentId;
    resetScore();
    currentGameId = gameId;
    answeredPinStatus = new Map();

    window.removeEventListener('orientationchange', _onGeoResize);
    window.removeEventListener('resize', _onGeoResize);
    document.removeEventListener('fullscreenchange', _onMapFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    menuArea.style.display = 'none';
    gameArea.style.display = 'block';
    currentTitle.innerText = title;

    // Status bar'ı gizle (match modunda HUD var)
    const statusBar = document.getElementById('status-bar');
    if (statusBar) statusBar.style.display = 'none';

    document.getElementById('map').style.display = 'block';

    if (map) { map.remove(); map = null; }

    backBtn.style.display = 'inline-block';
    backBtn.innerText = "← Geri Dön";
    backBtn.onclick = _matchExitHandler;

    // ── HUD ──────────────────────────────────────────────────
    const existingHud = document.getElementById('map-hud');
    if (existingHud) existingHud.remove();
    const existingSwitcher = document.getElementById('map-switcher');
    if (existingSwitcher) existingSwitcher.remove();
    const existingMatchPanel = document.getElementById('match-panel');
    if (existingMatchPanel) existingMatchPanel.remove();

    const pinsData = appData.gameData[gameId] || [];
    const totalPins = pinsData.length;

    const hudHTML = `
        <div id="map-hud" class="match-hud">
            <button class="hud-back-btn" id="hud-back-btn" title="Geri Dön">←</button>
            <div class="hud-left">
                <div class="hud-title" id="hud-title">${title}</div>
                <div class="hud-subtitle" id="hud-subtitle">Bir kart seç, sonra haritada yerine tıkla</div>
            </div>
            <div class="hud-stats">
                <div class="hud-stat hud-stat-correct">
                    <span class="hud-stat-num" id="hud-correct">0</span>
                    <span class="hud-stat-label">Doğru</span>
                </div>
                <div class="hud-stat hud-stat-wrong">
                    <span class="hud-stat-num" id="hud-wrong">0</span>
                    <span class="hud-stat-label">Yanlış</span>
                </div>
            </div>
            <div class="hud-right-group">
                <div class="hud-progress-wrap">
                    <svg class="hud-ring" viewBox="0 0 44 44">
                        <circle class="hud-ring-bg" cx="22" cy="22" r="18"/>
                        <circle class="hud-ring-fill" id="hud-ring-fill" cx="22" cy="22" r="18"
                            stroke-dasharray="113.1" stroke-dashoffset="113.1"/>
                    </svg>
                    <span class="hud-ring-text" id="hud-ring-text">0/${totalPins}</span>
                </div>
            </div>
        </div>
    `;
    gameArea.insertAdjacentHTML('afterbegin', hudHTML);

    const hudBackBtn = document.getElementById('hud-back-btn');
    if (hudBackBtn) hudBackBtn.addEventListener('click', _matchExitHandler);

    // ── Harita ───────────────────────────────────────────────
    const startZoom = window.innerWidth < 768 ? 5 : 6;
    map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], startZoom);

    const tileLayers = {
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri', maxZoom: 19
        }),
        topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenTopoMap', subdomains: 'abc', maxZoom: 17
        }),
        light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CARTO', subdomains: 'abcd', maxZoom: 19
        })
    };
    let activeLayer = tileLayers.satellite;
    activeLayer.addTo(map);

    // Katman seçici
    const switcherHTML = `
        <div id="map-switcher">
            <button class="map-btn active" data-layer="satellite" title="Uydu">
                <span class="map-btn-icon">🛰️</span>
                <span class="map-btn-label">Uydu</span>
            </button>
            <button class="map-btn" data-layer="topo" title="Fiziki">
                <span class="map-btn-icon">🗺️</span>
                <span class="map-btn-label">Fiziki</span>
            </button>
            <button class="map-btn" data-layer="light" title="Sade">
                <span class="map-btn-icon">🗾</span>
                <span class="map-btn-label">Sade</span>
            </button>
            <div class="map-btn-divider"></div>
            <button class="map-btn map-btn-action" id="map-fs-btn" title="Tam Ekran">
                <span class="map-btn-icon">⛶</span>
                <span class="map-btn-label">Ekran</span>
            </button>
            <button class="map-btn map-btn-action" id="map-reset-btn" title="İlerlemeyi Sıfırla" disabled
                onclick="handleMapReset()">
                <span class="map-btn-icon">↺</span>
                <span class="map-btn-label">Sıfırla</span>
            </button>
        </div>
    `;
    // Switcher'ı Leaflet'in bottomright control alanına ekle
    const switcherContainer2 = L.control({ position: 'bottomright' });
    switcherContainer2.onAdd = function() {
        const div = L.DomUtil.create('div', 'leaflet-control');
        div.innerHTML = switcherHTML.replace('<div id="map-switcher">', '<div id="map-switcher" style="position:static;bottom:auto;right:auto;">');
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    switcherContainer2.addTo(map);

    document.querySelectorAll('.map-btn[data-layer]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const key = btn.dataset.layer;
            if (activeLayer === tileLayers[key]) return;
            map.removeLayer(activeLayer);
            tileLayers[key].addTo(map);
            activeLayer = tileLayers[key];
            document.querySelectorAll('.map-btn[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    const mapFsBtn = document.getElementById('map-fs-btn');
    if (mapFsBtn) {
        mapFsBtn.addEventListener('click', e => {
            e.stopPropagation();
            _toggleMapFullscreen(mapFsBtn);
        });
    }

    // ── Match state başlat ───────────────────────────────────
    _matchState = {
        gameId,
        pins: pinsData,
        selectedCard: null,   // { id, el } — seçili kart
        selectedPin: null,    // { id, el } — seçili pin
        answered: new Set(),  // tamamlanan pin id'leri
        wrongFlash: null,     // timeout handle
    };

    // ── Önceki ilerlemeyi yükle ──────────────────────────────
    const savedProgress = loadGeoProgress(gameId);
    Object.entries(savedProgress).forEach(([pinId, status]) => {
        answeredPinStatus.set(pinId, status);
        _matchState.answered.add(pinId);
    });

    // ── Pinleri yerleştir ────────────────────────────────────
    _matchPlacePins(gameId);

    // ── Kart panelini oluştur ────────────────────────────────
    _matchBuildCardPanel(gameId);

    // ── Haritaya tıklanınca seçili pini kaldır (boş yere) ───
    map.on('click', () => {
        if (_matchState.selectedPin) {
            const el = document.getElementById(`mpin-${_matchState.selectedPin.id}`);
            if (el) el.classList.remove('match-pin-selected');
            _matchState.selectedPin = null;
            _matchUpdateHintBar(null);
        }
    });

    // ── Fullscreen / resize ──────────────────────────────────
    window.addEventListener('orientationchange', _onGeoResize);
    window.addEventListener('resize', _onGeoResize);
    document.addEventListener('fullscreenchange', _onMapFullscreenChange);
    document.addEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    // ── İlerleme varsa skor güncelle ────────────────────────
    _matchSyncScoreFromSaved();

    // ── Tüm pinler tamamlandıysa direkt completion göster ───
    if (_matchState.answered.size >= pinsData.length) {
        setTimeout(() => showCompletionScreen(), 300);
    }
}

// ── Çıkış ────────────────────────────────────────────────────
function _matchExitHandler() {
    exitGeoFullscreen();
    gameArea.style.display = 'none';
    menuArea.style.display = 'grid';

    const existingHud = document.getElementById('map-hud');
    if (existingHud) existingHud.remove();
    const existingSwitcher = document.getElementById('map-switcher');
    if (existingSwitcher) existingSwitcher.remove();
    const existingPanel = document.getElementById('match-panel');
    if (existingPanel) existingPanel.remove();
    const statusBar = document.getElementById('status-bar');
    if (statusBar) statusBar.style.display = '';

    _matchState = null;

    if (activeProfile) setActiveProfile(activeProfile);

    const parentId = _currentParentId;
    if (parentId && appData[parentId]) {
        renderMenu(appData[parentId]);
        updateTitleForMenu(parentId);
    } else {
        renderMenu(appData.main);
        currentTitle.innerText = "Dersler";
    }
}

// ── Pin yerleştirme (match modu, "?" ikonlu) ─────────────────
function _matchPlacePins(gameId) {
    const pinsData = appData.gameData[gameId] || [];
    currentMarkers = [];

    // Spiderfy gruplama (mevcut mantıkla aynı)
    const used = new Set();
    const groups = [];
    pinsData.forEach((itemA, i) => {
        if (used.has(i)) return;
        const group = [itemA];
        used.add(i);
        pinsData.forEach((itemB, j) => {
            if (used.has(j)) return;
            if (Math.abs(itemA.lat - itemB.lat) < SPIDERFY_THRESHOLD &&
                Math.abs(itemA.lng - itemB.lng) < SPIDERFY_THRESHOLD) {
                group.push(itemB);
                used.add(j);
            }
        });
        groups.push(group);
    });

    groups.forEach((group, gIdx) => {
        const groupId = `g${gIdx}`;
        const anchor = group[0];

        if (group.length === 1) {
            _matchAddSinglePin(anchor, groupId);
        } else {
            _matchAddClusterPin(group, groupId, anchor);
        }
    });
}

function _matchAddSinglePin(item, groupId) {
    const isDone = _matchState.answered.has(item.id);
    const savedStatus = answeredPinStatus.get(item.id);

    const pinEl = _matchBuildPinHTML(item, isDone, savedStatus);
    const icon = L.divIcon({
        className: 'custom-leaflet-icon',
        html: pinEl,
        iconSize: [40, 40], iconAnchor: [20, 42]
    });

    const marker = L.marker([item.lat, item.lng], { icon }).addTo(map);

    marker.on('click', e => {
        L.DomEvent.stopPropagation(e);
        _matchHandlePinClick(item, marker, groupId);
    });

    currentMarkers.push({ leafletMarker: marker, dataId: item.id });
}

function _matchAddClusterPin(group, groupId, anchor) {
    const doneCount = group.filter(i => _matchState.answered.has(i.id)).length;
    const allDone = doneCount === group.length;
    const remaining = group.length - doneCount;

    const clusterStyle = allDone
        ? 'background:radial-gradient(circle at 35% 35%,#2ecc71,#1e8449);box-shadow:0 4px 12px rgba(46,204,113,0.5);'
        : '';
    const clusterLabel = allDone ? '✓' : (doneCount > 0 ? remaining : group.length);

    const clusterIcon = L.divIcon({
        className: 'custom-leaflet-icon',
        html: `<div class="spider-cluster match-cluster" id="cluster-${groupId}" style="${clusterStyle}">
                   <span class="cluster-count">${clusterLabel}</span>
               </div>`,
        iconSize: [42, 42], iconAnchor: [21, 21]
    });

    const clusterMarker = L.marker([anchor.lat, anchor.lng], { icon: clusterIcon }).addTo(map);

    clusterMarker.on('click', e => {
        L.DomEvent.stopPropagation(e);
        if (spiderfyState.activeGroupId === groupId) {
            collapseSpiderfy();
        } else {
            collapseSpiderfy();
            _matchExpandSpiderfy(group, groupId, anchor, clusterMarker);
        }
    });

    group.forEach(item => {
        currentMarkers.push({ leafletMarker: clusterMarker, dataId: item.id });
    });
}

// ── Match spiderfy (match ikonlu pinler açar) ────────────────
function _matchExpandSpiderfy(group, groupId, anchor, clusterMarker) {
    spiderfyState.activeGroupId = groupId;
    spiderfyState.virtualMarkers = [];

    const centerLatLng = L.latLng(anchor.lat, anchor.lng);
    const centerPx = map.latLngToContainerPoint(centerLatLng);
    const count = group.length;
    const FAN_DEG = 100;
    const fanRad = (FAN_DEG * Math.PI) / 180;
    const startAngle = -Math.PI / 2 - fanRad / 2;
    const angleStep = count > 1 ? fanRad / (count - 1) : 0;

    const clusterEl = document.getElementById(`cluster-${groupId}`);
    if (clusterEl) clusterEl.style.opacity = '0.35';

    group.forEach((item, i) => {
        const angle = count > 1 ? startAngle + angleStep * i : -Math.PI / 2;
        const targetPx = {
            x: centerPx.x + Math.cos(angle) * SPIDER_RADIUS,
            y: centerPx.y + Math.sin(angle) * SPIDER_RADIUS,
        };
        const targetLatLng = map.containerPointToLatLng([targetPx.x, targetPx.y]);

        const line = L.polyline([centerLatLng, targetLatLng], {
            color: 'rgba(255,255,255,0.75)', weight: 1.5,
            dashArray: '5 4', interactive: false,
        }).addTo(map);

        const isDone = _matchState.answered.has(item.id);
        const savedStatus = answeredPinStatus.get(item.id);
        const doneClass = isDone ? (savedStatus === 'passive' ? 'passive' : 'correct') : '';

        const spiderIcon = L.divIcon({
            className: 'custom-leaflet-icon spider-icon',
            html: `<div class="premium-pin spider-pin match-spider-pin ${doneClass}"
                        id="mspider-${item.id}"
                        style="opacity:0;transform:scale(0.3);">
                       ${_matchPinInner(item, isDone, savedStatus)}
                   </div>`,
            iconSize: [40, 40], iconAnchor: [20, 42],
        });

        const spiderMarker = L.marker(targetLatLng, { icon: spiderIcon, zIndexOffset: 1000 }).addTo(map);

        spiderMarker.on('click', e => {
            L.DomEvent.stopPropagation(e);
            if (!isDone && !_matchState.answered.has(item.id)) {
                _matchHandleSpiderPinClick(item, spiderMarker, groupId);
            } else {
                _matchShowInfoToast(item);
            }
        });

        spiderfyState.virtualMarkers.push({ marker: spiderMarker, line, item });

        setTimeout(() => {
            const el = document.getElementById(`mspider-${item.id}`);
            if (el) {
                el.style.transition = 'opacity 0.2s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
                el.style.opacity = '1';
                el.style.transform = 'scale(1)';
            }
        }, i * 60);
    });
}

// ── Pin HTML yardımcıları ────────────────────────────────────
function _matchPinInner(item, isDone, savedStatus) {
    if (isDone) {
        const isCorrect = savedStatus !== 'passive';
        const bg = isCorrect
            ? 'background:radial-gradient(circle at 35% 35%,#2ecc71,#1e8449);'
            : 'background:radial-gradient(circle at 35% 35%,#e67e22,#ca6f1e);';
        const icon = isCorrect ? '✓' : '✗';
        const label = `<span class="match-pin-done-label">${item.names[0].toLocaleUpperCase('tr')}</span>`;
        return `<div class="pin-body" style="${bg}box-shadow:0 3px 10px rgba(0,0,0,0.4);">
                    <span class="pin-number" style="font-size:11px;">${icon}</span>
                </div>
                ${label}`;
    }

    // Pin türüne göre renk — ama isim gizli, "?" göster
    const { pinColor, pinClass } = getPinStyle(item);
    const typeIcon = item.type === 'isleme' ? '🏭' : (item.type === 'cikarim' ? '⛏️' : '');
    return `<div class="${pinClass} match-pin-unknown" style="background-color:${pinColor};" id="mpin-inner-${item.id}">
                <span class="pin-number match-pin-q" style="font-size:14px;">?</span>
            </div>
            <span class="match-pin-type-icon">${typeIcon}</span>`;
}

function _matchBuildPinHTML(item, isDone, savedStatus) {
    return `<div class="premium-pin match-pin" id="mpin-${item.id}">
                ${_matchPinInner(item, isDone, savedStatus)}
            </div>`;
}

// ── Pin tıklama — tek pin ────────────────────────────────────
function _matchHandlePinClick(item, marker, groupId) {
    if (_matchState.answered.has(item.id)) {
        _matchShowInfoToast(item);
        return;
    }

    // Eğer bir kart seçiliyse → eşleşme kontrolü
    if (_matchState.selectedCard) {
        _matchCheck(_matchState.selectedCard.id, item.id, item, marker, false);
        return;
    }

    // Kart seçili değilse → pini seç, hint panelini güncelle
    const el = document.getElementById(`mpin-${item.id}`);

    // Önceki seçili pini temizle
    if (_matchState.selectedPin) {
        const prev = document.getElementById(`mpin-${_matchState.selectedPin.id}`);
        if (prev) prev.classList.remove('match-pin-selected');
    }

    if (_matchState.selectedPin && _matchState.selectedPin.id === item.id) {
        // Aynı pine tekrar tıklandı → seçimi kaldır
        _matchState.selectedPin = null;
        _matchUpdateHintBar(null);
        return;
    }

    if (el) el.classList.add('match-pin-selected');
    _matchState.selectedPin = { id: item.id, item, marker };
    _matchUpdateHintBar(item);
}

// ── Spider pin tıklama ───────────────────────────────────────
function _matchHandleSpiderPinClick(item, spiderMarker, groupId) {
    if (_matchState.answered.has(item.id)) {
        _matchShowInfoToast(item);
        return;
    }

    if (_matchState.selectedCard) {
        _matchCheck(_matchState.selectedCard.id, item.id, item, spiderMarker, true);
        return;
    }

    // Spider pini seç
    const el = document.getElementById(`mspider-${item.id}`);

    if (_matchState.selectedPin) {
        const prev = _matchState.selectedPin.isSpider
            ? document.getElementById(`mspider-${_matchState.selectedPin.id}`)
            : document.getElementById(`mpin-${_matchState.selectedPin.id}`);
        if (prev) prev.classList.remove('match-pin-selected');
    }

    if (_matchState.selectedPin && _matchState.selectedPin.id === item.id) {
        _matchState.selectedPin = null;
        _matchUpdateHintBar(null);
        return;
    }

    if (el) el.classList.add('match-pin-selected');
    _matchState.selectedPin = { id: item.id, item, marker: spiderMarker, isSpider: true };
    _matchUpdateHintBar(item);
}

// ── Kart tıklama ─────────────────────────────────────────────
function _matchHandleCardClick(pinId, cardEl) {
    if (_matchState.answered.has(pinId)) return;

    // Eğer bir pin seçiliyse → eşleşme kontrolü
    if (_matchState.selectedPin) {
        const pinItem = _matchState.selectedPin.item;
        const pinMarker = _matchState.selectedPin.marker;
        const isSpider = _matchState.selectedPin.isSpider;
        _matchCheck(pinId, pinItem.id, pinItem, pinMarker, isSpider);
        return;
    }

    // Önceki seçili kartı temizle
    if (_matchState.selectedCard) {
        _matchState.selectedCard.el.classList.remove('match-card-selected');
    }

    if (_matchState.selectedCard && _matchState.selectedCard.id === pinId) {
        // Aynı karta tekrar tıklandı → seçimi kaldır
        _matchState.selectedCard = null;
        _matchUpdateHintBar(null);
        return;
    }

    cardEl.classList.add('match-card-selected');
    _matchState.selectedCard = { id: pinId, el: cardEl };

    // HUD subtitle güncelle
    const hudSub = document.getElementById('hud-subtitle');
    if (hudSub) hudSub.innerText = 'Haritada bu konumun pinini bul ve tıkla';

    // Seçili karta göre hint metnini göster — kart seçilince bölgeyi değil sadece türü göster
    _matchUpdateHintBar(null, `"${cardEl.querySelector('.match-card-name').textContent}" seçildi — haritada pinini bul`);
}

// ── Eşleşme kontrolü ─────────────────────────────────────────
function _matchCheck(cardPinId, clickedPinId, clickedItem, marker, isSpider) {
    const isMatch = cardPinId === clickedPinId;

    // Her iki seçimi temizle
    if (_matchState.selectedCard) {
        _matchState.selectedCard.el.classList.remove('match-card-selected');
    }
    if (_matchState.selectedPin) {
        const prevEl = _matchState.selectedPin.isSpider
            ? document.getElementById(`mspider-${_matchState.selectedPin.id}`)
            : document.getElementById(`mpin-${_matchState.selectedPin.id}`);
        if (prevEl) prevEl.classList.remove('match-pin-selected');
    }
    _matchState.selectedCard = null;
    _matchState.selectedPin = null;

    if (isMatch) {
        _matchOnCorrect(clickedItem, marker, isSpider);
    } else {
        _matchOnWrong(cardPinId, clickedItem, marker, isSpider);
    }
}

// ── Doğru eşleşme ────────────────────────────────────────────
function _matchOnCorrect(item, marker, isSpider) {
    if (typeof playSound === 'function') playSound('correct');

    _matchState.answered.add(item.id);
    answeredPinStatus.set(item.id, 'correct');
    saveGeoProgress(currentGameId, item.id, 'correct');

    // Pin → yeşil
    const pinEl = isSpider
        ? document.getElementById(`mspider-${item.id}`)
        : document.getElementById(`mpin-${item.id}`);

    if (pinEl) {
        pinEl.classList.add('match-pin-correct-flash');
        setTimeout(() => {
            pinEl.classList.remove('match-pin-correct-flash');
            _matchUpdatePinToAnswered(item, 'correct', isSpider);
        }, 500);
    }

    // Kartı kaldır
    _matchRemoveCard(item.id);

    // HUD güncelle
    score.correct++;
    updateScore();
    _matchUpdateHUD();
    _matchUpdateHintBar(null);

    // Cluster güncelle
    _matchUpdateCluster(item.id);

    // Son pin mi kontrol et
    const pinsData = appData.gameData[currentGameId] || [];
    const isLastPin = _matchState.answered.size >= pinsData.length;

    if (isLastPin) {
        // Son pin: balonu açma, do\u011frudan completion — item.desc'\i completion'a geçir
        collapseSpiderfy();
        setTimeout(() => showCompletionScreen(item), 500);
    } else if (item.desc) {
        // Ara pin: bilgi balonu göster
        setTimeout(() => _matchShowInfoBubble(item, isSpider), 550);
    }
}

// ── Yanlış eşleşme ───────────────────────────────────────────
function _matchOnWrong(expectedPinId, clickedItem, marker, isSpider) {
    if (typeof playSound === 'function') playSound('wrong');
    score.wrong++;
    updateScore();
    _matchUpdateHUD();

    // Tıklanan pin titret
    const pinEl = isSpider
        ? document.getElementById(`mspider-${clickedItem.id}`)
        : document.getElementById(`mpin-${clickedItem.id}`);
    if (pinEl) {
        pinEl.classList.add('match-pin-wrong-flash');
        setTimeout(() => pinEl.classList.remove('match-pin-wrong-flash'), 600);
    }

    // Kart panelini hafifçe titret
    const panel = document.getElementById('match-panel');
    if (panel) {
        panel.classList.add('match-panel-shake');
        setTimeout(() => panel.classList.remove('match-panel-shake'), 500);
    }

    // Beklenen kartı 1sn kırmızı göster
    const expectedCard = document.getElementById(`mcard-${expectedPinId}`);
    if (expectedCard) {
        expectedCard.classList.add('match-card-wrong-hint');
        setTimeout(() => expectedCard.classList.remove('match-card-wrong-hint'), 1200);
    }

    // HUD ipucu
    const correctItem = (_matchState.pins || []).find(p => p.id === expectedPinId);
    if (correctItem && correctItem.desc) {
        _matchUpdateHintBar(null, `💡 ${correctItem.desc}`);
        setTimeout(() => _matchUpdateHintBar(null), 3000);
    } else {
        _matchUpdateHintBar(null, '❌ Eşleşme yanlış — tekrar dene');
        setTimeout(() => _matchUpdateHintBar(null), 2000);
    }
}

// ── Pin görünümünü "tamamlandı" olarak güncelle ──────────────
function _matchUpdatePinToAnswered(item, status, isSpider) {
    const targetId = isSpider ? `mspider-${item.id}` : `mpin-${item.id}`;
    const pinEl = document.getElementById(targetId);
    if (!pinEl) return;

    const bg = status === 'correct'
        ? 'background:radial-gradient(circle at 35% 35%,#2ecc71,#1e8449);'
        : 'background:radial-gradient(circle at 35% 35%,#e67e22,#ca6f1e);';
    const icon = status === 'correct' ? '✓' : '✗';
    const nameLabel = item.names[0].toLocaleUpperCase('tr');

    pinEl.innerHTML = `
        <div class="pin-body" style="${bg}box-shadow:0 3px 10px rgba(0,0,0,0.4);">
            <span class="pin-number" style="font-size:11px;">${icon}</span>
        </div>
        <span class="match-pin-done-label">${nameLabel}</span>
    `;
    if (status === 'correct') {
        pinEl.classList.add('correct');
    } else {
        pinEl.classList.add('passive');
    }
}

// ── Cluster güncelle ─────────────────────────────────────────
function _matchUpdateCluster(answeredId) {
    const pinsData = appData.gameData[currentGameId] || [];

    // Spiderfy gruplama — mevcut placePins ile birebir aynı mantık
    const used = new Set();
    const groups = [];
    pinsData.forEach((itemA, i) => {
        if (used.has(i)) return;
        const group = [itemA];
        used.add(i);
        pinsData.forEach((itemB, j) => {
            if (used.has(j)) return;
            if (Math.abs(itemA.lat - itemB.lat) < SPIDERFY_THRESHOLD &&
                Math.abs(itemA.lng - itemB.lng) < SPIDERFY_THRESHOLD) {
                group.push(itemB);
                used.add(j);
            }
        });
        groups.push(group);
    });

    groups.forEach((group, gIdx) => {
        if (!group.find(i => i.id === answeredId)) return;
        if (group.length <= 1) return;

        const groupId = `g${gIdx}`;
        const clusterEl = document.getElementById(`cluster-${groupId}`);
        if (!clusterEl) return;

        const doneCount = group.filter(i => _matchState.answered.has(i.id)).length;
        const allDone = doneCount === group.length;
        const remaining = group.length - doneCount;

        if (allDone) {
            clusterEl.style.background = 'radial-gradient(circle at 35% 35%,#2ecc71,#1e8449)';
            clusterEl.style.boxShadow = '0 4px 12px rgba(46,204,113,0.5)';
            clusterEl.querySelector('.cluster-count').textContent = '✓';
        } else {
            clusterEl.querySelector('.cluster-count').textContent = remaining;
        }
    });
}

// ── Kart panelini oluştur ────────────────────────────────────
function _matchBuildCardPanel(gameId) {
    const pinsData = appData.gameData[gameId] || [];

    // Cevaplanmamış pinlerin kartlarını oluştur
    const unanswered = pinsData.filter(p => !_matchState.answered.has(p.id));

    // Fisher-Yates karıştır
    const shuffled = shuffleArray([...unanswered]);

    const panelEl = document.createElement('div');
    panelEl.id = 'match-panel';
    panelEl.className = 'match-panel';

    if (unanswered.length === 0) {
        panelEl.innerHTML = `<div class="match-panel-empty">🎉 Tüm konumlar tamamlandı!</div>`;
        gameArea.appendChild(panelEl);
        return;
    }

    // Grupları ayır: çıkarım ve işleme
    const cikarimCards = shuffled.filter(p => p.type === 'cikarim' || p.type === undefined);
    const islemeCards = shuffled.filter(p => p.type === 'isleme');

    let panelHTML = `
        <div class="match-panel-header">
            <div class="match-panel-legend">
                <span class="mpl-item mpl-cikarim"><span class="mpl-dot"></span>Çıkarım Yeri</span>
                <span class="mpl-item mpl-isleme"><span class="mpl-dot"></span>İşleme Tesisi</span>
            </div>
            <div class="match-panel-count" id="match-panel-count">${unanswered.length} konum kaldı</div>
        </div>
        <div class="match-cards-scroll">
            <div class="match-cards" id="match-cards">
    `;

    shuffled.forEach(pin => {
        const typeClass = pin.type === 'isleme' ? 'match-card-isleme' : 'match-card-cikarim';
        const typeIcon = pin.type === 'isleme' ? '🏭' : '⛏️';
        const displayName = pin.names[0].toLocaleUpperCase('tr');
        panelHTML += `
            <button class="match-card ${typeClass}" id="mcard-${pin.id}"
                    data-pin-id="${pin.id}" role="button" aria-label="${displayName}">
                <span class="match-card-icon">${typeIcon}</span>
                <span class="match-card-name">${displayName}</span>
            </button>
        `;
    });

    panelHTML += `
            </div>
        </div>
    `;

    panelEl.innerHTML = panelHTML;
    gameArea.appendChild(panelEl);

    // Event delegation — tüm kartlar için tek listener
    const cardsContainer = panelEl.querySelector('#match-cards');
    cardsContainer.addEventListener('click', e => {
        const card = e.target.closest('.match-card');
        if (!card) return;
        const pinId = card.dataset.pinId;
        _matchHandleCardClick(pinId, card);
    });
}

// ── Kartı kaldır (doğru cevap sonrası) ──────────────────────
function _matchRemoveCard(pinId) {
    const card = document.getElementById(`mcard-${pinId}`);
    if (!card) return;

    card.classList.add('match-card-correct-fly');
    setTimeout(() => {
        card.remove();
        // Kalan sayıyı güncelle
        const countEl = document.getElementById('match-panel-count');
        if (countEl) {
            const remaining = document.querySelectorAll('.match-card:not(.match-card-correct-fly)').length;
            countEl.textContent = `${remaining} konum kaldı`;
        }
    }, 400);
}

// ── HUD güncelle ─────────────────────────────────────────────
function _matchUpdateHUD() {
    const correctEl = document.getElementById('hud-correct');
    const wrongEl = document.getElementById('hud-wrong');
    const ringFill = document.getElementById('hud-ring-fill');
    const ringText = document.getElementById('hud-ring-text');

    if (correctEl) correctEl.textContent = score.correct;
    if (wrongEl) wrongEl.textContent = score.wrong;

    const pinsData = appData.gameData[currentGameId] || [];
    const total = pinsData.length;
    const done = _matchState ? _matchState.answered.size : 0;

    if (ringText) ringText.textContent = `${done}/${total}`;
    if (ringFill) {
        const circumference = 113.1;
        const pct = total > 0 ? done / total : 0;
        ringFill.style.strokeDashoffset = circumference - pct * circumference;
        ringFill.style.transition = 'stroke-dashoffset 0.4s ease';
    }

    // Sıfırla butonunu aktif/pasif yap
    updateResetButton();
}

// ── İpucu paneli (haritanın altında, sade bir strip) ─────────
function _matchUpdateHintBar(item, customText) {
    const hudSub = document.getElementById('hud-subtitle');
    if (!hudSub) return;

    if (customText) {
        hudSub.textContent = customText;
        return;
    }

    if (!item) {
        hudSub.textContent = 'Bir kart seç, sonra haritada yerine tıkla';
        return;
    }

    // Bölge ve tür ipucu
    const typeLabel = item.type === 'isleme' ? 'İşleme Tesisi' : 'Çıkarım Yeri';
    if (item.desc) {
        hudSub.textContent = `${typeLabel} — ${item.desc}`;
    } else {
        hudSub.textContent = `${typeLabel} — haritada pinini bul ve tıkla`;
    }
}

// ── Bilgi tostu (tamamlanmış pine tıklanınca) ────────────────
// ── Bilgi balonu (doğru eşleşme sonrası pin üzerinde) ───────
function _matchShowInfoBubble(item, isSpider) {
    // Varsa önceki balonu kaldır
    const existing = document.getElementById('match-info-bubble');
    if (existing) existing.remove();

    if (!item.desc) return;

    // Pin elementini bul
    const pinEl = isSpider
        ? document.getElementById(`mspider-${item.id}`)
        : document.getElementById(`mpin-${item.id}`);

    const typeIcon = item.type === 'isleme' ? '🏭' : '⛏️';
    const name = item.names[0].toLocaleUpperCase('tr');

    // Balonu harita üzerinde kayan bir overlay olarak ekle
    const bubble = document.createElement('div');
    bubble.id = 'match-info-bubble';
    bubble.className = 'match-info-bubble';
    bubble.innerHTML = `
        <div class="mib-inner">
            <div class="mib-header">
                <span class="mib-icon">✅</span>
                <span class="mib-name">${name}</span>
                <button class="mib-close" id="mib-close-btn" aria-label="Kapat">×</button>
            </div>
            <div class="mib-desc">${typeIcon} ${item.desc}</div>
        </div>
    `;

    // Pin varsa ona göre konumlandır, yoksa sabit koy
    if (pinEl && map) {
        const latLng = L.latLng(item.lat, item.lng);
        const pt = map.latLngToContainerPoint(latLng);
        const mapEl = document.getElementById('map');
        const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;

        bubble.style.position = 'absolute';
        bubble.style.zIndex = '2000';

        // Balonun solunda mı sağında mı açılacağına karar ver
        const mapW = mapRect ? mapRect.width : window.innerWidth;
        const openLeft = pt.x > mapW / 2;

        bubble.style.top = Math.max(8, pt.y - 70) + 'px';
        if (openLeft) {
            bubble.style.right = (mapW - pt.x + 18) + 'px';
            bubble.style.left = 'auto';
        } else {
            bubble.style.left = (pt.x + 18) + 'px';
            bubble.style.right = 'auto';
        }

        const gameArea = document.getElementById('game-area');
        if (gameArea) gameArea.appendChild(bubble);
    } else {
        // Fallback: sol üst sabit
        bubble.style.position = 'absolute';
        bubble.style.top = '80px';
        bubble.style.left = '16px';
        bubble.style.zIndex = '2000';
        const gameArea = document.getElementById('game-area');
        if (gameArea) gameArea.appendChild(bubble);
    }

    // Animate in
    requestAnimationFrame(() => bubble.classList.add('mib-visible'));

    // Kapat butonu
    document.getElementById('mib-close-btn').addEventListener('click', e => {
        e.stopPropagation();
        bubble.classList.remove('mib-visible');
        setTimeout(() => bubble.remove(), 250);
    });

    // Haritaya tıklanınca da kapan
    const closeOnMapClick = () => {
        bubble.classList.remove('mib-visible');
        setTimeout(() => bubble.remove(), 250);
        map.off('click', closeOnMapClick);
    };
    setTimeout(() => map && map.on('click', closeOnMapClick), 100);
}

function _matchShowInfoToast(item) {
    const status = answeredPinStatus.get(item.id);
    const icon = status === 'correct' ? '✅' : '🔶';
    const name = item.names[0].toLocaleUpperCase('tr');
    const msg = `${icon} ${name}${item.desc ? ' — ' + item.desc : ''}`;
    if (typeof showToast === 'function') {
        showToast(msg, status === 'correct' ? 'success' : 'warning', 3000);
    }
}

// ── Kaydedilmiş ilerlemeyi skor ile senkronize et ────────────
function _matchSyncScoreFromSaved() {
    answeredPinStatus.forEach((status, pinId) => {
        if (status === 'correct') score.correct++;
        else if (status === 'passive') score.shown++;
    });
    _matchUpdateHUD();
    updateScore();
}

// ── handleSelection patch: match modu entegrasyonu ───────────
// Mevcut handleSelection'ı genişletir — startGame yerine
// startMatchMode çağırır (sadece cikarim/isleme içeren gameId'ler için)
(function _patchHandleSelection() {
    const _origHandleSelection = window.handleSelection || handleSelection;
    window.handleSelection = function(item) {
        // appData.gameData'da varsa VE match modu için uygunsa
        if (appData.gameData && appData.gameData[item.id] && _isMatchModeGame(item.id)) {
            const parentId = findParentMenuId(item.id);
            startMatchMode(item.id, item.title, parentId);
            return;
        }
        _origHandleSelection(item);
    };
})();

// ============================================================
// SINIR KAPILARI — HARITA SORUSU MODU (mapquiz)
// Çalışma mantığı:
//   1. startMapQuiz() → haritayı açar, tüm pinleri koyar
//   2. Kullanıcı bir pine tıklar → pin PULSE animasyonu ile yanıp söner
//   3. Modal açılır: "Bu sınır kapısı hangisidir?" + 4 MC şık
//   4. Doğru cevap → pin yeşil olur, ilerleme kaydedilir
//   5. Hata → pin kırmızı titrer, doğru cevap gösterilir
// ============================================================

// ── mapquiz için ek pin tipi kontrol ────────────────────────
function _isMapQuizGame(gameId) {
    const pins = appData.gameData && appData.gameData[gameId];
    if (!pins || pins.length === 0) return false;
    // sinir_kapilari_harita'daki pinler 'karayolu', 'demiryolu', 'karayolu_demiryolu' type'larına sahip
    return pins.some(p => p.type === 'karayolu' || p.type === 'demiryolu' || p.type === 'karayolu_demiryolu');
}

// ── Harita Sorusu Modunu Başlat ─────────────────────────────
function startMapQuiz(gameId, title, parentId) {
    _currentParentId = parentId;
    resetScore();

    // Listener temizliği
    window.removeEventListener('orientationchange', _onGeoResize);
    window.removeEventListener('resize', _onGeoResize);
    document.removeEventListener('fullscreenchange', _onMapFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    restoreModalHTML();

    menuArea.style.display = 'none';
    gameArea.style.display = 'block';
    currentTitle.innerText = title;
    document.getElementById('map').style.display = 'block';

    if (map) { map.remove(); map = null; }

    backBtn.style.display = 'inline-block';
    backBtn.innerText = '← Geri Dön';
    backBtn.onclick = () => {
        exitGeoFullscreen();
        gameArea.style.display = 'none';
        menuArea.style.display = 'grid';
        resetScore();
        const existingHud = document.getElementById('map-hud');
        if (existingHud) existingHud.remove();
        const existingSwitcher = document.getElementById('map-switcher');
        if (existingSwitcher) existingSwitcher.remove();
        if (activeProfile) setActiveProfile(activeProfile);

        if (parentId && appData[parentId]) {
            renderMenu(appData[parentId]);
            updateTitleForMenu(parentId);
        } else {
            renderMenu(appData.main);
            currentTitle.innerText = 'Dersler';
        }
    };

    // ── HUD ─────────────────────────────────────────────────
    const existingHud = document.getElementById('map-hud');
    if (existingHud) existingHud.remove();
    const existingSwitcher = document.getElementById('map-switcher');
    if (existingSwitcher) existingSwitcher.remove();

    const totalPins = (appData.gameData[gameId] || []).length;
    const hudHTML = `
        <div id="map-hud">
            <button class="hud-back-btn" id="hud-back-btn" title="Geri Dön">←</button>
            <div class="hud-left">
                <div class="hud-title" id="hud-title">${title}</div>
                <div class="hud-subtitle" id="hud-subtitle">Bir pine tıkla → soruyu cevapla</div>
            </div>
            <div class="hud-stats">
                <div class="hud-stat hud-stat-correct">
                    <span class="hud-stat-num" id="hud-correct">0</span>
                    <span class="hud-stat-label">Doğru</span>
                </div>
                <div class="hud-stat hud-stat-wrong">
                    <span class="hud-stat-num" id="hud-wrong">0</span>
                    <span class="hud-stat-label">Yanlış</span>
                </div>
                <div class="hud-stat hud-stat-shown">
                    <span class="hud-stat-num" id="hud-shown">0</span>
                    <span class="hud-stat-label">Gösterildi</span>
                </div>
            </div>
            <div class="hud-right-group">
                <div class="hud-progress-wrap">
                    <svg class="hud-ring" viewBox="0 0 44 44">
                        <circle class="hud-ring-bg" cx="22" cy="22" r="18" />
                        <circle class="hud-ring-fill" id="hud-ring-fill" cx="22" cy="22" r="18"
                            stroke-dasharray="113.1" stroke-dashoffset="113.1" />
                    </svg>
                    <span class="hud-ring-text" id="hud-ring-text">0/${totalPins}</span>
                </div>
            </div>
        </div>
    `;
    gameArea.insertAdjacentHTML('afterbegin', hudHTML);

    const hudBackBtn = document.getElementById('hud-back-btn');
    if (hudBackBtn) hudBackBtn.addEventListener('click', () => backBtn.onclick());

    // ── Harita ──────────────────────────────────────────────
    const startZoom = window.innerWidth < 768 ? 5 : 6;
    map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], startZoom);

    const tileLayers = {
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri', maxZoom: 19
        }),
        topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenTopoMap', subdomains: 'abc', maxZoom: 17
        }),
        light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CARTO', subdomains: 'abcd', maxZoom: 19
        })
    };

    let activeLayer = tileLayers.satellite;
    activeLayer.addTo(map);

    // Katman seçici
    const switcherHTML = `
        <div id="map-switcher">
            <button class="map-btn active" data-layer="satellite" title="Uydu">
                <span class="map-btn-icon">🛰️</span><span class="map-btn-label">Uydu</span>
            </button>
            <button class="map-btn" data-layer="topo" title="Fiziki">
                <span class="map-btn-icon">🗺️</span><span class="map-btn-label">Fiziki</span>
            </button>
            <button class="map-btn" data-layer="light" title="Sade">
                <span class="map-btn-icon">🗾</span><span class="map-btn-label">Sade</span>
            </button>
            <div class="map-btn-divider"></div>
            <button class="map-btn map-btn-action" id="map-fs-btn" title="Tam Ekran">
                <span class="map-btn-icon">⛶</span><span class="map-btn-label">Ekran</span>
            </button>
            <button class="map-btn map-btn-action" id="map-reset-btn" title="İlerlemeyi Sıfırla" disabled
                onclick="handleMapQuizReset()">
                <span class="map-btn-icon">↺</span><span class="map-btn-label">Sıfırla</span>
            </button>
        </div>
    `;
    const switcherContainer = L.control({ position: 'bottomright' });
    switcherContainer.onAdd = function() {
        const div = L.DomUtil.create('div', 'leaflet-control');
        div.innerHTML = switcherHTML.replace('<div id="map-switcher">', '<div id="map-switcher" style="position:static;bottom:auto;right:auto;">');
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    switcherContainer.addTo(map);

    document.querySelectorAll('.map-btn[data-layer]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const key = btn.dataset.layer;
            if (activeLayer === tileLayers[key]) return;
            map.removeLayer(activeLayer);
            tileLayers[key].addTo(map);
            activeLayer = tileLayers[key];
            document.querySelectorAll('.map-btn[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    const mapFsBtn = document.getElementById('map-fs-btn');
    if (mapFsBtn) mapFsBtn.addEventListener('click', e => { e.stopPropagation(); _toggleMapFullscreen(mapFsBtn); });

    document.addEventListener('fullscreenchange', _onMapFullscreenChange);
    document.addEventListener('webkitfullscreenchange', _onMapFullscreenChange);

    // ── Pinleri Yerleştir ────────────────────────────────────
    currentGameId = gameId;
    answeredPinStatus = new Map();
    _placeMapQuizPins(gameId);

    // Kaydedilmiş ilerlemeyi geri yükle
    const savedProgress = loadGeoProgress(gameId);
    Object.entries(savedProgress).forEach(([pinId, status]) => {
        answeredPinStatus.set(pinId, status);
        if (status === 'correct') score.correct++;
        else if (status === 'passive') score.shown++;
    });
    Object.entries(savedProgress).forEach(([pinId, status]) => {
        const el = document.getElementById(`mqpin-${pinId}`);
        if (el) el.classList.add(status === 'correct' ? 'mq-pin-correct' : 'mq-pin-passive');
    });
    if (Object.keys(savedProgress).length > 0) {
        _mqUpdateHUD();
        updateScore();
        _mqCheckCompletion();
    }

    if (window.innerWidth < 900) enterGeoFullscreen();
}

// ── Pinleri haritaya koy ──────────────────────────────────────
function _placeMapQuizPins(gameId) {
    const pinsData = appData.gameData[gameId] || [];
    currentMarkers = [];

    // Renk → ulaşım tipine göre
    const TYPE_COLORS = {
        karayolu_demiryolu: '#8b5cf6', // mor — hem karayolu hem demiryolu
        demiryolu: '#f59e0b',           // amber — sadece demiryolu
        karayolu: '#3b82f6'             // mavi — sadece karayolu
    };
    const TYPE_ICONS = {
        karayolu_demiryolu: '🚗🚂',
        demiryolu: '🚂',
        karayolu: '🚗'
    };

    pinsData.forEach(item => {
        const color = TYPE_COLORS[item.type] || '#3b82f6';
        const icon = TYPE_ICONS[item.type] || '🚗';

        const isDone = answeredPinStatus.has(item.id);
        const doneClass = isDone
            ? (answeredPinStatus.get(item.id) === 'correct' ? 'mq-pin-correct' : 'mq-pin-passive')
            : '';

        const pinHTML = `
            <div class="mq-pin ${doneClass}" id="mqpin-${item.id}" data-pin-id="${item.id}">
                <div class="mq-pin-body" style="background:${color};">
                    <span class="mq-pin-num">${item.label}</span>
                </div>
            </div>
        `;

        const leafletIcon = L.divIcon({
            className: 'custom-leaflet-icon',
            html: pinHTML,
            iconSize: [36, 36], iconAnchor: [18, 38], popupAnchor: [0, -38]
        });

        const marker = L.marker([item.lat, item.lng], { icon: leafletIcon }).addTo(map);

        marker.on('click', () => {
            // Tamamlanmışsa bilgi göster, değilse soru sor
            const pinEl = document.getElementById(`mqpin-${item.id}`);
            const done = answeredPinStatus.has(item.id);
            if (done) {
                _mqShowInfoCard(item);
                return;
            }
            _mqOpenQuestion(item);
        });

        currentMarkers.push({ leafletMarker: marker, dataId: item.id });
    });
}

// ── Soru Modalını Aç ─────────────────────────────────────────
function _mqOpenQuestion(item) {
    currentMountain = item;

    // Tüm pinlerden 3 yanlış şık üret
    const allPins = appData.gameData[currentGameId] || [];
    const otherNames = allPins
        .filter(p => p.id !== item.id)
        .map(p => p.names[0]);

    // Fisher-Yates ile karıştır ve 3 tane al
    for (let i = otherNames.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherNames[i], otherNames[j]] = [otherNames[j], otherNames[i]];
    }
    const wrongOptions = otherNames.slice(0, 3);
    const allOptions = shuffleArray([item.names[0], ...wrongOptions]);

    // Pin tipi badge
    const TYPE_LABELS = {
        karayolu_demiryolu: '🚗🚂 Karayolu + Demiryolu',
        demiryolu: '🚂 Demiryolu',
        karayolu: '🚗 Karayolu'
    };

    // Mevcut openQuestion altyapısını kullan
    // Ama önce item'a MC options ekle (mevcut renderMultipleChoice için)
    const mockItem = {
        ...item,
        q: `${item.label} numaralı sınır kapısı hangisidir?`,
        a: [item.names[0]],
        options: allOptions,
        topicTitle: TYPE_LABELS[item.type] || 'Sınır Kapısı',
        _isMapQuiz: true // ayırt etmek için flag
    };

    currentMountain = mockItem;
    openQuestion(mockItem);

    // HUD güncelle
    const hudSub = document.getElementById('hud-subtitle');
    if (hudSub) hudSub.innerText = `${item.il} ilinde, ${item.ulke} sınırında bir kapı`;
}

// ── Tamamlanan pine tıklanınca bilgi kartı ───────────────────
function _mqShowInfoCard(item) {
    const status = answeredPinStatus.get(item.id);
    const icon = status === 'correct' ? '✅' : '🔶';
    const name = item.names[0].toLocaleUpperCase('tr');
    const msg = `${icon} ${name} — ${item.desc || item.il + ' / ' + item.ulke}`;
    if (typeof showToast === 'function') showToast(msg, status === 'correct' ? 'success' : 'warning', 3500);
}

// ── HUD Güncelle ─────────────────────────────────────────────
function _mqUpdateHUD() {
    const correctEl = document.getElementById('hud-correct');
    const wrongEl = document.getElementById('hud-wrong');
    const shownEl = document.getElementById('hud-shown');
    const ringFill = document.getElementById('hud-ring-fill');
    const ringText = document.getElementById('hud-ring-text');

    if (correctEl) correctEl.textContent = score.correct;
    if (wrongEl) wrongEl.textContent = score.wrong;
    if (shownEl) shownEl.textContent = score.shown;

    const pinsData = appData.gameData[currentGameId] || [];
    const total = pinsData.length;
    const done = answeredPinStatus.size;

    if (ringText) ringText.textContent = `${done}/${total}`;
    if (ringFill) {
        const circumference = 113.1;
        const pct = total > 0 ? done / total : 0;
        ringFill.style.strokeDashoffset = circumference - pct * circumference;
        ringFill.style.transition = 'stroke-dashoffset 0.4s ease';
    }

    updateResetButton();
}

// ── Tamamlanma kontrolü ───────────────────────────────────────
function _mqCheckCompletion() {
    const pinsData = appData.gameData[currentGameId] || [];
    if (answeredPinStatus.size >= pinsData.length) {
        setTimeout(() => showCompletionScreen(), 400);
    }
}

// ── Sıfırlama ─────────────────────────────────────────────────
function handleMapQuizReset() {
    const btn = document.getElementById('map-reset-btn');
    if (btn && btn.disabled) return;
    const hudTitle = document.getElementById('hud-title');
    const title = hudTitle ? hudTitle.innerText : '';
    showResetConfirm(`"${title}" haritasındaki tüm ilerleme silinecek. Emin misin?`, () => {
        clearGeoProgress(currentGameId);
        startMapQuiz(currentGameId, title, _currentParentId);
    });
}

// ── openQuestion'ın mapquiz cevap sonrası çağırdığı kısımları patch et ──
// checkAnswer ve selectMCOption'da currentMountain._isMapQuiz === true ise
// pin DOM'unu güncelle ve progress kaydet.
// Mevcut sisteme eklenti (monkey-patch değil, event tabanlı):

const _origSelectMCOption = window.selectMCOption;
window.selectMCOption = function(btn, selected) {
    // _origSelectMCOption'ı çağır (mevcut davranış korunur)
    _origSelectMCOption.call(this, btn, selected);

    // Eğer mapquiz ise pin'i güncelle
    if (currentMountain && currentMountain._isMapQuiz) {
        const _correctAnswers = _getCorrectAnswers(currentMountain);
        const isCorrect = _correctAnswers.some(a => normalizeText(selected) === normalizeText(a));
        const pinId = currentMountain.id;

        if (isCorrect) {
            answeredPinStatus.set(pinId, 'correct');
            saveGeoProgress(currentGameId, pinId, 'correct');
            const pinEl = document.getElementById(`mqpin-${pinId}`);
            if (pinEl) {
                pinEl.classList.remove('mq-pin-passive');
                pinEl.classList.add('mq-pin-correct');
            }
            _mqUpdateHUD();
            // Tamamlandı mı kontrol et (cevap sonrası kısa gecikmeyle)
            setTimeout(_mqCheckCompletion, 1200);
        } else {
            answeredPinStatus.set(pinId, 'passive');
            saveGeoProgress(currentGameId, pinId, 'passive');
            const pinEl = document.getElementById(`mqpin-${pinId}`);
            if (pinEl) {
                pinEl.classList.add('mq-pin-passive');
            }
            _mqUpdateHUD();
            setTimeout(_mqCheckCompletion, 1200);
        }
    }
};

// showAnswer (Cevabı Göster) için de aynı şekilde patch:
const _origShowAnswer = window.showAnswer;
window.showAnswer = function() {
    _origShowAnswer.call(this);
    if (currentMountain && currentMountain._isMapQuiz) {
        const pinId = currentMountain.id;
        answeredPinStatus.set(pinId, 'passive');
        saveGeoProgress(currentGameId, pinId, 'passive');
        const pinEl = document.getElementById(`mqpin-${pinId}`);
        if (pinEl) pinEl.classList.add('mq-pin-passive');
        _mqUpdateHUD();
    }
};

// ── handleSelection patch: mapquiz modu entegrasyonu ────────
// Mevcut _patchHandleSelection'dan ÖNCE gelecek —
// type === 'mapquiz' ise startMapQuiz'i çağır
(function _patchMapQuizHandleSelection() {
    const _prev = window.handleSelection;
    window.handleSelection = function(item) {
        if (item.type === 'mapquiz' && item.gameId) {
            const parentId = findParentMenuId(item.id);
            startMapQuiz(item.gameId, item.title, parentId);
            return;
        }
        if (_prev) _prev.call(this, item);
    };
})();

// ── CSS sınır kapısı tiplerine göre pin renkleri ──────────────
// Bu stilleri style.css'e ekle (ya da inline inject et):
(function _injectMapQuizCSS() {
    const style = document.createElement('style');
    style.textContent = `
        /* ── Harita Sorusu Modu — Pin Stilleri ── */
        .mq-pin { cursor: pointer; }
        .mq-pin-body {
            width: 32px; height: 32px;
            border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 3px 10px rgba(0,0,0,0.35);
            transition: transform 0.2s, box-shadow 0.2s;
            border: 2px solid rgba(255,255,255,0.8);
        }
        .mq-pin:hover .mq-pin-body {
            transform: rotate(-45deg) scale(1.15);
            box-shadow: 0 6px 18px rgba(0,0,0,0.45);
        }
        .mq-pin-num {
            transform: rotate(45deg);
            font-size: 10px;
            font-weight: 800;
            color: #fff;
            line-height: 1;
        }

        /* Tamamlanan pinler */
        .mq-pin.mq-pin-correct .mq-pin-body {
            background: radial-gradient(circle at 35% 35%, #2ecc71, #1e8449) !important;
            border-color: rgba(255,255,255,0.9);
        }
        .mq-pin.mq-pin-passive .mq-pin-body {
            background: radial-gradient(circle at 35% 35%, #e67e22, #ca6f1e) !important;
            border-color: rgba(255,255,255,0.9);
        }
        .mq-pin.mq-pin-correct .mq-pin-num::after { content: '✓'; font-size: 12px; }
        .mq-pin.mq-pin-correct .mq-pin-num { font-size: 0; }
        .mq-pin.mq-pin-passive .mq-pin-num::after { content: '✗'; font-size: 12px; }
        .mq-pin.mq-pin-passive .mq-pin-num { font-size: 0; }

        /* Pulse animasyonu — yeni pine tıklanınca */
        @keyframes mqPinPulse {
            0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7); }
            70% { box-shadow: 0 0 0 14px rgba(99, 102, 241, 0); }
            100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
        }
        .mq-pin-pulse .mq-pin-body { animation: mqPinPulse 0.8s ease-out; }
    `;
    document.head.appendChild(style);
})();

// ============================================================
// NATIVE FULLSCREEN MODAL FIX
// Sorun: requestFullscreen ile #game-area tam ekrana alındığında,
// tarayıcı yeni bir "fullscreen stacking context" oluşturur.
// Bu context dışında kalan position:fixed elemanlar (#modal-overlay,
// #question-modal) ekranda görünmez — z-index ne olursa olsun.
//
// Çözüm: Native fullscreen aktifken modal elemanlarını fullscreen
// container'ı olan #game-area içine taşı. Fullscreen kapanınca
// ya da modal kapanınca body'e geri taşı.
// ============================================================
(function _nativeFullscreenModalFix() {

    const MODAL_IDS = ['modal-overlay', 'question-modal'];
    // Modal'ların body içindeki orijinal referans noktası (script.js'nin
    // yüklenmesi bitince DOM hazır olur, DOMContentLoaded'a gerek yok)
    let _modalParent = null;          // body
    let _modalNextSibling = null;     // body içindeki sırayı korumak için
    let _movedToFs = false;

    function _getGameArea() {
        return document.getElementById('game-area');
    }

    // Modalları fullscreen container'a taşı
    function _moveModalsIntoFullscreen() {
        if (_movedToFs) return;
        const ga = _getGameArea();
        if (!ga) return;

        const overlay = document.getElementById('modal-overlay');
        const modal   = document.getElementById('question-modal');
        if (!overlay || !modal) return;

        // Orijinal konumu kaydet (bir kez)
        if (!_modalParent) {
            _modalParent      = overlay.parentNode;
            _modalNextSibling = overlay.nextSibling;
        }

        // game-area içinde position:fixed çalışmaz ama fullscreen stacking
        // context'in içinde olduğu için görünür hale gelir.
        // Ama absolute ile konumlandırılması gerekir — CSS'deki fixed kurallarını override edelim.
        _applyInFsStyles(overlay, modal);

        ga.appendChild(overlay);
        ga.appendChild(modal);
        _movedToFs = true;
    }

    // Modalları eski yerine geri taşı
    function _moveModalsBackToBody() {
        if (!_movedToFs) return;
        const overlay = document.getElementById('modal-overlay');
        const modal   = document.getElementById('question-modal');
        if (!overlay || !modal) { _movedToFs = false; return; }

        _removeInFsStyles(overlay, modal);

        const parent = _modalParent || document.body;
        if (_modalNextSibling && _modalNextSibling.parentNode === parent) {
            parent.insertBefore(overlay, _modalNextSibling);
            parent.insertBefore(modal,   _modalNextSibling);
        } else {
            parent.appendChild(overlay);
            parent.appendChild(modal);
        }
        _movedToFs = false;
    }

    // game-area içinde fixed çalışmadığı için inline style ile
    // fullscreen-aware absolute konumlandırma uygula
    function _applyInFsStyles(overlay, modal) {
        // Overlay: tüm game-area'yı kapla
        overlay.dataset._fsFixed = '1';
        overlay.style.setProperty('position', 'absolute', 'important');
        overlay.style.setProperty('inset', '0', 'important');
        overlay.style.setProperty('z-index', '9999', 'important');
        overlay.style.setProperty('width', '100%', 'important');
        overlay.style.setProperty('height', '100%', 'important');

        // Modal: ortala
        modal.dataset._fsFixed = '1';
        modal.style.setProperty('position', 'absolute', 'important');
        modal.style.setProperty('z-index', '10000', 'important');
        // Landscape: ortalanmış kutu
        const isLandscape = window.innerWidth > window.innerHeight;
        if (isLandscape) {
            modal.style.setProperty('top', '50%', 'important');
            modal.style.setProperty('left', '50%', 'important');
            modal.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
            modal.style.setProperty('bottom', 'auto', 'important');
            modal.style.setProperty('right', 'auto', 'important');
            modal.style.setProperty('width', 'min(420px, 55vw)', 'important');
            modal.style.setProperty('max-height', '90vh', 'important');
            modal.style.setProperty('border-radius', 'var(--r-xl)', 'important');
        } else {
            // Portrait: alt sheet
            modal.style.setProperty('bottom', '0', 'important');
            modal.style.setProperty('left', '0', 'important');
            modal.style.setProperty('right', '0', 'important');
            modal.style.setProperty('top', 'auto', 'important');
            modal.style.setProperty('transform', 'none', 'important');
            modal.style.setProperty('width', '100%', 'important');
            modal.style.setProperty('max-height', '80svh', 'important');
            modal.style.setProperty('border-radius', 'var(--r-xl) var(--r-xl) 0 0', 'important');
        }
    }

    function _removeInFsStyles(overlay, modal) {
        [overlay, modal].forEach(el => {
            if (!el || !el.dataset._fsFixed) return;
            delete el.dataset._fsFixed;
            ['position','inset','z-index','width','height',
             'top','left','right','bottom','transform','max-height','border-radius']
                .forEach(p => el.style.removeProperty(p));
        });
    }

    // ── Fullscreenchange listener ──────────────────────────────
    function _onFsChange() {
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isNativeFs) {
            // Tam ekrandan çıkıldı — modalları geri taşı
            _moveModalsBackToBody();
        }
        // Tam ekrana girilince openQuestion zaten çağrılır ve orada taşıma yapılır.
    }

    document.addEventListener('fullscreenchange',       _onFsChange);
    document.addEventListener('webkitfullscreenchange', _onFsChange);

    // ── openQuestion patch ─────────────────────────────────────
    const _origOpenQuestion = window.openQuestion;
    window.openQuestion = function(item, markerObject) {
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (isNativeFs) {
            // Önce taşı, sonra orijinal fonksiyonu çağır (display:block yapar)
            _moveModalsIntoFullscreen();
        } else if (_movedToFs) {
            // Native fs kapandı ama henüz geri taşınmadıysa
            _moveModalsBackToBody();
        }
        _origOpenQuestion.call(this, item, markerObject);
    };

    // ── closeModal patch ───────────────────────────────────────
    const _origCloseModal = window.closeModal;
    window.closeModal = function() {
        _origCloseModal.call(this);
        // Fullscreen dışındaysa taşıma gerekmez; fullscreen içindeyse modallar zaten orada
        // Eğer native fs artık yoksa geri taşı
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isNativeFs && _movedToFs) {
            _moveModalsBackToBody();
        }
    };

    // ── Orientation değişince in-fs konumu güncelle ────────────
    window.addEventListener('resize', () => {
        if (!_movedToFs) return;
        const overlay = document.getElementById('modal-overlay');
        const modal   = document.getElementById('question-modal');
        if (overlay && modal && modal.style.display !== 'none') {
            _applyInFsStyles(overlay, modal);
        }
    });

})(); // end _nativeFullscreenModalFix

// ============================================================
// MAPQUIZ YAN PANEL v5
// ============================================================
// ⚠️  script.js sonundaki _mapQuizSidePanelV* bloğunu tamamen
//     sil. Sonra bu dosyayı en sona yapıştır.
// ============================================================
// Değişiklikler:
//   - Panel body'e eklenir (fixed), native fullscreen'de
//     _nativeFullscreenModalFix gibi #game-area'ya taşınır
//   - Masaüstünde harita küçülmez — panel haritanın üstüne
//     sağ kenardan overlay açılır (GeoGuessr stili)
//   - Cevap sonrası panel KAPANMAZ, kullanıcı × ile kapatır
//   - Tamamlanmış pine tıklayınca şık yok, sadece bilgi kartı
// ============================================================

(function _mapQuizSidePanelV5() {
    'use strict';

    // ── Yardımcılar ──────────────────────────────────────────
    function _shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    function _norm(s) {
        return String(s).toLowerCase()
            .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
            .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c').trim();
    }

    // ── Panel şu an nerede? ───────────────────────────────────
    let _panelInGameArea = false;
    let _panelOrigParent = null;
    let _panelOrigNext   = null;

    // ── Panel oluştur (body'e) ────────────────────────────────
    function _ensurePanel() {
        if (document.getElementById('mq-side-panel')) return;
        const el = document.createElement('div');
        el.id = 'mq-side-panel';
        el.innerHTML =
            '<div class="mqp-header">' +
                '<div class="mqp-badge" id="mqp-badge">📍</div>' +
                '<button class="mqp-close" id="mqp-close">\u00d7</button>' +
            '</div>' +
            '<div class="mqp-body">' +
                '<div class="mqp-question" id="mqp-question"></div>' +
                '<div class="mqp-info"     id="mqp-info"></div>' +
                '<div class="mqp-options"  id="mqp-options"></div>' +
                '<div class="mqp-feedback" id="mqp-feedback"></div>' +
                '<button class="mqp-btn-show" id="mqp-btn-show">Cevab\u0131 G\u00f6ster</button>' +
            '</div>';
        document.body.appendChild(el);
        _panelOrigParent = document.body;
        _panelOrigNext   = null;
        document.getElementById('mqp-close').onclick = _closePanel;
        document.getElementById('mqp-btn-show').onclick = _showAnswer;
    }

    // Native fullscreen'de panel body'nin dışında kalır → game-area'ya taşı
    function _movePanelIntoFS() {
        if (_panelInGameArea) return;
        const panel = document.getElementById('mq-side-panel');
        const ga    = document.getElementById('game-area');
        if (!panel || !ga) return;
        _panelOrigParent = panel.parentNode;
        _panelOrigNext   = panel.nextSibling;
        // game-area içinde fixed değil absolute çalışır
        panel.classList.add('mqp-in-game-area');
        ga.appendChild(panel);
        _panelInGameArea = true;
    }

    function _movePanelBackToBody() {
        if (!_panelInGameArea) return;
        const panel = document.getElementById('mq-side-panel');
        if (!panel) { _panelInGameArea = false; return; }
        panel.classList.remove('mqp-in-game-area');
        const parent = _panelOrigParent || document.body;
        if (_panelOrigNext && _panelOrigNext.parentNode === parent) {
            parent.insertBefore(panel, _panelOrigNext);
        } else {
            parent.appendChild(panel);
        }
        _panelInGameArea = false;
    }

    function _removePanel() {
        _movePanelBackToBody();
        const p = document.getElementById('mq-side-panel');
        if (p) p.remove();
        _panelInGameArea = false;
    }

    function _closePanel() {
        const p = document.getElementById('mq-side-panel');
        if (p) p.classList.remove('mqp-open');
        document.querySelectorAll('.mq-pin-active').forEach(e => e.classList.remove('mq-pin-active'));
    }

    // Tam ekran değişince paneli doğru yere taşı
    function _onFsChange() {
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const panel = document.getElementById('mq-side-panel');
        if (!panel) return;
        if (isNativeFs) {
            _movePanelIntoFS();
        } else {
            _movePanelBackToBody();
        }
        // Panelin açık olup olmadığına bakılmaksızın haritayı güncelle
        setTimeout(() => { if (map) map.invalidateSize(); }, 150);
    }

    document.addEventListener('fullscreenchange',       _onFsChange);
    document.addEventListener('webkitfullscreenchange', _onFsChange);

    // ── Aktif durum ───────────────────────────────────────────
    let _activeItem = null;
    let _locked     = false;

    // ── Soru panelini aç ─────────────────────────────────────
    function _openPanel(item) {
        if (_locked) return;
        _activeItem = item;
        _ensurePanel();

        // Native fullscreen'de panel zaten game-area'da olmalı
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (isNativeFs && !_panelInGameArea) _movePanelIntoFS();

        const TYPE_LABELS = {
            karayolu_demiryolu: '\ud83d\ude97\ud83d\ude82 Karayolu + Demiryolu',
            demiryolu:          '\ud83d\ude82 Sadece Demiryolu',
            karayolu:           '\ud83d\ude97 Sadece Karayolu'
        };
        const TYPE_COLORS = {
            karayolu_demiryolu: '#8b5cf6',
            demiryolu:          '#f59e0b',
            karayolu:           '#3b82f6'
        };
        const color = TYPE_COLORS[item.type] || '#3b82f6';
        const badge = document.getElementById('mqp-badge');
        badge.textContent       = TYPE_LABELS[item.type] || '📍';
        badge.style.background  = color + '22';
        badge.style.color       = color;
        badge.style.borderColor = color + '55';

        document.getElementById('mqp-question').textContent =
            item.label + ' numaral\u0131 s\u0131n\u0131r kap\u0131s\u0131 hangisidir?';
        document.getElementById('mqp-info').textContent =
            '\ud83d\udccd ' + item.il + ' ili \u2014 ' + item.ulke + ' s\u0131n\u0131r\u0131';

        const all    = appData.gameData[currentGameId] || [];
        const others = _shuffle(all.filter(p => p.id !== item.id))
                         .slice(0, 3).map(p => p.names[0]);
        const options = _shuffle([item.names[0], ...others]);

        const optEl = document.getElementById('mqp-options');
        optEl.innerHTML = '';
        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.className   = 'mqp-option';
            btn.textContent = opt;
            btn.onclick     = () => _pick(btn, opt, item);
            optEl.appendChild(btn);
        });

        document.getElementById('mqp-feedback').textContent   = '';
        document.getElementById('mqp-feedback').className     = 'mqp-feedback';
        document.getElementById('mqp-btn-show').style.display = 'block';

        document.querySelectorAll('.mq-pin-active').forEach(e => e.classList.remove('mq-pin-active'));
        const pinEl = document.getElementById('mqpin-' + item.id);
        if (pinEl) pinEl.classList.add('mq-pin-active');

        document.getElementById('mq-side-panel').classList.add('mqp-open');
    }

    // ── Bilgi paneli (tamamlanmış pin) ───────────────────────
    function _openInfoPanel(item) {
        _ensurePanel();
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (isNativeFs && !_panelInGameArea) _movePanelIntoFS();

        const status = answeredPinStatus.get(item.id);
        const icon   = status === 'correct' ? '✅' : '🔶';
        const TYPE_LABELS = {
            karayolu_demiryolu: '\ud83d\ude97\ud83d\ude82 Karayolu + Demiryolu',
            demiryolu:          '\ud83d\ude82 Sadece Demiryolu',
            karayolu:           '\ud83d\ude97 Sadece Karayolu'
        };
        const TYPE_COLORS = {
            karayolu_demiryolu: '#8b5cf6',
            demiryolu:          '#f59e0b',
            karayolu:           '#3b82f6'
        };
        const color = TYPE_COLORS[item.type] || '#3b82f6';
        const badge = document.getElementById('mqp-badge');
        badge.textContent       = TYPE_LABELS[item.type] || '📍';
        badge.style.background  = color + '22';
        badge.style.color       = color;
        badge.style.borderColor = color + '55';

        document.getElementById('mqp-question').textContent    = icon + '\u00a0' + item.names[0].toLocaleUpperCase('tr');
        document.getElementById('mqp-info').textContent        = '\ud83d\udccd ' + item.il + ' ili \u2014 ' + item.ulke + ' s\u0131n\u0131r\u0131';
        document.getElementById('mqp-options').innerHTML       = '';
        document.getElementById('mqp-feedback').className      = 'mqp-feedback mqp-fb-info';
        document.getElementById('mqp-feedback').innerHTML      = item.desc || '';
        document.getElementById('mqp-btn-show').style.display  = 'none';

        document.querySelectorAll('.mq-pin-active').forEach(e => e.classList.remove('mq-pin-active'));
        const pinEl = document.getElementById('mqpin-' + item.id);
        if (pinEl) pinEl.classList.add('mq-pin-active');

        document.getElementById('mq-side-panel').classList.add('mqp-open');
    }

    // ── Şık seçimi ────────────────────────────────────────────
    function _pick(btn, selected, item) {
        if (_locked) return;
        _locked = true;

        document.querySelectorAll('.mqp-option').forEach(b => b.disabled = true);

        const correct = _norm(item.names[0]);
        const isOk    = _norm(selected) === correct;
        const feedEl  = document.getElementById('mqp-feedback');

        document.querySelectorAll('.mqp-option').forEach(b => {
            if (_norm(b.textContent) === correct) b.classList.add('mqp-opt-correct');
        });

        if (isOk) {
            btn.classList.add('mqp-opt-correct');
            feedEl.className = 'mqp-feedback mqp-fb-correct';
            feedEl.innerHTML = '<b>\u2713 DO\u011eRU!</b><br><span>' + (item.desc || '') + '</span>';
            score.correct++;
            answeredPinStatus.set(item.id, 'correct');
            saveGeoProgress(currentGameId, item.id, 'correct');
            _setPinState(item.id, 'correct');
        } else {
            btn.classList.add('mqp-opt-wrong');
            feedEl.className = 'mqp-feedback mqp-fb-wrong';
            feedEl.innerHTML = '<b>\u2717 YANLI\u015e!</b> Do\u011fru cevap i\u015faretlendi.<br><span>' + (item.desc || '') + '</span>';
            score.wrong++;
            answeredPinStatus.set(item.id, 'passive');
            saveGeoProgress(currentGameId, item.id, 'passive');
            _setPinState(item.id, 'passive');
        }

        document.getElementById('mqp-btn-show').style.display = 'none';
        updateScore();
        _mqUpdateHUD();

        // Panel KAPANMAZ — kullanıcı x'e basar veya başka pine tıklar
        setTimeout(() => {
            _locked = false;
            _mqCheckCompletion();
        }, 300);
    }

    // ── Cevabı Göster ─────────────────────────────────────────
    function _showAnswer() {
        if (!_activeItem || _locked) return;
        _locked = true;
        const item = _activeItem;

        document.querySelectorAll('.mqp-option').forEach(b => {
            b.disabled = true;
            if (_norm(b.textContent) === _norm(item.names[0])) b.classList.add('mqp-opt-correct');
        });

        const feedEl = document.getElementById('mqp-feedback');
        feedEl.className = 'mqp-feedback mqp-fb-shown';
        feedEl.innerHTML = '<b>\ud83d\udca1 CEVAP: ' + item.names[0] + '</b><br><span>' + (item.desc || '') + '</span>';
        document.getElementById('mqp-btn-show').style.display = 'none';

        score.shown++;
        answeredPinStatus.set(item.id, 'passive');
        saveGeoProgress(currentGameId, item.id, 'passive');
        _setPinState(item.id, 'passive');
        updateScore();
        _mqUpdateHUD();

        setTimeout(() => {
            _locked = false;
            _mqCheckCompletion();
        }, 300);
    }

    // ── Pin görsel state ──────────────────────────────────────
    function _setPinState(pinId, status) {
        const el = document.getElementById('mqpin-' + pinId);
        if (!el) return;
        el.classList.remove('mq-pin-active', 'mq-pin-correct', 'mq-pin-passive');
        el.classList.add(status === 'correct' ? 'mq-pin-correct' : 'mq-pin-passive');
    }

    // ── _placeMapQuizPins ─────────────────────────────────────
    window._placeMapQuizPins = function(gameId) {
        const pinsData = appData.gameData[gameId] || [];
        currentMarkers = [];

        const TYPE_COLORS = {
            karayolu_demiryolu: '#8b5cf6',
            demiryolu:          '#f59e0b',
            karayolu:           '#3b82f6'
        };

        pinsData.forEach(function(item) {
            const color     = TYPE_COLORS[item.type] || '#3b82f6';
            const isDone    = answeredPinStatus.has(item.id);
            const doneClass = isDone
                ? (answeredPinStatus.get(item.id) === 'correct' ? 'mq-pin-correct' : 'mq-pin-passive')
                : '';

            const pinHTML =
                '<div class="mq-pin ' + doneClass + '" id="mqpin-' + item.id + '">' +
                    '<div class="mq-pin-body" style="background:' + color + ';">' +
                        '<span class="mq-pin-num">' + item.label + '</span>' +
                    '</div>' +
                '</div>';

            const icon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: pinHTML,
                iconSize: [36, 36], iconAnchor: [18, 38]
            });

            const marker = L.marker([item.lat, item.lng], { icon: icon }).addTo(map);

            (function(it) {
                marker.on('click', function() {
                    if (answeredPinStatus.has(it.id)) {
                        _openInfoPanel(it);
                    } else {
                        _openPanel(it);
                    }
                });
            })(item);

            currentMarkers.push({ leafletMarker: marker, dataId: item.id });
        });
    };

    // ── startMapQuiz override ─────────────────────────────────
    const _origStartMapQuiz = window.startMapQuiz;
    window.startMapQuiz = function(gameId, title, parentId) {
        _removePanel();
        _activeItem = null;
        _locked     = false;
        document.body.classList.remove('mapquiz-active');

        // enterGeoFullscreen'i no-op yap (otomatik fullscreen'i engelle)
        const _origEnter = window.enterGeoFullscreen;
        window.enterGeoFullscreen = function(){};
        try {
            _origStartMapQuiz.call(this, gameId, title, parentId);
        } finally {
            window.enterGeoFullscreen = _origEnter;
        }

        document.body.classList.add('mapquiz-active');
        setTimeout(() => { if (map) map.invalidateSize(); }, 200);
    };

    // ── exitGeoFullscreen override ────────────────────────────
    const _origExitGeo = window.exitGeoFullscreen;
    window.exitGeoFullscreen = function() {
        _locked     = false;
        _activeItem = null;
        _removePanel();
        document.body.classList.remove('mapquiz-active');
        if (_origExitGeo) _origExitGeo.call(this);
    };

    window.addEventListener('resize', () => {
        if (document.body.classList.contains('mapquiz-active') && map) {
            setTimeout(() => map.invalidateSize(), 150);
        }
    });

    // ── CSS ───────────────────────────────────────────────────
    const old = document.getElementById('mq-panel-styles');
    if (old) old.remove();
    const style = document.createElement('style');
    style.id = 'mq-panel-styles';
    style.textContent = `

/* ============================================================
   MAPQUIZ PANEL — body.fixed → game-area.absolute (fullscreen)
   Harita HİÇ küçülmez — panel her zaman haritanın üzerine
   overlay açılır (GeoGuessr stili)
   ============================================================ */

/* ── Normal mod (body'de, fixed) ── */
#mq-side-panel {
    position: fixed;
    z-index: 8500;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2);
    font-family: 'DM Sans', sans-serif;
    opacity: 0;
    pointer-events: none;
    transition: transform 0.28s cubic-bezier(0.4,0,0.2,1),
                opacity  0.22s ease;
}
#mq-side-panel.mqp-open {
    opacity: 1;
    pointer-events: auto;
}

/* ── Native fullscreen'de: game-area içinde absolute ── */
#mq-side-panel.mqp-in-game-area {
    position: absolute !important;
    /* konumlandırma aşağıda media query ile belirlenir */
}

/* ── Geniş ekran (masaüstü/tablet landscape ≥700px) ─────────
   Sağ üst köşede overlay — harita küçülmez                  */
@media (min-width: 700px) {
    #mq-side-panel {
        top: 80px;
        right: 18px;
        bottom: auto;
        left: auto;
        width: 300px;
        max-height: calc(100vh - 100px);
        border-radius: 16px;
        transform: translateX(calc(100% + 24px));
    }
    #mq-side-panel.mqp-open {
        transform: translateX(0);
    }

    /* Fullscreen içinde: sağ üst */
    #mq-side-panel.mqp-in-game-area {
        top: 60px;
        right: 12px;
        bottom: auto;
        left: auto;
        width: 290px;
        max-height: calc(100% - 72px);
        border-radius: 14px;
        transform: translateX(calc(100% + 16px));
    }
    #mq-side-panel.mqp-in-game-area.mqp-open {
        transform: translateX(0);
    }
}

/* ── Dar ekran / mobil (< 700px) ────────────────────────────
   Alt drawer — ekranın üzerinde süzülür                     */
@media (max-width: 699.98px) {
    #mq-side-panel {
        bottom: 0;
        left: 0;
        right: 0;
        top: auto;
        width: 100%;
        max-height: 75svh;
        border-radius: 18px 18px 0 0;
        border-bottom: none;
        transform: translateY(105%);
    }
    #mq-side-panel.mqp-open {
        transform: translateY(0);
    }

    /* Fullscreen içinde alt drawer */
    #mq-side-panel.mqp-in-game-area {
        bottom: 0;
        left: 0;
        right: 0;
        top: auto;
        width: 100%;
        max-height: 72svh;
        border-radius: 18px 18px 0 0;
        border-bottom: none;
        transform: translateY(105%);
    }
    #mq-side-panel.mqp-in-game-area.mqp-open {
        transform: translateY(0);
    }
}

/* ── Panel iç stiller ── */
.mqp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
    background: var(--panel-2, var(--panel));
    border-radius: inherit;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    position: sticky;
    top: 0;
}

.mqp-badge {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 4px 10px;
    border-radius: 99px;
    border: 1px solid transparent;
    white-space: nowrap;
    max-width: calc(100% - 40px);
    overflow: hidden;
    text-overflow: ellipsis;
}

.mqp-close {
    width: 28px; height: 28px; min-width: 28px;
    border-radius: 50%;
    background: var(--panel-3, rgba(255,255,255,0.06));
    border: 1px solid var(--line-2, var(--line));
    color: var(--t-300, var(--t-400));
    font-size: 1.15rem;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
    line-height: 1;
}
.mqp-close:hover { background: var(--panel); color: var(--t-100); }

.mqp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    padding-bottom: max(env(safe-area-inset-bottom, 0px), 10px);
}

.mqp-question {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--t-100);
    padding: 14px 16px 4px;
    line-height: 1.45;
}

.mqp-info {
    font-size: 0.70rem;
    color: var(--t-400);
    padding: 2px 16px 12px;
}

.mqp-options {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 0 14px 10px;
    flex-shrink: 0;
}

.mqp-option {
    width: 100%;
    text-align: left;
    padding: 10px 14px;
    border-radius: var(--r-md, 10px);
    background: var(--panel-2, rgba(255,255,255,0.05));
    border: 1px solid var(--line-2, var(--line));
    color: var(--t-100);
    font-size: 0.84rem;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, transform 0.1s;
    line-height: 1.3;
}
.mqp-option:hover:not(:disabled) {
    background: var(--panel-3, rgba(255,255,255,0.10));
    border-color: var(--line-3, var(--line));
    transform: translateX(3px);
}
.mqp-option:disabled { cursor: default; }

.mqp-opt-correct {
    background: var(--green-bg, rgba(46,204,113,0.14)) !important;
    border-color: var(--green, #2ecc71) !important;
    color: var(--green, #2ecc71) !important;
}
.mqp-opt-wrong {
    background: var(--red-bg, rgba(231,76,60,0.14)) !important;
    border-color: var(--red, #e74c3c) !important;
    color: var(--red, #e74c3c) !important;
}

.mqp-feedback {
    margin: 0 14px 10px;
    padding: 10px 13px;
    border-radius: var(--r-md, 10px);
    font-size: 0.79rem;
    line-height: 1.55;
    flex-shrink: 0;
    color: var(--t-200);
}
.mqp-feedback:empty { display: none; }
.mqp-feedback b { display: block; margin-bottom: 2px; }
.mqp-feedback span { opacity: 0.8; font-size: 0.73rem; }

.mqp-fb-correct {
    background: var(--green-bg, rgba(46,204,113,0.10));
    border: 1px solid var(--green, #2ecc71);
    color: var(--green, #2ecc71);
}
.mqp-fb-wrong {
    background: var(--red-bg, rgba(231,76,60,0.10));
    border: 1px solid var(--red, #e74c3c);
    color: var(--red, #e74c3c);
}
.mqp-fb-shown {
    background: var(--gold-bg, rgba(201,151,74,0.10));
    border: 1px solid var(--gold, #c9974a);
    color: var(--gold, #c9974a);
}
.mqp-fb-info {
    background: var(--panel-2, rgba(255,255,255,0.04));
    border: 1px solid var(--line);
    color: var(--t-200);
}

.mqp-btn-show {
    margin: 0 14px 14px;
    padding: 8px 14px;
    border-radius: var(--r-md, 10px);
    background: transparent;
    border: 1px solid var(--line-2, var(--line));
    color: var(--t-400);
    font-size: 0.73rem;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
    text-align: center;
}
.mqp-btn-show:hover {
    background: var(--panel-2);
    color: var(--t-100);
    border-color: var(--line-3, var(--line));
}

/* Mobilde biraz büyük */
@media (max-width: 699.98px) {
    .mqp-question { font-size: 0.95rem; }
    .mqp-option   { font-size: 0.88rem; padding: 12px 14px; }
    .mqp-feedback { font-size: 0.82rem; }
}

/* ── Aktif pin pulse ── */
.mq-pin-active .mq-pin-body {
    border-color: #fff !important;
    animation: mqActivePulse 1.1s ease-out infinite !important;
}
@keyframes mqActivePulse {
    0%   { box-shadow: 0 0 0 0    rgba(99,102,241,0.75); }
    65%  { box-shadow: 0 0 0 12px rgba(99,102,241,0);    }
    100% { box-shadow: 0 0 0 0    rgba(99,102,241,0);    }
}

    `;
    document.head.appendChild(style);

})();



// ============================================================
// GÖRSEL SORU DESTEĞİ — script.js'in SONUNA ekle
// ============================================================
// visual: { type: "image", url: "...", desc: "..." } alanı olan
// sorularda, soru metninin üstünde görsel veya açıklama gösterir.
// url doluysa → <img> göster
// url null ise → açıklama metni badge olarak göster
// ============================================================

(function _visualQuestionSupport() {
    'use strict';

    const VISUAL_ID = 'q-visual-area';

    function _removeVisual() {
        const el = document.getElementById(VISUAL_ID);
        if (el) el.remove();
    }

    function _injectVisual(item) {
        _removeVisual();
        if (!item || !item.visual) return;

        const modal   = document.getElementById('question-modal');
        const qTitle  = document.getElementById('q-title');
        if (!modal || !qTitle) return;

        const visual = item.visual;
        const wrap   = document.createElement('div');
        wrap.id      = VISUAL_ID;

        if (visual.url) {
            // Görsel yüklü → resim göster
            wrap.innerHTML =
                '<div class="qv-img-wrap">' +
                    '<img class="qv-img" src="' + visual.url + '" alt="' + (visual.desc || 'Soru görseli') + '" ' +
                         'onerror="this.parentNode.innerHTML=\'<div class=qv-desc-badge>🗺️ ' + (visual.desc || '') + '</div>\'" />' +
                '</div>';
        } else if (visual.desc) {
            // URL yok ama açıklama var → badge göster
            wrap.innerHTML =
                '<div class="qv-desc-badge">' +
                    '<span class="qv-desc-icon">🗺️</span>' +
                    '<span class="qv-desc-text">' + visual.desc + '</span>' +
                '</div>';
        } else {
            return; // Ne görsel ne açıklama → hiç ekleme
        }

        modal.insertBefore(wrap, qTitle);
    }

    // ── openQuestion'ı wrap et ────────────────────────────────
    const _origOpenQuestion = window.openQuestion;
    window.openQuestion = function(item, markerObject) {
        _origOpenQuestion.call(this, item, markerObject);
        _injectVisual(item);
    };

    // Modal kapanınca görseli temizle
    const _origCloseModal = window.closeModal;
    window.closeModal = function() {
        _removeVisual();
        if (_origCloseModal) _origCloseModal.call(this);
    };

    // ── CSS ───────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id    = 'visual-question-styles';
    style.textContent = `

#q-visual-area {
    margin: 0 0 14px 0;
    width: 100%;
}

/* Görsel resim */
.qv-img-wrap {
    width: 100%;
    border-radius: var(--r-lg, 12px);
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--panel-2, rgba(0,0,0,0.2));
    max-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.qv-img {
    width: 100%;
    height: auto;
    max-height: 220px;
    object-fit: contain;
    display: block;
}

/* URL yok → açıklama badge */
.qv-desc-badge {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    background: var(--panel-2, rgba(255,255,255,0.05));
    border: 1px solid var(--line);
    border-radius: var(--r-lg, 12px);
    border-left: 3px solid var(--accent, #6c6ef5);
    font-size: 0.78rem;
    color: var(--t-300, rgba(255,255,255,0.65));
    line-height: 1.45;
    font-style: italic;
}

.qv-desc-icon {
    font-size: 1rem;
    flex-shrink: 0;
    margin-top: 1px;
}

.qv-desc-text {
    flex: 1;
}

/* Mobil */
@media (max-width: 640px) {
    .qv-img-wrap { max-height: 160px; }
    .qv-img      { max-height: 160px; }
    .qv-desc-badge { font-size: 0.74rem; padding: 8px 12px; }
}

    `;

    const old = document.getElementById('visual-question-styles');
    if (old) old.remove();
    document.head.appendChild(style);

})();


// ============================================================
// GÖRSEL SORU DESTEĞİ v2 — script.js'in SONUNA ekle
// ============================================================

(function _visualQuestionSupportV2() {
    'use strict';

    const VISUAL_ID = 'q-visual-area';

    function _removeVisual() {
        const el = document.getElementById(VISUAL_ID);
        if (el) el.remove();
    }

    function _injectVisual(item) {
        _removeVisual();
        if (!item || !item.visual) return;

        const modal  = document.getElementById('question-modal');
        const qTitle = document.getElementById('q-title');
        if (!modal || !qTitle) return;

        const visual = item.visual;
        const wrap   = document.createElement('div');
        wrap.id      = VISUAL_ID;

        if (visual.url) {
            // URL varsa → görsel göster
            const img = document.createElement('img');
            img.className = 'qv-img';
            img.src       = visual.url;
            img.alt       = visual.desc || 'Soru görseli';
            img.onerror   = function() {
                // Görsel yüklenemezse desc badge'e dön
                wrap.innerHTML = '';
                if (visual.desc) wrap.appendChild(_makeBadge(visual.desc));
            };
            const imgWrap = document.createElement('div');
            imgWrap.className = 'qv-img-wrap';
            imgWrap.appendChild(img);
            wrap.appendChild(imgWrap);
        } else if (visual.desc) {
            // URL yok → açıklama badge
            wrap.appendChild(_makeBadge(visual.desc));
        } else {
            return;
        }

        modal.insertBefore(wrap, qTitle);
    }

    function _makeBadge(text) {
        const badge = document.createElement('div');
        badge.className = 'qv-desc-badge';
        badge.innerHTML =
            '<span class="qv-desc-icon">🗺️</span>' +
            '<span class="qv-desc-text">' + text + '</span>';
        return badge;
    }

    // ── openQuestion wrap ─────────────────────────────────────
    const _origOpenQuestion = window.openQuestion;
    window.openQuestion = function(item, markerObject) {
        _origOpenQuestion.call(this, item, markerObject);
        _injectVisual(item);
    };

    // ── closeModal wrap ───────────────────────────────────────
    const _origCloseModal = window.closeModal;
    window.closeModal = function() {
        _removeVisual();
        if (_origCloseModal) _origCloseModal.call(this);
    };
    // ── Global erişim noktası — showHistoryQuestion ve Firestore loader kullanır ──
    window._injectVisualFn = _injectVisual;
    window._removeVisualFn = _removeVisual;


    // ── CSS ───────────────────────────────────────────────────
    const old = document.getElementById('visual-question-styles');
    if (old) old.remove();

    const style = document.createElement('style');
    style.id = 'visual-question-styles';
    style.textContent = `

#q-visual-area {
    margin: 0 0 12px 0;
    width: 100%;
}

/* Görsel resim */
.qv-img-wrap {
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--panel-2);
    max-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
}
.qv-img {
    width: 100%;
    height: auto;
    max-height: 200px;
    object-fit: contain;
    display: block;
}

/* Açıklama badge — URL yokken gösterilir */
.qv-desc-badge {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 13px;
    background: var(--panel-2);
    border: 1px solid var(--line-2);
    border-left: 3px solid #6c6ef5;
    border-radius: 10px;
    font-size: 0.76rem;
    /* Koyu tema */
    color: var(--t-200);
    line-height: 1.45;
    font-style: italic;
}

/* Açık tema için override */
[data-theme="light"] .qv-desc-badge {
    background: var(--panel-2);
    border-color: var(--line-2);
    color: var(--t-200);
}

/* Sistem açık tema */
@media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) .qv-desc-badge {
        background: var(--panel-2);
        border-color: var(--line-2);
        color: var(--t-200);
    }
}

.qv-desc-icon {
    font-size: 0.95rem;
    flex-shrink: 0;
    margin-top: 1px;
    font-style: normal;
}
.qv-desc-text {
    flex: 1;
}

@media (max-width: 640px) {
    .qv-img-wrap { max-height: 150px; }
    .qv-img      { max-height: 150px; }
    .qv-desc-badge { font-size: 0.72rem; padding: 8px 11px; }
}

    `;
    document.head.appendChild(style);

})();

// ============================================================
// GÖRSEL FIRESTORE LOADER — script.js'in SONUNA ekle
// ============================================================
// Admin panelinden yüklenen base64 görselleri Firestore'dan
// çeker ve localStorage'a cache'ler.
// visual.url null → Firestore'a bak → varsa göster
// ============================================================

(function _visualFirestoreLoader() {
    'use strict';

    const CACHE_PREFIX = 'kpss_vis_';
    const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000; // 7 gün

    // ── LocalStorage cache ────────────────────────────────────
    function _cacheGet(questionId) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + questionId);
            if (!raw) return null;
            const { b64, ts } = JSON.parse(raw);
            if (Date.now() - ts > CACHE_TTL) {
                localStorage.removeItem(CACHE_PREFIX + questionId);
                return null;
            }
            return b64;
        } catch(e) { return null; }
    }

    function _cacheSet(questionId, b64) {
        try {
            localStorage.setItem(CACHE_PREFIX + questionId, JSON.stringify({
                b64, ts: Date.now()
            }));
        } catch(e) {
            // localStorage dolu olabilir — sessizce geç
        }
    }

    // ── Firestore'dan çek ─────────────────────────────────────
    async function _fetchFromFirestore(questionId) {
        if (!window._fb) return null;
        try {
            const { db, doc, getDoc } = window._fb;
            const snap = await getDoc(doc(db, 'question_visuals', questionId));
            if (snap.exists()) {
                return snap.data().base64 || null;
            }
        } catch(e) {
            console.warn('[Visual] Firestore okuma hatası:', e);
        }
        return null;
    }

    // ── Görseli çek (cache → Firestore) ──────────────────────
    async function _resolveVisual(questionId) {
        // 1. Cache'e bak
        const cached = _cacheGet(questionId);
        if (cached) return cached;

        // 2. Firebase hazır değilse bekle (max 3sn)
        if (!window._fb) {
            await new Promise(resolve => {
                const t = setTimeout(resolve, 3000);
                window.addEventListener('fb-ready', () => { clearTimeout(t); resolve(); }, { once: true });
            });
        }

        // 3. Firestore'dan çek
        const b64 = await _fetchFromFirestore(questionId);
        if (b64) {
            _cacheSet(questionId, b64);
            return b64;
        }
        return null;
    }

    // ── visual_question_support_v2'deki _injectVisual'ı wrap et ─
    // Görsel alanı inject edildikten sonra async olarak URL güncelle
    const VISUAL_ID = 'q-visual-area';

    // Firestore'dan b64 geldikten sonra görsel alanını güncelle
    // (openQuestion ve showHistoryQuestion her ikisi tarafından kullanılır)
    function _applyB64ToVisualArea(b64, item) {
        if (!b64) return;
        const visualArea = document.getElementById(VISUAL_ID);
        if (!visualArea) return;

        const badge   = visualArea.querySelector('.qv-desc-badge');
        const imgWrap = visualArea.querySelector('.qv-img-wrap');

        if (imgWrap) {
            const img = imgWrap.querySelector('img');
            if (img) img.src = b64;
        } else if (badge) {
            const wrap = document.createElement('div');
            wrap.className = 'qv-img-wrap';
            const img = document.createElement('img');
            img.className = 'qv-img';
            img.src = b64;
            img.alt = item.visual.desc || 'Soru görseli';
            wrap.appendChild(img);
            visualArea.innerHTML = '';
            visualArea.appendChild(wrap);
        } else {
            const wrap = document.createElement('div');
            wrap.className = 'qv-img-wrap';
            const img = document.createElement('img');
            img.className = 'qv-img';
            img.src = b64;
            img.alt = item.visual.desc || 'Soru görseli';
            wrap.appendChild(img);
            visualArea.appendChild(wrap);
        }
    }

    // Görsel çek + uygula — dışarıdan (showHistoryQuestion) da çağrılabilir
    function _loadAndApplyFirestoreVisual(item) {
        if (!item || !item.visual || item.visual.url) return;
        _resolveVisual(item.id).then(b64 => _applyB64ToVisualArea(b64, item));
    }

    // Global erişim: showHistoryQuestion tarafından kullanılır
    window._loadFirestoreVisualFn = _loadAndApplyFirestoreVisual;

    const _origOpenQuestion = window.openQuestion;
    window.openQuestion = function(item, markerObject) {
        _origOpenQuestion.call(this, item, markerObject);
        // Görsel gerektiren soru ve URL boşsa → Firestore'dan çek
        _loadAndApplyFirestoreVisual(item);
    };

    // ── Cache temizleme (ayarlar menüsü için) ────────────────
    window.clearVisualCache = function() {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
        keys.forEach(k => localStorage.removeItem(k));
        console.log('[Visual] Cache temizlendi:', keys.length, 'görsel');
    };

})();
