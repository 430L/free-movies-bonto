const state = {
  config: null,
  home: null,
  featuredItems: [],
  featuredIndex: 0,
  watchlist: loadLocal('paysons-movies-watchlist'),
  recentlyViewed: loadLocal('paysons-movies-history'),
  currentFilter: 'all',
  currentSearch: '',
  searchResults: [],
  searchSequence: 0,
  detailsCache: new Map(),
  heroTimer: null
};

const elements = {
  hero: document.getElementById('hero'),
  heroPlay: document.getElementById('heroPlay'),
  heroDetails: document.getElementById('heroDetails'),
  heroList: document.getElementById('heroList'),
  heroPrev: document.getElementById('heroPrev'),
  heroNext: document.getElementById('heroNext'),
  heroDots: document.getElementById('heroDots'),
  sectionsRoot: document.getElementById('sectionsRoot'),
  searchInput: document.getElementById('searchInput'),
  clearSearch: document.getElementById('clearSearch'),
  searchResults: document.getElementById('searchResults'),
  searchGrid: document.getElementById('searchGrid'),
  searchMeta: document.getElementById('searchMeta'),
  myListSection: document.getElementById('myListSection'),
  myListGrid: document.getElementById('myListGrid'),
  recentlyViewedSection: document.getElementById('recentlyViewedSection'),
  recentlyViewedGrid: document.getElementById('recentlyViewedGrid'),
  clearHistory: document.getElementById('clearHistory'),
  detailModal: document.getElementById('detailModal'),
  detailContent: document.getElementById('detailContent'),
  videoModal: document.getElementById('videoModal'),
  videoFrame: document.getElementById('videoFrame'),
  rowTemplate: document.getElementById('rowTemplate'),
  navTabs: [...document.querySelectorAll('.nav-tab')]
};

init();

async function init() {
  attachEvents();

  try {
    [state.config, state.home] = await Promise.all([
      request('/api/config'),
      request('/api/home')
    ]);

    state.featuredItems = state.home.featuredItems?.length
      ? state.home.featuredItems
      : state.home.featured
        ? [state.home.featured]
        : [];

    if (!state.featuredItems.length) throw new Error('No featured titles were returned by TMDB.');

    renderFeatured();
    renderRows();
    renderMyList();
    renderRecentlyViewed();
    applyViewState();
    startHeroRotation();
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    renderFatalError(error.message);
  }
}

function attachEvents() {
  elements.heroPlay.addEventListener('click', async () => {
    const featured = getFeatured();
    if (featured) requestPlayback(featured);
  });

  elements.heroDetails.addEventListener('click', async () => {
    const featured = getFeatured();
    if (featured) await openDetails(featured.media_type, featured.id);
  });

  elements.heroList.addEventListener('click', () => {
    const featured = getFeatured();
    if (featured) toggleWatchlist(featured);
  });

  elements.heroPrev.addEventListener('click', () => stepFeatured(-1, true));
  elements.heroNext.addEventListener('click', () => stepFeatured(1, true));
  elements.clearHistory.addEventListener('click', clearHistory);

  elements.searchInput.addEventListener('input', debounce(handleSearch, 320));
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearSearch();
  });
  elements.clearSearch.addEventListener('click', clearSearch);

  elements.navTabs.forEach((button) => {
    button.addEventListener('click', () => setActiveTab(button.dataset.filter));
  });

  document.body.addEventListener('click', async (event) => {
    const closeDetail = event.target.closest('[data-close-modal]');
    if (closeDetail) {
      closeDetails();
      return;
    }

    const closeVideo = event.target.closest('[data-close-video]');
    if (closeVideo) {
      closeVideoModal();
      return;
    }

    const trailerButton = event.target.closest('[data-open-trailer]');
    if (trailerButton) {
      event.preventDefault();
      event.stopPropagation();
      await playTrailerFor(trailerButton.dataset.mediaType, trailerButton.dataset.itemId);
      return;
    }

    const toggleButton = event.target.closest('[data-toggle-watchlist]');
    if (toggleButton) {
      event.preventDefault();
      event.stopPropagation();
      toggleWatchlist(itemFromDataset(toggleButton.dataset));
      refreshOpenDetailButton(toggleButton.dataset.itemId, toggleButton.dataset.mediaType);
      return;
    }

    const dot = event.target.closest('[data-hero-index]');
    if (dot) {
      state.featuredIndex = Number(dot.dataset.heroIndex);
      renderFeatured();
      restartHeroRotation();
      return;
    }

    const card = event.target.closest('[data-open-title]');
    if (card) await openDetails(card.dataset.mediaType, card.dataset.itemId);
  });

  document.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') {
      closeDetails();
      closeVideoModal();
      return;
    }

    const card = event.target.closest?.('[data-open-title]');
    if (!card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    await openDetails(card.dataset.mediaType, card.dataset.itemId);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopHeroRotation();
    else startHeroRotation();
  });
}

