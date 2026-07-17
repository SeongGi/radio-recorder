/**
 * Radio Recorder - Dashboard JavaScript
 * 대시보드 인터랙션, API 호출, 실시간 업데이트
 */

// =============================================
// 초기화
// =============================================
let stations = {};
let schedules = [];
let statusInterval = null;
let editingScheduleId = null;
let selectedFiles = new Set();

// 라이브 플레이어 상태
let liveCurrentStation = null;
let liveIsPlaying = false;
let stationIdsOrdered = [];
let hlsInstance = null;
let liveRetryCount = 0; // 스트림 실패 재시도 횟수
const MAX_LIVE_RETRIES = 3; // 최대 재시도 횟수

document.addEventListener('DOMContentLoaded', () => {
    updateThemeControl();
    initTabs();
    loadStations().then(() => {
        renderLiveStations();
    });
    loadSchedules();
    loadFeedUrls();
    startStatusPolling();
    initPWA();
    registerServiceWorker();
    loadAdDetectionStatus();
    loadNasConfig();
    loadDriveConfig();
});

function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('radio-theme', next);
    updateThemeControl();
}

function updateThemeControl() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const button = document.getElementById('theme-toggle');
    if (button) {
        button.textContent = dark ? '☀️' : '🌙';
        button.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
    }
}

// =============================================
// PWA 초기화
// =============================================
let deferredInstallPrompt = null;

function initPWA() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        const card = document.getElementById('pwa-install-card');
        if (card) card.style.display = 'block';

        const btn = document.getElementById('pwa-install-btn');
        if (btn) {
            btn.addEventListener('click', async () => {
                if (!deferredInstallPrompt) return;
                deferredInstallPrompt.prompt();
                const result = await deferredInstallPrompt.userChoice;
                if (result.outcome === 'accepted') {
                    card.style.display = 'none';
                    showToast('앱이 설치되었습니다! 📱', 'success');
                }
                deferredInstallPrompt = null;
            });
        }
    });

    // PWA 앱으로 실행 중일 때 뒤로가기 버튼 → 앱 종료
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;

    if (isStandalone) {
        // 히스토리 스택에 현재 페이지 추가 (뒤로가기 시 popstate 발생)
        history.pushState({ page: 'main' }, '', window.location.href);

        window.addEventListener('popstate', (e) => {
            // 뒤로가기가 눌리면 앱 종료 확인 후 창 닫기
            if (confirm('앱을 종료하시겠습니까?')) {
                window.close();
                // window.close()가 막힌 경우 대비: 빈 히스토리로 이동
                window.location.href = 'about:blank';
            } else {
                // 취소 시 히스토리 스택 다시 추가
                history.pushState({ page: 'main' }, '', window.location.href);
            }
        });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
            .then(() => console.log('Service Worker 등록 완료'))
            .catch(e => console.warn('Service Worker 등록 실패:', e));
    }
}

// =============================================
// 탭 네비게이션
// =============================================
function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');

            // 탭 전환 시 데이터 새로고침
            if (tab.dataset.tab === 'files') loadFiles();
            if (tab.dataset.tab === 'schedules') loadSchedules();
            if (tab.dataset.tab === 'calendar') loadCalendar();
            if (tab.dataset.tab === 'stats') loadStats();
        });
    });
}

// =============================================
// API 호출 헬퍼
// =============================================
async function api(url, options = {}) {
    try {
        const resp = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
        });

        if (resp.status === 401) {
            window.location.href = '/auth/login';
            return null;
        }

        const data = await resp.json();
        if (!resp.ok) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return data;
    } catch (e) {
        console.error(`API 오류: ${url}`, e);
        throw e;
    }
}

// =============================================
// 라이브 청취
// =============================================
function renderLiveStations() {
    const container = document.getElementById('live-station-grid');
    if (!container) return;

    const networks = {};
    for (const [id, s] of Object.entries(stations)) {
        const net = s.network || 'OTHER';
        if (!networks[net]) networks[net] = [];
        networks[net].push({ ...s, id });
    }

    let html = '';
    stationIdsOrdered = [];

    for (const [net, list] of Object.entries(networks)) {
        const netClass = net.toLowerCase();
        for (const s of list) {
            stationIdsOrdered.push(s.id);
            html += `
                <div class="live-station-card" id="live-card-${s.id}" onclick="playLive('${s.id}', '${s.name.replace(/'/g, "\\'")}', '${netClass}')">
                    <div class="live-icon ${netClass}">${net[0]}</div>
                    <div class="live-info">
                        <div class="live-name">${s.name}</div>
                        <div class="live-sub">${net}</div>
                    </div>
                    <div class="live-action" id="live-action-${s.id}">▶</div>
                </div>
            `;
        }
    }

    container.innerHTML = html;
    console.log('[Player] Rendered stations. Order:', JSON.stringify(stationIdsOrdered));
}

// 방송 전환 중 플래그 (에러/pause 이벤트 간섭 방지)
let _switchingStation = false;
// HLS 일시정지 후 재개용 URL
let _lastHlsUrl = null;

async function playLive(stationId, stationName, netClass) {
    const audio = document.getElementById('live-audio');

    // 같은 방송국 클릭 → 토글
    if (liveCurrentStation === stationId && !_switchingStation) {
        toggleLivePlay();
        return;
    }

    // 전환 시작
    _switchingStation = true;
    liveRetryCount = 0; // 새 방송국 시작 시 재시도 횟수 초기화
    console.log('[Player] playLive:', stationId, stationName);

    try {
        showToast(`${stationName} 연결 중...`, 'info');

        // 이전 HLS 인스턴스 완전 정리
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
            hlsInstance = null;
        }
        audio.pause();
        audio.removeAttribute('src');
        audio.load();

        // 상태 즉시 업데이트
        liveCurrentStation = stationId;
        _lastHlsUrl = null;

        // 모든 카드 초기화
        document.querySelectorAll('.live-station-card').forEach(c => c.classList.remove('playing'));
        document.querySelectorAll('[id^="live-action-"]').forEach(a => a.textContent = '▶');

        // 현재 카드 활성화
        const card = document.getElementById(`live-card-${stationId}`);
        if (card) card.classList.add('playing');

        // 플레이어 바 표시
        showPlayerBar(stationName);
        document.title = `▶ ${stationName} - Radio Recorder`;

        // 스트림 URL 가져오기 (비동기)
        const data = await api(`/api/stream-url/${stationId}`);

        // 비동기 사이에 다른 전환이 발생했으면 중단
        if (liveCurrentStation !== stationId) {
            console.log('[Player] Station changed during fetch, aborting');
            return;
        }

        const streamUrl = data.url;
        console.log('[Player] Got stream URL:', streamUrl.substring(0, 80));

        if (Hls.isSupported() && streamUrl.includes('.m3u8')) {
            // HLS 스트림
            _lastHlsUrl = streamUrl;
            hlsInstance = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 60,
            });
            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(audio);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                if (liveCurrentStation !== stationId) return;
                audio.play().catch(e => console.error('[Player] HLS play error:', e));
            });
            hlsInstance.on(Hls.Events.ERROR, (event, errData) => {
                if (errData.fatal) {
                    console.error('[Player] HLS fatal:', errData.type, errData.details);
                    
                    if (liveRetryCount < MAX_LIVE_RETRIES) {
                        liveRetryCount++;
                        console.log(`[Player] Retrying... (${liveRetryCount}/${MAX_LIVE_RETRIES})`);
                        
                        if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            try { hlsInstance.recoverMediaError(); } catch (e) { /* ignore */ }
                        } else if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            setTimeout(() => { if (hlsInstance) hlsInstance.startLoad(); }, 2000);
                        }
                    } else {
                        console.warn('[Player] Max retries reached. Skipping to next station.');
                        showToast(`연결 실패: ${stationName}. 다음 방송으로 넘어갑니다.`, 'warning');
                        setTimeout(() => playNextStation(), 1000);
                    }
                }
            });
        } else {
            // MP3 직접 스트림
            audio.src = streamUrl;
            audio.load();
            audio.play().catch(e => {
                console.error('[Player] Direct play error:', e);
                handleStreamError(stationId, stationName);
            });
        }

        // 성공 UI
        liveIsPlaying = true;
        const actionBtn = document.getElementById(`live-action-${stationId}`);
        if (actionBtn) actionBtn.textContent = '⏸';
        updatePlayerUI(true);

        const s = stations[stationId];
        updateMediaMetadata(stationName, s ? s.network : 'Radio');
        showToast(`🎵 ${stationName} 재생 중`, 'success');

    } catch (e) {
        console.error('[Player] playLive error:', e);
        handleStreamError(stationId, stationName);
    } finally {
        _switchingStation = false;
    }
}

