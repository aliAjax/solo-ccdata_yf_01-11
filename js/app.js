/* Pixel Loom 脚本工作台 —— 应用主逻辑（无后端，状态存 localStorage）。 */
(function () {
  'use strict';
  const W = 16, H = 16, EMPTY = '';
  const LS_KEY = 'pixelLoom.workbench.v1';
  const APP_TAG = 'pixel-loom-script-workbench';
  const PALETTE = ['#ff7aa8', '#77e1ba', '#ffd166', '#6a8cff', '#b18cff', '#ffffff', '#f97316', '#39c5cf'];
  const TOOL_NAMES = { brush: '画笔', fill: '填充', move: '选区移动', eraser: '橡皮', picker: '取色' };
  const STEP_NAMES = { brush: '画笔', fill: '填充', move: '选区移动', script: '子脚本' };
  const MODE_NAMES = { forward: '正向', reverse: '反向', mirror: '镜像' };

  const $ = s => document.querySelector(s);
  const E = window.Engine;

  /* ---------------- 状态 ---------------- */
  let idSeq = 1;
  const uid = p => p + (idSeq++);
  const blankPixels = () => Array(W * H).fill(EMPTY);

  function newScript(name) {
    return { id: uid('s'), name, mode: 'forward', range: { start: 1, end: state ? state.frames.length : 1 }, steps: [] };
  }
  function freshState() {
    return {
      frames: [{ pixels: blankPixels() }],
      currentFrame: 0,
      color: PALETTE[0],
      tool: 'brush',
      zoom: 20,
      grid: true,
      recording: false,
      scripts: [],
      activeScriptId: null,
      selection: null,   // {x,y,w,h}
      cursor: { x: 0, y: 0 },
    };
  }
  let state = freshState();
  state.scripts = [newScript('脚本 1')];
  state.activeScriptId = state.scripts[0].id;

  let undoStack = [], redoStack = [];
  const activeScript = () => state.scripts.find(s => s.id === state.activeScriptId) || null;
  const curPixels = () => state.frames[state.currentFrame].pixels;

  /* ---------------- 撤销 / 重做（一次批量应用 = 一条记录） ---------------- */
  function commitFrames(label, changes) {
    undoStack.push({ label, changes, frame: state.currentFrame });
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    syncUndoButtons();
    autosave();
  }
  function applyChangeSet(entry, key) {
    for (const c of entry.changes) state.frames[c.frame].pixels = c[key].slice();
    state.currentFrame = Math.min(entry.frame, state.frames.length - 1);
  }
  function doUndo() {
    const e = undoStack.pop();
    if (!e) { setStatus('没有可撤销的操作', false); return; }
    redoStack.push(e);
    applyChangeSet(e, 'before');
    setStatus('已撤销：' + e.label, true);
    syncUndoButtons(); renderAll(); autosave();
  }
  function doRedo() {
    const e = redoStack.pop();
    if (!e) { setStatus('没有可重做的操作', false); return; }
    undoStack.push(e);
    applyChangeSet(e, 'after');
    setStatus('已重做：' + e.label, true);
    syncUndoButtons(); renderAll(); autosave();
  }
  function syncUndoButtons() {
    $('#undoBtn').disabled = !undoStack.length;
    $('#redoBtn').disabled = !redoStack.length;
  }

  /* ---------------- 脚本批量执行（预览 / 应用共用一条路径） ----------------
   * 始终在帧副本上计算；commit=true 时成功后一次性换入并记 1 条撤销，
   * 任一步骤失败则丢弃全部副本 —— 整批回滚，不留半残状态。 */
  function executeScript(script, { commit }) {
    const errors = E.validateScript(state, script);
    if (errors.length) return { ok: false, errors };
    let seq;
    try { seq = E.frameSequence(script.range, script.mode, state.frames.length); }
    catch (err) { return { ok: false, errors: [err.message] } }

    const work = state.frames.map(f => f.pixels.slice());
    const ctx = { scriptsById: E.scriptMap(state.scripts), stack: [script.id] };
    const results = [];
    try {
      for (const f of seq) {
        const pix = work[f - 1];
        for (const st of script.steps) E.applyStep(pix, W, H, st, ctx);
        results.push({ frame: f, pixels: pix.slice() });
      }
    } catch (err) {
      return { ok: false, errors: [err.message], partial: results };
    }
    if (commit) {
      const affected = [...new Set(seq)];
      const changes = affected.map(i => ({
        frame: i - 1,
        before: state.frames[i - 1].pixels.slice(),
        after: work[i - 1].slice(),
      }));
      for (const i of affected) state.frames[i - 1].pixels = work[i - 1];
      commitFrames(`应用脚本「${script.name}」（${seq.length} 次落帧）`, changes);
    }
    return { ok: true, seq, results };
  }

  /* ---------------- 画布渲染 ---------------- */
  const canvas = $('#canvas');
  const ctx2d = canvas.getContext('2d');
  let moveDrag = null; // {region, dx, dy, ghost:[...]}

  function renderCanvas() {
    const z = state.zoom;
    canvas.width = W * z; canvas.height = H * z;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    ctx2d.fillStyle = '#191d29';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    const pix = curPixels();
    const skip = moveDrag ? moveDrag.region : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (skip && x >= skip.x && x < skip.x + skip.w && y >= skip.y && y < skip.y + skip.h) continue;
      const c = pix[y * W + x];
      if (c !== EMPTY) { ctx2d.fillStyle = c; ctx2d.fillRect(x * z, y * z, z, z); }
    }
    if (moveDrag) { // 浮动中的选区内容
      const r = moveDrag.region;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const c = moveDrag.ghost[y * r.w + x];
        if (c === EMPTY) continue;
        const nx = r.x + moveDrag.dx + x, ny = r.y + moveDrag.dy + y;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        ctx2d.fillStyle = c;
        ctx2d.fillRect(nx * z, ny * z, z, z);
      }
    }
    if (state.grid && z >= 6) {
      ctx2d.strokeStyle = 'rgba(255,255,255,.06)';
      ctx2d.lineWidth = 1;
      for (let i = 1; i < W; i++) { ctx2d.beginPath(); ctx2d.moveTo(i * z + .5, 0); ctx2d.lineTo(i * z + .5, H * z); ctx2d.stroke(); }
      for (let i = 1; i < H; i++) { ctx2d.beginPath(); ctx2d.moveTo(0, i * z + .5); ctx2d.lineTo(W * z, i * z + .5); ctx2d.stroke(); }
    }
    if (state.selection) {
      const r = state.selection;
      ctx2d.strokeStyle = '#77e1ba';
      ctx2d.setLineDash([4, 3]);
      ctx2d.lineWidth = 2;
      ctx2d.strokeRect(r.x * z + 1, r.y * z + 1, r.w * z - 2, r.h * z - 2);
      ctx2d.setLineDash([]);
    }
    // 键盘光标
    ctx2d.strokeStyle = '#ff7aa8';
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(state.cursor.x * z + 1, state.cursor.y * z + 1, z - 2, z - 2);
  }

  function thumbCanvas(pixels, size) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.style.width = c.style.height = size + 'px';
    const q = c.getContext('2d');
    q.fillStyle = '#191d29'; q.fillRect(0, 0, W, H);
    pixels.forEach((v, i) => { if (v !== EMPTY) { q.fillStyle = v; q.fillRect(i % W, (i / W) | 0, 1, 1); } });
    return c;
  }

  function renderFrames() {
    const box = $('#frames');
    box.innerHTML = '';
    state.frames.forEach((f, i) => {
      const d = document.createElement('button');
      d.className = 'frame' + (i === state.currentFrame ? ' active' : '');
      d.type = 'button';
      d.title = `帧 ${i + 1}`;
      d.append(thumbCanvas(f.pixels, 44));
      const lab = document.createElement('span');
      lab.textContent = i + 1;
      d.append(lab);
      d.addEventListener('click', () => { state.currentFrame = i; state.selection = null; renderAll(); });
      box.append(d);
    });
    $('#frameInfo').textContent = `帧 ${state.currentFrame + 1} / ${state.frames.length}`;
  }

  /* ---------------- 脚本面板 ---------------- */
  function renderScripts() {
    const sel = $('#scriptSelect');
    sel.innerHTML = '';
    for (const s of state.scripts) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      sel.append(o);
    }
    const sc = activeScript();
    sel.value = sc ? sc.id : '';
    $('#recordBtn').classList.toggle('on', state.recording);
    $('#recordBtn').textContent = state.recording ? '● 录制中…点击停止' : '○ 开始录制';
    if (sc) {
      $('#rangeStart').value = sc.range.start;
      $('#rangeEnd').value = sc.range.end;
      $('#playMode').value = sc.mode;
    }
    renderSteps();
  }

  function renderSteps() {
    const sc = activeScript();
    const box = $('#stepsList');
    box.innerHTML = '';
    if (!sc) return;
    if (!sc.steps.length) {
      box.innerHTML = '<p class="hint">暂无步骤：开启录制后在画布上作画，或手动添加步骤。</p>';
      return;
    }
    sc.steps.forEach((st, idx) => {
      const row = document.createElement('div');
      row.className = 'step';
      row.dataset.id = st.id;
      const head = document.createElement('div');
      head.className = 'step-head';
      head.innerHTML = `<span class="step-type">${idx + 1}. ${STEP_NAMES[st.type] || st.type}</span>`;
      const acts = document.createElement('span');
      acts.className = 'step-acts';
      for (const [act, label, title] of [['up', '↑', '上移'], ['down', '↓', '下移'], ['del', '✕', '删除']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title; b.dataset.act = act;
        acts.append(b);
      }
      head.append(acts);
      row.append(head);
      const body = document.createElement('div');
      body.className = 'step-body';
      if (st.type === 'brush') {
        body.append(
          field('颜色', input('color', st.color, 'color')),
          field('坐标点', input('text', st.points.map(p => `${p.x},${p.y}`).join('; '), 'points', 'x,y; x,y; …'))
        );
      } else if (st.type === 'fill') {
        body.append(
          field('颜色', input('color', st.color, 'color')),
          field('起点 X', input('number', st.x, 'x')),
          field('起点 Y', input('number', st.y, 'y'))
        );
      } else if (st.type === 'move') {
        body.append(
          field('区域 X', input('number', st.region.x, 'rx')),
          field('区域 Y', input('number', st.region.y, 'ry')),
          field('宽', input('number', st.region.w, 'rw')),
          field('高', input('number', st.region.h, 'rh')),
          field('位移 dx', input('number', st.dx, 'dx')),
          field('位移 dy', input('number', st.dy, 'dy'))
        );
      } else if (st.type === 'script') {
        const s = document.createElement('select');
        s.dataset.field = 'scriptId';
        for (const o of state.scripts) {
          if (o.id === sc.id) continue;
          const op = document.createElement('option');
          op.value = o.id; op.textContent = o.name;
          s.append(op);
        }
        s.value = st.scriptId;
        body.append(field('引用脚本', s));
      }
      row.append(body);
      box.append(row);
    });
  }
  function field(label, el) {
    const l = document.createElement('label');
    l.className = 'fld';
    const sp = document.createElement('span');
    sp.textContent = label;
    l.append(sp, el);
    return l;
  }
  function input(type, value, f, ph) {
    const i = document.createElement('input');
    i.type = type; i.value = value; i.dataset.field = f;
    if (ph) i.placeholder = ph;
    return i;
  }

  function parsePoints(text) {
    const pts = [];
    for (const seg of String(text).split(/[;；\n]+/)) {
      const t = seg.trim();
      if (!t) continue;
      const m = t.split(/[,，\s]+/).map(Number);
      if (m.length !== 2 || !m.every(Number.isInteger)) return null;
      pts.push({ x: m[0], y: m[1] });
    }
    return pts;
  }

  function mutateScript() { renderSteps(); autosave(); }

  /* 添加嵌套引用前的循环预检：target 能回到 script 即成环 */
  function wouldCycle(scriptId, targetId) {
    return scriptId === targetId || E.reaches(state.scripts, targetId, scriptId);
  }

  function addStep(type) {
    const sc = activeScript();
    if (!sc) return;
    let st = null;
    if (type === 'brush') st = { type, color: state.color, points: [{ x: 0, y: 0 }] };
    else if (type === 'fill') st = { type, color: state.color, x: 0, y: 0 };
    else if (type === 'move') st = { type, region: { x: 0, y: 0, w: 2, h: 2 }, dx: 1, dy: 0 };
    else if (type === 'script') {
      const other = state.scripts.find(s => s.id !== sc.id);
      if (!other) { setStatus('没有其他脚本可嵌套：请先新建一个脚本', false); return; }
      if (wouldCycle(sc.id, other.id)) { setStatus(`已阻止：嵌套「${other.name}」会形成循环依赖`, false); return; }
      st = { type, scriptId: other.id };
    }
    if (!st) return;
    st.id = uid('st');
    sc.steps.push(st);
    mutateScript();
    setStatus(`已添加步骤：${STEP_NAMES[type]}`, true);
  }

  /* ---------------- 预览 / 应用 ---------------- */
  function doPreview() {
    const sc = activeScript();
    if (!sc) return;
    const res = executeScript(sc, { commit: false });
    const strip = $('#previewStrip');
    strip.innerHTML = '';
    const list = res.ok ? res.results : (res.partial || []);
    const seen = {};
    list.forEach(r => {
      seen[r.frame] = (seen[r.frame] || 0) + 1;
      const d = document.createElement('div');
      d.className = 'pv';
      d.append(thumbCanvas(r.pixels, 40));
      const lab = document.createElement('span');
      lab.textContent = `帧 ${r.frame}` + (seen[r.frame] > 1 ? ` ·第${seen[r.frame]}次` : '');
      d.append(lab);
      strip.append(d);
    });
    if (!res.ok) {
      const bad = document.createElement('div');
      bad.className = 'pv bad';
      bad.textContent = '✕ 失败';
      strip.append(bad);
      setStatus('预览失败：' + res.errors[0], false);
      return;
    }
    setStatus(`预览就绪：${MODE_NAMES[sc.mode]}序列 ${res.seq.join(' → ')}（未改动画布）`, true);
  }

  function doApply() {
    const sc = activeScript();
    if (!sc) return;
    const res = executeScript(sc, { commit: true });
    if (!res.ok) {
      setStatus('应用失败，已整批回滚：' + res.errors.join('；'), false);
      renderAll();
      return;
    }
    setStatus(`已应用「${sc.name}」：${MODE_NAMES[sc.mode]}序列 ${res.seq.join(' → ')}，占用 1 次撤销`, true);
    renderAll();
  }

  /* ---------------- 画布交互 ---------------- */
  let stroke = null;      // {before, color, points:[], seen:Set}
  let selDrag = null;     // 框选 {ax, ay}
  let moveStart = null;   // 移动 {x, y}

  function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - r.left) / r.width * W),
      y: Math.floor((e.clientY - r.top) / r.height * H),
    };
  }
  function paintCell(x, y, color) {
    if (!E.inBounds(x, y, W, H)) return;
    const pix = curPixels();
    if (pix[y * W + x] === color) return;
    pix[y * W + x] = color;
    const key = x + ',' + y;
    if (!stroke.seen.has(key)) { stroke.seen.add(key); stroke.points.push({ x, y }); }
  }
  function lineCells(a, b) {
    const pts = [];
    let { x: x0, y: y0 } = a; const { x: x1, y: y1 } = b;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      pts.push({ x: x0, y: y0 });
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return pts;
  }
  function recordStep(st) {
    const sc = activeScript();
    if (!sc) return;
    st.id = uid('st');
    sc.steps.push(st);
    mutateScript();
    setStatus(`已录制步骤：${STEP_NAMES[st.type]}（共 ${sc.steps.length} 步）`, true);
  }
  function beginStroke(cell) {
    stroke = { before: curPixels().slice(), color: state.tool === 'eraser' ? EMPTY : state.color, points: [], seen: new Set(), last: cell };
    paintCell(cell.x, cell.y, stroke.color);
    renderCanvas();
  }
  function endStroke() {
    if (!stroke) return;
    const after = curPixels().slice();
    if (stroke.points.length) {
      commitFrames(TOOL_NAMES[state.tool] || '绘制', [{ frame: state.currentFrame, before: stroke.before, after }]);
      if (state.recording) recordStep({ type: 'brush', color: stroke.color, points: stroke.points.slice() });
    }
    stroke = null;
  }
  function doFillAt(cell) {
    if (!E.inBounds(cell.x, cell.y, W, H)) return;
    const before = curPixels().slice();
    E.floodFill(curPixels(), W, H, cell.x, cell.y, state.color);
    const after = curPixels().slice();
    if (before.some((v, i) => v !== after[i])) {
      commitFrames('填充', [{ frame: state.currentFrame, before, after }]);
      if (state.recording) recordStep({ type: 'fill', color: state.color, x: cell.x, y: cell.y });
    }
    renderCanvas();
  }
  function normRect(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
  }
  const inSel = c => state.selection &&
    c.x >= state.selection.x && c.x < state.selection.x + state.selection.w &&
    c.y >= state.selection.y && c.y < state.selection.y + state.selection.h;

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const cell = cellFromEvent(e);
    if (state.tool === 'brush' || state.tool === 'eraser') beginStroke(cell);
    else if (state.tool === 'fill') doFillAt(cell);
    else if (state.tool === 'picker') {
      if (E.inBounds(cell.x, cell.y, W, H)) {
        const c = curPixels()[cell.y * W + cell.x];
        if (c !== EMPTY) { state.color = c; $('#customColor').value = c; renderSwatches(); setStatus('已取色 ' + c, true); }
      }
    } else if (state.tool === 'move') {
      if (inSel(cell)) {
        const r = state.selection;
        const ghost = [];
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) ghost.push(curPixels()[(r.y + y) * W + (r.x + x)]);
        moveStart = cell;
        moveDrag = { region: r, dx: 0, dy: 0, ghost };
      } else {
        state.selection = null;
        selDrag = { ax: cell.x, ay: cell.y };
      }
      renderCanvas();
    }
  });
  canvas.addEventListener('pointermove', e => {
    const cell = cellFromEvent(e);
    if (stroke) {
      for (const p of lineCells(stroke.last, cell)) paintCell(p.x, p.y, stroke.color);
      stroke.last = cell;
      renderCanvas();
    } else if (selDrag) {
      state.selection = normRect({ x: selDrag.ax, y: selDrag.ay }, {
        x: Math.max(0, Math.min(W - 1, cell.x)),
        y: Math.max(0, Math.min(H - 1, cell.y)),
      });
      renderCanvas();
    } else if (moveDrag) {
      // 钳制在画布内：拖动不裁剪、不丢弃像素，与步骤执行规则一致
      const r = moveDrag.region;
      moveDrag.dx = Math.max(-r.x, Math.min(W - r.x - r.w, cell.x - moveStart.x));
      moveDrag.dy = Math.max(-r.y, Math.min(H - r.y - r.h, cell.y - moveStart.y));
      renderCanvas();
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (stroke) endStroke();
    else if (selDrag) selDrag = null;
    else if (moveDrag) {
      const { region, dx, dy } = moveDrag;
      moveDrag = null;
      if (dx || dy) {
        const before = curPixels().slice();
        E.moveRegion(curPixels(), W, H, region, dx, dy);
        commitFrames('选区移动', [{ frame: state.currentFrame, before, after: curPixels().slice() }]);
        if (state.recording) recordStep({ type: 'move', region: { ...region }, dx, dy });
      }
      state.selection = null;
      renderCanvas();
    }
  });
  canvas.addEventListener('pointercancel', () => { stroke = null; selDrag = null; moveDrag = null; renderCanvas(); });

  /* ---------------- 工具 / 颜色 ---------------- */
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    setStatus('当前工具：' + TOOL_NAMES[t], true);
  }
  function renderSwatches() {
    const box = $('#swatches');
    box.innerHTML = '';
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw' + (c === state.color ? ' sel' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => { state.color = c; $('#customColor').value = c; renderSwatches(); });
      box.append(b);
    }
  }

  /* ---------------- 帧操作 ---------------- */
  function addFrame(dup) {
    const px = dup ? curPixels().slice() : blankPixels();
    state.frames.splice(state.currentFrame + 1, 0, { pixels: px });
    state.currentFrame++;
    renderAll(); autosave();
    setStatus(dup ? '已复制当前帧' : '已新建空白帧', true);
  }
  function delFrame() {
    if (state.frames.length <= 1) { setStatus('至少保留 1 帧', false); return; }
    state.frames.splice(state.currentFrame, 1);
    state.currentFrame = Math.min(state.currentFrame, state.frames.length - 1);
    renderAll(); autosave();
    setStatus('已删除帧', true);
  }

  /* ---------------- 持久化 / 导入导出 ---------------- */
  function serialize() {
    return {
      app: APP_TAG, version: 1,
      doc: {
        width: W, height: H,
        frames: state.frames.map(f => f.pixels.slice()),
        currentFrame: state.currentFrame,
        color: state.color,
        zoom: state.zoom,
        grid: state.grid,
        scripts: JSON.parse(JSON.stringify(state.scripts)),
        activeScriptId: state.activeScriptId,
        idSeq,
      },
    };
  }
  function normalizeProject(raw) {
    if (!raw || raw.app !== APP_TAG || !raw.doc) throw new Error('文件格式不符（缺少应用标识）');
    const d = raw.doc;
    if (d.width !== W || d.height !== H) throw new Error(`画布尺寸不符（需要 ${W}×${H}）`);
    if (!Array.isArray(d.frames) || !d.frames.length) throw new Error('帧数据缺失');
    const frames = d.frames.map(px => {
      if (!Array.isArray(px) || px.length !== W * H) throw new Error('帧像素数据损坏');
      return { pixels: px.map(v => (typeof v === 'string' ? v : EMPTY)) };
    });
    const scripts = [];
    for (const s of d.scripts || []) {
      if (!s || typeof s.id !== 'string') continue;
      const sc = {
        id: s.id,
        name: typeof s.name === 'string' ? s.name : s.id,
        mode: E.PLAY_MODES.includes(s.mode) ? s.mode : 'forward',
        range: {
          start: Math.max(1, Math.min(frames.length, s.range && s.range.start | 0 || 1)),
          end: Math.max(1, Math.min(frames.length, s.range && s.range.end | 0 || 1)),
        },
        steps: [],
      };
      if (sc.range.end < sc.range.start) sc.range.end = sc.range.start;
      for (const st of s.steps || []) {
        if (!st || !E.STEP_TYPES.includes(st.type)) throw new Error('存在无法识别的步骤类型');
        if (st.type === 'brush') {
          if (!Array.isArray(st.points)) throw new Error('画笔步骤缺少坐标点');
          sc.steps.push({ type: 'brush', color: String(st.color || ''), points: st.points.map(p => ({ x: p.x | 0, y: p.y | 0 })), id: st.id || uid('st') });
        } else if (st.type === 'fill') {
          sc.steps.push({ type: 'fill', color: String(st.color || ''), x: st.x | 0, y: st.y | 0, id: st.id || uid('st') });
        } else if (st.type === 'move') {
          const r = st.region || {};
          sc.steps.push({ type: 'move', region: { x: r.x | 0, y: r.y | 0, w: Math.max(1, r.w | 0), h: Math.max(1, r.h | 0) }, dx: st.dx | 0, dy: st.dy | 0, id: st.id || uid('st') });
        } else {
          sc.steps.push({ type: 'script', scriptId: String(st.scriptId), id: st.id || uid('st') });
        }
      }
      scripts.push(sc);
    }
    if (!scripts.length) scripts.push({ id: uid('s'), name: '脚本 1', mode: 'forward', range: { start: 1, end: frames.length }, steps: [] });
    return {
      frames,
      currentFrame: Math.max(0, Math.min(frames.length - 1, d.currentFrame | 0)),
      color: typeof d.color === 'string' ? d.color : PALETTE[0],
      zoom: Math.max(8, Math.min(32, d.zoom | 0 || 20)),
      grid: d.grid !== false,
      scripts,
      activeScriptId: scripts.some(s => s.id === d.activeScriptId) ? d.activeScriptId : scripts[0].id,
      idSeq: Math.max(idSeq, d.idSeq | 0),
    };
  }
  function loadDoc(d) {
    state.frames = d.frames;
    state.currentFrame = d.currentFrame;
    state.color = d.color;
    state.zoom = d.zoom;
    state.grid = d.grid;
    state.scripts = d.scripts;
    state.activeScriptId = d.activeScriptId;
    state.selection = null;
    state.recording = false;
    idSeq = d.idSeq;
    undoStack = []; redoStack = [];
    syncUndoButtons();
  }
  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProject(false), 400);
  }
  function saveProject(manual) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(serialize()));
      if (manual) setStatus('已保存到浏览器本地存储 · ' + new Date().toLocaleTimeString(), true);
    } catch (err) {
      if (manual) setStatus('保存失败：' + err.message, false);
    }
  }
  function exportProject() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.download = 'pixel-loom-project.json';
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('已导出项目 JSON', true);
  }
  function importProject(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const doc = normalizeProject(JSON.parse(rd.result));
        loadDoc(doc);
        renderAll();
        saveProject(false);
        setStatus('导入成功：' + file.name, true);
      } catch (err) {
        setStatus('导入失败：' + err.message, false);
      }
    };
    rd.readAsText(file);
  }

  /* ---------------- 状态栏 / 全量渲染 ---------------- */
  function setStatus(msg, ok) {
    const el = $('#status');
    el.textContent = msg;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }
  function renderAll() {
    renderCanvas();
    renderFrames();
    renderScripts();
    renderSwatches();
    $('#customColor').value = state.color;
    $('#zoomRange').value = state.zoom;
    $('#gridToggle').checked = state.grid;
  }

  /* ---------------- 键盘 ---------------- */
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'select' || tag === 'textarea';
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); saveProject(true); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'z') { if (!inField) { e.preventDefault(); doUndo(); } return; }
    if (mod && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) { if (!inField) { e.preventDefault(); doRedo(); } return; }
    if (inField) return;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      if (k === 'ArrowUp') state.cursor.y = Math.max(0, state.cursor.y - 1);
      if (k === 'ArrowDown') state.cursor.y = Math.min(H - 1, state.cursor.y + 1);
      if (k === 'ArrowLeft') state.cursor.x = Math.max(0, state.cursor.x - 1);
      if (k === 'ArrowRight') state.cursor.x = Math.min(W - 1, state.cursor.x + 1);
      renderCanvas();
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      const c = { ...state.cursor };
      if (state.tool === 'brush' || state.tool === 'eraser') { beginStroke(c); endStroke(); }
      else if (state.tool === 'fill') doFillAt(c);
    } else if (k === 'b' || k === 'B') setTool('brush');
    else if (k === 'f' || k === 'F') setTool('fill');
    else if (k === 'm' || k === 'M') setTool('move');
    else if (k === 'e' || k === 'E') setTool('eraser');
    else if (k === 'i' || k === 'I') setTool('picker');
    else if (k === 'r' || k === 'R') toggleRecord();
    else if (k === 'p' || k === 'P') doPreview();
    else if (k === '[') { state.currentFrame = (state.currentFrame + state.frames.length - 1) % state.frames.length; renderAll(); }
    else if (k === ']') { state.currentFrame = (state.currentFrame + 1) % state.frames.length; renderAll(); }
    else if (k === 'Escape') { state.selection = null; moveDrag = null; selDrag = null; renderCanvas(); }
    else if (k === 'g' || k === 'G') { state.grid = !state.grid; $('#gridToggle').checked = state.grid; renderCanvas(); }
  });

  function toggleRecord() {
    state.recording = !state.recording;
    renderScripts();
    setStatus(state.recording ? '录制中：画笔 / 填充 / 选区移动都会记成步骤' : '已停止录制', true);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#customColor').addEventListener('input', e => { state.color = e.target.value; renderSwatches(); });
    $('#zoomRange').addEventListener('input', e => { state.zoom = +e.target.value; renderCanvas(); });
    $('#gridToggle').addEventListener('change', e => { state.grid = e.target.checked; renderCanvas(); });
    $('#undoBtn').addEventListener('click', doUndo);
    $('#redoBtn').addEventListener('click', doRedo);
    $('#saveBtn').addEventListener('click', () => saveProject(true));
    $('#exportBtn').addEventListener('click', exportProject);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; });
    $('#newBtn').addEventListener('click', () => {
      if (!confirm('新建项目将清空当前画布与脚本（本地已保存的也会被覆盖），继续？')) return;
      resetProject();
    });
    $('#addFrameBtn').addEventListener('click', () => addFrame(false));
    $('#dupFrameBtn').addEventListener('click', () => addFrame(true));
    $('#delFrameBtn').addEventListener('click', delFrame);

    $('#scriptSelect').addEventListener('change', e => { state.activeScriptId = e.target.value; state.recording = false; renderScripts(); autosave(); });
    $('#scriptNew').addEventListener('click', () => {
      const sc = newScript('脚本 ' + (state.scripts.length + 1));
      state.scripts.push(sc);
      state.activeScriptId = sc.id;
      renderScripts(); autosave();
      setStatus('已新建「' + sc.name + '」', true);
    });
    $('#scriptRename').addEventListener('click', () => {
      const sc = activeScript();
      if (!sc) return;
      const name = prompt('脚本名称：', sc.name);
      if (name && name.trim()) { sc.name = name.trim(); renderScripts(); autosave(); }
    });
    $('#scriptDelete').addEventListener('click', () => {
      const sc = activeScript();
      if (!sc) return;
      if (state.scripts.some(s => s.id !== sc.id && s.steps.some(st => st.type === 'script' && st.scriptId === sc.id))) {
        setStatus(`无法删除：「${sc.name}」正被其他脚本嵌套引用`, false);
        return;
      }
      state.scripts = state.scripts.filter(s => s.id !== sc.id);
      if (!state.scripts.length) state.scripts.push(newScript('脚本 1'));
      state.activeScriptId = state.scripts[0].id;
      renderScripts(); autosave();
      setStatus('已删除「' + sc.name + '」', true);
    });
    $('#rangeStart').addEventListener('change', e => {
      const sc = activeScript(); if (!sc) return;
      sc.range.start = Math.max(1, Math.min(state.frames.length, +e.target.value | 0));
      e.target.value = sc.range.start; autosave();
    });
    $('#rangeEnd').addEventListener('change', e => {
      const sc = activeScript(); if (!sc) return;
      sc.range.end = Math.max(1, Math.min(state.frames.length, +e.target.value | 0));
      e.target.value = sc.range.end; autosave();
    });
    $('#playMode').addEventListener('change', e => { const sc = activeScript(); if (sc) { sc.mode = e.target.value; autosave(); } });
    $('#recordBtn').addEventListener('click', toggleRecord);
    $('#addStepBtn').addEventListener('click', () => addStep($('#addStepType').value));
    $('#previewBtn').addEventListener('click', doPreview);
    $('#applyBtn').addEventListener('click', doApply);

    $('#stepsList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const sc = activeScript(); if (!sc) return;
      const id = btn.closest('.step').dataset.id;
      const i = sc.steps.findIndex(s => s.id === id);
      if (i < 0) return;
      if (btn.dataset.act === 'del') sc.steps.splice(i, 1);
      else if (btn.dataset.act === 'up' && i > 0) [sc.steps[i - 1], sc.steps[i]] = [sc.steps[i], sc.steps[i - 1]];
      else if (btn.dataset.act === 'down' && i < sc.steps.length - 1) [sc.steps[i + 1], sc.steps[i]] = [sc.steps[i], sc.steps[i + 1]];
      mutateScript();
    });
    $('#stepsList').addEventListener('change', e => {
      const el = e.target.closest('[data-field]');
      if (!el) return;
      const sc = activeScript(); if (!sc) return;
      const st = sc.steps.find(s => s.id === el.closest('.step').dataset.id);
      if (!st) return;
      const f = el.dataset.field;
      if (f === 'color') st.color = el.value;
      else if (f === 'points') {
        const pts = parsePoints(el.value);
        if (!pts || !pts.length) { setStatus('坐标格式无效：应为 “x,y; x,y; …”', false); renderSteps(); return; }
        st.points = pts;
      }
      else if (f === 'x') st.x = +el.value | 0;
      else if (f === 'y') st.y = +el.value | 0;
      else if (f === 'rx') st.region.x = +el.value | 0;
      else if (f === 'ry') st.region.y = +el.value | 0;
      else if (f === 'rw') st.region.w = Math.max(1, +el.value | 0);
      else if (f === 'rh') st.region.h = Math.max(1, +el.value | 0);
      else if (f === 'dx') st.dx = +el.value | 0;
      else if (f === 'dy') st.dy = +el.value | 0;
      else if (f === 'scriptId') {
        if (wouldCycle(sc.id, el.value)) {
          const t = state.scripts.find(s => s.id === el.value);
          setStatus(`已阻止：嵌套「${t ? t.name : el.value}」会形成循环依赖`, false);
          renderSteps();
          return;
        }
        st.scriptId = el.value;
      }
      mutateScript();
    });
  }

  function resetProject() {
    localStorage.removeItem(LS_KEY);
    idSeq = 1;
    state = freshState();
    state.scripts = [newScript('脚本 1')];
    state.activeScriptId = state.scripts[0].id;
    undoStack = []; redoStack = [];
    syncUndoButtons();
    renderAll();
    setStatus('已新建空白项目', true);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    bind();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        loadDoc(normalizeProject(JSON.parse(raw)));
        setStatus('已恢复上次保存的项目', true);
      } else {
        setStatus('欢迎使用 Pixel Loom 脚本工作台', true);
      }
    } catch (err) {
      setStatus('本地存档损坏，已重置：' + err.message, false);
    }
    syncUndoButtons();
    renderAll();
  }

  /* 测试 / 调试钩子 */
  window.__app = {
    get state() { return state; },
    Engine: E,
    executeScript,
    activeScript,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length,
    setPixel(frame, x, y, color) { state.frames[frame].pixels[y * W + x] = color; renderAll(); },
    forceAddStep(scriptId, st) { const s = state.scripts.find(x => x.id === scriptId); if (s) { st.id = st.id || uid('st'); s.steps.push(st); renderSteps(); } },
    selectScript(id) { state.activeScriptId = id; renderScripts(); },
    serialize,
    checksum: () => JSON.stringify(serialize().doc.frames) + '|' + JSON.stringify(serialize().doc.scripts),
    resetProject,
    save: () => saveProject(true),
  };

  boot();
})();
