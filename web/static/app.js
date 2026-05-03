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

document.addEventListener('DOMContentLoaded', () => {
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
                    if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        try { hlsInstance.recoverMediaError(); } catch (e) { /* ignore */ }
                    } else if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        setTimeout(() => { if (hlsInstance) hlsInstance.startLoad(); }, 2000);
                    }
                }
            });
        } else {
            // MP3 직접 스트림
            audio.src = streamUrl;
            audio.load();
            audio.play().catch(e => console.error('[Player] Direct play error:', e));
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
        showToast('스트림 연결에 실패했습니다.', 'error');
        if (liveCurrentStation === stationId) {
            liveCurrentStation = null;
            liveIsPlaying = false;
            hidePlayerBar();
        }
    } finally {
        _switchingStation = false;
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

async function loadFiles() {
    try {
        allFiles = await api('/api/files');
        selectedFiles.clear();
        renderFiles(allFiles);
        updateBulkBar();
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
    let totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    let html = `<div class="file-summary">${files.length}개 파일 · ${(totalSize / 1024 / 1024).toFixed(1)}MB</div>`;

    for (const date of sortedDates) {
        const dateFiles = groups[date];
        const dateSize = dateFiles.reduce((sum, f) => sum + (f.size || 0), 0);

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
            html += `
                <div class="file-item ${isClean ? 'clean-file' : ''}">
                    <label class="checkbox-wrap">
                        <input type="checkbox" ${checked} onchange="toggleFileSelect('${f.relative_path}')">
                    </label>
                    <div class="file-icon">${isClean ? '✨' : '🎵'}</div>
                    <div class="file-info">
                        <div class="file-name">${f.filename}</div>
                        <div class="file-meta">${f.size_mb}MB · ${formatDate(f.created)}</div>
                        <div style="margin-top: 8px;">
                            ${f.status === 'NAS' ? '<span class="status-badge" style="background:#4ade8020; color:#4ade80; padding:2px 8px; border-radius:12px; font-size:11px;">NAS</span>' : ''}
                            ${f.status === 'DRIVE' ? '<span class="status-badge" style="background:#facc1520; color:#facc15; padding:2px 8px; border-radius:12px; font-size:11px;">DRIVE</span>' : ''}
                            <button class="btn btn-primary btn-sm" onclick="window.open('/play/${f.id}', 'Player', 'width=500,height=600')" style="margin-left:8px;">
                                ▶ 재생하기
                            </button>
                        </div>
                    </div>
                    <div class="file-actions">
                        <a href="/recordings/${f.relative_path}" download class="btn btn-ghost btn-sm" title="다운로드">⬇️</a>
                        <button class="btn btn-ghost btn-sm" onclick="deleteFile('${f.relative_path}')" title="삭제">🗑️</button>
                    </div>
                </div>
            `;
        }

        html += '</div></div>';
    }

    container.innerHTML = html;
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
        allFiles.forEach(f => selectedFiles.add(f.relative_path));
    } else {
        selectedFiles.clear();
    }
    renderFiles(allFiles);
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
    try {
        const data = await api('/api/files', {
            method: 'DELETE',
            body: JSON.stringify({ paths: [...selectedFiles] }),
        });
        showToast(`${data.deleted.length}개 삭제 완료`, 'success');
        loadFiles();
    } catch (e) {
        showToast('삭제 실패', 'error');
    }
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
    showToast(`${selectedFiles.size}개 파일 NAS 복사 중...`, 'info');
    try {
        const data = await api('/api/storage/nas/transfer', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], action: 'copy' }),
        });
        showToast(`NAS 복사 완료: ${data.transferred.length}개`, 'success');
        if (data.errors.length) console.error('NAS 전송 오류:', data.errors);
    } catch (e) {
        showToast(`NAS 전송 실패: ${e.message}`, 'error');
    }
}

async function moveSelectedToNas() {
    if (!selectedFiles.size) { showToast('파일을 선택하세요', 'error'); return; }
    if (!confirm(`${selectedFiles.size}개 파일을 NAS로 이동합니다.\n원본은 삭제됩니다. 계속?`)) return;
    showToast(`${selectedFiles.size}개 파일 NAS 이동 중...`, 'info');
    try {
        const data = await api('/api/storage/nas/transfer', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], action: 'move' }),
        });
        showToast(`NAS 이동 완료: ${data.transferred.length}개`, 'success');
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
    showToast(`${selectedFiles.size}개 파일 Google Drive 업로드 중...`, 'info');
    try {
        const folderName = document.getElementById('drive-folder') ? document.getElementById('drive-folder').value : 'Radio Recordings';
        const data = await api('/api/storage/drive/upload', {
            method: 'POST',
            body: JSON.stringify({ paths: [...selectedFiles], folder: folderName }),
        });
        showToast(`Drive 이동 완료: ${data.uploaded.length}개`, 'success');
        loadFiles();
        if (data.errors.length) console.error('Drive 업로드 오류:', data.errors);
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