// 스트림 에러 통합 처리 및 다음 방송 전환
function handleStreamError(stationId, stationName) {
    console.warn(`[Player] Handling error for ${stationName} (Retry: ${liveRetryCount}/${MAX_LIVE_RETRIES})`);
    
    if (liveRetryCount < MAX_LIVE_RETRIES) {
        liveRetryCount++;
        showToast(`${stationName} 연결 시도 중... (${liveRetryCount}/${MAX_LIVE_RETRIES})`, 'info');
        
        // 잠시 후 다시 시도
        setTimeout(() => {
            if (liveCurrentStation === stationId) {
                const s = stations[stationId];
                if (s) {
                    playLive(stationId, stationName, (s.network || 'OTHER').toLowerCase());
                }
            }
        }, 3000);
    } else {
        console.error(`[Player] ${stationName} failed after max retries. Skipping.`);
        showToast(`${stationName} 연결 실패. 다음 방송으로 넘어갑니다.`, 'warning');
        
        setTimeout(() => {
            if (liveCurrentStation === stationId) {
                playNextStation();
            }
        }, 2000);
    }
}

function toggleLivePlay() {
    const audio = document.getElementById('live-audio');
    if (!liveCurrentStation) return;

    console.log('[Player] toggleLivePlay, paused:', audio.paused, 'hls:', !!hlsInstance);

    if (!audio.paused) {
        // ===== 일시정지 =====
        if (hlsInstance) {
            // HLS: 반드시 detach 해야 진짜 멈춤 (stopLoad만으로는 부족)
            hlsInstance.stopLoad();
            hlsInstance.detachMedia();
        }
        audio.pause();
        liveIsPlaying = false;
        updatePlayerUI(false);
        if (liveCurrentStation) {
            const btn = document.getElementById(`live-action-${liveCurrentStation}`);
            if (btn) btn.textContent = '▶';
        }
        console.log('[Player] Paused OK');
    } else {
        // ===== 재생 재개 =====
        if (hlsInstance && _lastHlsUrl) {
            hlsInstance.attachMedia(audio);
            hlsInstance.startLoad();
        }
        audio.play().catch(e => console.error('[Player] Resume error:', e));
        liveIsPlaying = true;
        updatePlayerUI(true);
        if (liveCurrentStation) {
            const btn = document.getElementById(`live-action-${liveCurrentStation}`);
            if (btn) btn.textContent = '⏸';
        }
        console.log('[Player] Resumed OK');
    }
}

function stopLive() {
    if (_switchingStation) {
        console.log('[Player] stopLive blocked (switching)');
        return;
    }

    const audio = document.getElementById('live-audio');
    if (hlsInstance) {
        try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
        hlsInstance = null;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    liveIsPlaying = false;
    liveCurrentStation = null;
    _lastHlsUrl = null;

    document.querySelectorAll('.live-station-card').forEach(c => c.classList.remove('playing'));
    document.querySelectorAll('[id^="live-action-"]').forEach(a => a.textContent = '▶');

    hidePlayerBar();
    document.title = 'Radio Recorder - 대시보드';
}

function showPlayerBar(stationName) {
    const bar = document.getElementById('live-player-bar');
    document.getElementById('live-station-name').textContent = stationName;
    bar.classList.add('visible');
    document.querySelector('.content').classList.add('player-visible');
    updatePlayerUI(true);
}

function hidePlayerBar() {
    document.getElementById('live-player-bar').classList.remove('visible');
    document.querySelector('.content').classList.remove('player-visible');
    updatePlayerUI(false);
}

function updatePlayerUI(playing) {
    const icon = document.getElementById('live-play-icon');
    const wave = document.getElementById('live-wave');

    if (playing) {
        icon.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
        wave.classList.add('playing');
    } else {
        icon.setAttribute('d', 'M8 5v14l11-7z');
        wave.classList.remove('playing');
    }
}

// =============================================
// 미디어 세션 및 제어 (모바일 최적화)
// =============================================
function updateMediaMetadata(stationName, network) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: stationName,
            artist: network,
            album: 'Radio Recorder Live',
            artwork: [
                { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
            ]
        });
        setupMediaSessionHandlers();
    }
    document.title = `${stationName} - Radio Recorder`;
}

function setupMediaSessionHandlers() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => toggleLivePlay());
        navigator.mediaSession.setActionHandler('pause', () => toggleLivePlay());
        navigator.mediaSession.setActionHandler('stop', () => stopLive());
        try {
            navigator.mediaSession.setActionHandler('nexttrack', () => playNextStation());
            navigator.mediaSession.setActionHandler('previoustrack', () => playPrevStation());
        } catch (e) {
            console.warn('MediaSession action handlers not fully supported');
        }
    }
}

