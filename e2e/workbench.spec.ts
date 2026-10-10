import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test('offline demo, playback controls, history and printable report', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '产线异常辅助诊断' })).toBeVisible();
  await expect(page.getByText('在线模型未配置')).toBeVisible();
  await expect(page.getByRole('button', { name: '在线 Pi Agent 诊断' })).toBeDisabled();
  await page.getByRole('button', { name: /评测与安全/ }).click();
  await expect(page.getByRole('button', { name: '运行五案例在线评测' })).toBeDisabled();
  await expect(page.locator('.evaluation-panel')).toContainText('尚无在线评测记录');
  await page.getByRole('button', { name: /诊断与监测/ }).click();
  await page.locator('.case-list').getByRole('button', { name: /IND-002/ }).click();
  await expect(page.locator('.case-list .case-item.selected')).toContainText('正常产线对照');
  await expect(page.getByText('快照 2026-09-22')).toBeVisible();

  await page.getByRole('button', { name: /一键演示/ }).click();
  await expect(page.getByText('离线预录回放').first()).toBeVisible();
  await expect(page.locator('.trace-stats')).toContainText('实际模型调用 0');
  await expect(page.locator('.trace-stats')).toContainText('实际工具调用 0');
  await page.getByRole('button', { name: '暂停' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('2 / 8')).toBeVisible();
  await page.getByRole('button', { name: '上一步' }).click();
  await expect(page.getByText('1 / 8')).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '暂停' }).click();
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('.trace-meta summary').first().click();
  await expect(page.locator('.trace-meta').first()).toContainText('replay-get_line_snapshot');
  await expect(page.locator('.trace-meta').first()).toContainText('预录，未现场计时');
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

test('all five cases keep chart, diagnosis, evidence and report aligned', async ({ page, context }) => {
  await page.goto('/');
  for (const item of [
    { id: 'IND-001', line: 'LINE-03', output: 850, risk: 'HIGH', record: 'MAINT-003' },
    { id: 'IND-002', line: 'LINE-02', output: 1020, risk: 'LOW', record: 'MAINT-002' },
    { id: 'IND-003', line: 'LINE-01', output: 1000, risk: 'MEDIUM', record: 'MAINT-001' },
    { id: 'IND-004', line: 'LINE-04', output: 900, risk: 'UNKNOWN', record: 'MAINT-004' },
    { id: 'IND-005', line: 'LINE-05', output: 995, risk: 'MEDIUM', record: 'MAINT-005' },
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

test('comparison board exposes an incomplete case without drawing a false trend', async ({ page }) => {
  await page.goto('/');
  const comparison = page.locator('.comparison-panel');
  await expect(comparison.locator('tbody tr')).toHaveCount(5);
  await expect(comparison.locator('tr').filter({ hasText: 'IND-004' })).toContainText('未知');
  await comparison.getByRole('button', { name: '查看 IND-004' }).click();
  await expect(page.locator('.case-meta')).toContainText('LINE-04');
  await expect(page.getByRole('img', { name: '温度基线 70，当前 缺失' })).toBeVisible();
  await expect(page.getByText('读数缺失，未绘制趋势')).toBeVisible();
  await expect(page.locator('.scenario-panel')).toContainText('无法进行完整推演');
  await page.getByRole('button', { name: /一键演示/ }).click();
  await page.getByRole('button', { name: '暂停' }).click();
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('关键温度读数缺失，当前无法完成风险分级')).toBeVisible();
  await expect(page.locator('.result-panel')).toContainText('补采同期温度读数');
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
  await page.locator('.action-panel').getByRole('combobox', { name: 'Skill' }).selectOption('equipment-priority-patrol');
  await page.getByRole('button', { name: '在线 Pi Agent 诊断' }).click();
  await expect(page.getByText('等待开始演示')).toBeVisible();
  await expect(page.getByText('在线真实执行')).toBeVisible();
  await expect(page.getByRole('heading', { name: '辅助诊断结果' })).toBeVisible();
});

test('evaluation panel submits a fixed Skill run and displays returned scores', async ({ page }) => {
  await page.route('**/api/agent/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), online_available: true } });
  });
  await page.route('**/api/evaluations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().postDataJSON()).toEqual({ skill_id: 'equipment-priority-patrol' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ json: {
      id: 'evaluation-test', created_at: '2026-09-22T00:00:00.000Z', data_type: 'synthetic',
      suite_id: 'industrial-synthetic-v1', suite_version: '1.0.0',
      skill: { id: 'equipment-priority-patrol', version: '1.0.0', name: '设备优先级巡检' },
      model: { provider: 'openai', name: 'fake-test' }, passed_count: 4, total_count: 5,
      mean_duration_ms: 123, cases: ['IND-001', 'IND-002', 'IND-003', 'IND-004', 'IND-005'].map((id, index) => ({
        case_id: id, expected_risk: index === 3 ? 'UNKNOWN' : 'MEDIUM', session_id: `session-${index}`,
        passed: index !== 3, status: index === 3 ? 'failed' : 'completed',
        stop_reason: index === 3 ? 'MODEL_ERROR' : 'COMPLETED', risk_consistent: index !== 3,
        tools_complete: true, evidence_complete: index !== 3, abstained_when_unknown: true,
        duration_ms: 123, model_calls: 2, tool_calls: 2, token_usage: null,
      })),
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /评测与安全/ }).click();
  await page.getByRole('combobox', { name: '评测 Skill' }).selectOption('equipment-priority-patrol');
  await page.getByRole('button', { name: '运行五案例在线评测' }).click();
  await expect(page.getByRole('status')).toContainText('正在等待五个任务完成');
  await expect(page.locator('.evaluation-summary')).toContainText('4 / 5');
  await expect(page.locator('.evaluation-cases article')).toHaveCount(5);
  await expect(page.locator('.evaluation-cases article').filter({ hasText: 'IND-004' })).toContainText('未通过');
});

test('safety lab runs without a model key and keeps the result separate from diagnosis history', async ({ page }) => {
  await page.goto('/');
  const before = await (await page.request.get('/api/sessions?case_id=IND-001')).json();
  await page.getByRole('button', { name: /评测与安全/ }).click();
  const panel = page.locator('.safety-panel');
  await expect(panel.locator('.safety-scenarios article')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '运行五案例在线评测' })).toBeDisabled();
  await panel.locator('article').filter({ hasText: '越权控制请求' }).getByRole('button', { name: '运行场景' }).click();
  await expect(panel.getByRole('status')).toContainText('符合预期');
  await expect(panel.getByRole('status')).toContainText('模型调用：0');
  await expect(panel.getByRole('status')).toContainText('实际停止：POLICY_BLOCKED');
  const after = await (await page.request.get('/api/sessions?case_id=IND-001')).json();
  expect(after.items.map((item: { id: string }) => item.id)).toEqual(before.items.map((item: { id: string }) => item.id));
});

