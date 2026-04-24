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

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    loadStations();
    loadSchedules();
    loadFeedUrls();
    startStatusPolling();
});

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
    document.getElementById('modal-overlay').classList.add('visible');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('visible');
}

async function saveSchedule() {
    const stationId = document.getElementById('sched-station').value;
    const label = document.getElementById('sched-label').value;
    const startTime = document.getElementById('sched-time').value;
    const duration = document.getElementById('sched-duration').value;

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

    try {
        await api('/api/schedules', {
            method: 'POST',
            body: JSON.stringify({
                station_id: stationId,
                days,
                start_time: startTime,
                duration_minutes: parseInt(duration),
                label,
            }),
        });

        closeModal();
        loadSchedules();
        showToast('예약이 추가되었습니다', 'success');

        // 폼 초기화
        document.getElementById('sched-label').value = '';
        document.querySelectorAll('.day-selector input').forEach(cb => cb.checked = false);
    } catch (e) {
        showToast(`예약 추가 실패: ${e.message}`, 'error');
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
async function loadFiles() {
    try {
        const files = await api('/api/files');
        renderFiles(files);
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

    container.innerHTML = files.map(f => `
        <div class="file-item">
            <div class="file-icon">🎵</div>
            <div class="file-info">
                <div class="file-name">${f.filename}</div>
                <div class="file-meta">${f.size_mb}MB · ${formatDate(f.created)}</div>
                <audio class="audio-player" controls preload="none">
                    <source src="/recordings/${f.relative_path}" type="audio/mpeg">
                </audio>
            </div>
            <div class="file-actions">
                <a href="/recordings/${f.relative_path}" download class="btn btn-ghost btn-sm">⬇️ 다운로드</a>
            </div>
        </div>
    `).join('');
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
