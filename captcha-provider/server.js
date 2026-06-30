import http from 'node:http';
import { chromium } from 'playwright-core';
import * as cloak from 'cloakbrowser';

const PORT = Number(process.env.PORT || 9876);
const HOST = process.env.HOST || '127.0.0.1';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const SECRET = process.env.SECRET || '';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || process.env.SECRET || '';
const ZAI_URL = process.env.ZAI_URL || 'https://chat.z.ai/';
const CAPTCHA_REGION = process.env.CAPTCHA_REGION || 'sgp';
const CAPTCHA_PREFIX = process.env.CAPTCHA_PREFIX || 'no8xfe';
const CAPTCHA_SCENE_ID = process.env.CAPTCHA_SCENE_ID || 'didk33e0';
const CAPTCHA_MODE = process.env.CAPTCHA_MODE || 'popup';
const CAPTCHA_LANGUAGE = process.env.CAPTCHA_LANGUAGE || 'cn';
const CAPTCHA_LOGO = process.env.CAPTCHA_LOGO || 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg';
const BROWSER_BACKEND = process.env.BROWSER_BACKEND || 'cloak';
const POOL_SIZE = Number(process.env.POOL_SIZE || 5);
const TOKEN_TTL = Number(process.env.TOKEN_TTL || 240000);
const REFILL_INTERVAL = Number(process.env.REFILL_INTERVAL || 3000);
const BROWSER_USER_AGENT =
  process.env.BROWSER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

let browser = null;
let context = null;
let ready = false;
let lastError = '';
let stats = { served: 0, errors: 0, refills: 0, bridged: 0 };
let lastBridge = null;
const tokenPool = [];
let refilling = false;

function tokenAuthValid(req) {
  return !SECRET || req.headers['x-secret'] === SECRET;
}

function bridgeAuthValid(req) {
  if (BRIDGE_SECRET) {
    return req.headers['x-bridge-secret'] === BRIDGE_SECRET;
  }
  return tokenAuthValid(req);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function extractBearerToken(headers) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== 'authorization') continue;
    const match = String(value).match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return '';
}

function extractQueryParam(inputURL, key) {
  try {
    return new URL(inputURL).searchParams.get(key) || '';
  } catch {
    return '';
  }
}

function createLanguagePack() {
  return {
    cn: {
      START_VERIFY: '点击开始验证',
      POPUP_TITLE: '请完成安全验证',
      SLIDE_TIP: '请向右拖动滑块',
      CHECK_BOX_TIP: '请确认您不是机器人',
      PUZZLE_TIP: '请拖动滑块完成拼图',
      INPAINTING_TIP: '请拖动滑块还原完整图片',
      VERIFYING: '验证中...',
      SUCCESS: '验证成功',
      SLIDE_FAIL: '验证失败，请刷新后重试',
      CAPTCHA_FAIL: '验证失败，请重试',
      CONGESTION: '网络拥堵，请刷新后重试',
      CAPTCHA_COMPLETED: '验证已完成',
      FINISH_CAPTCHA: '请先完成验证',
    },
    en: {
      START_VERIFY: 'Click to start verification',
      POPUP_TITLE: 'Please complete security verification',
      SLIDE_TIP: 'Please drag slider right',
      CHECK_BOX_TIP: 'Confirm you are not a robot',
      PUZZLE_TIP: 'Please drag the slider to complete the puzzle',
      INPAINTING_TIP: 'Please drag the slider to restore the complete image',
      VERIFYING: 'Verifying...',
      SUCCESS: 'Slide successful!',
      SLIDE_FAIL: 'Verification failed, please refresh and try again',
      CAPTCHA_FAIL: 'Verification failed, please try again!',
      CONGESTION: 'Network congestion, please refresh and try again',
      CAPTCHA_COMPLETED: 'Slide completed',
      FINISH_CAPTCHA: 'Please complete verification first!',
    },
  };
}

async function launchBrowser() {
  console.log(`[provider] Initializing browser backend: ${BROWSER_BACKEND}`);
  if (BROWSER_BACKEND === 'cloak') {
    const test = await cloak.launch({ headless: true, userAgent: BROWSER_USER_AGENT });
    const version = await test.version();
    console.log(`[provider] CloakBrowser ready (${version})`);
    await test.close();
  } else {
    const launchOpts = {
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
    };
    const proxyURL = process.env.PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyURL) {
      launchOpts.proxy = { server: proxyURL };
    }
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 929 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: BROWSER_USER_AGENT,
    });
    await installStealth(context);
  }
  ready = true;
  console.log('[provider] Browser ready');
}