test('an alarm leads through diagnosis, SOP, recorded inspection, recheck and human resolution', async ({ page }) => {
  await page.goto('/');
  await page.locator('.operations-panel').getByRole('button', { name: '基于事件诊断' }).click();
  await expect(page.getByRole('textbox', { name: '诊断问题' })).toHaveValue(/持续告警.*时序测点/);
  await page.getByRole('button', { name: /一键演示/ }).click();
  await page.getByRole('button', { name: '暂停' }).click();
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('combobox', { name: '巡检责任角色' }).selectOption('quality_engineer');
  await page.getByRole('button', { name: '生成巡检工单' }).click();

  const panel = page.locator('.work-orders-panel');
  const card = panel.locator('.work-order-card').first();
  await expect(card).toContainText('IND-001 · EQ-003');
  await expect(card).toContainText('质量工程师');
  await expect(card).toContainText('SOP-COOL-01');
  await expect(card).toContainText('TEL-IND-001-004');
  await card.getByRole('button', { name: '开始巡检' }).click();
  const count = await card.locator('.work-order-checklist li').count();
  expect(count).toBeGreaterThan(0);
  await expect(card.getByRole('button', { name: '完成检查记录' })).toBeDisabled();
  for (let index = 0; index < count; index++) {
    await card.getByRole('combobox', { name: `检查结果 ${index + 1}` }).selectOption('normal');
    await card.getByRole('textbox', { name: `检查记录 ${index + 1}` }).fill('现场核查记录正常');
    await card.locator('.work-order-checklist li').nth(index).getByRole('button', { name: '记录检查' }).click();
  }
  await card.getByRole('button', { name: '完成检查记录' }).click();
  await expect(card).toContainText('检查已完成 · 异常尚未确认解除');
  await card.getByRole('button', { name: '保存虚拟复测证据' }).click();
  await expect(card).toContainText('测点复测通过');
  await expect(card).toContainText('TEL-IND-001-006');
  await expect(card).toContainText('异常尚未确认解除');
  await card.getByRole('checkbox', { name: '已人工复核产量状态' }).check();
  await card.getByRole('checkbox', { name: '已人工复核质量状态' }).check();
  await card.getByRole('textbox', { name: '异常解除确认记录' }).fill('人工确认产量和质量已复核');
  await card.getByRole('button', { name: '人工确认异常解除（演示）' }).click();
  await expect(card).toContainText('异常解除已由人工确认');
  await page.reload();
  await expect(page.locator('.work-order-card').first()).toContainText('异常解除已由人工确认');
});

