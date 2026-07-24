#!/usr/bin/env node
/**
 * 重新生成所有数字人的正面封面（/cover-shot/:id 隐藏路由 + playwright 截图上传）。
 *
 * 用法：
 *   node scripts/regenerate-covers.mjs
 *
 * 环境变量（均有默认值）：
 *   API_ORIGIN   后端地址，默认 http://localhost:8000
 *   WEB_ORIGIN   前端地址，默认 http://localhost:5173
 *   DHP_EMAIL    登录账号，默认 demo@dhp.local
 *   DHP_PASSWORD 登录密码，默认 demo123456
 *
 * 全部封面更新成功时退出码为 0。
 */
import { chromium } from 'playwright';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:8000';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const EMAIL = process.env.DHP_EMAIL ?? 'demo@dhp.local';
const PASSWORD = process.env.DHP_PASSWORD ?? 'demo123456';
const SHOT_TIMEOUT_MS = 45_000;

async function apiJson(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`API 响应解析失败（${path}）`);
  }
  if (!res.ok) throw new Error(`API ${path} 失败：${res.status} ${data.code ?? ''} ${data.message ?? ''}`);
  return data;
}

async function main() {
  // 1. 登录
  const { token, user } = await apiJson('/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  console.log(`[covers] 已登录：${user.email}`);

  // 2. 列出全部数字人
  const { avatars } = await apiJson('/avatars', { token });
  if (avatars.length === 0) {
    console.log('[covers] 没有数字人，跳过。');
    return;
  }
  console.log(`[covers] 共 ${avatars.length} 个数字人待更新封面`);

  // 3. 启动浏览器（本机 Chrome）
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 720, height: 960 },
    deviceScaleFactor: 1,
  });
  // 应用启动前注入登录态（api client 从 localStorage 读取 token）
  await context.addInitScript(
    ([t, u]) => localStorage.setItem('dhp.auth', JSON.stringify({ token: t, user: u })),
    [token, user],
  );
  const page = await context.newPage();

  let failed = 0;
  for (const avatar of avatars) {
    const label = `${avatar.name}（${avatar.id.slice(0, 8)}…）`;
    try {
      await page.goto(`${WEB_ORIGIN}/cover-shot/${avatar.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => window.__coverReady === true || Boolean(window.__coverError),
        undefined,
        { timeout: SHOT_TIMEOUT_MS },
      );
      const coverError = await page.evaluate(() => window.__coverError);
      if (coverError) throw new Error(`页面渲染失败：${coverError}`);

      const canvas = page.locator('.cover-shot-stage canvas');
      const png = await canvas.screenshot({ type: 'png' });

      const { avatar: updated } = await apiJson(`/avatars/${avatar.id}/cover`, {
        method: 'POST',
        token,
        body: { imageBase64: png.toString('base64') },
      });
      console.log(`[covers] ✓ ${label} → coverUrl=${updated.coverUrl}`);
    } catch (err) {
      failed += 1;
      console.error(`[covers] ✕ ${label}：${err instanceof Error ? err.message : err}`);
    }
  }

  await browser.close();

  if (failed > 0) {
    console.error(`[covers] 完成，${failed}/${avatars.length} 个失败`);
    process.exit(1);
  }
  console.log(`[covers] 全部 ${avatars.length} 个封面更新成功`);
}

main().catch((err) => {
  console.error(`[covers] 执行失败：${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
