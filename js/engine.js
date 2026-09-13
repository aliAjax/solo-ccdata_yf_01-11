/* Pixel Loom 脚本引擎 —— 纯逻辑，无 DOM 依赖。
 * 步骤类型：
 *   brush  {type:'brush',  color, points:[{x,y}...]}        参数：颜色 + 坐标点
 *   fill   {type:'fill',   color, x, y}                     参数：颜色 + 种子点
 *   move   {type:'move',   region:{x,y,w,h}, dx, dy}        参数：区域 + 位移
 *   script {type:'script', scriptId}                        嵌套复用另一个脚本
 * 像素缓冲：长度为 W*H 的数组，元素为颜色字符串，'' 表示空（背景）。
 */
(function (global) {
  'use strict';

  class StepError extends Error {
    constructor(message) { super(message); this.name = 'StepError'; }
  }

  const STEP_TYPES = ['brush', 'fill', 'move', 'script'];
  const PLAY_MODES = ['forward', 'reverse', 'mirror'];

  function inBounds(x, y, W, H) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;
  }

  function scriptMap(scripts) {
    const m = new Map();
    for (const s of scripts) m.set(s.id, s);
    return m;
  }

  /* 从 fromId 出发沿 script 引用能否到达 toId（用于添加嵌套时阻断循环） */
  function reaches(scripts, fromId, toId) {
    const map = scriptMap(scripts);
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      if (id === toId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const sc = map.get(id);
      if (!sc) continue;
      for (const st of sc.steps) if (st.type === 'script') stack.push(st.scriptId);
    }
    return false;
  }

  /* 从 startId 出发检测循环依赖，返回构成环的脚本 id 路径（含首尾重复），无环返回 null */
  function detectCycle(scripts, startId) {
    const map = scriptMap(scripts);
    const mark = new Map(); // 'gray' | 'black'
    const stack = [];
    function dfs(id) {
      mark.set(id, 'gray');
      stack.push(id);
      const sc = map.get(id);
      if (!sc) { stack.pop(); return null; }
      for (const st of sc.steps) {
        if (st.type !== 'script') continue;
        const t = st.scriptId;
        if (mark.get(t) === 'gray') return stack.slice(stack.indexOf(t)).concat(t);
        if (!mark.get(t)) { const c = dfs(t); if (c) return c; }
      }
      stack.pop();
      mark.set(id, 'black');
      return null;
    }
    return dfs(startId);
  }

  /* 帧范围 + 重放方式 → 帧序号序列（1 起始）。
   * forward: [s..e]  reverse: [e..s]  mirror: [s..e, e-1..s+1]（端点不重复） */
  function frameSequence(range, mode, frameCount) {
    const s = range.start, e = range.end;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s || e > frameCount) {
      throw new StepError(`帧范围无效（${s}–${e}，有效范围 1–${frameCount}）`);
    }
    const fwd = [];
    for (let i = s; i <= e; i++) fwd.push(i);
    if (mode === 'forward') return fwd;
    if (mode === 'reverse') return fwd.slice().reverse();
    if (mode === 'mirror') return fwd.concat(fwd.slice(1, -1).reverse());
    throw new StepError(`未知重放方式：${mode}`);
  }

  function floodFill(pix, W, H, x, y, color) {
    const target = pix[y * W + x];
    if (target === color) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      if (pix[cy * W + cx] !== target) continue;
      pix[cy * W + cx] = color;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function moveRegion(pix, W, H, r, dx, dy) {
    const tmp = [];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) tmp.push(pix[(r.y + y) * W + (r.x + x)]);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pix[(r.y + y) * W + (r.x + x)] = '';
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const nx = r.x + dx + x, ny = r.y + dy + y;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) pix[ny * W + nx] = tmp[y * r.w + x];
    }
  }

  /* 应用单个步骤；越界/缺引用/循环一律抛 StepError。
   * ctx = { scriptsById, stack }，stack 为当前嵌套调用链（防循环）。 */
  function applyStep(pix, W, H, step, ctx) {
    switch (step.type) {
      case 'brush': {
        const pts = step.points || [];
        if (!pts.length) throw new StepError('画笔步骤没有任何坐标点');
        for (const p of pts) {
          if (!inBounds(p.x, p.y, W, H)) throw new StepError(`画笔步骤越界：坐标 (${p.x}, ${p.y}) 超出 ${W}×${H} 画布`);
        }
        for (const p of pts) pix[p.y * W + p.x] = step.color;
        return;
      }
      case 'fill': {
        if (!inBounds(step.x, step.y, W, H)) throw new StepError(`填充步骤越界：起点 (${step.x}, ${step.y}) 超出 ${W}×${H} 画布`);
        floodFill(pix, W, H, step.x, step.y, step.color);
        return;
      }
      case 'move': {
        const r = step.region || {};
        if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.w < 1 || r.h < 1) {
          throw new StepError('移动步骤区域无效：需要整数 x/y 且宽、高 ≥ 1');
        }
        if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) {
          throw new StepError(`移动步骤越界：区域 (${r.x}, ${r.y}, ${r.w}×${r.h}) 超出 ${W}×${H} 画布`);
        }
        if (!Number.isInteger(step.dx) || !Number.isInteger(step.dy)) throw new StepError('移动步骤位移无效：dx/dy 需为整数');
        // 落点越界同样阻止：不裁剪、不丢弃任何像素，并指出越界坐标
        const tx = r.x + step.dx, ty = r.y + step.dy;
        if (tx < 0 || ty < 0 || tx + r.w > W || ty + r.h > H) {
          const oob = [];
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            const nx = tx + x, ny = ty + y;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) oob.push(`(${nx}, ${ny})`);
          }
          const detail = oob.length <= 3 ? oob.join('、') : `${oob.slice(0, 3).join('、')} 等 ${oob.length} 个像素`;
          throw new StepError(`移动步骤越界：落点 ${detail} 超出 ${W}×${H} 画布`);
        }
        moveRegion(pix, W, H, r, step.dx, step.dy);
        return;
      }
      case 'script': {
        const ref = ctx.scriptsById.get(step.scriptId);
        if (!ref) throw new StepError(`引用的子脚本不存在：${step.scriptId}`);
        if (ctx.stack.includes(step.scriptId)) {
          throw new StepError('检测到循环依赖：' + ctx.stack.concat(step.scriptId).join(' → '));
        }
        ctx.stack.push(step.scriptId);
        try { for (const s of ref.steps) applyStep(pix, W, H, s, ctx); }
        finally { ctx.stack.pop(); }
        return;
      }
      default:
        throw new StepError(`未知步骤类型：${step.type}`);
    }
  }

  /* 静态校验：帧范围、空脚本、循环依赖、缺失引用。返回错误字符串数组。 */
  function validateScript(doc, script) {
    const errors = [];
    const fc = doc.frames.length;
    const r = script.range || {};
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1 || r.end < r.start || r.end > fc) {
      errors.push(`帧范围无效（${r.start}–${r.end}，有效范围 1–${fc}）`);
    }
    if (!script.steps || !script.steps.length) errors.push('脚本为空：请先录制或添加步骤');
    const cyc = detectCycle(doc.scripts, script.id);
    if (cyc) {
      const map = scriptMap(doc.scripts);
      errors.push('检测到循环依赖：' + cyc.map(id => (map.get(id) || {}).name || id).join(' → '));
    }
    const map = scriptMap(doc.scripts);
    const seen = new Set();
    (function walk(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const sc = map.get(id);
      if (!sc) return;
      for (const st of sc.steps) {
        if (st.type !== 'script') continue;
        if (!map.has(st.scriptId)) errors.push(`脚本「${sc.name}」引用了不存在的脚本（${st.scriptId}）`);
        else walk(st.scriptId);
      }
    })(script.id);
    return errors;
  }

  const Engine = { StepError, STEP_TYPES, PLAY_MODES, inBounds, scriptMap, reaches, detectCycle, frameSequence, floodFill, moveRegion, applyStep, validateScript };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  global.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