test('knowledge sources and scheduling disruption are visible without a model key', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /知识与巡检/ }).click();
  const knowledge = page.locator('.knowledge-panel');
  await expect(knowledge).toContainText('SOP-COOL-01');
  await page.getByRole('combobox', { name: '巡检案例' }).selectOption('IND-004');
  await expect(knowledge).toContainText('SOP-DATA-04');
  await knowledge.getByRole('textbox', { name: '检索设备知识' }).fill('不存在资料');
  await knowledge.getByRole('button', { name: '检索', exact: true }).click();
  await expect(knowledge).toContainText('没有匹配的知识卡片');

  await page.getByRole('button', { name: /生产排程/ }).click();
  const scheduling = page.locator('.scheduling-panel');
  await expect(scheduling.locator('.schedule-comparison article')).toHaveCount(2);
  await expect(scheduling.locator('.schedule-comparison article').first()).toContainText('总延期 0 h');
  await scheduling.getByRole('combobox', { name: '设备扰动' }).selectOption('M-FAST');
  await scheduling.getByRole('button', { name: '运行仿真' }).click();
  await expect(scheduling).toContainText('高速加工单元停用');
  await expect(scheduling.locator('.schedule-comparison article').first()).toContainText('总延期 0.8 h');
  await expect(scheduling.locator('.schedule-comparison article').first()).toContainText('能耗 143.2 kWh');
});

test('alarm scheduling impact leads to a persisted human simulation choice', async ({ page }) => {
  const replay = await (await page.request.post('/api/replay', { data: { case_id: 'IND-001' } })).json();
  const orderResponse = await page.request.post('/api/work-orders', { data: {
    session_id: replay.id, assignee: 'equipment_technician',
  } });
  expect(orderResponse.status()).toBe(201);
  await page.goto('/#scheduling');
  const panel = page.locator('.scheduling-panel');
  await expect(panel.locator('.incident-schedule')).toContainText('IND-001 / EQ-003');
  await expect(panel.locator('.incident-schedule')).toContainText('TEL-IND-001-004');
  await expect(panel.locator('.impact-grid article').first()).toContainText('0 → 0.8 h');
  await expect(panel.locator('.incident-schedule')).toContainText('规则建议：交期优先');
  await panel.getByRole('combobox', { name: '选择仿真方案' }).selectOption('deadline_first');
  await panel.getByRole('textbox', { name: '排程选择说明' }).fill('人工选择交期优先，以减少装配批次延期。');
  await panel.getByRole('button', { name: '保存人工选择（仅仿真）' }).click();
  await expect(panel.locator('.decision-history')).toContainText('人工选择交期优先');
  await page.reload();
  await expect(page.locator('.decision-history')).toContainText('人工选择交期优先');
});

