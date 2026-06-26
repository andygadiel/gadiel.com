/* JamBase Live Music Research Assistant
   Vanilla JS, no build step. Talks to the JamBase Data API directly from the
   browser using a key the user stores locally. All API requests are logged to
   the on-screen Request Inspector so contract mismatches are easy to diagnose. */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config + storage
  // ---------------------------------------------------------------------------
  const DEFAULT_BASE = 'https://www.jambase.com/jb-api/v1';
  const LS_KEY = 'jb_research_key';
  const LS_BASE = 'jb_research_base';

  const store = {
    get key() { return localStorage.getItem(LS_KEY) || ''; },
    set key(v) { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); },
    get base() { return localStorage.getItem(LS_BASE) || DEFAULT_BASE; },
    set base(v) { localStorage.setItem(LS_BASE, v || DEFAULT_BASE); },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // API layer
  // ---------------------------------------------------------------------------
  function buildUrl(path, params = {}) {
    const base = store.base.replace(/\/+$/, '');
    const url = new URL(base + '/' + String(path).replace(/^\/+/, ''));
    url.searchParams.set('apikey', store.key);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    return url;
  }

  function redact(url) {
    const u = new URL(url.toString());
    if (u.searchParams.has('apikey')) u.searchParams.set('apikey', '••••••••');
    return decodeURIComponent(u.toString());
  }

  async function api(path, params = {}) {
    if (!store.key) {
      const e = new Error('Add your JamBase API key in Settings to start.');
      e.kind = 'nokey';
      throw e;
    }
    const url = buildUrl(path, params);
    inspector.begin(redact(url));
    let res, text;
    try {
      res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    } catch (netErr) {
      inspector.fail('Network / CORS error', String(netErr));
      const e = new Error(
        'Network request failed. This is usually CORS (the JamBase API not allowing ' +
        'direct browser calls) or an unreachable base URL. See the Inspector below.'
      );
      e.kind = 'network';
      throw e;
    }
    text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!res.ok) {
      inspector.finish(res.status, text);
      let msg = `Request failed (HTTP ${res.status}).`;
      if (res.status === 401 || res.status === 403) {
        msg = `Authorization failed (HTTP ${res.status}). Check that your API key is correct and active.`;
      } else if (data && (data.message || data.error)) {
        msg = `${data.message || data.error} (HTTP ${res.status})`;
      }
      const e = new Error(msg);
      e.kind = 'http';
      e.status = res.status;
      throw e;
    }
    inspector.finish(res.status, text);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Defensive field accessors (the API returns JSON-LD-ish objects)
  // ---------------------------------------------------------------------------
  const pick = (o, ...keys) => {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return undefined;
  };

  function imgUrl(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return imgUrl(v[0]);
    return v.url || v.contentUrl || v.src || '';
  }

  function collection(data, ...keys) {
    if (!data) return [];
    for (const k of keys) if (Array.isArray(data[k])) return data[k];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.cards)) return data.cards;
    return [];
  }

  function pagination(data) {
    const p = (data && (data.pagination || data)) || {};
    const page = Number(pick(p, 'page', 'currentPage')) || 1;
    const perPage = Number(pick(p, 'perPage', 'pageSize')) || 20;
    const total = Number(pick(p, 'totalItems', 'total', 'totalResults')) || 0;
    const totalPages = Number(pick(p, 'totalPages')) || (total ? Math.ceil(total / perPage) : (page));
    return { page, perPage, total, totalPages };
  }

  function normEvent(ev) {
    const venue = ev.location || ev.venue || {};
    const addr = venue.address || venue;
    const geo = venue.geo || venue;
    const perfRaw = ev.performer || ev.performers || ev.headliners || ev.lineup || [];
    const performers = (Array.isArray(perfRaw) ? perfRaw : [perfRaw]).map(p => ({
      name: pick(p, 'name') || '',
      image: imgUrl(pick(p, 'image')),
      headliner: p.isHeadliner === true || p.headliner === true,
    })).filter(p => p.name);
    const offersRaw = ev.offers || ev.ctas || [];
    const offers = (Array.isArray(offersRaw) ? offersRaw : [offersRaw]).map(o => ({
      url: pick(o, 'url', 'href'),
      name: pick(o, 'name', 'label', 'seller') || 'Tickets',
      kind: o.kind,
    })).filter(o => o.url);
    const type = (pick(ev, '@type', 'type', 'eventType') || '').toString().toLowerCase();
    const lat = Number(pick(geo, 'latitude', 'lat'));
    const lng = Number(pick(geo, 'longitude', 'lng', 'lon'));
    return {
      id: pick(ev, 'identifier', 'id', '@id'),
      name: pick(ev, 'name', 'title') || 'Untitled event',
      isFestival: type.includes('festival'),
      date: pick(ev, 'startDate', 'date', 'eventDate'),
      image: imgUrl(pick(ev, 'image', 'heroImage')),
      url: pick(ev, 'url', 'jambaseUrl') ||
           (offers.find(o => o.kind === 'view') || {}).url,
      venueName: pick(venue, 'name'),
      city: pick(addr, 'addressLocality', 'city'),
      region: pick(addr, 'addressRegion', 'region', 'state'),
      street: pick(addr, 'streetAddress', 'street'),
      lat: isFinite(lat) ? lat : null,
      lng: isFinite(lng) ? lng : null,
      mapUrl: pick(venue, 'mapUrl'),
      performers,
      offers: offers.filter(o => o.kind !== 'view'),
    };
  }

  function genresOf(o) {
    const g = o.genre || o.genres || [];
    return (Array.isArray(g) ? g : [g])
      .map(x => (typeof x === 'string' ? x : pick(x, 'name', 'slug')))
      .filter(Boolean);
  }

  function normArtist(a) {
    return {
      id: pick(a, 'identifier', 'id', '@id'),
      name: pick(a, 'name') || 'Unknown artist',
      image: imgUrl(pick(a, 'image')),
      url: pick(a, 'url', 'jambaseUrl'),
      genres: genresOf(a),
      datesText: pick(a, 'numUpcomingEvents') != null
        ? `${a.numUpcomingEvents} upcoming` : undefined,
    };
  }

  function normVenue(v) {
    const addr = v.address || v;
    return {
      id: pick(v, 'identifier', 'id', '@id'),
      name: pick(v, 'name') || 'Unknown venue',
      image: imgUrl(pick(v, 'image')),
      url: pick(v, 'url', 'jambaseUrl'),
      city: pick(addr, 'addressLocality', 'city'),
      region: pick(addr, 'addressRegion', 'region', 'state'),
      street: pick(addr, 'streetAddress', 'street'),
      upcoming: pick(v, 'numUpcomingEvents'),
    };
  }

  // ---------------------------------------------------------------------------
  // Resolvers — translate friendly text into the ids the API filters expect
  // ---------------------------------------------------------------------------
  function parseLocation(text) {
    const t = (text || '').trim();
    const m = t.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
    if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
    return { city: t, state: '' };
  }

  async function resolveCityId(text) {
    const { city, state } = parseLocation(text);
    if (!city) return null;
    const data = await api('geographies/cities', { name: city, perPage: 10 });
    let cities = collection(data, 'cities', 'geographies');
    if (state) {
      const filtered = cities.filter(c => {
        const r = (pick(c, 'addressRegion', 'region', 'state') || '').toString().toUpperCase();
        return r === state || r.endsWith('-' + state);
      });
      if (filtered.length) cities = filtered;
    }
    const first = cities[0];
    return first ? pick(first, 'identifier', 'id', '@id') : null;
  }

  async function resolveArtistId(name) {
    if (!name) return null;
    const data = await api('artists', { artistName: name, perPage: 1 });
    const first = collection(data, 'artists')[0];
    return first ? pick(first, 'identifier', 'id', '@id') : null;
  }

  // ---------------------------------------------------------------------------
  // Inspector
  // ---------------------------------------------------------------------------
  const inspector = (() => {
    const dot = $('#insDot'), urlPrev = $('#insUrlPreview'),
          urlEl = $('#insUrl'), statusEl = $('#insStatus'), bodyEl = $('#insBody');
    function setDot(cls) { dot.className = 'status-dot' + (cls ? ' ' + cls : ''); }
    return {
      begin(redactedUrl) {
        setDot('');
        urlPrev.textContent = redactedUrl;
        urlEl.textContent = redactedUrl;
        statusEl.textContent = 'Loading…';
        bodyEl.textContent = '—';
      },
      finish(status, text) {
        setDot(status >= 200 && status < 300 ? 'ok' : 'err');
        statusEl.textContent = 'HTTP ' + status;
        try { bodyEl.textContent = JSON.stringify(JSON.parse(text), null, 2); }
        catch { bodyEl.textContent = text || '(empty)'; }
      },
      fail(label, detail) {
        setDot('err');
        statusEl.textContent = label;
        bodyEl.textContent = detail || '';
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const hasTime = /T\d\d:/.test(iso);
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    if (hasTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
    return d.toLocaleString(undefined, opts);
  };
  const place = (o) => [o.city, o.region].filter(Boolean).join(', ');

  function skeletons(container, n = 6) {
    container.innerHTML = '';
    const grid = el('div', 'cards');
    for (let i = 0; i < n; i++) {
      grid.appendChild(el('div', 'skeleton',
        '<div class="sk-thumb"></div><div class="sk-line"></div>' +
        '<div class="sk-line short"></div><div class="sk-line short"></div>'));
    }
    container.appendChild(grid);
  }

  function showState(container, opts) {
    const { icon = '🔍', title = '', body = '', error = false } = opts;
    container.innerHTML = '';
    const s = el('div', 'state' + (error ? ' error' : ''));
    s.innerHTML = `<div class="big">${icon}</div><h3>${esc(title)}</h3><div>${body}</div>`;
    container.appendChild(s);
  }

  function handleError(container, err) {
    if (err.kind === 'nokey') {
      showState(container, { icon: '🔑', title: 'Connect your API key',
        body: 'Open <b>Settings</b> (top right) and paste your JamBase API key to begin.' });
      return;
    }
    showState(container, {
      icon: err.kind === 'network' ? '🚫' : '⚠️', error: true,
      title: err.kind === 'network' ? 'Couldn’t reach the API' : 'Something went wrong',
      body: esc(err.message) + ' <br><br><span style="opacity:.7">Open the Request Inspector below for details.</span>',
    });
    if (!$('#inspector').classList.contains('open')) $('#inspector').classList.add('open');
  }

  function eventCard(ev) {
    const card = el('div', 'card');
    const thumb = el('div', 'thumb');
    if (ev.image) thumb.style.backgroundImage = `url("${ev.image}")`;
    const badge = el('span', 'badge ' + (ev.isFestival ? 'festival' : 'concert'),
      ev.isFestival ? 'Festival' : 'Concert');
    thumb.appendChild(badge);
    card.appendChild(thumb);

    const body = el('div', 'body');
    body.appendChild(el('div', 'date', esc(fmtDate(ev.date))));
    body.appendChild(el('h3', null, esc(ev.name)));
    const venueLine = [ev.venueName, place(ev)].filter(Boolean).join(' · ');
    if (venueLine) body.appendChild(el('div', 'venue', esc(venueLine)));

    const support = ev.performers.filter(p => !p.headliner).map(p => p.name);
    if (support.length) body.appendChild(el('div', 'meta', 'with ' + esc(support.join(', '))));

    const actions = el('div', 'actions');
    if (ev.url) actions.appendChild(linkBtn(ev.url, 'JamBase'));
    const tix = ev.offers[0];
    if (tix) actions.appendChild(linkBtn(tix.url, '🎟 ' + (tix.name || 'Tickets'), 'tickets'));
    const map = ev.mapUrl || (ev.lat != null && ev.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${ev.lat},${ev.lng}` : null);
    if (map) actions.appendChild(linkBtn(map, '🗺 Map'));
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  function linkBtn(href, label, cls) {
    const a = el('a', cls || '', esc(label));
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }

  // ---------------------------------------------------------------------------
  // EVENTS view
  // ---------------------------------------------------------------------------
  const evState = { params: null, page: 1 };

  async function runEvents(page = 1) {
    const container = $('#ev-results');
    const loc = $('#ev-location').value.trim();
    const from = $('#ev-from').value;
    const to = $('#ev-to').value;
    const genre = $('#ev-genre').value;
    const type = $('#ev-type').value;
    const artist = $('#ev-artist').value.trim();

    skeletons(container);
    try {
      const params = { perPage: 24, page };
      if (from) params.eventDateFrom = from;
      if (to) params.eventDateTo = to;
      if (genre) params.genreSlug = genre;
      if (type) params.eventType = type;

      if (loc) {
        const cityId = await resolveCityId(loc);
        if (!cityId) {
          showState(container, { icon: '📍', title: 'City not found',
            body: `Couldn’t resolve “${esc(loc)}”. Try “City, ST” (e.g. <code>Austin, TX</code>).` });
          return;
        }
        params.geoCityId = cityId;
      }
      if (artist) {
        const artistId = await resolveArtistId(artist);
        if (artistId) params.artistId = artistId;
        else params.artistName = artist; // best-effort fallback
      }

      const data = await api('events', params);
      const events = collection(data, 'events').map(normEvent);
      const pg = pagination(data);
      evState.params = params; evState.page = pg.page;
      renderEvents(container, events, pg);
    } catch (err) {
      handleError(container, err);
    }
  }

  function renderEvents(container, events, pg) {
    container.innerHTML = '';
    if (!events.length) {
      showState(container, { icon: '🎭', title: 'No events found',
        body: 'Try widening the date range, clearing the genre, or a different city.' });
      return;
    }
    const bar = el('div', 'results-bar');
    bar.appendChild(el('h2', null, 'Upcoming shows'));
    bar.appendChild(el('span', 'results-count',
      `${pg.total ? pg.total.toLocaleString() + ' total · ' : ''}page ${pg.page} of ${Math.max(pg.totalPages, 1)}`));
    container.appendChild(bar);

    const grid = el('div', 'cards');
    events.forEach(ev => grid.appendChild(eventCard(ev)));
    container.appendChild(grid);

    addPager(container, pg, (p) => runEvents(p));
  }

  function addPager(container, pg, go) {
    if (pg.totalPages <= 1) return;
    const pager = el('div', 'pager');
    const prev = el('button', 'btn small', '← Prev');
    const next = el('button', 'btn small', 'Next →');
    prev.disabled = pg.page <= 1;
    next.disabled = pg.page >= pg.totalPages;
    prev.style.opacity = prev.disabled ? .4 : 1;
    next.style.opacity = next.disabled ? .4 : 1;
    prev.onclick = () => !prev.disabled && go(pg.page - 1);
    next.onclick = () => !next.disabled && go(pg.page + 1);
    pager.appendChild(prev);
    pager.appendChild(el('span', null, `Page ${pg.page} / ${pg.totalPages}`));
    pager.appendChild(next);
    container.appendChild(pager);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // ARTISTS view
  // ---------------------------------------------------------------------------
  async function runArtists() {
    const container = $('#ar-results');
    const name = $('#ar-name').value.trim();
    const genre = $('#ar-genre').value;
    if (!name && !genre) {
      showState(container, { icon: '🎤', title: 'Search for an artist',
        body: 'Enter an artist name (or pick a genre) to see who’s touring.' });
      return;
    }
    skeletons(container, 4);
    try {
      const data = await api('artists', { artistName: name, genreSlug: genre, perPage: 30 });
      const artists = collection(data, 'artists').map(normArtist);
      renderArtistList(container, artists);
    } catch (err) {
      handleError(container, err);
    }
  }

  function renderArtistList(container, artists) {
    container.innerHTML = '';
    if (!artists.length) {
      showState(container, { icon: '🤷', title: 'No artists found', body: 'Try a different spelling.' });
      return;
    }
    container.appendChild(el('div', 'results-bar', `<h2>${artists.length} artist${artists.length > 1 ? 's' : ''}</h2>`));
    const list = el('div', 'list');
    artists.forEach(a => {
      const row = el('div', 'row');
      const av = el('div', 'avatar round');
      if (a.image) av.style.backgroundImage = `url("${a.image}")`;
      row.appendChild(av);
      const info = el('div', 'info');
      info.appendChild(el('h3', null, esc(a.name)));
      const sub = [a.genres.slice(0, 3).join(' · '), a.datesText].filter(Boolean).join(' — ');
      if (sub) info.appendChild(el('p', null, esc(sub)));
      row.appendChild(info);
      row.appendChild(el('span', 'chev', '›'));
      row.onclick = () => showArtistDetail(a);
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  async function showArtistDetail(artist) {
    const container = $('#ar-results');
    container.innerHTML = '';
    const back = el('button', 'back-link', '← Back to results');
    back.onclick = () => runArtists();
    container.appendChild(back);

    const head = el('div', 'detail-head');
    const art = el('div', 'art');
    if (artist.image) art.style.backgroundImage = `url("${artist.image}")`;
    head.appendChild(art);
    const meta = el('div');
    meta.appendChild(el('h2', null, esc(artist.name)));
    const sub = el('p', null, esc(artist.genres.join(' · ')));
    meta.appendChild(sub);
    if (artist.url) {
      const links = el('div'); links.style.marginTop = '12px';
      links.appendChild(linkBtn(artist.url, 'Artist page on JamBase'));
      meta.appendChild(links);
    }
    head.appendChild(meta);
    container.appendChild(head);

    const tour = el('div'); container.appendChild(tour);
    skeletons(tour, 3);
    try {
      const data = await api('events', { artistId: artist.id, perPage: 50, eventType: 'concerts' });
      const events = collection(data, 'events').map(normEvent);
      tour.innerHTML = '';
      tour.appendChild(el('div', 'results-bar',
        `<h2>Tour itinerary</h2><span class="results-count">${events.length} upcoming</span>`));
      if (!events.length) {
        showState(tour, { icon: '🗓', title: 'No upcoming dates', body: 'This artist has no shows on the calendar right now.' });
        return;
      }
      const grid = el('div', 'cards');
      events.forEach(ev => grid.appendChild(eventCard(ev)));
      tour.appendChild(grid);
    } catch (err) {
      handleError(tour, err);
    }
  }

  // ---------------------------------------------------------------------------
  // VENUES view
  // ---------------------------------------------------------------------------
  async function runVenues() {
    const container = $('#ve-results');
    const name = $('#ve-name').value.trim();
    const loc = $('#ve-location').value.trim();
    if (!name && !loc) {
      showState(container, { icon: '📍', title: 'Find a venue', body: 'Search by venue name and/or city.' });
      return;
    }
    skeletons(container, 4);
    try {
      const params = { venueName: name, perPage: 30 };
      if (loc) {
        const cityId = await resolveCityId(loc);
        if (cityId) params.geoCityId = cityId;
      }
      const data = await api('venues', params);
      const venues = collection(data, 'venues').map(normVenue);
      renderVenueList(container, venues);
    } catch (err) {
      handleError(container, err);
    }
  }

  function renderVenueList(container, venues) {
    container.innerHTML = '';
    if (!venues.length) {
      showState(container, { icon: '🏟', title: 'No venues found', body: 'Try a different name or city.' });
      return;
    }
    container.appendChild(el('div', 'results-bar', `<h2>${venues.length} venue${venues.length > 1 ? 's' : ''}</h2>`));
    const list = el('div', 'list');
    venues.forEach(v => {
      const row = el('div', 'row');
      const av = el('div', 'avatar');
      if (v.image) av.style.backgroundImage = `url("${v.image}")`;
      row.appendChild(av);
      const info = el('div', 'info');
      info.appendChild(el('h3', null, esc(v.name)));
      const sub = [place(v), v.upcoming != null ? `${v.upcoming} upcoming` : ''].filter(Boolean).join(' — ');
      if (sub) info.appendChild(el('p', null, esc(sub)));
      row.appendChild(info);
      row.appendChild(el('span', 'chev', '›'));
      row.onclick = () => showVenueDetail(v);
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  async function showVenueDetail(venue) {
    const container = $('#ve-results');
    container.innerHTML = '';
    const back = el('button', 'back-link', '← Back to results');
    back.onclick = () => runVenues();
    container.appendChild(back);

    const head = el('div', 'detail-head');
    const art = el('div', 'art');
    if (venue.image) art.style.backgroundImage = `url("${venue.image}")`;
    head.appendChild(art);
    const meta = el('div');
    meta.appendChild(el('h2', null, esc(venue.name)));
    meta.appendChild(el('p', null, esc([venue.street, place(venue)].filter(Boolean).join(', '))));
    if (venue.url) {
      const links = el('div'); links.style.marginTop = '12px';
      links.appendChild(linkBtn(venue.url, 'Venue page on JamBase'));
      meta.appendChild(links);
    }
    head.appendChild(meta);
    container.appendChild(head);

    const cal = el('div'); container.appendChild(cal);
    skeletons(cal, 3);
    try {
      const data = await api('events', { venueId: venue.id, perPage: 50 });
      const events = collection(data, 'events').map(normEvent);
      cal.innerHTML = '';
      cal.appendChild(el('div', 'results-bar',
        `<h2>Upcoming calendar</h2><span class="results-count">${events.length} shows</span>`));
      if (!events.length) {
        showState(cal, { icon: '🗓', title: 'No upcoming shows', body: 'Nothing on the calendar for this venue right now.' });
        return;
      }
      const grid = el('div', 'cards');
      events.forEach(ev => grid.appendChild(eventCard(ev)));
      cal.appendChild(grid);
    } catch (err) {
      handleError(cal, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Genres (populate dropdowns; fall back to a known list if the call fails)
  // ---------------------------------------------------------------------------
  const FALLBACK_GENRES = [
    ['bluegrass', 'Bluegrass'], ['blues', 'Blues'], ['christian', 'Christian'],
    ['classical', 'Classical'], ['country-music', 'Country'], ['edm', 'EDM'],
    ['folk', 'Folk'], ['hip-hop-rap', 'Hip Hop & Rap'], ['indie', 'Indie'],
    ['jamband', 'Jamband'], ['jazz', 'Jazz'], ['kpop', 'K-pop'], ['latin', 'Latin'],
    ['metal', 'Metal'], ['pop', 'Pop'], ['punk', 'Punk'],
    ['rhythm-and-blues-soul', 'R&B / Soul'], ['reggae', 'Reggae'], ['rock', 'Rock'],
    ['tribute', 'Tribute'],
  ];

  async function loadGenres() {
    let entries = FALLBACK_GENRES;
    try {
      if (store.key) {
        const data = await api('genres', { perPage: 100 });
        const list = collection(data, 'genres');
        if (list.length) {
          entries = list.map(g => [pick(g, 'slug', 'identifier', 'id'), pick(g, 'name')])
            .filter(([s, n]) => s && n);
        }
      }
    } catch { /* keep fallback */ }
    for (const sel of [$('#ev-genre'), $('#ar-genre')]) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">Any genre</option>';
      entries.forEach(([slug, name]) => {
        const o = el('option'); o.value = slug; o.textContent = name; sel.appendChild(o);
      });
      sel.value = cur;
    }
  }

  // ---------------------------------------------------------------------------
  // Settings + key
  // ---------------------------------------------------------------------------
  function refreshKeyPill() {
    const pill = $('#keyPill'), text = $('#keyPillText');
    if (store.key) {
      pill.classList.add('ok');
      text.textContent = 'Key connected';
    } else {
      pill.classList.remove('ok');
      text.textContent = 'No key — click Settings';
    }
  }

  function openSettings() {
    $('#set-key').value = store.key;
    $('#set-base').value = store.base;
    $('#settingsModal').classList.remove('hidden');
  }
  function closeSettings() { $('#settingsModal').classList.add('hidden'); }

  function saveSettings() {
    store.key = $('#set-key').value.trim();
    store.base = $('#set-base').value.trim() || DEFAULT_BASE;
    refreshKeyPill();
    closeSettings();
    loadGenres();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  function init() {
    // default date range: today → +90 days
    const today = new Date();
    const plus90 = new Date(Date.now() + 90 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    $('#ev-from').value = iso(today);
    $('#ev-to').value = iso(plus90);

    $('#settingsBtn').onclick = openSettings;
    $('#keyPill').onclick = openSettings;
    $('#closeSettings').onclick = closeSettings;
    $('#saveSettings').onclick = saveSettings;
    $('#forgetKey').onclick = () => { store.key = ''; $('#set-key').value = ''; refreshKeyPill(); };
    $('#revealKey').onclick = () => {
      const i = $('#set-key');
      const show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      $('#revealKey').textContent = show ? 'hide' : 'show';
    };
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') closeSettings();
    });

    $('#tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) switchTab(tab.dataset.tab);
    });

    $('#ev-search').onclick = () => runEvents(1);
    $('#ar-search').onclick = () => runArtists();
    $('#ve-search').onclick = () => runVenues();

    // Enter key submits within each view
    $('#view-events').addEventListener('keydown', e => { if (e.key === 'Enter') runEvents(1); });
    $('#view-artists').addEventListener('keydown', e => { if (e.key === 'Enter') runArtists(); });
    $('#view-venues').addEventListener('keydown', e => { if (e.key === 'Enter') runVenues(); });

    // Inspector toggle
    $('#inspectorBar').onclick = () => {
      const ins = $('#inspector');
      ins.classList.toggle('open');
      $('#insToggle').textContent = ins.classList.contains('open') ? '▼' : '▲';
    };

    refreshKeyPill();
    loadGenres();

    if (!store.key) {
      showState($('#ev-results'), { icon: '🔑', title: 'Welcome — connect your API key',
        body: 'Click <b>⚙ Settings</b> in the top right and paste your JamBase API key. ' +
              'It’s stored only in this browser. Then search away.' });
      openSettings();
    } else {
      runEvents(1);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
