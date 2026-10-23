/* core.js —— 纯逻辑：osu!mania (.osu) → Phigros PEC
 * 参考：Phigros Wiki / PEC 与官谱JSON 格式说明
 *   PEC: 首行 175；bp/cp/ca/cv 事件；n1 Tap, n2 Hold, n3 Flick, n4 Drag
 *        拍数(beat) 以四分音符为一拍，x 坐标范围 ±1024
 */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function F(n, d) {
    var p = Math.pow(10, d), v = Math.round((+n || 0) * p) / p;
    if (!isFinite(v)) v = 0;
    return v.toFixed(d);
  }

  /* ---------------- 解析 .osu ---------------- */
  function parseOsu(text) {
    if (typeof text !== 'string') throw new Error('谱面内容为空');
    text = text.replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/);
    var section = '', general = {}, meta = {}, diff = {}, events = [], timing = [], objects = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('//') === 0) continue;
      if (line.charAt(0) === '[' && line.charAt(line.length - 1) === ']') { section = line.slice(1, -1); continue; }

      if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
        var k = line.indexOf(':');
        if (k > 0) {
          var key = line.slice(0, k).trim(), val = line.slice(k + 1).trim();
          (section === 'General' ? general : section === 'Metadata' ? meta : diff)[key] = val;
        }
      } else if (section === 'Events') {
        events.push(line);
      } else if (section === 'TimingPoints') {
        var tp = line.split(',');
        if (tp.length >= 2) {
          var t = {
            time: num(tp[0]),
            beatLength: num(tp[1]),
            meter: num(tp[2], 4),
            uninherited: tp.length >= 7 ? (num(tp[6], 1) !== 0) : true
          };
          if (isFinite(t.time)) timing.push(t);
        }
      } else if (section === 'HitObjects') {
        var p = line.split(',');
        if (p.length < 5) continue;
        var o = { x: num(p[0]), y: num(p[1]), time: num(p[2]), type: Math.round(num(p[3])), hs: Math.round(num(p[4])) };
        if (o.type & 128) { var ep = String(p[5] || '').split(':'); o.endTime = num(ep[0], NaN); }
        objects.push(o);
      }
    }

    var audio = general.AudioFilename || '';
    var bg = '';
    for (var j = 0; j < events.length; j++) {
      var m = /^\d+\s*,\s*\d+\s*,\s*"([^"]+)"/.exec(events[j]);
      if (m) { bg = m[1]; break; }
    }

    var mode = Math.round(num(general.Mode, 0));
    var keys = clamp(Math.round(num(diff.CircleSize, 4)) || 4, 1, 18);

    return {
      general: general, meta: meta, diff: diff, events: events, timing: timing, objects: objects,
      mode: mode, keys: keys, audio: audio, bg: bg,
      title: meta.Title || '', artist: meta.Artist || '', creator: meta.Creator || '',
      version: meta.Version || '', source: meta.Source || ''
    };
  }

  /* ---------------- 解析 .mc（Malody，JSON 格式） ---------------- */
  function mcBeat(b) {
    if (b == null) return NaN;
    if (typeof b === 'number') return b;
    var a = num(b[0]), n = num(b[1]), d = num(b[2], 1);
    return a + (d ? n / d : 0);
  }

  function parseMc(text) {
    if (typeof text !== 'string') throw new Error('谱面内容为空');
    var t = text.replace(/^\uFEFF/, '').trim();
    if (t.charAt(0) !== '{') throw new Error('不是 Malody JSON 谱面（旧版纯文本 .mc 暂不支持）');
    var j;
    try { j = JSON.parse(t); } catch (e) { throw new Error('Malody 谱面 JSON 解析失败'); }

    var meta = j.meta || {};
    var mode = Math.round(num(meta.mode, 0));
    if (mode !== 0) throw new Error('Malody mode ' + mode + ' 不是 Key 模式（只支持 mode:0 的 4K/6K 等键谱）');
    var ext = meta.mode_ext || {};
    var song = meta.song || {};
    var noteArr = j.note || [];

    // 键数：优先 mode_ext.column，缺失则用最大列号 +1
    var keys = Math.round(num(ext.column, 0));
    if (!(keys > 0)) {
      var maxCol = -1;
      for (var q = 0; q < noteArr.length; q++) {
        if (noteArr[q] && noteArr[q].column != null) maxCol = Math.max(maxCol, Math.round(num(noteArr[q].column, 0)));
      }
      keys = maxCol + 1;
    }
    keys = clamp(keys || 4, 1, 18);

    // BPM 段：beat → ms（音频 beat0 = 0ms）
    var raw = [];
    for (var i = 0; i < (j.time || []).length; i++) {
      var p = j.time[i], bb = mcBeat(p.beat), bpm = num(p.bpm, 0);
      if (isFinite(bb) && bpm > 0) raw.push({ beat: bb, bpm: bpm });
    }
    raw.sort(function (a, b) { return a.beat - b.beat; });
    if (!raw.length) raw.push({ beat: 0, bpm: 120 });

    var segs = [{ beat: raw[0].beat, ms: 0, bpm: raw[0].bpm }];
    for (i = 1; i < raw.length; i++) {
      var prev = segs[segs.length - 1];
      if (Math.abs(raw[i].bpm - prev.bpm) < 1e-9) continue;
      segs.push({ beat: raw[i].beat, ms: prev.ms + (raw[i].beat - prev.beat) * 60000 / prev.bpm, bpm: raw[i].bpm });
    }
    function msOf(beat) {
      var s = segs[0];
      if (beat <= s.beat) return (beat - s.beat) * 60000 / s.bpm;
      for (var k = 1; k < segs.length; k++) {
        if (segs[k].beat <= beat + 1e-9) s = segs[k]; else break;
      }
      return s.ms + (beat - s.beat) * 60000 / s.bpm;
    }

    var objects = [], audio = '', audioOffset = 0;
    for (i = 0; i < noteArr.length; i++) {
      var o = noteArr[i];
      if (o == null) continue;
      if (o.column == null) {
        // 音效 / BGM 轨（type:1）：不进谱面，但能拿到音频文件名与整体延迟
        if (!audio && o.sound) { audio = String(o.sound); audioOffset = num(o.offset, 0); }
        continue;
      }
      var col = clamp(Math.round(num(o.column, 0)), 0, keys - 1);
      var b0 = mcBeat(o.beat);
      if (!isFinite(b0)) continue;
      var t0 = msOf(b0) + audioOffset;
      var note = {
        column: col,
        x: (col + 0.5) * 512 / keys,   // buildPec 用 floor(x*keys/512) 还原列号
        y: 192, time: t0, type: 1, hs: 0
      };
      if (o.endbeat != null) {
        var b1 = mcBeat(o.endbeat);
        if (isFinite(b1) && b1 > b0) {
          note.type = 1 | 128;
          note.endTime = msOf(b1) + audioOffset;
        }
      }
      objects.push(note);
    }
    if (!objects.length) throw new Error('Malody 谱面里没有音符');

    var timing = [];
    for (i = 0; i < segs.length; i++) {
      timing.push({ time: segs[i].ms, beatLength: 60000 / segs[i].bpm, meter: 4, uninherited: true });
    }

    return {
      game: 'malody',
      meta: meta, mode: mode, keys: keys,
      audio: audio, bg: meta.background || '',
      timing: timing, objects: objects,
      title: song.title || song.titleorg || '', artist: song.artist || song.artistorg || '',
      creator: meta.creator || '', version: meta.version || '', source: ''
    };
  }

  /* ---------------- 时间(ms) → 拍数 ---------------- */
  function buildBeatMapper(timing) {
    var tps = [], i;
    for (i = 0; i < timing.length; i++) {
      var t = timing[i];
      if (t.uninherited && isFinite(t.beatLength) && t.beatLength > 0) tps.push(t);
    }
    tps.sort(function (a, b) { return a.time - b.time; });

    var dedup = [];
    for (i = 0; i < tps.length; i++) {
      var last = dedup[dedup.length - 1];
      if (last && Math.abs(last.time - tps[i].time) < 1e-6) dedup[dedup.length - 1] = tps[i];
      else dedup.push(tps[i]);
    }
    if (!dedup.length) dedup.push({ time: 0, beatLength: 500 });

    // 以音频 t=0 为拍 0，用第一个 BPM 向前延伸，保证不会出现负拍
    var segs = [{ startMs: 0, bpm: 60000 / dedup[0].beatLength, startBeat: 0 }];
    for (i = 0; i < dedup.length; i++) {
      var cur = dedup[i];
      if (cur.time <= 0) continue;
      var prev = segs[segs.length - 1];
      var bpm = 60000 / cur.beatLength;
      if (Math.abs(bpm - prev.bpm) < 1e-9) continue;
      var beat = prev.startBeat + (cur.time - prev.startMs) * prev.bpm / 60000;
      segs.push({ startMs: cur.time, bpm: bpm, startBeat: beat });
    }

    function beatOf(ms) {
      var seg = segs[0];
      for (var j = 0; j < segs.length; j++) { if (segs[j].startMs <= ms) seg = segs[j]; else break; }
      return seg.startBeat + (ms - seg.startMs) * seg.bpm / 60000;
    }
    function msOf(beat) {
      var seg = segs[0];
      for (var j = 0; j < segs.length; j++) { if (segs[j].startBeat <= beat) seg = segs[j]; else break; }
      return seg.startMs + (beat - seg.startBeat) * 60000 / seg.bpm;
    }
    return { beatOf: beatOf, msOf: msOf, segs: segs, baseBpm: segs[0].bpm };
  }

  /* ---------------- 转换主函数 ---------------- */
  function buildPec(chart, opt) {
    opt = opt || {};
    var keys = chart.keys || 4;
    var spread = num(opt.spread, 0.75);          // 键盘占屏宽比例 (0.3~1)
    var lineY = num(opt.lineY, 700);             // 判定线纵坐标 0~1400
    var speed = num(opt.speed, 8.5);             // PEC 流速
    var offMs = num(opt.offsetMs, 0);            // 正值=谱面提前
    var finishToFlick = !!opt.finishToFlick;     // hitsound:finish → Flick
    var longAsHold = opt.longAsDrag ? false : true;

    var laneW = 2 * 1024 * spread / keys;
    var center = (keys - 1) / 2;
    var bm = buildBeatMapper(chart.timing);

    var notes = [], stat = { tap: 0, drag: 0, hold: 0, flick: 0 };
    var minMs = Infinity, maxMs = -Infinity, dropped = 0;

    for (var i = 0; i < chart.objects.length; i++) {
      var o = chart.objects[i];
      if (!isFinite(o.time)) { dropped++; continue; }
      var col = clamp(Math.floor(o.x * keys / 512), 0, keys - 1);
      var x = (col - center) * laneW;
      var t = o.time - offMs;
      var beat = bm.beatOf(t);

      if (o.type & 128) { // Hold
        var et = isFinite(o.endTime) ? (o.endTime - offMs) : (t + 100);
        var beat2 = bm.beatOf(et);
        if (!(beat2 > beat)) beat2 = beat + 0.25;
        if (longAsHold) { notes.push({ k: 2, b: beat, b2: beat2, x: x }); stat.hold++; maxMs = Math.max(maxMs, et); }
        else { notes.push({ k: 4, b: beat, x: x }); stat.drag++; }
      } else {
        var flick = finishToFlick && (o.hs & 4);
        notes.push({ k: flick ? 3 : 1, b: beat, x: x });
        if (flick) stat.flick++; else stat.tap++;
      }
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    }

    notes.sort(function (a, b) { return a.b - b.b || a.x - b.x; });

    var out = [];
    out.push('175');
    for (var s = 0; s < bm.segs.length; s++) {
      out.push('bp ' + F(bm.segs[s].startBeat, 3) + ' ' + F(bm.segs[s].bpm, 3));
    }
    out.push('cp 0 0.000 1024.00 ' + F(lineY, 2));
    out.push('ca 0 0.000 255');
    out.push('cv 0 0.000 ' + F(speed, 3));

    for (var n = 0; n < notes.length; n++) {
      var nt = notes[n];
      if (nt.k === 2) out.push('n2 0 ' + F(nt.b, 3) + ' ' + F(nt.b2, 3) + ' ' + F(nt.x, 2) + ' 1 0');
      else out.push('n' + nt.k + ' 0 ' + F(nt.b, 3) + ' ' + F(nt.x, 2) + ' 1 0');
      out.push('# 1.000');
      out.push('& 1.00');
    }

    var durationMs = (isFinite(minMs) && isFinite(maxMs)) ? Math.max(0, maxMs - minMs) : 0;
    var total = notes.length;
    var nps = durationMs > 0 ? total / (durationMs / 1000) : 0;

    return {
      pec: out.join('\n') + '\n',
      stat: stat, keys: keys, noteCount: total, dropped: dropped,
      bpm: bm.baseBpm, bpmList: bm.segs.map(function (x) { return Math.round(x.bpm * 1000) / 1000; }),
      durationMs: durationMs, firstMs: isFinite(minMs) ? minMs : 0,
      nps: Math.round(nps * 100) / 100,
      suggestLevel: estimateLevel(nps, keys, total, num(opt.star, 0))
    };
  }

  /* 有 osu! 星级就用星级标定（更贴近实际难度），没有就退回 NPS 估算 */
  function estimateLevel(nps, keys, total, star) {
    if (!total) return 1;
    var d;
    if (star > 0) {
      d = 4.0 + 2.0 * star;
      if (keys >= 7) d += 0.2;
      return Math.round(clamp(d, 1, 16.5) * 10) / 10;
    }
    // 以 NPS 为主的对数标定（2 → ~9，6 → ~13.4，12 → ~16），再按谱面长度微调
    d = 6.2 + 2.75 * (Math.log(Math.max(0.5, nps)) / Math.LN2);
    if (total < 150) d -= 1.2; else if (total < 300) d -= 0.5;
    if (keys >= 7) d += 0.3;
    if (keys >= 10) d += 0.3;
    return Math.round(clamp(d, 1, 16.5) * 10) / 10;
  }

  /* ---------------- info.yml (Phira) ---------------- */
  function yq(s) {
    return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
  }
  function makeInfoYml(o) {
    o = o || {};
    var lines = [
      'name: ' + yq(o.name || 'Untitled'),
      'difficulty: ' + (isFinite(o.difficulty) ? o.difficulty : 12),
      'level: ' + yq(String(o.level == null ? '' : o.level)),
      'charter: ' + yq(o.charter || ''),
      'composer: ' + yq(o.composer || ''),
      'illustrator: ' + yq(o.illustrator || ''),
      'chart: ' + yq(o.chart || 'chart.pec'),
      'music: ' + yq(o.music || 'music.mp3'),
      'illustration: ' + yq(o.illustration || ''),
      'offset: ' + (isFinite(o.offset) ? o.offset : 0),
      'tip: ' + yq(o.tip || ''),
      'tags: []',
      'intro: ' + yq(o.intro || '')
    ];
    return lines.join('\n') + '\n';
  }

  var api = {
    parseOsu: parseOsu, parseMc: parseMc, buildBeatMapper: buildBeatMapper, buildPec: buildPec,
    makeInfoYml: makeInfoYml, estimateLevel: estimateLevel, F: F, clamp: clamp
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PHICORE = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* core end */