function playNextStation() {
    const ids = stationIdsOrdered.length > 0 ? stationIdsOrdered : Object.keys(stations);
    console.log('[Player] playNextStation - count:', ids.length, 'current:', liveCurrentStation);

    if (ids.length === 0) return;

    let nextIndex = 0;
    if (liveCurrentStation) {
        const currentIndex = ids.indexOf(liveCurrentStation);
        console.log('[Player] currentIndex:', currentIndex);
        if (currentIndex !== -1) {
            nextIndex = (currentIndex + 1) % ids.length;
        }
    }

    const nextId = ids[nextIndex];
    const s = stations[nextId];
    console.log('[Player] -> next:', nextId, s ? s.name : '???');

    if (s) {
        playLive(nextId, s.name, (s.network || 'OTHER').toLowerCase());
    }
}

function playPrevStation() {
    const ids = stationIdsOrdered.length > 0 ? stationIdsOrdered : Object.keys(stations);
    if (ids.length === 0) return;

    let prevIndex = ids.length - 1;
    if (liveCurrentStation) {
        const currentIndex = ids.indexOf(liveCurrentStation);
        if (currentIndex !== -1) {
            prevIndex = (currentIndex - 1 + ids.length) % ids.length;
        }
    }

    const prevId = ids[prevIndex];
    const s = stations[prevId];
    if (s) {
        playLive(prevId, s.name, (s.network || 'OTHER').toLowerCase());
    }
}

// audio 이벤트 (UI 동기화)
document.addEventListener('DOMContentLoaded', () => {
    const audio = document.getElementById('live-audio');
    if (!audio) return;

    audio.addEventListener('playing', () => {
        console.log('[Audio] playing event');
        liveIsPlaying = true;
        updatePlayerUI(true);
        if (liveCurrentStation) {
            const btn = document.getElementById(`live-action-${liveCurrentStation}`);
            if (btn) btn.textContent = '⏸';
        }
    });

    audio.addEventListener('pause', () => {
        console.log('[Audio] pause event, switching:', _switchingStation);
        if (_switchingStation) return; // 전환 중 무시
        liveIsPlaying = false;
        updatePlayerUI(false);
        if (liveCurrentStation) {
            const btn = document.getElementById(`live-action-${liveCurrentStation}`);
            if (btn) btn.textContent = '▶';
        }
    });

    audio.addEventListener('error', (e) => {
        console.error('[Audio] error event:', e);
        if (_switchingStation) return; // 전환 중 무시
        if (liveCurrentStation) {
            showToast('스트림 연결이 끊어졌습니다.', 'error');
            stopLive();
        }
    });
});

// =============================================
// 방송국
// =============================================
async function loadStations() {
    try {
        stations = await api('/api/stations');
        renderStations();
        populateStationSelects();
    } catch (e) {
        showToast('방송국 목록 로드 실패', 'error');
    }
}

function renderStations() {
    const container = document.getElementById('stations-container');
    const networks = {};

    for (const [id, s] of Object.entries(stations)) {
        const net = s.network || 'OTHER';
        if (!networks[net]) networks[net] = [];
        networks[net].push({ ...s, id });
    }

    let html = '';
    for (const [net, list] of Object.entries(networks)) {
        const netClass = net.toLowerCase();
        html += `<h3 class="${netClass}">${net}</h3>`;
        html += '<div class="station-grid">';
        for (const s of list) {
            html += `
                <div class="station-card" onclick="quickRecordStation('${s.id}')" title="클릭하여 즉시 녹음">
                    <div class="station-dot ${netClass}">${net[0]}</div>
                    <div class="station-info">
                        <div class="station-name">${s.name}</div>
                        <div class="station-meta">${s.id}</div>
                    </div>
                    <div class="station-status" id="status-${s.id}"></div>
                </div>
            `;
        }
        html += '</div>';
    }

    container.innerHTML = html;
}

function populateStationSelects() {
    const selects = ['quick-station', 'sched-station'];
    for (const selectId of selects) {
        const select = document.getElementById(selectId);
        if (!select) continue;

        // 기존 옵션 유지 (첫 번째 placeholder)
        const placeholder = select.options[0];
        select.innerHTML = '';
        select.appendChild(placeholder);

        // 네트워크별 그룹
        const networks = {};
        for (const [id, s] of Object.entries(stations)) {
            const net = s.network || 'OTHER';
            if (!networks[net]) networks[net] = [];
            networks[net].push({ ...s, id });
        }

        for (const [net, list] of Object.entries(networks)) {
            const group = document.createElement('optgroup');
            group.label = net;
            for (const s of list) {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                group.appendChild(opt);
            }
            select.appendChild(group);
        }
    }
}

function quickRecordStation(stationId) {
    // 녹음 탭으로 이동
    document.querySelector('.tab[data-tab="recording"]').click();
    document.getElementById('quick-station').value = stationId;
}

// =============================================
// 스트림 테스트
// =============================================
async function testAllStreams() {
    showToast('스트림 테스트 중...', 'info');

    // 모든 스테이션 상태를 testing으로
    for (const id of Object.keys(stations)) {
        const el = document.getElementById(`status-${id}`);
        if (el) {
            el.className = 'station-status testing';
            el.title = '테스트 중...';
        }
    }



    try {
        const results = await api('/api/streams/test');

        for (const [id, result] of Object.entries(results)) {
            const el = document.getElementById(`status-${id}`);
            if (el) {
                el.className = `station-status ${result.success ? 'online' : 'offline'}`;
                el.title = result.success
                    ? `✅ ${result.source}`
                    : `❌ ${result.error}`;
            }
        }

        const ok = Object.values(results).filter(r => r.success).length;
        const total = Object.keys(results).length;
        showToast(`스트림 테스트 완료: ${ok}/${total} 연결 성공`, ok === total ? 'success' : 'error');
    } catch (e) {
        showToast('스트림 테스트 실패', 'error');
    }
}

// =============================================
// 예약 관리
// =============================================
async function loadSchedules() {
    try {
        schedules = await api('/api/schedules');
        renderSchedules();
    } catch (e) {
        console.error('예약 로드 실패:', e);
    }
}

