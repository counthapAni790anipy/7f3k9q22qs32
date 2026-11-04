/* ==========================================================
   Tizen TV Media Widget (Lampa-style)
   Vanilla ES5/ES6. Только Promise, .then(); без новых операторов.
   ========================================================== */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    ENTER: 13, RETURN: 10009,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 179,
    FF: 417, RW: 412,
    /* переключение каналов — в плеере листает серии */
    CHUP: 427, CHDOWN: 428,
    /* цветные кнопки пульта Samsung */
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    INFO: 457
  };

  /* ---------------- Конфиг ---------------- */
  var CONFIG = {
    /* Публичные CORS-прокси: URL только здесь, не размазан по коду */
    publicProxies: [
      'https://corsproxy.io/?',
      'https://api.allorigins.win/raw?url='
    ],
    defaultProxyUrl: 'http://192.168.1.2:8080/?url=',
    fetchTimeout: 8000,
    apiTimeout: 25000,
    defaultSrc: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    defaultPoster: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg',
    /* Не перематывать в первые секунды: бессмысленно и мешает началу */
    minResumeSec: 5,
    /* Ближе к концу — начинать серию заново */
    endThresholdSec: 30,
    toleranceSec: 2
  };

  /* ---------------- Helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn, false); }
  function off(el, ev, fn) { if (el) el.removeEventListener(ev, fn, false); }
  function clamp(v, min, max) {
    v = Number(v) || 0;
    if (v < min) v = min;
    if (max > 0 && v > max) v = max;
    return v;
  }
  function pad(n) { n = Math.floor(n) || 0; return n < 10 ? '0' + n : '' + n; }
  function fmt(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (sec < 0) sec = 0;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }
  /* 'http://host:port/...' -> 'http://host:port' */
  function originOf(url) {
    var m = /^(https?:\/\/[^\/]+)/i.exec(url || '');
    return m ? m[1] : '';
  }
  /* Подключение к локальному прокси на ПК требует разрешения в config.xml */
  function requestProxyAccess(proxyUrl) {
    var origin = originOf(proxyUrl);
    if (!origin) return;
    try {
      if (isTizen() && tizen.application && typeof tizen.application.addAllowedOrigin === 'function') {
        tizen.application.addAllowedOrigin(origin + '/*');
      }
    } catch (e) { /* на эмуляторе без tizen игнорируем */ }
  }
  function isTizen() {
    return typeof tizen !== 'undefined' && tizen !== null;
  }
  function getTizenAvplay() {
    /* На телевизорах Samsung AVPlay живёт в webapis.avplay,
       в Tizen Studio — в tizen.avplay. Поддерживаем оба варианта. */
    try {
      if (typeof webapis !== 'undefined' && webapis && webapis.avplay &&
          typeof webapis.avplay.open === 'function') {
        return webapis.avplay;
      }
    } catch (eWeb) { /* noop */ }
    try {
      if (isTizen() && tizen.avplay && typeof tizen.avplay.open === 'function') return tizen.avplay;
    } catch (e) { /* noop */ }
    return null;
  }
  /* Каким API найден AVPlay — для диагностики */
  function avplaySource() {
    try {
      if (typeof webapis !== 'undefined' && webapis && webapis.avplay) return 'webapis.avplay';
    } catch (e1) { /* noop */ }
    try {
      if (isTizen() && tizen.avplay) return 'tizen.avplay';
    } catch (e2) { /* noop */ }
    return 'нет';
  }
  function exitApp() {
    try {
      if (isTizen() && tizen.application && tizen.application.getCurrentApplication) {
        tizen.application.getCurrentApplication().exit();
        return true;
      }
    } catch (e) { /* на эмуляторе без tizen просто игнорируем */ }
    return false;
  }

  function storageGet(key, def) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null || v === undefined ? def : v;
    } catch (e) { return def; }
  }
  function storageSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* quota */ }
  }

  /* ---- кеш с TTL (карточки релизов, источники, серии) ---- */
  function cacheGet(key) {
    try {
      var raw = storageGet(key, '');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.ts) return null;
      if ((new Date()).getTime() - obj.ts > (obj.ttl || 900000)) return null;
      return obj.data;
    } catch (e) { return null; }
  }

  function cacheSet(key, data, ttl) {
    try {
      storageSet(key, JSON.stringify({
        ts: (new Date()).getTime(),
        ttl: ttl || 900000,
        data: data
      }));
    } catch (e) { /* quota */ }
  }

  /* Удаляем просроченные кеши при запуске */
  function cachePurge() {
    try {
      var drop = [];
      var now = (new Date()).getTime();
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (!k || k.indexOf('cache_') !== 0) continue;
        try {
          var o = JSON.parse(window.localStorage.getItem(k));
          if (!o || !o.ts || now - o.ts > (o.ttl || 900000)) drop.push(k);
        } catch (e) { drop.push(k); }
      }
      for (var j = 0; j < drop.length; j++) window.localStorage.removeItem(drop[j]);
    } catch (e2) { /* noop */ }
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('active');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('active');
      toastTimer = null;
    }, ms || 2500);
  }

  /* ---------------- Loader ---------------- */
  var Loader = {
    show: function (text) {
      var l = $('loader');
      if (!l) return;
      if (text && $('loader_text')) $('loader_text').textContent = text;
      l.classList.add('active');
    },
    hide: function () {
      var l = $('loader');
      if (l) l.classList.remove('active');
    }
  };

  /* ==========================================================
     1) TVNavigation — Spatial Navigation
     ========================================================== */
  var TVNavigation = {
    current: null,
    /* Ближайшие скролл-контейнеры горизонтальных рядов */
    hContainers: [],

    getCandidates: function () {
      var all = document.querySelectorAll('.focusable');
      var list = [];
      var viewW = window.innerWidth || 1920;
      var viewH = window.innerHeight || 1080;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var r = el.getBoundingClientRect();
        /* игнорируем нулевые размеры и невидимые элементы */
        if (r.width <= 0 || r.height <= 0) continue;
        var cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (parseFloat(cs.opacity) === 0) continue;
        /* элементы, вынесенные далеко за пределы экрана, не участвуют */
        if (r.right < -viewW || r.left > viewW * 2 || r.bottom < -viewH || r.top > viewH * 2) continue;
        list.push({ el: el, r: r });
      }
      return list;
    },

    /* Горизонтальная прокрутка ряда через transform — без лагов и без обрезки scale */
    scrollRowTo: function (el) {
      for (var i = 0; i < TVNavigation.hContainers.length; i++) {
        var c = TVNavigation.hContainers[i];
        if (!c.contains(el)) continue;
        var cr = c.getBoundingClientRect();
        var er = el.getBoundingClientRect();
        var shift = parseFloat(c.getAttribute('data-shift')) || 0;
        /* Положение элемента относительно содержимого ряда.
           Ряд уже сдвинут на -shift, поэтому разница прямоугольников и ЕСТЬ
           координата в содержимом: прибавлять shift нельзя — он удваивался,
           и при повторном вызове (после scrollIntoView) ряд уезжал за экран. */
        var left = er.left - cr.left;
        var right = left + er.width;
        var margin = 40;
        var target = shift;
        if (left - margin < shift) {
          /* элемент выходит за левый край — прижимаем к нему */
          target = left - margin;
        } else if (right + margin > shift + cr.width) {
          /* элемент ушёл за правый край. Ведём не к самому краю, а к центру ряда:
             при удержании стрелки пульт шлёт повторы чаще, чем длится анимация
             прокрутки, и у края карточка успевала оказаться срезанной. */
          target = left - (cr.width - er.width) / 2;
        }
        var max = c.scrollWidth - cr.width;
        if (max < 0) max = 0;
        if (target < 0) target = 0;
        if (target > max) target = max;
        target = Math.round(target);
        if (target !== shift) {
          c.setAttribute('data-shift', String(target));
          c.style.transform = 'translateX(' + (-target) + 'px)';
        }
        return true;
      }
      return false;
    },

    /* Горизонтальная прокрутка предков должна оставаться нулевой: ряд двигаем
       только через transform, иначе два сдвига складываются. */
    resetHScroll: function (node) {
      var p = node ? node.parentNode : null;
      while (p && p.nodeType === 1) {
        if (p.scrollLeft) p.scrollLeft = 0;
        p = p.parentNode;
      }
    },

    focus: function (el, silent) {
      if (!el) return;
      if (TVNavigation.current && TVNavigation.current !== el) {
        TVNavigation.current.classList.remove('focused');
      }
      TVNavigation.current = el;
      /* горизонтальную ленту прокручиваем сами (transform), остальное — scrollIntoView */
      var inRow = TVNavigation.scrollRowTo(el);
      var opts = { block: 'nearest', inline: 'nearest' };
      if (!silent) opts.behavior = 'smooth';
      if (inRow) {
        /* Элемент внутри ленты: scrollIntoView для него ещё и прокручивает контейнер
           по горизонтали, и этот сдвиг складывался с transform — элемент уезжал
           вдвое дальше и пропадал с экрана. Для лент подводим по вертикали сам ряд,
           а горизонтальную прокрутку предков держим в нуле. */
        TVNavigation.resetHScroll(el.parentNode);
        try {
          el.parentNode.scrollIntoView(opts);
        } catch (eRow) {
          try { el.parentNode.scrollIntoView(false); } catch (eRow2) { /* noop */ }
        }
        TVNavigation.resetHScroll(el.parentNode);
      } else {
        try {
          el.scrollIntoView(opts);
        } catch (e) {
          try { el.scrollIntoView(false); } catch (e2) { /* noop */ }
        }
      }
      if (inRow) TVNavigation.scrollRowTo(el);
      el.classList.add('focused');
      if (!silent && TVNavigation.onFocus) TVNavigation.onFocus(el);
    },

    onFocus: null,

    /* ближайший элемент в направлении dir: 'left'|'right'|'up'|'down' */
    navigate: function (dir) {
      var cur = TVNavigation.current;
      if (!cur) {
        var c0 = TVNavigation.getCandidates();
        if (c0.length) TVNavigation.focus(c0[0].el);
        return;
      }
      var cr = cur.getBoundingClientRect();
      var cx = cr.left + cr.width / 2;
      var cy = cr.top + cr.height / 2;

      var list = TVNavigation.getCandidates();
      var best = null;
      var bestScore = Infinity;
      var PENALTY = 2;

      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item.el === cur) continue;
        var r = item.r;
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        var dx = x - cx;
        var dy = y - cy;
        var main, perp;

        if (dir === 'left') {
          if (dx >= -1) continue;
          main = -dx; perp = Math.abs(dy);
        } else if (dir === 'right') {
          if (dx <= 1) continue;
          main = dx; perp = Math.abs(dy);
        } else if (dir === 'up') {
          if (dy >= -1) continue;
          main = -dy; perp = Math.abs(dx);
        } else if (dir === 'down') {
          if (dy <= 1) continue;
          main = dy; perp = Math.abs(dx);
        } else {
          continue;
        }

        /* score = основа проекции + 2 * перпендикуляр
           (тот же штраф x2, но без sqrt: считается в 10 раз быстрее) */
        var score = (main + PENALTY * perp) / Math.sqrt(1 + PENALTY * PENALTY);
        if (score < bestScore) {
          bestScore = score;
          best = item.el;
        }
      }

      if (best) TVNavigation.focus(best);
      /* если кандидатов нет — фокус остаётся на текущем элементе */
    },

    init: function (root) {
      TVNavigation.refresh();
      var first = (root || document).querySelector('.focusable.focused') ||
        (root || document).querySelector('.focusable');
      if (first) TVNavigation.focus(first, true);
    },

    /* Пересобрать список горизонтальных рядов (после перерисовки содержимого) */
    refresh: function () {
      TVNavigation.hContainers = [];
      var rows = document.querySelectorAll('.history_row');
      for (var i = 0; i < rows.length; i++) {
        rows[i].setAttribute('data-shift', rows[i].getAttribute('data-shift') || '0');
        TVNavigation.hContainers.push(rows[i]);
      }
    },

    /* Пересобрать ряды и поставить фокус на первый элемент контейнера */
    focusIn: function (container) {
      TVNavigation.refresh();
      var el = container && container.querySelector('.focusable');
      if (el) TVNavigation.focus(el, true);
    }
  };

  /* ==========================================================
     2) TVHistory — история просмотров
     ========================================================== */
  var TVHistory = {
    KEY: 'watch_history',
    MAX: 20,
    lastSave: 0,
    lastRender: 0,

    get: function () {
      try {
        var raw = storageGet(this.KEY, '[]');
        var arr = JSON.parse(raw);
        return arr instanceof Array ? arr : [];
      } catch (e) { return []; }
    },

    save: function (list) {
      this.lastSave = (new Date()).getTime();
      try { storageSet(this.KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
      /* перерисовка ленты только когда она видна и не чаще раза в 5 секунд */
      var main = $('main_view');
      var histView = $('history_view');
      var visible = (main && main.style.display !== 'none') ||
        (histView && histView.style.display === 'flex');
      var ts = (new Date()).getTime();
      if (visible && ts - this.lastRender >= 5000) {
        this.lastRender = ts;
        TVHistory.render();
      }
      /* блок «Продолжить просмотр» на главной */
      try { TVContinue.render(); } catch (eCont) { /* noop */ }
    },

    find: function (id) {
      var list = this.get();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
      return null;
    },

    /* Подготовить id/title/poster/episode/time к записи */
    normalize: function (item) {
      return {
        id: String(item.id),
        title: item.title || '',
        poster: item.poster || '',
        episode: item.episode === undefined || item.episode === null ? 1 : item.episode,
        time: Math.max(0, Math.floor(Number(item.time) || 0)),
        src: item.src || ''
      };
    },

    /* item: { id, title, poster, episode, time } */
    add: function (item) {
      if (!item || item.id === undefined || item.id === null) return;
      var rec = this.normalize(item);
      var list = this.get();
      var found = false;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === rec.id) {
          list[i].title = rec.title || list[i].title;
          list[i].poster = rec.poster || list[i].poster || '';
          list[i].episode = rec.episode;
          list[i].time = rec.time;
          list[i].src = rec.src || list[i].src || '';
          found = true;
          /* последний просмотренный — в начало ленты */
          if (i > 0) {
            list.splice(i, 1);
            list.unshift(rec);
          }
          break;
        }
      }
      if (!found) list.unshift(rec);
      if (list.length > this.MAX) list = list.slice(0, this.MAX);
      this.save(list);
    },

    remove: function (id) {
      var list = this.get();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) {
          list.splice(i, 1);
          break;
        }
      }
      this.save(list);
    },

    clear: function () {
      this.save([]);
      this.render();
    },

    render: function () {
      var row = $('history_row');
      if (!row) return;
      var list = this.get();
      /* запомним фокус и горизонтальный сдвиг между перерисовками */
      var focusedId = TVNavigation.current && row.contains(TVNavigation.current) ?
        TVNavigation.current.getAttribute('data-id') : null;
      var oldShift = parseFloat(row.getAttribute('data-shift')) || 0;
      row.innerHTML = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'history_empty';
        empty.textContent = 'История пока пуста';
        row.appendChild(empty);
        return;
      }
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var card = document.createElement('div');
        card.className = 'history_card focusable';
        card.setAttribute('data-id', String(it.id));
        card.setAttribute('data-title', it.title || '');
        card.setAttribute('data-src', it.src || CONFIG.defaultSrc);
        card.setAttribute('data-episode', String(it.episode || 1));
        if (it.poster) card.style.backgroundImage = 'url("' + it.poster + '")';

        /* затемнение поверх постера — градиентом, без тяжёлых эффектов */
        var cover = document.createElement('div');
        cover.className = 'h_cover';
        card.appendChild(cover);

        var info = document.createElement('div');
        info.className = 'h_info';
        var t = document.createElement('div');
        t.className = 'h_title';
        t.textContent = it.title || 'Без названия';
        var m = document.createElement('div');
        m.className = 'h_meta';
        m.textContent = 'Серия ' + (it.episode || 1) + ' · ' + fmt(it.time);
        info.appendChild(t);
        info.appendChild(m);
        card.appendChild(info);

        /* индикатор прогресса, если время известно (duration не храним — показываем точку) */
        if (it.time > 0) {
          var prog = document.createElement('div');
          prog.className = 'h_prog';
          var fill = document.createElement('div');
          fill.className = 'h_prog_fill';
          fill.style.width = Math.min(100, Math.max(6, Math.floor(it.time / 60))).toFixed(0) + '%';
          prog.appendChild(fill);
          card.appendChild(prog);
        }
        row.appendChild(card);
      }

      /* вернуть сдвиг ленты */
      row.setAttribute('data-shift', String(oldShift));
      row.style.transform = 'translateX(' + (-oldShift) + 'px)';

      /* вернуть фокус на ту же карточку истории */
      if (focusedId !== null) {
        var again = row.querySelector('[data-id="' + focusedId + '"]');
        if (again) TVNavigation.focus(again, true);
      }
    }
  };

  /* ==========================================================
     2a2) TVContinue — блок «Продолжить просмотр» на главной
     ========================================================== */
  var TVContinue = {
    MAX: 8,

    render: function () {
      var row = $('continue_row');
      var sec = $('continue_section');
      if (!row || !sec) return;
      var list = TVHistory.get();
      row.innerHTML = '';
      var focusedId = TVNavigation.current && row.contains(TVNavigation.current) ?
        TVNavigation.current.getAttribute('data-id') : null;
      var shown = 0;
      for (var i = 0; i < list.length && shown < this.MAX; i++) {
        var h = list[i];
        if (!h || String(h.id || '').indexOf('anix:') !== 0) continue;
        var card = document.createElement('div');
        card.className = 'history_card focusable';
        card.setAttribute('data-id', String(h.id));
        card.setAttribute('data-title', h.title || '');
        if (h.poster) card.style.backgroundImage = 'url("' + h.poster + '")';

        var cover = document.createElement('div');
        cover.className = 'h_cover';
        card.appendChild(cover);

        var info = document.createElement('div');
        info.className = 'h_info';
        var t = document.createElement('div');
        t.className = 'h_title';
        t.textContent = h.title || 'Без названия';
        var m = document.createElement('div');
        m.className = 'h_meta';
        var meta = [];
        if (h.episode) meta.push(h.episode + ' серия');
        if (h.time) meta.push(fmt(h.time));
        m.textContent = meta.join(' · ');
        info.appendChild(t);
        info.appendChild(m);
        card.appendChild(info);

        if (h.time > 0) {
          var prog = document.createElement('div');
          prog.className = 'h_prog';
          var fill = document.createElement('div');
          fill.className = 'h_prog_fill';
          fill.style.width = Math.min(100, Math.max(6, Math.floor(h.time / 60))) + '%';
          prog.appendChild(fill);
          card.appendChild(prog);
        }
        row.appendChild(card);
        shown++;
      }
      if (!shown) { sec.style.display = 'none'; return; }
      sec.style.display = '';
      if (focusedId !== null) {
        var again = row.querySelector('[data-id="' + focusedId + '"]');
        if (again) TVNavigation.focus(again, true);
      }
      if (typeof TVNavigation !== 'undefined') TVNavigation.refresh();
    }
  };

  /* ==========================================================
     2b) TVBookmarks — закладки (избранные релизы)
     Храним только те поля, которые нужны карточке (fillReleaseRow),
     чтобы лента закладок рисовалась без запросов к API.
     ========================================================== */
  var TVBookmarks = {
    KEY: 'bookmarks',
    MAX: 60,

    get: function () {
      try {
        var arr = JSON.parse(storageGet(this.KEY, '[]'));
        return arr instanceof Array ? arr : [];
      } catch (e) { return []; }
    },

    find: function (id) {
      if (id === undefined || id === null) return null;
      var list = this.get();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
      return null;
    },

    has: function (id) { return this.find(id) !== null; },

    /* Релиз из API, карточки или плеера -> запись закладки */
    normalize: function (rel) {
      rel = rel || {};
      return {
        id: rel.id === undefined || rel.id === null ? '' : String(rel.id),
        title_ru: rel.title_ru || rel.title || 'Без названия',
        image: rel.image || rel.poster || '',
        year: rel.year || '',
        episodes_total: Number(rel.episodes_total) || 0,
        episodes_released: Number(rel.episodes_released) || 0,
        grade: Number(rel.grade) || 0
      };
    },

    save: function (list) {
      try { storageSet(this.KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
      this.render();
      this.markCards();
    },

    add: function (rel) {
      var rec = this.normalize(rel);
      if (!rec.id) return false;
      var list = this.get();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === rec.id) {
          list[i] = rec;                 /* обновим название/постер */
          this.save(list);
          return true;
        }
      }
      list.unshift(rec);                 /* свежая закладка — в начало */
      if (list.length > this.MAX) list = list.slice(0, this.MAX);
      this.save(list);
      return true;
    },

    remove: function (id) {
      var list = this.get();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) {
          list.splice(i, 1);
          this.save(list);
          return true;
        }
      }
      return false;
    },

    /* true — добавлено, false — удалено, null — нечего сохранять */
    toggle: function (rel) {
      if (!rel || rel.id === undefined || rel.id === null || rel.id === '') return null;
      var id = String(rel.id);
      if (this.has(id)) { this.remove(id); return false; }
      this.add(rel);
      return true;
    },

    clear: function () { this.save([]); },

    /* Звёздочки на карточках и подпись кнопки на экране релиза */
    markCards: function () {
      var cards = document.querySelectorAll('.history_card[data-release]');
      for (var i = 0; i < cards.length; i++) {
        var id = cards[i].getAttribute('data-release');
        if (this.has(id)) cards[i].classList.add('bm');
        else cards[i].classList.remove('bm');
      }
      var btn = $('rel_bookmark');
      if (!btn) return;
      var rid = (typeof TVRelease !== 'undefined' && TVRelease.rel) ? String(TVRelease.rel.id) : '';
      var on = rid && this.has(rid);
      btn.textContent = on ? '★ В закладках' : '☆ В закладки';
      if (on) btn.classList.add('on');
      else btn.classList.remove('on');
    },

    render: function () {
      var row = $('bookmark_row');
      if (!row) return;
      var list = this.get();
      /* фокус и сдвиг ленты переживают перерисовку */
      var focusedId = TVNavigation.current && row.contains(TVNavigation.current) ?
        TVNavigation.current.getAttribute('data-release') : null;
      var oldShift = parseFloat(row.getAttribute('data-shift')) || 0;
      fillReleaseRow(row, list, 'Закладок пока нет');
      var max = row.scrollWidth - row.clientWidth;
      if (max < 0) max = 0;
      if (oldShift > max) oldShift = max;
      row.setAttribute('data-shift', String(oldShift));
      row.style.transform = 'translateX(' + (-oldShift) + 'px)';
      if (focusedId !== null) {
        var again = row.querySelector('[data-release="' + focusedId + '"]');
        if (again) {
          TVNavigation.focus(again, true);
        } else {
          /* карточку убрали — фокус на первую оставшуюся, иначе на пункт меню */
          var any = row.querySelector('.history_card');
          if (any) TVNavigation.focus(any, true);
          else if ($('bookmarks_view') && $('bookmarks_view').style.display === 'flex') {
            TVNavigation.focus(document.querySelector('[data-nav="bookmarks"]'), true);
          } else {
            TVNavigation.focus($('search_open'), true);
          }
        }
      }
    }
  };

  /* ==========================================================
     2c) TVWatched — просмотренные серии (локальные отметки)
     Храним по релизу список позиций серий, чтобы красить их в списке.
     ========================================================== */
  var TVWatched = {
    KEY: 'watched_eps',

    get: function () {
      try {
        var obj = JSON.parse(storageGet(this.KEY, '{}'));
        return obj && typeof obj === 'object' ? obj : {};
      } catch (e) { return {}; }
    },

    /* Список позиций серий для релиза */
    list: function (relId) {
      var map = this.get();
      var arr = map[String(relId)];
      return arr instanceof Array ? arr : [];
    },

    has: function (relId, pos) {
      pos = Number(pos) || 0;
      if (!pos) return false;
      var arr = this.list(relId);
      for (var i = 0; i < arr.length; i++) {
        if (Number(arr[i]) === pos) return true;
      }
      return false;
    },

    add: function (relId, pos) {
      pos = Number(pos) || 0;
      if (!relId || !pos) return;
      var map = this.get();
      var key = String(relId);
      var arr = map[key] instanceof Array ? map[key] : [];
      if (arr.indexOf(pos) >= 0) return;
      arr.push(pos);
      /* не раздуваем хранилище: держим последние 2000 отметок на релиз */
      if (arr.length > 2000) arr = arr.slice(arr.length - 2000);
      map[key] = arr;
      try { storageSet(this.KEY, JSON.stringify(map)); } catch (e) { /* quota */ }
    },

    clear: function () {
      try { storageSet(this.KEY, '{}'); } catch (e) { /* noop */ }
    },

    /* Сбросить отметки одного релиза */
    removeRelease: function (relId) {
      if (!relId) return;
      var map = this.get();
      var key = String(relId);
      if (map[key] === undefined) return;
      delete map[key];
      try { storageSet(this.KEY, JSON.stringify(map)); } catch (e) { /* noop */ }
    }
  };

  /* ==========================================================
     3) TVNetwork — обход CORS
     ========================================================== */
  var TVNetwork = {
    PROXY_KEY: 'proxy_url',
    CORS_KEY: 'cors_mode',
    MODES: ['direct', 'public', 'custom'],

    getMode: function () {
      var m = storageGet(this.CORS_KEY, 'direct');
      return this.MODES.indexOf(m) >= 0 ? m : 'direct';
    },
    setMode: function (m) {
      storageSet(this.CORS_KEY, this.MODES.indexOf(m) >= 0 ? m : 'direct');
    },
    getProxyUrl: function () {
      var u = storageGet(this.PROXY_KEY, '');
      return u || CONFIG.defaultProxyUrl;
    },
    setProxyUrl: function (u) {
      /* нормализуем ввод: обрезаем пробелы и длину */
      u = String(u === undefined || u === null ? '' : u).replace(/^\s+|\s+$/g, '');
      if (u.length > 300) u = u.substring(0, 300);
      if (u && !/^https?:\/\//i.test(u)) return false;
      storageSet(this.PROXY_KEY, u);
      if (u) requestProxyAccess(u);
      return true;
    },

    /* Если прокси принимает адрес параметром (?url=, ?=) — адрес кодируется */
    isParamStyle: function (p) {
      var last = p.charAt(p.length - 1);
      return last === '?' || last === '=';
    },

    buildUrl: function (url, mode, proxy) {
      if (mode === 'public') {
        var p = CONFIG.publicProxies[0];
        return this.isParamStyle(p) ? p + encodeURIComponent(url) : p + url;
      }
      if (mode === 'custom') {
        var c = proxy || this.getProxyUrl();
        if (!c) return url;
        return this.isParamStyle(c) ? c + encodeURIComponent(url) : c + url;
      }
      return url;
    },

    /* Цепочка режимов с откатом: custom -> public -> direct */
    chainFor: function (mode) {
      if (mode === 'custom') return ['custom', 'public', 'direct'];
      if (mode === 'public') return ['public', 'direct'];
      return ['direct'];
    },

    /* GET -> Promise<text>. Таймаут на весь запрос, без зависания UI. */
    get: function (url, opts) {
      opts = opts || {};
      var mode = opts.mode || TVNetwork.getMode();
      var chain = TVNetwork.chainFor(mode);
      var timeout = opts.timeout || CONFIG.fetchTimeout;

      return new Promise(function (resolve, reject) {
        var timer = null;
        var done = false;

        function finish(err, val) {
          if (done) return;
          done = true;
          if (timer) { clearTimeout(timer); timer = null; }
          if (err) reject(err); else resolve(val);
        }

        timer = setTimeout(function () {
          finish(new Error('Timeout ' + timeout + 'ms'));
        }, timeout);

        function attempt(i) {
          if (done) return;
          if (i >= chain.length) {
            finish(new Error('Network error'));
            return;
          }
          var u = TVNetwork.buildUrl(url, chain[i], chain[i] === 'direct' ? null : opts.proxy);
          var p;
          try {
            p = fetch(u, {
              method: 'GET',
              mode: 'cors',
              cache: 'no-store',
              headers: opts.headers || {}
            });
          } catch (e) {
            attempt(i + 1);
            return;
          }
          p.then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          }).then(function (txt) {
            finish(null, txt);
          }).catch(function () {
            /* Не ломаем приложение: следующий режим в цепочке */
            attempt(i + 1);
          });
        }

        attempt(0);
      });
    },

    /* GET -> Promise<json> */
    getJSON: function (url, opts) {
      return TVNetwork.get(url, opts).then(function (txt) {
        try { return JSON.parse(txt); } catch (e) { throw new Error('Bad JSON'); }
      });
    }
  };

  /* ==========================================================
     AnixApi — API приложения AniXart (anixart)
     Базовый адрес берётся из публичного конфига проекта, ниже — запасные.
     Сервер отдаёт Access-Control-Allow-Origin: *, поэтому запросы идут
     напрямую, без прокси. Авторизация для каталога и серий не нужна.
     ========================================================== */
  var AnixApi = {
    CONFIG_URL: 'https://anixhelper.github.io/pages/urls.json',
    MIRRORS: ['https://api-s.anixsekai.com/', 'https://api.anixsekai.com/'],
    TIMEOUT: 15000,
    base: '',
    ready: null,

    normalizeBase: function (u) {
      u = String(u || '');
      if (!u) return this.MIRRORS[0];
      if (u.charAt(u.length - 1) !== '/') u += '/';
      return u;
    },

    /* Один раз читаем конфиг с базовым адресом; дальше работаем по нему. */
    init: function () {
      if (this.ready) return this.ready;
      var self = this;
      self.base = self.MIRRORS[0];
      self.ready = new Promise(function (resolve) {
        var settled = false;
        function done(b) {
          if (settled) return;
          settled = true;
          self.base = self.normalizeBase(b);
          resolve(self.base);
        }
        var timer = setTimeout(function () { done(self.MIRRORS[0]); }, 5000);
        try {
          fetch(self.CONFIG_URL, { method: 'GET', mode: 'cors', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (cfg) {
              clearTimeout(timer);
              var entry = (cfg && (cfg['default'] || cfg.ru)) || null;
              done(entry && entry.api_url ? entry.api_url : self.MIRRORS[0]);
            })
            .catch(function () {
              clearTimeout(timer);
              done(self.MIRRORS[0]);
            });
        } catch (e) {
          clearTimeout(timer);
          done(self.MIRRORS[0]);
        }
      });
      return this.ready;
    },

    request: function (path, method, body) {
      var self = this;
      return this.init().then(function () {
        var url = self.base + path;
        return new Promise(function (resolve, reject) {
          var timer = null;
          var done = false;
          function finish(err, val) {
            if (done) return;
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (err) reject(err); else resolve(val);
          }
          timer = setTimeout(function () { finish(new Error('Timeout')); }, self.TIMEOUT);
          var opts = {
            method: method,
            mode: 'cors',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' }
          };
          if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
          }
          var p;
          try { p = fetch(url, opts); } catch (e) { finish(e); return; }
          p.then(function (res) {
            if (!res.ok) { finish(new Error('HTTP ' + res.status)); return; }
            return res.text().then(function (txt) {
              try { finish(null, JSON.parse(txt)); }
              catch (e2) { finish(new Error('Bad JSON')); }
            });
          }).catch(function (e3) { finish(e3); });
        });
      });
    },

    get: function (path) { return this.request(path, 'GET', null); },
    post: function (path, body) { return this.request(path, 'POST', body || {}); },

    /* --- ручки API --- */

    /* Случайный релиз: GET release/random -> release */
    random: function () {
      return this.get('release/random').then(function (j) {
        if (!j || j.code !== 0 || !j.release) throw new Error('API ' + (j && j.code));
        return j.release;
      });
    },

    /* Карточка релиза: GET release/{id} */
    release: function (id) {
      return this.get('release/' + encodeURIComponent(id)).then(function (j) {
        if (!j || j.code !== 0 || !j.release) throw new Error('API ' + (j && j.code));
        return j.release;
      });
    },

    /* Поиск: POST search/releases/{page} + {"query": "..."} -> content[] */
    search: function (query, page) {
      return this.post('search/releases/' + (page || 0), { query: String(query || '') })
        .then(function (j) {
          if (!j || j.code !== 0) throw new Error('API ' + (j && j.code));
          return j.content || [];
        });
    },

    /* Связанные релизы: GET related/{related.id}/{page} -> content[] */
    related: function (relatedId, page) {
      return this.get('related/' + encodeURIComponent(relatedId) + '/' + (page || 0))
        .then(function (j) {
          if (!j || j.code !== 0) throw new Error('API ' + (j && j.code));
          return j.content || [];
        });
    },

    /* Все связанные: страницы по 25, пока не кончатся (не больше 5 страниц) */
    relatedAll: function (relatedId) {
      var self = this;
      var out = [];
      var seen = {};
      function step(page) {
        if (!relatedId || page > 4) return Promise.resolve(out);
        return self.related(relatedId, page).then(function (list) {
          if (!list.length) return out;
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var key = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
            if (!key || seen[key]) continue;
            seen[key] = 1;
            out.push(item);
          }
          if (list.length < 25) return out;
          return step(page + 1);
        });
      }
      return step(0);
    },

    /* Озвучки/субтитры: GET episode/{id} -> types[] */
    types: function (id) {
      return this.get('episode/' + encodeURIComponent(id)).then(function (j) {
        if (!j || j.code !== 0) return [];
        return j.types || [];
      });
    },

    /* Источники выбранной озвучки: GET episode/{id}/{typeId} -> sources[] */
    sources: function (id, typeId) {
      return this.get('episode/' + encodeURIComponent(id) + '/' + encodeURIComponent(typeId))
        .then(function (j) {
          if (!j || j.code !== 0) return [];
          return j.sources || [];
        });
    },

    /* Серии: GET episode/{id}/{typeId}/{sourceId} -> episodes[] (поле url) */
    episodes: function (id, typeId, sourceId) {
      return this.get('episode/' + encodeURIComponent(id) + '/' +
        encodeURIComponent(typeId) + '/' + encodeURIComponent(sourceId))
        .then(function (j) {
          if (!j || j.code !== 0) return [];
          return j.episodes || [];
        });
    }
  };

  /* Прямая ссылка на медиафайл или HTML-страница плеера источника */
  function isMediaUrl(u) {
    return /\.(mp4|m3u8|webm|m4v|mov|ts)(\?|#|$)/i.test(String(u || ''));
  }

  /* ---- Kodik: страница плеера, из которой можно получить прямой HLS ----
     Ссылки Kodik отдаёт POST/GET /ftor, но в закодированном виде:
     буквы сдвинуты на 18, затем base64. Сдвиг и раскодирование ниже. */
  function kodikParse(url) {
    var m = /^(https?:)?\/\/([a-z0-9]+\.[a-z]+)\/([a-z]+)\/(\d+)\/([0-9a-z]+)\/?(\d+p)?/i.exec(String(url || ''));
    if (!m) return null;
    return { host: String(m[2]), type: String(m[3]).toLowerCase(), id: String(m[4]),
      hash: String(m[5]), quality: m[6] || '' };
  }

  function kodikDecodeLink(src) {
    var shifted = String(src || '').replace(/[a-zA-Z]/g, function (ch) {
      var r = ch.charCodeAt(0);
      var lim = r <= 90 ? 90 : 122;
      r += 18;
      if (r > lim) r -= 26;
      return String.fromCharCode(r);
    });
    try {
      var s = window.atob(shifted);
      if (s.indexOf('//') === 0) s = 'https:' + s;
      return s;
    } catch (e) { return ''; }
  }

  /* Загрузка через нативный менеджер загрузок Tizen: тоже без CORS.
     Файл скачивается в приватное хранилище приложения и читается оттуда. */
  function tizenDownloadText(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!isTizen() || !tizen.download || typeof tizen.download.start !== 'function' || !tizen.filesystem) {
        reject(new Error('нет tizen.download'));
        return;
      }
      var name = 'kodik_' + (new Date()).getTime() + '.json';
      var dest = 'wgt-private/' + name;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timeout'));
      }, timeoutMs || 15000);

      function finish(err, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(val);
      }

      function readFile() {
        try {
          tizen.filesystem.resolve(dest, function (file) {
            try {
              file.openStream('r', function (stream) {
                var txt = '';
                try {
                  txt = stream.read(stream.bytesAvailable);
                  stream.close();
                } catch (eRead) { /* оставим пусто */ }
                finish(null, String(txt));
              }, function (eOpen) { finish(eOpen); }, 'UTF-8');
            } catch (e) { finish(e); }
          }, function (eRes) { finish(eRes); }, 'rw');
        } catch (e) { finish(e); }
      }

      var listener = {
        onprogress: function () { },
        onpaused: function () { },
        oncanceled: function () { finish(new Error('canceled')); },
        oncompleted: function () { readFile(); },
        onfailed: function (err) { finish(new Error((err && err.message) || 'download failed')); }
      };

      try {
        var req = new tizen.DownloadRequest(url, 'wgt-private', name, 'GET');
        tizen.download.start(req, listener);
      } catch (e) {
        finish(e);
      }
    });
  }

  /* Диагностика для экрана настроек: что доступно на этом телевизоре */
  var KODIK_DIAG = { error: '', via: '' };
  /* Диагностика плеера: какой источник открывали и что решили */
  var PLAY_DIAG = { url: '', decision: '', error: '' };

  function kodikDiag() {
    var http = false;
    var dl = false;
    var httpErr = '';
    try {
      http = !!(isTizen() && tizen.network && tizen.network.http && tizen.network.http.HttpClient);
      if (isTizen() && tizen.network && tizen.network.http && !http) httpErr = 'нет HttpClient';
    } catch (e) { httpErr = (e && e.message) || 'ошибка'; }
    try { dl = !!(isTizen() && tizen.download && typeof tizen.download.start === 'function'); } catch (e2) { dl = false; }
    return {
      http: http,
      download: dl,
      avplay: avplaySource(),
      error: KODIK_DIAG.error || '—',
      via: KODIK_DIAG.via || '—',
      httpErr: httpErr
    };
  }

  /* GET через нативный HTTP-клиент Tizen: не подчиняется CORS браузера */  function tizenHttpGet(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!isTizen() || !tizen.network || !tizen.network.http) {
        reject(new Error('нет tizen.network.http'));
        return;
      }
      var done = false;
      var client = null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (client) client.close(); } catch (eClose) { /* noop */ }
        reject(new Error('timeout'));
      }, timeoutMs || 12000);
      function finish(err, body) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (client) client.close(); } catch (e2) { /* noop */ }
        if (err) reject(err); else resolve(body);
      }
      try {
        client = new tizen.network.http.HttpClient();
        var req = new tizen.network.http.HttpRequest(url, 'GET');
        client.open(req, {
          onprogress: function () { },
          onheadersreceived: function () { },
          oncompleted: function (headers, status) {
            var body = '';
            try { body = client.readBodyToString(); } catch (eRead) { body = ''; }
            finish(null, body);
          },
          onaborted: function () { finish(new Error('aborted')); },
          onerror: function (err) { finish(new Error((err && err.message) || 'http error')); }
        });
        client.send();
      } catch (e) {
        finish(e);
      }
    });
  }

  /* GET через XHR: на Tizen сетевую политику приложения проходит чаще, чем fetch */
  function kodikHttpGet(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var xhr = new XMLHttpRequest();
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { xhr.abort(); } catch (eAbort) { /* noop */ }
        reject(new Error('timeout'));
      }, timeoutMs || 12000);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || done) return;
        done = true;
        clearTimeout(timer);
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('network'));
      };
      try {
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.send();
      } catch (e) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /* Доступные качества из ответа /ftor (от лучшего к худшему) */
  function kodikQualities(json) {
    var out = [];
    if (!json || !json.links) return out;
    var order = ['2160', '1080', '720', '480', '360', '240'];
    var i, k;
    for (i = 0; i < order.length; i++) {
      if (json.links[order[i]]) out.push(order[i]);
    }
    for (k in json.links) {
      if (!json.links.hasOwnProperty(k)) continue;
      if (out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }

  function kodikLinkFor(json, q) {
    if (!q || !json || !json.links || !json.links[q]) return '';
    var arr = json.links[q];
    for (var j = 0; j < arr.length; j++) {
      var u = kodikDecodeLink(arr[j].src);
      if (u && /m3u8|hls/i.test(u)) return u;
    }
    return arr.length ? kodikDecodeLink(arr[0].src) : '';
  }

  /* Выбрать поток: prefer = 'auto' | '1080' | '720' | ... */
  function kodikPickHls(json, prefer) {
    var avail = kodikQualities(json);
    if (!avail.length) return null;
    var q = '';
    if (prefer && prefer !== 'auto' && avail.indexOf(String(prefer)) >= 0) q = String(prefer);
    else q = avail[0];
    var url = kodikLinkFor(json, q);
    if (!url) return null;
    return { url: url, quality: q, available: avail };
  }

  /* ---- Libria (anixart.libria.fun): iframe-страница с Playerjs,
     внутри которой лежат прямые HLS-ссылки по качествам ---- */
  function libriaParse(url) {
    var m = /^(https?:)?\/\/([^\/]*libria\.fun)\/public\/iframe\.php\?([^#]*)/i.exec(String(url || ''));
    if (!m) return null;
    var q = m[3] || '';
    var id = /(?:^|&)id=(\d+)/.exec(q);
    var ep = /(?:^|&)ep=(\d+)/.exec(q);
    if (!id) return null;
    return { host: m[2], id: id[1], ep: ep ? ep[1] : '1' };
  }

  /* Разбор страницы: [480p]https://…m3u8?…,[720p]…,[1080p]… */
  function libriaStreams(html, id, ep) {
    var text = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    var found = [];
    var re = /\[(\d{3,4})p\]\s*(https?:\/\/[^,"'\]\s]+?\.m3u8[^,"'\]\s]*)/g;
    var m;
    while ((m = re.exec(text))) found.push({ quality: m[1], url: m[2] });
    if (!found.length) {
      var re2 = /(https?:\/\/[^,"'\]\s]+?\.m3u8[^,"'\]\s]*)/g;
      while ((m = re2.exec(text))) found.push({ quality: '', url: m[1] });
    }
    /* оставить только нужную серию: путь /ts/<id>/<ep>/ */
    var mine = [];
    if (id && ep) {
      var rx = new RegExp('/ts/' + id + '/' + ep + '/');
      for (var i = 0; i < found.length; i++) if (rx.test(found[i].url)) mine.push(found[i]);
    }
    var list = mine.length ? mine : found;
    var out = [];
    var seen = {};
    for (var j = 0; j < list.length; j++) {
      var q = list[j].quality || 'auto';
      if (seen[q]) continue;
      seen[q] = 1;
      out.push(list[j]);
    }
    return out;
  }

  function libriaPick(streams, prefer) {
    if (!streams || !streams.length) return null;
    var order = ['1080', '720', '480', '360'];
    var avail = [];
    for (var i = 0; i < streams.length; i++) avail.push(streams[i].quality || 'auto');
    var pick = null;
    if (prefer && prefer !== 'auto') {
      for (var j = 0; j < streams.length; j++) {
        if (String(streams[j].quality) === String(prefer)) { pick = streams[j]; break; }
      }
    }
    for (var k = 0; k < order.length && !pick; k++) {
      for (var n = 0; n < streams.length; n++) {
        if (String(streams[n].quality) === order[k]) { pick = streams[n]; break; }
      }
    }
    if (!pick) pick = streams[0];
    return { url: pick.url, quality: pick.quality || 'auto', available: avail };
  }

  /* Диагностика Libria: что ответили API и страница на этом телевизоре */
  var LIBRIA_DIAG = { api: '', page: '' };

  /* Разбор JSON API anilibria.top: episodes[].hls_1080/hls_720/hls_480 */
  function libriaFromApi(text, ep, prefer) {
    var j = null;
    try { j = JSON.parse(text); } catch (e) { return null; }
    var eps = j && j.episodes;
    if (!eps || !eps.length) return null;
    var num = Number(ep) || 1;
    var found = null;
    for (var i = 0; i < eps.length; i++) {
      if (Number(eps[i].ordinal) === num) { found = eps[i]; break; }
    }
    if (!found) found = eps[0];
    var order = ['1080', '720', '480'];
    var map = {};
    var avail = [];
    for (var k = 0; k < order.length; k++) {
      var key = 'hls_' + order[k];
      if (found[key]) { map[order[k]] = found[key]; avail.push(order[k]); }
    }
    if (!avail.length) return null;
    var q = (prefer && prefer !== 'auto' && map[String(prefer)]) ? String(prefer) : avail[0];
    return { url: map[q], quality: q, available: avail };
  }

  /* ==========================================================
     4) TVPlayer — мультирежимный плеер
     ========================================================== */
  var TVPlayer = {
    MODE_KEY: 'player_mode',
    mode: 'html5',
    container: null,
    video: null,
    toggleH: null,
    avInitialized: false,
    avListener: null,
    opened: false,
    webMode: false,
    externalUrl: '',
    fallbackWeb: '',
    curTime: 0,
    duration: 0,
    current: null,
    paused: false,
    /* выбор качества */
    qualities: [],
    quality: '',
    kodikUrl: '',
    sourceKind: '',      /* 'kodik' | 'libria' — для смены качества */
    sourceUrl: '',
    resolvedCache: {},   /* url|качество -> поток (на 5 минут) */
    menuOpen: false,
    menuIndex: 0,
    menuItems: [],

    init: function () {
      this.container = $('player_container');
      this.video = $('html5_element');
      this.mode = storageGet(this.MODE_KEY, 'avplay') === 'html5' ? 'html5' : 'avplay';
      this.container.classList.add('mode-' + this.mode);
      this.bindVideo();
      /* при смене разрешения окна/экрана держим AVPlay-прямоугольник актуальным */
      on(window, 'resize', function () { TVPlayer.syncAvplayRect(); });
      return this;
    },

    setMode: function (m) {
      this.mode = m === 'avplay' ? 'avplay' : 'html5';
      storageSet(this.MODE_KEY, this.mode);
      var c = this.container;
      c.classList.remove('mode-html5');
      c.classList.remove('mode-avplay');
      c.classList.add('mode-' + this.mode);
      return this.mode;
    },

    /* Текущее разрешение экрана ТВ (1080p/720p/4K) */
    screenSize: function () {
      var w = window.innerWidth || 1920;
      var h = window.innerHeight || 1080;
      var dh = isTizen() && tizen.systeminfo && typeof tizen.systeminfo.getCapability === 'function' ?
        (parseInt(tizen.systeminfo.getCapability('http://tizen.org/feature/screen.height'), 10) || 0) : 0;
      if (dh >= 2160) return { w: 3840, h: 2160 };
      if (w >= 3500) return { w: 3840, h: 2160 };
      if (w >= 1800 || (dh >= 1080)) return { w: 1920, h: 1080 };
      return { w: 1280, h: 720 };
    },

    syncAvplayRect: function () {
      var av = getTizenAvplay();
      if (!av || !this.avInitialized) return;
      var s = this.screenSize();
      try { av.setDisplayRect(0, 0, s.w, s.h); } catch (e) { /* noop */ }
    },

    isAvplayAvailable: function () {
      return getTizenAvplay() !== null;
    },

    /* ---- UI ---- */
    updateTimeUI: function () {
      var cur = this.curTime || 0;
      var dur = this.duration || 0;
      if ($('p_cur')) $('p_cur').textContent = fmt(cur);
      if ($('p_dur')) $('p_dur').textContent = fmt(dur);
      var pct = dur > 0 ? clamp(cur / dur * 100, 0, 100) : 0;
      if ($('p_fill')) $('p_fill').style.width = pct.toFixed(2) + '%';
    },

    startTicker: function () {
      var self = this;
      this.stopTicker();
      this.toggleH = setInterval(function () {
        if (!self.opened) return;
        if (self.mode === 'html5') {
          self.curTime = self.video.currentTime || 0;
          self.duration = isFinite(self.video.duration) ? (self.video.duration || 0) : 0;
        } else if (self.avInitialized && getTizenAvplay()) {
          try {
            var av = getTizenAvplay();
            self.curTime = TVPlayer.ms(av.getCurrentTime());
            var d = TVPlayer.ms(av.getDuration());
            if (d > 0) self.duration = d;
          } catch (e) { /* avplay может бросить до готовности */ }
        }
        self.updateTimeUI();
        /* историю пишем не чаще раза в 5 секунд — меньше операций с localStorage */
        var ts = (new Date()).getTime();
        if (self.current && ts - TVHistory.lastSave >= 5000) TVHistory.add(self.current);
      }, 1000);
    },

    stopTicker: function () {
      if (this.toggleH) { clearInterval(this.toggleH); this.toggleH = null; }
    },

    ms: function (v) { return Math.floor((Number(v) || 0) / 1000); },

    /* ---- HTML5 ---- */
    bindVideo: function () {
      var self = this;
      var v = this.video;
      if (!v) return;
      /* снимаем прежние, чтобы повторный bind не задваивал обработчики */
      this.unbindVideo();
      this.onLoadedMeta = function () {
        var d = isFinite(v.duration) ? (v.duration || 0) : 0;
        self.duration = d;
        var target = self.resumeTarget();
        if (target > 0 && Math.abs(v.currentTime - target) > CONFIG.toleranceSec) {
          try { v.currentTime = target; } catch (e) { /* noop */ }
        }
        self.updateTimeUI();
      };
      /* html5 video не отдаёт CORS-заголовки: crossorigin не ставим намеренно */
      this.onCanPlay = function () {
        Loader.hide();
        var p = v.play();
        if (p && p.catch) p.catch(function () { /* autoplay blocked */ });
      };
      this.onError = function () {
        Loader.hide();
        var code = v.error ? v.error.code : 0;
        toast('Не удалось воспроизвести видео (код ' + code + ')');
      };
      this.onTimeUpdate = function () {
        self.curTime = v.currentTime || 0;
        self.duration = isFinite(v.duration) ? (v.duration || 0) : self.duration;
        self.updateTimeUI();
      };
      this.onEnded = function () {
        self.saveProgress();
        self.handleEnded();
      };
      this.onWaiting = function () { self.bufferingShow(); };
      this.onPlaying = function () { self.bufferingHide(); };
      on(v, 'loadedmetadata', this.onLoadedMeta);
      on(v, 'canplay', this.onCanPlay);
      on(v, 'error', this.onError);
      on(v, 'timeupdate', this.onTimeUpdate);
      on(v, 'ended', this.onEnded);
      on(v, 'waiting', this.onWaiting);
      on(v, 'stalled', this.onWaiting);
      on(v, 'playing', this.onPlaying);
    },

    unbindVideo: function () {
      var v = this.video;
      if (!v) return;
      off(v, 'loadedmetadata', this.onLoadedMeta);
      off(v, 'canplay', this.onCanPlay);
      off(v, 'error', this.onError);
      off(v, 'timeupdate', this.onTimeUpdate);
      off(v, 'ended', this.onEnded);
      off(v, 'waiting', this.onWaiting);
      off(v, 'stalled', this.onWaiting);
      off(v, 'playing', this.onPlaying);
    },

    /* HTML5: жёсткая очистка памяти */
    clearHtml5: function () {
      var v = this.video;
      if (!v) return;
      try { v.pause(); } catch (e) { /* noop */ }
      this.unbindVideo();
      v.removeAttribute('src');
      try { v.load(); } catch (e2) { /* noop */ }
      v.removeAttribute('poster');
    },

    /* Встроенный плеер источника: страница kodik/sibnet/libria в iframe */
    openWeb: function (url, item) {      var self = this;
      if (self.opened) { self.saveProgress(); self.reset(); }
      item = item || {};
      self.webMode = true;
      self.opened = true;
      self.paused = false;
      self.curTime = 0;
      self.duration = 0;
      self.current = {
        id: item.id,
        title: item.title || '',
        poster: item.poster || '',
        episode: item.episode || 1,
        time: 0,
        src: url
      };
      if (self.container) {
        self.container.classList.add('active');
        self.container.classList.add('mode-web');
      }
      var f = $('web_element');
      if (f) f.setAttribute('src', url);
      self.externalUrl = url;
      if ($('p_title')) $('p_title').textContent = item.title || 'Без названия';
      Loader.hide();
    },

    /* Встроенные плееры источников (Kodik и подобные) не реагируют на пульт:
       внутри iframe нельзя нажать Play. Открываем страницу в браузере телевизора,
       где есть указатель и можно нажать кнопку. */
    openExternal: function () {
      var url = this.externalUrl;
      if (!url) return false;
      try {
        if (isTizen() && tizen.application && typeof tizen.application.launchAppControl === 'function') {
          var ac = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
          tizen.application.launchAppControl(ac, null, null, function (err) {
            toast('Не удалось открыть браузер: ' + ((err && err.message) || 'ошибка'));
          });
          return true;
        }
      } catch (e) { /* нет tizen — пробуем window.open */ }
      try {
        var w = window.open(url, '_blank');
        if (w) return true;
      } catch (e2) { /* noop */ }
      toast('Браузер недоступен: ' + url, 4000);
      return false;
    },

    clearWeb: function () {
      this.webMode = false;
      this.externalUrl = '';
      var f = $('web_element');
      if (f) f.removeAttribute('src');
      if (this.container) this.container.classList.remove('mode-web');
    },

    /* ---- Плеер сбросить в известное состояние (повторное открытие) ---- */
    reset: function () {
      this.opened = false;
      this.stopTicker();
      this.hideQualityMenu();
      this.bufferingHide();
      if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = null; }
      var ui = $('player_ui');
      if (ui) ui.classList.remove('ui_hidden');
      this.uiVisible = true;
      if (this.seekTimer) { clearTimeout(this.seekTimer); this.seekTimer = null; }
      this.pendingSeek = null;
      this.qualities = [];
      this.quality = '';
      this.kodikUrl = '';
      this.sourceKind = '';
      this.sourceUrl = '';
      Loader.hide();
      this.clearHtml5();
      this.avClear();
      this.avListener = null;
      this.clearWeb();
      this.video = $('html5_element');
      this.container.classList.remove('active');
      this.current = null;
      this.fallbackWeb = '';
      this.curTime = 0;
      this.duration = 0;
      this.paused = false;
      if ($('p_fill')) $('p_fill').style.width = '0%';
      if ($('p_cur')) $('p_cur').textContent = '00:00';
      if ($('p_dur')) $('p_dur').textContent = '00:00';
      /* обработчики video снимаются в clearHtml5(), возвращаем их для следующего запуска */
      this.bindVideo();
    },

    /* Шаг перемотки стрелками (секунды): 10 / 20 / 30 / 70 / 77 */
    SEEK_STEPS: [10, 20, 30, 70, 77],

    seekStep: function () {
      var s = parseInt(storageGet('seek_step', '10'), 10);
      if (this.SEEK_STEPS.indexOf(s) < 0) s = 10;
      return s;
    },

    /* Синяя кнопка в плеере: следующий шаг перемотки по кругу */
    cycleSeekStep: function () {
      var steps = this.SEEK_STEPS;
      var i = steps.indexOf(this.seekStep());
      if (i < 0) i = 0;
      var next = steps[(i + 1) % steps.length];
      storageSet('seek_step', String(next));
      this.updateHint();
      this.showUI();
      toast('Шаг перемотки: ' + next + ' с', 2000);
      return next;
    },

    /* Подсказка в плеере: собирается из текущих настроек */
    hintText: function () {
      return 'RETURN — выход &nbsp;|&nbsp; OK — пауза &nbsp;|&nbsp; ← → — ' + this.seekStep() +
        ' с &nbsp;|&nbsp; 1–9 — % &nbsp;|&nbsp; ▲▼ — скрыть &nbsp;|&nbsp; CH± — серии &nbsp;|&nbsp; ' +
        'ЖЁЛТАЯ — качество &nbsp;|&nbsp; СИНЯЯ — шаг &nbsp;|&nbsp; ЗЕЛЁНАЯ — статистика';
    },

    updateHint: function () {
      if ($('p_hint')) $('p_hint').innerHTML = this.hintText();
    },

    /* Строка под названием: качество, доступные варианты, буфер */
    updateMeta: function () {
      var el = $('p_meta');
      if (!el) return;
      var parts = [];
      parts.push(this.quality ? (this.quality === 'auto' ? 'авто' : this.quality + 'p') : 'качество —');
      if (this.qualities && this.qualities.length) parts.push('доступно ' + this.qualities.join('/'));
      var bs = parseInt(storageGet('buffer_sec', '10'), 10);
      parts.push('буфер ' + (bs && bs >= 2 ? bs : 10) + ' с');
      el.textContent = parts.join(' · ');
    },

    /* Перемотка в процент длительности (цифры 1–9 на пульте) */
    seekPercent: function (pct) {
      if (!this.opened || this.webMode) return;
      var d = this.duration || 0;
      if (d <= 0) return;
      var t = Math.max(0, Math.min(d - 1, d * pct / 100));
      this.curTime = t;
      this.updateTimeUI();
      this.showUI();
      if (this.mode === 'avplay' && this.avInitialized && getTizenAvplay()) {
        try { getTizenAvplay().seekTo(Math.floor(t * 1000)); } catch (e) { /* noop */ }
      } else if (this.video) {
        try { this.video.currentTime = t; } catch (e2) { /* noop */ }
      }
    },

    /* Экран статистики (кнопка INFO) */
    toggleStats: function () {
      var el = $('p_stats');
      if (!el) return;
      if (el.classList.contains('active')) {
        el.classList.remove('active');
        return;
      }
      var lines = [];
      lines.push('Качество: ' + (this.quality || '—') +
        (this.qualities && this.qualities.length ? '  (доступно ' + this.qualities.join('/') + ')' : ''));
      var bs = parseInt(storageGet('buffer_sec', '10'), 10) || 10;
      lines.push('Режим: ' + this.mode + ' · буфер ' + bs + ' с');
      lines.push('Время: ' + fmt(this.curTime || 0) + ' / ' + fmt(this.duration || 0));
      lines.push('Поток: ' + String((this.current && this.current.src) || '').replace(/^https?:\/\//, '').slice(0, 90));
      var bnd = window.ANI_BUNDLE;
      lines.push('Код: ' + (bnd && bnd.version ? (bnd.version + ' (GitHub)') : 'встроенная'));
      lines.push('Буферизаций за 2 мин: ' + (this.bufEvents ? this.bufEvents.length : 0));
      el.textContent = lines.join('\n');
      el.classList.add('active');
      this.showUI(true);
    },

    /* ---- интерфейс плеера: скрываем через 2 секунды, ▲▼ — вручную ---- */
    showUI: function (sticky) {
      var el = $('player_ui');
      if (el) el.classList.remove('ui_hidden');
      this.uiVisible = true;
      if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = null; }
      if (sticky) return;
      var self = this;
      this.uiTimer = setTimeout(function () {
        self.uiTimer = null;
        if (self.paused) return;      /* на паузе интерфейс оставляем видимым */
        self.hideUI();
      }, 2000);
    },

    hideUI: function () {
      if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = null; }
      var el = $('player_ui');
      if (el) el.classList.add('ui_hidden');
      this.uiVisible = false;
    },

    toggleUI: function () {
      if (this.uiVisible) this.hideUI();
      else this.showUI();
    },

    /* ---- индикатор буферизации: маленькая плашка, только если ждать реально долго ---- */
    bufferingShow: function () {
      var self = this;
      if (self.bufTimer) clearTimeout(self.bufTimer);
      self.bufTimer = setTimeout(function () {
        self.bufTimer = null;
        var el = $('buffer_pill');
        if (el) el.classList.add('active');
      }, 900);

      /* счётчик буферизаций: если сеть нестабильна — понижаем качество один раз */
      var now = (new Date()).getTime();
      self.bufEvents = self.bufEvents || [];
      self.bufEvents.push(now);
      var fresh = [];
      for (var i = 0; i < self.bufEvents.length; i++) {
        if (now - self.bufEvents[i] < 120000) fresh.push(self.bufEvents[i]);
      }
      self.bufEvents = fresh;
      if (self.bufEvents.length >= 3) self.autoDowngrade();
    },

    /* Автопонижение качества при частой буферизации (один раз за серию) */
    autoDowngrade: function () {
      if (!this.opened || this.webMode || this.autoDownDone) return;
      this.autoDownDone = true;
      var list = this.qualities || [];
      if (!list.length) return;
      var order = ['1080', '720', '480', '360'];
      var cur = String(this.quality || '');
      var from = order.indexOf(cur);
      var next = '';
      for (var i = from + 1; i < order.length; i++) {
        if (list.indexOf(order[i]) >= 0) { next = order[i]; break; }
      }
      if (!next) return;
      var pos = this.curTime || 0;
      var url = this.sourceUrl || this.kodikUrl;
      if (!url) return;
      toast('Нестабильная сеть — качество ' + next + 'p', 3000);
      var item = {
        id: this.current ? this.current.id : '',
        title: this.current ? this.current.title : '',
        poster: this.current ? this.current.poster : '',
        episode: this.current ? this.current.episode : 1,
        src: url
      };
      if (this.sourceKind === 'libria') this.playLibria(url, item, next, pos);
      else this.playKodik(url, item, next, pos);
    },

    bufferingHide: function () {
      if (this.bufTimer) { clearTimeout(this.bufTimer); this.bufTimer = null; }
      var el = $('buffer_pill');
      if (el) el.classList.remove('active');
    },

    /* ---- AVPlay ---- */
    avGetListener: function () {
      var self = this;
      if (self.avListener) return self.avListener;
      self.avListener = {
        onbufferingstart: function () { self.bufferingShow(); },
        onbufferingprogress: function () {},
        onbufferingcomplete: function () { self.bufferingHide(); },
        oncurrentplaytime: function (ms) {
          /* приходит часто — здесь только время, без DOM-записей */
          self.curTime = self.ms(ms);
        },
        onstreamcompleted: function () { self.saveProgress(); self.handleEnded(); },
        onerror: function () {
          Loader.hide();
          toast('Ошибка воспроизведения AVPlay');
          self.avClear();
        }
      };
      return self.avListener;
    },

    avClear: function () {
      var wasInit = this.avInitialized || this.avListener;
      this.avInitialized = false;
      var av = getTizenAvplay();
      if (av && wasInit) {
        try { av.stop(); } catch (e) { /* noop */ }
        try { av.close(); } catch (e) { /* noop */ }
      }
      /* Обнуляем ссылку на object: после close() AVPlay требует свежий элемент */
      var obj = $('avplay_element');
      if (obj) {
        try {
          var fresh = obj.cloneNode(false);
          if (av && wasInit) {
            try { fresh.setAttribute('src', ''); } catch (e2) { /* noop */ }
          }
          if (obj.parentNode) obj.parentNode.replaceChild(fresh, obj);
        } catch (e3) { /* noop */ }
      }
      this.avListener = null;
    },

    openAvplay: function (url) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var av = getTizenAvplay();
        if (!av) {
          reject(new Error('AVPlay unavailable'));
          return;
        }
        try {
          if (self.avInitialized) self.avClear();
          /* Samsung AVPlay перед первым открытием требует init() */
          try { if (typeof av.init === 'function') av.init(); } catch (eInitAv) { /* уже инициализирован */ }
          /* 1) open */
          av.open(url);
          /* 2) setDisplayRect — под реальное разрешение экрана */
          var s = self.screenSize();
          try {
            av.setDisplayRect(0, 0, s.w, s.h);
          } catch (eRect) {
            try { av.setDisplayRect(0, 0, 1920, 1080); } catch (eR2) { /* noop */ }
          }
          /* 3) setListener */
          av.setListener(self.avGetListener());
          /* 3b) буфер: применяем до prepare, иначе параметры не подхватятся */
          self.applyBuffer(av);
          self.avInitialized = true;
          /* 4) prepareAsync -> seek -> play */
          av.prepareAsync(function () {
            try {
              var d = self.ms(av.getDuration());
              if (d > 0) self.duration = d;
              var target = self.resumeTarget();
              if (target > 0) {
                try { av.seekTo(target * 1000); } catch (eSeek) { /* noop */ }
                self.curTime = target;
              }
              /* 5) play */
              av.play();
              self.updateTimeUI();
              Loader.hide();
              resolve(true);
            } catch (ePlay) {
              Loader.hide();
              reject(ePlay);
            }
          }, function (err) {
            Loader.hide();
            reject(err || new Error('prepare failed'));
          });
        } catch (e) {
          Loader.hide();
          reject(e);
        }
      });
    },

    /* Серия доиграла: если открыт релиз — включаем следующую */
    handleEnded: function () {
      if (typeof TVRelease === 'undefined' || !TVRelease.rel) return;
      TVRelease.playNext();
    },

    /* Размер буфера AVPlay в секундах: больше — меньше «буферизации» при перемотке */
    applyBuffer: function (av) {
      if (!av) return;
      var sec = parseInt(storageGet('buffer_sec', '10'), 10);
      if (!sec || sec < 2) sec = 10;
      try {
        if (typeof av.setBufferingParam === 'function') {
          av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', sec);
          av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', sec);
        }
      } catch (eBuf) { /* прошивка без параметров буфера */ }
      try {
        if (typeof av.setTimeoutForBuffering === 'function') {
          av.setTimeoutForBuffering(Math.max(10, sec * 2));
        }
      } catch (eTo) { /* noop */ }
    },

    /* Точка возобновления: ограничена duration, без мусорных «доигрываний» */
    resumeTarget: function () {
      if (!this.current) return 0;
      var d = this.duration > 0 ? this.duration : 0;
      var t = Number(this.current.time) || 0;
      if (t <= CONFIG.minResumeSec) return 0;
      if (d > 0 && t > d - CONFIG.endThresholdSec) return 0;
      return clamp(t, 0, d > 0 ? d - 1 : t);
    },

    /* ---- Публичный API ---- */
    open: function (item, forceMode) {
      /* item: { id, title, poster, episode, time, src, playSrc } */
      var self = this;
      if (!item) return;
      item.src = item.src || CONFIG.defaultSrc;
      var mode = forceMode || self.mode;
      var playUrl = item.playSrc || item.src;
      /* Режим должен совпадать с реально используемым плеером: от него зависят
         и класс контейнера (какой элемент виден), и источник времени в тикере.
         Иначе HLS играет звуком через AVPlay, а страница показывает чёрный <video>
         и время стоит на 00:00. */
      if (mode !== self.mode) self.setMode(mode);

      /* Повторное открытие (другой фильм или повтор того же) */
      if (self.opened) {
        self.saveProgress();
        self.reset();
      }

      var hist = TVHistory.find(item.id);
      var resume = (item.resumeTime !== undefined && item.resumeTime !== null) ? item.resumeTime :
        (hist ? hist.time : (item.time || 0));
      self.current = {
        id: item.id,
        title: item.title || '',
        poster: item.poster || '',
        episode: item.episode || 1,
        time: resume || 0,
        src: item.src
      };

      self.opened = true;
      self.paused = false;
      self.autoDownDone = false;
      self.bufEvents = [];
      var statEl = $('p_stats');
      if (statEl) statEl.classList.remove('active');
      self.curTime = resume || 0;
      self.duration = 0;
      Loader.show('Загрузка...');
      self.container.classList.add('active');
      if ($('p_title')) $('p_title').textContent = item.title || 'Без названия';
      self.updateHint();
      self.updateMeta();
      self.showUI();
      self.updateTimeUI();

      var fail = function () {
        self.avClear();
        if (self.fallbackWeb) {
          /* поток Kodik не открылся — показываем страницу источника */
          var webUrl = self.fallbackWeb;
          self.fallbackWeb = '';
          toast('Поток не открылся — встроенный плеер источника');
          self.openWeb(webUrl, item);
          return;
        }
        if (mode === 'avplay') {
          /* AVPlay не открылся — откат на HTML5 без потери сессии */
          self.setMode('html5');
          toast('AVPlay недоступен — переключено на HTML5');
          self.openHtml5(item);
        } else {
          Loader.hide();
        }
      };

      if (mode === 'avplay') {
        self.openAvplay(playUrl).then(function () {
          self.startTicker();
        }).catch(function () {
          fail();
        });
      } else {
        self.openHtml5(item);
      }
    },

    /* Kodik: получить прямой HLS из страницы плеера.
       XHR и нативная загрузка идут ПАРАЛЛЕЛЬНО — что ответит быстрее, то и берём
       (раньше загрузка пробовалась первой и старт серии растягивался на секунды). */
    resolveKodik: function (url, prefer) {
      var info = kodikParse(url);
      if (!info) return Promise.reject(new Error('not kodik'));
      var api = 'https://kodikplayer.com/ftor?hash=' + encodeURIComponent(info.hash) +
        '&id=' + encodeURIComponent(info.id) + '&type=' + encodeURIComponent(info.type);

      /* кеш ссылок: повторный запуск той же серии — мгновенно */
      var key = url + '|' + String(prefer || 'auto');
      var cached = this.resolvedCache[key];
      var now = (new Date()).getTime();
      if (cached && now - cached.ts < 5 * 60 * 1000) {
        KODIK_DIAG.via = 'ok (кеш)';
        return Promise.resolve(cached.picked);
      }

      var t0 = now;
      return Promise.race([
        kodikHttpGet(api, 10000),
        tizenDownloadText(api, 12000)
      ]).catch(function (e1) {
        /* если оба быстрых способа не справились — последний резерв: fetch/прокси */
        return TVNetwork.get(api, { timeout: 8000, mode: 'direct' }).catch(function (e2) {
          KODIK_DIAG.error = 'xhr+dl: ' + (e1.message || '-') + ' / fetch: ' + (e2.message || '-');
          throw new Error(KODIK_DIAG.error);
        });
      }).then(function (txt) {
        var json = null;
        try { json = JSON.parse(txt); } catch (e) { throw new Error('Bad JSON'); }
        var picked = kodikPickHls(json, prefer);
        if (!picked) throw new Error('No links');
        this.resolvedCache[key] = { picked: picked, ts: (new Date()).getTime() };
        KODIK_DIAG.via = 'ok ' + ((new Date()).getTime() - t0) + ' мс';
        KODIK_DIAG.error = '';
        return picked;
      }.bind(this));
    },

    /* Libria: сначала API anilibria.top (другой хост, отдаёт HLS по сериям),
       если он недоступен — разбираем iframe-страницу. */
    resolveLibria: function (url, prefer) {
      var info = libriaParse(url);
      if (!info) return Promise.reject(new Error('not libria'));
      var api = 'https://anilibria.top/api/v1/anime/releases/' + encodeURIComponent(info.id);

      function fetchText(u, slot) {
        var log = [];
        function note(stage, err) {
          log.push(stage + (err ? ':' + (err.message || err) : ':ok'));
        }
        function done(txt) {
          LIBRIA_DIAG[slot] = log.join(' ');
          return txt;
        }
        return tizenHttpGet(u, 12000).then(function (txt) {
          note('http');
          return done(txt);
        }).catch(function (e1) {
          note('http', e1);
          return tizenDownloadText(u, 15000).then(function (txt) {
            note('dl');
            return done(txt);
          }).catch(function (e2) {
            note('dl', e2);
            return kodikHttpGet(u, 12000).then(function (txt) {
              note('xhr');
              return done(txt);
            }).catch(function (e3) {
              note('xhr', e3);
              LIBRIA_DIAG[slot] = log.join(' ');
              throw e3;
            });
          });
        });
      }

      LIBRIA_DIAG.api = '';
      LIBRIA_DIAG.page = '';
      function tag(slot) {
        return '#' + info.id + ' ' + (LIBRIA_DIAG[slot] || '');
      }
      return fetchText(api, 'api').then(function (json) {
        var picked = libriaFromApi(json, info.ep, prefer);
        if (picked) return picked;
        LIBRIA_DIAG.api = 'нет серий';
        throw new Error('No links in API');
      }).catch(function () {
        LIBRIA_DIAG.api = tag('api');
        /* резерв: страница iframe */
        return fetchText(url, 'page').then(function (html) {
          var picked = libriaPick(libriaStreams(html, info.id, info.ep), prefer);
          if (!picked) {
            LIBRIA_DIAG.page = 'нет ссылок';
            throw new Error('No links');
          }
          return picked;
        }).catch(function (e2) {
          LIBRIA_DIAG.page = tag('page');
          throw e2;
        });
      });
    },

    /* Открыть серию Libria в AVPlay */
    playLibria: function (url, item, prefer, resumeAt) {
      var self = this;
      item = item || {};
      if (!self.isAvplayAvailable()) {
        self.openWeb(url, item);
        return;
      }
      if (!prefer) prefer = self.qualityPref();
      Loader.show('Получение видео...');
      self.resolveLibria(url, prefer).then(function (picked) {
        Loader.hide();
        var next = {};
        for (var k in item) {
          if (item.hasOwnProperty(k)) next[k] = item[k];
        }
        next.src = url;
        next.playSrc = picked.url;
        if (resumeAt !== undefined && resumeAt !== null) next.resumeTime = resumeAt;
        self.open(next, 'avplay');
        self.fallbackWeb = url;
        self.sourceKind = 'libria';
        self.sourceUrl = url;
        self.qualities = picked.available || [];
        self.quality = picked.quality || '';
        self.updateMeta();
      }).catch(function (e) {
        Loader.hide();
        PLAY_DIAG.error = 'API ' + (LIBRIA_DIAG.api || '—') + ' / страница ' + (LIBRIA_DIAG.page || '—');
        /* если Libria недоступна — пробуем Kodik с другой озвучкой */
        if (typeof TVRelease !== 'undefined' && TVRelease.rel && TVRelease.playKodikFallback) {
          toast('Libria недоступна — пробую Kodik', 3000);
          TVRelease.playKodikFallback(item.episode);
          return;
        }
        toast('Libria: ' + (e && e.message) + '', 4000);
        self.openWeb(url, item);
      });
    },

    /* Открыть серию Kodik во встроенном плеере (AVPlay + HLS).
       prefer — желаемое качество ('auto' или '720' и т.п.), resumeAt — секунда. */
    playKodik: function (url, item, prefer, resumeAt) {
      var self = this;
      item = item || {};
      if (!self.isAvplayAvailable()) {
        self.openWeb(url, item);
        return;
      }
      if (!prefer) prefer = self.qualityPref();
      /* индикатор показываем только если получение ссылки реально затянулось */
      var loaderTimer = setTimeout(function () { Loader.show('Получение видео...'); }, 400);
      function stopLoader() {
        if (loaderTimer) { clearTimeout(loaderTimer); loaderTimer = null; }
      }
      self.resolveKodik(url, prefer).then(function (picked) {
        stopLoader();
        Loader.hide();
        var next = {};
        for (var k in item) {
          if (item.hasOwnProperty(k)) next[k] = item[k];
        }
        next.src = url;              /* в истории остаётся страница Kodik */
        next.playSrc = picked.url;   /* фактический поток — HLS, играет AVPlay */
        if (resumeAt !== undefined && resumeAt !== null) next.resumeTime = resumeAt;
        self.open(next, 'avplay');
        /* после open() — потому что reset() внутри open чистит состояние */
        self.fallbackWeb = url;
        self.kodikUrl = url;
        self.sourceKind = 'kodik';
        self.sourceUrl = url;
        self.qualities = picked.available || [];
        self.quality = picked.quality || '';
        self.updateMeta();
      }).catch(function (e) {
        stopLoader();
        Loader.hide();
        PLAY_DIAG.error = String((e && e.message) || 'ошибка');
        toast('Kodik: ' + ((e && e.message) || 'ошибка') + ' — встроенный плеер', 4000);
        self.openWeb(url, item);
      });
    },

    /* ---- выбор качества в плеере ---- */
    qualityPref: function () {
      var q = storageGet('video_quality', 'auto');
      return q || 'auto';
    },

    showQualityMenu: function () {
      if (!this.opened || this.webMode) return;
      var list = (this.qualities && this.qualities.length) ? this.qualities.slice() : [];
      if (!list.length) { toast('Качество недоступно'); return; }
      this.menuItems = ['auto'].concat(list).concat(['restart']);
      var idx = this.menuItems.indexOf(this.quality);
      this.menuIndex = idx >= 0 ? idx : 0;
      this.menuOpen = true;
      this.renderQualityMenu();
      var el = $('quality_menu');
      if (el) el.classList.add('active');
    },

    renderQualityMenu: function () {
      var box = $('quality_list');
      if (!box) return;
      box.innerHTML = '';
      for (var i = 0; i < this.menuItems.length; i++) {
        var it = this.menuItems[i];
        var row = document.createElement('div');
        row.className = 'qm_item' + (i === this.menuIndex ? ' active' : '');
        row.textContent = it === 'auto' ? 'Авто (лучшее)'
          : (it === 'restart' ? 'С начала' : (it + 'p'));
        box.appendChild(row);
      }
    },

    qualityMove: function (delta) {
      if (!this.menuOpen) return;
      var n = this.menuItems.length;
      if (!n) return;
      this.menuIndex = (this.menuIndex + delta + n) % n;
      this.renderQualityMenu();
    },

    hideQualityMenu: function () {
      this.menuOpen = false;
      var el = $('quality_menu');
      if (el) el.classList.remove('active');
    },

    qualitySelect: function () {
      if (!this.menuOpen) return;
      var q = this.menuItems[this.menuIndex];
      var pos = this.curTime || 0;
      var url = this.sourceUrl || this.kodikUrl;
      var kind = this.sourceKind || 'kodik';
      this.hideQualityMenu();
      if (q === 'restart') {
        this.seekPercent(0);
        toast('Начинаем сначала', 2000);
        return;
      }
      storageSet('video_quality', q);
      if (!url) return;
      var item = {
        id: this.current ? this.current.id : '',
        title: this.current ? this.current.title : '',
        poster: this.current ? this.current.poster : '',
        episode: this.current ? this.current.episode : 1,
        src: url
      };
      toast('Качество: ' + (q === 'auto' ? 'авто' : q + 'p'));
      if (kind === 'libria') this.playLibria(url, item, q, pos);
      else this.playKodik(url, item, q, pos);
    },

    openHtml5: function (item) {
      var self = this;
      var v = self.video;
      if (!v) return;
      /* Сносим состояние предыдущего воспроизведения */
      try { v.pause(); } catch (e) { /* noop */ }
      v.removeAttribute('src');
      try { v.load(); } catch (e2) { /* noop */ }
      if (item.poster) v.setAttribute('poster', item.poster);
      v.setAttribute('src', item.playSrc || item.src);
      try { v.load(); } catch (e3) { /* noop */ }
      self.startTicker();
    },

    /* Синхронизируем прогресс в историю */
    saveProgress: function () {
      if (!this.current) return;
      var t = this.curTime || 0;
      if (this.duration > 0) t = clamp(t, 0, this.duration - 1);
      this.current.time = Math.max(0, Math.floor(t));
      TVHistory.add(this.current);
    },

    togglePause: function () {
      if (!this.opened) return;
      if (this.webMode) return;      /* управление внутри встроенного плеера */
      if (this.mode === 'html5') {
        if (this.video.paused) {
          var p = this.video.play();
          if (p && p.catch) p.catch(function () {});
          this.paused = false;
        } else {
          this.video.pause();
          this.paused = true;
        }
      } else if (this.avInitialized && getTizenAvplay()) {
        try {
          var av = getTizenAvplay();
          if (this.paused) { av.play(); this.paused = false; }
          else { av.pause(); this.paused = true; }
        } catch (e) { /* noop */ }
      }
      /* на паузе интерфейс показываем и не скрываем; при продолжении — снова таймер */
      if (this.paused) this.showUI(true);
      else this.showUI();
    },

    seek: function (deltaSec) {
      if (!this.opened) return;
      if (this.webMode) return;      /* перемотка — средствами плеера источника */
      var d = this.duration || 0;
      var target = clamp((this.curTime || 0) + deltaSec, 0, d > 0 ? d - 1 : 0);
      this.curTime = target;
      this.updateTimeUI();
      this.showUI();

      /* Автоповтор пульта шлёт seek десятки раз подряд — каждый запускает
         новую загрузку сегмента и «буферизацию». Склеиваем: применяем только
         последнюю позицию, когда нажатия прекратились. */
      var self = this;
      self.pendingSeek = target;
      if (self.seekTimer) clearTimeout(self.seekTimer);
      self.seekTimer = setTimeout(function () {
        self.seekTimer = null;
        var t = self.pendingSeek;
        self.pendingSeek = null;
        if (t === null || t === undefined) return;
        if (self.mode === 'html5') {
          try { self.video.currentTime = t; } catch (e) { /* noop */ }
        } else if (self.avInitialized && getTizenAvplay()) {
          try {
            var av = getTizenAvplay();
            if (typeof av.seekTo === 'function') av.seekTo(Math.floor(t * 1000));
          } catch (e2) { /* noop */ }
        }
      }, 350);
    },

    /* RETURN в плеере — закрыть плеер, НЕ приложение */
    close: function () {
      if (!this.opened) return;
      this.saveProgress();
      this.reset();

      TVHistory.render();

      /* Возврат туда, откуда запускали: сначала экран релиза */
      if (TVRelease.rel) {
        TVRelease.show();
        TVNavigation.refresh();
        var play = $('rel_play');
        if (play) TVNavigation.focus(play, true);
        return;
      }

      var cur = TVNavigation.current;
      if (cur && document.body.contains(cur) && cur.offsetParent !== null) {
        TVNavigation.focus(cur, true);
      } else {
        TVNavigation.init();
      }
    }
  };

  /* ==========================================================
     Настройки (интерфейс)
     ========================================================== */
  var TVSettings = {
    show: function (force) {
      var s = $('settings_view');
      var m = $('main_view');
      if (!s || !m) return;
      var isOn = s.style.display === 'flex';
      if ((force === true && isOn) || force === false || (force === undefined && isOn)) {
        if (force === true) return;
        this.hide();
        return;
      }
      this.render();
      hideListViews();
      var nv = $('net_view');
      if (nv) nv.style.display = 'none';
      s.style.display = 'flex';
      m.style.display = 'none';
      TVNavigation.focus(s.querySelector('.focusable'));
    },
    hide: function () {
      var s = $('settings_view');
      var m = $('main_view');
      if (!s || !m) return;
      s.style.display = 'none';
      m.style.display = 'block';
      TVNavigation.focus(document.querySelector('[data-nav="settings"]') ||
        document.querySelector('.focusable'));
    },
    isOpen: function () {
      var s = $('settings_view');
      return !!s && s.style.display === 'flex';
    },
    render: function () {
      var pm = storageGet('player_mode', 'avplay') === 'html5' ? 'html5' : 'avplay';
      var cm = TVNetwork.getMode();
      if ($('val_player_type')) $('val_player_type').textContent = pm;
      if ($('val_cors_mode')) $('val_cors_mode').textContent = cm;
      if ($('val_proxy_url')) $('val_proxy_url').textContent = TVNetwork.getProxyUrl();
      if ($('val_video_quality')) {
        var vq = storageGet('video_quality', 'auto');
        $('val_video_quality').textContent = vq && vq !== 'auto' ? (vq + 'p') : 'авто';
      }
      if ($('val_buffer_sec')) {
        var bs = parseInt(storageGet('buffer_sec', '10'), 10);
        $('val_buffer_sec').textContent = (bs && bs >= 2 ? bs : 10) + ' сек';
      }
      if ($('val_seek_step')) $('val_seek_step').textContent = TVPlayer.seekStep() + ' с';
      if ($('val_hide_watched')) {
        $('val_hide_watched').textContent = storageGet('hide_watched', '0') === '1' ? 'вкл' : 'выкл';
      }
      if ($('val_last_key')) {
        var lk = window.__LAST_KEY;
        $('val_last_key').textContent = lk ? (lk.code + (lk.name ? ' · ' + lk.name : '')) : '—';
      }
      /* диагностика сетевых возможностей для плеера Kodik */
      try {
        var d = kodikDiag();
        if ($('diag_http')) {
          $('diag_http').textContent = d.http ? 'есть' : ('нет' + (d.httpErr ? ' — ' + d.httpErr : ''));
        }
        if ($('diag_download')) $('diag_download').textContent = d.download ? 'есть' : 'нет';
        if ($('diag_avplay')) $('diag_avplay').textContent = d.avplay;
        if ($('diag_kodik')) {
          var msg = (d.via && d.via.indexOf('ok') === 0)
            ? ('ссылка получена ' + d.via.replace('ok', '').trim()) : (d.error || '—');
          $('diag_kodik').textContent = msg.length > 70 ? msg.substring(0, 70) + '…' : msg;
        }
        if ($('diag_decision')) $('diag_decision').textContent = PLAY_DIAG.decision || '—';
        if ($('diag_src')) {
          var host = '';
          var mm = /^(?:https?:)?\/\/([^\/]+)/i.exec(PLAY_DIAG.url || '');
          if (mm) host = mm[1];
          var srcMsg = host ? host : '—';
          if (PLAY_DIAG.error) srcMsg += ' · ' + PLAY_DIAG.error;
          $('diag_src').textContent = srcMsg.length > 70 ? srcMsg.substring(0, 70) + '…' : srcMsg;
        }
        /* Строка «Версия кода» создаётся из JS, чтобы её можно было добавить
           обновлением с GitHub, не переустанавливая .wgt */
        var sv = $('settings_view');
        if (sv && !$('val_code_version')) {
          var vrow = document.createElement('div');
          vrow.className = 'setting_row';
          var vlab = document.createElement('span');
          vlab.className = 'setting_label';
          vlab.textContent = 'Версия кода';
          var vval = document.createElement('span');
          vval.className = 'setting_value';
          vval.id = 'val_code_version';
          vrow.appendChild(vlab);
          vrow.appendChild(vval);
          sv.appendChild(vrow);
        }
        if ($('val_code_version')) {
          var bnd = window.ANI_BUNDLE;
          $('val_code_version').textContent = (bnd && bnd.version)
            ? (bnd.version + ' (с GitHub)') : 'встроенная';
        }
        /* диагностика Libria: что ответили API и страница на этом ТВ */
        if (sv && !$('val_libria')) {
          var lrow = document.createElement('div');
          lrow.className = 'setting_row';
          var llab = document.createElement('span');
          llab.className = 'setting_label';
          llab.textContent = 'Libria (API / страница)';
          var lval = document.createElement('span');
          lval.className = 'setting_value';
          lval.id = 'val_libria';
          lrow.appendChild(llab);
          lrow.appendChild(lval);
          sv.appendChild(lrow);
        }
        if ($('val_libria')) {
          $('val_libria').textContent = (LIBRIA_DIAG.api || '—') + ' / ' + (LIBRIA_DIAG.page || '—');
        }
      } catch (eDiag) { /* noop */ }
    },
    /* Строка прокси: на ТВ prompt() обычно недоступен — подсказываем, где менять */
    toggleProxy: function () {
      var done = false;
      try {
        var v = window.prompt('URL кастомного прокси (напр. http://192.168.1.10:8080/?url=):',
          TVNetwork.getProxyUrl());
        if (v !== null && v !== undefined) {
          done = true;
          if (v === '') {
            TVNetwork.setProxyUrl('');
            toast('Прокси сброшен на значение по умолчанию');
          } else if (!TVNetwork.setProxyUrl(v)) {
            toast('Неверный URL: нужен адрес вида http://...');
          } else {
            toast('Прокси сохранён');
          }
        }
      } catch (e) { /* prompt не поддерживается */ }
      if (!done) {
        toast('Изменить прокси: CONFIG.defaultProxyUrl в app.js или ключ proxy_url в localStorage', 4000);
      }
      this.render();
    },
    toggle: function (row) {
      if (!row) return;
      var what = row.getAttribute('data-setting');
      if (what === 'player_type') {
        var m = storageGet('player_mode', 'avplay') === 'avplay' ? 'html5' : 'avplay';
        TVPlayer.setMode(m);
        /* если плеер открыт — переключение применится к следующему запуску */
      } else if (what === 'cors_mode') {
        var cur = TVNetwork.getMode();
        var order = TVNetwork.MODES;
        var i = order.indexOf(cur);
        if (i < 0) i = 0;
        TVNetwork.setMode(order[(i + 1) % order.length]);
      } else if (what === 'proxy_url') {
        this.toggleProxy();
        return;
      } else if (what === 'video_quality') {
        var qo = ['auto', '1080', '720', '480', '360'];
        var cq = storageGet('video_quality', 'auto');
        var qi = qo.indexOf(cq);
        if (qi < 0) qi = 0;
        storageSet('video_quality', qo[(qi + 1) % qo.length]);
      } else if (what === 'buffer_sec') {
        var bo = ['5', '10', '15', '20', '30'];
        var cb = String(parseInt(storageGet('buffer_sec', '10'), 10) || 10);
        var bi = bo.indexOf(cb);
        if (bi < 0) bi = 0;
        storageSet('buffer_sec', bo[(bi + 1) % bo.length]);
        toast('Буфер применится к следующей серии');
      } else if (what === 'seek_step') {
        var so = TVPlayer.SEEK_STEPS;
        var cs = TVPlayer.seekStep();
        var si = so.indexOf(cs);
        if (si < 0) si = 0;
        storageSet('seek_step', String(so[(si + 1) % so.length]));
      } else if (what === 'hide_watched') {
        var hw = storageGet('hide_watched', '0') === '1' ? '0' : '1';
        storageSet('hide_watched', hw);
        toast(hw === '1' ? 'Просмотренное скрыто' : 'Просмотренное показывается', 2000);
        if (TVList.current) TVList.show(TVList.current);
      } else if (what === 'clear_history' || what === 'clear_bookmarks') {
        this.askClear(what);
        return;
      }
      this.render();
    },

    /* Очистка в два нажатия: случайный OK по строке не должен стирать данные */
    pendingClear: null,
    clearTimer: null,
    askClear: function (what) {
      var self = this;
      var label = what === 'clear_history' ? 'историю' : 'закладки';
      if (self.pendingClear === what) {
        self.pendingClear = null;
        if (self.clearTimer) { clearTimeout(self.clearTimer); self.clearTimer = null; }
        if (what === 'clear_history') {
          TVHistory.clear();
          TVWatched.clear();
          if (TVRelease.rel && TVRelease.episodes.length) TVRelease.renderEpisodes();
        } else TVBookmarks.clear();
        toast('Очищено: ' + label);
        return;
      }
      self.pendingClear = what;
      if (self.clearTimer) clearTimeout(self.clearTimer);
      self.clearTimer = setTimeout(function () {
        self.pendingClear = null;
        self.clearTimer = null;
      }, 4000);
      toast('Нажмите OK ещё раз, чтобы очистить ' + label, 4000);
    }
  };

  /* ==========================================================
     Каталог: карточки релизов из API
     ========================================================== */
  function releaseTitle(rel) {
    if (!rel) return 'Без названия';
    return rel.title_ru || rel.title_original || 'Без названия';
  }

  function releaseMeta(rel) {
    if (!rel) return '';
    var parts = [];
    if (rel.year) parts.push(String(rel.year));
    var total = Number(rel.episodes_total) || 0;
    var out = Number(rel.episodes_released) || 0;
    if (total) parts.push('эп. ' + (out || total) + '/' + total);
    else if (out) parts.push('эп. ' + out);
    if (rel.grade && Number(rel.grade) > 0) parts.push('★ ' + Number(rel.grade).toFixed(2));
    if (rel.is_play_disabled) parts.push('нет видео');
    return parts.join(' · ');
  }

  /* Заполнить ряд карточками релизов. metaFn — необязательный форматтер подписи. */
  function fillReleaseRow(row, items, emptyText, metaFn) {
    if (!row) return;
    row.innerHTML = '';
    row.setAttribute('data-shift', '0');
    row.style.transform = 'translateX(0px)';
    if (!items || !items.length) {
      var empty = document.createElement('div');
      empty.className = 'history_empty';
      empty.textContent = emptyText || 'Пусто';
      row.appendChild(empty);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var rel = items[i];
      var card = document.createElement('div');
      card.className = 'history_card focusable';
      card.setAttribute('data-release', String(rel.id));
      card.setAttribute('data-title', releaseTitle(rel));
      if (rel.image) card.style.backgroundImage = 'url("' + rel.image + '")';

      var cover = document.createElement('div');
      cover.className = 'h_cover';
      card.appendChild(cover);

      var info = document.createElement('div');
      info.className = 'h_info';
      var t = document.createElement('div');
      t.className = 'h_title';
      t.textContent = releaseTitle(rel);
      var m = document.createElement('div');
      m.className = 'h_meta';
      m.textContent = metaFn ? metaFn(rel) : releaseMeta(rel);
      info.appendChild(t);
      info.appendChild(m);
      card.appendChild(info);

      /* звезда «в закладках» — показывается только у отмеченных (класс bm) */
      var star = document.createElement('div');
      star.className = 'h_star';
      star.textContent = '★';
      card.appendChild(star);

      row.appendChild(card);
    }
    TVBookmarks.markCards();
  }

  /* ==========================================================
     Главная: подборка случайных релизов с API
     ========================================================== */
  var TVHome = {
    busy: false,
    items: [],

    loadRandom: function () {
      var self = this;
      if (self.busy) return;
      self.busy = true;
      var row = $('random_row');
      if (row) row.innerHTML = '<div class="history_empty">Загрузка...</div>';
      var jobs = [];
      for (var i = 0; i < 8; i++) {
        jobs.push(AnixApi.random().catch(function () { return null; }));
      }
      Promise.all(jobs).then(function (list) {
        var seen = {};
        var out = [];
        for (var k = 0; k < list.length; k++) {
          var rel = list[k];
          if (!rel || !rel.id || seen[rel.id]) continue;
          seen[rel.id] = 1;
          out.push(rel);
        }
        self.items = out;
        self.busy = false;
        fillReleaseRow(row, out, 'Не удалось получить данные API');
        if (!out.length) toast('API недоступен — проверьте сеть');
      }).catch(function () {
        self.busy = false;
        fillReleaseRow(row, [], 'Ошибка загрузки');
      });
    }
  };

  /* ==========================================================
     Поиск с экранной клавиатурой
     ========================================================== */
  var TVSearch = {
    query: '',
    keysBuilt: false,
    results: [],
    HISTORY_KEY: 'search_history',
    HISTORY_MAX: 3,

    /* последние запросы (храним 3) */
    history: function () {
      try {
        var arr = JSON.parse(storageGet(this.HISTORY_KEY, '[]'));
        return arr instanceof Array ? arr.slice(0, this.HISTORY_MAX) : [];
      } catch (e) { return []; }
    },

    remember: function (q) {
      q = String(q || '').replace(/^\s+|\s+$/g, '');
      if (!q) return;
      var list = this.history();
      var out = [q];
      for (var i = 0; i < list.length && out.length < this.HISTORY_MAX; i++) {
        if (String(list[i]).toLowerCase() !== q.toLowerCase()) out.push(list[i]);
      }
      try { storageSet(this.HISTORY_KEY, JSON.stringify(out)); } catch (e) { /* quota */ }
      this.renderRecent();
    },

    isOpen: function () {
      var s = $('search_view');
      return !!s && s.style.display === 'flex';
    },

    show: function () {
      var s = $('search_view');
      var m = $('main_view');
      if (!s || !m) return;
      this.buildKeys();
      this.buildRecent();
      hideListViews();
      s.style.display = 'flex';
      m.style.display = 'none';
      this.renderQuery();
      this.renderRecent();
      TVNavigation.focusIn(s);
    },

    hide: function () {
      var s = $('search_view');
      var m = $('main_view');
      if (!s || !m) return;
      s.style.display = 'none';
      m.style.display = 'block';
      TVNavigation.refresh();
      TVNavigation.focus($('search_open'), true);
    },

    buildKeys: function () {
      if (this.keysBuilt) return;
      var box = $('search_keys');
      if (!box) return;
      var letters = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789';
      for (var i = 0; i < letters.length; i++) {
        var b = document.createElement('div');
        b.className = 'key_btn focusable';
        b.setAttribute('data-key', letters.charAt(i));
        b.textContent = letters.charAt(i);
        box.appendChild(b);
      }
      var del = document.createElement('div');
      del.className = 'key_btn key_del focusable';
      del.setAttribute('data-key', 'DEL');
      del.textContent = '⌫';
      box.appendChild(del);

      var sp = document.createElement('div');
      sp.className = 'key_btn key_space focusable';
      sp.setAttribute('data-key', 'SP');
      sp.textContent = 'пробел';
      box.appendChild(sp);

      this.keysBuilt = true;
    },

    /* Контейнер «последних запросов» под клавиатурой (создаём из JS) */
    buildRecent: function () {
      if ($('search_recent')) return;
      var keys = $('search_keys');
      if (!keys || !keys.parentNode) return;
      var title = document.createElement('div');
      title.className = 'view_hint';
      title.id = 'search_recent_title';
      title.textContent = 'Последние запросы';
      title.style.display = 'none';
      title.style.marginTop = '18px';

      var box = document.createElement('div');
      box.id = 'search_recent';
      box.style.display = 'none';
      box.style.flexWrap = 'wrap';
      box.style.marginTop = '10px';

      keys.parentNode.insertBefore(title, keys.nextSibling);
      title.parentNode.insertBefore(box, title.nextSibling);
    },

    renderRecent: function () {
      var box = $('search_recent');
      var title = $('search_recent_title');
      if (!box) return;
      var list = this.history();
      box.innerHTML = '';
      if (!list.length) {
        box.style.display = 'none';
        if (title) title.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      if (title) title.style.display = '';
      for (var i = 0; i < list.length; i++) {
        var chip = document.createElement('div');
        chip.className = 'focusable';
        chip.setAttribute('data-recent', String(list[i]));
        chip.textContent = String(list[i]);
        chip.style.padding = '10px 22px';
        chip.style.marginRight = '14px';
        chip.style.borderRadius = '10px';
        chip.style.background = '#1c1c26';
        chip.style.border = '3px solid transparent';
        chip.style.fontSize = '24px';
        chip.style.color = '#d8d8e2';
        box.appendChild(chip);
      }
      TVNavigation.refresh();
    },

    /* Подставить сохранённый запрос и сразу выполнить поиск */
    useRecent: function (q) {
      this.query = String(q || '');
      this.renderQuery();
      this.run();
    },

    press: function (k) {
      if (k === 'DEL') {
        this.query = this.query.substring(0, Math.max(0, this.query.length - 1));
      } else if (k === 'SP') {
        this.query += ' ';
      } else if (k) {
        this.query += k;
      }
      if (this.query.length > 60) this.query = this.query.substring(0, 60);
      this.renderQuery();
    },

    clear: function () {
      this.query = '';
      this.renderQuery();
    },

    renderQuery: function () {
      var q = $('search_query');
      if (q) q.textContent = this.query ? this.query : 'Введите название';
    },

    run: function () {
      var self = this;
      var q = String(self.query || '').replace(/^\s+|\s+$/g, '');
      if (!q) { toast('Сначала введите название'); return; }
      self.remember(q);
      var row = $('search_results');
      if (row) row.innerHTML = '<div class="history_empty">Поиск...</div>';
      Loader.show('Поиск...');
      AnixApi.search(q, 0).then(function (list) {
        Loader.hide();
        self.results = list || [];
        fillReleaseRow(row, self.results, 'Ничего не найдено');
        if (self.results.length) {
          var first = row.querySelector('.history_card');
          if (first) { TVNavigation.refresh(); TVNavigation.focus(first, true); }
        } else {
          TVNavigation.focus($('search_go'), true);
        }
      }).catch(function (e) {
        Loader.hide();
        fillReleaseRow(row, [], 'Ошибка запроса');
        toast('Ошибка API: ' + ((e && e.message) || 'сеть'));
      });
    }
  };

  /* ==========================================================
     Экран релиза: озвучка, источник, серии
     ========================================================== */
  /* ==========================================================
     Небольшое подменю выбора (озвучка / источник).
     Разметка создаётся из JS: так меню можно добавить обновлением с GitHub,
     не переустанавливая .wgt. Стили — классы qm_* из style.css.
     ========================================================== */
  var TVChoice = {
    open: false,
    title: '',
    items: [],
    index: 0,
    apply: null,

    ensure: function () {
      var box = $('choice_menu');
      if (box) return box;

      box = document.createElement('div');
      box.id = 'choice_menu';
      box.style.position = 'fixed';
      box.style.right = '90px';
      box.style.top = '50%';
      box.style.transform = 'translateY(-50%)';
      box.style.width = '520px';
      box.style.maxHeight = '62%';
      box.style.overflowY = 'auto';
      box.style.zIndex = '140';
      box.style.padding = '24px 28px';
      box.style.borderRadius = '12px';
      box.style.background = 'rgba(16, 16, 22, 0.96)';
      box.style.border = '2px solid #2a2a36';
      box.style.display = 'none';

      var title = document.createElement('div');
      title.className = 'qm_title';
      title.id = 'choice_title';
      box.appendChild(title);

      var list = document.createElement('div');
      list.id = 'choice_list';
      box.appendChild(list);

      var hint = document.createElement('div');
      hint.className = 'qm_hint';
      hint.textContent = '▲ ▼ — выбор · OK — применить · RETURN — назад';
      box.appendChild(hint);

      document.body.appendChild(box);
      return box;
    },

    show: function (title, items, index, apply) {
      if (!items || !items.length) { toast('Нет вариантов', 2000); return; }
      var box = this.ensure();
      this.items = items;
      this.index = Math.max(0, Math.min(items.length - 1, Number(index) || 0));
      this.apply = apply || null;
      this.open = true;
      if ($('choice_title')) $('choice_title').textContent = title;
      this.render();
      box.style.display = 'block';
    },

    render: function () {
      var list = $('choice_list');
      if (!list) return;
      list.innerHTML = '';
      for (var i = 0; i < this.items.length; i++) {
        var item = this.items[i];
        var row = document.createElement('div');
        row.className = 'qm_item' + (i === this.index ? ' active' : '');
        row.textContent = (item && (item.name || item.title)) || ('Вариант ' + (i + 1));
        list.appendChild(row);
      }
      var act = list.querySelector('.qm_item.active');
      if (act) { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) { /* noop */ } }
    },

    move: function (delta) {
      if (!this.open) return;
      var n = this.items.length;
      if (!n) return;
      this.index = (this.index + delta + n) % n;
      this.render();
    },

    select: function () {
      if (!this.open) return;
      var item = this.items[this.index];
      var fn = this.apply;
      var idx = this.index;
      this.close();
      if (fn) fn(item, idx);
    },

    close: function () {
      this.open = false;
      var box = $('choice_menu');
      if (box) box.style.display = 'none';
    }
  };

  var TVRelease = {
    rel: null,
    types: [],
    typeIndex: 0,
    sources: [],
    sourceIndex: 0,
    episodes: [],

    isOpen: function () {
      var v = $('release_view');
      return !!v && v.style.display === 'flex';
    },

    show: function () {
      var v = $('release_view');
      var m = $('main_view');
      if (!v) return;
      v.style.display = 'flex';
      if (m) m.style.display = 'none';
      /* экраны разделов не должны оставаться рядом с релизом */
      hideListViews();
      var s = $('search_view');
      if (s) s.style.display = 'none';
    },

    hide: function () {
      var v = $('release_view');
      var m = $('main_view');
      if (!v) return;
      TVChoice.close();
      v.style.display = 'none';
      var rv = $('related_view');
      if (rv) rv.style.display = 'none';
      this.rel = null;
      var back = this.returnEl;
      this.returnEl = null;
      var kind = this.returnKind;
      this.returnKind = null;
      TVNavigation.refresh();
      /* возвращаемся на тот экран, откуда открывали релиз */
      if (kind) {
        TVList.show(kind);
        /* карточки раздела перерисовываются, поэтому старый элемент уже detached —
           ищем карточку заново по её data-атрибуту */
        var row = $(TVList.rows[kind]);
        var key = back && (back.getAttribute('data-release') || back.getAttribute('data-id'));
        var again = null;
        if (row && key) {
          again = row.querySelector('[data-release="' + key + '"]') ||
            row.querySelector('[data-id="' + key + '"]');
        }
        if (again) TVNavigation.focus(again, true);
        else if (back && document.body.contains(back)) TVNavigation.focus(back, true);
        else TVNavigation.focus(document.querySelector('[data-nav="' + kind + '"]'), true);
        return;
      }
      if (m) m.style.display = 'block';
      TVNavigation.refresh();
      if (back && document.body.contains(back)) TVNavigation.focus(back, true);
      else TVNavigation.focus($('search_open'), true);
    },

    open: function (id) {
      var self = this;
      if (!id) return;
      /* экран связанных поверх релиза закрываем */
      var rv = $('related_view');
      if (rv) rv.style.display = 'none';
      /* запомним, откуда пришли — туда вернём фокус при закрытии */
      self.returnEl = TVNavigation.current;
      self.returnKind = TVList.current;
      self.rel = null;
      self.types = [];
      self.sources = [];
      self.episodes = [];
      self.typeIndex = 0;
      self.sourceIndex = 0;
      self.show();
      if ($('rel_title')) $('rel_title').textContent = 'Загрузка...';
      if ($('rel_meta')) $('rel_meta').textContent = '';
      if ($('rel_desc')) $('rel_desc').textContent = '';
      if ($('rel_poster')) $('rel_poster').style.backgroundImage = '';
      if ($('rel_voice')) $('rel_voice').textContent = 'Озвучка: —';
      if ($('rel_source')) $('rel_source').textContent = 'Источник: —';
      if ($('rel_bookmark')) {
        $('rel_bookmark').textContent = '☆ В закладки';
        $('rel_bookmark').classList.remove('on');
      }
      fillReleaseRow($('rel_eps'), [], 'Загрузка...');
      /* секции под сериями прячем до загрузки нового релиза */
      this.fillExtra('rel_rec', 'rel_rec_title', []);
      this.relatedItems = [];
      TVNavigation.focusIn($('release_view'));
      Loader.show('Загрузка релиза...');

      /* кеш карточки релиза: повторный вход — мгновенно */
      var cached = cacheGet('cache_release_' + id);
      if (cached && cached.rel) {
        Loader.hide();
        self.rel = cached.rel;
        self.renderInfo();
        self.types = cached.types || [];
        self.typeIndex = self.pickSavedIndex(self.types, 'last_type_id');
        self.applyType();
        return;
      }

      AnixApi.release(id).then(function (rel) {
        self.rel = rel;
        self.renderInfo();
        return AnixApi.types(id);
      }).then(function (types) {
        self.types = types || [];
        cacheSet('cache_release_' + id, { rel: self.rel, types: self.types }, 15 * 60 * 1000);
        /* вспоминаем озвучку, выбранную в прошлый раз */
        self.typeIndex = self.pickSavedIndex(self.types, 'last_type_id');
        self.applyType();
      }).catch(function (e) {
        Loader.hide();
        if ($('rel_title')) $('rel_title').textContent = 'Ошибка загрузки';
        TVError.show('Не удалось загрузить релиз', function () { TVRelease.open(id); });
        toast('Не удалось загрузить релиз: ' + ((e && e.message) || 'сеть'));
      });
    },

    renderInfo: function () {
      var rel = this.rel;
      if (!rel) return;
      if ($('rel_title')) $('rel_title').textContent = releaseTitle(rel);
      if ($('rel_poster') && rel.image) {
        $('rel_poster').style.backgroundImage = 'url("' + rel.image + '")';
      }
      var meta = [];
      if (rel.year) meta.push(String(rel.year));
      if (rel.status && rel.status.name) meta.push(rel.status.name);
      if (rel.category && rel.category.name) meta.push(rel.category.name);
      if (rel.genres) meta.push(rel.genres);
      var total = Number(rel.episodes_total) || 0;
      var out = Number(rel.episodes_released) || 0;
      if (total) meta.push('серий: ' + (out || total) + '/' + total);
      if (rel.duration) meta.push(rel.duration + ' мин');
      if (rel.grade && Number(rel.grade) > 0) meta.push('★ ' + Number(rel.grade).toFixed(2));
      if ($('rel_meta')) $('rel_meta').textContent = meta.join(' · ');
      if ($('rel_desc')) $('rel_desc').textContent = rel.description || '';
      /* кнопка закладки и звёздочки на карточках */
      TVBookmarks.markCards();
      /* связанные релизы и рекомендации — под списком серий */
      this.renderExtras();
    },

    /* Заполнить секцию доп. релизов; пустую — скрыть вместе с заголовком */
    fillExtra: function (rowId, titleId, items) {
      var row = $(rowId);
      var title = $(titleId);
      if (!row || !title) return;
      if (!items || !items.length) {
        title.style.display = 'none';
        row.style.display = 'none';
        row.innerHTML = '';
        return;
      }
      title.style.display = '';
      row.style.display = '';
      fillReleaseRow(row, items, '');
      TVNavigation.refresh();
    },

    /* «Связанные релизы» и «Рекомендуем также» из ответа release/{id} */
    renderExtras: function () {
      var rel = this.rel;
      if (!rel) return;
      var curId = String(rel.id);
      var related = [];
      var relList = rel.related_releases || [];
      for (var i = 0; i < relList.length; i++) {
        if (relList[i] && String(relList[i].id) !== curId) related.push(relList[i]);
      }
      var rec = [];
      var recList = rel.recommended_releases || [];
      for (var j = 0; j < recList.length; j++) {
        if (recList[j] && String(recList[j].id) !== curId) rec.push(recList[j]);
      }
      if (!rec.length) rec = related.slice(0, 12);
      /* связанные показываем отдельным экраном по кнопке, здесь только запоминаем */
      this.relatedItems = related;
      if ($('rel_related_btn')) {
        $('rel_related_btn').textContent = related.length ? ('Связанные релизы (' + related.length + ')')
          : 'Связанные релизы';
      }
      /* «Рекомендуем также» — не больше четырёх карточек */
      this.fillExtra('rel_rec', 'rel_rec_title', rec.slice(0, 4));
    },

    /* Экран со всеми связанными релизами */
    isRelatedOpen: function () {
      var v = $('related_view');
      return !!v && v.style.display === 'flex';
    },

    openRelated: function () {
      var self = this;
      var rel = self.rel || {};
      var relId = rel.id;
      var relatedId = rel.related && rel.related.id;
      var list = (self.relatedItems || []).slice();
      var v = $('related_view');
      if (!v) return;
      hideListViews();
      var grid = $('related_grid');
      if (grid) fillReleaseRow(grid, list, 'Загрузка...');
      if ($('related_title')) {
        $('related_title').textContent = 'Связанные релизы' + (list.length ? ' (' + list.length + ')' : '');
      }
      var r = $('release_view');
      var m = $('main_view');
      if (r) r.style.display = 'none';
      if (m) m.style.display = 'none';
      v.style.display = 'flex';
      TVNavigation.refresh();
      var first = document.querySelector('#related_grid .history_card');
      if (first) TVNavigation.focus(first, true);

      /* полный список — тем же способом, что кнопка «Показать все» в приложении:
         GET related/{related.id}/{page}, по 25 записей на страницу */
      if (!relatedId) return;
      AnixApi.relatedAll(relatedId).then(function (all) {
        if (!TVRelease.isRelatedOpen() || !TVRelease.rel) return;
        if (String(TVRelease.rel.id) !== String(relId)) return;
        var out = [];
        for (var i = 0; i < all.length; i++) {
          if (all[i] && String(all[i].id) !== String(relId)) out.push(all[i]);
        }
        if (!out.length) return;
        TVRelease.relatedItems = out;
        if ($('rel_related_btn')) {
          $('rel_related_btn').textContent = 'Связанные релизы (' + out.length + ')';
        }
        fillReleaseRow($('related_grid'), out, '');
        if ($('related_title')) $('related_title').textContent = 'Связанные релизы (' + out.length + ')';
        TVNavigation.refresh();
        var firstCard = document.querySelector('#related_grid .history_card');
        if (firstCard) TVNavigation.focus(firstCard, true);
      }).catch(function () { /* остаёмся на том, что пришло вместе с релизом */ });
    },

    closeRelated: function () {
      var v = $('related_view');
      if (!v) return;
      v.style.display = 'none';
      this.show();
      TVNavigation.refresh();
      var btn = $('rel_related_btn');
      if (btn) TVNavigation.focus(btn, true);
    },

    applyType: function () {
      var self = this;
      var t = self.types[self.typeIndex];
      if ($('rel_voice')) {
        $('rel_voice').textContent = 'Озвучка: ' + (t ? (t.name || '—') : '—');
      }
      if (!t || !self.rel) {
        self.sources = [];
        self.episodes = [];
        fillReleaseRow($('rel_eps'), [], 'Серии не найдены');
        Loader.hide();
        return;
      }
      var srcKey = 'cache_sources_' + self.rel.id + '_' + t.id;
      var cachedSrc = cacheGet(srcKey);
      if (cachedSrc) {
        self.sources = cachedSrc;
        self.sourceIndex = self.pickSavedIndex(self.sources, 'last_source_id');
        self.applySource();
        return;
      }
      AnixApi.sources(self.rel.id, t.id).then(function (srcs) {
        var all = srcs || [];
        /* Libria отключена: её CDN не пускает телевизор (XHR 404/503) */
        var list = [];
        for (var i = 0; i < all.length; i++) {
          if (!/libria/i.test(String(all[i] && all[i].name || ''))) list.push(all[i]);
        }
        if (all.length && !list.length) {
          toast('Источник Libria отключён — других нет', 3500);
        }
        cacheSet(srcKey, list, 10 * 60 * 1000);
        self.sources = list;
        /* вспоминаем источник, выбранный в прошлый раз */
        self.sourceIndex = self.pickSavedIndex(self.sources, 'last_source_id');
        self.applySource();
      }).catch(function () {
        Loader.hide();
        fillReleaseRow($('rel_eps'), [], 'Нет источников');
      });
    },

    applySource: function () {
      var self = this;
      var s = self.sources[self.sourceIndex];
      if ($('rel_source')) {
        $('rel_source').textContent = 'Источник: ' + (s ? (s.name || '—') : '—');
      }
      if (!s || !self.rel) {
        self.episodes = [];
        fillReleaseRow($('rel_eps'), [], 'Серии не найдены');
        Loader.hide();
        return;
      }
      var t = self.types[self.typeIndex];
      var epKey = 'cache_eps_' + self.rel.id + '_' + t.id + '_' + s.id;
      var cachedEps = cacheGet(epKey);
      if (cachedEps && cachedEps.length) {
        Loader.hide();
        self.episodes = cachedEps;
        self.renderEpisodes();
        return;
      }
      AnixApi.episodes(self.rel.id, t.id, s.id).then(function (eps) {
        Loader.hide();
        var arr = eps || [];
        /* подстраховка: не пускаем в плеер ссылки Libria, даже если источник назван иначе */
        var clean = [];
        for (var i = 0; i < arr.length; i++) {
          if (!/libria\.fun/i.test(String(arr[i] && arr[i].url || ''))) clean.push(arr[i]);
        }
        self.episodes = clean.length ? clean : arr;
        if (self.episodes.length) cacheSet(epKey, self.episodes, 10 * 60 * 1000);
        self.renderEpisodes();
        /* прогреваем ссылку первой серии, чтобы старт был быстрым */
        if (self.episodes.length && kodikParse(self.episodes[0].url)) {
          setTimeout(function () {
            try {
              TVPlayer.resolveKodik(self.episodes[0].url, TVPlayer.qualityPref()).catch(function () {});
            } catch (e0) { /* noop */ }
          }, 1200);
        }
      }).catch(function (e) {
        Loader.hide();
        fillReleaseRow($('rel_eps'), [], 'Ошибка загрузки серий');
        toast('Ошибка API: ' + ((e && e.message) || 'сеть'));
      });
    },

    renderEpisodes: function () {
      var row = $('rel_eps');
      if (!row) return;
      row.innerHTML = '';
      row.setAttribute('data-shift', '0');
      row.style.transform = 'translateX(0px)';
      if (!this.episodes.length) {
        var empty = document.createElement('div');
        empty.className = 'history_empty';
        empty.textContent = 'Серии не найдены';
        row.appendChild(empty);
        TVNavigation.refresh();
        TVNavigation.focus($('rel_play'), true);
        return;
      }
      for (var i = 0; i < this.episodes.length; i++) {
        var ep = this.episodes[i];
        var b = document.createElement('div');
        var watched = ep.is_watched || TVWatched.has(this.rel.id, ep.position);
        b.className = 'ep_btn focusable' + (watched ? ' watched' : '');
        b.setAttribute('data-ep', String(i));
        b.textContent = String(ep.position || (i + 1));
        row.appendChild(b);
      }
      TVNavigation.refresh();
      TVNavigation.focus($('rel_play'), true);
    },

    /* Индекс сохранённого элемента (озвучка/источник) в списке */
    pickSavedIndex: function (list, key) {
      var saved = storageGet(key, '');
      if (!saved) return 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].id) === String(saved)) return i;
      }
      return 0;
    },

    /* Подменю выбора озвучки */
    chooseType: function () {
      var self = this;
      if (!self.types.length) { toast('Нет озвучек', 2000); return; }
      TVChoice.show('Озвучка', self.types, self.typeIndex, function (item, idx) {
        self.typeIndex = idx;
        if (item && item.id !== undefined && item.id !== null) {
          storageSet('last_type_id', String(item.id));
        }
        Loader.show('Загрузка...');
        self.applyType();
      });
    },

    /* Подменю выбора источника */
    chooseSource: function () {
      var self = this;
      if (!self.sources.length) { toast('Нет источников', 2000); return; }
      TVChoice.show('Источник', self.sources, self.sourceIndex, function (item, idx) {
        self.sourceIndex = idx;
        if (item && item.id !== undefined && item.id !== null) {
          storageSet('last_source_id', String(item.id));
        }
        Loader.show('Загрузка...');
        self.applySource();
      });
    },

    /* Сброс отметок просмотренных серий у текущего релиза (два нажатия OK) */
    resetWatched: function () {
      var self = this;
      if (!self.rel) return;
      if (!self.resetPending) {
        self.resetPending = true;
        if (self.resetTimer) clearTimeout(self.resetTimer);
        self.resetTimer = setTimeout(function () {
          self.resetPending = false;
          self.resetTimer = null;
        }, 4000);
        toast('Нажмите OK ещё раз, чтобы сбросить отметки', 3500);
        return;
      }
      self.resetPending = false;
      if (self.resetTimer) { clearTimeout(self.resetTimer); self.resetTimer = null; }
      TVWatched.removeRelease(self.rel.id);
      self.renderEpisodes();
      toast('Отметки просмотренных серий сброшены', 2500);
    },

    cycleType: function () {
      if (!this.types.length) return;
      this.typeIndex = (this.typeIndex + 1) % this.types.length;
      var t = this.types[this.typeIndex];
      if (t && t.id !== undefined && t.id !== null) storageSet('last_type_id', String(t.id));
      Loader.show('Загрузка...');
      this.applyType();
    },

    cycleSource: function () {
      if (!this.sources.length) return;
      this.sourceIndex = (this.sourceIndex + 1) % this.sources.length;
      var s = this.sources[this.sourceIndex];
      if (s && s.id !== undefined && s.id !== null) storageSet('last_source_id', String(s.id));
      Loader.show('Загрузка...');
      this.applySource();
    },

    /* Резерв: если Libria недоступна, включаем Kodik с другой озвучкой */
    playKodikFallback: function (position) {
      var self = this;
      if (!self.rel || !self.types.length) { toast('Нет доступных источников', 3000); return; }
      var started = self.typeIndex;
      var tried = 0;

      function nextType() {
        tried++;
        if (tried > self.types.length) {
          toast('Libria и Kodik недоступны', 4000);
          return;
        }
        var idx = (started + tried) % self.types.length;
        var t = self.types[idx];
        if (!t) { nextType(); return; }
        AnixApi.sources(self.rel.id, t.id).then(function (srcs) {
          var list = srcs || [];
          var kodik = null;
          for (var i = 0; i < list.length; i++) {
            if (/kodik/i.test(String(list[i].name || ''))) { kodik = list[i]; break; }
          }
          if (!kodik) { nextType(); return; }
          AnixApi.episodes(self.rel.id, t.id, kodik.id).then(function (eps) {
            var arr = eps || [];
            if (!arr.length) { nextType(); return; }
            var k = -1;
            for (var j = 0; j < arr.length; j++) {
              if (Number(arr[j].position) === Number(position)) { k = j; break; }
            }
            if (k < 0) k = 0;
            self.typeIndex = idx;
            self.sources = list;
            self.sourceIndex = list.indexOf(kodik);
            self.episodes = arr;
            if (t.id !== undefined && t.id !== null) storageSet('last_type_id', String(t.id));
            self.renderEpisodes();
            toast('Включена озвучка ' + (t.name || '') + ' (Kodik)', 3500);
            self.playIndex(k);
          }).catch(function () { nextType(); });
        }).catch(function () { nextType(); });
      }

      nextType();
    },

    /* Включить следующую серию после окончания текущей */
    /* Переключение серий в плеере (CH+ / CH−): delta = +1 или -1 */
    switchEpisode: function (delta) {
      var eps = this.episodes || [];
      if (!eps.length) { toast('Нет доступных серий', 2000); return; }
      var pos = TVPlayer.current ? Number(TVPlayer.current.episode) || 0 : 0;
      var idx = -1;
      for (var i = 0; i < eps.length; i++) {
        if (Number(eps[i].position) === pos) { idx = i; break; }
      }
      if (idx < 0) idx = 0;
      var next = idx + delta;
      if (next < 0) { toast('Это первая серия', 2000); return; }
      if (next >= eps.length) { toast('Это последняя серия', 2000); return; }
      toast((delta > 0 ? 'Следующая серия: ' : 'Предыдущая серия: ') +
        (eps[next].position || (next + 1)), 2000);
      this.playIndex(next);
    },

    playNext: function () {
      var eps = this.episodes || [];
      if (!eps.length) return;
      var pos = TVPlayer.current ? Number(TVPlayer.current.episode) || 0 : 0;
      var idx = -1;
      for (var i = 0; i < eps.length; i++) {
        if (Number(eps[i].position) === pos) { idx = i; break; }
      }
      if (idx < 0) idx = 0;
      if (idx + 1 >= eps.length) {
        toast('Это была последняя серия', 3000);
        return;
      }
      toast('Следующая серия: ' + (eps[idx + 1].position || (idx + 2)), 2500);
      /* небольшая пауза, чтобы зритель понял, что произошло */
      setTimeout(function () {
        if (!TVRelease.rel) return;
        TVRelease.playIndex(idx + 1);
      }, 700);
    },

    /* «Смотреть» на экране релиза: продолжаем последнюю серию из истории */
    playResume: function () {
      var self = this;
      if (!self.rel) return;
      var hist = TVHistory.find('anix:' + self.rel.id);
      if (!hist || !hist.episode) { self.playIndex(0); return; }
      var idx = -1;
      for (var i = 0; i < self.episodes.length; i++) {
        if (Number(self.episodes[i].position) === Number(hist.episode)) { idx = i; break; }
      }
      if (idx < 0) { self.playIndex(0); return; }
      var t = Math.max(0, Number(hist.time) || 0);
      if (t > 0) toast('Продолжаем: ' + hist.episode + ' серия', 2000);
      self.playIndex(idx, t);
    },

    /* idx — индекс в this.episodes; -1 — первая серия.
       resumeAt — секунда, с которой начать (для «Продолжить» из истории). */
    playIndex: function (idx, resumeAt) {
      if (!this.rel) return;
      if (!this.episodes.length) { toast('Нет доступных серий'); return; }
      var i = (idx === undefined || idx === null || idx < 0) ? 0 : idx;
      var ep = this.episodes[i];
      if (!ep || !ep.url) { toast('У серии нет ссылки'); return; }
      var pos = ep.position || (i + 1);
      var startAt = Math.max(0, Number(resumeAt) || 0);
      var item = {
        id: 'anix:' + this.rel.id,
        title: releaseTitle(this.rel) + ' — ' + pos + ' серия',
        poster: this.rel.image || '',
        episode: pos,
        time: startAt,
        /* по умолчанию новая серия с начала; из истории — с сохранённой секунды */
        resumeTime: startAt,
        src: ep.url
      };
      var v = $('release_view');
      var m = $('main_view');
      if (v) v.style.display = 'none';
      if (m) m.style.display = 'block';
      PLAY_DIAG.url = String(ep.url || '');
      PLAY_DIAG.error = '';
      /* серия просмотрена — отмечаем и красим кнопку красным */
      if (this.rel && pos) {
        TVWatched.add(this.rel.id, pos);
        var btn = document.querySelector('#rel_eps [data-ep="' + i + '"]');
        if (btn) btn.classList.add('watched');
      }
      if (isMediaUrl(ep.url)) {
        PLAY_DIAG.decision = 'прямой файл';
        TVPlayer.open(item);
      } else if (libriaParse(ep.url)) {
        /* Libria: страница с прямыми HLS-ссылками — играем в AVPlay */
        PLAY_DIAG.decision = 'libria';
        TVPlayer.playLibria(ep.url, item);
      } else if (kodikParse(ep.url)) {
        /* Kodik: получаем прямой HLS и играем встроенным AVPlay */
        PLAY_DIAG.decision = 'kodik';
        TVPlayer.playKodik(ep.url, item);
      } else {
        /* sibnet и подобные — страницы плеера, показываем их во фрейме */
        PLAY_DIAG.decision = 'iframe';
        TVPlayer.openWeb(ep.url, item);
      }

      /* прогреваем ссылку следующей серии, чтобы автопереход был мгновенным */
      var nextEp = this.episodes[i + 1];
      if (nextEp && kodikParse(nextEp.url)) {
        setTimeout(function () {
          try { TVPlayer.resolveKodik(nextEp.url, TVPlayer.qualityPref()).catch(function () {}); } catch (e) {}
        }, 3000);
      }
    }
  };

  /* ==========================================================
     Единое окно ошибки с кнопкой «Повторить»
     ========================================================== */
  var TVError = {
    open: false,
    retry: null,

    ensure: function () {
      var box = $('error_box');
      if (box) return box;
      box = document.createElement('div');
      box.id = 'error_box';
      box.style.position = 'fixed';
      box.style.left = '50%';
      box.style.top = '42%';
      box.style.transform = 'translate(-50%, -50%)';
      box.style.width = '760px';
      box.style.zIndex = '160';
      box.style.padding = '28px 34px';
      box.style.borderRadius = '14px';
      box.style.background = 'rgba(16, 16, 22, 0.97)';
      box.style.border = '2px solid #2a2a36';
      box.style.display = 'none';
      box.style.textAlign = 'center';

      var title = document.createElement('div');
      title.id = 'error_title';
      title.style.fontSize = '30px';
      title.style.fontWeight = '600';
      title.style.marginBottom = '14px';

      var hint = document.createElement('div');
      hint.className = 'qm_hint';
      hint.textContent = 'OK — повторить · RETURN — закрыть';

      box.appendChild(title);
      box.appendChild(hint);
      document.body.appendChild(box);
      return box;
    },

    show: function (title, retry) {
      var box = this.ensure();
      this.open = true;
      this.retry = retry || null;
      if ($('error_title')) $('error_title').textContent = title || 'Ошибка';
      box.style.display = 'block';
    },

    close: function () {
      this.open = false;
      this.retry = null;
      var box = $('error_box');
      if (box) box.style.display = 'none';
    },

    run: function () {
      var fn = this.retry;
      this.close();
      if (fn) { try { fn(); } catch (e) { /* noop */ } }
    }
  };

  /* ==========================================================
     Диагностика сети: реальные запросы с телевизора
     ========================================================== */
  var TVNetDiag = {
    results: { api: '', pages: '', kodik: '' },
    busy: false,

    isOpen: function () {
      var v = $('net_view');
      return !!v && v.style.display === 'flex';
    },

    show: function () {
      var v = $('net_view');
      var m = $('main_view');
      var s = $('settings_view');
      if (!v) return;
      hideListViews();
      if (m) m.style.display = 'none';
      if (s) s.style.display = 'none';
      v.style.display = 'flex';
      this.render();
      TVNavigation.refresh();
      if ($('net_run')) TVNavigation.focus($('net_run'), true);
      this.run();
    },

    hide: function () {
      var v = $('net_view');
      if (!v) return;
      v.style.display = 'none';
      TVSettings.show(true);
    },

    render: function () {
      if ($('net_api')) $('net_api').textContent = this.results.api || '—';
      if ($('net_pages')) $('net_pages').textContent = this.results.pages || '—';
      if ($('net_kodik')) $('net_kodik').textContent = this.results.kodik || '—';
      if ($('net_version')) {
        var bnd = window.ANI_BUNDLE;
        $('net_version').textContent = (bnd && bnd.version) ? (bnd.version + ' (с GitHub)') : 'встроенная';
      }
    },

    check: function (key, url, expect) {
      var self = this;
      var t0 = (new Date()).getTime();
      self.results[key] = 'проверка...';
      self.render();
      return kodikHttpGet(url, 9000).then(function (txt) {
        var ms = (new Date()).getTime() - t0;
        var ok = expect ? expect(txt) : true;
        self.results[key] = ok ? ('OK · ' + ms + ' мс') : ('ответ без данных · ' + ms + ' мс');
        self.render();
      }).catch(function (e) {
        var ms = (new Date()).getTime() - t0;
        self.results[key] = ((e && e.message) || 'ошибка') + ' · ' + ms + ' мс';
        self.render();
      });
    },

    run: function () {
      if (this.busy) return;
      this.busy = true;
      var self = this;
      var base = (window.ANI_BUNDLE && window.ANI_BUNDLE.base) ||
        'https://counthapAni790anipy.github.io/7f3k9q22qs32/';
      Promise.all([
        self.check('api', 'https://api.anixsekai.com/release/random', function (t) {
          return t && t.indexOf('"release"') >= 0;
        }),
        self.check('pages', base + 'manifest.json?t=' + (new Date()).getTime(), function (t) {
          return t && t.indexOf('version') >= 0;
        }),
        self.check('kodik', 'https://kodikplayer.com/ftor?hash=ead7d029724d16a6d0440cf6786e2226&id=176238&type=seria', function (t) {
          return t && t.indexOf('links') >= 0;
        })
      ]).then(function () { self.busy = false; }, function () { self.busy = false; });
    }
  };

  /* ==========================================================
     Разделы левой панели: «Закладки» и «История»
     ========================================================== */
  var TVList = {
    current: null,
    views: {
      bookmarks: 'bookmarks_view',
      history: 'history_view',
      popular: 'popular_view',
      schedule: 'schedule_view',
      collections: 'collections_view',
      collection: 'collection_view',
      filters: 'filters_view'
    },
    rows: {
      bookmarks: 'bookmark_row',
      history: 'history_row',
      popular: 'popular_grid',
      schedule: 'schedule_grid',
      collections: 'collections_grid',
      collection: 'collection_grid',
      filters: 'filter_grid'
    },

    isOpen: function () { return this.current !== null; },

    /* Показать экран раздела (фокус не переносим — это делает open) */
    show: function (kind) {
      if (!this.views[kind]) return;
      var v = $(this.views[kind]);
      if (!v) return;
      var m = $('main_view');
      var r = $('release_view');
      var s = $('search_view');
      var st = $('settings_view');
      /* остальные разделы обязательно скрываем: иначе экраны встанут рядом */
      for (var k in this.views) {
        if (!this.views.hasOwnProperty(k) || k === kind) continue;
        var other = $(this.views[k]);
        if (other) other.style.display = 'none';
      }
      if (m) m.style.display = 'none';
      if (r) r.style.display = 'none';
      /* экран связанных релизов тоже должен уйти, иначе висит поверх раздела */
      var rv = $('related_view');
      if (rv) rv.style.display = 'none';
      TVChoice.close();
      if (TVPlayer.menuOpen) TVPlayer.hideQualityMenu();
      if (s) s.style.display = 'none';
      if (st) st.style.display = 'none';
      v.style.display = 'flex';
      this.current = kind;
      if (kind === 'history') TVHistory.render();
      else if (kind === 'bookmarks') TVBookmarks.render();
      else TVSections.render(kind);
      TVNavigation.refresh();
    },

    /* Открыть раздел и поставить фокус на первый элемент */
    open: function (kind) {
      if (!this.views[kind]) return;
      this.show(kind);
      var row = $(this.rows[kind]);
      var first = kind === 'filters' ? document.querySelector('.filter_row.focusable') :
        (row ? row.querySelector('.focusable') : null);
      if (first) TVNavigation.focus(first, true);
      else TVNavigation.focus(document.querySelector('[data-nav="' + kind + '"]'), true);
    },

    close: function () {
      if (!this.current) return;
      var kind = this.current;
      var v = $(this.views[kind]);
      var m = $('main_view');
      if (v) v.style.display = 'none';
      if (m) m.style.display = 'block';
      this.current = null;
      TVNavigation.refresh();
      TVNavigation.focus(document.querySelector('[data-nav="' + kind + '"]'), true);
    }
  };

  /* Скрыть экраны разделов и сбросить текущий раздел.
     Вызывается, когда открывается другой экран (релиз, поиск, настройки). */
  function hideListViews() {
    for (var k in TVList.views) {
      if (!TVList.views.hasOwnProperty(k)) continue;
      var v = $(TVList.views[k]);
      if (v) v.style.display = 'none';
    }
    TVList.current = null;
  }

  /* ==========================================================
     TVCatalog — общий пул релизов для «Популярного», «Расписания»,
     «Коллекций» и «Фильтров».
     У API нет ручки каталога, поэтому пул собирается поиском по частым
     буквам и страницам, чистится от дублей и кэшируется на 6 часов.
     ========================================================== */
  var TVCatalog = {
    KEY: 'catalog_pool',
    TS_KEY: 'catalog_pool_ts',
    TTL: 6 * 3600 * 1000,
    LETTERS: ['а', 'е', 'и', 'м', 'о', 'с'],
    PAGES: [0, 1, 2],
    items: [],
    loading: null,

    slim: function (rel) {
      return {
        id: rel.id,
        title_ru: rel.title_ru || rel.title_original || 'Без названия',
        image: rel.image || '',
        year: rel.year || '',
        grade: Number(rel.grade) || 0,
        vote_count: Number(rel.vote_count) || 0,
        genres: rel.genres || '',
        episodes_total: Number(rel.episodes_total) || 0,
        episodes_released: Number(rel.episodes_released) || 0,
        release_date: rel.release_date || '',
        last_update_date: Number(rel.last_update_date) || 0,
        status_id: Number(rel.status_id) || 0
      };
    },

    fromCache: function () {
      var ts = Number(storageGet(this.TS_KEY, 0)) || 0;
      if (!ts || (new Date()).getTime() - ts > this.TTL) return null;
      try {
        var arr = JSON.parse(storageGet(this.KEY, '[]'));
        return arr instanceof Array && arr.length ? arr : null;
      } catch (e) { return null; }
    },

    saveCache: function (list) {
      try {
        storageSet(this.KEY, JSON.stringify(list));
        storageSet(this.TS_KEY, String((new Date()).getTime()));
      } catch (e) { /* нет места — работаем без кэша */ }
    },

    load: function () {
      var self = this;
      if (self.loading) return self.loading;
      var cached = self.fromCache();
      if (cached) {
        self.items = cached;
        self.loading = Promise.resolve(cached);
        return self.loading;
      }
      var tasks = [];
      for (var i = 0; i < self.LETTERS.length; i++) {
        for (var p = 0; p < self.PAGES.length; p++) {
          tasks.push({ q: self.LETTERS[i], page: self.PAGES[p] });
        }
      }
      self.loading = new Promise(function (resolve) {
        var out = [];
        var seen = {};
        var index = 0;
        var active = 0;
        var LIMIT = 4;
        var finished = false;

        function finish() {
          if (finished) return;
          finished = true;
          self.items = out;
          if (out.length) self.saveCache(out);
          resolve(out);
        }

        function next() {
          if (finished) return;
          while (active < LIMIT && index < tasks.length) {
            var task = tasks[index];
            index++;
            active++;
            AnixApi.search(task.q, task.page).then(function (list) {
              for (var k = 0; k < list.length; k++) {
                var it = list[k];
                if (!it || !it.id || seen[it.id]) continue;
                seen[it.id] = 1;
                out.push(TVCatalog.slim(it));
              }
            }).catch(function () {
              /* одна неудачная страница не должна ломать весь пул */
            }).then(function () {
              active--;
              if (index >= tasks.length && active === 0) finish();
              else next();
            });
          }
          if (index >= tasks.length && active === 0) finish();
        }

        next();
      });
      return self.loading;
    },

    ensure: function () {
      if (this.items.length) return Promise.resolve(this.items);
      return this.load();
    }
  };

  /* ==========================================================
     TVSections — экраны «Популярное», «Расписание», «Коллекции», «Фильтры»
     ========================================================== */
  var TVSections = {
    filters: { genre: 'Все', status: 'Все', year: 'Все', sort: 'Рейтинг' },
    collection: 'top',

    COLLECTIONS: [
      { key: 'top', title: 'Топ рейтинга', desc: 'Лучшие оценки' },
      { key: 'new', title: 'Новинки', desc: 'Сначала свежие годы' },
      { key: 'ongoing', title: 'Онгоинги', desc: 'Ещё выходят' },
      { key: 'finished', title: 'Завершённые', desc: 'Все серии вышли' },
      { key: 'short', title: 'Короткие', desc: 'До 12 серий' },
      { key: 'long', title: 'Длинные', desc: '50 серий и больше' }
    ],

    isOngoing: function (rel) {
      var total = Number(rel.episodes_total) || 0;
      var out = Number(rel.episodes_released) || 0;
      if (total > 0) return out < total;
      return Number(rel.status_id) === 2;
    },

    /* Последняя дата из строки вида «c 08.07.2012 по 23.12.2012» */
    dateText: function (rel) {
      var s = String(rel.release_date || '');
      var re = /(\d{2})\.(\d{2})\.(\d{4})/g;
      var last = '';
      var m;
      while ((m = re.exec(s))) last = m[0];
      if (last) return last;
      return rel.year ? String(rel.year) : '';
    },

    dateOf: function (rel) {
      var txt = this.dateText(rel);
      var p = txt ? txt.split('.') : null;
      if (p && p.length === 3) {
        return new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0])).getTime();
      }
      var y = Number(rel.year);
      return y ? new Date(y, 0, 1).getTime() : 0;
    },

    scheduleMeta: function (rel) {
      var parts = [];
      var d = this.dateText(rel);
      if (d) parts.push(d);
      var total = Number(rel.episodes_total) || 0;
      var out = Number(rel.episodes_released) || 0;
      if (total) parts.push('эп. ' + (out || total) + '/' + total);
      else if (out) parts.push('эп. ' + out);
      if (rel.grade) parts.push('★ ' + Number(rel.grade).toFixed(2));
      return parts.join(' · ');
    },

    render: function (kind) {
      if (kind === 'popular') this.renderPopular();
      else if (kind === 'schedule') this.renderSchedule();
      else if (kind === 'collections') this.renderCollections();
      else if (kind === 'collection') this.renderCollection();
      else if (kind === 'filters') this.renderFilters();
    },

    loading: function (grid) {
      if (grid) grid.innerHTML = '<div class="history_empty">Загрузка каталога...</div>';
    },

    /* ---- скрытие просмотренного ---- */
    LIMIT: 40,
    limits: {},

    hideWatchedOn: function () {
      return storageGet('hide_watched', '0') === '1';
    },

    watchedIds: function () {
      var map = {};
      var list = TVHistory.get();
      for (var i = 0; i < list.length; i++) {
        var id = String(list[i].id || '');
        if (id.indexOf('anix:') === 0) map[id.slice(5)] = 1;
      }
      return map;
    },

    dropWatched: function (list) {
      if (!this.hideWatchedOn()) return list;
      var map = this.watchedIds();
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (!map[String(list[i].id)]) out.push(list[i]);
      }
      return out;
    },

    /* ---- сетка с догрузкой («Показать ещё») ---- */
    paint: function (grid, kind, list, emptyText, metaFn) {
      if (!grid) return;
      var total = list.length;
      var limit = this.limits[kind] || this.LIMIT;
      var part = list.slice(0, limit);
      fillReleaseRow(grid, part, emptyText, metaFn);
      if (total > part.length) {
        var more = document.createElement('div');
        more.className = 'history_card focusable';
        more.setAttribute('data-more', kind);
        var info = document.createElement('div');
        info.className = 'h_info';
        var t = document.createElement('div');
        t.className = 'h_title';
        t.textContent = 'Показать ещё';
        var m = document.createElement('div');
        m.className = 'h_meta';
        m.textContent = 'ещё ' + (total - part.length);
        info.appendChild(t);
        info.appendChild(m);
        more.appendChild(info);
        grid.appendChild(more);
      }
    },

    showMore: function (kind) {
      this.limits[kind] = (this.limits[kind] || this.LIMIT) + this.LIMIT;
      var row = $('main_view');
      if (kind === 'popular') this.renderPopular();
      else if (kind === 'schedule') this.renderSchedule();
      else if (kind === 'collection') this.renderCollection();
      else if (kind === 'filters') this.renderFilterResults();
    },

    /* После загрузки пула: если раздел ещё открыт и фокус на пункте меню — ведём на карточку */
    afterLoad: function (kind, grid) {
      if (TVList.current !== kind) return;
      var cur = TVNavigation.current;
      var nav = document.querySelector('[data-nav="' + kind + '"]');
      var first = grid ? grid.querySelector('.focusable') : null;
      if (first && (!cur || cur === nav)) TVNavigation.focus(first, true);
    },

    renderPopular: function () {
      var self = this;
      var grid = $('popular_grid');
      if (!grid) return;
      if (!TVCatalog.items.length) self.loading(grid);
      TVCatalog.ensure().then(function (items) {
        var list = items.slice();
        list.sort(function (a, b) { return (b.grade - a.grade) || (b.vote_count - a.vote_count); });
        list = list.filter(function (x) { return x.grade > 0 && x.vote_count >= 50; });
        list = self.dropWatched(list);
        self.paint(grid, 'popular', list, 'Нет данных');
        TVNavigation.refresh();
        self.afterLoad('popular', grid);
      });
    },

    renderSchedule: function () {
      var self = this;
      var grid = $('schedule_grid');
      if (!grid) return;
      if (!TVCatalog.items.length) self.loading(grid);
      TVCatalog.ensure().then(function (items) {
        /* у каталога почти все релизы уже вышли, поэтому «расписание» —
           даты выхода из карточки релиза, свежие сверху */
        var list = [];
        for (var i = 0; i < items.length; i++) {
          if (self.dateOf(items[i]) > 0) list.push(items[i]);
        }
        list.sort(function (a, b) { return self.dateOf(b) - self.dateOf(a); });
        list = self.dropWatched(list);
        self.paint(grid, 'schedule', list, 'Дат выхода в каталоге нет', function (rel) {
          return self.scheduleMeta(rel);
        });
        TVNavigation.refresh();
        self.afterLoad('schedule', grid);
      });
    },

    renderCollections: function () {
      var self = this;
      var grid = $('collections_grid');
      if (!grid) return;
      if (!TVCatalog.items.length) self.loading(grid);
      TVCatalog.ensure().then(function (items) {
        grid.innerHTML = '';
        grid.setAttribute('data-shift', '0');
        for (var i = 0; i < self.COLLECTIONS.length; i++) {
          var c = self.COLLECTIONS[i];
          var tile = document.createElement('div');
          tile.className = 'collection_tile focusable';
          tile.setAttribute('data-collection', c.key);
          var t = document.createElement('div');
          t.className = 'c_title';
          t.textContent = c.title;
          var d = document.createElement('div');
          d.className = 'c_desc';
          var count = self.collectionItems(items, c.key).length;
          d.textContent = c.desc + ' · ' + count;
          tile.appendChild(t);
          tile.appendChild(d);
          grid.appendChild(tile);
        }
        TVNavigation.refresh();
        self.afterLoad('collections', grid);
      });
    },

    collectionItems: function (items, key) {
      var self = this;
      var list = items.slice();
      if (key === 'top') {
        list = list.filter(function (x) { return x.grade > 0; });
        list.sort(function (a, b) { return b.grade - a.grade; });
      } else if (key === 'new') {
        list.sort(function (a, b) {
          return (Number(b.year) - Number(a.year)) || (b.last_update_date - a.last_update_date);
        });
      } else if (key === 'ongoing') {
        list = list.filter(function (x) { return self.isOngoing(x); });
        list.sort(function (a, b) { return b.last_update_date - a.last_update_date; });
      } else if (key === 'finished') {
        list = list.filter(function (x) { return !self.isOngoing(x) && x.episodes_released > 0; });
      } else if (key === 'short') {
        list = list.filter(function (x) { return x.episodes_total > 0 && x.episodes_total <= 12; });
        list.sort(function (a, b) { return b.grade - a.grade; });
      } else if (key === 'long') {
        list = list.filter(function (x) { return x.episodes_total >= 50; });
        list.sort(function (a, b) { return b.grade - a.grade; });
      }
      return list;
    },

    openCollection: function (key) {
      if (!key) return;
      this.collection = key;
      TVList.open('collection');
    },

    renderCollection: function () {
      var self = this;
      var grid = $('collection_grid');
      var title = $('collection_title');
      if (!grid) return;
      var def = null;
      for (var i = 0; i < self.COLLECTIONS.length; i++) {
        if (self.COLLECTIONS[i].key === self.collection) def = self.COLLECTIONS[i];
      }
      if (title) title.textContent = def ? def.title : 'Коллекция';
      if (!TVCatalog.items.length) self.loading(grid);
      TVCatalog.ensure().then(function (items) {
        var list = self.collectionItems(items, self.collection);
        list = self.dropWatched(list);
        self.paint(grid, 'collection', list, 'В коллекции пока пусто');
        TVNavigation.refresh();
        self.afterLoad('collection', grid);
      });
    },

    /* ---- фильтры ---- */
    genreOptions: function () {
      var counts = {};
      var i, j;
      for (i = 0; i < TVCatalog.items.length; i++) {
        var gs = String(TVCatalog.items[i].genres || '').split(',');
        for (j = 0; j < gs.length; j++) {
          var g = gs[j].replace(/^\s+|\s+$/g, '');
          if (!g || g.length < 3) continue;
          counts[g] = (counts[g] || 0) + 1;
        }
      }
      var arr = [];
      for (var k in counts) {
        if (counts.hasOwnProperty(k) && counts[k] >= 2) arr.push({ name: k, n: counts[k] });
      }
      arr.sort(function (a, b) { return b.n - a.n; });
      arr = arr.slice(0, 14);
      var names = ['Все'];
      for (i = 0; i < arr.length; i++) names.push(arr[i].name);
      return names;
    },

    yearOptions: function () {
      var seen = {};
      var arr = [];
      for (var i = 0; i < TVCatalog.items.length; i++) {
        var y = String(TVCatalog.items[i].year || '');
        if (!/^\d{4}$/.test(y) || seen[y]) continue;
        seen[y] = 1;
        arr.push(y);
      }
      arr.sort(function (a, b) { return Number(b) - Number(a); });
      arr = arr.slice(0, 10);
      return ['Все'].concat(arr);
    },

    optionList: function (what) {
      if (what === 'genre') return this.genreOptions();
      if (what === 'status') return ['Все', 'Завершённые', 'Онгоинги'];
      if (what === 'year') return this.yearOptions();
      return ['Рейтинг', 'Год', 'Название'];
    },

    cycleFilter: function (row) {
      var what = row && row.getAttribute('data-filter');
      if (!what) return;
      var opts = this.optionList(what);
      if (!opts.length) return;
      var i = opts.indexOf(this.filters[what]);
      this.filters[what] = opts[(i + 1) % opts.length];
      this.renderFilterValues();
      this.renderFilterResults();
      TVNavigation.refresh();
    },

    renderFilterValues: function () {
      var f = this.filters;
      if ($('f_genre')) $('f_genre').textContent = f.genre;
      if ($('f_status')) $('f_status').textContent = f.status;
      if ($('f_year')) $('f_year').textContent = f.year;
      if ($('f_sort')) $('f_sort').textContent = f.sort;
    },

    renderFilters: function () {
      var self = this;
      var grid = $('filter_grid');
      if (!grid) return;
      if (!TVCatalog.items.length) self.loading(grid);
      TVCatalog.ensure().then(function () {
        self.renderFilterValues();
        self.renderFilterResults();
        TVNavigation.refresh();
      });
    },

    filterMatch: function (rel) {
      var f = this.filters;
      if (f.genre !== 'Все' && String(rel.genres || '').toLowerCase().indexOf(f.genre.toLowerCase()) < 0) {
        return false;
      }
      var ongoing = this.isOngoing(rel);
      if (f.status === 'Завершённые' && ongoing) return false;
      if (f.status === 'Онгоинги' && !ongoing) return false;
      if (f.year !== 'Все' && String(rel.year) !== f.year) return false;
      return true;
    },

    renderFilterResults: function () {
      var self = this;
      var grid = $('filter_grid');
      if (!grid) return;
      var list = TVCatalog.items.filter(function (x) { return self.filterMatch(x); });
      if (self.filters.sort === 'Год') {
        list.sort(function (a, b) { return Number(b.year) - Number(a.year); });
      } else if (self.filters.sort === 'Название') {
        list.sort(function (a, b) {
          var x = String(a.title_ru).toLowerCase();
          var y = String(b.title_ru).toLowerCase();
          return x < y ? -1 : (x > y ? 1 : 0);
        });
      } else {
        list.sort(function (a, b) { return b.grade - a.grade; });
      }
      list = self.dropWatched(list);
      fillReleaseRow(grid, list.slice(0, 60), 'Ничего не найдено — измените фильтры');
      TVNavigation.refresh();
    }
  };

  /* ==========================================================
     5) Глобальный обработчик keydown
     ========================================================== */
  function isPlayerOpen() {
    return TVPlayer.opened === true;
  }

  /* Короткая блокировка от двойного срабатывания (RETURN на keydown + keyup) */
  var lastKey = 0;
  var lastKeyTime = 0;
  function isRepeat(e, code, windowMs) {
    var ts = (new Date()).getTime();
    var rep = (code === lastKey && ts - lastKeyTime < (windowMs || 120));
    lastKey = code;
    lastKeyTime = ts;
    return rep;
  }

  /* KEY_RETURN (10009) на Tizen обычно приходит на keyup, на части моделей — на keydown.
     preventDefault() вызывается в любом случае и в любом состоянии.
     Одно нажатие должно срабатывать ОДИН раз: иначе выход из плеера сразу закрывал
     и карточку релиза (keydown + keyup приходили с разницей больше 120 мс). */
  var lastReturnHandled = 0;
  var returnDownAt = 0;

  function handleReturn(e, fromUp) {
    e.preventDefault();
    var ts = (new Date()).getTime();

    if (fromUp) {
      /* keyup того же нажатия, которое уже обработали на keydown — игнорируем */
      if (returnDownAt && ts - returnDownAt < 800) return;
    } else {
      returnDownAt = ts;
    }
    if (ts - lastReturnHandled < 350) return;
    lastReturnHandled = ts;

    /* на главной exit() вызывается из handleKey (keydown) или отложенно из keyup */
    var onHome = !isPlayerOpen() && !TVSettings.isOpen() && !TVSearch.isOpen() &&
      !TVRelease.isOpen() && !TVList.isOpen();
    if (onHome && fromUp) {
      /* ждём один тик: если тот же RETURN придёт ещё и keydown — выйдет он */
      setTimeout(function () {
        if (isPlayerOpen() || TVSettings.isOpen() || TVSearch.isOpen() ||
            TVRelease.isOpen() || TVList.isOpen()) return;
        if (isRepeat(null, KEY.RETURN, 300)) return;
        if (!exitApp()) toast('Приложение работает без tizen: выход доступен только на ТВ');
      }, 80);
      return;
    }

    if (isRepeat(e, KEY.RETURN)) return;

    /* окно ошибки: RETURN закрывает */
    if (TVError.open) {
      TVError.close();
      return;
    }

    /* RETURN в подменю выбора (озвучка/источник) закрывает только его */
    if (TVChoice.open) {
      TVChoice.close();
      return;
    }

    /* RETURN при открытом меню качества закрывает только меню */
    if (TVPlayer.menuOpen) {
      TVPlayer.hideQualityMenu();
      return;
    }

    if (isPlayerOpen()) {
      TVPlayer.close();            /* плеер закрывается, приложение живо */
      return;
    }
    if (TVRelease.isRelatedOpen()) {
      TVRelease.closeRelated();
      return;
    }
    if (TVNetDiag.isOpen()) {
      TVNetDiag.hide();
      return;
    }
    if (TVRelease.isOpen()) {
      TVRelease.hide();
      return;
    }
    if (TVSearch.isOpen()) {
      TVSearch.hide();
      return;
    }
    if (TVSettings.isOpen()) {
      TVSettings.hide();
      return;
    }
    /* из содержимого коллекции RETURN ведёт к списку коллекций, а не на главную */
    if (TVList.current === 'collection') {
      TVList.open('collections');
      return;
    }
    if (TVList.isOpen()) {
      TVList.close();
      return;
    }
    if (!exitApp()) toast('Приложение работает без tizen: выход доступен только на ТВ');
  }

  /* Цифра из события: e.key ('1'..'9'), обычный код 48–57 или numpad 96–105 */
  function digitOf(e, code) {
    var k = e && e.key;
    if (k && k.length === 1 && k >= '0' && k <= '9') return Number(k);
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 96 && code <= 105) return code - 96;
    return -1;
  }

  /* Перемотка цифрой: работает и в keydown, и в keyup, без двойного прыжка */
  var lastDigitAt = 0;
  function seekByDigitOnce(e, code) {
    var d = digitOf(e, code);
    if (d < 1 || d > 9) return false;
    var now = (new Date()).getTime();
    if (now - lastDigitAt < 250) return true;
    lastDigitAt = now;
    if (isPlayerOpen() && !TVPlayer.webMode) TVPlayer.seekPercent(d * 10);
    return true;
  }

  /* Нормальные имена клавиш (Tizen 2.4+: tizen.tvinputdevice.getKeyName) */
  function keyNameOf(code) {
    try {
      if (isTizen() && tizen.tvinputdevice && typeof tizen.tvinputdevice.getKeyName === 'function') {
        return String(tizen.tvinputdevice.getKeyName(code) || '');
      }
    } catch (e) { /* noop */ }
    return '';
  }

  /* Клавиши воспроизведения в плеере (по коду и по имени) */
  /* Клавиши воспроизведения в плеере (по коду и по имени).
     10252/10233 на пультах Samsung — это MediaPlay/MediaPause, а не перемотка:
     раньше они были ошибочно привязаны к ±10 с и «отматывали назад». */
  var PLAYER_ACTIONS = {
    13: 'toggle', 415: 'toggle', 19: 'toggle', 179: 'toggle',
    10252: 'toggle', 10233: 'toggle',
    37: 'rw10', 39: 'ff10',
    412: 'rw10', 417: 'ff10'
  };

  function playerAction(code, name) {
    if (PLAYER_ACTIONS[code]) return PLAYER_ACTIONS[code];
    if (name === 'MediaPlayPause' || name === 'MediaPlay' || name === 'MediaPause') return 'toggle';
    if (name === 'MediaFastForward') return 'ff10';
    if (name === 'MediaRewind') return 'rw10';
    return '';
  }

  /* «anix:609» -> «609»: в истории id релиза хранится с префиксом */
  function releaseIdOf(id) {
    var s = id === undefined || id === null ? '' : String(id);
    return s.indexOf('anix:') === 0 ? s.substring(5) : s;
  }

  /* Карточка каталога/поиска/закладок/истории -> запись закладки */
  function bookmarkRelFromCard(el) {
    if (!el) return null;
    var relId = el.getAttribute('data-release');
    var title = String(el.getAttribute('data-title') || '').replace(/\s+—\s+\d+\s+серия\s*$/, '');
    var img = '';
    var m = /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage || '');
    if (m) img = m[1];
    if (!relId) {
      var recId = el.getAttribute('data-id');
      if (!recId) return null;
      relId = releaseIdOf(recId);
    }
    if (!relId) return null;
    return { id: relId, title_ru: title, image: img };
  }

  /* Что сейчас на экране: открытый релиз > плеер > сфокусированная карточка */
  function bookmarkCandidate() {
    if (TVRelease.isOpen() && TVRelease.rel) return TVRelease.rel;
    if (isPlayerOpen() && TVPlayer.current) {
      var c = TVPlayer.current;
      /* в плеере заголовок вида «Наруто — 5 серия», в закладках нужен релиз */
      var t = String(c.title || '').replace(/\s+—\s+\d+\s+серия\s*$/, '');
      return { id: releaseIdOf(c.id), title_ru: t, image: c.poster };
    }
    return bookmarkRelFromCard(TVNavigation.current);
  }

  function toggleBookmark() {
    var rel = bookmarkCandidate();
    if (!rel || !rel.id) { toast('Нечего добавить в закладки'); return; }
    var added = TVBookmarks.toggle(rel);
    if (added === null) { toast('Нечего добавить в закладки'); return; }
    if (added) toast('В закладках: ' + (rel.title_ru || 'релиз'));
    else toast('Убрано из закладок');
  }

  function removeCurrentEntry() {
    /* на экране релиза RED снимает закладку с этого релиза */
    if (TVRelease.isOpen() && TVRelease.rel) {
      if (TVBookmarks.remove(String(TVRelease.rel.id))) toast('Убрано из закладок');
      else toast('Этого релиза нет в закладках');
      return;
    }
    if (isPlayerOpen()) { toast('Сначала выйдите из плеера (RETURN)'); return; }
    var el = TVNavigation.current;
    if (!el) return;
    var brow = $('bookmark_row');
    if (brow && brow.contains(el)) {
      var bid = el.getAttribute('data-release');
      if (bid && TVBookmarks.remove(bid)) toast('Убрано из закладок');
      return;
    }
    var hrow = $('history_row');
    if (hrow && hrow.contains(el)) {
      var hid = el.getAttribute('data-id');
      if (hid) TVHistory.remove(hid);
      TVHistory.render();
      var first = hrow.querySelector('.history_card');
      if (first) TVNavigation.focus(first, true);
      else if (TVList.current === 'history') {
        TVNavigation.focus(document.querySelector('[data-nav="history"]'), true);
      } else {
        TVNavigation.focus($('search_open'), true);
      }
      toast('Удалено из истории');
      return;
    }
    var relId = el.getAttribute('data-release');
    if (relId && TVBookmarks.remove(relId)) { toast('Убрано из закладок'); return; }
    toast('Нечего удалять');
  }

  function openItemFrom(el) {
    if (!el) return;
    /* карточка релиза каталога */
    var relId = el.getAttribute('data-release');
    if (relId) {
      TVRelease.open(relId);
      return;
    }
    var id = el.getAttribute('data-id');
    /* история хранит id вида anix:<id релиза> — открываем карточку релиза,
       а не сразу серию: там видно описание, список серий и «Смотреть» */
    if (id && id.indexOf('anix:') === 0) {
      var releaseId = id.slice(5);
      if (releaseId) { TVRelease.open(releaseId); return; }
    }
    var src = el.getAttribute('data-src') || CONFIG.defaultSrc;
    var hist = TVHistory.find(id);
    var ep = parseInt(el.getAttribute('data-episode'), 10);
    if (!ep) ep = (hist && hist.episode) || 1;
    var item = {
      id: id,
      title: el.getAttribute('data-title') || (hist ? hist.title : 'Без названия'),
      poster: (hist && hist.poster) || CONFIG.defaultPoster,
      episode: ep,
      time: 0,
      src: src
    };
    /* сохранённая ссылка может быть страницей плеера источника, а не медиафайлом */
    if (src && !isMediaUrl(src)) {
      if (libriaParse(src)) TVPlayer.playLibria(src, item);
      else if (kodikParse(src)) TVPlayer.playKodik(src, item);
      else TVPlayer.openWeb(src, item);
    } else {
      TVPlayer.open(item);
    }
  }

  /* Единая точка активации элемента — и для пульта (OK), и для мыши/клика */
  function activateElement(el) {
    if (!el || !el.classList) return;

    if (el.classList.contains('nav_item')) {
      var nav = el.getAttribute('data-nav');
      if (nav === 'popular' || nav === 'schedule' || nav === 'collections' ||
          nav === 'filters' || nav === 'bookmarks' || nav === 'history') {
        if (TVRelease.isOpen() || TVRelease.isRelatedOpen()) {
          TVRelease.returnKind = null;
          TVRelease.hide();
        }
        if (TVSearch.isOpen()) TVSearch.hide();
        if (TVSettings.isOpen()) TVSettings.hide();
        TVList.open(nav);
        return;
      }
      if (nav === 'settings') {
        var rvs = $('related_view');
        if (rvs) rvs.style.display = 'none';
        TVSettings.show(true);
        return;
      }
      /* «Главная»: закрыть всё открытое и вернуться на главный экран */
      if (TVRelease.isOpen() || TVRelease.isRelatedOpen()) {
        TVRelease.returnKind = null;
        TVRelease.hide();
      }
      if (TVSearch.isOpen()) TVSearch.hide();
      if (TVSettings.isOpen()) TVSettings.hide();
      hideListViews();
      var m = $('main_view');
      if (m) m.style.display = 'block';
      TVNavigation.refresh();
      TVNavigation.focus(el, true);
      return;
    }

    /* служебные плитки и кнопки — раньше общих карточек */
    if (el.id === 'search_open') { TVSearch.show(); return; }
    if (el.id === 'random_more') { TVHome.loadRandom(); return; }
    if (el.id === 'search_go') { TVSearch.run(); return; }
    if (el.id === 'search_clear') { TVSearch.clear(); return; }
    if (el.id === 'search_back') { TVSearch.hide(); return; }
    if (el.id === 'rel_play') { TVRelease.playResume(); return; }
    if (el.id === 'rel_voice') { TVRelease.chooseType(); return; }
    if (el.id === 'rel_source') { TVRelease.chooseSource(); return; }
    if (el.id === 'rel_bookmark') { toggleBookmark(); return; }
    if (el.id === 'rel_reset_watched') { TVRelease.resetWatched(); return; }
    if (el.id === 'rel_related_btn') { TVRelease.openRelated(); return; }
    if (el.id === 'rel_back') { TVRelease.hide(); return; }
    if (el.id === 'settings_back') { TVSettings.hide(); return; }
    if (el.id === 'net_open') { TVNetDiag.show(); return; }
    if (el.id === 'net_run') { TVNetDiag.run(); return; }
    if (el.id === 'net_back') { TVNetDiag.hide(); return; }
    if (el.hasAttribute('data-more')) { TVSections.showMore(el.getAttribute('data-more')); return; }

    if (el.classList.contains('ep_btn')) {
      TVRelease.playIndex(parseInt(el.getAttribute('data-ep'), 10));
      return;
    }
    if (el.hasAttribute('data-recent')) {
      TVSearch.useRecent(el.getAttribute('data-recent'));
      return;
    }
    if (el.classList.contains('key_btn')) {
      TVSearch.press(el.getAttribute('data-key'));
      return;
    }
    if (el.classList.contains('collection_tile')) {
      TVSections.openCollection(el.getAttribute('data-collection'));
      return;
    }
    if (el.hasAttribute('data-filter')) {
      TVSections.cycleFilter(el);
      return;
    }
    if (el.hasAttribute('data-setting')) {
      TVSettings.toggle(el);
      return;
    }
    /* каталог: карточки релизов и карточки истории */
    if (el.classList.contains('card') || el.classList.contains('history_card')) {
      openItemFrom(el);
    }
  }

  function handleKey(e) {
    var code = e.keyCode || e.which;
    /* диагностика: какая кнопка пришла последней (видно в настройках) */
    try { window.__LAST_KEY = { code: code, name: keyNameOf(code) }; } catch (eLk) { /* noop */ }

    if (code === KEY.RETURN) {
      /* RETURN 10009 всегда с preventDefault во всех состояниях */
      handleReturn(e, false);
      return;
    }

    /* В браузере (без tizen) RETURN заменяется на Esc */
    if (code === 27 && !isTizen()) {
      handleReturn(e, false);
      return;
    }

    /* Цветные кнопки: зелёная — закладка (вне плеера) и статистика (в плеере),
       красная — удалить запись. */
    if (code === KEY.GREEN) {
      e.preventDefault();
      if (isPlayerOpen()) toggleInfoOnce();
      else toggleBookmark();
      return;
    }
    if (code === KEY.RED) {
      e.preventDefault();
      removeCurrentEntry();
      return;
    }

    /* подменю выбора (озвучка/источник): ▲▼ — навигация, OK — применить */
    if (TVError.open) {
      if (code === KEY.ENTER) {
        e.preventDefault();
        TVError.run();
      }
      return;
    }

    if (TVChoice.open) {
      if (code === KEY.UP || code === KEY.DOWN) {
        e.preventDefault();
        TVChoice.move(code === KEY.UP ? -1 : 1);
        return;
      }
      if (code === KEY.ENTER) {
        e.preventDefault();
        TVChoice.select();
        return;
      }
      return;
    }

    if (isPlayerOpen()) {
      /* меню качества: стрелки вверх/вниз, OK — применить */
      if (TVPlayer.menuOpen) {
        e.preventDefault();
        if (code === KEY.UP) TVPlayer.qualityMove(-1);
        else if (code === KEY.DOWN) TVPlayer.qualityMove(1);
        else if (code === KEY.ENTER) TVPlayer.qualitySelect();
        return;
      }      /* жёлтая кнопка пульта открывает выбор качества */
      if (code === KEY.YELLOW && !TVPlayer.webMode) {
        e.preventDefault();
        TVPlayer.showQualityMenu();
        return;
      }
      /* синяя кнопка переключает шаг перемотки: 10 → 20 → 30 → 70 → 77 → 10 */
      if (code === KEY.BLUE && !TVPlayer.webMode) {
        e.preventDefault();
        TVPlayer.cycleSeekStep();
        return;
      }
      /* CH+ / CH− — следующая / предыдущая серия */
      if (code === KEY.CHUP || code === KEY.CHDOWN) {
        e.preventDefault();
        TVRelease.switchEpisode(code === KEY.CHUP ? 1 : -1);
        return;
      }
      /* INFO — статистика плеера (keydown и keyup, с защитой от двойного срабатывания) */
      if (code === KEY.INFO) {
        e.preventDefault();
        toggleInfoOnce();
        return;
      }
      /* цифры 1–9 — переход к 10–90 % длительности */
      if (seekByDigitOnce(e, code)) {
        e.preventDefault();
        return;
      }
      /* ▲ ▼ — скрыть/показать интерфейс (вместо перемотки) */
      if (code === KEY.UP || code === KEY.DOWN) {
        e.preventDefault();
        TVPlayer.toggleUI();
        return;
      }
      /* во встроенном плеере источника ОК открывает страницу в браузере ТВ:
         внутри iframe пультом нажать Play нельзя */
      if (TVPlayer.webMode && code === KEY.ENTER) {
        e.preventDefault();
        TVPlayer.openExternal();
        return;
      }
      var action = playerAction(code, keyNameOf(code));
      if (action === 'toggle') {
        e.preventDefault();
        TVPlayer.togglePause();
      } else if (action) {
        e.preventDefault();
        var step = TVPlayer.seekStep();
        if (action === 'rw10') TVPlayer.seek(-step);
        else if (action === 'ff10') TVPlayer.seek(step);
        else if (action === 'rw60') TVPlayer.seek(-60);
        else if (action === 'ff60') TVPlayer.seek(60);
      }
      return;
    }

    /* Навигация по интерфейсу */
    if (code === KEY.LEFT) {
      e.preventDefault();
      TVNavigation.navigate('left');
      return;
    }
    if (code === KEY.RIGHT) {
      e.preventDefault();
      TVNavigation.navigate('right');
      return;
    }
    if (code === KEY.UP) {
      e.preventDefault();
      TVNavigation.navigate('up');
      return;
    }
    if (code === KEY.DOWN) {
      e.preventDefault();
      TVNavigation.navigate('down');
      return;
    }
    if (code === KEY.ENTER) {
      e.preventDefault();
      activateElement(TVNavigation.current);
    }
  }

  /* RETURN обычно приходит на keyup — обрабатываем и его, без двойного срабатывания.
     INFO на части пультов тоже приходит на keyup. */
  var lastInfoAt = 0;
  function toggleInfoOnce() {
    var now = (new Date()).getTime();
    if (now - lastInfoAt < 300) return;
    lastInfoAt = now;
    if (isPlayerOpen()) TVPlayer.toggleStats();
  }

  function handleMediaKey(e) {
    var code = e.keyCode || e.which;
    if (code === KEY.RETURN) {
      e.preventDefault();
      handleReturn(e, true);
    } else if (code === KEY.INFO) {
      e.preventDefault();
      toggleInfoOnce();
    } else if (seekByDigitOnce(e, code)) {
      e.preventDefault();
    }
  }

  /* ==========================================================
     Инициализация
     ========================================================== */
  /* Разрешаем сетевой политике Tizen обращения к Kodik и его CDN:
     без этого прямой запрос за ссылкой на поток может быть заблокирован. */
  function allowKodikOrigins() {
    if (!isTizen() || !tizen.application || typeof tizen.application.addAllowedOrigin !== 'function') return;
    var origins = ['https://kodikplayer.com', 'https://cloud2.solodcdn.com', 'https://spider.cloud2.solodcdn.com'];
    for (var i = 0; i < origins.length; i++) {
      try { tizen.application.addAllowedOrigin(origins[i]); } catch (e) { /* noop */ }
    }
  }

  function initVolumeKeys() {
    /* Громкость (VolumeUp/Down/Mute) здесь НЕ регистрируем: после registerKey
       телевизор перестаёт регулировать её сам, а собственного обработчика
       громкости у виджета нет — кнопки начинали «не работать».
       Остальные мультимедиа- и цветные кнопки нужны приложению. */
    var keys = [
      'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', 'MediaStop',
      /* INFO — статистика плеера (на части пультов приходит только после регистрации) */
      'Info', 'Tools', 'Guide',
      /* цифры (на части пультов доставляются только после регистрации) */
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      /* каналы в плеере листают серии */
      'ChannelUp', 'ChannelDown',
      /* цветные кнопки: GREEN — закладка, RED — удалить запись, YELLOW — качество, BLUE — шаг перемотки */
      'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'
    ];
    try {
      if (isTizen() && tizen.tvinputdevice && typeof tizen.tvinputdevice.registerKey === 'function') {
        for (var i = 0; i < keys.length; i++) {
          try {
            tizen.tvinputdevice.registerKey(keys[i]);
          } catch (eKey) {
            /* отдельная кнопка может не поддерживаться моделью */
          }
        }
      }
    } catch (e) {
      /* эмулятор / неподдерживаемая модель — игнорируем */
    }
  }

  /* Точка входа. Вызывается загрузчиком (loader.js), когда он решит,
     запускать встроенную копию кода или скачанную с GitHub. */
  function bootApp() {
    try {
      initVolumeKeys();
    } catch (eInit) { /* noop */ }
    try {
      allowKodikOrigins();
    } catch (eOrig) { /* noop */ }
    try {
      TVPlayer.init();
      TVSettings.render();
      TVHistory.render();
      TVBookmarks.render();
      TVContinue.render();
      cachePurge();
    } catch (eCore) { /* noop */ }

    /* События UI: один делегированный обработчик — пульт и мышь ведут себя одинаково */
    on(document, 'click', function (e) {
      var t = e.target;
      while (t && t !== document.body && t !== document) {
        if (t.classList && t.classList.contains('focusable')) {
          if (TVNavigation.current !== t) TVNavigation.focus(t, true);
          activateElement(t);
          return;
        }
        t = t.parentNode;
      }
    });

    /* Подборка с API — после отрисовки интерфейса */
    window.setTimeout(function () {
      TVHome.loadRandom();
    }, 100);

    /* Стартовый фокус */
    window.setTimeout(function () {
      TVNavigation.init();
    }, 0);

    /* Резервная регистрация нажатий (Tizen иногда шлёт keydown до onload) */
    document.addEventListener('keydown', handleKey, false);
    document.addEventListener('keyup', handleMediaKey, false);
  }

  /* Загрузчик вызывает это; повторный вызов (две копии кода) игнорируется. */
  window.TVAppBoot = function () {
    if (window.__TV_BOOTED__) return;
    window.__TV_BOOTED__ = true;
    bootApp();
  };

  /* Корректно закрыть плеер при уходе со страницы */
  window.addEventListener('unload', function () {
    try { TVPlayer.close(); } catch (e) { /* noop */ }
  }, false);

  /* Экспорт для отладки */
  window.TVNavigation = TVNavigation;
  window.TVPlayer = TVPlayer;
  window.TVNetwork = TVNetwork;
  window.TVHistory = TVHistory;
  window.TVBookmarks = TVBookmarks;
  window.TVWatched = TVWatched;
  window.TVList = TVList;  window.TVSections = TVSections;
  window.TVCatalog = TVCatalog;
  window.TVSettings = TVSettings;
  window.AnixApi = AnixApi;
  window.TVHome = TVHome;
  window.TVSearch = TVSearch;
  window.TVRelease = TVRelease;
  window.TVChoice = TVChoice;
  window.TVContinue = TVContinue;
  window.TVError = TVError;
  window.TVNetDiag = TVNetDiag;
  /* для проверок: разбор и раскодирование ссылок Kodik */
  window.kodikParse = kodikParse;
  window.kodikDecodeLink = kodikDecodeLink;
  window.kodikPickHls = kodikPickHls;
})();
