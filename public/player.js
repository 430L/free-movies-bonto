const PLAYER_PROGRESS_KEY = 'paysons-movies-playback-progress';
const PLAYER_SETTINGS_KEY = 'paysons-movies-playback-settings';
const PLAYER_METRICS_KEY = 'paysons-movies-source-metrics';

const playerState = {
  media: null,
  season: 1,
  episode: 1,
  episodes: [],
  sources: [],
  sourceIndex: -1,
  hls: null,
  loadStartedAt: 0,
  lastProgressWrite: 0,
  failoverLock: false,
  settings: loadJson(PLAYER_SETTINGS_KEY, { autoServer: true, autoplay: true, preferredQuality: 'auto', playbackRate: 1 }),
  progress: loadJson(PLAYER_PROGRESS_KEY, {}),
  metrics: loadJson(PLAYER_METRICS_KEY, {})
};

const ui = {};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupPlayer);
else setupPlayer();

function setupPlayer() {
  injectPlayerShell();
  cacheUi();
  wirePlayerEvents();
  enhancePlaybackButtons(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) enhancePlaybackButtons(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', interceptAppPlaybackClicks, true);
}

function injectPlayerShell() {
  if (document.getElementById('paysonPlayer')) return;
  const root = document.createElement('div');
  root.id = 'paysonPlayer';
  root.className = 'payson-player hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="payson-player-backdrop"></div>
    <section class="payson-player-shell" role="dialog" aria-modal="true" aria-label="Payson’s Movies player">
      <header class="payson-player-header">
        <div class="payson-player-title-wrap">
          <img src="/assets/logo.svg" alt="" class="payson-player-mark" />
          <div>
            <div class="payson-player-kicker">Payson’s Movies</div>
            <h2 id="paysonPlayerTitle">Preparing playback…</h2>
            <div id="paysonPlayerSubhead" class="payson-player-subhead"></div>
          </div>
        </div>
        <button id="paysonPlayerClose" class="payson-player-close" type="button" aria-label="Close player">×</button>
      </header>

      <div class="payson-video-stage">
        <video id="paysonVideo" controls playsinline preload="metadata"></video>
        <div id="paysonPlayerStatus" class="payson-player-status">Resolving the best available server…</div>
      </div>

      <div class="payson-player-toolbar">
        <label class="payson-control payson-server-control">
          <span>Server</span>
          <select id="paysonServerSelect"></select>
        </label>
        <label class="payson-control">
          <span>Quality</span>
          <select id="paysonQualitySelect"><option value="-1">Auto</option></select>
        </label>
        <label class="payson-control">
          <span>Audio</span>
          <select id="paysonAudioSelect" disabled><option value="">Default</option></select>
        </label>
        <label class="payson-control">
          <span>Subtitles</span>
          <select id="paysonSubtitleSelect"><option value="off">Off</option></select>
        </label>
        <label class="payson-control">
          <span>Speed</span>
          <select id="paysonSpeedSelect">
            <option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
          </select>
        </label>
        <label class="payson-toggle"><input id="paysonAutoServer" type="checkbox" /> <span>Auto fastest server</span></label>
      </div>

      <div id="paysonEpisodeControls" class="payson-episode-controls hidden">
        <label class="payson-control"><span>Season</span><select id="paysonSeasonSelect"></select></label>
        <label class="payson-control"><span>Episode</span><select id="paysonEpisodeSelect"></select></label>
        <button id="paysonPrevEpisode" class="ghost-button compact" type="button">Previous</button>
        <button id="paysonNextEpisode" class="primary-button compact" type="button">Next Episode</button>
      </div>

      <div id="paysonSourceSummary" class="payson-source-summary"></div>
      <div id="paysonFallback" class="payson-fallback hidden"></div>
    </section>
  `;
  document.body.appendChild(root);
}

function cacheUi() {
  ui.root = document.getElementById('paysonPlayer');
  ui.video = document.getElementById('paysonVideo');
  ui.title = document.getElementById('paysonPlayerTitle');
  ui.subhead = document.getElementById('paysonPlayerSubhead');
  ui.status = document.getElementById('paysonPlayerStatus');
  ui.close = document.getElementById('paysonPlayerClose');
  ui.server = document.getElementById('paysonServerSelect');
  ui.quality = document.getElementById('paysonQualitySelect');
  ui.audio = document.getElementById('paysonAudioSelect');
  ui.subtitle = document.getElementById('paysonSubtitleSelect');
  ui.speed = document.getElementById('paysonSpeedSelect');
  ui.autoServer = document.getElementById('paysonAutoServer');
  ui.episodeControls = document.getElementById('paysonEpisodeControls');
  ui.season = document.getElementById('paysonSeasonSelect');
  ui.episode = document.getElementById('paysonEpisodeSelect');
  ui.prevEpisode = document.getElementById('paysonPrevEpisode');
  ui.nextEpisode = document.getElementById('paysonNextEpisode');
  ui.summary = document.getElementById('paysonSourceSummary');
  ui.fallback = document.getElementById('paysonFallback');

  ui.autoServer.checked = Boolean(playerState.settings.autoServer);
  ui.speed.value = String(playerState.settings.playbackRate || 1);
  ui.video.playbackRate = Number(ui.speed.value);
}

function wirePlayerEvents() {
  ui.close.addEventListener('click', closePlayer);
  ui.root.querySelector('.payson-player-backdrop').addEventListener('click', closePlayer);
  ui.server.addEventListener('change', () => {
    playerState.settings.autoServer = false;
    ui.autoServer.checked = false;
    saveSettings();
    loadSource(Number(ui.server.value), { manual: true });
  });
  ui.autoServer.addEventListener('change', () => {
    playerState.settings.autoServer = ui.autoServer.checked;
    saveSettings();
    if (ui.autoServer.checked && playerState.sources.length) loadSource(bestSourceIndex(), { manual: false });
  });
  ui.quality.addEventListener('change', () => {
    const level = Number(ui.quality.value);
    playerState.settings.preferredQuality = ui.quality.options[ui.quality.selectedIndex]?.textContent || 'Auto';
    saveSettings();
    if (playerState.hls) playerState.hls.currentLevel = level;
  });
  ui.audio.addEventListener('change', () => {
    if (playerState.hls) playerState.hls.audioTrack = Number(ui.audio.value);
  });
  ui.subtitle.addEventListener('change', applySubtitleSelection);
  ui.speed.addEventListener('change', () => {
    ui.video.playbackRate = Number(ui.speed.value);
    playerState.settings.playbackRate = ui.video.playbackRate;
    saveSettings();
  });
  ui.season.addEventListener('change', async () => {
    playerState.season = Number(ui.season.value);
    playerState.episode = 1;
    await loadSeasonAndResolve();
  });
  ui.episode.addEventListener('change', async () => {
    playerState.episode = Number(ui.episode.value);
    await resolveAndPlay();
  });
  ui.prevEpisode.addEventListener('click', () => stepEpisode(-1));
  ui.nextEpisode.addEventListener('click', () => stepEpisode(1));
  ui.video.addEventListener('loadedmetadata', restoreProgress);
  ui.video.addEventListener('timeupdate', persistProgressThrottled);
  ui.video.addEventListener('ended', handleEnded);
  ui.video.addEventListener('error', () => handlePlaybackFailure('video-error'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.root.classList.contains('hidden')) closePlayer();
  });
}

function interceptAppPlaybackClicks(event) {
  const hero = event.target.closest?.('#heroPlay');
  if (hero) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openHeroPlayback();
    return;
  }

  const cardWatch = event.target.closest?.('[data-payson-playback]');
  if (cardWatch) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openPlayer({ type: cardWatch.dataset.mediaType, id: cardWatch.dataset.itemId, title: cardWatch.dataset.title || '' });
    return;
  }

  const detailWatch = event.target.closest?.('[data-payson-detail-watch]');
  if (detailWatch) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openPlayer({ type: detailWatch.dataset.mediaType, id: detailWatch.dataset.itemId, title: detailWatch.dataset.title || '' });
    return;
  }

  const trailer = event.target.closest?.('[data-payson-trailer]');
  if (trailer) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openTrailerFor(trailer.dataset.mediaType, trailer.dataset.itemId);
  }
}

function enhancePlaybackButtons(root) {
  const scope = root.querySelectorAll ? root : document;

  const heroPlay = document.getElementById('heroPlay');
  if (heroPlay) heroPlay.textContent = 'Watch Now';
  const heroActions = heroPlay?.closest('.hero-actions');
  if (heroActions && !document.getElementById('heroTrailer')) {
    const trailer = document.createElement('button');
    trailer.id = 'heroTrailer';
    trailer.type = 'button';
    trailer.className = 'secondary-button';
    trailer.textContent = 'Trailer';
    trailer.addEventListener('click', async () => {
      const identity = await getHeroIdentity();
      if (identity) await openTrailerFor(identity.type, identity.id);
    });
    heroPlay.insertAdjacentElement('afterend', trailer);
  }

  scope.querySelectorAll?.('.poster-card .poster-overlay-actions [data-open-trailer]').forEach((button) => {
    if (button.dataset.paysonEnhanced === '1') return;
    const trailer = document.createElement('button');
    trailer.className = 'icon-button payson-trailer-button';
    trailer.type = 'button';
    trailer.title = 'Trailer';
    trailer.textContent = 'T';
    trailer.dataset.paysonTrailer = '1';
    trailer.dataset.mediaType = button.dataset.mediaType;
    trailer.dataset.itemId = button.dataset.itemId;

    button.dataset.paysonEnhanced = '1';
    button.dataset.paysonPlayback = '1';
    button.title = 'Watch now';
    button.textContent = '▶';
    delete button.dataset.openTrailer;
    button.insertAdjacentElement('afterend', trailer);
  });

  const detailActions = document.querySelector('#detailContent .detail-actions');
  if (detailActions && !detailActions.querySelector('[data-payson-detail-watch]')) {
    const trailer = detailActions.querySelector('[data-open-trailer]');
    if (trailer) {
      const watch = document.createElement('button');
      watch.className = 'primary-button';
      watch.type = 'button';
      watch.textContent = 'Watch Now';
      watch.dataset.paysonDetailWatch = '1';
      watch.dataset.mediaType = trailer.dataset.mediaType;
      watch.dataset.itemId = trailer.dataset.itemId;
      watch.dataset.title = document.querySelector('#detailContent .detail-copy h2')?.textContent || '';
      trailer.className = 'secondary-button';
      trailer.textContent = 'Trailer';
      detailActions.insertBefore(watch, trailer);
    }
  }
}

async function openHeroPlayback() {
  const identity = await getHeroIdentity();
  if (!identity) return showToast('Could not identify this featured title.');
  await openPlayer(identity);
}

async function getHeroIdentity() {
  const title = document.querySelector('.hero-title')?.textContent?.trim();
  if (!title || title.startsWith('Loading')) return null;
  const chips = [...document.querySelectorAll('.hero-meta .chip')].map((node) => node.textContent.trim());
  const type = chips.some((text) => text.toLowerCase().includes('tv')) ? 'tv' : 'movie';
  const year = chips.find((text) => /^\d{4}$/.test(text));
  const data = await request(`/api/search?q=${encodeURIComponent(title)}`);
  const normalized = normalizeText(title);
  const candidates = data.results.filter((item) => item.media_type === type && normalizeText(item.title) === normalized);
  const match = candidates.find((item) => !year || String(item.release_date || '').startsWith(year)) || candidates[0] || data.results.find((item) => item.media_type === type);
  return match ? { type: match.media_type, id: match.id, title: match.title } : null;
}

async function openPlayer({ type, id, title }) {
  if (!['movie', 'tv'].includes(type) || !id) return;
  cleanupMedia();
  playerState.media = { type, id: String(id), title: title || '' };
  playerState.season = 1;
  playerState.episode = 1;
  playerState.sources = [];
  playerState.sourceIndex = -1;

  ui.root.classList.remove('hidden');
  ui.root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  ui.title.textContent = title || 'Payson’s Movies';
  ui.subhead.textContent = type === 'tv' ? 'Series' : 'Movie';
  setStatus('Loading title details…');
  setFallback('');

  try {
    const details = await request(`/api/title/${type}/${encodeURIComponent(id)}`);
    playerState.media.title = details.display_title || title || 'Untitled';
    playerState.media.poster = details.backdrop_url || details.poster_url || '';
    ui.title.textContent = playerState.media.title;
    ui.video.poster = details.backdrop_url || '';

    if (type === 'tv') {
      ui.episodeControls.classList.remove('hidden');
      const seasons = (details.seasons || []).filter((season) => season.season_number > 0);
      ui.season.innerHTML = seasons.map((season) => `<option value="${season.season_number}">${escapeHtml(season.name || `Season ${season.season_number}`)}</option>`).join('');
      playerState.season = Number(ui.season.value || 1);
      await loadSeasonAndResolve();
    } else {
      ui.episodeControls.classList.add('hidden');
      await resolveAndPlay();
    }
  } catch (error) {
    setStatus('Playback could not be prepared.');
    setFallback(escapeHtml(error.message));
  }
}

async function loadSeasonAndResolve() {
  setStatus('Loading episodes…');
  try {
    const season = await request(`/api/tv/${playerState.media.id}/season/${playerState.season}`);
    playerState.episodes = season.episodes || [];
    ui.episode.innerHTML = playerState.episodes.map((episode) => `<option value="${episode.episode_number}">E${episode.episode_number} · ${escapeHtml(episode.name || 'Episode')}</option>`).join('');
    if (!playerState.episodes.some((episode) => episode.episode_number === playerState.episode)) playerState.episode = playerState.episodes[0]?.episode_number || 1;
    ui.episode.value = String(playerState.episode);
    updateEpisodeButtons();
    await resolveAndPlay();
  } catch (error) {
    setStatus('Could not load this season.');
    setFallback(escapeHtml(error.message));
  }
}

async function resolveAndPlay() {
  cleanupMedia();
  setFallback('');
  setStatus('Testing available servers…');
  const params = new URLSearchParams({ type: playerState.media.type, id: playerState.media.id });
  if (playerState.media.type === 'tv') {
    params.set('season', String(playerState.season));
    params.set('episode', String(playerState.episode));
    const episodeMeta = playerState.episodes.find((episode) => episode.episode_number === playerState.episode);
    ui.subhead.textContent = `Season ${playerState.season} · Episode ${playerState.episode}${episodeMeta?.name ? ` · ${episodeMeta.name}` : ''}`;
  } else {
    ui.subhead.textContent = 'Movie';
  }

  try {
    const resolved = await request(`/api/playback/resolve?${params}`);
    playerState.sources = rankWithClientMetrics(resolved.sources || []);
    renderSourceOptions();
    if (!playerState.sources.length) {
      setStatus('No direct playback source is configured for this title.');
      await renderWatchFallback();
      return;
    }
    const preferred = playerState.settings.autoServer ? bestSourceIndex() : Math.max(0, playerState.sources.findIndex((source) => source.id === resolved.autoSelected));
    await loadSource(preferred < 0 ? 0 : preferred, { manual: false });
  } catch (error) {
    setStatus('Could not resolve playback.');
    setFallback(escapeHtml(error.message));
  }
}

function rankWithClientMetrics(sources) {
  return [...sources].sort((a, b) => {
    if (a.health?.online !== b.health?.online) return a.health?.online ? -1 : 1;
    const aMetric = playerState.metrics[a.id]?.latencyMs;
    const bMetric = playerState.metrics[b.id]?.latencyMs;
    if (Number.isFinite(aMetric) && Number.isFinite(bMetric) && Math.abs(aMetric - bMetric) > 80) return aMetric - bMetric;
    return (a.health?.latencyMs || 999999) - (b.health?.latencyMs || 999999);
  });
}

function bestSourceIndex() {
  const onlineIndex = playerState.sources.findIndex((source) => source.health?.online !== false);
  return onlineIndex >= 0 ? onlineIndex : 0;
}

function renderSourceOptions() {
  ui.server.innerHTML = playerState.sources.map((source, index) => {
    const latency = source.health?.latencyMs ? `${source.health.latencyMs}ms` : 'untested';
    const state = source.health?.online === false ? 'offline' : 'online';
    return `<option value="${index}">${escapeHtml(source.name)} · ${escapeHtml(source.quality)} · ${state} · ${latency}</option>`;
  }).join('');
  ui.summary.textContent = playerState.sources.length ? `${playerState.sources.length} server${playerState.sources.length === 1 ? '' : 's'} available. Fastest healthy server is selected automatically.` : '';
}

async function loadSource(index, { manual = false } = {}) {
  if (!playerState.sources[index]) return;
  cleanupMedia();
  playerState.sourceIndex = index;
  const source = playerState.sources[index];
  ui.server.value = String(index);
  ui.video.playbackRate = Number(playerState.settings.playbackRate || 1);
  ui.speed.value = String(ui.video.playbackRate);
  setStatus(`Connecting to ${source.name}…`);
  applyExternalSubtitles(source.subtitles || []);
  resetQualityOptions();
  playerState.loadStartedAt = performance.now();

  const isHls = source.type === 'hls' || source.url.includes('.m3u8');
  if (isHls && window.Hls?.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true, backBufferLength: 30, maxBufferLength: 45, startLevel: -1 });
    playerState.hls = hls;
    hls.loadSource(source.url);
    hls.attachMedia(ui.video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      populateHlsQuality(hls);
      populateHlsAudio(hls);
      playbackReady(source);
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (Number.isInteger(data.level)) ui.quality.value = String(data.level); });
    hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => populateHlsAudio(hls));
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); return; } catch {}
      }
      handlePlaybackFailure(`hls-${data.type || 'fatal'}`);
    });
  } else {
    ui.video.src = source.url;
    ui.video.addEventListener('canplay', () => playbackReady(source), { once: true });
    if (isHls && !ui.video.canPlayType('application/vnd.apple.mpegurl')) {
      setStatus('This browser cannot play this HLS source. Trying another server…');
      if (!manual) return handlePlaybackFailure('hls-unsupported');
    }
    ui.video.load();
  }
}

function playbackReady(source) {
  const latencyMs = Math.max(1, Math.round(performance.now() - playerState.loadStartedAt));
  playerState.metrics[source.id] = { latencyMs, updatedAt: Date.now() };
  localStorage.setItem(PLAYER_METRICS_KEY, JSON.stringify(playerState.metrics));
  reportSource(source.id, 'success', latencyMs);
  setStatus(`${source.name} connected · ${latencyMs}ms startup`);
  restoreProgress();
  if (playerState.settings.autoplay) ui.video.play().catch(() => {});
}

function populateHlsQuality(hls) {
  ui.quality.innerHTML = '<option value="-1">Auto</option>' + hls.levels.map((level, index) => `<option value="${index}">${level.height ? `${level.height}p` : `Level ${index + 1}`}</option>`).join('');
  ui.quality.disabled = false;
  const preference = String(playerState.settings.preferredQuality || 'auto').toLowerCase();
  if (preference !== 'auto') {
    const option = [...ui.quality.options].find((entry) => entry.textContent.toLowerCase() === preference);
    if (option) {
      ui.quality.value = option.value;
      hls.currentLevel = Number(option.value);
    }
  }
}

function populateHlsAudio(hls) {
  const tracks = hls.audioTracks || [];
  ui.audio.innerHTML = tracks.length ? tracks.map((track, index) => `<option value="${index}">${escapeHtml(track.name || track.lang || `Track ${index + 1}`)}</option>`).join('') : '<option value="">Default</option>';
  ui.audio.disabled = tracks.length < 2;
}

function resetQualityOptions() {
  ui.quality.innerHTML = '<option value="-1">Auto</option>';
  ui.quality.disabled = true;
  ui.audio.innerHTML = '<option value="">Default</option>';
  ui.audio.disabled = true;
}

function applyExternalSubtitles(subtitles) {
  [...ui.video.querySelectorAll('track')].forEach((track) => track.remove());
  ui.subtitle.innerHTML = '<option value="off">Off</option>';
  subtitles.forEach((subtitle, index) => {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.label || subtitle.language || `Subtitle ${index + 1}`;
    track.srclang = subtitle.language || 'und';
    track.src = subtitle.url;
    ui.video.appendChild(track);
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = track.label;
    ui.subtitle.appendChild(option);
  });
}

function applySubtitleSelection() {
  const selected = ui.subtitle.value;
  [...ui.video.textTracks].forEach((track, index) => { track.mode = selected !== 'off' && Number(selected) === index ? 'showing' : 'disabled'; });
}

function cleanupMedia() {
  if (playerState.hls) {
    try { playerState.hls.destroy(); } catch {}
    playerState.hls = null;
  }
  if (ui.video) {
    ui.video.pause();
    ui.video.removeAttribute('src');
    ui.video.load();
  }
}

async function handlePlaybackFailure(reason) {
  if (playerState.failoverLock || playerState.sourceIndex < 0) return;
  playerState.failoverLock = true;
  const current = playerState.sources[playerState.sourceIndex];
  reportSource(current?.id, 'failure', 0, reason);
  if (!playerState.settings.autoServer) {
    setStatus(`Server failed (${reason}). Choose another server.`);
    playerState.failoverLock = false;
    return;
  }

  const candidates = playerState.sources.map((source, index) => ({ source, index })).filter(({ index, source }) => index !== playerState.sourceIndex && source.health?.online !== false);
  const next = candidates[0] || playerState.sources.map((source, index) => ({ source, index })).find(({ index }) => index !== playerState.sourceIndex);
  if (!next) {
    setStatus('All configured servers failed.');
    setFallback('Try again later or choose an external streaming provider below.');
    playerState.failoverLock = false;
    return;
  }
  setStatus(`${current?.name || 'Server'} failed. Rotating to ${next.source.name}…`);
  const resumeAt = Number.isFinite(ui.video.currentTime) ? ui.video.currentTime : 0;
  await loadSource(next.index, { manual: false });
  if (resumeAt > 0) ui.video.addEventListener('loadedmetadata', () => { if (resumeAt < ui.video.duration - 5) ui.video.currentTime = resumeAt; }, { once: true });
  playerState.failoverLock = false;
}

async function renderWatchFallback() {
  try {
    const watch = await request(`/api/watch/${playerState.media.type}/${playerState.media.id}`);
    const groups = [...(watch.flatrate || []), ...(watch.free || []), ...(watch.ads || []), ...(watch.rent || []), ...(watch.buy || [])];
    const unique = [...new Map(groups.map((provider) => [provider.provider_id, provider])).values()].slice(0, 10);
    const providers = unique.length ? `<div class="payson-provider-list">${unique.map((provider) => `<span class="payson-provider-chip">${escapeHtml(provider.provider_name)}</span>`).join('')}</div>` : '<p>No US provider listing was returned.</p>';
    const link = watch.link ? `<a class="primary-button" href="${escapeAttribute(watch.link)}" target="_blank" rel="noopener noreferrer">View streaming options</a>` : '';
    setFallback(`<h3>Playback source not configured</h3><p>This title does not have an authorized direct source in this deployment.</p>${providers}${link}`);
  } catch {
    setFallback('<h3>Playback source not configured</h3><p>Add an authorized HLS or MP4 source for this title to enable direct playback.</p>');
  }
}

function progressKey() {
  if (!playerState.media) return '';
  return playerState.media.type === 'tv' ? `tv:${playerState.media.id}:${playerState.season}:${playerState.episode}` : `movie:${playerState.media.id}`;
}

function restoreProgress() {
  const saved = playerState.progress[progressKey()];
  if (!saved || !Number.isFinite(saved.currentTime) || !Number.isFinite(ui.video.duration)) return;
  if (saved.currentTime > 10 && saved.currentTime < ui.video.duration - 20) ui.video.currentTime = saved.currentTime;
}

function persistProgressThrottled() {
  const now = Date.now();
  if (now - playerState.lastProgressWrite < 5000 || !playerState.media || !Number.isFinite(ui.video.duration) || ui.video.duration <= 0) return;
  playerState.lastProgressWrite = now;
  playerState.progress[progressKey()] = {
    type: playerState.media.type,
    id: playerState.media.id,
    title: playerState.media.title,
    season: playerState.season,
    episode: playerState.episode,
    currentTime: ui.video.currentTime,
    duration: ui.video.duration,
    updatedAt: now
  };
  localStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify(playerState.progress));
}

function handleEnded() {
  delete playerState.progress[progressKey()];
  localStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify(playerState.progress));
  if (playerState.media?.type === 'tv') void stepEpisode(1);
}

async function stepEpisode(direction) {
  if (!playerState.episodes.length) return;
  const index = playerState.episodes.findIndex((episode) => episode.episode_number === playerState.episode);
  const next = playerState.episodes[index + direction];
  if (!next) return;
  playerState.episode = next.episode_number;
  ui.episode.value = String(playerState.episode);
  updateEpisodeButtons();
  await resolveAndPlay();
}

function updateEpisodeButtons() {
  const index = playerState.episodes.findIndex((episode) => episode.episode_number === playerState.episode);
  ui.prevEpisode.disabled = index <= 0;
  ui.nextEpisode.disabled = index < 0 || index >= playerState.episodes.length - 1;
}

function closePlayer() {
  persistProgressThrottled();
  cleanupMedia();
  ui.root.classList.add('hidden');
  ui.root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function openTrailerFor(type, id) {
  try {
    const details = await request(`/api/title/${type}/${id}`);
    if (!details.trailer?.key) return showToast('No trailer was found for this title.');
    const modal = document.getElementById('videoModal');
    const frame = document.getElementById('videoFrame');
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(details.trailer.key)}?autoplay=1&rel=0&modestbranding=1`;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  } catch (error) {
    showToast(error.message);
  }
}

function reportSource(sourceId, event, latencyMs = 0, reason = '') {
  if (!sourceId) return;
  fetch('/api/playback/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, event, latencyMs, reason }),
    keepalive: true
  }).catch(() => {});
}

function setStatus(message) {
  ui.status.textContent = message;
  ui.status.classList.toggle('hidden', !message);
}

function setFallback(html) {
  ui.fallback.innerHTML = html;
  ui.fallback.classList.toggle('hidden', !html);
}

function saveSettings() {
  localStorage.setItem(PLAYER_SETTINGS_KEY, JSON.stringify(playerState.settings));
}

async function request(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.error || `Request failed (${response.status})`);
  return data;
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback; }
  catch { return fallback; }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function escapeHtml(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
