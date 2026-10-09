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
