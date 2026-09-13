const { test, expect } = require('@playwright/test');

/* ---------- 工具函数 ---------- */
const ZOOM = 20;
async function cellPoint(page, x, y) {
  const box = await page.locator('#canvas').boundingBox();
  return { x: box.x + (x + 0.5) * ZOOM, y: box.y + (y + 0.5) * ZOOM };
}
async function dragCells(page, x0, y0, x1, y1) {
  const a = await cellPoint(page, x0, y0);
  const b = await cellPoint(page, x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}
async function clickCell(page, x, y) {
  const p = await cellPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}
const px = (page, f, x, y) =>
  page.evaluate(([f, x, y]) => window.__app.state.frames[f].pixels[y * 16 + x], [f, x, y]);
const debug = page => page.evaluate(() => window.__app.state);
const undoDepth = page => page.evaluate(() => window.__app.undoDepth());
const checksum = page => page.evaluate(() => window.__app.checksum());

async function addStep(page, type) {
  await page.locator('#addStepType').selectOption(type);
  await page.locator('#addStepBtn').click();
}
async function setPoints(page, stepIndex, text) {
  const input = page.locator('.step').nth(stepIndex).locator('input[data-field="points"]');
  await input.fill(text);
  await input.press('Tab');
}
async function setRange(page, start, end) {
  await page.locator('#rangeStart').fill(String(start));
  await page.locator('#rangeStart').press('Tab');
  await page.locator('#rangeEnd').fill(String(end));
  await page.locator('#rangeEnd').press('Tab');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__app.resetProject());
});

/* ---------- 1. 空脚本 ---------- */
test('空脚本：应用被阻止且不产生任何修改', async ({ page }) => {
  const before = await checksum(page);
  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('脚本为空');
  expect(await checksum(page)).toBe(before);
  expect(await undoDepth(page)).toBe(0);
});

