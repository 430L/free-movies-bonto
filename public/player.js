const PLAYER_SETTINGS_KEY = 'paysons-movies-playback-settings';
const PLAYER_PROGRESS_KEY = 'paysons-movies-playback-progress';
const PLAYER_METRICS_KEY = 'paysons-movies-source-metrics';

const playerState = {
  media: null,
  season: 1,
  episode: 1,
  episodes: [],
  sources: [],
  responseId: null,
  sourceIndex: -1,
  hls: null,
  refreshAttempted: false,
  failoverLock: false,
  failedSourceKeys: new Set(),
  sourceLoadTimer: null,
  statusHideTimer: null,
  sessionToken: 0,
  resolveToken: 0,
  sourceLoadToken: 0,
  subtitleObjectUrls: [],
  loadStartedAt: 0,
  lastProgressWrite: 0,
  settings: loadJson(PLAYER_SETTINGS_KEY, {
    autoServer: true,
    autoplay: true,
    preferredQuality: 'Auto',
    playbackRate: 1,
    preferredProvider: ''
  }),
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
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) enhancePlaybackButtons(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', interceptPlaybackClicks, true);
  window.addEventListener('payson:play', (event) => void openPlayer(event.detail || {}));
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
        <div id="paysonPlayerStatus" class="payson-player-status">Finding the best available server…</div>
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
            <option value="0.75">0.75×</option>
            <option value="1">1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
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
    playerState.settings.preferredProvider = playerState.sources[Number(ui.server.value)]?.provider?.id || '';
    ui.autoServer.checked = false;
    saveSettings();
    void loadSource(Number(ui.server.value), { manual: true });
  });

  ui.autoServer.addEventListener('change', () => {
    playerState.settings.autoServer = ui.autoServer.checked;
    saveSettings();
    if (ui.autoServer.checked && playerState.sources.length) void loadSource(bestSourceIndex(), { manual: false });
  });

  ui.quality.addEventListener('change', () => {
    const level = Number(ui.quality.value);
    playerState.settings.preferredQuality = ui.quality.options[ui.quality.selectedIndex]?.textContent || 'Auto';
    saveSettings();
    if (playerState.hls) playerState.hls.currentLevel = level;
  });

  ui.audio.addEventListener('change', () => {
    if (playerState.hls && ui.audio.value !== '') playerState.hls.audioTrack = Number(ui.audio.value);
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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.root.classList.contains('hidden')) closePlayer();
  });
}