async function installStealth(targetContext) {
  await targetContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => ({}) };
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    }
  });
}

async function createSession() {
  let localBrowser = null;
  let localContext = null;
  let localPage = null;

  if (BROWSER_BACKEND === 'cloak') {
    const opts = { headless: true, userAgent: BROWSER_USER_AGENT };
    const proxyURL = process.env.PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyURL) {
      opts.proxy = { server: proxyURL };
    }
    localBrowser = await cloak.launch(opts);
    localContext = await localBrowser.newContext({
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 929 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: BROWSER_USER_AGENT,
    });
    await installStealth(localContext);
  } else {
    if (!browser || !context) {
      throw new Error('playwright 浏览器未初始化');
    }
    localContext = await browser.newContext({
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 929 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: BROWSER_USER_AGENT,
    });
    await installStealth(localContext);
  }

  localPage = await localContext.newPage();

  return {
    browser: localBrowser,
    context: localContext,
    page: localPage,
    async close() {
      try {
        await localPage?.close();
      } catch {}
      try {
        await localContext?.close();
      } catch {}
      if (localBrowser) {
        try {
          await localBrowser.close();
        } catch {}
      }
    },
  };
}

async function preparePage(page, options = {}) {
  const target = new URL(ZAI_URL);
  if (typeof options.chatId === 'string' && options.chatId.trim()) {
    target.pathname = `/c/${options.chatId}`;
  }
  await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  await page.evaluate(async ({ region, prefix }) => {
    if (typeof window.initAliyunCaptcha === 'function') {
      return;
    }
    window.AliyunCaptchaConfig = { region, prefix };
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('验证码 SDK 加载失败'));
      document.head.appendChild(script);
    });
  }, { region: CAPTCHA_REGION, prefix: CAPTCHA_PREFIX });

  await page.waitForTimeout(1000);
}

async function solveCaptchaOnPage(page) {
  return await page.evaluate(async (cfg) => {
    if (typeof window.initAliyunCaptcha !== 'function') {
      throw new Error('注入后未找到 initAliyunCaptcha');
    }

    const containerId = 'chat-captcha-element';
    const triggerId = 'chat-captcha-trigger';

    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = containerId;
      container.style.cssText =
        'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;';
      document.body.appendChild(container);
    }

    let trigger = document.getElementById(triggerId);
    if (!trigger) {
      trigger = document.createElement('button');
      trigger.id = triggerId;
      trigger.type = 'button';
      trigger.setAttribute('aria-hidden', 'true');
      trigger.tabIndex = -1;
      trigger.style.cssText =
        'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;';
      document.body.appendChild(trigger);
    }

    try {
      let instance = null;
      let settled = false;
      let resolveToken;
      let rejectToken;
      const tokenPromise = new Promise((resolve, reject) => {
        resolveToken = resolve;
        rejectToken = reject;
      });

      const clickTrigger = () => {
        const button = document.getElementById(triggerId);
        if (button) {
          button.click();
        }
      };

      await new Promise((resolve, reject) => {
        const initTimeout = setTimeout(() => reject(new Error('验证码初始化超时')), 10000);
        window.initAliyunCaptcha({
          SceneId: cfg.sceneId,
          mode: cfg.mode,
          element: `#${containerId}`,
          button: `#${triggerId}`,
          captchaLogoImg: cfg.logoImage,
          upLang: cfg.myLang,
          language: cfg.language,
          timeout: 10000,
          delayBeforeSuccess: false,
          success: (token) => {
            if (settled) return;
            settled = true;
            resolveToken(token);
            try {
              instance?.refresh?.();
            } catch {}
          },
          fail: () => {
            if (settled) return;
            setTimeout(clickTrigger, 0);
          },
          onError: (err) => {
            if (settled) return;
            settled = true;
            rejectToken(new Error(`验证码错误: ${JSON.stringify(err)}`));
            try {
              instance?.refresh?.();
            } catch {}
          },
          onClose: () => {
            if (settled) return;
            settled = true;
            rejectToken(new Error('验证码被用户取消'));
            try {
              instance?.refresh?.();
            } catch {}
          },
          getInstance: (inst) => {
            instance = inst;
            clearTimeout(initTimeout);
            resolve();
          },
        });
      });

      setTimeout(clickTrigger, 0);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectToken(new Error('验证码超时'));
        try {
          instance?.refresh?.();
        } catch {}
      }, 25000);

      try {
        return await tokenPromise;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      try {
        container.remove();
      } catch {}
      try {
        trigger.remove();
      } catch {}
    }
  }, {
    sceneId: CAPTCHA_SCENE_ID,
    mode: CAPTCHA_MODE,
    logoImage: CAPTCHA_LOGO,
    myLang: createLanguagePack(),
    language: CAPTCHA_LANGUAGE,
  });
}

