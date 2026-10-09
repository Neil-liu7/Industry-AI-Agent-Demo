import { expect, test } from '@playwright/test';

test('offline demo, playback controls, history and printable report', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '产线异常辅助诊断' })).toBeVisible();
  await expect(page.getByText('在线模型未配置')).toBeVisible();
  await expect(page.getByRole('button', { name: '在线 Pi Agent 诊断' })).toBeDisabled();
  await page.getByRole('button', { name: /IND-002/ }).click();
  await expect(page.getByText('正常产线对照')).toBeVisible();
  await expect(page.getByText('快照 2026-09-22')).toBeVisible();

  await page.getByRole('button', { name: /一键演示/ }).click();
  await expect(page.getByText('离线预录回放').first()).toBeVisible();
  await page.getByRole('button', { name: '暂停' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('2 / 7')).toBeVisible();
  await page.getByRole('button', { name: '上一步' }).click();
  await expect(page.getByText('1 / 7')).toBeVisible();
  await page.getByRole('button', { name: '继续' }).click();
  await page.getByRole('button', { name: '暂停' }).click();
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: '辅助诊断结果' })).toBeVisible();
  await expect(page.getByText('IND-002:maintenance:MAINT-002', { exact: true }).first()).toBeVisible();
  const reportLink = page.getByRole('link', { name: '打开可打印报告' });
  const [report] = await Promise.all([context.waitForEvent('page'), reportLink.click()]);
  await report.waitForLoadState();
  await expect(report.getByText('正常对照案例各关键指标未越阈')).toBeVisible();
  await expect(report.getByText('离线预录回放')).toBeVisible();
  await report.close();

  await page.getByRole('button', { name: '退出回放' }).click();
  await expect(page.getByText('等待开始演示')).toBeVisible();
  await page.getByRole('combobox', { name: '筛选模式' }).selectOption('replay');
  await page.getByRole('button', { name: /IND-002.*回放/ }).click();
  await expect(page.getByRole('heading', { name: '辅助诊断结果' })).toBeVisible();
});

test('all three cases keep chart, diagnosis, evidence and report aligned', async ({ page, context }) => {
  await page.goto('/');
  for (const item of [
    { id: 'IND-001', line: 'LINE-03', output: 850, risk: 'HIGH', record: 'MAINT-003' },
    { id: 'IND-002', line: 'LINE-02', output: 1020, risk: 'LOW', record: 'MAINT-002' },
    { id: 'IND-003', line: 'LINE-01', output: 1000, risk: 'MEDIUM', record: 'MAINT-001' },
  ]) {
    await page.locator('.case-list').getByRole('button', { name: new RegExp(item.id) }).click();
    await expect(page.locator('.case-meta')).toContainText(item.line);
    await expect(page.getByRole('img', { name: `日产量基线 1000，当前 ${item.output}` })).toBeVisible();
    await page.getByRole('button', { name: /一键演示/ }).click();
    await page.getByRole('button', { name: '暂停' }).click();
    for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('heading', { name: '辅助诊断结果' })).toBeVisible();
    await expect(page.getByText(`${item.id}:maintenance:${item.record}`, { exact: true }).first()).toBeVisible();
    const [report] = await Promise.all([
      context.waitForEvent('page'), page.getByRole('link', { name: '打开可打印报告' }).click(),
    ]);
    await report.waitForLoadState();
    await expect(report.locator('body')).toContainText(item.id);
    await expect(report.locator('body')).toContainText(item.record);
    await expect(report.getByText(item.risk, { exact: true })).toBeVisible();
    await report.close();
    await page.getByRole('button', { name: '退出回放' }).click();
  }
});

test('what-if controls change only the temporary risk view', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('.scenario-panel');
  await expect(panel).toContainText('原始风险 高风险');
  await panel.getByRole('slider', { name: '假设日产量' }).press('End');
  await panel.getByRole('slider', { name: '假设温度' }).press('Home');
  await panel.getByRole('slider', { name: '假设振动' }).press('Home');
  await expect(panel).toContainText('假设风险 低风险');
  const snapshot = await (await page.request.get('/api/cases/IND-001/snapshot')).json();
  expect(snapshot.current).toMatchObject({ daily_output_units: 850, temperature_c: 87.5, vibration_mm_s: 8.1 });
  expect(snapshot.metrics.risk_level).toBe('HIGH');
  await panel.getByRole('button', { name: '恢复原始值' }).click();
  await expect(panel).toContainText('假设风险 高风险');
  await page.locator('.case-list').getByRole('button', { name: /IND-003/ }).click();
  await expect(panel).toContainText('原始风险 中风险');
  await expect(panel).toContainText('假设风险 中风险');
});

test('a late snapshot cannot replace a newly selected case', async ({ page }) => {
  await page.route('**/api/cases/IND-001/snapshot', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue().catch(() => {});
  });
  await page.goto('/');
  await page.locator('.case-list').getByRole('button', { name: /IND-003/ }).click();
  await expect(page.locator('.case-meta')).toContainText('LINE-01');
  await page.waitForTimeout(300);
  await expect(page.locator('.case-meta')).not.toContainText('LINE-03');
  await expect(page.getByRole('img', { name: '温度基线 70，当前 86' })).toBeVisible();
});

test('online button sends the selected case and skill without invented progress', async ({ page }) => {
  const replayResponse = await page.request.post('/api/replay', { data: { case_id: 'IND-001' } });
  const replay = await replayResponse.json();
  await page.route('**/api/agent/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), online_available: true } });
  });
  await page.route('**/api/diagnose', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      case_id: 'IND-001', skill_id: 'equipment-priority-patrol',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ json: { ...replay, mode: 'online', trace: [], skill: {
      id: 'equipment-priority-patrol', version: '1.0.0', name: '设备优先级巡检',
    } } });
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Skill' }).selectOption('equipment-priority-patrol');
  await page.getByRole('button', { name: '在线 Pi Agent 诊断' }).click();
  await expect(page.getByText('等待开始演示')).toBeVisible();
  await expect(page.getByText('在线真实执行')).toBeVisible();
  await expect(page.getByRole('heading', { name: '辅助诊断结果' })).toBeVisible();
});
