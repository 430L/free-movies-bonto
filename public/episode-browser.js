(() => {
  const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
  const PROGRESS_KEY = 'paysons-movies-playback-progress';
  const state = {
    showId: '',
    seasons: [],
    seasonData: new Map(),
    selectedSeason: 1,
    selectedEpisode: 1,
    fallbackImage: '',
    hooked: false,
    titleRequestSequence: 0,
    seasonRequestSequence: 0,
    resolveRequestSequence: 0
  };

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const requestUrl = resolveRequestUrl(args[0]);
    const seasonMatch = requestUrl.match(/\/api\/tv\/(\d+)\/season\/(\d+)(?:\?|$)/);
    const titleMatch = requestUrl.match(/\/api\/title\/tv\/(\d+)(?:\?|$)/);
    const resolveMatch = requestUrl.match(/\/api\/playback\/resolve\?(.+)$/);
    const titleRequestToken = titleMatch ? ++state.titleRequestSequence : 0;
    const seasonRequestToken = seasonMatch ? ++state.seasonRequestSequence : 0;
    const resolveRequestToken = resolveMatch ? ++state.resolveRequestSequence : 0;

    if (resolveMatch) {
      const params = new URLSearchParams(resolveMatch[1]);
      if (params.get('type') === 'tv') {
        const nextShowId = params.get('id') || state.showId;
        if (nextShowId && nextShowId !== state.showId) resetShowState(nextShowId);
        state.showId = nextShowId;
        state.selectedSeason = Number(params.get('season') || state.selectedSeason || 1);
        state.selectedEpisode = Number(params.get('episode') || state.selectedEpisode || 1);
        syncSelection();
        startResolveStatusHints();
      }
    }

    let response;
    try {
      response = await originalFetch(...args);
    } catch (error) {
      if (resolveMatch && resolveRequestToken === state.resolveRequestSequence) clearResolveStatusHints();
      throw error;
    }

    if (titleMatch && response.ok) {
      void response.clone().json().then((data) => {
        if (titleRequestToken !== state.titleRequestSequence) return;
        const nextShowId = titleMatch[1];
        if (nextShowId !== state.showId) resetShowState(nextShowId);
        state.showId = nextShowId;
        state.seasons = (data.seasons || []).filter((season) => season.season_number > 0);
        state.fallbackImage = data.backdrop_url || data.poster_url || '';
        if (!state.seasons.some((season) => season.season_number === state.selectedSeason)) {
          state.selectedSeason = state.seasons[0]?.season_number || 1;
          state.selectedEpisode = 1;
        }
        renderSeasonTabs();
        renderBrowser();
      }).catch(() => {});
    }

    if (seasonMatch && response.ok) {
      void response.clone().json().then((data) => {
        if (seasonRequestToken !== state.seasonRequestSequence) return;
        const responseShowId = seasonMatch[1];
        if (state.showId && responseShowId !== state.showId) return;
        state.showId = responseShowId;
        const responseSeason = Number(seasonMatch[2]);
        state.seasonData.set(responseSeason, data);
        if (responseSeason === Number(document.getElementById('paysonSeasonSelect')?.value || state.selectedSeason)) {
          state.selectedSeason = responseSeason;
        }
        renderBrowser();
      }).catch(() => {});
    }

    if (resolveMatch && resolveRequestToken === state.resolveRequestSequence) clearResolveStatusHints();
    return response;
  };

  function resetShowState(showId = '') {
    state.showId = showId;
    state.seasons = [];
    state.seasonData.clear();
    state.selectedSeason = 1;
    state.selectedEpisode = 1;
    state.fallbackImage = '';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  function boot() {
    ensureBrowser();
    const observer = new MutationObserver(() => ensureBrowser());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (event) => {
      if (event.key === PROGRESS_KEY) renderBrowser();
    });
  }

  function ensureBrowser() {
    const controls = document.getElementById('paysonEpisodeControls');
    if (!controls || controls.dataset.richEpisodeBrowser === '1') return;

    controls.dataset.richEpisodeBrowser = '1';
    controls.classList.add('payson-episode-controls-rich');

    const rich = document.createElement('section');
    rich.className = 'payson-rich-episode-browser';
    rich.innerHTML = `
      <div class="payson-rich-episode-head">
        <div>
          <div class="payson-rich-kicker">Episode Browser</div>
          <h3 id="paysonRichSeasonTitle">Season</h3>
          <p id="paysonRichSeasonMeta"></p>
        </div>
      </div>
      <div id="paysonRichSeasonTabs" class="payson-rich-season-tabs" role="tablist" aria-label="Seasons"></div>
      <div id="paysonRichCurrentEpisode" class="payson-rich-current-episode"></div>
      <div id="paysonRichEpisodeGrid" class="payson-rich-episode-grid"></div>
    `;
    controls.prepend(rich);

    rich.querySelector('#paysonRichSeasonTabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-rich-season]');
      if (!button) return;
      chooseSeason(Number(button.dataset.richSeason));
    });

    rich.querySelector('#paysonRichEpisodeGrid').addEventListener('click', (event) => {
      const card = event.target.closest('[data-rich-episode]');
      if (!card) return;
      chooseEpisode(Number(card.dataset.richEpisode));
    });

    const seasonSelect = document.getElementById('paysonSeasonSelect');
    const episodeSelect = document.getElementById('paysonEpisodeSelect');
    seasonSelect?.addEventListener('change', () => {
      state.selectedSeason = Number(seasonSelect.value || 1);
      state.selectedEpisode = 1;
      syncSelection();
    });
    episodeSelect?.addEventListener('change', () => {
      state.selectedEpisode = Number(episodeSelect.value || 1);
      syncSelection();
    });

    state.hooked = true;
    renderSeasonTabs();
    renderBrowser();
  }

  function chooseSeason(season) {
    if (!Number.isInteger(season) || season < 1) return;
    const select = document.getElementById('paysonSeasonSelect');
    if (!select) return;
    state.selectedSeason = season;
    state.selectedEpisode = 1;
    select.value = String(season);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    renderSeasonTabs();
  }

  function chooseEpisode(episode) {
    if (!Number.isInteger(episode) || episode < 1) return;
    const select = document.getElementById('paysonEpisodeSelect');
    if (!select) return;
    state.selectedEpisode = episode;
    select.value = String(episode);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncSelection();
  }

  function renderSeasonTabs() {
    const root = document.getElementById('paysonRichSeasonTabs');
    if (!root) return;

    const seasonSelect = document.getElementById('paysonSeasonSelect');
    if (seasonSelect?.value) state.selectedSeason = Number(seasonSelect.value);

    const seasons = state.seasons.length
      ? state.seasons
      : [...(seasonSelect?.options || [])].map((option) => ({
          season_number: Number(option.value),
          name: option.textContent,
          episode_count: 0
        })).filter((season) => Number.isInteger(season.season_number) && season.season_number > 0);

    root.innerHTML = seasons.map((season) => {
      const active = season.season_number === state.selectedSeason;
      return `<button type="button" class="payson-rich-season-tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" data-rich-season="${season.season_number}">
        <span>${escapeHtml(season.name || `Season ${season.season_number}`)}</span>
        ${season.episode_count ? `<small>${season.episode_count} episodes</small>` : ''}
      </button>`;
    }).join('');
  }

  function renderBrowser() {
    const grid = document.getElementById('paysonRichEpisodeGrid');
    const current = document.getElementById('paysonRichCurrentEpisode');
    const title = document.getElementById('paysonRichSeasonTitle');
    const meta = document.getElementById('paysonRichSeasonMeta');
    if (!grid || !current || !title || !meta) return;

    const seasonSelect = document.getElementById('paysonSeasonSelect');
    const episodeSelect = document.getElementById('paysonEpisodeSelect');
    if (seasonSelect?.value) state.selectedSeason = Number(seasonSelect.value || state.selectedSeason);
    if (episodeSelect?.value) state.selectedEpisode = Number(episodeSelect.value || state.selectedEpisode);

    renderSeasonTabs();
    const season = state.seasonData.get(state.selectedSeason);
    if (!season) {
      title.textContent = seasonSelect?.selectedOptions?.[0]?.textContent || `Season ${state.selectedSeason}`;
      meta.textContent = 'Loading episode artwork and details…';
      grid.innerHTML = skeletonMarkup(6);
      current.innerHTML = '';
      return;
    }

    const episodes = season.episodes || [];
    title.textContent = season.name || `Season ${state.selectedSeason}`;
    const metaParts = [];
    if (season.air_date) metaParts.push(formatDate(season.air_date));
    if (episodes.length) metaParts.push(`${episodes.length} episode${episodes.length === 1 ? '' : 's'}`);
    if (season.overview) metaParts.push(season.overview);
    meta.textContent = metaParts.join(' · ');

    const selected = episodes.find((episode) => episode.episode_number === state.selectedEpisode) || episodes[0];
    if (selected) {
      const image = selected.still_path ? `${IMAGE_BASE}${selected.still_path}` : state.fallbackImage;
      const progress = progressFor(selected.episode_number);
      current.innerHTML = `
        <div class="payson-rich-current-art">${image ? `<img src="${escapeAttr(image)}" alt="" decoding="async" />` : ''}</div>
        <div class="payson-rich-current-copy">
          <div class="payson-rich-current-number">S${state.selectedSeason} · E${selected.episode_number}${selected.runtime ? ` · ${selected.runtime} min` : ''}</div>
          <h4>${escapeHtml(selected.name || `Episode ${selected.episode_number}`)}</h4>
          <p>${escapeHtml(selected.overview || 'Episode information is not available yet.')}</p>
          <small>${selected.air_date ? escapeHtml(formatDate(selected.air_date)) : ''}${progress > 0 ? ` · ${Math.round(progress)}% watched` : ''}</small>
        </div>`;
    } else {
      current.innerHTML = '';
    }

    grid.innerHTML = episodes.map(episodeCard).join('') || '<div class="payson-rich-empty">No episodes were returned for this season.</div>';
    requestAnimationFrame(() => grid.querySelector('.is-active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
  }

  function episodeCard(episode) {
    const active = episode.episode_number === state.selectedEpisode;
    const image = episode.still_path ? `${IMAGE_BASE}${episode.still_path}` : '';
    const progress = progressFor(episode.episode_number);
    const subline = [episode.runtime ? `${episode.runtime} min` : '', episode.air_date ? formatDate(episode.air_date) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="payson-rich-episode-card${active ? ' is-active' : ''}" data-rich-episode="${episode.episode_number}" aria-pressed="${active}">
      <span class="payson-rich-thumb">
        ${image ? `<img src="${escapeAttr(image)}" alt="" loading="lazy" decoding="async" />` : '<span class="payson-rich-thumb-empty">No preview</span>'}
        <span class="payson-rich-episode-badge">E${episode.episode_number}</span>
        <span class="payson-rich-play">▶</span>
        ${progress > 0 ? `<span class="payson-rich-progress"><span style="width:${Math.min(100, progress)}%"></span></span>` : ''}
      </span>
      <span class="payson-rich-card-copy">
        <strong>${escapeHtml(episode.name || `Episode ${episode.episode_number}`)}</strong>
        <span>${escapeHtml(subline)}</span>
        <small>${escapeHtml(episode.overview || 'No episode summary available.')}</small>
      </span>
    </button>`;
  }

  function syncSelection() {
    renderSeasonTabs();
    renderBrowser();
  }

  function progressFor(episodeNumber) {
    const progress = loadProgress();
    const entry = progress[`tv:${state.showId}:${state.selectedSeason}:${episodeNumber}`];
    if (!entry || !Number.isFinite(entry.time) || !Number.isFinite(entry.duration) || entry.duration <= 0) return 0;
    return Math.max(0, Math.min(100, (entry.time / entry.duration) * 100));
  }

  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  let slowTimer = null;
  let verySlowTimer = null;
  function startResolveStatusHints() {
    clearResolveStatusHints();
    slowTimer = setTimeout(() => setPlayerStatus('Still checking available servers…'), 9000);
    verySlowTimer = setTimeout(() => setPlayerStatus('This title is taking longer than usual to resolve. You can leave the player open while the backend finishes.'), 22000);
  }

  function clearResolveStatusHints() {
    clearTimeout(slowTimer);
    clearTimeout(verySlowTimer);
    slowTimer = null;
    verySlowTimer = null;
  }

  function setPlayerStatus(message) {
    const status = document.getElementById('paysonPlayerStatus');
    if (status) status.textContent = message;
  }

  function skeletonMarkup(count) {
    return Array.from({ length: count }, () => '<div class="payson-rich-skeleton"><span></span><span></span></div>').join('');
  }

  function resolveRequestUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input instanceof Request) return new URL(input.url, location.href).href;
      return '';
    } catch { return ''; }
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttr(value) { return escapeHtml(value); }
})();