/* ---------- 2. 单步（录制画笔笔画） ---------- */
test('单步：录制一笔并应用，批量应用只占一次撤销', async ({ page }) => {
  await page.locator('#recordBtn').click();
  await dragCells(page, 2, 2, 4, 2);
  await expect(page.locator('.step')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('已录制');
  expect(await px(page, 0, 2, 2)).toBe('#ff7aa8');
  expect(await px(page, 0, 4, 2)).toBe('#ff7aa8');

  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('已应用');
  // 第一次撤销：回退“批量应用”这一条记录，现场画的笔画仍在
  await page.keyboard.press('Control+z');
  expect(await px(page, 0, 3, 2)).toBe('#ff7aa8');
  // 第二次撤销：才回退录制时的现场笔画
  await page.keyboard.press('Control+z');
  expect(await px(page, 0, 3, 2)).toBe('');
});

/* ---------- 3. 反向重放 ---------- */
test('反向：逐帧预览按帧范围倒序排列，且不改动画布', async ({ page }) => {
  await page.locator('#addFrameBtn').click();
  await page.locator('#addFrameBtn').click();
  await addStep(page, 'move');
  await setRange(page, 1, 3);
  await page.locator('#playMode').selectOption('reverse');
  const before = await checksum(page);
  await page.locator('#previewBtn').click();
  await expect(page.locator('#status')).toContainText('预览就绪');
  const labels = await page.locator('#previewStrip .pv span').allTextContents();
  expect(labels).toEqual(['帧 3', '帧 2', '帧 1']);
  expect(await checksum(page)).toBe(before); // 预览不落地
  expect(await undoDepth(page)).toBe(0);
});

/* ---------- 4. 镜像重放 ---------- */
test('镜像：中间帧被来回各应用一次（位移翻倍）', async ({ page }) => {
  await page.locator('#addFrameBtn').click();
  await page.locator('#addFrameBtn').click();
  await page.evaluate(() => { for (let f = 0; f < 3; f++) window.__app.setPixel(f, 0, 0, '#ff7aa8'); });
  await addStep(page, 'move'); // 默认区域 (0,0,2x2)，dx=1
  await setRange(page, 1, 3);
  await page.locator('#playMode').selectOption('mirror');
  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('已应用');
  // 序列 [1,2,3,2]：帧1/帧3 移动 1 格，帧2 移动 2 格
  expect(await px(page, 0, 1, 0)).toBe('#ff7aa8');
  expect(await px(page, 1, 2, 0)).toBe('#ff7aa8');
  expect(await px(page, 2, 1, 0)).toBe('#ff7aa8');
  expect(await px(page, 0, 0, 0)).toBe('');
  expect(await px(page, 1, 1, 0)).toBe('');
});

/* ---------- 5. 嵌套复用 + 循环依赖阻止 ---------- */
test('嵌套：子脚本可复用；循环依赖在添加时与应用时都被阻止', async ({ page }) => {
  // 脚本 A：画笔点 (1,1)
  await addStep(page, 'brush');
  await setPoints(page, 0, '1,1');
  // 脚本 B：嵌套 A + 画笔点 (2,2)
  await page.locator('#scriptNew').click();
  await addStep(page, 'script');
  await addStep(page, 'brush');
  await setPoints(page, 1, '2,2');
  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('已应用');
  expect(await px(page, 0, 1, 1)).toBe('#ff7aa8');
  expect(await px(page, 0, 2, 2)).toBe('#ff7aa8');

  const [idA, idB] = await page.evaluate(() => window.__app.state.scripts.map(s => s.id));
  // 添加时阻止：A 嵌套 B 会成环（B 已引用 A）
  await page.locator('#scriptSelect').selectOption(idA);
  await addStep(page, 'script');
  await expect(page.locator('#status')).toContainText('循环');
  let aSteps = await page.evaluate(id => window.__app.state.scripts.find(s => s.id === id).steps.length, idA);
  expect(aSteps).toBe(1);

  // 应用时阻止：构造绕过 UI 的循环（如导入的脏数据），批量应用必须失败且回滚
  await page.evaluate(([a, b]) => window.__app.forceAddStep(a, { type: 'script', scriptId: b }), [idA, idB]);
  const before = await checksum(page);
  const depthBefore = await undoDepth(page);
  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('循环依赖');
  expect(await checksum(page)).toBe(before);
  expect(await undoDepth(page)).toBe(depthBefore); // 失败的应用不产生新的撤销记录
});

/* ---------- 6. 跨帧应用 + 单次撤销 ---------- */
test('跨帧：帧范围 1-3 全部生效、第 4 帧不受影响，一次撤销整体回退', async ({ page }) => {
  for (let i = 0; i < 3; i++) await page.locator('#addFrameBtn').click();
  await addStep(page, 'brush');
  await setPoints(page, 0, '0,0');
  await setRange(page, 1, 3);
  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('已应用');
  for (const f of [0, 1, 2]) expect(await px(page, f, 0, 0)).toBe('#ff7aa8');
  expect(await px(page, 3, 0, 0)).toBe('');
  expect(await undoDepth(page)).toBe(1); // 整批一条记录
  await page.keyboard.press('Control+z');
  for (const f of [0, 1, 2]) expect(await px(page, f, 0, 0)).toBe('');
  expect(await undoDepth(page)).toBe(0);
});

/* ---------- 7. 失败回滚 ---------- */
test('失败回滚：越界步骤使整批作废，画布与撤销栈原封不动', async ({ page }) => {
  await page.locator('#addFrameBtn').click();
  await addStep(page, 'brush');
  await setPoints(page, 0, '5,5');
  await addStep(page, 'brush');
  await setPoints(page, 1, '99,99'); // 越界
  await setRange(page, 1, 2);

  await page.locator('#previewBtn').click();
  await expect(page.locator('#status')).toContainText('越界');

  await page.locator('#applyBtn').click();
  await expect(page.locator('#status')).toContainText('越界');
  await expect(page.locator('#status')).toContainText('回滚');
  // 第一步本来合法，但整批回滚 → 任何帧都不应有像素
  const flat = await page.evaluate(() => window.__app.state.frames.map(f => f.pixels.every(v => v === '')));
  expect(flat).toEqual([true, true]);
  expect(await undoDepth(page)).toBe(0);
});

/* ---------- 8. 保存后刷新一致 ---------- */
test('保存刷新：刷新后画布与脚本完全一致', async ({ page }) => {
  await page.evaluate(() => window.__app.setPixel(0, 3, 3, '#6a8cff'));
  await addStep(page, 'brush');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#status')).toContainText('已保存');
  await page.reload();
  await page.waitForFunction(() => window.__app);
  expect(await px(page, 0, 3, 3)).toBe('#6a8cff');
  const d = await debug(page);
  expect(d.scripts).toHaveLength(1);
  expect(d.scripts[0].steps).toHaveLength(1);
  expect(d.scripts[0].steps[0].type).toBe('brush');
});

/* ---------- 9. 导出导入一致 ---------- */
test('导出导入：导出的 JSON 重新导入后结果一致', async ({ page }) => {
  await dragCells(page, 0, 0, 1, 1);
  await addStep(page, 'fill');
  const before = await checksum(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportBtn').click(),
  ]);
  const path = await download.path();
  await page.evaluate(() => window.__app.resetProject());
  expect(await checksum(page)).not.toBe(before);
  await page.locator('#importFile').setInputFiles(path);
  await expect(page.locator('#status')).toContainText('导入成功');
  expect(await checksum(page)).toBe(before);
});

