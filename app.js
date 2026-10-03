/* ============================================================
 * ShortRead - 每日简讯 PWA
 * 原生 JS，无框架依赖
 * 功能：联网拉取每日简讯、上下手势跟随翻页（首尾循环）、
 *       长文滚动与翻页手势隔离、点击卡片打开详情页、
 *       加载/错误状态、ServiceWorker 注册
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  // 每日简讯接口（每天 60s 读懂世界，每日更新，支持跨域）
  var API_LIST = [
    'https://60s.viki.moe/v2/60s',
    'https://60s-api.viki.moe/v2/60s'
  ];
  var FETCH_TIMEOUT = 10000;   // 单次请求超时 ms
  var SWIPE_THRESHOLD = 80;    // 翻页滑动阈值 px
  var DIRECTION_LOCK = 8;      // 方向判定最小位移 px

  /* ---------------- DOM ---------------- */
  var viewport = document.getElementById('viewport');
  var track = document.getElementById('track');
  var cards = {
    prev: document.querySelector('.card[data-slot="prev"]'),
    curr: document.querySelector('.card[data-slot="curr"]'),
    next: document.querySelector('.card[data-slot="next"]')
  };
  var loadingEl = document.getElementById('state-loading');
  var errorEl = document.getElementById('state-error');
  var errorMsgEl = document.getElementById('error-msg');
  var retryBtn = document.getElementById('retry-btn');
  var detailEl = document.getElementById('detail');
  var backBtn = document.getElementById('back-btn');
  var detailImg = document.getElementById('detail-img');
  var detailTitle = document.getElementById('detail-title');
  var detailMeta = document.getElementById('detail-meta');
  var detailText = document.getElementById('detail-text');

  /* ---------------- 内存状态 ---------------- */
  var articles = [];      // 当日文章列表（仅内存，不做持久化）
  var currentIndex = 0;   // 当前文章索引
  var isAnimating = false;

  /* ================= 数据层 ================= */

  function fetchWithTimeout(url, timeout) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('请求超时'));
      }, timeout);
      fetch(url, { cache: 'no-store' })
        .then(function (res) {
          clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(resolve, function (err) {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // 将接口响应归一化为文章列表
  // 每条数据结构：{ cover 图片url, coverAlt, title 标题, meta 来源日期,
  //                intro 简介, text 完整正文, date 日期 }
  function normalize(raw) {
    var data = raw && raw.data ? raw.data : raw;
    if (!data) throw new Error('数据格式错误');

    // 显式文章数组格式：data.articles = [{ cover, title, meta, intro, text, date }]
    if (Array.isArray(data.articles)) {
      var direct = data.articles.map(function (a) {
        var text = String(a.text || '');
        var intro = String(a.intro || '');
        if (!intro) {
          // 无显式简介时，取正文首段前 60 字
          var firstPara = text.split(/\n+/).filter(Boolean)[0] || '';
          intro = firstPara.length > 60 ? firstPara.slice(0, 60) + '…' : firstPara;
        }
        return {
          cover: a.cover || '',
          coverAlt: a.coverAlt || '',
          title: String(a.title || ''),
          meta: String(a.meta || ''),
          intro: intro,
          text: text,
          date: String(a.date || '')
        };
      }).filter(function (a) { return a.title || a.text; });
      if (direct.length) return direct;
    }

    var newsArr = Array.isArray(data.news) ? data.news : [];
    var date = data.date || '';
    var dayOfWeek = data.day_of_week || '';
    var lunar = data.lunar_date || '';
    var tip = data.tip || '';

    var list = [];

    // 首篇：每日一言（用一句话作标题生成独立配图）
    if (tip) {
      var tipCovers = buildCovers(tip);
      list.push({
        cover: tipCovers.cover,
        coverAlt: tipCovers.coverAlt,
        title: '今日一言',
        meta: trimJoin([date, dayOfWeek, lunar], ' · '),
        intro: tip,
        text: tip,
        date: date
      });
    }

    // 新闻条目：冒号前缀作为标题，每条独立生成相关配图
    newsArr.forEach(function (item) {
      var s = String(item || '').trim();
      if (!s) return;
      var colonIdx = s.indexOf('：');
      var title;
      if (colonIdx > 0 && colonIdx <= 14) {
        title = s.slice(0, colonIdx);
      } else {
        title = s.length > 22 ? s.slice(0, 22) + '…' : s;
      }
      var imgs = buildCovers(title);
      list.push({
        cover: imgs.cover,
        coverAlt: imgs.coverAlt,
        title: title,
        meta: trimJoin(['每天60s读懂世界', date, dayOfWeek], ' · '),
        intro: s,
        text: s,
        date: date
      });
    });

    if (!list.length) throw new Error('暂无内容');
    return list;
  }

  function trimJoin(arr, sep) {
    return arr.filter(function (s) { return !!s; }).join(sep);
  }

  // 字符串哈希 → 正整数（用于生成稳定的 picsum 种子）
  function hashSeed(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return (h % 100000) + 1;
  }

  // 从标题提取英文关键词（用于 unsplash 相关配图搜索）
  var STOP_WORDS = { the: 1, and: 1, for: 1, with: 1, from: 1, says: 1, after: 1, over: 1, amid: 1, will: 1, into: 1, has: 1, are: 1, its: 1, his: 1, her: 1, new: 1 };
  function extractKeyword(title) {
    var words = String(title).toLowerCase().match(/[a-z]{3,}/g) || [];
    for (var i = 0; i < words.length; i++) {
      if (!STOP_WORDS[words[i]]) return words[i];
    }
    return 'news';
  }

  // 为每条新闻生成相关配图：
  // 主图 picsum（按标题哈希稳定，每条不同）；失败回退 unsplash 关键词图
  function buildCovers(title) {
    var seed = hashSeed(title);
    return {
      cover: 'https://picsum.photos/seed/sr-' + seed + '/900/600',
      coverAlt: 'https://source.unsplash.com/900x600/?' + encodeURIComponent(extractKeyword(title))
    };
  }

  /* ================= 渲染层 ================= */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 正文文本 → 段落 HTML
  function paragraphsHtml(text) {
    return String(text).split(/\n+/).filter(Boolean)
      .map(function (line) { return '<p>' + escapeHtml(line) + '</p>'; }).join('');
  }

  // 列表卡片：顶部配图 + 标题 + 来源日期 + 简介（完整正文在详情页展示）
  function buildCardHtml(article) {
    var imgHtml = '';
    if (article.cover) {
      imgHtml = '<img src="' + escapeHtml(article.cover) + '"' +
        (article.coverAlt ? ' data-fb="' + escapeHtml(article.coverAlt) + '"' : '') +
        ' alt="" draggable="false" onerror="var f=this.getAttribute(\'data-fb\');' +
        'if(f){this.removeAttribute(\'data-fb\');this.src=f;}else{this.style.display=\'none\';}">';
    }
    return '<div class="cover">' + imgHtml + '<div class="cover-mask"></div></div>' +
      '<div class="content">' +
        '<h1 class="title">' + escapeHtml(article.title) + '</h1>' +
        '<div class="meta">' + escapeHtml(article.meta) + '</div>' +
        '<div class="intro">' + escapeHtml(article.intro) + '</div>' +
      '</div>';
  }

  // 渲染当前窗口：上一篇 / 当前 / 下一篇
  function renderWindow() {
    var n = articles.length;
    if (!n) return;
    cards.prev.innerHTML = buildCardHtml(articles[(currentIndex - 1 + n) % n]);
    cards.curr.innerHTML = buildCardHtml(articles[currentIndex]);
    cards.next.innerHTML = buildCardHtml(articles[(currentIndex + 1) % n]);
  }

  /* ================= 详情页 ================= */

  var detailOpen = false;   // 详情页是否展开
  var detailPushed = false; // 是否已 pushState（安卓返回键支持）

  function fillDetail(article) {
    detailImg.style.display = article.cover ? '' : 'none';
    detailImg.onerror = function () {
      // 主图失败 → 回退到相关关键词图，再失败隐藏（留灰色占位）
      var fb = article.coverAlt;
      if (fb && detailImg.src !== fb) {
        detailImg.src = fb;
      } else {
        this.style.display = 'none';
      }
    };
    detailImg.src = article.cover || '';
    detailTitle.textContent = article.title;
    detailMeta.textContent = article.meta;
    detailText.innerHTML = paragraphsHtml(article.text);
    detailEl.scrollTop = 0;
  }

  function openDetail() {
    if (!articles.length || isAnimating || detailOpen) return;
    fillDetail(articles[currentIndex]);
    detailEl.classList.add('show');
    detailOpen = true;
    // 压入历史记录：安卓物理返回键可关闭详情页
    history.pushState({ sr: 'detail' }, '');
    detailPushed = true;
  }

  function closeDetail(fromPop) {
    if (!detailOpen) return;
    detailEl.classList.remove('show');
    detailOpen = false;
    if (detailPushed && !fromPop) history.back();
    detailPushed = false;
  }

  backBtn.addEventListener('click', function () { closeDetail(false); });
  window.addEventListener('popstate', function () {
    if (detailOpen) closeDetail(true);
  });

  /* ================= 手势翻页 ================= */

  var touch = {
    active: false,
    mode: 'pending',   // pending | scroll | drag
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    t0: 0,
    dy: 0,
    contentEl: null
  };
  var TAP_MAX_MOVE = 10;     // 轻点判定：位移小于该值
  var TAP_MAX_DUR = 350;     // 轻点判定：时长小于该值 ms

  function setTransition(on) {
    track.style.transition = on ? 'transform 0.28s ease-out' : 'none';
  }

  function gestureStart(x, y, target) {
    if (!articles.length || isAnimating) return;
    touch.active = true;
    touch.mode = 'pending';
    touch.startX = x;
    touch.startY = y;
    touch.lastX = x;
    touch.lastY = y;
    touch.t0 = Date.now();
    touch.dy = 0;
    touch.contentEl = target && target.closest ? target.closest('.content') : null;
  }

  // 返回 true 表示需要 preventDefault
  function gestureMove(x, y) {
    if (!touch.active) return false;
    touch.lastX = x;
    touch.lastY = y;
    var dx = x - touch.startX;
    var dy = y - touch.startY;

    if (touch.mode === 'pending') {
      if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) return false;
      // 横向滑动：不处理
      if (Math.abs(dx) > Math.abs(dy)) {
        touch.mode = 'scroll';
        return false;
      }
      // 内容可继续滚动时，让位给原生滚动，禁止触发卡片切换
      var content = touch.contentEl;
      if (content) {
        var canScrollUp = content.scrollTop + content.clientHeight < content.scrollHeight - 1;
        var canScrollDown = content.scrollTop > 1;
        if ((dy < 0 && canScrollUp) || (dy > 0 && canScrollDown)) {
          touch.mode = 'scroll';
          return false;
        }
      }
      touch.mode = 'drag';
      setTransition(false);
    }

    if (touch.mode === 'drag') {
      touch.dy = dy;
      track.style.transform = 'translateY(' + dy + 'px)';
      return true;
    }
    return false;
  }

  function gestureEnd() {
    if (!touch.active) return;
    touch.active = false;
    // 轻点（几乎无位移、短按）→ 打开详情页
    if (touch.mode === 'pending') {
      var moved = Math.abs(touch.lastX - touch.startX) + Math.abs(touch.lastY - touch.startY);
      var duration = Date.now() - touch.t0;
      if (moved < TAP_MAX_MOVE && duration < TAP_MAX_DUR) openDetail();
      return;
    }
    if (touch.mode !== 'drag') {
      touch.mode = 'pending';
      return;
    }
    touch.mode = 'pending';
    var dy = touch.dy;
    setTransition(true);
    if (dy <= -SWIPE_THRESHOLD) {
      animateFlip(1);   // 上滑 → 下一篇
    } else if (dy >= SWIPE_THRESHOLD) {
      animateFlip(-1);  // 下滑 → 上一篇
    } else {
      // 未达阈值 → 回弹
      track.style.transform = 'translateY(0)';
    }
  }

  function gestureCancel() {
    if (touch.mode === 'drag') {
      setTransition(true);
      track.style.transform = 'translateY(0)';
    }
    touch.active = false;
    touch.mode = 'pending';
  }

  // 执行翻页动画：dir = 1 下一篇 / -1 上一篇（手势与按钮共用）
  function animateFlip(dir) {
    if (!articles.length || isAnimating) return;
    setTransition(true);
    track.style.transform = 'translateY(' + (-100 * dir) + '%)';
    settleTo(dir);
  }

  // 翻页动画结束后更新索引并重渲染
  function settleTo(dir) {
    isAnimating = true;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      track.removeEventListener('transitionend', finish);
      currentIndex = (currentIndex + dir + articles.length) % articles.length;
      setTransition(false);
      track.style.transform = 'translateY(0)';
      renderWindow();
      // 详情页展开中翻页：同步切换详情内容
      if (detailOpen) fillDetail(articles[currentIndex]);
      isAnimating = false;
    }
    track.addEventListener('transitionend', finish);
    setTimeout(finish, 350); // 兜底
  }

  /* ---- 触摸事件（安卓优先） ---- */
  viewport.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    gestureStart(t.clientX, t.clientY, e.target);
  }, { passive: true });

  viewport.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (gestureMove(t.clientX, t.clientY)) e.preventDefault();
  }, { passive: false });

  viewport.addEventListener('touchend', gestureEnd);
  viewport.addEventListener('touchcancel', gestureCancel);

  /* ---- 鼠标事件（桌面调试兼容） ---- */
  var mouseDown = false;
  viewport.addEventListener('mousedown', function (e) {
    mouseDown = true;
    gestureStart(e.clientX, e.clientY, e.target);
  });
  window.addEventListener('mousemove', function (e) {
    if (!mouseDown) return;
    if (gestureMove(e.clientX, e.clientY)) e.preventDefault();
  });
  window.addEventListener('mouseup', function () {
    if (!mouseDown) return;
    mouseDown = false;
    gestureEnd();
  });

  /* ================= 状态视图 ================= */

  function showState(name) {
    loadingEl.classList.toggle('show', name === 'loading');
    errorEl.classList.toggle('show', name === 'error');
    viewport.style.visibility = name ? 'hidden' : 'visible';
  }

  /* ================= 加载流程 ================= */

  function loadArticles() {
    closeDetail(false); // 刷新时关闭详情页（同步回退历史记录）
    showState('loading');
    var chain = Promise.reject();
    // 依次尝试接口列表
    API_LIST.forEach(function (url) {
      chain = chain.catch(function () { return fetchWithTimeout(url, FETCH_TIMEOUT); });
    });
    chain.then(function (raw) {
      articles = normalize(raw);
      currentIndex = 0;
      setTransition(false);
      track.style.transform = 'translateY(0)';
      renderWindow();
      showState(null);
    }).catch(function () {
      errorMsgEl.textContent = '网络异常，请检查网络连接后重试';
      showState('error');
    });
  }

  retryBtn.addEventListener('click', loadArticles);

  /* ================= 底部按钮绑定真实功能 ================= */

  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var action = btn.getAttribute('data-action');
      if (action === 'prev') {
        animateFlip(-1);
      } else if (action === 'next') {
        animateFlip(1);
      } else if (action === 'refresh') {
        loadArticles();
      }
      // about 及其他按钮无操作
    });
  });

  /* ================= ServiceWorker 注册 ================= */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略注册失败 */ });
    });
  }

  /* ================= 启动 ================= */

  loadArticles();
})();