test('workspace navigation keeps the active case and diagnosis session while showing one area at a time', async ({ page }) => {
  await page.goto('/#followup');
  await expect(page.getByRole('heading', { name: '知识与人工巡检' })).toBeVisible();
  await expect(page.locator('.knowledge-panel')).toBeVisible();
  await expect(page.locator('.case-list')).toBeHidden();
  await page.getByRole('combobox', { name: '巡检案例' }).selectOption('IND-005');
  await page.getByRole('textbox', { name: '检索设备知识' }).fill('维修');
  await page.locator('.knowledge-panel').getByRole('button', { name: '检索', exact: true }).click();
  await expect(page.locator('.knowledge-panel')).toContainText('SOP-MAINT-05');
  await page.getByRole('button', { name: /诊断与监测/ }).click();
  await expect(page.locator('.case-list .case-item.selected')).toContainText('IND-005');
  await page.getByRole('button', { name: /一键演示/ }).click();
  await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
  await expect(page.locator('.trace-stats')).toContainText('实际模型调用 0');
  await page.getByRole('button', { name: /生产排程/ }).click();
  await expect(page.locator('.scheduling-panel')).toBeVisible();
  await expect(page.locator('.trace-panel')).toBeHidden();
  await page.getByRole('combobox', { name: '设备扰动' }).selectOption('M-FAST');
  await page.getByRole('button', { name: '运行仿真' }).click();
  await expect(page.locator('.scheduling-panel')).toContainText('高速加工单元停用');
  await page.getByRole('button', { name: /评测与安全/ }).click();
  await expect(page.locator('.safety-panel')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.scheduling-panel')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '设备扰动' })).toHaveValue('M-FAST');
  await page.getByRole('button', { name: /知识与巡检/ }).click();
  await expect(page.getByRole('textbox', { name: '检索设备知识' })).toHaveValue('维修');
  await expect(page.locator('.knowledge-panel')).toContainText('SOP-MAINT-05');
  await page.getByRole('button', { name: /诊断与监测/ }).click();
  await expect(page.locator('.case-list .case-item.selected')).toContainText('IND-005');
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
});

test('panel numbers restart within each workspace', async ({ page }) => {
  await page.goto('/#diagnosis');
  await expect(page.locator('.case-panel .panel-title .eyebrow')).toHaveText('01 / CASE CONTEXT');
  await page.getByRole('button', { name: /知识与巡检/ }).click();
  await expect(page.locator('.work-orders-panel .panel-title .eyebrow')).toHaveText('01 / HUMAN FOLLOW-UP');
  await expect(page.locator('.knowledge-panel .panel-title .eyebrow')).toHaveText('02 / ASSET KNOWLEDGE');
  await page.getByRole('button', { name: /生产排程/ }).click();
  await expect(page.locator('.scheduling-panel .panel-title .eyebrow')).toHaveText('01 / VIRTUAL DECISION');
  await page.getByRole('button', { name: /评测与安全/ }).click();
  await expect(page.locator('.evaluation-panel .panel-title .eyebrow')).toHaveText('01 / REPEATABLE EVALUATION');
  await expect(page.locator('.safety-panel .panel-title .eyebrow')).toHaveText('02 / SAFETY LAB');
});

test('industrial event timeline requires sustained alarm and shows virtual recheck gates', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('.operations-panel');
  await expect(panel).toContainText('IND-001 · LINE-03 · EQ-003');
  await expect(panel.locator('.operations-state')).toHaveText('持续告警');
  await expect(panel).toContainText('TEL-IND-001-003');
  await panel.locator('.operations-steps button').nth(1).click();
  await expect(panel.locator('.operations-state')).toHaveText('待确认');
  await expect(panel.getByRole('button', { name: '预览虚拟复测' })).toHaveCount(0);
  await panel.locator('.operations-steps button').last().click();
  await panel.getByRole('button', { name: '预览虚拟复测' }).click();
  await expect(panel.getByRole('status')).toContainText('测点复测通过');
  await expect(panel.getByRole('status')).toContainText('不代表产量和质量恢复');

  await page.locator('.case-list').getByRole('button', { name: /IND-004/ }).click();
  await expect(panel.locator('.operations-state')).toHaveText('数据缺失');
  await expect(panel).toContainText('温度测点缺失');
  await expect(panel.getByRole('status')).toHaveCount(0);
  await page.locator('.case-list').getByRole('button', { name: /IND-003/ }).click();
  await expect(panel).toContainText('SOP-COOL-01');
  await panel.getByRole('button', { name: '预览虚拟复测' }).click();
  await expect(panel.getByRole('status')).toContainText('复测未通过');
});

test('CSV telemetry import exposes quality evidence and industrial outcome metrics', async ({ page }) => {
  await page.goto('/#assurance');
  const importer = page.locator('.telemetry-import-panel');
  const outcome = page.locator('.industrial-outcome-panel');
  await expect(outcome).toContainText('已确认告警');
  await expect(outcome).toContainText('少延期');
  await expect(outcome).toContainText('14.2 h');
  await importer.getByLabel('导入 CSV 文件').setInputFiles(join(process.cwd(), 'data', 'telemetry-import-example.csv'));
  await importer.getByRole('button', { name: '导入并校验' }).click();
  await expect(importer.locator('.import-history article').first()).toContainText('持续告警 · 4 个样本');
  await expect(importer.locator('.import-history article').first()).toContainText('质量 BAD：0');
  await expect(outcome).toContainText('当前案例 CSV 导入 1 批');
  await page.reload();
  await expect(page.locator('.import-history article').first()).toContainText('持续告警 · 4 个样本');
});

test('a late CSV response cannot appear under a newly selected asset', async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const posted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/telemetry/import', async (route) => {
    const response = await route.fetch();
    started();
    await hold;
    await route.fulfill({ response });
  });
  await page.goto('/#assurance');
  const importer = page.locator('.telemetry-import-panel');
  await importer.getByLabel('导入 CSV 文件').setInputFiles(join(process.cwd(), 'data', 'telemetry-import-example.csv'));
  await importer.getByRole('button', { name: '导入并校验' }).click();
  await posted;
  await page.getByRole('button', { name: /诊断与监测/ }).click();
  await page.locator('.case-list').getByRole('button', { name: /IND-003/ }).click();
  await page.getByRole('button', { name: /评测与安全/ }).click();
  await expect(importer).toContainText('选中案例 IND-003');
  const received = page.waitForResponse('**/api/telemetry/import');
  release();
  await received;
  await page.waitForTimeout(100);
  await expect(importer.locator('.import-history article')).toHaveCount(0);
  await expect(importer).toContainText('当前案例还没有导入记录');
});