function interceptPlaybackClicks(event) {
  const hero = event.target.closest?.('#heroPlay');
  if (hero) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openHeroPlayback();
    return;
  }

  const watch = event.target.closest?.('[data-payson-playback], [data-payson-detail-watch]');
  if (watch) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void openPlayer({ type: watch.dataset.mediaType, id: watch.dataset.itemId, title: watch.dataset.title || '' });
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
    trailer.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
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
    button.dataset.title = button.closest('.poster-card')?.querySelector('.poster-title')?.textContent || '';
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
      trailer.dataset.paysonTrailer = '1';
      delete trailer.dataset.openTrailer;
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
  const heroPlay = document.getElementById('heroPlay');
  if (heroPlay?.dataset?.mediaType && heroPlay?.dataset?.itemId) {
    return {
      type: heroPlay.dataset.mediaType,
      id: heroPlay.dataset.itemId,
      title: heroPlay.dataset.title || document.querySelector('.hero-title')?.textContent?.trim() || ''
    };
  }

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
  const sessionToken = ++playerState.sessionToken;
  playerState.resolveToken += 1;
  playerState.sourceLoadToken += 1;
  cleanupMedia();
  playerState.media = { type, id: String(id), title: title || '' };
  playerState.season = 1;
  playerState.episode = 1;
  playerState.episodes = [];
  playerState.sources = [];
  playerState.responseId = null;
  playerState.refreshAttempted = false;
  playerState.sourceIndex = -1;
  playerState.failedSourceKeys.clear();

  ui.root.classList.remove('hidden');
  ui.root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  ui.title.textContent = title || 'Payson’s Movies';
  ui.subhead.textContent = type === 'tv' ? 'Series' : 'Movie';
  setStatus('Loading title details…');
  setFallback('');

  try {
    const details = await request(`/api/title/${type}/${encodeURIComponent(id)}`);
    if (sessionToken !== playerState.sessionToken || ui.root.classList.contains('hidden')) return;
    playerState.media.title = details.display_title || title || 'Untitled';
    playerState.media.poster = details.backdrop_url || details.poster_url || '';
    ui.title.textContent = playerState.media.title;
    ui.video.poster = details.backdrop_url || '';

    if (type === 'tv') {
      ui.episodeControls.classList.remove('hidden');
      const seasons = (details.seasons || []).filter((season) => season.season_number > 0);
      if (!seasons.length) {
        ui.season.innerHTML = '';
        ui.episode.innerHTML = '';
        updateEpisodeButtons();
        setStatus('No regular seasons are available for this series.');
        setFallback('No playable episodes were returned for this series.');
        return;
      }
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

async function loadSeasonAndResolve({ selectLast = false } = {}) {
  const sessionToken = playerState.sessionToken;
  const mediaId = playerState.media?.id;
  const seasonNumber = playerState.season;
  setStatus('Loading episodes…');
  try {
    const season = await request(`/api/tv/${mediaId}/season/${seasonNumber}`);
    if (sessionToken !== playerState.sessionToken || playerState.media?.id !== mediaId || playerState.season !== seasonNumber) return;
    playerState.episodes = season.episodes || [];
    ui.episode.innerHTML = playerState.episodes.map((episode) => `<option value="${episode.episode_number}">E${episode.episode_number} · ${escapeHtml(episode.name || 'Episode')}</option>`).join('');
    if (!playerState.episodes.length) {
      updateEpisodeButtons();
      setStatus('This season has no playable episodes.');
      setFallback('No episode metadata was returned for this season.');
      return;
    }
    if (selectLast) playerState.episode = playerState.episodes.at(-1)?.episode_number || 1;
    else if (!playerState.episodes.some((episode) => episode.episode_number === playerState.episode)) playerState.episode = playerState.episodes[0]?.episode_number || 1;
    ui.episode.value = String(playerState.episode);
    updateEpisodeButtons();
    await resolveAndPlay();
  } catch (error) {
    setStatus('Could not load this season.');
    setFallback(escapeHtml(error.message));
  }
}

async function resolveAndPlay({ refreshed = false } = {}) {
  const sessionToken = playerState.sessionToken;
  const resolveToken = ++playerState.resolveToken;
  playerState.sourceLoadToken += 1;
  cleanupMedia();
  setFallback('');
  setStatus(refreshed ? 'Refreshing servers…' : 'Resolving all available servers…');

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
    if (sessionToken !== playerState.sessionToken || resolveToken !== playerState.resolveToken || ui.root.classList.contains('hidden')) return;
    playerState.responseId = resolved.responseId || resolved.id || null;
    playerState.sources = rankSources(resolved.sources || []);
    playerState.failedSourceKeys.clear();
    renderSourceOptions();

    if (!playerState.sources.length) {
      setStatus('No playable server was returned for this title.');
      await renderWatchFallback(resolved.diagnostics || []);
      return;
    }

    const preferredIndex = preferredSourceIndex();
    await loadSource(preferredIndex, { manual: false });
  } catch (error) {
    if (sessionToken !== playerState.sessionToken || resolveToken !== playerState.resolveToken || ui.root.classList.contains('hidden')) return;
    setStatus('Could not resolve playback.');
    setFallback(escapeHtml(error.message));
  }
}

function rankSources(sources) {
  return [...sources].sort((a, b) => sourceRank(b) - sourceRank(a));
}

function sourceRank(source) {
  const metric = playerState.metrics[sourceMetricKey(source)] || {};
  const serverLatency = Number.isFinite(source.health?.latencyMs) ? source.health.latencyMs : 1800;
  const recentFailurePenalty = metric.lastFailure && Date.now() - metric.lastFailure < 30 * 60 * 1000 ? 5000 : 0;
  const latencyPenalty = Number.isFinite(metric.latencyMs) ? metric.latencyMs : serverLatency;
  const successBoost = Math.min(Number(metric.successes || 0), 10) * 45;
  const providerBoost = playerState.settings.preferredProvider && source.provider?.id === playerState.settings.preferredProvider ? 700 : 0;
  const onlinePenalty = source.health?.online === false ? 10000 : 0;
  const unsupportedPenalty = isBrowserSupportedSource(source) ? 0 : 20000;
  const sessionFailurePenalty = playerState.failedSourceKeys.has(sourceFailureKey(source)) ? 50000 : 0;
  return Number(source.score || 0) * 5 + successBoost + providerBoost - latencyPenalty - recentFailurePenalty - onlinePenalty - unsupportedPenalty - sessionFailurePenalty;
}

function isBrowserSupportedSource(source) {
  const type = String(source?.type || '').toLowerCase();
  const url = String(source?.url || '').toLowerCase();
  if (type === 'embed') return false;
  if (type === 'dash' || url.includes('.mpd')) return Boolean(ui.video?.canPlayType?.('application/dash+xml'));
  if (type === 'hls' || url.includes('.m3u8')) return Boolean(window.Hls?.isSupported?.() || ui.video?.canPlayType?.('application/vnd.apple.mpegurl'));
  if (type === 'mkv') return Boolean(ui.video?.canPlayType?.('video/x-matroska'));
  if (type === 'webm') return Boolean(ui.video?.canPlayType?.('video/webm'));
  if (type === 'mp4') return Boolean(ui.video?.canPlayType?.('video/mp4'));
  return true;
}

function preferredSourceIndex() {
  if (playerState.settings.autoServer) return bestSourceIndex();
  const preferred = playerState.sources.findIndex((source) => source.provider?.id === playerState.settings.preferredProvider);
  return preferred >= 0 ? preferred : 0;
}

function bestSourceIndex() {
  const eligible = playerState.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => isBrowserSupportedSource(source) && !playerState.failedSourceKeys.has(sourceFailureKey(source)));
  const pool = eligible.length ? eligible : playerState.sources.map((source, index) => ({ source, index }));
  let bestIndex = 0;
  let bestRank = -Infinity;
  pool.forEach(({ source, index }) => {
    const rank = sourceRank(source);
    if (rank > bestRank) {
      bestRank = rank;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function renderSourceOptions() {
  ui.server.innerHTML = playerState.sources.map((source, index) => {
    const metric = playerState.metrics[sourceMetricKey(source)];
    const measured = Number.isFinite(metric?.latencyMs) ? metric.latencyMs : source.health?.latencyMs;
    const latency = Number.isFinite(measured) ? `${measured}ms` : 'new';
    const state = !isBrowserSupportedSource(source) ? 'unsupported' : source.health?.online === false ? 'offline' : source.health?.online === true ? 'online' : 'unchecked';
    const label = `${source.provider?.name || `Server ${index + 1}`} · ${source.quality || 'Auto'} · ${state} · ${latency}`;
    return `<option value="${index}">${escapeHtml(label)}</option>`;
  }).join('');
  const providers = new Set(playerState.sources.map((source) => source.provider?.id || source.provider?.name));
  ui.summary.textContent = `${playerState.sources.length} source${playerState.sources.length === 1 ? '' : 's'} across ${providers.size} server${providers.size === 1 ? '' : 's'}. Auto mode prioritizes browser compatibility, quality, measured startup speed, and recent reliability.`;
}

async function loadSource(index, { manual = false } = {}) {
  const source = playerState.sources[index];
  if (!source) return;
  if (manual) playerState.failedSourceKeys.delete(sourceFailureKey(source));

  const resumeAt = Number.isFinite(ui.video.currentTime) ? ui.video.currentTime : 0;
  const sourceLoadToken = ++playerState.sourceLoadToken;
  cleanupMedia();
  playerState.sourceIndex = index;
  ui.server.value = String(index);
  ui.video.playbackRate = Number(playerState.settings.playbackRate || 1);
  ui.speed.value = String(ui.video.playbackRate);
  setStatus(`Connecting to ${source.provider?.name || 'server'}…`);
  resetTrackControls();
  applyExternalSubtitles(source.subtitles || [], sourceLoadToken).catch(() => {});
  playerState.loadStartedAt = performance.now();
  playerState.sourceLoadTimer = setTimeout(() => {
    if (sourceLoadToken === playerState.sourceLoadToken && playerState.sourceIndex === index) {
      void handlePlaybackFailure('startup-timeout');
    }
  }, 22000);

  ui.video.addEventListener('error', () => {
    if (sourceLoadToken === playerState.sourceLoadToken && playerState.sourceIndex === index) {
      void handlePlaybackFailure('video-error');
    }
  }, { once: true });

  const sourceType = String(source.type || '').toLowerCase();
  const isHls = sourceType === 'hls' || String(source.url).includes('.m3u8');
  const isDash = sourceType === 'dash' || String(source.url).includes('.mpd');

  if (!isBrowserSupportedSource(source)) {
    clearSourceLoadTimer();
    const reason = `${sourceType || 'source'}-unsupported`;
    if (!manual) return handlePlaybackFailure(reason);
    markFailure(source, reason);
    setStatus('This source format is not supported by this browser. Choose another server.');
    return;
  }

  if (isDash) {
    ui.video.src = source.url;
    ui.video.addEventListener('canplay', () => {
      if (sourceLoadToken === playerState.sourceLoadToken) playbackReady(source, resumeAt);
    }, { once: true });
    ui.video.load();
    return;
  }

  if (isHls && window.Hls?.isSupported()) {
    let mediaRecoveryAttempted = false;
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: true,
      backBufferLength: 45,
      maxBufferLength: 60,
      startLevel: -1,
      manifestLoadingTimeOut: 10000,
      levelLoadingTimeOut: 10000,
      fragLoadingTimeOut: 15000
    });
    playerState.hls = hls;
    hls.loadSource(source.url);
    hls.attachMedia(ui.video);

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (playerState.hls !== hls || sourceLoadToken !== playerState.sourceLoadToken) return;
      populateHlsQuality(hls);
      populateHlsAudio(hls);
    });
    ui.video.addEventListener('canplay', () => {
      if (playerState.hls === hls && sourceLoadToken === playerState.sourceLoadToken) playbackReady(source, resumeAt);
    }, { once: true });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (Number.isInteger(data.level)) ui.quality.value = String(data.level);
    });
    hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => populateHlsAudio(hls));
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (playerState.hls !== hls || sourceLoadToken !== playerState.sourceLoadToken) return;
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
        mediaRecoveryAttempted = true;
        try { hls.recoverMediaError(); return; } catch {}
      }
      void handlePlaybackFailure(`hls-${data.type || 'fatal'}`);
    });
    return;
  }

  if (isHls && ui.video.canPlayType('application/vnd.apple.mpegurl')) {
    ui.video.src = source.url;
    ui.video.addEventListener('canplay', () => {
      if (sourceLoadToken === playerState.sourceLoadToken) playbackReady(source, resumeAt);
    }, { once: true });
    ui.video.load();
    return;
  }

  ui.video.src = source.url;
  ui.video.addEventListener('canplay', () => {
    if (sourceLoadToken === playerState.sourceLoadToken) playbackReady(source, resumeAt);
  }, { once: true });
  ui.video.load();
}