function setActiveTab(filter) {
  state.currentFilter = filter;
  elements.navTabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.filter === filter));
  applyViewState();
}

function applyViewState() {
  if (!state.home) return;

  const searching = Boolean(state.currentSearch);
  const myList = state.currentFilter === 'list';

  elements.hero.classList.toggle('hidden', searching || myList);
  elements.sectionsRoot.classList.toggle('hidden', searching || myList);
  elements.searchResults.classList.toggle('hidden', !searching);
  elements.myListSection.classList.toggle('hidden', !myList || searching);
  elements.recentlyViewedSection.classList.toggle(
    'hidden',
    searching || myList || state.currentFilter !== 'all' || state.recentlyViewed.length === 0
  );

  renderRows();
  renderMyList();
  if (searching) renderSearchResults();
}

async function handleSearch() {
  const query = elements.searchInput.value.trim();
  state.currentSearch = query;
  const sequence = ++state.searchSequence;

  if (!query) {
    state.searchResults = [];
    elements.searchMeta.textContent = '';
    elements.searchGrid.innerHTML = '';
    applyViewState();
    return;
  }

  elements.searchMeta.textContent = `Searching for “${query}”…`;
  elements.searchGrid.innerHTML = '<div class="empty-state">Searching the catalog…</div>';
  applyViewState();

  try {
    const data = await request(`/api/search?q=${encodeURIComponent(query)}`);
    if (sequence !== state.searchSequence) return;
    state.searchResults = data.results;
    renderSearchResults();
  } catch (error) {
    if (sequence !== state.searchSequence) return;
    elements.searchMeta.textContent = 'Search failed';
    elements.searchGrid.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderSearchResults() {
  const results = filterByActiveType(state.searchResults);
  const label = state.currentFilter === 'movie' ? 'movie' : state.currentFilter === 'tv' ? 'TV' : 'catalog';
  elements.searchMeta.textContent = `${results.length} ${label} result${results.length === 1 ? '' : 's'} for “${state.currentSearch}”`;
  renderGrid(elements.searchGrid, results);
}

function clearSearch() {
  elements.searchInput.value = '';
  state.currentSearch = '';
  state.searchResults = [];
  state.searchSequence += 1;
  elements.searchMeta.textContent = '';
  elements.searchGrid.innerHTML = '';
  applyViewState();
}

function getFeatured() {
  return state.featuredItems[state.featuredIndex] || null;
}

function renderFeatured() {
  const item = getFeatured();
  if (!item) return;

  const backdrop = item.backdrop_path ? `${state.config.imageBase}/w1280${item.backdrop_path}` : '';
  const heroBackdrop = elements.hero.querySelector('.hero-backdrop');

  elements.hero.classList.remove('loading-state');
  heroBackdrop.style.backgroundImage = backdrop ? `url(${JSON.stringify(backdrop).slice(1, -1)})` : '';
  elements.hero.querySelector('.hero-title').textContent = item.title;
  elements.hero.querySelector('.hero-overview').textContent = item.overview || 'No overview available.';
  elements.hero.querySelector('.hero-meta').innerHTML = buildMetaChips(item);
  elements.heroPlay.disabled = false;
  elements.heroDetails.disabled = false;
  elements.heroList.disabled = false;
  elements.heroList.textContent = isInWatchlist(item.id, item.media_type) ? 'Remove from My List' : 'Add to My List';
  elements.heroPlay.dataset.mediaType = item.media_type;
  elements.heroPlay.dataset.itemId = String(item.id);
  elements.heroPlay.dataset.title = item.title || '';

  elements.heroDots.innerHTML = state.featuredItems.map((_, index) => `
    <button
      class="hero-dot${index === state.featuredIndex ? ' is-active' : ''}"
      type="button"
      data-hero-index="${index}"
      aria-label="Show featured title ${index + 1}"
      aria-current="${index === state.featuredIndex ? 'true' : 'false'}"
    ></button>
  `).join('');
}

function stepFeatured(direction, userInitiated = false) {
  if (state.featuredItems.length < 2) return;
  state.featuredIndex = (state.featuredIndex + direction + state.featuredItems.length) % state.featuredItems.length;
  renderFeatured();
  if (userInitiated) restartHeroRotation();
}

function startHeroRotation() {
  if (state.heroTimer || state.featuredItems.length < 2 || document.hidden) return;
  state.heroTimer = window.setInterval(() => stepFeatured(1), 9000);
}

function stopHeroRotation() {
  if (!state.heroTimer) return;
  clearInterval(state.heroTimer);
  state.heroTimer = null;
}

function restartHeroRotation() {
  stopHeroRotation();
  startHeroRotation();
}

function renderRows() {
  if (!state.home) return;
  elements.sectionsRoot.innerHTML = '';

  for (const section of state.home.sections) {
    const filteredItems = filterByActiveType(section.items);
    if (!filteredItems.length) continue;

    const node = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.section = section.id;
    node.querySelector('.section-eyebrow').textContent = section.id.replaceAll('-', ' ');
    node.querySelector('.section-title').textContent = section.title;
    node.querySelector('.section-copy').textContent = section.subtitle;

    const row = node.querySelector('.poster-row');
    filteredItems.forEach((item) => row.appendChild(createPosterCard(item)));

    node.querySelector('.shelf-nav-left').addEventListener('click', () => row.scrollBy({ left: -row.clientWidth * 0.86, behavior: 'smooth' }));
    node.querySelector('.shelf-nav-right').addEventListener('click', () => row.scrollBy({ left: row.clientWidth * 0.86, behavior: 'smooth' }));

    elements.sectionsRoot.appendChild(node);
  }
}

function filterByActiveType(items) {
  if (state.currentFilter === 'movie') return items.filter((item) => item.media_type === 'movie');
  if (state.currentFilter === 'tv') return items.filter((item) => item.media_type === 'tv');
  return items;
}

function renderGrid(root, items) {
  root.innerHTML = '';
  if (!items.length) {
    root.innerHTML = '<div class="empty-state">Nothing is on this shelf yet.</div>';
    return;
  }
  items.forEach((item) => root.appendChild(createPosterCard(item, true)));
}

function renderMyList() {
  renderGrid(elements.myListGrid, filterByActiveType(state.watchlist));
}

function renderRecentlyViewed() {
  renderGrid(elements.recentlyViewedGrid, state.recentlyViewed);
  if (state.home) applyRecentlyViewedVisibility();
}

function applyRecentlyViewedVisibility() {
  const hidden = Boolean(state.currentSearch) || state.currentFilter !== 'all' || state.recentlyViewed.length === 0;
  elements.recentlyViewedSection.classList.toggle('hidden', hidden);
}

function createPosterCard(item, dense = false) {
  const card = document.createElement('article');
  card.className = 'poster-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.openTitle = 'true';
  card.dataset.itemId = item.id;
  card.dataset.mediaType = item.media_type;

  const posterUrl = item.poster_path ? `${state.config.imageBase}/w500${item.poster_path}` : '';
  const releaseYear = item.release_date ? item.release_date.slice(0, 4) : '—';
  const badge = item.media_type === 'movie' ? 'Movie' : 'TV';
  const score = item.vote_average ? item.vote_average.toFixed(1) : '—';
  const overview = item.overview || 'No synopsis available.';
  const trimmed = overview.length > (dense ? 72 : 88) ? `${overview.slice(0, dense ? 69 : 85)}…` : overview;
  const saved = isInWatchlist(item.id, item.media_type);

  card.innerHTML = `
    <div class="poster-overlay-actions">
      <button class="icon-button" type="button" title="Watch now" data-payson-playback="true" data-media-type="${item.media_type}" data-item-id="${item.id}" data-title="${escapeAttribute(item.title)}">▶</button>
      <button class="icon-button payson-trailer-button" type="button" title="Trailer" data-payson-trailer="true" data-media-type="${item.media_type}" data-item-id="${item.id}">T</button>
      <button class="icon-button" type="button" title="${saved ? 'Remove from My List' : 'Add to My List'}" data-toggle-watchlist="true" ${datasetAttributes(item)}>${saved ? '✓' : '+'}</button>
    </div>
    <div class="poster-image-wrap">
      ${posterUrl ? `<img class="poster-image" src="${posterUrl}" alt="Poster for ${escapeHtml(item.title)}" loading="lazy" />` : `<div class="poster-fallback">${escapeHtml(item.title)}</div>`}
    </div>
    <div class="poster-info">
      <div class="poster-topline"><span>${badge}</span><span>★ ${score}</span></div>
      <h3 class="poster-title">${escapeHtml(item.title)}</h3>
      <div class="poster-subtitle">${releaseYear} • ${escapeHtml(trimmed)}</div>
    </div>
  `;

  return card;
}

async function openDetails(mediaType, id) {
  try {
    const details = await getDetails(mediaType, id);
    rememberViewed(details);

    const creators = [...new Set([
      ...(details.created_by || []).map((member) => member.name),
      ...(details.crew || []).map((member) => member.name)
    ].filter(Boolean))].join(', ') || 'Not listed';
    const genres = (details.genres || []).map((genre) => genre.name).join(', ') || 'Uncategorized';
    const seasons = details.number_of_seasons ? `${details.number_of_seasons} season${details.number_of_seasons === 1 ? '' : 's'}` : null;
    const runtime = details.runtime ? `${details.runtime} min` : seasons;
    const rows = details.recommendations?.length ? details.recommendations : details.similar || [];
    const backdropStyle = details.backdrop_url ? `url('${escapeAttribute(details.backdrop_url)}')` : 'none';

    elements.detailContent.innerHTML = `
      <section class="detail-hero" style="--detail-backdrop:${backdropStyle}">
        <div class="detail-poster">
          ${details.poster_url ? `<img src="${details.poster_url}" alt="Poster for ${escapeHtml(details.display_title)}" />` : `<div class="poster-fallback">${escapeHtml(details.display_title)}</div>`}
        </div>
        <div class="detail-copy">
          <div class="eyebrow">${details.media_type === 'movie' ? 'Feature Presentation' : 'Series Spotlight'}</div>
          <h2>${escapeHtml(details.display_title)}</h2>
          <div class="detail-meta">
            <span class="chip">${details.display_date ? details.display_date.slice(0, 4) : 'Unknown year'}</span>
            <span class="chip">★ ${Number(details.vote_average || 0).toFixed(1)}</span>
            ${runtime ? `<span class="chip">${runtime}</span>` : ''}
            ${details.rating ? `<span class="chip">${escapeHtml(details.rating)}</span>` : ''}
          </div>
          <p class="detail-overview">${escapeHtml(details.overview || 'No overview available yet.')}</p>
          <div class="detail-actions">
            <button class="primary-button" data-payson-detail-watch="true" data-media-type="${details.media_type}" data-item-id="${details.id}" data-title="${escapeAttribute(details.display_title)}">Watch Now</button>
            <button class="secondary-button" ${details.trailer ? `data-payson-trailer="true" data-media-type="${details.media_type}" data-item-id="${details.id}"` : 'disabled'}>${details.trailer ? 'Trailer' : 'No Trailer Available'}</button>
            <button class="secondary-button detail-watchlist-button" data-toggle-watchlist="true" ${datasetAttributes({
              id: details.id,
              media_type: details.media_type,
              title: details.display_title,
              overview: details.overview,
              poster_path: details.poster_path,
              backdrop_path: details.backdrop_path,
              release_date: details.display_date,
              vote_average: details.vote_average
            })}>${isInWatchlist(details.id, details.media_type) ? 'Remove from My List' : 'Add to My List'}</button>
          </div>
        </div>
      </section>
      <section class="detail-grid">
        <div>
          <div class="detail-section">
            <h3>Overview</h3>
            <div class="text-stack">
              <div class="keyline"><strong>Genres:</strong> ${escapeHtml(genres)}</div>
              <div class="keyline"><strong>Creative Team:</strong> ${escapeHtml(creators)}</div>
              <div class="keyline"><strong>Status:</strong> ${escapeHtml(details.status || 'Unknown')}</div>
              ${details.tagline ? `<div class="keyline"><strong>Tagline:</strong> ${escapeHtml(details.tagline)}</div>` : ''}
            </div>
          </div>
          <div class="detail-section">
            <h3>Cast</h3>
            <div class="cast-grid">
              ${(details.cast || []).map((member) => `
                <article class="cast-card">
                  ${member.profile_path ? `<img class="cast-photo" src="${state.config.imageBase}/w300${member.profile_path}" alt="${escapeHtml(member.name)}" loading="lazy" />` : `<div class="poster-fallback cast-photo">${escapeHtml(member.name)}</div>`}
                  <div class="cast-name">${escapeHtml(member.name)}</div>
                  <div class="cast-role">${escapeHtml(member.character || 'Cast')}</div>
                </article>
              `).join('') || '<div class="empty-state">No cast information is available.</div>'}
            </div>
          </div>
        </div>
        <div>
          <div class="detail-section">
            <h3>You May Also Like</h3>
            <div class="poster-grid recommendations-grid">
              ${rows.length ? rows.slice(0, 6).map(recommendationCardMarkup).join('') : '<div class="empty-state">No recommendations yet.</div>'}
            </div>
          </div>
        </div>
      </section>
    `;

    elements.detailModal.classList.remove('hidden');
    elements.detailModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    elements.detailModal.querySelector('.modal-close')?.focus();
  } catch (error) {
    showToast(error.message);
  }
}

function requestPlayback(item) {
  window.dispatchEvent(new CustomEvent('payson:play', {
    detail: {
      type: item.media_type,
      id: String(item.id),
      title: item.title || item.display_title || ''
    }
  }));
}

function recommendationCardMarkup(item) {
  const posterUrl = item.poster_path ? `${state.config.imageBase}/w500${item.poster_path}` : '';
  const releaseYear = item.release_date ? item.release_date.slice(0, 4) : '—';

  return `
    <article class="poster-card compact-poster" tabindex="0" role="button" data-open-title="true" data-item-id="${item.id}" data-media-type="${item.media_type}">
      <div class="poster-image-wrap">
        ${posterUrl ? `<img class="poster-image" src="${posterUrl}" alt="Poster for ${escapeHtml(item.title)}" loading="lazy" />` : `<div class="poster-fallback">${escapeHtml(item.title)}</div>`}
      </div>
      <div class="poster-info">
        <div class="poster-topline"><span>${item.media_type === 'movie' ? 'Movie' : 'TV'}</span><span>${releaseYear}</span></div>
        <h3 class="poster-title">${escapeHtml(item.title)}</h3>
      </div>
    </article>
  `;
}

function closeDetails() {
  if (elements.detailModal.classList.contains('hidden')) return;
  elements.detailModal.classList.add('hidden');
  elements.detailModal.setAttribute('aria-hidden', 'true');
  if (elements.videoModal.classList.contains('hidden')) document.body.classList.remove('modal-open');
}

async function playTrailerFor(mediaType, id) {
  try {
    const details = await getDetails(mediaType, id);
    openTrailer(details.trailer);
  } catch (error) {
    showToast(error.message);
  }
}

function openTrailer(trailer) {
  if (!trailer?.key) {
    showToast('No trailer was found for this title.');
    return;
  }

  elements.videoFrame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0&modestbranding=1`;
  elements.videoModal.classList.remove('hidden');
  elements.videoModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeVideoModal() {
  if (elements.videoModal.classList.contains('hidden')) return;
  elements.videoFrame.src = '';
  elements.videoModal.classList.add('hidden');
  elements.videoModal.setAttribute('aria-hidden', 'true');
  if (elements.detailModal.classList.contains('hidden')) document.body.classList.remove('modal-open');
}

async function getDetails(mediaType, id) {
  const key = `${mediaType}:${id}`;
  if (state.detailsCache.has(key)) return state.detailsCache.get(key);
  const details = await request(`/api/title/${encodeURIComponent(mediaType)}/${encodeURIComponent(id)}`);
  state.detailsCache.set(key, details);
  return details;
}

function rememberViewed(details) {
  const item = {
    id: details.id,
    media_type: details.media_type,
    title: details.display_title,
    overview: details.overview || '',
    poster_path: details.poster_path || '',
    backdrop_path: details.backdrop_path || '',
    release_date: details.display_date || '',
    vote_average: Number(details.vote_average || 0)
  };

  state.recentlyViewed = [
    item,
    ...state.recentlyViewed.filter((entry) => !(entry.id === item.id && entry.media_type === item.media_type))
  ].slice(0, 12);

  persistLocal('paysons-movies-history', state.recentlyViewed);
  renderRecentlyViewed();
}

function clearHistory() {
  state.recentlyViewed = [];
  persistLocal('paysons-movies-history', state.recentlyViewed);
  renderRecentlyViewed();
  showToast('Recently viewed history cleared.');
}

function toggleWatchlist(item) {
  const existingIndex = state.watchlist.findIndex((entry) => Number(entry.id) === Number(item.id) && entry.media_type === item.media_type);

  if (existingIndex >= 0) {
    state.watchlist.splice(existingIndex, 1);
    showToast(`Removed “${item.title}” from My List`);
  } else {
    state.watchlist.unshift(item);
    showToast(`Saved “${item.title}” to My List`);
  }

  persistLocal('paysons-movies-watchlist', state.watchlist);
  renderMyList();
  renderRows();

  const featured = getFeatured();
  if (featured && Number(featured.id) === Number(item.id) && featured.media_type === item.media_type) {
    elements.heroList.textContent = isInWatchlist(item.id, item.media_type) ? 'Remove from My List' : 'Add to My List';
  }
}

function refreshOpenDetailButton(id, mediaType) {
  const button = elements.detailContent.querySelector('.detail-watchlist-button');
  if (!button) return;
  if (String(button.dataset.itemId) !== String(id) || button.dataset.mediaType !== mediaType) return;
  button.textContent = isInWatchlist(Number(id), mediaType) ? 'Remove from My List' : 'Add to My List';
}

function isInWatchlist(id, mediaType) {
  return state.watchlist.some((entry) => Number(entry.id) === Number(id) && entry.media_type === mediaType);
}

function itemFromDataset(dataset) {
  return {
    id: Number(dataset.itemId),
    media_type: dataset.mediaType,
    title: dataset.title || 'Untitled',
    overview: dataset.overview || '',
    poster_path: dataset.posterPath || '',
    backdrop_path: dataset.backdropPath || '',
    release_date: dataset.releaseDate || '',
    vote_average: Number(dataset.voteAverage || '0')
  };
}

function datasetAttributes(item) {
  return [
    `data-item-id="${Number(item.id)}"`,
    `data-media-type="${escapeAttribute(item.media_type)}"`,
    `data-title="${escapeAttribute(item.title || item.display_title || 'Untitled')}"`,
    `data-overview="${escapeAttribute(item.overview || '')}"`,
    `data-poster-path="${escapeAttribute(item.poster_path || '')}"`,
    `data-backdrop-path="${escapeAttribute(item.backdrop_path || '')}"`,
    `data-release-date="${escapeAttribute(item.release_date || item.display_date || '')}"`,
    `data-vote-average="${Number(item.vote_average || 0)}"`
  ].join(' ');
}

function buildMetaChips(item) {
  const year = item.release_date ? item.release_date.slice(0, 4) : 'Now showing';
  return [
    `<span class="chip">${item.media_type === 'movie' ? 'Movie' : 'TV Series'}</span>`,
    `<span class="chip">${escapeHtml(year)}</span>`,
    `<span class="chip">★ ${Number(item.vote_average || 0).toFixed(1)}</span>`
  ].join('');
}

async function request(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Request failed with status ${response.status}`);
  return data;
}

function loadLocal(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function renderFatalError(message) {
  elements.hero.classList.remove('loading-state');
  elements.hero.querySelector('.hero-title').textContent = 'Payson’s Movies needs one setting';
  elements.hero.querySelector('.hero-overview').textContent = message;
  elements.hero.querySelector('.hero-meta').innerHTML = '<span class="chip">Set TMDB_API_KEY in Bonto, then restart the app</span>';
  elements.heroPlay.disabled = true;
  elements.heroDetails.disabled = true;
  elements.heroList.disabled = true;
  elements.heroPrev.disabled = true;
  elements.heroNext.disabled = true;
  elements.sectionsRoot.innerHTML = '';
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
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
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