async function acquireToken() {
  const session = await createSession();
  try {
    await preparePage(session.page);
    return await solveCaptchaOnPage(session.page);
  } finally {
    await session.close();
  }
}

function getValidToken() {
  const now = Date.now();
  while (tokenPool.length > 0 && now - tokenPool[0].createdAt > TOKEN_TTL) {
    tokenPool.shift();
  }
  if (tokenPool.length > 0) {
    return tokenPool.shift().token;
  }
  return null;
}

async function refillPool() {
  if (refilling || POOL_SIZE <= 0) {
    return;
  }
  refilling = true;
  try {
    const now = Date.now();
    while (tokenPool.length > 0 && now - tokenPool[0].createdAt > TOKEN_TTL) {
      tokenPool.shift();
    }
    if (tokenPool.length < POOL_SIZE) {
      const token = await acquireToken();
      tokenPool.push({ token, createdAt: Date.now() });
      stats.refills++;
    }
  } catch (err) {
    lastError = err.message;
    stats.errors++;
    if (!String(err.message || '').includes('验证码超时')) {
      console.error(`[pool] Refill error: ${err.message}`);
    }
  } finally {
    refilling = false;
  }
}

async function bridgeUpstreamRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid bridge payload');
  }
  if (!payload.url || !payload.method) {
    throw new Error('bridge payload missing method or url');
  }

  const session = await createSession();
  try {
    let requestBody = payload.body;
    if (typeof requestBody !== 'string') {
      requestBody = JSON.stringify(requestBody ?? {});
    }

    const parsedBody = requestBody ? JSON.parse(requestBody) : {};
    const authToken = extractBearerToken(payload.headers);
    if (authToken) {
      await session.context.addCookies([
        {
          name: 'token',
          value: authToken,
          domain: 'chat.z.ai',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'Lax',
        },
      ]);
      await session.context.addInitScript((token) => {
        if (location.hostname === 'chat.z.ai') {
          localStorage.setItem('token', token);
          document.cookie = `token=${token}; path=/; SameSite=Lax; Secure`;
        }
      }, authToken);
    }

    await preparePage(session.page, {
      chatId: typeof parsedBody.chat_id === 'string' ? parsedBody.chat_id : '',
    });

    const captchaToken = await solveCaptchaOnPage(session.page);
    parsedBody.captcha_verify_param = captchaToken;

    const upstreamURL = new URL(payload.url);
    const fingerprint = await session.page.evaluate(
      ({ timestamp, requestId, userId, token, signatureTimestamp }) => {
        const params = {
          timestamp,
          requestId,
          user_id: userId,
          version: '0.0.1',
          platform: 'web',
          token,
          user_agent: navigator.userAgent,
          language: navigator.language,
          languages: navigator.languages.join(','),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          cookie_enabled: String(navigator.cookieEnabled),
          screen_width: String(window.screen.width),
          screen_height: String(window.screen.height),
          screen_resolution: `${window.screen.width}x${window.screen.height}`,
          viewport_height: String(window.innerHeight),
          viewport_width: String(window.innerWidth),
          viewport_size: `${window.innerWidth}x${window.innerHeight}`,
          color_depth: String(window.screen.colorDepth),
          pixel_ratio: String(window.devicePixelRatio),
          current_url: window.location.href,
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
          host: window.location.host,
          hostname: window.location.hostname,
          protocol: window.location.protocol,
          referrer: document.referrer,
          title: document.title,
          timezone_offset: String(new Date().getTimezoneOffset()),
          local_time: new Date().toString(),
          utc_time: new Date().toUTCString(),
          is_mobile: 'false',
          is_touch: String('ontouchstart' in window),
          max_touch_points: String(navigator.maxTouchPoints),
          browser_name: 'Chrome',
          os_name: 'Windows',
          signature_timestamp: signatureTimestamp || timestamp,
        };
        return Object.entries(params);
      },
      {
        timestamp: extractQueryParam(payload.url, 'timestamp'),
        requestId: extractQueryParam(payload.url, 'requestId'),
        userId: extractQueryParam(payload.url, 'user_id'),
        token: authToken,
        signatureTimestamp: extractQueryParam(payload.url, 'signature_timestamp'),
      },
    );
    upstreamURL.search = '';
    for (const [key, value] of fingerprint) {
      upstreamURL.searchParams.append(key, String(value));
    }

    const headers = normalizeHeaders(payload.headers);
    delete headers['Content-Length'];
    delete headers['content-length'];
    delete headers['Host'];
    delete headers['host'];
    delete headers['Connection'];
    delete headers['connection'];
    delete headers['Cookie'];
    delete headers['cookie'];
    delete headers['Origin'];
    delete headers['origin'];
    delete headers['Referer'];
    delete headers['referer'];
    delete headers['User-Agent'];
    delete headers['user-agent'];

    const response = await session.page.evaluate(
      async ({ url, method, headers: reqHeaders, body }) => {
        const resp = await fetch(url, {
          method,
          headers: reqHeaders,
          body,
          credentials: 'include',
        });
        const text = await resp.text();
        const responseHeaders = {};
        resp.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          ok: true,
          status: resp.status,
          statusText: resp.statusText,
          headers: responseHeaders,
          body: text,
        };
      },
      {
        url: upstreamURL.toString(),
        method: payload.method,
        headers,
        body: JSON.stringify(parsedBody),
      },
    );

    stats.bridged++;
    let upstreamError = null;
    try {
      const decoded = JSON.parse(response.body);
      upstreamError =
        decoded?.data?.data?.error ||
        decoded?.data?.error ||
        decoded?.error ||
        null;
    } catch {}
    lastBridge = {
      at: new Date().toISOString(),
      endpoint: upstreamURL.pathname,
      status: response.status,
      bodyKeys: Object.keys(parsedBody).sort(),
      hasAuth: Boolean(authToken),
      captchaLen: typeof captchaToken === 'string' ? captchaToken.length : null,
      captchaJsonKeys: (() => {
        try {
          return Object.keys(JSON.parse(Buffer.from(captchaToken, 'base64').toString('utf8'))).sort();
        } catch {
          return [];
        }
      })(),
      queryKeys: [...upstreamURL.searchParams.keys()].sort(),
      requestHeaders: Object.keys(headers).sort(),
      upstreamError,
    };
    console.log(
      `[bridge] endpoint=${lastBridge.endpoint} status=${lastBridge.status} ` +
        `captchaLen=${lastBridge.captchaLen} errorCode=${upstreamError?.code || ''} ` +
        `verifyCode=${upstreamError?.verify_code || ''} captchaType=${upstreamError?.captcha_error_type || ''}`,
    );
    return response;
  } finally {
    await session.close();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: ready,
      pool: tokenPool.length,
      stats,
      lastError,
      bridge: true,
      lastBridge,
    });
  }

  if (req.method === 'GET' && req.url === '/token') {
    if (!tokenAuthValid(req)) {
      return sendJson(res, 401, { error: '未授权' });
    }
    if (!ready) {
      return sendJson(res, 503, { error: '服务未就绪', lastError });
    }
    const cached = getValidToken();
    if (cached) {
      stats.served++;
      return sendJson(res, 200, { ok: true, token: cached, cached: true });
    }
    try {
      const started = Date.now();
      const token = await acquireToken();
      stats.served++;
      return sendJson(res, 200, {
        ok: true,
        token,
        cached: false,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      lastError = err.message;
      stats.errors++;
      console.error(`[provider] Token error: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/v1/upstream') {
    if (!bridgeAuthValid(req)) {
      return sendJson(res, 401, { ok: false, error: '未授权' });
    }
    if (!ready) {
      return sendJson(res, 503, { ok: false, error: '服务未就绪', lastError });
    }
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');
      const result = await bridgeUpstreamRequest(payload);
      return sendJson(res, 200, result);
    } catch (err) {
      lastError = err.message;
      stats.errors++;
      console.error(`[bridge] Upstream error: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { error: '请使用 GET /token、GET /health 或 POST /v1/upstream' });
});

server.listen(PORT, HOST, async () => {
  console.log(`[provider] listening on http://${HOST}:${PORT}`);
  console.log(`[provider] Pool size: ${POOL_SIZE}, TTL: ${TOKEN_TTL}ms`);
  try {
    await launchBrowser();
    await refillPool();
    setInterval(refillPool, REFILL_INTERVAL);
  } catch (err) {
    lastError = err.message;
    console.error('[provider] Startup error:', err.message);
  }
});

process.on('SIGINT', async () => {
  try {
    await browser?.close();
  } catch {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  try {
    await browser?.close();
  } catch {}
  process.exit(0);
});