function playbackReady(source, resumeAt = 0) {
  clearSourceLoadTimer();
  const latencyMs = Math.max(1, Math.round(performance.now() - playerState.loadStartedAt));
  markSuccess(source, latencyMs);
  renderSourceOptions();
  ui.server.value = String(playerState.sourceIndex);
  setStatus(`${source.provider?.name || 'Server'} connected · ${latencyMs}ms startup`);
  scheduleStatusHide();

  if (resumeAt > 0 && Number.isFinite(ui.video.duration) && resumeAt < ui.video.duration - 5) ui.video.currentTime = resumeAt;
  else restoreProgress();

  if (playerState.settings.autoplay) ui.video.play().catch(() => {});
}

function markSuccess(source, latencyMs) {
  const key = sourceMetricKey(source);
  const current = playerState.metrics[key] || {};
  playerState.metrics[key] = {
    ...current,
    latencyMs,
    successes: Number(current.successes || 0) + 1,
    lastSuccess: Date.now()
  };
  persistMetrics();
}

function markFailure(source, reason) {
  if (!source) return;
  const key = sourceMetricKey(source);
  const current = playerState.metrics[key] || {};
  playerState.metrics[key] = {
    ...current,
    failures: Number(current.failures || 0) + 1,
    lastFailure: Date.now(),
    lastFailureReason: reason
  };
  persistMetrics();
}

