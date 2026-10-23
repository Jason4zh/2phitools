/* app.js —— UI / 搜索 / 下载 / 打包下载 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var CORE = window.PHICORE;
  var JSZ = window.JSZip;

  /* ---------------- 默认配置 ---------------- */
  var DEFAULT = {
    // 已实测可用（真机 file:// origin 下无 CORS 拦截）的两个数据源
    src: [
      { name: 'sayobot', url: 'https://api.sayobot.cn/?post' },
      { name: 'osu.direct', url: 'https://osu.direct/api/search?q={q}&m=3&ps=50' }
    ],
    dl: [
      'https://osu.direct/api/d/{id}',
      'https://dl.sayobot.cn/beatmaps/download/novideo/{id}'
    ],
    proxy: '', cid: '', csec: '',
    opt: { spread: 0.75, lineY: 700, speed: 8.5, offsetMs: 0, finishToFlick: false }
  };
  var LSKEY = 'mcz2phi.v3';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    var s = clone(DEFAULT);
    try {
      var raw = localStorage.getItem(LSKEY);
      if (raw) {
        var j = JSON.parse(raw);
        if (j && typeof j === 'object') {
          if (j.src) s.src = j.src;
          if (j.dl) s.dl = j.dl;
          if (typeof j.proxy === 'string') s.proxy = j.proxy;
          if (typeof j.cid === 'string') s.cid = j.cid;
          if (typeof j.csec === 'string') s.csec = j.csec;
          if (j.opt) { for (var k in s.opt) if (j.opt[k] !== undefined) s.opt[k] = j.opt[k]; }
        }
      }
    } catch (e) { }
    return s;
  }
  function save() { try { localStorage.setItem(LSKEY, JSON.stringify(S)); } catch (e) { } }
  var S = load();

  /* ---------------- 小工具 ---------------- */
  function msg(el, text, kind) {
    if (!el) return;
    el.className = 'msg ' + (kind || 'info') + ' show';
    el.textContent = text;
  }
  function clearMsg(el) { if (el) { el.className = 'msg'; el.textContent = ''; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[c];
    });
  }
  function safeName(s) {
    return String(s || 'chart').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'chart';
  }
  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 8000);
  }
  function busy(btn, on, textWhenBusy) {
    if (!btn) return;
    if (on) {
      btn.dataset.old = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>' + (textWhenBusy || '处理中');
    } else {
      btn.disabled = false;
      if (btn.dataset.old) btn.textContent = btn.dataset.old;
    }
  }

  /* ---------------- 网络层 ---------------- */
  function withProxy(url) {
    var p = (S.proxy || '').trim();
    if (!p) return url;
    if (p.indexOf('{url}') >= 0) return p.replace(/\{url\}/g, encodeURIComponent(url));
    if (p.indexOf('{raw}') >= 0) return p.replace(/\{raw\}/g, url);
    return p + encodeURIComponent(url);
  }
  function req(url, o) {
    o = o || {};
    var init = { method: o.method || 'GET' };
    if (o.headers) init.headers = o.headers;
    if (o.body != null) init.body = o.body;
    init.redirect = 'follow';
    return fetch(withProxy(url), init);
  }

  var TK = null;
  async function osuToken() {
    if (TK && TK.exp > Date.now()) return TK.t;
    if (!S.cid || !S.csec) throw new Error('未填 client_id / client_secret');
    var r = await req('https://osu.ppy.sh/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: +S.cid, client_secret: S.csec, grant_type: 'client_credentials', scope: 'public' })
    });
    if (!r.ok) throw new Error('获取 token 失败 HTTP ' + r.status);
    var j = await r.json();
    if (!j.access_token) throw new Error('token 无效');
    TK = { t: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
    return TK.t;
  }

  function normSet(bs) {
    if (!bs || typeof bs !== 'object') return null;
    var covers = bs.covers || {};
    var raw = bs.beatmaps || bs.children || bs.difficulties || [];
    var creator = bs.creator;
    if (creator && typeof creator === 'object') creator = creator.name || creator.username || '';
    var maps = [];
    for (var i = 0; i < raw.length; i++) {
      var b = raw[i] || {};
      var mode = b.mode;
      if (typeof mode === 'string') {
        var mm = mode.toLowerCase();
        mode = mm === 'mania' ? 3 : mm === 'taiko' ? 1 : (mm === 'fruits' || mm === 'catch') ? 2 : mm === 'osu' ? 0 : null;
      }
      var keys = 0;
      if (b.cs != null) keys = +b.cs;
      else if (b.difficulty && b.difficulty.cs != null) keys = +b.difficulty.cs;
      var star = b.difficulty_rating;
      if (star == null && b.difficulty && typeof b.difficulty === 'object') star = b.difficulty.rating;
      if (star == null) star = b.star;
      maps.push({ id: b.id, version: b.version || b.name || '', mode: mode, keys: keys, star: +star || 0 });
    }
    return {
      id: bs.id,
      title: bs.title || bs.title_unicode || bs.song_name || ('#' + bs.id),
      artist: bs.artist || bs.artist_unicode || '',
      creator: creator || '',
      cover: covers['list@2x'] || covers.cover || covers['cover@2x'] || covers.list || covers.card || bs.cover_url || bs.preview_url || '',
      maps: maps
    };
  }

  async function sourceSearch(src, q) {
    var url = String(src.url).replace(/\{q\}/g, encodeURIComponent(q));
    var host = hostOf(url);
    if (host.indexOf('sayobot') >= 0) return sayobotSearch(q, url);
    if (host.indexOf('osu.direct') >= 0) return osuDirectSearch(q, url);
    // 通用兜底：osu! API v2 / 其他镜像形状
    var r = await req(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var arr = Array.isArray(j) ? j : (j.beatmapsets || j.data || j.results || j.maps || null);
    if (!Array.isArray(arr)) throw new Error('返回格式异常');
    return arr.map(normSet).filter(Boolean);
  }

  function hostOf(u) { return String(u).replace(/^https?:\/\//, '').split('/')[0].toLowerCase(); }

  /* ---- sayobot：POST 必须是 text/plain 简单请求，否则被 CORS 预检拦下 ---- */
  async function sayobotSearch(q, url) {
    var r = await req(url || 'https://api.sayobot.cn/?post', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ cmd: 'beatmaplist', limit: 30, offset: 0, type: 'search', keyword: q })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var arr = (j && (j.data || j.list)) || [];
    if (!Array.isArray(arr)) throw new Error('返回格式异常');
    var out = [];
    arr.forEach(function (s) {
      if (!s || s.sid == null) return;
      if (!(+s.modes & 8)) return;              // 8 = 含 mania 难度
      out.push({
        id: s.sid, title: s.title || ('#' + s.sid), artist: s.artist || '',
        creator: s.creator || '', cover: '', maps: [], lazy: true, src: 'sayobot'
      });
    });
    return out;
  }

  /* 补 sayobot 单集难度（列表接口不返回 children） */
  async function fillSayobotMaps(set) {
    if (!set || set._filling || set._filled) return;
    set._filling = true;
    try {
      var r = await req('https://api.sayobot.cn/v2/beatmapinfo?0=' + set.id);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      var d = (j && j.data) || {};
      var maps = [];
      (d.bid_data || []).forEach(function (b) {
        if (+b.mode !== 3) return;              // 0=std 1=taiko 2=catch 3=mania
        maps.push({
          id: b.bid, version: b.version || '', mode: 3,
          keys: Math.round(+b.CS) || 0, star: +(b.star || 0), length: +(b.length || 0)
        });
      });
      set.maps = maps;
      set.bpm = d.bpm;
      if (!set.artist && d.artist) set.artist = d.artist;
      if (!set.creator && d.creator) set.creator = d.creator;
    } catch (e) {
      set.maps = set.maps || [];
      set._err = e.message || String(e);
    }
    set._filling = false;
    set._filled = true;
    if (SEARCHED.indexOf(set) >= 0) renderSets(SEARCHED);
  }

  async function fillAll(sets, limit) {
    var list = sets.filter(function (s) { return s.lazy && !s._filled; });
    var i = 0;
    var workers = [];
    for (var w = 0; w < Math.min(limit || 4, list.length); w++) {
      workers.push((async function () {
        while (i < list.length) { var s = list[i++]; await fillSayobotMaps(s); }
      })());
    }
    await Promise.all(workers);
  }

  /* ---- osu.direct：官方数据镜像，一次请求带齐难度列表 ---- */
  function normOsuDirect(bs) {
    if (!bs || bs.SetID == null) return null;
    var maps = [];
    (bs.ChildrenBeatmaps || []).forEach(function (b) {
      if (+b.Mode !== 3) return;                // 0=std 1=taiko 2=catch 3=mania
      maps.push({
        id: b.BeatmapID, version: b.DiffName || '', mode: 3,
        keys: Math.round(+b.CS) || 0, star: +(b.DifficultyRating || 0), length: +(b.TotalLength || 0)
      });
    });
    if (!maps.length) return null;              // 没有 mania 难度就不显示
    return {
      id: bs.SetID, title: bs.Title || ('#' + bs.SetID), artist: bs.Artist || '',
      creator: bs.Creator || '', cover: '', maps: maps, src: 'osu.direct'
    };
  }

  async function osuDirectSearch(q, url) {
    var r = await req(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var arr = Array.isArray(j) ? j : (j.beatmapsets || j.data || []);
    if (!Array.isArray(arr)) throw new Error('返回格式异常');
    return arr.map(normOsuDirect).filter(Boolean);
  }

  async function officialSearch(q) {
    try {
      var t = await osuToken();
      var r = await req('https://osu.ppy.sh/api/v2/beatmapsets/search?m=3&s=any&q=' + encodeURIComponent(q), {
        headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      return { name: 'osu!官方', arr: (j.beatmapsets || []).map(normSet).filter(Boolean) };
    } catch (e) {
      return { name: 'osu!官方', err: e.message || String(e) };
    }
  }

  /* ---------------- 下载谱面包 ---------------- */
  function looksZip(buf) {
    var u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return u[0] === 0x50 && u[1] === 0x4b;
  }

  async function fetchOsz(setId, onLog) {
    var errs = [];
    var tpls = S.dl && S.dl.length ? S.dl : DEFAULT.dl;
    for (var i = 0; i < tpls.length; i++) {
      var url = String(tpls[i]).replace(/\{id\}/g, String(setId));
      var host = url.replace(/^https?:\/\//, '').split('/')[0];
      try {
        if (onLog) onLog('下载源 ' + host + ' …');
        var r = await req(url, { headers: { 'Accept': '*/*' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var buf = await r.arrayBuffer();
        if (buf.byteLength < 512) throw new Error('文件过小');
        if (!looksZip(buf)) throw new Error('不是 zip（可能被拦截/需要登录）');
        return buf;
      } catch (e) {
        errs.push(host + ': ' + (e.message || e));
      }
    }
    throw new Error('所有下载源都失败了\n' + errs.join('\n'));
  }

  /* ---------------- 解包 → 谱面列表 ---------------- */
  async function extractCharts(buf) {
    if (!JSZ) throw new Error('JSZip 未加载，无法解包');
    var zip;
    try { zip = await JSZ.loadAsync(buf); }
    catch (e) { throw new Error('无法解包：不是有效的 zip / mcz / osz'); }

    var out = [], i, names = [], mcNames = [];
    zip.forEach(function (rel, f) {
      if (f.dir) return;
      if (/\.osu$/i.test(rel)) names.push(rel);
      else if (/\.mc_?$/i.test(rel)) mcNames.push(rel);
    });

    // ---- osu!mania ----
    for (i = 0; i < names.length; i++) {
      var txt;
      try { txt = await zip.file(names[i]).async('string'); }
      catch (e) { continue; }
      var ch;
      try { ch = CORE.parseOsu(txt); } catch (e) { continue; }
      if (ch.mode !== 3) continue;
      ch.fileName = names[i];
      ch._zip = zip;
      out.push(ch);
    }

    // ---- Malody key 模式（.mc；.mc_ 实际是内含 .mc 的 zip）----
    var errs = [];
    for (i = 0; i < mcNames.length; i++) {
      try {
        var raw = await zip.file(mcNames[i]).async('uint8array');
        var mcText = await readMcPayload(raw);
        if (mcText == null) continue;
        var mch = CORE.parseMc(mcText);
        mch.fileName = mcNames[i];
        mch._zip = zip;                 // 音频/曲绘仍在最外层包里
        out.push(mch);
      } catch (e) {
        errs.push(mcNames[i] + '：' + (e.message || e));
      }
    }

    if (!out.length) {
      throw new Error('包内没有可转换的谱面' +
        '（osu!mania 需 Mode:3；Malody 需 Key 模式的 .mc）' +
        (errs.length ? '\n' + errs.slice(0, 4).join('\n') : ''));
    }
    return out;
  }

  /* .mc_ 通常是 zip（内含 .mc），也可能是 gzip 或纯文本 */
  async function readMcPayload(buf) {
    var u = new Uint8Array(buf);
    if (u.length > 4 && u[0] === 0x50 && u[1] === 0x4b) {           // zip
      var z = await JSZ.loadAsync(buf);
      var inner = null, any = null;
      z.forEach(function (rel, f) {
        if (f.dir) return;
        if (/\.mc$/i.test(rel)) inner = rel;
        if (!any) any = rel;
      });
      var pick = inner || any;
      if (!pick) return null;
      return await z.file(pick).async('string');
    }
    if (u.length > 2 && u[0] === 0x1f && u[1] === 0x8b) {           // gzip
      if (typeof DecompressionStream === 'undefined') return null;
      var ds = new DecompressionStream('gzip');
      var ab = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
      return new TextDecoder('utf-8').decode(ab);
    }
    return new TextDecoder('utf-8').decode(buf);                     // 纯文本
  }

  /* ---------------- 找音频 / 背景图 ---------------- */
  function findInZip(zip, hint, exts) {
    if (!zip) return null;
    var names = Object.keys(zip.files || {}).filter(function (n) { return !zip.files[n].dir; });
    var want = baseName(hint || '').toLowerCase();
    var i;
    if (want) {
      for (i = 0; i < names.length; i++) if (baseName(names[i]).toLowerCase() === want) return names[i];
    }
    for (i = 0; i < names.length; i++) {
      var e = extOf(names[i]);
      if (exts.indexOf(e) >= 0) return names[i];
    }
    return null;
  }

  /* ---------------- 参数 ---------------- */
  function readOpts() {
    return {
      spread: +$('#oSpread').value || 0.75,
      lineY: +$('#oLineY').value || 700,
      speed: +$('#oSpeed').value || 8.5,
      offsetMs: +$('#oOff').value || 0,
      finishToFlick: $('#oFlick').checked
    };
  }
  function applyOpts(o) {
    if (!o) return;
    $('#oSpread').value = o.spread;
    $('#oLineY').value = o.lineY;
    $('#oSpeed').value = o.speed;
    $('#oOff').value = o.offsetMs;
    $('#oFlick').checked = !!o.finishToFlick;
  }
  $$('#optbox input').forEach(function (el) {
    el.addEventListener('change', function () {
      S.opt = readOpts();
      save();
      if (OUTS.length) renderOut(OUTS.charts, OUTS.meta); // 参数变了重新生成
    });
  });

  /* ---------------- 输出 ---------------- */
  var OUTS = { charts: [], meta: null };

  async function emit(charts, meta) {
    charts.sort(function (a, b) { return (b.noteCountCalc || 0) - (a.noteCountCalc || 0); });
    OUTS = { charts: charts, meta: meta || {} };
    renderOut(charts, OUTS.meta);
    var outEl = $('#out');
    if (outEl && outEl.scrollIntoView) outEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderOut(charts, meta) {
    var opts = readOpts();
    var box = $('#out');
    box.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'out-title';
    head.textContent = '转换结果（' + charts.length + ' 个谱面）';
    box.appendChild(head);

    charts.forEach(function (ch, idx) {
      var r;
      // 用 osu! 星级标定等级（搜索来的谱面都有）；本地文件没有星级则退回 NPS 估算
      var star = 0;
      if (meta && meta.set && meta.set.maps) {
        for (var mi = 0; mi < meta.set.maps.length; mi++) {
          if (meta.set.maps[mi].version === ch.version) { star = meta.set.maps[mi].star || 0; break; }
        }
      }
      opts.star = star;
      try { r = CORE.buildPec(ch, opts); }
      catch (e) {
        var er = document.createElement('div');
        er.className = 'rcard';
        er.innerHTML = '<h3>' + esc(ch.title) + '</h3><div class="a" style="color:#ff9b9e">转换失败：' + esc(e.message) + '</div>';
        box.appendChild(er);
        return;
      }
      ch._r = r;

      var card = document.createElement('div');
      card.className = 'rcard';

      var title = ch.title + (ch.version ? ' [' + ch.version + ']' : '');
      card.innerHTML =
        '<h3><span>' + esc(title) + '</span>' +
        '<span class="tag">' + r.keys + 'K</span>' +
        '<span class="tag g">Lv.' + r.suggestLevel + '</span>' +
        (ch._zip ? '' : '<span class="tag o">无音频</span>') +
        '</h3>' +
        '<div class="a" style="font-size:12px;color:var(--tx2);margin-top:3px">' +
        esc(ch.artist || '') + ' · by ' + esc(ch.creator || '') + '</div>' +
        '<div class="stats">' +
        stat('音符', r.noteCount) +
        stat('Tap', r.stat.tap) +
        stat('Hold', r.stat.hold) +
        (r.stat.flick ? stat('Flick', r.stat.flick) : '') +
        (r.stat.drag ? stat('Drag', r.stat.drag) : '') +
        stat('BPM', Math.round(r.bpm * 100) / 100 + (r.bpmList.length > 1 ? '+' : '')) +
        stat('时长', fmtTime(r.firstMs) + '→' + fmtTime(r.firstMs + r.durationMs)) +
        stat('NPS', r.nps) +
        '</div>' +
        '<div class="acts">' +
        '<button class="btn sm primary" data-a="pec">下载 .pec</button>' +
        (ch._zip ? '<button class="btn sm gr" data-a="zip">下载 ZIP（含音频）</button>' : '') +
        '<button class="btn sm" data-a="prev">预览</button>' +
        '</div>' +
        '<pre></pre>';

      function stat(k, v) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

      var pre = card.querySelector('pre');
      pre.textContent = r.pec.length > 6000 ? r.pec.slice(0, 6000) + '\n…（共 ' + r.pec.split('\n').length + ' 行）' : r.pec;

      card.addEventListener('click', async function (ev) {
        var btn = ev.target.closest('button[data-a]');
        if (!btn) return;
        var a = btn.dataset.a;
        if (a === 'prev') { pre.classList.toggle('show'); return; }
        if (a === 'pec') {
          saveBlob(new Blob([r.pec], { type: 'text/plain;charset=utf-8' }), safeName(ch.title + ' [' + ch.version + ']') + '.pec');
          return;
        }
        if (a === 'zip') {
          busy(btn, true, '打包中');
          try {
            var blob = await buildZip(ch, r);
            saveBlob(blob, safeName(ch.title + ' [' + ch.version + ']') + '_phi.zip');
          } catch (e) { alert('打包失败：' + (e.message || e)); }
          finally { busy(btn, false); }
        }
      });

      box.appendChild(card);
    });
  }

  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  async function buildZip(ch, r) {
    var zip = new JSZ();
    zip.file('chart.pec', r.pec);

    var audioName = findInZip(ch._zip, ch.audio, ['mp3', 'ogg', 'wav', 'm4a', 'flac']);
    var musicFile = '';
    if (audioName) {
      musicFile = 'music.' + extOf(audioName);
      zip.file(musicFile, await ch._zip.file(audioName).async('uint8array'));
    }
    var bgName = findInZip(ch._zip, ch.bg, ['jpg', 'jpeg', 'png', 'webp']);
    var bgFile = '';
    if (bgName) {
      bgFile = 'bg.' + extOf(bgName);
      zip.file(bgFile, await ch._zip.file(bgName).async('uint8array'));
    }

    var lv = r.suggestLevel;
    var fromMalody = ch.game === 'malody';
    zip.file('info.yml', CORE.makeInfoYml({
      name: ch.title + (ch.version ? ' [' + ch.version + ']' : ''),
      difficulty: lv,
      level: 'IN Lv.' + lv,
      charter: (fromMalody ? 'malody2phi · ' : 'osu2phi · ') + (ch.creator || ''),
      composer: ch.artist || '',
      illustrator: '',
      chart: 'chart.pec',
      music: musicFile,
      illustration: bgFile,
      offset: 0,
      tip: fromMalody ? 'Converted from Malody (key mode)' : 'Converted from osu!mania',
      intro: '源谱面：' + (ch.version || '') + ' / mapper: ' + (ch.creator || '') + ' / ' + ch.keys + 'K'
    }));

    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }

  /* ---------------- 搜索结果 ---------------- */
  var SEARCHED = [];

  function renderSets(sets) {
    var box = $('#results');
    box.innerHTML = '';
    if (!sets.length) return;
    sets.forEach(function (s) {
      var mania = s.maps.filter(function (m) { return m.mode === 3 || m.mode == null || m.mode === '3'; });
      var el = document.createElement('div');
      el.className = 'set';
      el.innerHTML = '<img referrerpolicy="no-referrer" loading="lazy" alt="">' +
        '<div class="info"><div class="t"></div><div class="a"></div><div class="chips"></div></div>';
      var img = el.querySelector('img');
      if (s.cover) img.src = s.cover; else img.style.visibility = 'hidden';
      el.querySelector('.t').textContent = s.title;
      el.querySelector('.a').textContent = s.artist + (s.creator ? ' · ' + s.creator : '');
      var chips = el.querySelector('.chips');

      if (!mania.length) {
        var d = document.createElement('span');
        if (s.lazy && !s._filled) {
          d.className = 'chip';
          d.textContent = '加载难度…';
          chips.appendChild(d);
        } else {
          d.className = 'chip';
          d.textContent = s._err ? ('难度获取失败：' + s._err) : '无 mania 难度';
          chips.appendChild(d);
        }
      } else {
        mania.slice(0, 10).forEach(function (m) {
          var c = document.createElement('button');
          c.className = 'chip hot';
          c.textContent = (m.keys ? m.keys + 'K ' : '') + (m.version || 'difficulty') + (m.star ? ' ★' + (Math.round(m.star * 10) / 10) : '');
          c.onclick = function () { runDownload(s, m.version, c); };
          chips.appendChild(c);
        });
        if (mania.length > 1) {
          var a = document.createElement('button');
          a.className = 'chip all';
          a.textContent = '全部 ' + mania.length + ' 个难度';
          a.onclick = function () { runDownload(s, null, a); };
          chips.appendChild(a);
        }
      }
      box.appendChild(el);
    });
  }

  async function runDownload(set, onlyVersion, btn) {
    var sm = $('#smsg');
    busy(btn, true, '下载中');
    try {
      msg(sm, '正在下载 ' + set.title + ' …', 'info');
      var buf = await fetchOsz(set.id, function (t) { msg(sm, t, 'info'); });
      msg(sm, '解包解析中…', 'info');
      var charts = await extractCharts(buf);
      var sel = charts;
      if (onlyVersion) {
        var f = charts.filter(function (c) { return c.version === onlyVersion; });
        if (f.length) sel = f;
      }
      await emit(sel, { set: set });
      msg(sm, '✅ 完成：' + sel.length + ' 个谱面已转换，往下看结果', 'ok');
    } catch (e) {
      msg(sm, '❌ ' + (e.message || e), 'err');
    } finally { busy(btn, false); }
  }

  /* ---------------- 搜索入口 ---------------- */
  var searching = false;
  async function doSearch() {
    if (searching) return;
    var q = ($('#q').value || '').trim();
    var sm = $('#smsg');
    if (!q) { msg(sm, '请输入关键词', 'warn'); return; }
    searching = true;
    var btn = $('#btnSearch');
    busy(btn, true, '搜索中');
    msg(sm, '正在查询多个 osu! 镜像…', 'info');
    $('#results').innerHTML = '';

    var jobs = [];
    if (S.cid && S.csec) jobs.push(officialSearch(q));
    S.src.forEach(function (src) {
      jobs.push(sourceSearch(src, q).then(function (arr) { return { name: src.name, arr: arr }; })
        .catch(function (e) { return { name: src.name, err: e.message || String(e) }; }));
    });

    var res = await Promise.all(jobs);
    var map = {}, order = [], ok = [], failed = [];
    res.forEach(function (r) {
      if (r.err) { failed.push(r.name + '×'); return; }
      var n = 0;
      (r.arr || []).forEach(function (s) {
        if (!s || !s.id) return;
        if (map[s.id]) {
          // 合并难度信息
          var t = map[s.id];
          s.maps.forEach(function (m) {
            var hit = t.maps.some(function (x) { return x.version === m.version; });
            if (!hit) t.maps.push(m);
          });
          return;
        }
        map[s.id] = s; order.push(s.id); n++;
      });
      ok.push(r.name + ' ' + (r.arr || []).length);
    });

    var sets = order.map(function (id) { return map[id]; });
    SEARCHED = sets;
    renderSets(sets);

    searching = false;
    busy(btn, false);

    var line = '共 ' + sets.length + ' 个谱面集（' + ok.join(' / ') + '）';
    if (failed.length) line += '\n失败：' + failed.join(' ');
    if (!sets.length) line = '没有搜索到结果。\n' + (failed.length ? '接口失败：' + failed.join(' ') + '\n' : '') + '可在「设置」里换镜像或开代理。';
    msg(sm, line, sets.length ? 'ok' : 'err');

    if (sets.length) {
      // sayobot 列表不带难度，后台限并发补齐（完成后自动重绘）
      fillAll(sets, 4).then(function () {
        var n = sets.filter(function (s) { return (s.maps || []).length; }).length;
        msg(sm, '共 ' + n + ' 个含 osu!mania 难度的谱面集（' + ok.join(' / ') + '）' + (failed.length ? '\n失败：' + failed.join(' ') : ''), 'ok');
      });
    }
  }

  /* ---------------- 本地文件 ---------------- */
  async function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var lm = $('#lmsg');
    var charts = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        if (/\.osu$/i.test(f.name)) {
          var ch = CORE.parseOsu(await f.text());
          if (ch.mode !== 3) { msg(lm, f.name + '：不是 mania 谱面（Mode=' + ch.mode + '）', 'warn'); continue; }
          ch.fileName = f.name; ch._zip = null;
          charts.push(ch);
          msg(lm, f.name + '：已解析 ' + ch.keys + 'K，' + ch.objects.length + ' 个对象', 'ok');
        } else if (/\.mc_?$/i.test(f.name)) {
          // 单个 Malody 谱面：.mc 为 JSON；.mc_ 可能套了一层 zip
          var mcText = await readMcPayload(await f.arrayBuffer());
          if (mcText == null) throw new Error('无法读取 Malody 谱面内容');
          var mch = CORE.parseMc(mcText);
          mch.fileName = f.name; mch._zip = null;
          charts.push(mch);
          msg(lm, f.name + '：已解析 Malody ' + mch.keys + 'K，' + mch.objects.length + ' 个音符', 'ok');
        } else {
          var buf = await f.arrayBuffer();
          var list = await extractCharts(buf);
          charts = charts.concat(list);
          msg(lm, f.name + '：解析到 ' + list.length + ' 个谱面', 'ok');
        }
      } catch (e) {
        msg(lm, f.name + '：❌ ' + (e.message || e), 'err');
      }
    }
    if (charts.length) {
      charts.forEach(function (c) { c._srcName = c._srcName || files[0].name; });
      await emit(charts, { local: true });
    }
  }

  /* ---------------- 绑定 UI ---------------- */
  function bind() {
    // tabs
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('.tab').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        $$('section[data-pane]').forEach(function (p) {
          p.hidden = p.getAttribute('data-pane') !== t.dataset.tab;
        });
      });
    });

    $('#btnSearch').addEventListener('click', doSearch);
    $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

    $('#q').addEventListener('input', function () {
      var q = $('#q').value;
      var a = $('#osuweb');
      if (a) a.href = q ? 'https://osu.ppy.sh/beatmapsets?q=' + encodeURIComponent(q) + '&m=3&s=any' : 'https://osu.ppy.sh/beatmapsets';
    });

    $('#btnById').addEventListener('click', async function () {
      var v = ($('#sid').value || '').trim();
      var m = /beatmapsets\/(\d+)/.exec(v) || /(\d{3,})/.exec(v);
      if (!m) return msg($('#smsg'), '没识别出谱面集 ID', 'warn');
      runDownload({ id: m[1], title: '谱面集 #' + m[1], artist: '', creator: '', cover: '', maps: [] }, null, this);
    });

    $('#file').addEventListener('change', function (e) { handleFiles(e.target.files); });

    // 设置
    $('#setSrc').value = S.src.map(function (s) { return s.name + '|' + s.url; }).join('\n');
    $('#setDl').value = (S.dl || []).join('\n');
    $('#setProxy').value = S.proxy || '';
    $('#setCid').value = S.cid || '';
    $('#setCsec').value = S.csec || '';

    $$('button[data-proxy]').forEach(function (b) {
      b.addEventListener('click', function () { $('#setProxy').value = b.dataset.proxy; });
    });

    $('#btnSave').addEventListener('click', function () {
      var src = $('#setSrc').value.split('\n').map(function (l) {
        l = l.trim();
        if (!l) return null;
        var i = l.indexOf('|');
        if (i < 0) return { name: l.replace(/^https?:\/\//, '').split('/')[0], url: l };
        return { name: l.slice(0, i).trim(), url: l.slice(i + 1).trim() };
      }).filter(Boolean);
      S.src = src.length ? src : clone(DEFAULT.src);
      S.dl = $('#setDl').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (!S.dl.length) S.dl = clone(DEFAULT.dl);
      S.proxy = $('#setProxy').value.trim();
      S.cid = $('#setCid').value.trim();
      S.csec = $('#setCsec').value.trim();
      TK = null;
      save();
      msg($('#setmsg'), '已保存', 'ok');
    });

    $('#btnReset').addEventListener('click', function () {
      S = clone(DEFAULT);
      save();
      $('#setSrc').value = S.src.map(function (s) { return s.name + '|' + s.url; }).join('\n');
      $('#setDl').value = S.dl.join('\n');
      $('#setProxy').value = '';
      $('#setCid').value = '';
      $('#setCsec').value = '';
      applyOpts(S.opt);
      msg($('#setmsg'), '已恢复默认', 'ok');
    });

    applyOpts(S.opt);

    if (!JSZ) {
      var w = document.createElement('div');
      w.className = 'msg err show';
      w.style.margin = '0 14px 12px';
      w.textContent = '⚠️ JSZip 未加载：请确认 lib/jszip.min.js 与 index.html 在同一目录（否则无法解包 .mcz/.osz）。';
      document.querySelector('.app').insertBefore(w, document.querySelector('.tabs'));
    }
    if (!CORE) {
      var w2 = document.createElement('div');
      w2.className = 'msg err show';
      w2.textContent = '⚠️ core.js 未加载，转换功能不可用。';
      document.querySelector('.app').insertBefore(w2, document.querySelector('.tabs'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 供自动化/调试使用：向页面直接喂 File 对象
  window.__phiDev = {
    handleFiles: function (files) { return handleFiles(files); },
    extractCharts: function (buf) { return extractCharts(buf); },
    emit: function (charts, meta) { return emit(charts, meta); },
    buildZip: function (ch, r) { return buildZip(ch, r); },
    OUTS: function () { return OUTS; }
  };
})();