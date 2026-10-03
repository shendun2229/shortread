/* ============================================================
 * ShortRead - 本地模拟接口（仅调试用）
 * 说明：
 * - 仅在 localhost / 127.0.0.1 环境生效，线上部署自动跳过
 * - 拦截每日简讯接口请求，直接返回 3 条测试文章数据
 *   （每条显式包含 cover / title / meta / text 字段）
 * - 不改动 app.js 其他逻辑
 * ============================================================ */
(function () {
  'use strict';

  var host = location.hostname;
  // localhost / 127.0.0.1 自动生效；手机局域网调试可通过 URL 加 ?mock=1 强制启用
  var forceMock = /(^|[?&])mock=1(&|$)/.test(location.search);
  if (host !== 'localhost' && host !== '127.0.0.1' && !forceMock) return;

  var MOCK_DELAY = 300; // 模拟网络延迟 ms

  // 匹配每日简讯接口（与 app.js 中 API_LIST 一致）
  var API_PATTERN = /(60s\.viki\.moe|60s-api\.viki\.moe)\/v2\/60s/;

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;

  function today() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      day_of_week: week[d.getDay()]
    };
  }

  function buildMockData() {
    var t = today();
    var metaPrefix = 'ShortRead 模拟 · ' + t.date + ' · ' + t.day_of_week;
    return {
      code: 200,
      message: '本地模拟数据（mock.js）',
      data: {
        date: t.date,
        day_of_week: t.day_of_week,
        articles: [
          {
            cover: 'https://picsum.photos/seed/shortread-1/900/600',
            title: '模拟接口已启用',
            meta: metaPrefix,
            text: '当前页面运行在本机调试环境，简讯接口已被 mock.js 拦截，返回 3 条测试文章。\n\n部署到线上环境后，本模拟逻辑会自动跳过，页面将联网拉取真实的每日简讯内容。'
          },
          {
            cover: 'https://picsum.photos/seed/shortread-2/900/600',
            title: '手势与按钮翻页测试',
            meta: metaPrefix,
            text: '上下滑动卡片可以切换文章：上滑查看下一篇，下滑查看上一篇，首尾循环。\n\n底部操作栏的"上一篇"、"下一篇"按钮同样可以直接切换；"刷新"按钮会重新拉取模拟接口数据。\n\n当正文较长时，卡片内部优先滚动阅读，滚动到边界后再滑动才会触发翻页，不会误触。'
          },
          {
            cover: 'https://picsum.photos/seed/shortread-3/900/600',
            title: '渲染字段说明',
            meta: metaPrefix,
            text: '每条文章包含四个字段：\n\ncover：顶部封面图，宽 100%，高 42vh，加载时有灰色占位底色；\n\ntitle：文章标题，26px 粗体；\n\nmeta：来源与日期信息，14px 灰色；\n\ntext：资讯正文，18px、行高 1.8，支持多段落完整展示。'
          }
        ]
      }
    };
  }

  function mockResponse() {
    return new Response(JSON.stringify(buildMockData()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  window.fetch = function (input, init) {
    var url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (e) { url = ''; }
    if (API_PATTERN.test(url)) {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(mockResponse()); }, MOCK_DELAY);
      });
    }
    if (originalFetch) return originalFetch(input, init);
    return Promise.reject(new Error('fetch unavailable'));
  };

  console.info('[ShortRead] Mock API enabled (localhost)：简讯接口返回 3 条测试文章');
})();
