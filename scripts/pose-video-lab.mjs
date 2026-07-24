#!/usr/bin/env node
/**
 * 动作映射视频分析自动化：
 * 用 playwright + 本机 Chrome（channel: 'chrome'，可解码 H.264；自带 chromium 不行）
 * 打开 dev server 的 /pose-lab，跑完后把 window.__poseLabResult 存成 JSON 并打印误差表。
 *
 * 用法：
 *   node scripts/pose-video-lab.mjs [--out tmp/pose-lab-report.json] [--url http://localhost:5173]
 *                                   [--query "start=0&end=120&interval=0.1&model=heavy&delegate=CPU"]
 *
 * 说明：headless Chrome 里 GPU delegate 可能不可用，默认走 CPU delegate。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg('url', 'http://localhost:5173');
const outPath = resolve(arg('out', 'tmp/pose-lab-report.json'));
const query = arg(
  'query',
  'auto=1&start=0&end=120&interval=0.1&calibSec=2&model=heavy&delegate=CPU&mirror=0&smooth=0',
);
const timeoutMs = Number(arg('timeout', String(40 * 60 * 1000)));

const url = `${baseUrl}/pose-lab?${query}`;
console.log(`[pose-lab] 打开 ${url}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[console.error] ${msg.text()}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 进度心跳：每 30s 打印一次采样进度
  const heartbeat = setInterval(async () => {
    try {
      const p = await page.evaluate(() => window.__poseLabProgress ?? 0);
      console.log(`[pose-lab] 进度 ${(p * 100).toFixed(1)}%`);
    } catch {
      /* 页面导航/关闭中 */
    }
  }, 30000);

  try {
    await page.waitForFunction(
      () => window.__poseLabResult !== undefined || window.__poseLabError !== undefined,
      null,
      { timeout: timeoutMs, polling: 2000 },
    );
  } finally {
    clearInterval(heartbeat);
  }
  const labError = await page.evaluate(() => window.__poseLabError);
  if (labError) {
    console.error(`[pose-lab] 页面分析失败：${labError}`);
    await browser.close();
    process.exit(1);
  }
  const result = await page.evaluate(() => window.__poseLabResult);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result));
  console.log(`[pose-lab] 报告已写入 ${outPath}`);

  // 打印误差表
  const m = result.meta;
  console.log(
    `\nmapper=${m.mapperVersion} model=${m.model} delegate=${m.delegate} ` +
      `采样=${m.sampledFrames} 帧（${m.start}–${m.end}s @${m.interval}s）校准=${m.calibSec}±${m.calibWin}s`,
  );
  console.log(`worldSanity: ${JSON.stringify(result.worldSanity)}`);
  console.log(`\n${'肢体段'.padEnd(16)} ${'平均°'.padStart(7)} ${'P95°'.padStart(7)} ${'最大°'.padStart(7)} ${'帧数'.padStart(6)}`);
  for (const [id, e] of Object.entries(result.errors)) {
    console.log(
      `${id.padEnd(18)} ${e.mean.toFixed(1).padStart(7)} ${e.p95.toFixed(1).padStart(7)} ${e.max.toFixed(1).padStart(7)} ${String(e.count).padStart(6)}`,
    );
  }
  const o = result.overall;
  console.log(`${'overall'.padEnd(18)} ${o.mean.toFixed(1).padStart(7)} ${o.p95.toFixed(1).padStart(7)} ${o.max.toFixed(1).padStart(7)} ${String(o.count).padStart(6)}`);
  if (result.overallWorld) {
    const ow = result.overallWorld;
    console.log(`\n自检（vs worldLandmarks，应≈0 除 clamp 段）: mean=${ow.mean.toFixed(1)}° p95=${ow.p95.toFixed(1)}° max=${ow.max.toFixed(1)}°`);
    for (const [id, e] of Object.entries(result.errorsWorld ?? {})) {
      console.log(`  ${id.padEnd(18)} ${e.mean.toFixed(1).padStart(6)} ${e.p95.toFixed(1).padStart(6)}`);
    }
  }
  console.log('\n最差帧 Top5:');
  for (const f of result.worstFrames.slice(0, 5)) {
    console.log(`  t=${f.t.toFixed(1)}s meanErr=${f.meanErr.toFixed(1)}°`);
  }
} finally {
  await browser.close();
}