function sourceMetricKey(source) {
  return source?.provider?.id || source?.provider?.name || source?.id || source?.url || 'unknown-source';
}

function sourceFailureKey(source) {
  return source?.id || source?.url || sourceMetricKey(source);
}

function persistMetrics() {
  localStorage.setItem(PLAYER_METRICS_KEY, JSON.stringify(playerState.metrics));
}

async function handlePlaybackFailure(reason) {
  if (playerState.failoverLock || playerState.sourceIndex < 0) return;
  const sessionToken = playerState.sessionToken;
  playerState.failoverLock = true;

  try {
    const current = playerState.sources[playerState.sourceIndex];
    markFailure(current, reason);
    playerState.failedSourceKeys.add(sourceFailureKey(current));
    clearSourceLoadTimer();

    if (!playerState.settings.autoServer) {
      setStatus(`Server failed (${reason}). Choose another server.`);
      return;
    }

    const candidates = playerState.sources
      .map((source, index) => ({ source, index, rank: sourceRank(source) }))
      .filter(({ source, index }) => index !== playerState.sourceIndex && isBrowserSupportedSource(source) && !playerState.failedSourceKeys.has(sourceFailureKey(source)))
      .sort((a, b) => b.rank - a.rank);

    if (candidates.length) {
      const next = candidates[0];
      setStatus(`${current?.provider?.name || 'Server'} failed. Switching to ${next.source.provider?.name || 'another server'}…`);
      await loadSource(next.index, { manual: false });
      return;
    }

    if (!playerState.refreshAttempted && playerState.responseId) {
      playerState.refreshAttempted = true;
      setStatus('All current servers failed. Refreshing the server list…');
      await request('/api/playback/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: playerState.responseId })
      });
      if (sessionToken !== playerState.sessionToken || ui.root.classList.contains('hidden')) return;
      await resolveAndPlay({ refreshed: true });
      return;
    }

    setStatus('Every returned server failed.');
    await renderWatchFallback();
  } catch (error) {
    setStatus('Automatic server recovery failed.');
    setFallback(escapeHtml(error.message));
  } finally {
    playerState.failoverLock = false;
  }
}