/* ---------- 10. 键盘可用 ---------- */
test('键盘：工具切换、光标移动、作画、撤销、切帧', async ({ page }) => {
  await page.locator('#addFrameBtn').click(); // 新建后位于第 2 帧
  await page.locator('#canvas').focus();
  await page.keyboard.press('['); // 切回第 1 帧
  expect((await debug(page)).currentFrame).toBe(0);
  await page.keyboard.press('f');
  expect((await debug(page)).tool).toBe('fill');
  await page.keyboard.press('b');
  expect((await debug(page)).tool).toBe('brush');
  await page.keyboard.press('ArrowRight');
  expect((await debug(page)).cursor).toEqual({ x: 1, y: 0 });
  await page.keyboard.press('Enter');
  expect(await px(page, 0, 1, 0)).toBe('#ff7aa8');
  await page.keyboard.press('Control+z');
  expect(await px(page, 0, 1, 0)).toBe('');
  await page.keyboard.press(']');
  expect((await debug(page)).currentFrame).toBe(1);
  await page.keyboard.press('[');
  expect((await debug(page)).currentFrame).toBe(0);
});

/* ---------- 11. 窄屏可用 ---------- */
test('窄屏：390px 视口下单列布局且画布可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => window.__app.resetProject());
  const cols = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#applyBtn')).toBeVisible();
  // 窄屏下仍能作画
  await clickCell(page, 5, 5);
  expect(await px(page, 0, 5, 5)).toBe('#ff7aa8');
});

/* ---------- 12. 填充与选区移动也可录制 ---------- */
test('录制：填充与选区移动被记为带参数的步骤', async ({ page }) => {
  await page.locator('#recordBtn').click();
  await page.locator('.tool[data-tool="fill"]').click();
  await clickCell(page, 0, 0); // 整帧填充
  await page.locator('.tool[data-tool="move"]').click();
  await dragCells(page, 0, 0, 2, 2); // 框选 3x3
  await dragCells(page, 1, 1, 4, 4); // 拖动选区 (+3,+3)
  const steps = (await debug(page)).scripts[0].steps;
  expect(steps).toHaveLength(2);
  expect(steps[0]).toMatchObject({ type: 'fill', color: '#ff7aa8', x: 0, y: 0 });
  expect(steps[1]).toMatchObject({ type: 'move', region: { x: 0, y: 0, w: 3, h: 3 }, dx: 3, dy: 3 });
});
