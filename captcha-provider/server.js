import http from 'node:http';
import { chromium } from 'playwright-core';

// ─── Config ───
const PORT = Number(process.env.PORT || 9876);
const HOST = process.env.HOST || '127.0.0.1';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const SECRET = process.env.SECRET || '';
const ZAI_URL = 'https://chat.z.ai/';
const SCENE_ID = 'didk33e0';

// Token 预取池配置
const POOL_SIZE = Number(process.env.POOL_SIZE || 5);       // 池中保持的 token 数量
const TOKEN_TTL = Number(process.env.TOKEN_TTL || 240000);  // token 有效期 4 分钟
const REFILL_INTERVAL = Number(process.env.REFILL_INTERVAL || 3000); // 补充间隔 3s

// ─── State ───
let browser = null;
let page = null;
let ready = false;
let lastError = '';
let stats = { served: 0, errors: 0, refills: 0 };

// Token 池：{ token, createdAt }
const tokenPool = [];
let refilling = false;

// ─── Browser lifecycle ───

async function launchBrowser() {
  console.log('[provider] Launching headless Chromium...');
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  });

  page = await context.newPage();

  // Stealth patches
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => ({}) };
    // Permissions API
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    }
  });

  console.log('[provider] Navigating to chat.z.ai...');
  await page.goto(ZAI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // 确保验证码 SDK 可用
  const hasCaptchaSDK = await page.evaluate(() => typeof window.initAliyunCaptcha === 'function');
  if (!hasCaptchaSDK) {
    console.log('[provider] Injecting AliyunCaptcha SDK...');
    await page.evaluate(async () => {
      window.AliyunCaptchaConfig = { region: 'cn', prefix: 'no8xfe' };
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('SDK load failed'));
        document.head.appendChild(script);
      });
    });
    await page.waitForTimeout(1000);
  }

  console.log('[provider] ✓ AliyunCaptcha SDK ready');
  ready = true;
}

// ─── Token acquisition ───

async function acquireToken() {
  if (!ready || !page) throw new Error('Browser not ready');

  const token = await page.evaluate(async (sceneId) => {
    if (typeof window.initAliyunCaptcha !== 'function') {
      throw new Error('initAliyunCaptcha not available');
    }

    const id = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const triggerId = 't-' + id;

    const container = document.createElement('div');
    container.id = id;
    container.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;';
    document.body.appendChild(container);

    const trigger = document.createElement('button');
    trigger.id = triggerId;
    trigger.style.cssText = 'display:none;';
    container.appendChild(trigger);

    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          container.remove();
          reject(new Error('captcha timeout'));
        }, 30000);

        window.initAliyunCaptcha({
          SceneId: sceneId,
          mode: 'popup',
          element: `#${id}`,
          button: `#${triggerId}`,
          language: 'cn',
          timeout: 10000,
          delayBeforeSuccess: false,
          success: (token) => {
            clearTimeout(timeout);
            container.remove();
            resolve(token);
          },
          fail: () => { /* TRACELESS 失败会降级，等 success 或 timeout */ },
          onError: (err) => {
            clearTimeout(timeout);
            container.remove();
            reject(new Error('captcha error: ' + JSON.stringify(err)));
          },
          onClose: () => { /* headless 不会触发 */ },
        });

        setTimeout(() => trigger.click(), 200);
      });
    } catch (e) {
      try { container.remove(); } catch {}
      throw e;
    }
  }, SCENE_ID);

  return token;
}

// ─── Token pool management ───

function getValidToken() {
  const now = Date.now();
  // 清理过期 token
  while (tokenPool.length > 0 && (now - tokenPool[0].createdAt) > TOKEN_TTL) {
    tokenPool.shift();
  }
  if (tokenPool.length > 0) {
    return tokenPool.shift().token;
  }
  return null;
}

async function refillPool() {
  if (refilling) return;
  refilling = true;
  try {
    const now = Date.now();
    // 清理过期的
    while (tokenPool.length > 0 && (now - tokenPool[0].createdAt) > TOKEN_TTL) {
      tokenPool.shift();
    }
    // 每次只补充一个，避免连续调用触发阿里云频率限制
    if (tokenPool.length < POOL_SIZE) {
      try {
        const token = await acquireToken();
        tokenPool.push({ token, createdAt: Date.now() });
        stats.refills++;
      } catch (err) {
        lastError = err.message;
        stats.errors++;
        // 超时不打日志刷屏，只记录非超时错误
        if (!err.message.includes('captcha timeout')) {
          console.error(`[pool] Refill error: ${err.message}`);
        }
      }
    }
  } finally {
    refilling = false;
  }
}

// ─── HTTP Server ───

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (SECRET && req.headers['x-secret'] !== SECRET) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: ready,
      pool: tokenPool.length,
      stats,
      lastError,
    });
  }

  if (req.method === 'GET' && req.url === '/token') {
    if (!ready) {
      return sendJson(res, 503, { error: 'not ready', lastError });
    }

    // 先从池里取
    const cached = getValidToken();
    if (cached) {
      stats.served++;
      console.log(`[provider] Served cached token (pool: ${tokenPool.length})`);
      return sendJson(res, 200, { ok: true, token: cached, cached: true });
    }

    // 池空了，实时获取
    try {
      const started = Date.now();
      const token = await acquireToken();
      const elapsed = Date.now() - started;
      stats.served++;
      console.log(`[provider] Served fresh token in ${elapsed}ms (pool: ${tokenPool.length})`);
      return sendJson(res, 200, { ok: true, token, cached: false, elapsed_ms: elapsed });
    } catch (err) {
      lastError = err.message;
      stats.errors++;
      console.error(`[provider] Token error: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  sendJson(res, 404, { error: 'Use GET /token or GET /health' });
});

// ─── Start ───

server.listen(PORT, HOST, async () => {
  console.log(`[provider] zai-captcha-provider listening on http://${HOST}:${PORT}`);
  console.log(`[provider] Pool size: ${POOL_SIZE}, TTL: ${TOKEN_TTL}ms`);
  try {
    await launchBrowser();
    // 初始填充池
    await refillPool();
    console.log(`[provider] Initial pool filled: ${tokenPool.length} tokens`);
    // 定期补充
    setInterval(refillPool, REFILL_INTERVAL);
  } catch (err) {
    console.error('[provider] Startup error:', err.message);
    lastError = err.message;
  }
});

process.on('SIGINT', async () => {
  console.log('[provider] Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