function renderSchedules() {
    const container = document.getElementById('schedule-list');

    if (!schedules.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📅</div>
                <p>등록된 예약이 없습니다</p>
                <button class="btn btn-primary" onclick="showAddScheduleModal()" style="margin-top:16px;">
                    ➕ 첫 예약 추가하기
                </button>
            </div>
        `;
        return;
    }

    const DAY_LABELS = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };

    container.innerHTML = schedules.map(s => {
        const days = (s.days || []).map(d => `<span class="day-badge">${DAY_LABELS[d] || d}</span>`).join('');
        const disabled = !s.enabled ? 'disabled' : '';

        return `
            <div class="schedule-item ${disabled}">
                <div class="schedule-time">${s.start_time || ''}</div>
                <div class="schedule-info">
                    <div class="schedule-label">${s.label || s.station_name}</div>
                    <div class="schedule-details">${s.station_name} · ${s.duration_minutes}분</div>
                    <div class="schedule-days">${days}</div>
                </div>
                <div class="schedule-actions">
                    <button class="btn-icon" onclick="showEditScheduleModal('${s.id}')" title="수정">✏️</button>
                    <button class="btn-icon" onclick="toggleSchedule('${s.id}')" title="${s.enabled ? '비활성화' : '활성화'}">
                        ${s.enabled ? '⏸️' : '▶️'}
                    </button>
                    <button class="btn-icon" onclick="deleteSchedule('${s.id}')" title="삭제">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

function showAddScheduleModal() {
    editingScheduleId = null;
    document.getElementById('modal-title').textContent = '새 예약 추가';
    document.getElementById('sched-station').value = '';
    document.getElementById('sched-label').value = '';
    document.getElementById('sched-time').value = '07:00';
    document.getElementById('sched-duration').value = '120';
    document.getElementById('sched-retention').value = '7'; // 기본값 1주일
    document.getElementById('sched-storage').value = 'LOCAL';
    document.querySelectorAll('.day-selector input').forEach(cb => cb.checked = false);
    document.getElementById('modal-overlay').classList.add('visible');
}

function showEditScheduleModal(id) {
    const sched = schedules.find(s => s.id === id);
    if (!sched) return;

    editingScheduleId = id;
    document.getElementById('modal-title').textContent = '예약 수정';
    document.getElementById('sched-station').value = sched.station_id || '';
    document.getElementById('sched-label').value = sched.label || '';
    document.getElementById('sched-time').value = sched.start_time || '07:00';
    document.getElementById('sched-duration').value = sched.duration_minutes || 120;
    document.getElementById('sched-retention').value = sched.retention_days || 0;
    document.getElementById('sched-storage').value = sched.storage_type || 'LOCAL';

    document.querySelectorAll('.day-selector input').forEach(cb => {
        cb.checked = (sched.days || []).includes(cb.value);
    });

    document.getElementById('modal-overlay').classList.add('visible');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('visible');
    editingScheduleId = null;
}

async function saveSchedule() {
    const stationId = document.getElementById('sched-station').value;
    const label = document.getElementById('sched-label').value;
    const startTime = document.getElementById('sched-time').value;
    const duration = document.getElementById('sched-duration').value;
    const retention = document.getElementById('sched-retention').value;
    const storage = document.getElementById('sched-storage').value;

    const days = [];
    document.querySelectorAll('.day-selector input:checked').forEach(cb => {
        days.push(cb.value);
    });

    if (!stationId) {
        showToast('방송국을 선택하세요', 'error');
        return;
    }

    if (!days.length) {
        showToast('요일을 선택하세요', 'error');
        return;
    }

    const payload = {
        station_id: stationId,
        days,
        start_time: startTime,
        duration_minutes: parseInt(duration),
        label,
        retention_days: parseInt(retention),
        storage_type: storage,
    };

    try {
        if (editingScheduleId) {
            await api(`/api/schedules/${editingScheduleId}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            showToast('예약이 수정되었습니다', 'success');
        } else {
            await api('/api/schedules', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            showToast('예약이 추가되었습니다', 'success');
        }

        closeModal();
        loadSchedules();
    } catch (e) {
        showToast(`예약 저장 실패: ${e.message}`, 'error');
    }
}

async function toggleSchedule(id) {
    try {
        await api(`/api/schedules/${id}/toggle`, { method: 'POST' });
        loadSchedules();
    } catch (e) {
        showToast('상태 변경 실패', 'error');
    }
}

async function deleteSchedule(id) {
    if (!confirm('이 예약을 삭제하시겠습니까?')) return;

    try {
        await api(`/api/schedules/${id}`, { method: 'DELETE' });
        loadSchedules();
        showToast('예약이 삭제되었습니다', 'success');
    } catch (e) {
        showToast('삭제 실패', 'error');
    }
}

// =============================================
// 녹음
// =============================================
async function startQuickRecording() {
    const stationId = document.getElementById('quick-station').value;
    const duration = document.getElementById('quick-duration').value;

    if (!stationId) {
        showToast('방송국을 선택하세요', 'error');
        return;
    }

    try {
        await api('/api/record/start', {
            method: 'POST',
            body: JSON.stringify({
                station_id: stationId,
                duration_minutes: parseInt(duration),
            }),
        });
        showToast('녹음이 시작되었습니다 🔴', 'success');
        refreshActiveRecordings();
    } catch (e) {
        showToast(`녹음 시작 실패: ${e.message}`, 'error');
    }
}

async function stopRecording(jobId) {
    try {
        await api(`/api/record/stop/${jobId}`, { method: 'POST' });
        showToast('녹음이 중지되었습니다', 'info');
        refreshActiveRecordings();
    } catch (e) {
        showToast('중지 실패', 'error');
    }
}

async function refreshActiveRecordings() {
    try {
        const jobs = await api('/api/record/status');
        renderActiveRecordings(jobs);
    } catch (e) {
        console.error('녹음 상태 조회 실패:', e);
    }
}

function renderActiveRecordings(jobs) {
    const container = document.getElementById('active-recordings');

    if (!jobs || !jobs.length) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 40px;">
                <div class="empty-icon">🎧</div>
                <p>진행 중인 녹음이 없습니다</p>
            </div>
        `;
        return;
    }

    container.innerHTML = jobs.map(j => {
        const progress = j.progress_percent || 0;
        const elapsed = formatDuration(j.elapsed_seconds || 0);
        const total = formatDuration(j.duration_seconds || 0);

        return `
            <div class="recording-card" style="--progress: ${progress}%">
                <div class="rec-indicator"></div>
                <div class="rec-info">
                    <div class="rec-name">${j.station_name}</div>
                    <div class="rec-time">${elapsed} / ${total} · ${j.file_size_mb || 0}MB</div>
                </div>
                <div class="rec-progress">
                    <div class="rec-progress-bar" style="width: ${progress}%"></div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="stopRecording('${j.job_id}')">⏹️ 중지</button>
            </div>
        `;
    }).join('');
}

function startStatusPolling() {
    refreshActiveRecordings();
    statusInterval = setInterval(refreshActiveRecordings, 5000);
}

// =============================================
// 파일 관리
// =============================================
let allFiles = [];
let filteredFiles = [];

async function loadFiles(forceSync = false) {
    try {
        const url = forceSync ? '/api/files?sync=true' : '/api/files';
        allFiles = await api(url);
        filteredFiles = allFiles;
        selectedFiles.clear();
        filterFiles();
        updateBulkBar();

        // 전송 중인 파일이 있으면 3초 후 자동 새로고침
        const hasTransferring = allFiles.some(f => f.status === 'TRANSFERRING');
        if (hasTransferring) {
            if (window.filesPollTimeout) clearTimeout(window.filesPollTimeout);
            window.filesPollTimeout = setTimeout(loadFiles, 3000);
        }
    } catch (e) {
        showToast('파일 목록 로드 실패', 'error');
    }
}

function renderFiles(files) {
    const container = document.getElementById('file-list');

    if (!files || !files.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📁</div>
                <p>녹음된 파일이 없습니다</p>
            </div>
        `;
        return;
    }

    // 날짜별 그룹핑
    const groups = {};
    for (const f of files) {
        const date = f.created ? f.created.substring(0, 10) : 'unknown';
        if (!groups[date]) groups[date] = [];
        groups[date].push(f);
    }

    const sortedDates = Object.keys(groups).sort().reverse();
    let totalSize = files.reduce((sum, f) => sum + (f.size_bytes || f.size || 0), 0);

    let html = `<div class="file-summary">${files.length}개 파일 · ${(totalSize / 1024 / 1024).toFixed(1)}MB</div>`;

    for (const date of sortedDates) {
        const dateFiles = groups[date];
        const dateSize = dateFiles.reduce((sum, f) => sum + (f.size_bytes || f.size || 0), 0);

        html += `
            <div class="file-group">
                <div class="file-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
                    <span class="file-group-arrow">▼</span>
                    <span class="file-group-date">${date}</span>
                    <span class="file-group-meta">${dateFiles.length}개 · ${(dateSize / 1024 / 1024).toFixed(1)}MB</span>
                </div>
                <div class="file-group-body">
        `;

        for (const f of dateFiles) {
            const checked = selectedFiles.has(f.relative_path) ? 'checked' : '';
            const isClean = f.filename.includes('_clean');
            const isRecording = Boolean(f.is_recording);
            const encodedPath = encodeURIComponent(f.relative_path);
            const downloadPath = f.relative_path.split('/').map(encodeURIComponent).join('/');
            html += `
                <div class="file-item ${isClean ? 'clean-file' : ''}">
                    <label class="checkbox-wrap">
                        <input type="checkbox" ${checked} ${isRecording ? 'disabled' : ''} onchange="toggleFileSelect(decodeURIComponent('${encodedPath}'))">
                    </label>
                    <div class="file-icon">${isClean ? '✨' : '🎵'}</div>
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(f.filename)}</div>
                        <div class="file-meta">${f.size_mb}MB · ${formatDate(f.created)}</div>
                        <div style="margin-top: 8px;">
                            ${f.status === 'NAS' ? '<span class="status-badge" style="background:#4ade8020; color:#4ade80; padding:2px 8px; border-radius:12px; font-size:11px;">NAS</span>' : ''}
                            ${f.status === 'DRIVE' ? '<span class="status-badge" style="background:#facc1520; color:#facc15; padding:2px 8px; border-radius:12px; font-size:11px;">DRIVE</span>' : ''}
                            ${f.status === 'TRANSFERRING' ? '<span class="status-badge transferring-badge" style="background:#8b5cf620; color:#c084fc; padding:2px 8px; border-radius:12px; font-size:11px; animation: blink 1.5s infinite;">⏳ 전송 중...</span>' : ''}
                            ${isRecording ? '<span class="status-badge transferring-badge" style="background:#ef444420; color:#f87171; padding:2px 8px; border-radius:12px; font-size:11px;">🔴 녹음 중</span>' : ''}
                            <button class="btn btn-primary btn-sm" onclick="window.open('/play/${f.id}', 'Player', 'width=500,height=600')" style="margin-left:8px;" ${f.status === 'TRANSFERRING' ? 'disabled style="opacity:0.5; pointer-events:none;"' : ''}>
                                ▶ 재생하기
                            </button>
                        </div>
                    </div>
                    <div class="file-actions">
                        ${f.status === 'TRANSFERRING' || isRecording ? '<span style="font-size:12px; color:var(--text-muted);">삭제 제외</span>' : `
                        <a href="/recordings/${downloadPath}" download class="btn btn-ghost btn-sm" title="다운로드">⬇️</a>
                        <button class="btn btn-ghost btn-sm" onclick="deleteFile(decodeURIComponent('${encodedPath}'))" title="삭제">🗑️</button>
                        `}
                    </div>
                </div>
            `;
        }

        html += '</div></div>';
    }

    container.innerHTML = html;
}

function escapeHtml(value) {
    const el = document.createElement('div');
    el.textContent = String(value ?? '');
    return el.innerHTML;
}

function filterFiles() {
    const input = document.getElementById('file-search');
    const query = (input?.value || '').trim().toLocaleLowerCase();
    filteredFiles = query ? allFiles.filter(f => {
        const haystack = [f.filename, f.created, f.status, f.relative_path]
            .filter(Boolean).join(' ').toLocaleLowerCase();
        return haystack.includes(query);
    }) : allFiles;
    renderFiles(filteredFiles);
    const result = document.getElementById('file-search-result');
    if (result) result.textContent = query ? `${filteredFiles.length}개 검색됨` : `전체 ${allFiles.length}개`;
    updateBulkBar();
}

function selectSearchResults() {
    if (!filteredFiles.length) { showToast('검색 결과가 없습니다', 'error'); return; }
    filteredFiles.filter(f => !f.is_recording).forEach(f => selectedFiles.add(f.relative_path));
    renderFiles(filteredFiles);
    updateBulkBar();
}

async function deleteSearchResults() {
    if (!filteredFiles.length) { showToast('삭제할 검색 결과가 없습니다', 'error'); return; }
    const query = (document.getElementById('file-search')?.value || '').trim();
    if (!query) { showToast('먼저 삭제할 파일을 검색하세요', 'error'); return; }
    const paths = filteredFiles.filter(f => !f.is_recording).map(f => f.relative_path);
    if (!paths.length) { showToast('검색 결과가 모두 녹음 중인 파일입니다', 'error'); return; }
    if (!confirm(`검색어 "${query}"에 해당하는 ${paths.length}개 파일을 모두 삭제하시겠습니까?`)) return;
    await deletePaths(paths);
}

async function deletePaths(paths) {
    try {
        const data = await api('/api/files', {
            method: 'DELETE',
            body: JSON.stringify({ paths }),
        });
        const type = data.errors?.length ? 'error' : 'success';
        showToast(`${data.deleted.length}개 삭제 완료${data.errors?.length ? ` · ${data.errors.length}개 실패` : ''}`, type);
        await loadFiles();
    } catch (e) {
        showToast(`삭제 실패: ${e.message}`, 'error');
    }
}

function toggleFileSelect(path) {
    if (selectedFiles.has(path)) {
        selectedFiles.delete(path);
    } else {
        selectedFiles.add(path);
    }
    updateBulkBar();
}

function toggleSelectAll() {
    const allChecked = document.getElementById('select-all-files').checked;
    if (allChecked) {
        filteredFiles.filter(f => !f.is_recording).forEach(f => selectedFiles.add(f.relative_path));
    } else {
        selectedFiles.clear();
    }
    renderFiles(filteredFiles);
    updateBulkBar();
}

function updateBulkBar() {
    const count = selectedFiles.size;
    document.getElementById('selected-count').textContent = `${count}개 선택`;
    const bar = document.getElementById('bulk-action-bar');
    if (bar) bar.classList.toggle('has-selection', count > 0);
}

async function deleteFile(path) {
    if (!confirm(`이 파일을 삭제하시겠습니까?\n${path}`)) return;
    try {
        const data = await api('/api/files', {
            method: 'DELETE',
            body: JSON.stringify({ paths: [path] }),
        });
        showToast(`${data.deleted.length}개 삭제 완료`, 'success');
        loadFiles();
    } catch (e) {
        showToast('삭제 실패', 'error');
    }
}

async function deleteSelectedFiles() {
    if (!selectedFiles.size) { showToast('파일을 선택하세요', 'error'); return; }
    if (!confirm(`${selectedFiles.size}개 파일을 삭제하시겠습니까?`)) return;
    await deletePaths([...selectedFiles]);
}

// =============================================
// NAS 연동
// =============================================
async function loadNasConfig() {
    try {
        const data = await api('/api/storage/nas');
        document.getElementById('nas-server').value = data.server || '';
        document.getElementById('nas-share').value = data.share || '';
        document.getElementById('nas-username').value = data.username || '';
        document.getElementById('nas-password').value = data.password === '***' ? '' : '';
        document.getElementById('nas-password').placeholder = data.password === '***' ? '(설정됨)' : 'password';
        document.getElementById('nas-remote-dir').value = data.remote_dir || '/';
    } catch (e) {
        console.error('NAS 설정 로드 실패:', e);
    }
}

async function saveNasConfig() {
    const data = {
        server: document.getElementById('nas-server').value,
        share: document.getElementById('nas-share').value,
        username: document.getElementById('nas-username').value,
        password: document.getElementById('nas-password').value || '***',
        remote_dir: document.getElementById('nas-remote-dir').value || '/',
    };
    try {
        await api('/api/storage/nas', { method: 'POST', body: JSON.stringify(data) });
        showToast('NAS 설정이 저장되었습니다', 'success');
    } catch (e) {
        showToast('NAS 설정 저장 실패', 'error');
    }
}

async function testNasConnection() {
    showToast('NAS 연결 테스트 중...', 'info');
    try {
        const data = await api('/api/storage/nas/test', { method: 'POST' });
        if (data.success) {
            showToast('✅ NAS 연결 성공!', 'success');
        } else {
            showToast(`❌ NAS 연결 실패: ${data.error}`, 'error');
        }
    } catch (e) {
        showToast('NAS 연결 테스트 실패', 'error');
    }
}

async function copySelectedToNas() {
    if (!selectedFiles.size) { showToast('파일을 선택하세요', 'error'); return; }
    showToast(`${selectedFiles.size}개 파일 NAS 복사 요청 중...`, 'info');
    try {
        const data = await api('/api/storage/nas/transfer', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], action: 'copy' }),
        });
        showToast(data.message || 'NAS 복사가 백그라운드에서 시작되었습니다.', 'success');
        loadFiles();
    } catch (e) {
        showToast(`NAS 전송 실패: ${e.message}`, 'error');
    }
}

async function moveSelectedToNas() {
    if (!selectedFiles.size) { showToast('파일을 선택하세요', 'error'); return; }
    if (!confirm(`${selectedFiles.size}개 파일을 NAS로 이동합니다.\n원본은 삭제됩니다. 계속?`)) return;
    showToast(`${selectedFiles.size}개 파일 NAS 이동 요청 중...`, 'info');
    try {
        const data = await api('/api/storage/nas/transfer', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], action: 'move' }),
        });
        showToast(data.message || 'NAS 이동이 백그라운드에서 시작되었습니다.', 'success');
        loadFiles();
    } catch (e) {
        showToast(`NAS 전송 실패: ${e.message}`, 'error');
    }
}

// =============================================
// Google Drive 연동
// =============================================
async function uploadSelectedToDrive() {
    if (!selectedFiles.size) { showToast('파일을 선택하세요', 'error'); return; }
    showToast(`${selectedFiles.size}개 파일 Google Drive 업로드 요청 중...`, 'info');
    try {
        const folderName = document.getElementById('drive-folder') ? document.getElementById('drive-folder').value : 'Radio Recordings';
        const data = await api('/api/storage/drive/upload', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], folder: folderName }),
        });
        showToast(data.message || 'Drive 업로드가 백그라운드에서 시작되었습니다.', 'success');
        loadFiles();
    } catch (e) {
        showToast(`Drive 업로드 실패: ${e.message}`, 'error');
    }
}

async function loadDriveConfig() {
    try {
        const data = await api('/api/storage/drive');
        if (document.getElementById('drive-folder')) {
            document.getElementById('drive-folder').value = data.folder || 'Radio Recordings';
        }
    } catch (e) {
        console.error('Drive 설정 로드 실패:', e);
    }
}

async function saveDriveConfig() {
    const data = {
        folder: document.getElementById('drive-folder').value || 'Radio Recordings',
    };
    try {
        await api('/api/storage/drive', { method: 'POST', body: JSON.stringify(data) });
        showToast('Drive 설정이 저장되었습니다', 'success');
    } catch (e) {
        showToast('Drive 설정 저장 실패', 'error');
    }
}

// =============================================
// RSS 피드 URL
// =============================================
async function loadFeedUrls() {
    try {
        const data = await api('/api/feed-urls');
        document.getElementById('rss-all-url').value = data.all;

        const container = document.getElementById('rss-station-urls');
        let html = '';
        for (const [id, url] of Object.entries(data.stations || {})) {
            const name = stations[id]?.name || id;
            html += `
                <div class="setting-row">
                    <label>${name}</label>
                    <div class="feed-url-row">
                        <input type="text" class="input" value="${url}" readonly id="rss-${id}">
                        <button class="btn btn-ghost btn-sm" onclick="copyFeedUrl('rss-${id}')">📋</button>
                    </div>
                </div>
            `;
        }
        container.innerHTML = html;
    } catch (e) {
        console.error('피드 URL 로드 실패:', e);
    }
}

function copyFeedUrl(inputId) {
    const input = document.getElementById(inputId);
    if (input) {
        navigator.clipboard.writeText(input.value);
        showToast('URL이 클립보드에 복사되었습니다', 'success');
    }
}

// =============================================
// Toast 알림
// =============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

// =============================================
// 유틸리티
// =============================================
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// =============================================
// 광고 감지 설정
// =============================================
async function loadAdDetectionStatus() {
    try {
        const data = await api('/api/ad-detection');
        const toggle = document.getElementById('ad-detection-toggle');
        if (toggle) toggle.checked = data.enabled;
    } catch (e) {
        console.error('광고 감지 상태 로드 실패:', e);
    }
}

async function toggleAdDetection() {
    try {
        const data = await api('/api/ad-detection/toggle', { method: 'POST' });
        const toggle = document.getElementById('ad-detection-toggle');
        if (toggle) toggle.checked = data.enabled;
        showToast(data.enabled ? '🚫 광고 자동 제거 활성화' : '광고 자동 제거 비활성화', data.enabled ? 'success' : 'info');
    } catch (e) {
        showToast('설정 변경 실패', 'error');
        // 실패 시 원래 상태로 복원
        loadAdDetectionStatus();
    }
}

// =============================================
// 녹음 캘린더 렌더링
// =============================================
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();

async function loadCalendar() {
    try {
        allFiles = await api('/api/files');
        renderCalendar();
    } catch (e) {
        showToast('캘린더 데이터 로드 실패', 'error');
    }
}

function prevMonth() {
    currentMonth--;
    if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
    }
    renderCalendar();
}

function nextMonth() {
    currentMonth++;
    if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
    }
    renderCalendar();
}

function detectStation(filename) {
    if (!stations) return null;
    for (const [id, s] of Object.entries(stations)) {
        const safeName = s.name.replace(/\s+/g, '_').replace(/\//g, '-');
        if (filename.includes(safeName) || filename.includes(s.name) || filename.includes(id)) {
            return s;
        }
    }
    if (filename.includes('윤상')) return { network: 'EBS', name: '윤상-라디오' };
    if (filename.includes('상순')) return { network: 'MBC', name: '상순씨-라디오' };
    if (filename.includes('철수')) return { network: 'MBC', name: '배철수아저씨' };
    
    if (filename.includes('KBS')) return { network: 'KBS', name: 'KBS 라디오' };
    if (filename.includes('MBC')) return { network: 'MBC', name: 'MBC 라디오' };
    if (filename.includes('SBS')) return { network: 'SBS', name: 'SBS 라디오' };
    if (filename.includes('EBS')) return { network: 'EBS', name: 'EBS 라디오' };
    if (filename.includes('TBS')) return { network: 'TBS', name: 'TBS 교통방송' };
    if (filename.includes('WBS')) return { network: 'WBS', name: 'WBS 원음방송' };
    if (filename.includes('CBS')) return { network: 'CBS', name: 'CBS 라디오' };

    return null;
}

function getEventColorClass(network) {
    if (!network) return 'event-default';
    const nw = network.toUpperCase();
    if (nw.includes('KBS')) return 'event-kbs';
    if (nw.includes('SBS')) return 'event-sbs';
    if (nw.includes('MBC')) return 'event-mbc';
    if (nw.includes('EBS')) return 'event-ebs';
    if (nw.includes('TBS')) return 'event-tbs';
    if (nw.includes('CBS')) return 'event-cbs';
    if (nw.includes('WBS')) return 'event-wbs';
    if (nw.includes('CPBC')) return 'event-cpbc';
    return 'event-default';
}

function renderCalendar() {
    const monthTitle = document.getElementById('calendar-month-title');
    if (!monthTitle) return;
    monthTitle.innerText = `${currentYear}년 ${currentMonth + 1}월`;

    const daysContainer = document.getElementById('calendar-days');
    if (!daysContainer) return;
    daysContainer.innerHTML = '';

    // 월 변경 시 상세 정보 패널 숨기기
    const panel = document.getElementById('calendar-details-panel');
    if (panel) panel.style.display = 'none';

    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
    const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
    const prevLastDay = new Date(currentYear, currentMonth, 0).getDate();

    let daysHtml = '';

    for (let i = firstDayIndex; i > 0; i--) {
        const dayNum = prevLastDay - i + 1;
        daysHtml += `<div class="calendar-day other-month"><div class="calendar-day-num">${dayNum}</div></div>`;
    }

    const today = new Date();
    const isThisMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth;

    for (let day = 1; day <= lastDay; day++) {
        const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isToday = isThisMonth && today.getDate() === day;

        const dayFiles = allFiles.filter(f => f.created && f.created.startsWith(dateStr));

        let eventsHtml = '<div class="calendar-events">';
        for (const f of dayFiles) {
            const station = detectStation(f.filename);
            const net = station ? station.network : '';
            const colorClass = getEventColorClass(net);
            const shortName = station ? station.name : f.filename.split('_')[0].split('/').pop();
            const locationIcon = f.status === 'NAS' ? '📂' : (f.status === 'DRIVE' ? '☁️' : '🎵');
            eventsHtml += `
                <div class="calendar-event ${colorClass}" onclick="event.stopPropagation(); window.open('/play/${f.id}', 'Player', 'width=500,height=600')" title="${f.filename} (${f.size_mb}MB)">
                    <span>${locationIcon}</span>
                    <span style="overflow:hidden; text-overflow:ellipsis;">${shortName}</span>
                </div>
            `;
        }
        eventsHtml += '</div>';

        daysHtml += `
            <div class="calendar-day ${isToday ? 'today' : ''}" onclick="selectCalendarDay('${dateStr}', this)">
                <div class="calendar-day-num">${day}</div>
                ${eventsHtml}
            </div>
        `;
    }

    const totalCells = firstDayIndex + lastDay;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
        daysHtml += `<div class="calendar-day other-month"><div class="calendar-day-num">${i}</div></div>`;
    }

    daysContainer.innerHTML = daysHtml;
}

// =============================================
// 캘린더 날짜 클릭 및 상세 목록 노출
// =============================================
function selectCalendarDay(dateStr, element) {
    document.querySelectorAll('.calendar-day').forEach(d => d.classList.remove('selected'));
    if (element) {
        element.classList.add('selected');
    }

    const dayFiles = allFiles.filter(f => f.created && f.created.startsWith(dateStr));
    const panel = document.getElementById('calendar-details-panel');
    const container = document.getElementById('calendar-day-files');
    const titleSpan = document.getElementById('selected-day-title');

    if (titleSpan) titleSpan.textContent = dateStr;

    if (!dayFiles.length) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 20px;">
                <p style="margin: 0; color: var(--text-muted);">해당 날짜에 녹음된 파일이 없습니다.</p>
            </div>
        `;
    } else {
        let html = '';
        for (const f of dayFiles) {
            const isClean = f.filename.includes('_clean');
            html += `
                <div class="file-item ${isClean ? 'clean-file' : ''}">
                    <div class="file-icon">${isClean ? '✨' : '🎵'}</div>
                    <div class="file-info">
                        <div class="file-name">${f.filename}</div>
                        <div class="file-meta">${f.size_mb}MB · ${formatDate(f.created)}</div>
                        <div style="margin-top: 8px;">
                            ${f.status === 'NAS' ? '<span class="status-badge" style="background:#4ade8020; color:#4ade80; padding:2px 8px; border-radius:12px; font-size:11px;">NAS</span>' : ''}
                            ${f.status === 'DRIVE' ? '<span class="status-badge" style="background:#facc1520; color:#facc15; padding:2px 8px; border-radius:12px; font-size:11px;">DRIVE</span>' : ''}
                            ${f.status === 'TRANSFERRING' ? '<span class="status-badge transferring-badge" style="background:#8b5cf620; color:#c084fc; padding:2px 8px; border-radius:12px; font-size:11px; animation: blink 1.5s infinite;">⏳ 전송 중...</span>' : ''}
                            <button class="btn btn-primary btn-sm" onclick="window.open('/play/${f.id}', 'Player', 'width=500,height=600')" style="margin-left:8px;" ${f.status === 'TRANSFERRING' ? 'disabled style="opacity:0.5; pointer-events:none;"' : ''}>
                                ▶ 재생하기
                             </button>
                        </div>
                    </div>
                    <div class="file-actions">
                        ${f.status === 'TRANSFERRING' ? '<span style="font-size:12px; color:var(--text-muted);">대기</span>' : `
                        <a href="/recordings/${f.relative_path}" download class="btn btn-ghost btn-sm" title="다운로드">⬇️</a>
                        <button class="btn btn-ghost btn-sm" onclick="deleteCalendarDayFile('${f.relative_path}', '${dateStr}', this)" title="삭제">🗑️</button>
                        `}
                    </div>
                </div>
            `;
        }
        container.innerHTML = html;
    }
    panel.style.display = 'block';
}

async function deleteCalendarDayFile(path, dateStr, element) {
    if (!confirm(`이 파일을 삭제하시겠습니까?\n${path}`)) return;
    try {
        const data = await api('/api/files', {
            method: 'DELETE',
            body: JSON.stringify({ paths: [path] }),
        });
        showToast(`${data.deleted.length}개 삭제 완료`, 'success');
        
        // 데이터 다시 로드 및 달력 업데이트
        allFiles = await api('/api/files');
        renderCalendar();
        
        // 해당 날짜 셀 찾아서 다시 포커스 및 상세 노출 갱신
        const dayNum = parseInt(dateStr.split('-')[2]);
        const days = document.querySelectorAll('.calendar-day:not(.other-month)');
        let targetEl = null;
        for (const d of days) {
            const numEl = d.querySelector('.calendar-day-num');
            if (numEl && parseInt(numEl.textContent) === dayNum) {
                targetEl = d;
                break;
            }
        }
        selectCalendarDay(dateStr, targetEl);
    } catch (e) {
        showToast('삭제 실패', 'error');
    }
}

// =============================================
// 통계 및 방송사별 모아듣기
// =============================================
async function loadStats() {
    try {
        allFiles = await api('/api/files');
        renderStats();
    } catch (e) {
        showToast('통계 데이터 로드 실패', 'error');
    }
}

function renderStats() {
    const container = document.getElementById('stats-grid');
    if (!container) return;

    if (!allFiles || !allFiles.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📊</div>
                <p>통계를 생성할 녹음 파일이 없습니다</p>
            </div>
        `;
        return;
    }

    // 방송국별 그룹 생성
    const groups = {};
    for (const f of allFiles) {
        const station = detectStation(f.filename);
        const sName = station ? station.name : '기타 방송';
        const network = station ? station.network : 'OTHER';
        if (!groups[sName]) {
            groups[sName] = {
                stationName: sName,
                network: network,
                files: []
            };
        }
        groups[sName].files.push(f);
    }

    // 파일 개수가 많은 순으로 정렬
    const sortedGroups = Object.values(groups).sort((a, b) => b.files.length - a.files.length);

    let html = '';
    for (const g of sortedGroups) {
        const fileCount = g.files.length;
        const totalSizeMb = g.files.reduce((sum, f) => sum + (f.size_mb || 0), 0);
        const sizeStr = totalSizeMb >= 1024 
            ? `${(totalSizeMb / 1024).toFixed(2)} GB` 
            : `${totalSizeMb.toFixed(1)} MB`;

        const dates = g.files.map(f => f.created).filter(Boolean).sort();
        let dateRangeStr = '-';
        if (dates.length > 0) {
            const oldest = dates[0].substring(0, 10);
            const newest = dates[dates.length - 1].substring(0, 10);
            dateRangeStr = oldest === newest ? oldest : `${oldest} ~ ${newest}`;
        }

        // 각 방송국 내 파일 최신 등록일 역순 정렬
        g.files.sort((a, b) => {
            if (!a.created) return 1;
            if (!b.created) return -1;
            return b.created.localeCompare(a.created);
        });

        const netClass = g.network.toLowerCase();

        let filesHtml = '';
        for (const f of g.files) {
            const isClean = f.filename.includes('_clean');
            filesHtml += `
                <div class="stats-file-item ${isClean ? 'clean-file' : ''}">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                        <span style="font-size: 14px;">${isClean ? '✨' : '🎵'}</span>
                        <div style="min-width: 0; flex: 1;">
                            <div class="stats-file-name" title="${f.filename}">${f.filename}</div>
                            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                                ${f.size_mb}MB · ${formatDate(f.created)}
                                ${f.status === 'NAS' ? ' <span class="status-badge" style="background:#4ade8020; color:#4ade80; padding:1px 6px; border-radius:8px; font-size:10px;">NAS</span>' : ''}
                                ${f.status === 'DRIVE' ? ' <span class="status-badge" style="background:#facc1520; color:#facc15; padding:1px 6px; border-radius:8px; font-size:10px;">DRIVE</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="window.open('/play/${f.id}', 'Player', 'width=500,height=600')">
                        ▶ 재생
                    </button>
                </div>
            `;
        }

        const safeId = 'stats-' + g.stationName.replace(/[^a-zA-Z0-9가-힣]/g, '-');

        html += `
            <div class="stats-card" id="card-${safeId}">
                <div class="stats-card-header" onclick="toggleStatsAccordion('${safeId}')">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div class="station-dot ${netClass}" style="flex-shrink: 0; width: 32px; height: 32px; font-size: 14px;">${g.network[0] || '기'}</div>
                        <div>
                            <h3 class="stats-station-title">${g.stationName}</h3>
                            <span class="stats-network-badge">${g.network}</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="stats-arrow">▼</span>
                    </div>
                </div>
                <div class="stats-card-meta">
                    <div class="stats-meta-item">
                        <span class="stats-meta-label">녹음 파일</span>
                        <span class="stats-meta-val">${fileCount}개</span>
                    </div>
                    <div class="stats-meta-item">
                        <span class="stats-meta-label">총 용량</span>
                        <span class="stats-meta-val">${sizeStr}</span>
                    </div>
                    <div class="stats-meta-item" style="grid-column: span 2;">
                        <span class="stats-meta-label">보관 기간</span>
                        <span class="stats-meta-val" style="font-size: 11px;">${dateRangeStr}</span>
                    </div>
                </div>
                <div class="stats-file-list" id="list-${safeId}" style="display: none;">
                    ${filesHtml}
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
}

function toggleStatsAccordion(safeId) {
    const list = document.getElementById(`list-${safeId}`);
    const card = document.getElementById(`card-${safeId}`);
    if (!list || !card) return;

    const isOpen = list.style.display !== 'none';
    if (isOpen) {
        list.style.display = 'none';
        card.classList.remove('expanded');
    } else {
        list.style.display = 'block';
        card.classList.add('expanded');
    }
}