function populateHlsQuality(hls) {
  const levels = hls.levels || [];
  ui.quality.innerHTML = '<option value="-1">Auto</option>' + levels.map((level, index) => `<option value="${index}">${level.height ? `${level.height}p` : `${Math.round((level.bitrate || 0) / 1000)} kbps`}</option>`).join('');
  ui.quality.disabled = levels.length === 0;

  const preference = String(playerState.settings.preferredQuality || 'Auto').toLowerCase();
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

function resetTrackControls() {
  ui.quality.innerHTML = '<option value="-1">Auto</option>';
  ui.quality.disabled = true;
  ui.audio.innerHTML = '<option value="">Default</option>';
  ui.audio.disabled = true;
  ui.subtitle.innerHTML = '<option value="off">Off</option>';
  [...ui.video.querySelectorAll('track')].forEach((track) => track.remove());
}

async function applyExternalSubtitles(subtitles, sourceLoadToken = playerState.sourceLoadToken) {
  revokeSubtitleObjectUrls();
  ui.subtitle.innerHTML = '<option value="off">Off</option>';
  [...ui.video.querySelectorAll('track')].forEach((track) => track.remove());

  for (let index = 0; index < subtitles.length; index += 1) {
    if (sourceLoadToken !== playerState.sourceLoadToken) return;
    const subtitle = subtitles[index];
    if (!subtitle?.url) continue;
    const label = subtitle.label || subtitle.language || `Subtitle ${index + 1}`;
    const format = String(subtitle.format || '').toLowerCase();
    let trackUrl = subtitle.url;

    if (format === 'srt' || trackUrl.toLowerCase().endsWith('.srt')) {
      try {
        const response = await fetch(trackUrl);
        if (response.ok) {
          const text = await response.text();
          const vtt = `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
          trackUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
          if (sourceLoadToken !== playerState.sourceLoadToken) {
            URL.revokeObjectURL(trackUrl);
            return;
          }
          playerState.subtitleObjectUrls.push(trackUrl);
        }
      } catch {}
    } else if (format && !['vtt', 'webvtt'].includes(format) && !trackUrl.toLowerCase().includes('.vtt')) {
      continue;
    }

    if (sourceLoadToken !== playerState.sourceLoadToken) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = subtitle.language || 'und';
    track.src = trackUrl;
    ui.video.appendChild(track);

    const option = document.createElement('option');
    option.value = String(ui.video.querySelectorAll('track').length - 1);
    option.textContent = label;
    ui.subtitle.appendChild(option);
  }
}

function applySubtitleSelection() {
  const selected = ui.subtitle.value;
  [...ui.video.textTracks].forEach((track, index) => {
    track.mode = selected !== 'off' && Number(selected) === index ? 'showing' : 'disabled';
  });
}

function cleanupMedia() {
  clearSourceLoadTimer();
  clearTimeout(playerState.statusHideTimer);
  playerState.statusHideTimer = null;
  revokeSubtitleObjectUrls();
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

function clearSourceLoadTimer() {
  clearTimeout(playerState.sourceLoadTimer);
  playerState.sourceLoadTimer = null;
}

function revokeSubtitleObjectUrls() {
  for (const url of playerState.subtitleObjectUrls) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  playerState.subtitleObjectUrls = [];
}

function progressKey() {
  if (!playerState.media) return '';
  return playerState.media.type === 'tv'
    ? `tv:${playerState.media.id}:${playerState.season}:${playerState.episode}`
    : `movie:${playerState.media.id}`;
}

function restoreProgress() {
  const key = progressKey();
  const saved = playerState.progress[key];
  if (!saved || !Number.isFinite(saved.time) || !Number.isFinite(ui.video.duration)) return;
  if (saved.time > 15 && saved.time < ui.video.duration - 20) ui.video.currentTime = saved.time;
}

function persistProgressThrottled() {
  const now = Date.now();
  if (now - playerState.lastProgressWrite < 3000) return;
  playerState.lastProgressWrite = now;
  const key = progressKey();
  if (!key || !Number.isFinite(ui.video.currentTime)) return;
  playerState.progress[key] = {
    time: ui.video.currentTime,
    duration: Number.isFinite(ui.video.duration) ? ui.video.duration : 0,
    updatedAt: now,
    title: playerState.media?.title || '',
    type: playerState.media?.type || '',
    id: playerState.media?.id || '',
    season: playerState.season,
    episode: playerState.episode
  };
  localStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify(playerState.progress));
}

function handleEnded() {
  const key = progressKey();
  if (key) {
    delete playerState.progress[key];
    localStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify(playerState.progress));
  }
  if (playerState.media?.type === 'tv' && playerState.settings.autoplay) void stepEpisode(1);
}

async function stepEpisode(direction) {
  if (playerState.media?.type !== 'tv' || !playerState.episodes.length) return;
  const currentIndex = playerState.episodes.findIndex((episode) => episode.episode_number === playerState.episode);
  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < playerState.episodes.length) {
    playerState.episode = playerState.episodes[nextIndex].episode_number;
    ui.episode.value = String(playerState.episode);
    updateEpisodeButtons();
    await resolveAndPlay();
    return;
  }

  const seasonIndex = ui.season.selectedIndex;
  const nextSeasonIndex = seasonIndex + direction;
  if (nextSeasonIndex < 0 || nextSeasonIndex >= ui.season.options.length) return;
  ui.season.selectedIndex = nextSeasonIndex;
  playerState.season = Number(ui.season.value);
  playerState.episode = 1;
  await loadSeasonAndResolve({ selectLast: direction < 0 });
}

function updateEpisodeButtons() {
  const index = playerState.episodes.findIndex((episode) => episode.episode_number === playerState.episode);
  const seasonIndex = ui.season.selectedIndex;
  const hasPreviousSeason = seasonIndex > 0;
  const hasNextSeason = seasonIndex >= 0 && seasonIndex < ui.season.options.length - 1;
  ui.prevEpisode.disabled = index < 0 || (index === 0 && !hasPreviousSeason);
  ui.nextEpisode.disabled = index < 0 || (index >= playerState.episodes.length - 1 && !hasNextSeason);
}

async function renderWatchFallback(diagnostics = []) {
  try {
    const watch = await request(`/api/watch/${playerState.media.type}/${playerState.media.id}`);
    const groups = [...(watch.flatrate || []), ...(watch.free || []), ...(watch.ads || []), ...(watch.rent || []), ...(watch.buy || [])];
    const unique = [...new Map(groups.map((provider) => [provider.provider_id, provider])).values()].slice(0, 12);
    const diagnosticText = diagnostics.length ? `<details><summary>Playback diagnostics</summary><pre>${escapeHtml(JSON.stringify(diagnostics, null, 2))}</pre></details>` : '';
    const providers = unique.length ? `<div class="payson-provider-list">${unique.map((provider) => `<span class="payson-provider-chip">${escapeHtml(provider.provider_name)}</span>`).join('')}</div>` : '<p>No alternate provider listing was returned.</p>';
    const link = watch.link ? `<a class="primary-button" href="${escapeAttribute(watch.link)}" target="_blank" rel="noopener noreferrer">View provider options</a>` : '';
    setFallback(`${providers}${link}${diagnosticText}`);
  } catch {
    setFallback('No working server is available right now. Try again later.');
  }
}

async function openTrailerFor(mediaType, id) {
  try {
    const details = await request(`/api/title/${mediaType}/${encodeURIComponent(id)}`);
    const trailer = details.trailer;
    if (!trailer?.key) return showToast('No trailer was found for this title.');
    const frame = document.getElementById('videoFrame');
    const modal = document.getElementById('videoModal');
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0&modestbranding=1`;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  } catch (error) {
    showToast(error.message);
  }
}

function closePlayer() {
  playerState.sessionToken += 1;
  playerState.resolveToken += 1;
  playerState.sourceLoadToken += 1;
  persistProgressThrottled();
  cleanupMedia();
  ui.root.classList.add('hidden');
  ui.root.setAttribute('aria-hidden', 'true');
  if (document.getElementById('detailModal')?.classList.contains('hidden') && document.getElementById('videoModal')?.classList.contains('hidden')) document.body.classList.remove('modal-open');
}

function setStatus(message) {
  clearTimeout(playerState.statusHideTimer);
  playerState.statusHideTimer = null;
  ui.status.textContent = message;
  ui.status.classList.remove('hidden');
}

function scheduleStatusHide() {
  clearTimeout(playerState.statusHideTimer);
  playerState.statusHideTimer = setTimeout(() => {
    if (!ui.root.classList.contains('hidden')) ui.status.classList.add('hidden');
    playerState.statusHideTimer = null;
  }, 2600);
}

function setFallback(html) {
  if (!html) {
    ui.fallback.innerHTML = '';
    ui.fallback.classList.add('hidden');
    return;
  }
  ui.fallback.innerHTML = html;
  ui.fallback.classList.remove('hidden');
}

function saveSettings() {
  localStorage.setItem(PLAYER_SETTINGS_KEY, JSON.stringify(playerState.settings));
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Request failed (${response.status})`);
  return data;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
