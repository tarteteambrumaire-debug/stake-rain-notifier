// ==UserScript==
// @name         StakePulse
// @namespace    https://stake.bet/stakepulse
// @version      1.1.1
// @description  StakePulse - Rain & Stats tracker pour Stake.bet - by alleluiateam
// @author       alleluiateam
// @match        https://stake.com/*
// @match        https://stake.bet/*
// @match        https://stake.ac/*
// @match        https://stake.games/*
// @match        https://stake.pet/*
// @match        https://stake1001.com/*
// @match        https://stake1002.com/*
// @match        https://stake1003.com/*
// @match        https://stake1017.com/*
// @match        https://stake1022.com/*
// @match        https://stake.mba/*
// @match        https://stake.jp/*
// @match        https://stake.bz/*
// @match        https://staketr.com/*
// @match        https://stake.ceo/*
// @match        https://stake.krd/*
// @match        https://stake1039.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      api.telegram.org
// @connect      api.exchangerate-api.com
// @connect      api.coingecko.com
// @connect      alerte-rain-default-rtdb.europe-west1.firebasedatabase.app
// @connect      publicbackendstakeslots-production.up.railway.app
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js
// ==/UserScript==
(function () {
  'use strict';
  // Regles compteur de mots
  var WORD_RULES = [
    { id: 'monthly',    label: 'Monthly',    pattern: /monthly/i,                senderFilter: null },
    { id: 'glissade',   label: 'Glissade',   pattern: /glissade/i,               senderFilter: null },
    { id: 'aie',        label: 'Aie',        pattern: /a[ii][ee]/i,              senderFilter: null },
    { id: 'reloadout',  label: 'Reload Out', pattern: /reload.{0,3}out/i,        senderFilter: null },
    { id: 'rip',        label: 'Rip',        pattern: /rip/i,                    senderFilter: null },
  ];
  var CONFIG = {
    TELEGRAM_BOT_TOKEN: 'VOTRE_BOT_TOKEN_ICI',
    STAKE_PULSE_TOKEN: '8736690342:AAFu1whZ7SeE072sM42adY_DcRS296mVQn4',
    TELEGRAM_CHAT_ID:   'VOTRE_CHAT_ID_ICI',
    INACTIVITY_MINUTES: 10,
    YOUR_USERNAME:      '',
    WATCH_KEYWORDS:     [],
  };
  var SK = {
    RAIN_LOG:      'srn_rain_log',
    RANKINGS:      'srn_rankings',
    LAST_MSG_TIME: 'srn_last_msg_time',
    USER_CONFIG:   'srn_user_config',
    MENTIONS:      'srn_mentions',
  };
  var SK_DEDUP      = 'srn_dedup';
  var SK_WORDCOUNT  = 'srn_wordcount';
  var SK_DELETED    = 'srn_deleted_mentions';
  var SK_CUSTOMWORDS= 'srn_custom_words';
  var SK_MYSTATS_OFFSET = 'srn_mystats_offset';
  var SK_WAGER = 'srn_wager_v2'; // v2 : inclut game, amount, payout, profit
  var SK_EMOJI_COUNT = 'srn_emoji_count';
  var SK_MULTIP = 'srn_multip';
  var SK_MULTIP_CONFIG = 'srn_multip_config';
  var SK_TABS_CONFIG = 'srn_tabs_config';
  var SK_SETUP_DONE = 'srn_setup_done_v2';
  var SK_RAINERS = 'srn_rainers';
  var DEDUP_TTL     = 4 * 60 * 60 * 1000;
  var DELETED_TTL   = 7 * 24 * 60 * 60 * 1000;
  var WEEKLY_GOAL   = 300;
  function load(key, fallback) {
    if (fallback === undefined) fallback = null;
    try { return JSON.parse(GM_getValue(key, JSON.stringify(fallback))); }
    catch(e) { return fallback; }
  }
  function save(key, value) { GM_setValue(key, JSON.stringify(value)); }
  // Charge les mots custom et les fusionne avec WORD_RULES
  var FIREBASE_URL = 'https://alerte-rain-default-rtdb.europe-west1.firebasedatabase.app';
  var FIREBASE_KEYS = ['srn_rain_log', 'srn_rankings', 'srn_wordcount', 'srn_emoji_count', 'srn_multip', 'srn_wager'];
  var fbSyncTimer = null;
  var lastFbSync = 0;
  function fbGet(path, callback) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: FIREBASE_URL + '/' + path + '.json',
      onload: function(res) {
        try {
          var data = JSON.parse(res.responseText);
          callback(data);
        } catch(e) { callback(null); }
      },
      onerror: function() { callback(null); }
    });
  }
  function fbSet(path, data) {
    GM_xmlhttpRequest({
      method: 'PUT',
      url: FIREBASE_URL + '/' + path + '.json',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: function() {},
      onerror: function() {}
    });
  }
  // Pousse les donnees locales vers Firebase
  function fbPush() {
    var now = Date.now();
    if (now - lastFbSync < 10000) return; // max 1 sync toutes les 10s
    lastFbSync = now;
    FIREBASE_KEYS.forEach(function(key) {
      var val = load(key, null);
      if (val !== null) fbSet('shared/' + key, val);
    });
    console.log('[StakePulse] Sync Firebase OK');
  }
  // Recupere les donnees depuis Firebase et les fusionne
  function fbPull(callback) {
    fbGet('shared', function(data) {
      if (!data) { if (callback) callback(); return; }
      FIREBASE_KEYS.forEach(function(key) {
        if (data[key] !== undefined && data[key] !== null) {
          // Fusion intelligente selon le type
          var local = load(key, null);
          if (Array.isArray(data[key]) && Array.isArray(local)) {
                    var merged = local.slice();
            var localTs = local.map(function(e) { return e.ts; });
            data[key].forEach(function(e) {
              if (e.ts && localTs.indexOf(e.ts) < 0) merged.push(e);
            });
            merged.sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
            if (merged.length > 2000) merged = merged.slice(-2000);
            save(key, merged);
          } else if (typeof data[key] === 'object' && !Array.isArray(data[key]) && typeof local === 'object' && !Array.isArray(local)) {
                    var merged2 = Object.assign({}, data[key], local || {});
            save(key, merged2);
          } else {
            save(key, data[key]);
          }
        }
      });
      console.log('[StakePulse] Pull Firebase OK');
      if (callback) callback();
    });
  }
  function loadCustomWords() {
    var custom = load(SK_CUSTOMWORDS, []);
    custom.forEach(function(w) {
      if (!WORD_RULES.some(function(r) { return r.id === w.id; })) {
        try {
          WORD_RULES.push({ id: w.id, label: w.label, pattern: new RegExp(w.pattern, 'i'), senderFilter: null, custom: true });
        } catch(e) {}
      }
    });
  }
  // Cache des chatIds Firebase
  var fbUserCache = {};
  var fbUserCacheTime = {};
  function getFbChatId(pseudo, callback) {
    if (!pseudo) { callback(null); return; }
    var p = pseudo.toLowerCase();
    // Cache de 5 minutes
    if (fbUserCache[p] && Date.now() - fbUserCacheTime[p] < 5*60*1000) {
      callback(fbUserCache[p]); return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: FIREBASE_URL + '/users/' + p + '.json',
      onload: function(res) {
        try {
          var data = JSON.parse(res.responseText);
          if (data && data.chatId) {
            fbUserCache[p] = data.chatId;
            fbUserCacheTime[p] = Date.now();
            callback(data.chatId);
          } else {
            callback(null);
          }
        } catch(e) { callback(null); }
      },
      onerror: function() { callback(null); }
    });
  }
  function sendTelegramToUser(pseudo, text) {
    getFbChatId(pseudo, function(chatId) {
      if (!chatId) return;
      var token = CONFIG.STAKE_PULSE_TOKEN;
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.telegram.org/bot' + token + '/sendMessage',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
        onload: function() {},
        onerror: function() {}
      });
    });
  }
  function sendTelegram(text, onSuccess, onError) {
    var token = CONFIG.TELEGRAM_BOT_TOKEN;
    var chatId = CONFIG.TELEGRAM_CHAT_ID;
    if (!token || token.indexOf('VOTRE') >= 0) { if (onError) onError('Token manquant'); return; }
    if (!chatId || chatId.indexOf('VOTRE') >= 0) { if (onError) onError('Chat ID manquant'); return; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.telegram.org/bot' + token + '/sendMessage',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
      onload: function(res) {
        try {
          var json = JSON.parse(res.responseText);
          if (json.ok) { if (onSuccess) onSuccess(); }
          else { if (onError) onError('Telegram erreur: ' + (json.description || '') + ' (code ' + json.error_code + ')'); }
        } catch(e) { if (onError) onError('Reponse invalide'); }
      },
      onerror: function() { if (onError) onError('Erreur reseau'); },
    });
  }
  var RAIN_TRIGGERS = [
    /a donn[ee] [aa] \d+ utilisateurs/i,
    /a donn[ee] [aa] \d+ users/i,
    /rained .* on \d+ users/i,
    /tipping everyone/i,
    /shared.*with the chat/i,
    /chacun:/i,
  ];
  var AMOUNT_RE = /([\d,.]+)\s*(BTC|ETH|USDT|USD|LTC|XRP|DOGE|BNB|TRX|EOS|MATIC|SOL)/i;
  function looksLikeRain(text) {
    return RAIN_TRIGGERS.some(function(p) { return p.test(text); });
  }
  function parseRainMessage(text) {
    var euroMatch = text.match(/\u20ac\s*([\d]+[.,][\d]+|[\d]+)/);
    var am = text.match(AMOUNT_RE);
    var amount = null, currency = '\u20ac';
    if (euroMatch) { amount = parseFloat(euroMatch[1].replace(',', '.')); currency = '\u20ac'; }
    else if (am) { amount = parseFloat(am[1].replace(/,/g, '')); currency = am[2].toUpperCase(); }
    // Extrait le sender depuis le texte : "[Sender] a donne a N utilisateurs"
    var senderFromText = null;
    var senderMatch = text.match(/([A-Za-z0-9_]{2,25})\s+a\s+donn/i);
    if (senderMatch) senderFromText = senderMatch[1].trim();
    if (!senderFromText && text.toLowerCase().indexOf("rain bot") >= 0) senderFromText = "Rain Bot";
    var recipients = [];
    var afterColon = text.match(/(?:chacun|each)[^:]*:\s*(.+)$/i);
    if (afterColon) {
      var cleaned = afterColon[1].replace(/\bME\s+([A-Za-z0-9_]+)/g, '$1');
      recipients = cleaned.split(',').reduce(function(acc, s) {
        s.trim().split(/\s+/).forEach(function(w) { acc.push(w.trim()); });
        return acc;
      }, []).filter(function(s) { return s.length >= 2 && /^[A-Za-z0-9_]+$/.test(s) && s.toUpperCase() !== 'ME'; });
    }
    return { amount: amount, currency: currency, recipients: recipients, raw: text, senderFromText: senderFromText };
  }
  function trackWordCount(text, sender) {
    var wordKey = "w|" + text.substring(0, 80).trim().toLowerCase();
    if (seenWordKeys.has(wordKey)) return;
    var persistW = loadPersistDedup();
    if (persistW[wordKey]) { seenWordKeys.add(wordKey); return; }
    seenWordKeys.add(wordKey);
    persistW[wordKey] = Date.now();
    var wEntries = Object.entries(persistW).sort(function(a,b){return b[1]-a[1];}).slice(0, 300);
    save(SK_DEDUP, Object.fromEntries(wEntries));
    var now = Date.now();
    var counts = load(SK_WORDCOUNT, []);
    var matched = false;
    WORD_RULES.forEach(function(rule) {
      if (!rule.pattern.test(text)) return;
      if (rule.senderFilter && (!sender || sender.toLowerCase() !== rule.senderFilter.toLowerCase())) return;
      counts.push({ id: rule.id, ts: now });
      matched = true;
    });
    if (matched) {
      var yearAgo = now - 365 * 24 * 3600 * 1000;
      counts = counts.filter(function(c) { return c.ts > yearAgo; });
      if (counts.length > 5000) counts = counts.slice(-5000);
      save(SK_WORDCOUNT, counts);
    }
  }
  // +1 manuel
  function addManualCount(id) {
    var counts = load(SK_WORDCOUNT, []);
    counts.push({ id: id, ts: Date.now() });
    save(SK_WORDCOUNT, counts);
    renderModeration();
  }
  function findMatchingKeywords(text) {
    if (!CONFIG.WATCH_KEYWORDS || !CONFIG.WATCH_KEYWORDS.length) return [];
    var lower = text.toLowerCase();
    return CONFIG.WATCH_KEYWORDS.filter(function(kw) {
      if (!kw) return false;
      var k = kw.toLowerCase().replace(/^@/, '');
      return lower.indexOf('@' + k) >= 0;
    });
  }
  var lastMentionKey = '';
  function checkAndNotifyMention(text, sender) {
    var matches = findMatchingKeywords(text);
    if (!matches.length) return;
    if (looksLikeRain(text)) return;
    var words = text.trim().split(/\s+/);
    if (words.some(function(w) { return w.length > 40; })) return;
    var myUsername = (CONFIG.YOUR_USERNAME || '').toLowerCase().trim();
    if (myUsername && sender && sender.toLowerCase() === myUsername) return;
    if (sender && sender.toUpperCase() === 'ME') return;
    if (!sender && text.trim().toUpperCase().indexOf('ME ') === 0) return;
    if (myUsername && !sender) {
      var firstWord = text.trim().split(' ')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (firstWord === myUsername) return;
    }
    // Dedup base sur le texte uniquement (pas le sender) pour eviter les doublons
    // quand le meme message est capte via WS et via DOM avec des senders differents
    var key = text.substring(0, 80);
    if (lastMentionKey === key) return;
    lastMentionKey = key;
    var deletedMap = load(SK_DELETED, {});
    var msgKey = text.substring(0, 80);
    if (deletedMap[msgKey]) return;
    // Sauvegarde mention
    var mentions = load(SK.MENTIONS, []);
    var alreadyExists = mentions.some(function(m) { return m.text.substring(0, 80) === msgKey; });
    if (!alreadyExists) {
      mentions.unshift({ id: Date.now(), ts: Date.now(), sender: sender || 'Inconnu', text: text.substring(0, 300), msgKey: msgKey, read: false });
      if (mentions.length > 100) mentions = mentions.slice(0, 100);
      save(SK.MENTIONS, mentions);
    }
    refreshPanel();
    var kws = matches.map(function(k) { return '<b>@' + k.replace(/^@/, '') + '</b>'; }).join(', ');
    // Retire le "pseudo: " du debut du preview pour ne pas doubonner avec "Par :"
    var previewText = text.replace(/^[\s\u00a0\u200b]*[A-Za-z0-9_]{2,25}:\s*/, '').trim();
    var preview = previewText.length > 120 ? previewText.substring(0, 120) + '...' : previewText;
    sendTelegram(
      '\uD83D\uDD14 <b>Tu as ete mentionne sur Stake !</b>\n' +
      '\uD83D\uDC64 Par : <b>' + escHtml(sender || 'Inconnu') + '</b>\n' +
      '\uD83C\uDFF7 Mot-cle : ' + kws + '\n' +
      '\uD83D\uDCAC "' + escHtml(preview) + '"\n' +
      '\uD83D\uDD50 ' + new Date().toLocaleTimeString('fr-FR')
    );
    showNotif('Mention @' + matches[0] + ' par ' + (sender || 'quelqun') + ' sur Stake !');
  }
  function recordRain(sender, parsed) {
    var rainKey = (parsed.amount || '') + '|' + (parsed.recipients || []).slice(0,3).join(',');
    if (rainKey === lastRainKey && Date.now() - lastRainTime < 10000) return;
    lastRainKey = rainKey; lastRainTime = Date.now();
    var now = Date.now();
    // Priorite au sender extrait du texte (plus fiable que le DOM)
    if (parsed.senderFromText) sender = parsed.senderFromText;
    var log = load(SK.RAIN_LOG, []);
    var entry = { ts: now, date: new Date().toISOString(), sender: sender || 'Inconnu', amount: parsed.amount, currency: parsed.currency, recipients: parsed.recipients, raw: parsed.raw.substring(0, 300) };
    log.push(entry);
    if (log.length > 1000) log.splice(0, log.length - 1000);
    save(SK.RAIN_LOG, log);
    updateRankings(entry);
    // Sauvegarde aussi le sender dans SK_RAINERS
    var rainers = load(SK_RAINERS, []);
    rainers.push({ ts: entry.ts, sender: entry.sender, amount: entry.amount, currency: entry.currency });
    if (rainers.length > 2000) rainers = rainers.slice(-2000);
    save(SK_RAINERS, rainers);
    // Notifie chaque destinataire via Firebase
    parsed.recipients.forEach(function(recipient) {
      sendTelegramToUser(recipient,
        '\uD83C\uDF27 <b>Tu as recu une rain !</b>\nDe : <b>' + escHtml(sender || 'Inconnu') + '</b>' +
        (parsed.amount ? '\nMontant : <b>' + parsed.amount + ' ' + parsed.currency + '</b>' : '') +
        '\n\uD83D\uDD50 ' + new Date().toLocaleTimeString('fr-FR')
      );
    });
    var youReceived = CONFIG.YOUR_USERNAME && parsed.recipients.some(function(r) { return r.toLowerCase() === CONFIG.YOUR_USERNAME.toLowerCase(); });
    var amtStr = parsed.amount ? '\n\uD83D\uDCB0 Montant/joueur : <b>' + parsed.amount + ' ' + parsed.currency + '</b>' : '';
    var recStr = parsed.recipients.length > 0 ? '\n\uD83D\uDC65 ' + parsed.recipients.length + ' joueur(s) : ' + parsed.recipients.slice(0, 8).join(', ') + (parsed.recipients.length > 8 ? '...' : '') : '';
    sendTelegram((youReceived ? '\uD83C\uDF89 <b>TU AS RECU UNE RAIN !</b>' : '\uD83C\uDF27 <b>Rain sur Stake.bet</b>') + '\n\uD83D\uDC64 De : <b>' + escHtml(sender || 'Inconnu') + '</b>' + amtStr + recStr + '\n\uD83D\uDD50 ' + new Date().toLocaleTimeString('fr-FR'));
    // Animation si >= 10 euros
    if (parsed.amount && (parsed.currency === '\u20ac' || parsed.currency === 'EUR') && parsed.amount >= 10) {
      showRainAnimation(parsed.amount);
    }
    refreshPanel();
  }
  function showMultipAnimation(game, multi) {
    var anim = document.createElement('div');
    anim.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999999;pointer-events:none;text-align:center;animation:srnRainAnim 3s ease-out forwards';
    anim.innerHTML = '<div style="display:inline-block;margin-top:40px;background:linear-gradient(135deg,#0f1923,#1a0f23);border:2px solid #ffd700;border-radius:16px;padding:20px 40px;box-shadow:0 0 40px #ffd70044">'
      + '<div style="font-size:36px">&#127775;</div>'
      + '<div style="color:#ffd700;font-size:26px;font-weight:800;margin:6px 0">x' + multi.toFixed(2) + '</div>'
      + '<div style="color:#fff;font-size:14px;margin-top:4px">' + escHtml(game) + '</div>'
      + '</div>';
    document.body.appendChild(anim);
    setTimeout(function() { if (anim.parentNode) anim.parentNode.removeChild(anim); }, 3500);
  }
  function showRainAnimation(amount) {
    var anim = document.createElement('div');
    anim.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999999;pointer-events:none;text-align:center;animation:srnRainAnim 3s ease-out forwards';
    anim.innerHTML = '<div style="display:inline-block;margin-top:40px;background:linear-gradient(135deg,#0f1923,#162330);border:2px solid #00d4ff;border-radius:16px;padding:20px 40px;box-shadow:0 0 40px #00d4ff44">' +
      '<div style="font-size:40px">&#127783;</div>' +
      '<div style="color:#00d4ff;font-size:24px;font-weight:800;margin:8px 0">RAIN !</div>' +
      '<div style="color:#fff;font-size:20px;font-weight:700">' + amount.toFixed(2) + '\u20ac / joueur</div>' +
      '</div>';
    document.body.appendChild(anim);
    setTimeout(function() { if (anim.parentNode) anim.parentNode.removeChild(anim); }, 3500);
  }
  function getWeekStart(date) {
    var d = new Date(date);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function getMonthStart(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
  function updateRankings(entry) {
    var rankings = load(SK.RANKINGS, {});
    var now = new Date();
    var weekStart = getWeekStart(now).getTime();
    var monthStart = getMonthStart(now).getTime();
    entry.recipients.forEach(function(username) {
      if (!rankings[username]) rankings[username] = {
        weekly:  { count: 0, totalAmount: 0, currency: entry.currency, _start: weekStart },
        monthly: { count: 0, totalAmount: 0, currency: entry.currency, _start: monthStart },
        allTime: { count: 0, totalAmount: 0, currency: entry.currency },
      };
      var p = rankings[username];
      if (!p.weekly._start  || p.weekly._start  < weekStart)  p.weekly  = { count: 0, totalAmount: 0, currency: entry.currency, _start: weekStart };
      if (!p.monthly._start || p.monthly._start < monthStart) p.monthly = { count: 0, totalAmount: 0, currency: entry.currency, _start: monthStart };
      p.weekly.count++; p.monthly.count++; p.allTime.count++;
      if (entry.amount) { p.weekly.totalAmount += entry.amount; p.monthly.totalAmount += entry.amount; p.allTime.totalAmount += entry.amount; }
    });
    save(SK.RANKINGS, rankings);
  }
  function getTopN(period, n) {
    var rankings = load(SK.RANKINGS, {});
    var now = new Date();
    var weekStart = getWeekStart(now).getTime();
    var monthStart = getMonthStart(now).getTime();
    return Object.entries(rankings)
      .filter(function(e) {
        var p = e[1];
        if (period === 'weekly')  return p.weekly._start  >= weekStart;
        if (period === 'monthly') return p.monthly._start >= monthStart;
        return true;
      })
      .map(function(e) { return Object.assign({ username: e[0] }, e[1][period]); })
      .sort(function(a, b) { return (b.totalAmount - a.totalAmount) || (b.count - a.count); })
      .slice(0, n);
  }
  function sendRankingToTelegram(period) {
    var top = getTopN(period, 10);
    var label = { weekly: 'Cette semaine', monthly: 'Ce mois', allTime: 'Tout temps' }[period];
    if (!top.length) { sendTelegram(label + ' - Aucune rain enregistree.'); return; }
    var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    var lines = top.map(function(p, i) {
      var isEuro = (p.currency === '\u20ac' || p.currency === 'EUR');
      var amtStr = p.totalAmount > 0 ? (isEuro ? ' - ' + p.totalAmount.toFixed(2) + '\u20ac' : ' - ' + p.totalAmount.toFixed(6) + ' ' + (p.currency || '')) : '';
      return (medals[i] || (i+1) + '.') + ' <b>' + escHtml(p.username) + '</b> - ' + p.count + ' rain' + (p.count > 1 ? 's' : '') + amtStr;
    }).join('\n');
    sendTelegram('\uD83C\uDFC6 Classement rains recues - ' + label + '\n\n' + lines);
  }
  var seenMessages = new Set();
  var seenWordKeys = new Set(); // deduplication trackWordCount
  var lastRainKey = ''; var lastRainTime = 0;
  function loadPersistDedup() {
    try {
      var raw = load(SK_DEDUP, {});
      var now = Date.now();
      var cleaned = {};
      Object.keys(raw).forEach(function(k) { if (now - raw[k] < DEDUP_TTL) cleaned[k] = raw[k]; });
      return cleaned;
    } catch(e) { return {}; }
  }
  function isDuplicate(key) {
    var normalized = key.trim().toLowerCase().substring(0, 120);
    if (seenMessages.has(normalized)) return true;
    var persist = loadPersistDedup();
    if (persist[normalized]) { seenMessages.add(normalized); return true; }
    seenMessages.add(normalized);
    persist[normalized] = Date.now();
    var entries = Object.entries(persist).sort(function(a,b){return b[1]-a[1];}).slice(0, 200);
    save(SK_DEDUP, Object.fromEntries(entries));
    if (seenMessages.size > 800) seenMessages = new Set([...seenMessages].slice(-500));
    return false;
  }
  function processMessage(text, sender) {
    if (!text || text.length < 2) return;
    // PRIORITE 1 : extraire le pseudo auteur depuis le debut du texte.
    // Format Stake : "Poulpe10: @alleluiateam ..." — le pseudo est dans les 30 premiers chars.
    // On cherche dans les 30 premiers caracteres (apres trim) pour gerer espaces/chars invisibles.
    if (text) {
      var trimmed = text.replace(/^[\s\u00a0\u200b\u200c\u200d\ufeff]+/, '');
      var m = trimmed.match(/^([A-Za-z0-9_]{2,25}):\s/);
      if (m) { sender = m[1]; }
      else {
        // 2e chance : le pseudo peut etre apres un emoji ou un caractere non-alphanum en debut
        var m2 = text.match(/(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]{2,25}):\s/);
        if (m2 && text.indexOf(m2[1] + ':') < 35) sender = m2[1];
      }
    }
    trackWordCount(text, sender);
    var key = text.substring(0, 100);
    if (isDuplicate(key)) return;
    checkAndNotifyMention(text, sender);
    if (looksLikeRain(text)) {
      var parsed = parseRainMessage(text);
      recordRain(sender, parsed);
    }
  }
  function interceptWebSocket() {
    // Injection dans la page via <script> pour intercepter avant les WS natifs
    var code = [
      '(function() {',
      '  var OrigWS = window.WebSocket;',
      '  window.WebSocket = function(url, protocols) {',
      '    var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);',
      '    ws.addEventListener("message", function(event) {',
      '      try {',
      '        var d = JSON.parse(event.data);',
      '        window.dispatchEvent(new CustomEvent("srn_ws_message", { detail: d }));',
      '      } catch(e) {}',
      '    });',
      '    return ws;',
      '  };',
      '  Object.assign(window.WebSocket, OrigWS);',
      '  window.WebSocket.prototype = OrigWS.prototype;',
      '})();'
    ].join("\n");
    var s = document.createElement("script");
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    // Ecoute les messages WS depuis la page
    window.addEventListener("srn_ws_message", function(e) {
      try { scanPayload(e.detail); } catch(err) {}
    });
  }
  function scanPayload(data) {
    walkObject(data, function(obj) {
      var text = obj.message || obj.text || obj.content || obj.body || '';
      var sender = obj.username || obj.displayName || obj.name ||
        (obj.user && (obj.user.username || obj.user.displayName || obj.user.name)) ||
        (obj.author && (obj.author.username || obj.author.displayName || obj.author.name)) ||
        (obj.createdBy && (obj.createdBy.username || obj.createdBy.name)) ||
        (obj.profile && (obj.profile.username || obj.profile.name)) ||
        obj.sender || null;
      if (typeof text === 'string' && text.length >= 2) processMessage(text, sender);
    });
    walkForMultiplier(data);
    if (Object.keys(data).length > 0)
    walkForBet(data);
  }
  var _fetch = window.fetch;
  window.fetch = function() {
    var args = Array.prototype.slice.call(arguments);
    return _fetch.apply(this, args).then(function(res) {
      try {
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (url.indexOf('graphql') >= 0 || url.indexOf('chat') >= 0) {
          res.clone().json().then(function(d) {
            var s = JSON.stringify(d);
            if (s.indexOf('amount') > -1 || s.indexOf('payout') > -1 || s.indexOf('profit') > -1) {
            }
            scanPayload(d);
          }).catch(function(){});
        }
      } catch(e) {}
      return res;
    });
  };
  function findSenderFromNode(node) {
    // Strategie 1 : attributs data-* portant le pseudo (data-username, data-user, etc.)
    var el = node;
    for (var i = 0; i < 15 && el; i++) {
      var dataUser = el.getAttribute && (
        el.getAttribute('data-username') ||
        el.getAttribute('data-user') ||
        el.getAttribute('data-author') ||
        el.getAttribute('data-sender')
      );
      if (dataUser && /^[A-Za-z0-9_]{2,25}$/.test(dataUser.trim())) return dataUser.trim();
      el = el.parentElement;
    }
    // Strategie 2 : lien profil /user/NOM — UNIQUEMENT dans le noeud lui-meme
    // (pas de remontee parentElement : on attraperait les messages voisins du DOM)
    if (node.querySelectorAll) {
      var links = node.querySelectorAll('a[href*="/user/"]');
      for (var li = 0; li < links.length; li++) {
        var href = links[li].getAttribute('href') || '';
        var hm = href.match(/\/user\/([A-Za-z0-9_]{2,25})/);
        if (hm) return hm[1];
      }
    }
    // Strategie 3 : conteneur de message (class message/chat/ctainer/row/item)
    el = node;
    for (var i3 = 0; i3 < 15 && el; i3++) {
      var cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal ? el.className.baseVal : '');
      if (cls && /message|chat|ctainer|row|item/i.test(cls)) {
        // Priorite aux elements avec class user/author/name/sender
        var userEls = el.querySelectorAll('[class*="user"],[class*="author"],[class*="name"],[class*="sender"]');
        for (var ui = 0; ui < userEls.length; ui++) {
          var t = (userEls[ui].textContent || '').trim();
          if (t.length >= 2 && t.length <= 25 && /^[A-Za-z0-9_]+$/.test(t)) return t;
        }
        // Fallback : premier span/a/button valide
        var spans = el.querySelectorAll('span, a, button');
        for (var j = 0; j < spans.length; j++) {
          var t2 = (spans[j].textContent || '').trim();
          if (t2.length >= 2 && t2.length <= 25 && /^[A-Za-z0-9_]+$/.test(t2)) return t2;
        }
        break;
      }
      el = el.parentElement;
    }
    return null;
  }
  // Capture bets via WebSocket (voir scanForBet)
  // observeBets() supprime — capture via WebSocket dans scanForBet()
  function getMultipConfig() {
    return load(SK_MULTIP_CONFIG, {
      globalThreshold: 100,
      enabled: true,
      games: [], // [{name, threshold}]
    });
  }
  function getMultipThresholdForGame(gameName) {
    var cfg = getMultipConfig();
    if (!cfg.enabled) return null;
    var gn = (gameName || '').toLowerCase().trim();
    var gameRule = (cfg.games || []).find(function(g) {
      return g.name && gn.indexOf(g.name.toLowerCase()) >= 0;
    });
    return gameRule ? gameRule.threshold : cfg.globalThreshold;
  }
  // Notifie si le multiplicateur depasse le seuil
  var lastMultipKey = '';
  function checkMultiplier(gameName, multiplier) {
    var threshold = getMultipThresholdForGame(gameName);
    if (threshold === null) return;
    // Ignore les valeurs trop proches de 1 pour eviter les faux positifs
    if (multiplier < Math.max(threshold, 1.01)) return;
    var key = (gameName || '') + '|' + Math.round(multiplier * 100) + '|' + Math.floor(Date.now() / 5000);
    if (key === lastMultipKey) return;
    lastMultipKey = key;
    var log = load(SK_MULTIP, []);
    log.unshift({
      ts: Date.now(),
      game: gameName || 'Inconnu',
      multiplier: multiplier,
      threshold: threshold,
    });
    if (log.length > 500) log = log.slice(0, 500);
    save(SK_MULTIP, log);
    // Notification navigateur
    // Animation sur la page
    showMultipAnimation(gameName || 'Inconnu', multiplier);
    var msg = '\uD83C\uDFB0 x' + multiplier.toFixed(2) + ' sur ' + (gameName || 'Inconnu') + ' ! (seuil : x' + threshold + ')';
    showNotif(msg);
    console.log('[StakePulse] Multiplicateur :', multiplier, 'sur', gameName, '| Seuil :', threshold);
    if (curTab === 'multip') renderMultip();
  }
  // Champs multiplicateur connus dans l'API Stake (elargi)
  var MULTIP_FIELDS = [
    'multiplier','payoutMultiplier','currentMultiplier','winMultiplier',
    'crashPoint','result_multiplier','cashoutMultiplier','bustedAt',
    'payout','payoutMultiplier','outcomeMultiplier','resultMultiplier',
    'betMultiplier','value','profit','nonce',
  ];
  // Champs qui contiennent le nom du jeu
  var GAME_FIELDS = [
    'game','gameName','slug','gameSlug','name','identifier','type',
  ];
  // Mode debug : logue dans la console tous les objets WS contenant des champs suspects
  var MULTIP_DEBUG = false; // passe a true via window._srn.enableMultipDebug()
  function extractGame(obj) {
    for (var i = 0; i < GAME_FIELDS.length; i++) {
      var v = obj[GAME_FIELDS[i]];
      if (typeof v === 'string' && v.length > 1 && v.length < 60) return v;
      if (v && typeof v === 'object') {
        var inner = v.name || v.slug || v.identifier || v.title;
        if (typeof inner === 'string' && inner.length > 1) return inner;
      }
    }
    return null;
  }
  function scanForMultiplier(obj) {
    var mult = null;
    var foundField = null;
    for (var i = 0; i < MULTIP_FIELDS.length; i++) {
      var f = MULTIP_FIELDS[i];
      var raw = obj[f];
      if (raw === undefined || raw === null) continue;
      var m = parseFloat(raw);
      // Un multiplicateur valide : >= 1 et raisonnable (pas un timestamp ou un ID)
      if (isFinite(m) && m >= 1 && m < 1000000 && String(raw).length <= 10) {
        mult = m; foundField = f; break;
      }
    }
    if (mult === null) return;
    var game = extractGame(obj);
    if (MULTIP_DEBUG) {
      console.log('[StakePulse][MULTIP DEBUG] field=' + foundField + ' mult=' + mult + ' game=' + game, JSON.stringify(obj).substring(0, 200));
    }
    checkMultiplier(game, mult);
  }
  // Champs montant mise
  var BET_AMOUNT_FIELDS = ['amount','betAmount','wager','stake'];
  // Champs payout/gain
  var BET_PAYOUT_FIELDS = ['payout','payoutAmount','winAmount','cashout','profit'];
  // Deduplication bets WS
  var seenBetIds = new Set();

  function scanForBet(obj, parentObj) {
    // Doit avoir un identifiant unique (id ou nonce) pour eviter doublons
    var betId = obj.id || obj.nonce || obj.betId || null;
    // Doit etre un CasinoBet (typename)
    if (obj.__typename && obj.__typename !== 'CasinoBet') return;
    // Doit avoir un montant mise
    var amount = null;
    for (var i = 0; i < BET_AMOUNT_FIELDS.length; i++) {
      var raw = obj[BET_AMOUNT_FIELDS[i]];
      if (raw !== undefined && raw !== null) {
        var v = parseFloat(raw);
        if (isFinite(v) && v > 0 && v < 100000) { amount = v; break; }
      }
    }
    if (amount === null) return;
    // Doit avoir un payout (bet termine)
    var payout = null;
    for (var j = 0; j < BET_PAYOUT_FIELDS.length; j++) {
      var rawp = obj[BET_PAYOUT_FIELDS[j]];
      if (rawp !== undefined && rawp !== null) {
        var vp = parseFloat(rawp);
        if (isFinite(vp) && vp >= 0) { payout = vp; break; }
      }
    }
    if (payout === null) return;
    // Filtre strict : n'accepter que les bets avec un user qui correspond au notre
    var betUser = (obj.user && (obj.user.name || obj.user.username)) || null;
    var myUser = (CONFIG.YOUR_USERNAME || '').toLowerCase().trim();
    // Si pas de username configure, on n'enregistre rien
    if (!myUser) return;
    // Si pas de user dans le bet, on n'enregistre pas (trop risque de capter les autres)
    if (!betUser) return;
    // Si le user du bet n'est pas le notre, on ignore
    if (betUser.toLowerCase() !== myUser) return;
    // Deduplication
    var dedupKey = betId ? String(betId) : (String(amount) + '|' + String(payout) + '|' + Math.floor(Date.now()/2000));
    if (seenBetIds.has(dedupKey)) return;
    seenBetIds.add(dedupKey);
    if (seenBetIds.size > 500) seenBetIds = new Set([...seenBetIds].slice(-300));
    // Devise depuis l'objet lui-meme
    var currency = (obj.currency || 'crypto').toUpperCase();
    // Nom du jeu : cherche dans l'objet parent ou l'objet lui-meme
    var game = extractGame(obj) || (parentObj ? extractGame(parentObj) : null) || 'Inconnu';
    game = game.replace(/-/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); }).trim();
    var profit = payout - amount;
    // Refresh prix crypto si vieux de plus de 5 min
    if (Date.now() - cryptoLastFetch > 5 * 60 * 1000) fetchCryptoPrices(null);
    var amountFiat = cryptoToFiat(amount, currency);
    var payoutFiat = cryptoToFiat(payout, currency);
    var profitFiat = payoutFiat - amountFiat;
    var entry = { ts: Date.now(), game: game, amount: amount, payout: payout, profit: profit,
                  amountFiat: amountFiat, payoutFiat: payoutFiat, profitFiat: profitFiat,
                  currency: currency, fiat: userFiatCurrency };
    var wager = load(SK_WAGER, []);
    wager.push(entry);
    var twoYears = Date.now() - 2*365*24*3600*1000;
    wager = wager.filter(function(w){ return w.ts > twoYears; });
    if (wager.length > 5000) wager = wager.slice(-5000);
    save(SK_WAGER, wager);
    console.log('[StakePulse] Bet WS:', game, '(' + currency + ') | mise:', amountFiat.toFixed(2) + userFiatSymbol, '| profit:', profitFiat.toFixed(2) + userFiatSymbol);
    if (curTab === 'wager') renderWager();
  }

  function walkForBet(data, parentObj) {
    if (!data || typeof data !== 'object') return;
    scanForBet(data, parentObj);
    var vals = Object.values(data);
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] && typeof vals[i] === 'object') walkForBet(vals[i], data);
    }
  }

  function walkForMultiplier(data) {
    if (!data || typeof data !== 'object') return;
    scanForMultiplier(data);
    var vals = Object.values(data);
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] && typeof vals[i] === 'object') walkForMultiplier(vals[i]);
    }
  }
  // Outil de debug : active les logs detailles dans la console
  // Usage : dans la console du navigateur, taper : _srn.enableMultipDebug()
  window._srnEnableMultipDebug = function() {
    MULTIP_DEBUG = true;
    console.log('[StakePulse] Mode debug multiplicateur ACTIVE. Joue un bet pour voir les payloads.');
  };
  window._srnDisableMultipDebug = function() {
    MULTIP_DEBUG = false;
    console.log('[StakePulse] Mode debug multiplicateur desactive.');
  };
  var seenEmojiKeys = new Set();
  function trackEmojis(node) {
    if (!node.querySelectorAll) return;
    if (node.id === 'srn-panel' || (node.closest && node.closest('#srn-panel'))) return;
    var imgs = node.querySelectorAll('img');
    if (!imgs.length) return;
    var emojiImgs = Array.from(imgs).filter(function(img) {
      var alt = img.alt || '';
      return /^:[a-z0-9_]+:$/.test(alt);
    });
    if (!emojiImgs.length) return;
    if (emojiImgs.length > 5) return;
    var alts = emojiImgs.map(function(img) { return img.alt; }).join(',');
    var nodeKey = alts + '|' + (node.textContent || '').substring(0, 30);
    if (seenEmojiKeys.has(nodeKey)) return;
    var ek = 'e|' + nodeKey;
    var persist = loadPersistDedup();
    if (persist[ek]) { seenEmojiKeys.add(nodeKey); return; }
    persist[ek] = Date.now();
    var entries = Object.entries(persist).sort(function(a,b){return b[1]-a[1];}).slice(0,300);
    save(SK_DEDUP, Object.fromEntries(entries));
    seenEmojiKeys.add(nodeKey);
    var counts = load(SK_EMOJI_COUNT, {});
    var changed = false;
    emojiImgs.forEach(function(img) {
      var alt = (img.alt || '').replace(/:/g, '').trim().toLowerCase();
      if (!alt || !STAKE_EMOJIS.includes(alt)) return;
      counts[alt] = (counts[alt] || 0) + 1;
      changed = true;
      console.log('[StakePulse] Emoji detecte:', alt);
    });
    if (changed) save(SK_EMOJI_COUNT, counts);
  }
  function observeChat() {
    new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (!node || node.nodeType !== 1) return;
          if (node.id === 'srn-panel') return;
          if (node.closest && node.closest('#srn-panel')) return;
          if (node.tagName && node.tagName.toLowerCase() === 'svg') return;
          var text = node.textContent || '';
          // Filtre strict : ignore tout ce qui est dans ou proche du panneau
          var checkEl = node;
          var inPanel = false;
          for (var pi = 0; pi < 15 && checkEl; pi++) {
            if (checkEl.id === 'srn-panel' || (checkEl.className && typeof checkEl.className === 'string' && checkEl.className.indexOf('srn-') >= 0)) { inPanel = true; break; }
            checkEl = checkEl.parentElement;
          }
          if (inPanel) return;
          if (text.length < 2) return;
          var sender = findSenderFromNode(node);
          var hasUserTags = node.querySelector && node.querySelector('[class*="user-tags"],[class*="tags-only"]');
          var lowerText = text.toLowerCase();
          var hasKeyword = CONFIG.WATCH_KEYWORDS.some(function(kw) {
            var k = kw.toLowerCase().replace(/^@/, '');
            return lowerText.indexOf('@' + k) >= 0;
          });
          if (hasUserTags || hasKeyword || looksLikeRain(text)) {
            console.log('[StakePulse] MSG captured | sender DOM:', sender, '| text RAW:', JSON.stringify(text.substring(0, 80)));
            processMessage(text, sender);
          }
          trackEmojis(node);
          trackWordCount(text, sender);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  function walkObject(obj, cb) {
    if (!obj || typeof obj !== 'object') return;
    cb(obj);
    Object.values(obj).forEach(function(v) { if (v && typeof v === 'object') walkObject(v, cb); });
  }
  var inactivityAlertSent = false;
  function getLastMsgTime() { return parseInt(GM_getValue(SK.LAST_MSG_TIME, '0'), 10); }
  function setLastMsgTime(ts) { GM_setValue(SK.LAST_MSG_TIME, String(ts)); }
  function trackOwnMessages() {
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.getAttribute('contenteditable') === 'true')) {
        if ((a.value || a.textContent || '').trim().length > 0) { setLastMsgTime(Date.now()); inactivityAlertSent = false; }
      }
    });
  }
  function checkInactivity() {
    var last = getLastMsgTime();
    if (!last) return;
    var mins = (Date.now() - last) / 60000;
    if (mins >= CONFIG.INACTIVITY_MINUTES && !inactivityAlertSent) {
      inactivityAlertSent = true;
      sendTelegram('\u23F0 <b>Inactivite !</b>\nTu n\'as pas parle depuis <b>' + Math.round(mins) + ' minutes</b>.');
    }
    refreshPanel();
  }
  function showNotif(msg) {
    if (Notification.permission === 'granted')
      new Notification('StakePulse', { body: msg, icon: 'https://stake.bet/favicon.ico' });
  }
  GM_addStyle([
    '#srn-menu-btn{display:flex;align-items:center;justify-content:space-between;width:100%;padding:7px 12px;background:#162330;border:1px solid #1e3a4a;border-radius:8px;color:#cdd9e5;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:6px;box-sizing:border-box}',
    '#srn-menu-btn:hover{border-color:#00d4ff44;color:#00d4ff}',
    '#srn-menu-btn span{flex:1;text-align:left}',
    '#srn-menu-dropdown{display:none;background:#0f1923;border:1px solid #1e3a4a;border-radius:8px;margin-bottom:8px;overflow:hidden}',
    '#srn-menu-dropdown.open{display:block}',
    '.srn-menu-item{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;font-size:12px;color:#8899aa;border-bottom:1px solid #1e3a4a22}',
    '.srn-menu-item:last-child{border-bottom:none}',
    '.srn-menu-item:hover{background:#162330;color:#fff}',
    '.srn-menu-item.active{background:#00d4ff11;color:#00d4ff;font-weight:700}',
    '.srn-menu-item .srn-menu-dot{width:6px;height:6px;border-radius:50%;background:#1e3a4a;flex-shrink:0}',
    '.srn-menu-item.active .srn-menu-dot{background:#00d4ff}',
    '#srn-setup{position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;font-family:"Inter","Segoe UI",sans-serif}',
    '#srn-setup-box{background:#0f1923;border:1px solid #1e3a4a;border-radius:16px;padding:30px;width:400px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.8)}',
    '#srn-setup-box h2{color:#fff;font-size:20px;font-weight:800;margin:0 0 6px;text-align:center}',
    '#srn-setup-box p{color:#8899aa;font-size:12px;text-align:center;margin:0 0 20px;line-height:1.6}',
    '.srn-setup-step{display:none}.srn-setup-step.active{display:block}',
    '.srn-setup-input{width:100%;background:#162330;border:1px solid #1e3a4a;border-radius:8px;color:#fff;padding:10px 14px;font-size:13px;box-sizing:border-box;margin-bottom:10px}',
    '.srn-setup-input:focus{outline:none;border-color:#00d4ff}',
    '.srn-setup-btn{display:block;width:100%;padding:12px;border-radius:10px;border:none;font-size:14px;font-weight:700;cursor:pointer;margin-top:8px;text-align:center}',
    '.srn-setup-btn.primary{background:linear-gradient(135deg,#00d4ff,#0099cc);color:#fff}',
    '.srn-setup-btn.secondary{background:#162330;color:#8899aa;border:1px solid #1e3a4a}',
    '.srn-setup-progress{display:flex;gap:6px;justify-content:center;margin-bottom:24px}',
    '.srn-setup-dot{width:8px;height:8px;border-radius:50%;background:#1e3a4a}',
    '.srn-setup-dot.active{background:#00d4ff}',
    '.srn-setup-dot.done{background:#00ff88}',
    '.srn-setup-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}',
    '.srn-setup-tab-toggle{display:flex;align-items:center;justify-content:space-between;background:#162330;border:1px solid #1e3a4a;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:12px;color:#cdd9e5}',
    '.srn-setup-tab-toggle.on{border-color:#00d4ff44;color:#00d4ff}',
    '.srn-setup-info{background:#162330;border:1px solid #00d4ff33;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:#8899aa;line-height:1.6}',
    '.srn-setup-info b{color:#00d4ff}',
    '#srn-panel{transition:background .3s,color .3s;position:fixed;bottom:16px;right:16px;width:340px;min-width:280px;max-width:700px;background:#0f1923;border:1px solid #1e3a4a;border-radius:12px;font-family:"Inter","Segoe UI",sans-serif;font-size:13px;color:#cdd9e5;z-index:999999;box-shadow:0 8px 32px rgba(0,0,0,.6)}',
    '#srn-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#162330;border-radius:12px 12px 0 0;cursor:move;border-bottom:1px solid #1e3a4a}',
    '#srn-hdr span{font-weight:600;font-size:14px;color:#fff}',
    '.srn-badge{background:#00d4ff18;color:#00d4ff;border:1px solid #00d4ff44;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600}',
    '#srn-tog{background:none;border:none;color:#8899aa;cursor:pointer;font-size:18px;padding:0 4px}',
    '#srn-body{padding:12px 14px;overflow-y:auto}',
    '#srn-body.col{display:none}',
    '.srn-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}',
    '.srn-tab{flex:1;min-width:fit-content;padding:5px 6px;border:1px solid #1e3a4a;border-radius:8px;background:#0f1923;color:#8899aa;cursor:pointer;font-size:10px;font-weight:600;text-align:center;white-space:nowrap}',
    '.srn-tab.active{background:#00d4ff18;border-color:#00d4ff55;color:#00d4ff}',
    '.srn-sec{display:none}.srn-sec.active{display:block}',
    '.srn-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #1e3a4a22}',
    '.srn-row:last-child{border-bottom:none}',
    '.srn-lbl{color:#8899aa;font-size:12px}.srn-val{color:#fff;font-weight:600}',
    '.srn-rank-list{list-style:none;margin:0;padding:0}',
    '.srn-rank-list li{display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid #1e3a4a22;font-size:12px}',
    '.srn-rank-list li:last-child{border-bottom:none}',
    '.srn-pos{min-width:22px;font-weight:700;font-size:11px;color:#8899aa}',
    '.srn-pos.g{color:#ffd700}.srn-pos.s{color:#c0c0c0}.srn-pos.b{color:#cd7f32}',
    '.srn-rname{flex:1;color:#cdd9e5;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.srn-rcount{color:#00d4ff;font-weight:700;font-size:11px;background:#00d4ff11;border-radius:6px;padding:2px 7px;white-space:nowrap}',
    '.srn-btn{display:block;width:100%;margin-top:8px;padding:7px;border-radius:8px;border:1px solid #1e3a4a;background:#162330;color:#cdd9e5;cursor:pointer;font-size:12px;font-weight:600;text-align:center}',
    '.srn-btn.p{border-color:#00d4ff55;color:#00d4ff;background:#00d4ff11}',
    '.srn-btn.d{color:#ff6666;border-color:#ff444433}',
    '.srn-per{display:flex;gap:4px;margin-bottom:10px}',
    '.srn-pbtn{flex:1;padding:5px 0;border:1px solid #1e3a4a;border-radius:6px;background:#0f1923;color:#8899aa;cursor:pointer;font-size:11px;font-weight:600;text-align:center}',
    '.srn-pbtn.active{background:#162330;border-color:#00d4ff55;color:#00d4ff}',
    '.srn-hi{padding:5px 0;border-bottom:1px solid #1e3a4a22;font-size:12px}',
    '.srn-hi:last-child{border-bottom:none}',
    '.srn-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#00ff88;margin-right:5px}',
    '.srn-dot.off{background:#ff4444}',
    '.srn-empty{color:#8899aa;font-size:12px;text-align:center;padding:16px 0}',
    '.srn-cfg-r{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px}',
    '.srn-cfg-r label{color:#8899aa;flex-shrink:0}',
    '.srn-cfg-r input[type=text]{background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:12px;width:150px}',
    '.srn-kw-list{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 10px}',
    '.srn-kw{display:flex;align-items:center;gap:4px;background:#00d4ff11;border:1px solid #00d4ff33;border-radius:999px;padding:3px 10px;font-size:11px;color:#00d4ff}',
    '.srn-kw button{background:none;border:none;color:#00d4ff88;cursor:pointer;font-size:13px;padding:0;line-height:1}',
    '.srn-kw-add{display:flex;gap:6px;margin-top:4px}',
    '.srn-kw-add input{flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:12px}',
    '.srn-kw-add button{padding:4px 10px;border-radius:6px;border:1px solid #00d4ff55;background:#00d4ff11;color:#00d4ff;cursor:pointer;font-size:12px;font-weight:600}',
    '.srn-sec-title{font-size:11px;color:#8899aa;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 6px;font-weight:600}',
    '.srn-stat-card{background:#162330;border:1px solid #1e3a4a;border-radius:8px;padding:10px 12px;margin-bottom:8px}',
    '.srn-stat-card-title{color:#8899aa;font-size:11px;margin-bottom:4px}',
    '.srn-stat-card-val{color:#fff;font-size:18px;font-weight:800}',
    '.srn-stat-card-sub{color:#8899aa;font-size:10px;margin-top:2px}',
    '.srn-progress-bar{background:#1e3a4a;border-radius:999px;height:8px;margin:6px 0 4px;overflow:hidden}',
    '.srn-progress-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#00d4ff,#00ff88)}',
    '#srn-resize{height:6px;cursor:ns-resize;background:transparent;border-top:1px solid #1e3a4a;border-radius:0 0 12px 12px;display:flex;align-items:center;justify-content:center}',
    '#srn-resize:hover{background:#1e3a4a55}',
    '#srn-resize::after{content:"";display:block;width:32px;height:3px;background:#1e3a4a;border-radius:999px}',
    '#srn-resize-left{position:absolute;left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize;border-radius:12px 0 0 12px}',
    '#srn-resize-left:hover{background:#1e3a4a55}',
'#srn-panel.light{background:#f5f7fa;border-color:#dde3ea;color:#1a2332}',
'#srn-panel.light #srn-hdr{background:#e8ecf0;border-color:#dde3ea}',
'#srn-panel.light #srn-hdr span{color:#1a2332}',
'#srn-panel.light #srn-tog{color:#666}',
'#srn-panel.light .srn-tab{background:#f0f3f6;border-color:#dde3ea;color:#666}',
'#srn-panel.light .srn-tab.active{background:#00d4ff22;border-color:#00d4ff;color:#0099bb}',
'#srn-panel.light .srn-row{border-color:#dde3ea}',
'#srn-panel.light .srn-lbl{color:#666}',
'#srn-panel.light .srn-val{color:#1a2332}',
'#srn-panel.light .srn-rank-list li{border-color:#dde3ea}',
'#srn-panel.light .srn-rname{color:#1a2332}',
'#srn-panel.light .srn-pbtn{background:#f0f3f6;border-color:#dde3ea;color:#666}',
'#srn-panel.light .srn-pbtn.active{background:#e0f7ff;border-color:#00d4ff;color:#0099bb}',
'#srn-panel.light .srn-btn{background:#e8ecf0;border-color:#dde3ea;color:#1a2332}',
'#srn-panel.light .srn-btn.p{background:#e0f7ff;border-color:#00d4ff;color:#0099bb}',
'#srn-panel.light .srn-btn.d{background:#fff0f0;border-color:#ffaaaa;color:#cc4444}',
'#srn-panel.light .srn-hi{border-color:#dde3ea}',
'#srn-panel.light .srn-stat-card{background:#e8ecf0;border-color:#dde3ea}',
'#srn-panel.light .srn-stat-card-title{color:#666}',
'#srn-panel.light .srn-stat-card-val{color:#1a2332}',
'#srn-panel.light .srn-progress-bar{background:#dde3ea}',
'#srn-panel.light .srn-empty{color:#999}',
'#srn-panel.light #srn-resize{border-color:#dde3ea}',
'#srn-panel.light #srn-resize::after{background:#dde3ea}',
'#srn-panel.light .srn-cfg-r label{color:#666}',
'#srn-panel.light .srn-cfg-r input[type=text]{background:#fff;border-color:#dde3ea;color:#1a2332}',
'#srn-panel.light .srn-sec-title{color:#999}',
'#srn-notif-popup{display:none;position:absolute;top:44px;right:10px;width:280px;background:#0f1923;border:1px solid #00d4ff44;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.7);z-index:9999999;overflow:hidden}',
'#srn-panel.light #srn-notif-popup{background:#f5f7fa;border-color:#00d4ff}',
'#srn-notif-popup.open{display:block}',
'#srn-notif-popup-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#162330;border-bottom:1px solid #1e3a4a}',
'#srn-panel.light #srn-notif-popup-header{background:#e8ecf0;border-color:#dde3ea}',
'#srn-notif-popup-header span{font-size:12px;font-weight:700;color:#00d4ff}',
'#srn-notif-popup-header button{background:none;border:none;color:#8899aa;cursor:pointer;font-size:14px;padding:0}',
'#srn-notif-popup-list{max-height:200px;overflow-y:auto;padding:8px}',
'.srn-notif-item{padding:8px;border-radius:6px;margin-bottom:5px;background:#162330;border:1px solid #1e3a4a22;cursor:pointer}',
'.srn-notif-item:last-child{margin-bottom:0}',
'.srn-notif-item:hover{background:#1e3a4a}',
'#srn-panel.light .srn-notif-item{background:#e8ecf0;border-color:#dde3ea}',
'#srn-panel.light .srn-notif-item:hover{background:#dde3ea}',
'.srn-notif-item-sender{color:#00d4ff;font-size:11px;font-weight:700}',
'.srn-notif-item-time{color:#8899aa;font-size:10px;margin-left:4px}',
'.srn-notif-item-text{color:#cdd9e5;font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'#srn-panel.light .srn-notif-item-text{color:#1a2332}',
'.srn-notif-footer{padding:6px 12px;border-top:1px solid #1e3a4a;display:flex;justify-content:space-between}',
'#srn-panel.light .srn-notif-footer{border-color:#dde3ea}',
'#srn-ticker{overflow:hidden;background:#0a1019;border-top:1px solid #1e3a4a;padding:5px 0;white-space:nowrap;border-radius:0 0 12px 12px}',
'#srn-ticker-inner{display:inline-block;animation:srnTicker 40s linear infinite}',
'#srn-ticker-inner:hover{animation-play-state:paused}',
'@keyframes srnTicker{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}',
'#srn-panel.light #srn-ticker{background:#e0e4e8;border-color:#dde3ea}',
'.srn-tick-item{display:inline-flex;align-items:center;gap:5px;margin:0 16px;font-size:11px;font-weight:600}',
'.srn-tick-sym{color:#cdd9e5}',
'#srn-panel.light .srn-tick-sym{color:#333}',
'.srn-tick-price{color:#00d4ff}',
'.srn-tick-up{color:#00ff88}',
'.srn-tick-down{color:#ff4444}',
    '@keyframes srnRainAnim{0%{opacity:0;transform:translateY(-30px)}20%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(-20px)}}',
    '@keyframes srnMultipPop{0%{opacity:0;transform:scale(.7)}60%{transform:scale(1.1)}100%{opacity:1;transform:scale(1)}}',
    '.srn-multip-hit{animation:srnMultipPop .4s ease-out}',
    '.srn-multip-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #1e3a4a22;font-size:12px}',
    '.srn-multip-row:last-child{border-bottom:none}',
    '.srn-multip-val{font-size:15px;font-weight:800;color:#ffd700;min-width:64px}',
    '.srn-multip-game{flex:1;color:#cdd9e5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.srn-multip-time{color:#8899aa;font-size:10px;white-space:nowrap}',
  ].join(''));
  var panelEl = null, curTab = 'dashboard', wagerPeriod = 'day', emojiPeriod = 'all', rankPeriod = 'weekly', wordPeriod = 'day', rainPeriod = 'week', collapsed = false;
  var selectedWordId = null;
  function buildSetup() {
    var overlay = document.createElement('div');
    overlay.id = 'srn-setup';
    var tabs = ALL_TABS.filter(function(t) { return t.id !== 'dashboard'; });
    var tabsConfig = getTabsConfig();
    overlay.innerHTML = [
      '<div id="srn-setup-box">',
        '<div style="text-align:center;font-size:36px;margin-bottom:8px">&#127783;</div>',
        '<h2>StakePulse</h2>',
        '<p>Configuration initiale<br><span style="font-size:10px;color:#1e3a4a">by alleluiateam</span></p>',
        '<div class="srn-setup-progress">',
          '<div class="srn-setup-dot active" id="sdot-1"></div>',
          '<div class="srn-setup-dot" id="sdot-2"></div>',
          '<div class="srn-setup-dot" id="sdot-3"></div>',
        '</div>',
        // Etape 1 - Pseudo
        '<div class="srn-setup-step active" id="sstep-1">',
          '<div class="srn-setup-info">',
            '&#128101; <b>Etape 1/3 - Ton pseudo Stake</b><br><br>',
            'Entre ton pseudo Stake pour recevoir les notifications de rains et de mentions.<br><br><b style="color:#ffd700">\u26a0\ufe0f Important :</b> Laisse le script actif sur ton navigateur !',
          '</div>',
          '<input type="text" class="srn-setup-input" id="ssetup-pseudo" placeholder="Ton pseudo Stake" />',
          '<div class="srn-setup-info" style="margin-top:4px">',
            '&#128241; <b>Notifications Telegram gratuites</b><br><br>',
            'Envoie <b>/register tonpseudo</b> au bot <b>@StakePulseAlert_Bot</b> sur Telegram pour recevoir les notifications automatiquement !',
          '</div>',
          '<button class="srn-setup-btn primary" id="ssetup-next1">Suivant &#8594;</button>',
          '<button class="srn-setup-btn secondary" id="ssetup-skip1" style="margin-top:6px">Passer cette etape</button>',
        '</div>',
        // Etape 2 - Telegram perso (optionnel)
        '<div class="srn-setup-step" id="sstep-2">',
          '<div class="srn-setup-info">',
            '&#128274; <b>Etape 2/3 - Telegram personnel (optionnel)</b><br><br>',
            'Tu peux aussi configurer <b>ton propre bot Telegram</b> pour des notifications privees.<br>',
            'Si tu ne sais pas ce que c&#39;est, clique sur "Passer".',
          '</div>',
          '<input type="password" class="srn-setup-input" id="ssetup-token" placeholder="Bot Token (ex: 123456:ABCdef...)" />',
          '<input type="text" class="srn-setup-input" id="ssetup-chatid" placeholder="Chat ID (ex: 123456789)" />',
          '<button class="srn-setup-btn primary" id="ssetup-next2">Suivant &#8594;</button>',
          '<button class="srn-setup-btn secondary" id="ssetup-skip2" style="margin-top:6px">Passer cette etape</button>',
        '</div>',
        // Etape 3 - Onglets
        '<div class="srn-setup-step" id="sstep-3">',
          '<div class="srn-setup-info">',
            '&#9881; <b>Etape 3/3 - Choisis tes onglets</b><br><br>',
            'Selectionne les fonctionnalites que tu veux utiliser.',
          '</div>',
          '<div class="srn-setup-tabs" id="ssetup-tabs"></div>',
          '<button class="srn-setup-btn primary" id="ssetup-finish">&#10003; Terminer</button>',
        '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(overlay);
    // Peupler les toggles d'onglets
    var tabsEl = document.getElementById('ssetup-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = tabs.map(function(t) {
        var on = tabsConfig[t.id] !== false;
        return '<div class="srn-setup-tab-toggle ' + (on?'on':'') + '" data-tabid="' + t.id + '">'
          + '<span>' + t.label + '</span>'
          + '<div style="width:26px;height:14px;border-radius:999px;background:' + (on?'#00d4ff':'#1e3a4a') + ';position:relative;flex-shrink:0">'
          + '<div style="width:10px;height:10px;border-radius:50%;background:#fff;position:absolute;top:2px;left:' + (on?'14px':'2px') + '"></div>'
          + '</div></div>';
      }).join('');
      tabsEl.querySelectorAll('.srn-setup-tab-toggle').forEach(function(el) {
        el.addEventListener('click', function() {
          var id = el.getAttribute('data-tabid');
          tabsConfig[id] = !tabsConfig[id];
          el.classList.toggle('on', tabsConfig[id]);
          var dot = el.querySelector('div div');
          var track = el.querySelector('div');
          if (track) track.style.background = tabsConfig[id] ? '#00d4ff' : '#1e3a4a';
          if (dot) dot.style.left = tabsConfig[id] ? '14px' : '2px';
        });
      });
    }
    function goStep(n) {
      document.querySelectorAll('.srn-setup-step').forEach(function(s) { s.classList.remove('active'); });
      document.getElementById('sstep-' + n).classList.add('active');
      for (var i = 1; i <= 3; i++) {
        var dot = document.getElementById('sdot-' + i);
        if (!dot) continue;
        if (i < n) dot.className = 'srn-setup-dot done';
        else if (i === n) dot.className = 'srn-setup-dot active';
        else dot.className = 'srn-setup-dot';
      }
    }
    // Etape 1 -> 2
    document.getElementById('ssetup-next1').addEventListener('click', function() {
      var pseudo = document.getElementById('ssetup-pseudo').value.trim();
      if (pseudo) {
        CONFIG.YOUR_USERNAME = pseudo;
        if (CONFIG.WATCH_KEYWORDS.indexOf(pseudo) < 0) CONFIG.WATCH_KEYWORDS.push(pseudo);
        var c = load(SK.USER_CONFIG, {});
        save(SK.USER_CONFIG, Object.assign({}, c, { username: pseudo, keywords: CONFIG.WATCH_KEYWORDS }));
        saveKeywords();
      }
      goStep(2);
    });
    document.getElementById('ssetup-skip1').addEventListener('click', function() { goStep(2); });
    // Etape 2 -> 3
    document.getElementById('ssetup-next2').addEventListener('click', function() {
      var tok = document.getElementById('ssetup-token').value.trim();
      var cid = document.getElementById('ssetup-chatid').value.trim();
      if (tok && cid) {
        CONFIG.TELEGRAM_BOT_TOKEN = tok;
        CONFIG.TELEGRAM_CHAT_ID = cid;
        var c = load(SK.USER_CONFIG, {});
        save(SK.USER_CONFIG, Object.assign({}, c, { token: tok, chatid: cid }));
      }
      goStep(3);
    });
    document.getElementById('ssetup-skip2').addEventListener('click', function() { goStep(3); });
    // Terminer
    document.getElementById('ssetup-finish').addEventListener('click', function() {
      tabsConfig['dashboard'] = true;
      save(SK_TABS_CONFIG, tabsConfig);
      save(SK_SETUP_DONE, true);
      document.body.removeChild(overlay);
      applyTabsConfig();
      refreshPanel();
    });
  }
  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'srn-panel';
    panelEl.innerHTML = [
      '<div id="srn-hdr">',
        '<span>&#127783; StakePulse <span style="font-size:9px;color:#1e3a4a;margin-left:4px">by alleluiateam</span> <span id="srn-notif-badge" style="display:none;background:#ff4444;color:#fff;border-radius:999px;font-size:10px;padding:1px 6px;margin-left:4px;font-weight:700;vertical-align:middle"></span></span>',
        '<div style="display:flex;align-items:center;gap:8px">',
        '<button id="srn-theme" title="Changer le theme" style="background:none;border:none;cursor:pointer;font-size:16px;padding:0 4px">&#9728;</button>',
          '<span class="srn-badge">LIVE</span>',
          '<button id="srn-tog">-</button>',
        '</div>',
      '</div>',
      '<div id="srn-notif-popup">',
        '<div id="srn-notif-popup-header"><span>&#128276; Notifications</span><button id="srn-notif-close">&#10005;</button></div>',
        '<div id="srn-notif-popup-list"></div>',
        '<div class="srn-notif-footer">',
          '<button class="srn-btn p" style="margin-top:0;padding:4px 10px;font-size:11px" data-srn="readAllMentions">Tout marquer lu</button>',
          '<button class="srn-btn d" style="margin-top:0;padding:4px 10px;font-size:11px" data-srn="goToMessages">Voir tout</button>',
        '</div>',
      '</div>',
      '<div id="srn-body">',
        '<button id="srn-menu-btn"><span id="srn-menu-label">&#128203; Stats</span><span>&#9660;</span></button>',
        '<div id="srn-menu-dropdown">',
          '<div class="srn-menu-item active" data-tab="dashboard"><div class="srn-menu-dot"></div>Stats</div>',
          '<div class="srn-menu-item" data-tab="ranking"><div class="srn-menu-dot"></div>Classement</div>',
          '<div class="srn-menu-item" data-tab="history"><div class="srn-menu-dot"></div>Historique</div>',
          '<div class="srn-menu-item" data-tab="messages"><div class="srn-menu-dot"></div>Messages</div>',
          '<div class="srn-menu-item" data-tab="mystats"><div class="srn-menu-dot"></div>Mes Stats</div>',
          '<div class="srn-menu-item" data-tab="moderation"><div class="srn-menu-dot"></div>Hot words</div>',
          '<div class="srn-menu-item" data-tab="rainers"><div class="srn-menu-dot"></div>Rains</div>',
          '<div class="srn-menu-item" data-tab="wager"><div class="srn-menu-dot"></div>&#9888; Stats Wager</div>',
          '<div class="srn-menu-item" data-tab="multip"><div class="srn-menu-dot"></div>&#9888; Multiplicateur</div>',
          '<div class="srn-menu-item" data-tab="converter"><div class="srn-menu-dot"></div>Convertisseur</div>',
          '<div class="srn-menu-item" data-tab="rang"><div class="srn-menu-dot"></div>Rank</div>',
          '<div class="srn-menu-item" data-tab="bonushunt"><div class="srn-menu-dot"></div>🎰 Bonus Hunt</div>',
          '<div class="srn-menu-item" data-tab="settings"><div class="srn-menu-dot"></div>Config</div>',
        '</div>',
        // Dashboard
        '<div class="srn-sec active" id="tab-dashboard">',
          '<div class="srn-row"><span class="srn-lbl"><span class="srn-dot" id="srn-dot"></span>Mon activite</span><span class="srn-val" id="srn-act">-</span></div>',
          '<div class="srn-row"><span class="srn-lbl">Rains aujourd\'hui</span><span class="srn-val" id="srn-dc">-</span></div>',
          '<div class="srn-row"><span class="srn-lbl">Rains cette semaine</span><span class="srn-val" id="srn-wc">-</span></div>',
          '<div class="srn-row"><span class="srn-lbl">Rains ce mois</span><span class="srn-val" id="srn-mc">-</span></div>',
          '<div class="srn-row"><span class="srn-lbl">Total enregistre</span><span class="srn-val" id="srn-tc">-</span></div>',
          '<div class="srn-row"><span class="srn-lbl">Derniere rain</span><span class="srn-val" id="srn-lr">-</span></div>',
        '</div>',
        // Classement
        '<div class="srn-sec" id="tab-ranking">',
          '<div class="srn-per">',
            '<button class="srn-pbtn active" data-period="weekly">Semaine</button>',
            '<button class="srn-pbtn" data-period="monthly">Mois</button>',
            '<button class="srn-pbtn" data-period="allTime">Tout temps</button>',
          '</div>',
          '<ul class="srn-rank-list" id="srn-rl"></ul>',
        '</div>',
        // Historique
        '<div class="srn-sec" id="tab-history"><div id="srn-hl"></div></div>',
        // Messages
        '<div class="srn-sec" id="tab-messages">',
          '<div style="display:flex;gap:5px;margin-bottom:10px">',
            '<button class="srn-btn p" style="margin-top:0;flex:1;padding:5px" data-srn="readAllMentions">Tout lu</button>',
            '<button class="srn-btn d" style="margin-top:0;flex:1;padding:5px" data-srn="deleteReadMentions">Suppr. lus</button>',
            '<button class="srn-btn d" style="margin-top:0;flex:1;padding:5px" data-srn="deleteAllMentions">Tout suppr.</button>',
          '</div>',
          '<div id="srn-msg-list"></div>',
          '<div id="srn-msg-empty" style="display:none" class="srn-empty">Aucun message.</div>',
        '</div>',
        // Mes Stats
        '<div class="srn-sec" id="tab-mystats"><div id="srn-mystats-content"></div></div>',
        // Mots
        '<div class="srn-sec" id="tab-moderation">',
          '<div class="srn-per" id="srn-word-per">',
            '<button class="srn-pbtn active" data-wordperiod="day">Jour</button>',
            '<button class="srn-pbtn" data-wordperiod="week">Semaine</button>',
            '<button class="srn-pbtn" data-wordperiod="month">Mois</button>',
            '<button class="srn-pbtn" data-wordperiod="year">Annee</button>',
          '</div>',
          '<div id="srn-word-content"></div>',
          '<div id="srn-word-detail" style="margin-top:8px;display:none"></div>',
          '<div class="srn-sec-title" style="margin-top:12px">Ajouter un mot</div>',
          '<div style="display:flex;gap:5px;margin-bottom:5px">',
            '<input type="text" id="srn-cw-id" placeholder="id (ex: gg)" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:11px" />',
            '<input type="text" id="srn-cw-label" placeholder="label (ex: GG)" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:11px" />',
          '</div>',
          '<div style="display:flex;gap:5px">',
            '<input type="text" id="srn-cw-pattern" placeholder="mot a detecter" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:11px" />',
            '<button data-srn="addCustomWord" style="padding:4px 10px;border-radius:6px;border:1px solid #00d4ff55;background:#00d4ff11;color:#00d4ff;cursor:pointer;font-size:11px;font-weight:600">+ Add</button>',
          '</div>',
          '<div id="srn-custom-words-list" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px"></div>',
          '<div class="srn-sec-title" style="margin-top:14px">Emojis Stake</div>',
          '<div class="srn-per">',
            '<button class="srn-pbtn active" data-emojiperiod="all">Total</button>',
            '<button class="srn-pbtn" data-emojiperiod="top">Top 10</button>',
          '</div>',
          '<div id="srn-emoji-content"></div>',
          '<button class="srn-btn d" style="margin-top:8px" data-srn="resetEmojis">&#128465; Reset emojis</button>',
          '<button class="srn-btn d" style="margin-top:10px" data-srn="resetWords">&#128465; Remettre les stats a zero</button>',
        '</div>',
        // Rainers
        '<div class="srn-sec" id="tab-rainers">',
          '<div class="srn-per">',
            '<button class="srn-pbtn active" data-rainperiod="week">Semaine</button>',
            '<button class="srn-pbtn" data-rainperiod="month">Mois</button>',
            '<button class="srn-pbtn" data-rainperiod="allTime">Tout temps</button>',
          '</div>',
          '<div id="srn-rainers-list"></div>',
          '<button class="srn-btn d" style="margin-top:10px" data-srn="resetRains">&#128465; Remettre les stats a zero</button>',
        '</div>',
        // Config
        '<div class="srn-sec" id="tab-rang">',
          '<div class="srn-sec-title">Calculateur de rang</div>',
          '<div style="margin-bottom:8px">',
            '<label style="color:#8899aa;font-size:11px;display:block;margin-bottom:4px">Mon rang actuel</label>',
            '<select id="srn-rang-select" style="width:100%;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:6px 8px;font-size:12px">',
              '<option value="0">\u2b1c No Rank (0$ - 10,000$)</option>',
              '<option value="1">\ud83e\udd49 Bronze (10,000$ - 50,000$)</option>',
              '<option value="2">\ud83e\udd48 Silver (50,000$ - 100,000$)</option>',
              '<option value="3">\ud83e\udd47 Gold (100,000$ - 250,000$)</option>',
              '<option value="4">\ud83d\udc8e Platinum (250,000$ - 500,000$)</option>',
              '<option value="5">\ud83d\udc8e Platinum 2 (500,000$ - 1,000,000$)</option>',
              '<option value="6">\ud83d\udc8e Platinum 3 (1,000,000$ - 2,500,000$)</option>',
              '<option value="7">\ud83d\udc8e Platinum 4 (2,500,000$ - 5,000,000$)</option>',
              '<option value="8">\ud83d\udc8e Platinum 5 (5,000,000$ - 10,000,000$)</option>',
              '<option value="9">\ud83d\udc8e Platinum 6 (10,000,000$ - 25,000,000$)</option>',
            '</select>',
          '</div>',
          '<div style="margin-bottom:10px">',
            '<label style="color:#8899aa;font-size:11px;display:block;margin-bottom:4px">Mon pourcentage actuel (%)</label>',
            '<div style="display:flex;gap:8px;align-items:center">',
              '<input type="range" id="srn-rang-slider" min="0" max="100" value="0" style="flex:1;accent-color:#00d4ff" />',
              '<input type="number" id="srn-rang-pct" min="0" max="100" value="0" style="width:60px;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:13px;font-weight:700" />',
              '<span style="color:#8899aa">%</span>',
            '</div>',
          '</div>',
          '<div id="srn-rang-result"></div>',
        '</div>',
        '<div class="srn-sec" id="tab-multip">',
          '<div id="srn-multip-content"></div>',
        '</div>',
        '<div class="srn-sec" id="tab-bonushunt">',
          '<div class="srn-sec-title">Bonus Hunt</div>',
          '<div style="text-align:center;padding:30px 0">',
            '<button id="srn-bh-launch" style="background:#00d4ff22;border:1px solid #00d4ff55;border-radius:8px;color:#00d4ff;cursor:pointer;font-size:14px;font-weight:700;padding:14px 32px">&#127921; Lancer le Bonus Hunt</button>',
            '<div style="margin-top:12px;font-size:12px;color:#8899aa">Ouvre une fenetre flottante independante, deplacable et redimensionnable</div>',
          '</div>',
        '</div>',
        '<div class="srn-sec" id="tab-converter">',
          '<div class="srn-sec-title">Convertisseur de devises</div>',
          '<div style="display:flex;gap:5px;margin-bottom:8px;align-items:center">',
            '<input type="number" id="srn-conv-amount" value="1" min="0" step="0.01" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:6px 8px;font-size:13px;font-weight:700" />',
            '<select id="srn-conv-from" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:6px 8px;font-size:12px"></select>',
          '</div>',
          '<div style="text-align:center;color:#8899aa;font-size:18px;margin:4px 0">&#8595;</div>',
          '<div style="display:flex;gap:5px;margin-bottom:10px;align-items:center">',
            '<div id="srn-conv-result" style="flex:1;background:#162330;border:1px solid #00d4ff33;border-radius:6px;color:#00d4ff;padding:6px 8px;font-size:13px;font-weight:700;text-align:center">-</div>',
            '<select id="srn-conv-to" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:6px 8px;font-size:12px"></select>',
          '</div>',
          '<button class="srn-btn p" data-srn="convertCurrency">Convertir</button>',
          '<div id="srn-conv-rate" style="font-size:10px;color:#8899aa;text-align:center;margin-top:6px"></div>',
          '<div class="srn-sec-title" style="margin-top:12px">Conversions rapides</div>',
          '<div id="srn-conv-quick" style="display:grid;grid-template-columns:1fr 1fr;gap:5px"></div>',
        '</div>',
        '<div class="srn-sec" id="tab-wager">',
          '<div class="srn-per">',
            '<button class="srn-pbtn active" data-wagerperiod="day">Jour</button>',
            '<button class="srn-pbtn" data-wagerperiod="week">Semaine</button>',
            '<button class="srn-pbtn" data-wagerperiod="month">Mois</button>',
            '<button class="srn-pbtn" data-wagerperiod="year">Annee</button>',
          '</div>',
          '<div id="srn-wager-content"></div>',
          '<button class="srn-btn d" style="margin-top:10px" data-srn="resetWager">&#128465; Remettre le wager a zero</button>',
        '</div>',
        '<div class="srn-sec" id="tab-settings">',
          '<div class="srn-sec-title">Telegram</div>',
          '<div class="srn-cfg-r"><label>Bot Token</label><input type="password" id="cfg-tok" placeholder="123456:ABCdef..." /></div>',
          '<div class="srn-cfg-r"><label>Chat ID</label><input type="password" id="cfg-cid" placeholder="123456789" /></div>',
          '<div class="srn-sec-title">Stake</div>',
          '<div class="srn-cfg-r"><label>Mon pseudo</label><input type="text" id="cfg-usr" placeholder="Ton pseudo Stake" /></div>',
          '<div class="srn-cfg-r"><label>Inactivite (min)</label><input type="text" id="cfg-ina" placeholder="10" style="width:60px" /></div>',
          '<div class="srn-sec-title">Mots-cles surveilles</div>',
          '<div class="srn-kw-list" id="srn-kw-list"></div>',
          '<div class="srn-kw-add"><input type="text" id="cfg-kw-input" placeholder="Ton pseudo Stake" /><button data-srn="addKeyword">+ Ajouter</button></div>',
                    '<div class="srn-sec-title" style="margin-top:12px">Affichage des onglets</div>',
          '<div id="srn-tabs-toggles" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px"></div>',
          '<button class="srn-btn p" style="margin-top:12px" data-srn="saveConfig">Sauvegarder</button>',
          '<button class="srn-btn d" style="margin-top:5px" data-srn="test">Tester Telegram</button>',
          '<div id="srn-test-status" style="font-size:11px;margin-top:4px;min-height:14px;text-align:center"></div>',
          '<div id="srn-reset-confirm" style="display:none;margin-top:8px;padding:8px;border:1px solid #ff444433;border-radius:8px;text-align:center">',
            '<div style="color:#ff6666;font-size:12px;margin-bottom:6px">Supprimer tout ?</div>',
            '<div style="display:flex;gap:6px">',
              '<button class="srn-btn d" style="margin-top:0;flex:1" data-srn="resetConfirm">Confirmer</button>',
              '<button class="srn-btn" style="margin-top:0;flex:1" data-srn="resetCancel">Annuler</button>',
            '</div>',
          '</div>',
          '<button class="srn-btn d" style="margin-top:5px" data-srn="reset">Reinitialiser</button>',
        '</div>',
      '</div>',
      '<div id="srn-ticker"><div id="srn-ticker-inner">Chargement des prix...</div></div>',
      '<div id="srn-resize"></div>',
      '<div id="srn-resize-left"></div>',
    ].join('');
    document.body.appendChild(panelEl);
    var c = load(SK.USER_CONFIG, {});
    if (c.token)      document.getElementById('cfg-tok').value = c.token;
    if (c.chatid)     document.getElementById('cfg-cid').value = c.chatid;
    if (c.username)   document.getElementById('cfg-usr').value = c.username;
    if (c.inactivity) document.getElementById('cfg-ina').value = c.inactivity;
    renderKeywords();
    renderCustomWordsList();
    document.getElementById('cfg-kw-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') window._srn.addKeyword(); });
    document.getElementById('srn-tog').addEventListener('click', function() {
      collapsed = !collapsed;
      document.getElementById('srn-body').classList.toggle('col', collapsed);
      document.getElementById('srn-tog').textContent = collapsed ? '+' : '-';
    });
    // Dropdown menu
    var menuBtn = document.getElementById('srn-menu-btn');
    var menuDropdown = document.getElementById('srn-menu-dropdown');
    if (menuBtn) {
      menuBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        menuDropdown.classList.toggle('open');
      });
    }
    document.addEventListener('click', function() {
      if (menuDropdown) menuDropdown.classList.remove('open');
    });
    var MENU_LABELS = {
      dashboard:'Stats', ranking:'Classement', history:'Historique',
      messages:'Messages', mystats:'Mes Stats', moderation:'Hot words',
      rainers:'Rains', wager:'Stats Wager', multip:'Multiplicateur',
      converter:'Convertisseur', rang:'Rank', settings:'Config'
    };
    panelEl.querySelectorAll('.srn-menu-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        curTab = item.getAttribute('data-tab');
        panelEl.querySelectorAll('.srn-menu-item').forEach(function(i) { i.classList.remove('active'); });
        item.classList.add('active');
        panelEl.querySelectorAll('.srn-sec').forEach(function(s) { s.classList.remove('active'); });
        var sec = document.getElementById('tab-' + curTab);
        if (sec) sec.classList.add('active');
        var label = document.getElementById('srn-menu-label');
        if (label) label.textContent = '\uD83D\uDCCB ' + (MENU_LABELS[curTab] || curTab);
        if (menuDropdown) menuDropdown.classList.remove('open');
        if (curTab === 'converter') renderConverter();
        if (curTab === 'settings')  renderTabsToggles();
        refreshPanel();
      });
    });
    panelEl.querySelectorAll('.srn-pbtn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (btn.getAttribute('data-period')) {
          rankPeriod = btn.getAttribute('data-period');
          panelEl.querySelectorAll('[data-period]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          renderRanking();
        } else if (btn.getAttribute('data-wordperiod')) {
          wordPeriod = btn.getAttribute('data-wordperiod');
          panelEl.querySelectorAll('[data-wordperiod]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          renderModeration();
        } else if (btn.getAttribute('data-rainperiod')) {
          rainPeriod = btn.getAttribute('data-rainperiod');
          panelEl.querySelectorAll('[data-rainperiod]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          renderRainers();
        } else if (btn.getAttribute('data-wagerperiod')) {
          wagerPeriod = btn.getAttribute('data-wagerperiod');
          panelEl.querySelectorAll('[data-wagerperiod]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          renderWager();
        } else if (btn.getAttribute('data-emojiperiod')) {
          emojiPeriod = btn.getAttribute('data-emojiperiod');
          panelEl.querySelectorAll('[data-emojiperiod]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          renderEmojiStats();
        }
      });
    });
    panelEl.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-srn]');
      if (!btn) return;
      var action = btn.getAttribute('data-srn');
      var srn = window._srn;
      if (!srn) return;
      if      (action === 'sendRank-weekly')    srn.sendRank('weekly');
      else if (action === 'sendRank-monthly')   srn.sendRank('monthly');
      else if (action === 'sendRank-allTime')   srn.sendRank('allTime');
      else if (action === 'saveConfig')         srn.saveConfig();
      else if (action === 'test')               srn.test();
      else if (action === 'testMention')        srn.testMention();
      else if (action === 'replaySetup')     srn.replaySetup();
      else if (action === 'reset')              srn.reset();
      else if (action === 'resetConfirm')       srn.resetConfirm();
      else if (action === 'resetCancel')        srn.resetCancel();
      else if (action === 'addKeyword')         srn.addKeyword();
      else if (action === 'editRanking')      srn.editRanking(btn.getAttribute('data-username'), btn.getAttribute('data-period'));
      else if (action === 'refreshCrypto')    srn.refreshCrypto();
      else if (action === 'calcRang')         srn.calcRang();
      else if (action === 'convertCurrency')  srn.convertCurrency();
      else if (action === 'resetWager')       srn.resetWager();
      else if (action === 'resetRains')       srn.resetRains();
      else if (action === 'saveMultipConfig') srn.saveMultipConfig();
      else if (action === 'fbPullNow')          srn.fbPullNow();
      else if (action === 'fbPushNow')          srn.fbPushNow();
      else if (action === 'addMultipGame')    srn.addMultipGame();
      else if (action === 'removeMultipGame') srn.removeMultipGame(parseInt(btn.getAttribute('data-idx')));
      else if (action === 'resetMultip')      srn.resetMultip();
      else if (action === 'testMultip')      srn.testMultip();
      else if (action === 'multip_debug_on')  window._srnEnableMultipDebug();
      else if (action === 'multip_debug_off') window._srnDisableMultipDebug();
      else if (action === 'resetEmojis')      srn.resetEmojis();
      else if (action === 'resetWords')       srn.resetWords();
      else if (action === 'addCustomWord')      srn.addCustomWord();
      else if (action === 'removeKeyword')      srn.removeKeyword(parseInt(btn.getAttribute('data-idx')));
      else if (action === 'removeCustomWord')   srn.removeCustomWord(btn.getAttribute('data-id'));
      else if (action === 'manualCount')        addManualCount(btn.getAttribute('data-id'));
      else if (action === 'selectWord')         { selectedWordId = btn.getAttribute('data-id'); renderModeration(); }
      else if (action === 'deleteMention')      srn.deleteMention(parseInt(btn.getAttribute('data-id')));
      else if (action === 'readMention')        srn.readMention(parseInt(btn.getAttribute('data-id')));
      else if (action === 'goToMessages')     srn.goToMessages();
      else if (action === 'readAllMentions')    srn.readAllMentions();
      else if (action === 'deleteReadMentions') srn.deleteReadMentions();
      else if (action === 'deleteAllMentions')  srn.deleteAllMentions();
    });
    makeDraggable(panelEl, document.getElementById('srn-hdr'));
    renderTabsToggles();
    applyTabsConfig();
    // Fermer popup notif en cliquant ailleurs
    document.addEventListener('click', function(e) {
      var popup = document.getElementById('srn-notif-popup');
      if (popup && popup.classList.contains('open') && !popup.contains(e.target) && e.target.id !== 'srn-notif-badge') {
        popup.classList.remove('open');
      }
    });
    // Bouton fermer le popup
    var closeBtn = document.getElementById('srn-notif-close');
    if (closeBtn) closeBtn.addEventListener('click', function() {
      var popup = document.getElementById('srn-notif-popup');
      if (popup) popup.classList.remove('open');
    });
    // Theme toggle
    var savedTheme = GM_getValue('srn_theme', 'dark');
    if (savedTheme === 'light') panelEl.classList.add('light');
    document.getElementById('srn-theme').textContent = savedTheme === 'light' ? '\u2600' : '\u263D';
    document.getElementById('srn-theme').addEventListener('click', function() {
      var isLight = panelEl.classList.toggle('light');
      GM_setValue('srn_theme', isLight ? 'light' : 'dark');
      this.textContent = isLight ? '\u2600' : '\u263D';
    });
    makeResizable(panelEl, document.getElementById('srn-resize'));
    refreshPanel();
  }
  function renderKeywords() {
    var list = document.getElementById('srn-kw-list');
    if (!list) return;
    var kws = CONFIG.WATCH_KEYWORDS || [];
    if (!kws.length) { list.innerHTML = '<span style="color:#8899aa;font-size:11px">Aucun mot-cle</span>'; return; }
    list.innerHTML = kws.map(function(kw, i) {
      return '<span class="srn-kw">@' + escHtml(kw.replace(/^@/, '')) + '<button data-srn="removeKeyword" data-idx="' + i + '">x</button></span>';
    }).join('');
  }
  function renderCustomWordsList() {
    var el = document.getElementById('srn-custom-words-list');
    if (!el) return;
    var custom = load(SK_CUSTOMWORDS, []);
    if (!custom.length) { el.innerHTML = ''; return; }
    el.innerHTML = custom.map(function(w) {
      return '<span style="display:flex;align-items:center;gap:4px;background:#ff950011;border:1px solid #ff950033;border-radius:999px;padding:3px 10px;font-size:11px;color:#ff9500">'
        + escHtml(w.label)
        + '<button data-srn="removeCustomWord" data-id="' + w.id + '" style="background:none;border:none;color:#ff950088;cursor:pointer;font-size:13px;padding:0;line-height:1">x</button>'
        + '</span>';
    }).join('');
  }
  function renderNotifPopup() {
    var list = document.getElementById('srn-notif-popup-list');
    if (!list) return;
    var mentions = load(SK.MENTIONS, []).filter(function(m) { return !m.read; });
    if (!mentions.length) {
      list.innerHTML = '<div style="color:#8899aa;font-size:12px;text-align:center;padding:12px">Aucune notification non lue</div>';
      return;
    }
    list.innerHTML = mentions.slice(0, 5).map(function(m) {
      var time = new Date(m.ts).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
      return '<div class="srn-notif-item" data-id="' + m.id + '">'
        + '<div><span class="srn-notif-item-sender">' + escHtml(m.sender) + '</span><span class="srn-notif-item-time">' + time + '</span></div>'
        + '<div class="srn-notif-item-text">' + escHtml(m.text.substring(0, 80)) + '</div>'
        + '</div>';
    }).join('');
    // Clic sur un item => marque comme lu
    list.querySelectorAll('.srn-notif-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var id = parseInt(item.getAttribute('data-id'));
        window._srn.readMention(id);
        renderNotifPopup();
        refreshPanel();
      });
    });
  }
  var ALL_TABS = [
    { id: 'dashboard',  label: 'Stats' },
    { id: 'ranking',    label: 'Classement' },
    { id: 'history',    label: 'Historique' },
    { id: 'messages',   label: 'Messages' },
    { id: 'mystats',    label: 'Mes Stats' },
    { id: 'moderation', label: 'Mots' },
    { id: 'rainers',    label: 'Rains' },
    { id: 'wager',      label: 'Stats Wager' },
    { id: 'multip',     label: 'Multiplicateur' },
    { id: 'converter',  label: 'Convertisseur' },
    { id: 'rang',       label: 'Rang' },
    { id: 'bonushunt',  label: 'Bonus Hunt' },
  ];
  function getTabsConfig() {
    var cfg = load(SK_TABS_CONFIG, {});
    ALL_TABS.forEach(function(t) { if (cfg[t.id] === undefined) cfg[t.id] = true; });
    return cfg;
  }
  function applyTabsConfig() {
    if (!panelEl) return;
    var cfg = getTabsConfig();
    ALL_TABS.forEach(function(t) {
      var item = panelEl.querySelector('.srn-menu-item[data-tab="' + t.id + '"]');
      if (item) item.style.display = cfg[t.id] ? '' : 'none';
      if (!cfg[t.id] && curTab === t.id) {
        curTab = 'dashboard';
        panelEl.querySelectorAll('.srn-menu-item').forEach(function(i) { i.classList.remove('active'); });
        var dash = panelEl.querySelector('.srn-menu-item[data-tab="dashboard"]');
        if (dash) dash.classList.add('active');
        panelEl.querySelectorAll('.srn-sec').forEach(function(s) { s.classList.remove('active'); });
        var dashSec = document.getElementById('tab-dashboard');
        if (dashSec) dashSec.classList.add('active');
        var label = document.getElementById('srn-menu-label');
        if (label) label.textContent = '\uD83D\uDCCB Stats';
      }
    });
  }
  function renderTabsToggles() {
    var el = document.getElementById('srn-tabs-toggles');
    if (!el) return;
    var cfg = getTabsConfig();
    el.innerHTML = ALL_TABS.map(function(t) {
      var on = cfg[t.id] !== false;
      var bg = on ? '#00d4ff' : '#1e3a4a';
      var dot = on ? 'translateX(14px)' : 'translateX(0)';
      var txtColor = on ? '#00d4ff' : '#8899aa';
      var cursor = t.id === 'dashboard' ? 'default' : 'pointer';
      return '<div data-tabid="' + t.id + '" style="display:flex;align-items:center;justify-content:space-between;background:#162330;border:1px solid ' + (on ? '#00d4ff44' : '#1e3a4a') + ';border-radius:8px;padding:7px 10px;cursor:' + cursor + ';font-size:12px;color:' + txtColor + ';font-weight:' + (on ? '600' : '400') + '">'
        + '<span>' + t.label + '</span>'
        + '<div style="width:30px;height:16px;border-radius:999px;background:' + bg + ';position:relative;flex-shrink:0">'
        + '<div style="width:12px;height:12px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transform:' + dot + '"></div>'
        + '</div>'
        + '</div>';
    }).join('');
    // Event listeners
    el.querySelectorAll('[data-tabid]').forEach(function(row) {
      var id = row.getAttribute('data-tabid');
      if (id === 'dashboard') return;
      row.addEventListener('click', function() {
        var cfg2 = getTabsConfig();
        cfg2[id] = !cfg2[id];
        cfg2['dashboard'] = true;
        save(SK_TABS_CONFIG, cfg2);
        renderTabsToggles();
        applyTabsConfig();
      });
    });
  }
  function refreshPanel() {
    if (!panelEl) return;
    var log = load(SK.RAIN_LOG, []);
    var now = Date.now();
    var dayStart = new Date(); dayStart.setHours(0,0,0,0); dayStart = dayStart.getTime();
    var weekStart  = getWeekStart(new Date()).getTime();
    var monthStart = getMonthStart(new Date()).getTime();
    var g = function(id) { return document.getElementById(id); };
    if (g('srn-dc')) g('srn-dc').textContent = log.filter(function(e) { return e.ts >= dayStart; }).length;
    if (g('srn-wc')) g('srn-wc').textContent = log.filter(function(e) { return e.ts >= weekStart; }).length;
    if (g('srn-mc')) g('srn-mc').textContent = log.filter(function(e) { return e.ts >= monthStart; }).length;
    if (g('srn-tc')) g('srn-tc').textContent = log.length;
    var lr = log[log.length - 1];
    if (g('srn-lr') && lr) g('srn-lr').textContent = new Date(lr.ts).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    var last = getLastMsgTime();
    if (last > 0 && g('srn-dot') && g('srn-act')) {
      var mins = Math.round((now - last) / 60000);
      var active = mins < CONFIG.INACTIVITY_MINUTES;
      g('srn-dot').className = 'srn-dot' + (active ? '' : ' off');
      g('srn-act').textContent = active ? 'Actif (il y a ' + mins + ' min)' : 'Inactif depuis ' + mins + ' min';
    }
    if (curTab === 'ranking')    renderRanking();
    if (curTab === 'history')    renderHistory();
    if (curTab === 'messages')   renderMessages();
    if (curTab === 'mystats')    renderMyStats();
    if (curTab === 'moderation') renderModeration();
    if (curTab === 'rainers')    renderRainers();
    if (curTab === 'wager')      renderWager();
    if (curTab === 'multip')     renderMultip();
    if (curTab === 'converter')  renderConverter();
    if (curTab === 'settings')   renderTabsToggles();
    if (curTab === 'rang')       renderRang();
    if (curTab === 'bonushunt')  bhInitTab();
    if (curTab === 'moderation') renderEmojiStats();
    // Badge notifications non lues
    var unread = load(SK.MENTIONS, []).filter(function(m) { return !m.read; }).length;
    var badge = g('srn-notif-badge');
    if (badge) { badge.style.display = unread > 0 ? 'inline' : 'none'; badge.textContent = unread; }
    if (badge && !badge._hasClick) {
      badge._hasClick = true;
      badge.style.cursor = 'pointer';
      badge.addEventListener('click', function(e) {
        e.stopPropagation();
        var popup = document.getElementById('srn-notif-popup');
        if (!popup) return;
        popup.classList.toggle('open');
        if (popup.classList.contains('open')) renderNotifPopup();
      });
    }
    var msgItem = panelEl.querySelector('.srn-menu-item[data-tab="messages"]');
    if (msgItem) { var dot = msgItem.querySelector('.srn-menu-dot'); if (dot) dot.style.background = unread > 0 ? '#ff4444' : (curTab === 'messages' ? '#00d4ff' : '#1e3a4a'); }
    // Notification objectif 100%
    var me = (CONFIG.YOUR_USERNAME || '').toLowerCase();
    var myWeekTotal = log.filter(function(e) {
      return e.ts >= weekStart && e.recipients && e.recipients.some(function(r) { return r.toLowerCase() === me; });
    }).reduce(function(s, e) { return s + (e.amount || 0); }, 0);
    if (myWeekTotal >= WEEKLY_GOAL && !window._srnGoalNotified) {
      window._srnGoalNotified = true;
      sendTelegram('Objectif atteint ! Tu as touche ' + myWeekTotal.toFixed(2) + 'EUR de rains cette semaine !');
      showNotif('Objectif ' + WEEKLY_GOAL + 'EUR atteint cette semaine !');
    }
    if (myWeekTotal < WEEKLY_GOAL) window._srnGoalNotified = false;
  }
  function renderRanking() {
    var list = document.getElementById('srn-rl');
    if (!list) return;
    var top    = getTopN(rankPeriod, 10);
    var allTop = getTopN(rankPeriod, 9999);
    var me     = CONFIG.YOUR_USERNAME ? CONFIG.YOUR_USERNAME.toLowerCase() : null;
    if (!top.length) { list.innerHTML = '<li><span class="srn-empty">Aucune rain pour cette periode.</span></li>'; return; }
    function makeRow(p, i, isMe) {
      var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
      var pos = medals[i] || (i+1) + '.';
      var posCls = ['g','s','b'][i] ? ' class="srn-pos ' + ['g','s','b'][i] + '"' : ' class="srn-pos"';
      var isEuro = (p.currency === '\u20ac' || p.currency === 'EUR');
      var amtStr = p.totalAmount > 0 ? (isEuro ? p.totalAmount.toFixed(2) + '\u20ac' : p.totalAmount.toFixed(5) + ' ' + (p.currency || '')) : '';
      var amt = amtStr ? '<span style="color:#00d4ff;font-weight:700;font-size:11px;background:#00d4ff11;border-radius:6px;padding:2px 7px">' + amtStr + '</span>' : '';
      var nameStyle = isMe ? 'color:#fff;font-weight:800;text-shadow:0 0 8px #00d4ff88' : '';
      var meBadge = isMe ? ' <span style="color:#00d4ff;font-size:10px;font-weight:700">< MOI</span>' : '';
      var rowStyle = isMe ? 'background:#00d4ff08;border-radius:6px;padding:4px' : '';
      return '<li style="' + rowStyle + '"><span' + posCls + '>' + pos + '</span><span class="srn-rname" style="' + nameStyle + '">' + escHtml(p.username) + meBadge + '</span>' + amt + '<span class="srn-rcount">' + p.count + ' rain' + (p.count > 1 ? 's' : '') + '</span><button data-srn="editRanking" data-username="' + escHtml(p.username) + '" data-period="' + rankPeriod + '" style="background:none;border:none;color:#8899aa;cursor:pointer;font-size:12px;padding:0 4px" title="Modifier">&#9998;</button></li>';
    }
    var rows = top.map(function(p, i) { return makeRow(p, i, !!(me && p.username.toLowerCase() === me)); });
    var myRankIdx = -1;
    allTop.forEach(function(p, i) { if (me && p.username.toLowerCase() === me) myRankIdx = i; });
    var inTop = top.some(function(p) { return !!(me && p.username.toLowerCase() === me); });
    if (me && myRankIdx >= 0 && !inTop) {
      rows.push('<li style="border-top:1px dashed #1e3a4a;margin-top:4px;padding-top:4px;list-style:none"></li>');
      rows.push(makeRow(allTop[myRankIdx], myRankIdx, true));
    } else if (me && myRankIdx < 0) {
      rows.push('<li style="border-top:1px dashed #1e3a4a;margin-top:4px;padding-top:4px;list-style:none"></li>');
      rows.push('<li style="background:#00d4ff08;border-radius:6px;padding:4px"><span class="srn-pos">-</span><span class="srn-rname" style="color:#fff;font-weight:800">' + escHtml(CONFIG.YOUR_USERNAME) + ' <span style="color:#00d4ff;font-size:10px;font-weight:700">< MOI</span></span><span style="color:#8899aa;font-size:11px">pas encore classe</span></li>');
    }
    list.innerHTML = rows.join('');
  }
  function renderHistory() {
    var el = document.getElementById('srn-hl');
    if (!el) return;
    var log = load(SK.RAIN_LOG, []);
    var recent = log.slice(-10).reverse();
    if (!recent.length) { el.innerHTML = '<div class="srn-empty">Aucune rain.</div>'; return; }
    el.innerHTML = recent.map(function(e) {
      var time = new Date(e.ts).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      var amt = e.amount ? ' - <span style="color:#00d4ff">' + e.amount + ' ' + e.currency + '</span>' : '';
      var recip = e.recipients.length > 0 ? '<br><span style="color:#8899aa;font-size:11px">' + e.recipients.length + ' joueurs touches</span>' : '';
      return '<div class="srn-hi"><span style="color:#00d4ff;font-weight:600">' + escHtml(e.sender) + '</span>' + amt + ' <span style="color:#8899aa;font-size:11px">- ' + time + '</span>' + recip + '</div>';
    }).join('');
  }
  function renderMessages() {
    var container = document.getElementById('srn-msg-list');
    var empty = document.getElementById('srn-msg-empty');
    if (!container) return;
    var mentions = load(SK.MENTIONS, []);
    if (!mentions.length) { container.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    container.innerHTML = mentions.map(function(m) {
      var time = new Date(m.ts).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      var bg = m.read ? 'transparent' : '#00d4ff06';
      var border = m.read ? '1px solid #1e3a4a22' : '1px solid #00d4ff22';
      var dot = m.read ? '' : '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#00d4ff;margin-right:5px;flex-shrink:0;margin-top:3px"></span>';
      return '<div style="background:' + bg + ';border:' + border + ';border-radius:8px;padding:8px 10px;margin-bottom:6px">'
        + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">'
        + '<div style="display:flex;align-items:flex-start;flex:1;min-width:0">' + dot
        + '<div style="flex:1;min-width:0"><span style="color:#00d4ff;font-weight:600;font-size:12px">' + escHtml(m.sender) + '</span>'
        + ' <span style="color:#8899aa;font-size:10px">' + time + '</span>'
        + '<div style="color:#cdd9e5;font-size:11px;margin-top:3px;word-break:break-word">' + escHtml(m.text.substring(0, 150)) + (m.text.length > 150 ? '...' : '') + '</div></div></div>'
        + '<button data-srn="deleteMention" data-id="' + m.id + '" style="background:none;border:none;color:#ff444488;cursor:pointer;font-size:16px;padding:0;flex-shrink:0">x</button></div>'
        + (!m.read ? '<button data-srn="readMention" data-id="' + m.id + '" style="margin-top:6px;font-size:10px;background:none;border:1px solid #00d4ff33;border-radius:4px;color:#00d4ff88;cursor:pointer;padding:2px 8px">Marquer comme lu</button>' : '')
        + '</div>';
    }).join('');
  }
  function renderMyStats() {
    var offset = load(SK_MYSTATS_OFFSET, { month: 0, monthCount: 0, allTime: 0, allTimeCount: 0, week: 0 });
    var el = document.getElementById('srn-mystats-content');
    if (!el) return;
    var log = load(SK.RAIN_LOG, []);
    var me = (CONFIG.YOUR_USERNAME || '').toLowerCase();
    var myRains = log.filter(function(e) {
      return e.recipients && e.recipients.some(function(r) { return r.toLowerCase() === me; });
    });
    var now = Date.now();
    var weekStart  = getWeekStart(new Date()).getTime();
    var monthStart = getMonthStart(new Date()).getTime();
    var weekRains  = myRains.filter(function(e) { return e.ts >= weekStart; });
    var monthRains = myRains.filter(function(e) { return e.ts >= monthStart; });
    var weekTotal  = weekRains.reduce(function(s, e) { return s + (e.amount || 0); }, 0) + offset.week;
    var monthTotal = monthRains.reduce(function(s, e) { return s + (e.amount || 0); }, 0) + offset.month;
    var allTotal   = myRains.reduce(function(s, e) { return s + (e.amount || 0); }, 0) + offset.allTime;
    var bestWeek = 0, bestWeekLabel = '-';
    var weekMap = {};
    myRains.forEach(function(e) {
      var ws = getWeekStart(new Date(e.ts)); var wk = ws.toISOString().substring(0, 10);
      if (!weekMap[wk]) weekMap[wk] = { total: 0, start: ws };
      weekMap[wk].total += (e.amount || 0);
    });
    Object.keys(weekMap).forEach(function(k) {
      if (weekMap[k].total > bestWeek) { bestWeek = weekMap[k].total; var d = weekMap[k].start; bestWeekLabel = d.getDate() + '/' + (d.getMonth()+1); }
    });
    var pct = Math.min(100, Math.round((weekTotal / WEEKLY_GOAL) * 100));
    var pctColor = pct >= 100 ? '#00ff88' : pct >= 50 ? '#00d4ff' : '#8899aa';
    var weeks = [];
    for (var i = 7; i >= 0; i--) {
      var wS = getWeekStart(new Date(now - i * 7 * 24 * 3600 * 1000)).getTime();
      var wE = wS + 7 * 24 * 3600 * 1000;
      var wT = myRains.filter(function(e) { return e.ts >= wS && e.ts < wE; }).reduce(function(s, e) { return s + (e.amount || 0); }, 0);
      var wD = new Date(wS);
      weeks.push({ total: wT, label: wD.getDate() + '/' + (wD.getMonth()+1) });
    }
    var maxW = Math.max.apply(null, weeks.map(function(w) { return w.total; })) || 1;
    var barsHtml = weeks.map(function(w) {
      var h = Math.max(4, Math.round((w.total / maxW) * 56));
      return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:2px">'
        + '<div style="font-size:9px;color:#8899aa">' + (w.total > 0 ? w.total.toFixed(1) : '') + '</div>'
        + '<div style="width:100%;background:#00d4ff33;border-radius:3px 3px 0 0;height:' + h + 'px" title="' + w.total.toFixed(2) + '\u20ac"></div></div>';
    }).join('');
    var labelsHtml = weeks.map(function(w) { return '<div style="flex:1;text-align:center;font-size:9px;color:#8899aa">' + w.label + '</div>'; }).join('');
    el.innerHTML = [
      '<div class="srn-sec-title">Objectif semaine</div>',
      '<div class="srn-stat-card">',
        '<div style="display:flex;justify-content:space-between"><span style="color:#fff;font-size:16px;font-weight:800">' + weekTotal.toFixed(2) + '\u20ac</span><span style="color:' + pctColor + ';font-weight:700">' + pct + '%</span></div>',
        '<div class="srn-progress-bar"><div class="srn-progress-fill" style="width:' + pct + '%"></div></div>',
        '<div style="color:#8899aa;font-size:10px">Objectif : ' + WEEKLY_GOAL + '\u20ac - Reste : ' + Math.max(0, WEEKLY_GOAL - weekTotal).toFixed(2) + '\u20ac</div>',
      '</div>',
      '<div class="srn-sec-title">Mes statistiques</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Ce mois</div><div class="srn-stat-card-val">' + monthTotal.toFixed(2) + '\u20ac</div><div class="srn-stat-card-sub">' + (monthRains.length + offset.monthCount) + ' rain' + ((monthRains.length + offset.monthCount) > 1 ? 's' : '') + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">All-time</div><div class="srn-stat-card-val">' + allTotal.toFixed(2) + '\u20ac</div><div class="srn-stat-card-sub">' + (myRains.length + offset.allTimeCount) + ' rain' + ((myRains.length + offset.allTimeCount) > 1 ? 's' : '') + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Meilleure sem.</div><div class="srn-stat-card-val">' + bestWeek.toFixed(2) + '\u20ac</div><div class="srn-stat-card-sub">Sem. du ' + bestWeekLabel + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Moy. par rain</div><div class="srn-stat-card-val">' + ((myRains.length + offset.allTimeCount) > 0 ? (allTotal / (myRains.length + offset.allTimeCount)).toFixed(2) : '0.00') + '\u20ac</div><div class="srn-stat-card-sub">sur ' + myRains.length + ' rain' + (myRains.length > 1 ? 's' : '') + '</div></div>',
      '</div>',
      '<div class="srn-sec-title">8 dernieres semaines</div>',
      '<div style="display:flex;align-items:flex-end;gap:3px;height:80px;margin-bottom:4px">' + barsHtml + '</div>',
      '<div style="display:flex;gap:3px">' + labelsHtml + '</div>',
    ].join('');
    // Preremplir les champs offset
    var offsetData = load(SK_MYSTATS_OFFSET, { month: 0, monthCount: 0, allTime: 0, allTimeCount: 0 });
    var oMonth = document.getElementById('srn-offset-month');
    var oMonthC = document.getElementById('srn-offset-month-count');
    var oAll = document.getElementById('srn-offset-alltime');
    var oAllC = document.getElementById('srn-offset-alltime-count');
    if (oMonth)  oMonth.value  = offsetData.month || '';
    if (oMonthC) oMonthC.value = offsetData.monthCount || '';
    if (oAll)    oAll.value    = offsetData.allTime || '';
    if (oAllC)   oAllC.value   = offsetData.allTimeCount || '';
    var oWeek = document.getElementById('srn-offset-week');
    if (oWeek) oWeek.value = offsetData.week || '';
  }
  function renderModeration() {
    var el = document.getElementById('srn-word-content');
    if (!el) return;
    var now = Date.now();
    var counts = load(SK_WORDCOUNT, []);
    var periodMs = { day: 24*3600*1000, week: 7*24*3600*1000, month: 30*24*3600*1000, year: 365*24*3600*1000 }[wordPeriod] || 24*3600*1000;
    var filtered = counts.filter(function(c) { return now - c.ts <= periodMs; });
    var totals = {};
    WORD_RULES.forEach(function(r) { totals[r.id] = 0; });
    filtered.forEach(function(c) { if (totals[c.id] !== undefined) totals[c.id]++; });
    var sorted = WORD_RULES.map(function(r) { return { id: r.id, label: r.label, count: totals[r.id], custom: r.custom }; })
      .sort(function(a, b) { return b.count - a.count; });
    var max = sorted[0] ? sorted[0].count : 1;
    var listHtml = sorted.map(function(r) {
      var pct = max > 0 ? Math.round((r.count / max) * 100) : 0;
      var color = r.custom ? '#ff9500' : '#00d4ff';
      var isSelected = selectedWordId === r.id;
      var rowStyle = isSelected ? 'background:#00d4ff08;border-radius:6px;padding:4px' : '';
      return '<div style="margin-bottom:8px;' + rowStyle + '">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">'
        + '<button data-srn="selectWord" data-id="' + r.id + '" style="background:none;border:none;color:#cdd9e5;font-weight:600;font-size:12px;cursor:pointer;padding:0;text-align:left">' + escHtml(r.label) + '</button>'
        + '<div style="display:flex;align-items:center;gap:5px">'
        + '<button data-srn="manualCount" data-id="' + r.id + '" style="background:#00d4ff11;border:1px solid #00d4ff33;border-radius:4px;color:#00d4ff;cursor:pointer;font-size:11px;padding:1px 7px;font-weight:700" title="+1 manuel">+1</button>'
        + '<span style="font-size:12px;color:' + color + ';font-weight:800">' + r.count + '</span>'
        + '</div></div>'
        + '<div style="background:#1e3a4a;border-radius:999px;height:5px;overflow:hidden"><div style="height:100%;border-radius:999px;background:' + color + ';width:' + pct + '%"></div></div>'
        + '</div>';
    }).join('');
    // Detail du mot selectionne
    var detailHtml = '';
    if (selectedWordId) {
      var rule = WORD_RULES.find(function(r) { return r.id === selectedWordId; });
      if (rule) {
        var wordCounts = filtered.filter(function(c) { return c.id === selectedWordId; });
        var byDay = {};
        wordCounts.forEach(function(c) {
          var d = new Date(c.ts).toLocaleDateString('fr-FR');
          byDay[d] = (byDay[d] || 0) + 1;
        });
        var dayEntries = Object.entries(byDay).slice(-7);
        var maxDay = Math.max.apply(null, dayEntries.map(function(e) { return e[1]; })) || 1;
        var dayBars = dayEntries.map(function(e) {
          var h = Math.max(4, Math.round((e[1] / maxDay) * 40));
          return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:2px">'
            + '<div style="font-size:9px;color:#8899aa">' + e[1] + '</div>'
            + '<div style="width:100%;background:#00d4ff33;border-radius:3px 3px 0 0;height:' + h + 'px"></div>'
            + '<div style="font-size:8px;color:#8899aa;transform:rotate(-45deg);transform-origin:top left;margin-top:4px;white-space:nowrap">' + e[0].substring(0, 5) + '</div>'
            + '</div>';
        }).join('');
        detailHtml = '<div style="background:#162330;border:1px solid #1e3a4a;border-radius:8px;padding:10px;margin-top:8px">'
          + '<div style="color:#cdd9e5;font-weight:700;font-size:12px;margin-bottom:8px">' + escHtml(rule.label) + ' - Detail</div>'
          + '<div style="display:flex;align-items:flex-end;gap:3px;height:60px;margin-bottom:8px">' + (dayBars || '<div class="srn-empty" style="padding:4px">Pas de donnees</div>') + '</div>'
          + '<div style="color:#8899aa;font-size:11px">Total periode : <b style="color:#00d4ff">' + wordCounts.length + '</b></div>'
          + '</div>';
      }
    }
    el.innerHTML = '<div style="font-size:11px;color:#8899aa;text-align:center;margin-bottom:8px">' + filtered.length + ' occurrence' + (filtered.length > 1 ? 's' : '') + '</div>' + listHtml;
    var detailEl = document.getElementById('srn-word-detail');
    if (detailEl) { detailEl.innerHTML = detailHtml; detailEl.style.display = detailHtml ? 'block' : 'none'; }
  }
  var STAKE_EMOJIS = ['adesanya', 'biden', 'beer', 'blob', 'catbread', 'coffee', 'cooldoge', 'coupon', 'coin', 'dendi', 'djokovic', 'doge', 'donut', 'easymoney', 'eddie', 'ezpz', 'gary', 'jordan', 'kanye', 'lambo', 'lebron', 'lefroge', 'mahomes', 'mcgregor', 'messi', 'nadal', 'nightdoge', 'nyancat', 'pepe', 'pikachu', 'rigged', 'rish', 'ronaldo', 'santa', 'skem', 'stonks', 'sus', 'trump', 'umbrella', 'woods', 'elon', 'feelsgoodman', 'monkas', 'pepehands', 'pepelaugh', 'poggers', 'chrissyblob', 'taco'];
  var STAKE_RANKS = [
    { name: 'No Rank',     min: 0,          max: 10000,       color: '#8899aa', icon: '\u2b1c' },
    { name: 'Bronze',      min: 10000,       max: 50000,       color: '#cd7f32', icon: '\ud83e\udd49' },
    { name: 'Silver',      min: 50000,       max: 100000,      color: '#c0c0c0', icon: '\ud83e\udd48' },
    { name: 'Gold',        min: 100000,      max: 250000,      color: '#ffd700', icon: '\ud83e\udd47' },
    { name: 'Platinum',    min: 250000,      max: 500000,      color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Platinum 2',  min: 500000,      max: 1000000,     color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Platinum 3',  min: 1000000,     max: 2500000,     color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Platinum 4',  min: 2500000,     max: 5000000,     color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Platinum 5',  min: 5000000,     max: 10000000,    color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Platinum 6',  min: 10000000,    max: 25000000,    color: '#00d4ff', icon: '\ud83d\udc8e' },
    { name: 'Diamond',     min: 25000000,    max: Infinity,    color: '#ff00ff', icon: '\ud83d\udc51' },
  ];
  function getRank(wager) {
    for (var i = STAKE_RANKS.length - 1; i >= 0; i--) {
      if (wager >= STAKE_RANKS[i].min) return { rank: STAKE_RANKS[i], index: i };
    }
    return { rank: STAKE_RANKS[0], index: 0 };
  }

  // ══ BONUS HUNT ═══════════════════════════════════════════════════════════════
  var bhSlots = [], bhBonuses = [], bhNextId = 1, bhSelThumb = '';
  var bhWinBuilt = false, bhMinimized = false, bhSlotsLoaded = false;
  var BH_API = 'https://publicbackendstakeslots-production.up.railway.app';
  var BH_STYLES = '#bh-win{position:fixed;z-index:99999;background:#0f1923;border:1px solid #1e3a4a;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);font-family:sans-serif;font-size:13px;color:#cdd9e5;min-width:320px;min-height:200px;width:700px;display:none;flex-direction:column}'
    + '#bh-win.bh-visible{display:flex}'
    + '#bh-tb{padding:10px 14px;background:#162330;border-bottom:1px solid #1e3a4a;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;flex-shrink:0}'
    + '#bh-tb-title{font-weight:700;color:#fff;font-size:14px}'
    + '.bh-tbtn{background:none;border:1px solid #1e3a4a;border-radius:4px;color:#8899aa;cursor:pointer;font-size:12px;padding:2px 8px;margin-left:4px}'
    + '.bh-tbtn:hover{background:#1e3a4a;color:#fff}'
    + '#bh-cnt{padding:14px;overflow-y:auto;flex:1}'
    + '#bh-cnt.bh-mini{display:none}'
    + '.bhsg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}'
    + '.bhsc{background:#162330;border-radius:8px;padding:10px 12px}'
    + '.bhsl{font-size:11px;color:#8899aa;margin-bottom:4px}'
    + '.bhsv{font-size:18px;font-weight:700;color:#fff}'
    + '.bhsv.g{color:#00ff88}.bhsv.r{color:#ff4444}.bhsv.p{color:#9f7fef}'
    + '.bh2c{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}'
    + '.bhbx{background:#162330;border-radius:8px;padding:12px}'
    + '.bhbt{font-size:11px;color:#8899aa;margin-bottom:8px;font-weight:700;text-transform:uppercase}'
    + '.bhbeg{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
    + '.bhbei{background:#0f1923;border-radius:6px;padding:8px 10px}'
    + '.bhbel{font-size:11px;color:#8899aa;margin-bottom:2px}'
    + '.bhbev{font-size:16px;font-weight:700;color:#fff}'
    + '.bhfr{display:grid;grid-template-columns:2fr 1.2fr .8fr auto;gap:8px;margin-bottom:12px;align-items:end}'
    + '.bhlb{font-size:11px;color:#8899aa;margin-bottom:4px}'
    + '.bhin{width:100%;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#cdd9e5;padding:6px 10px;font-size:13px;outline:none}'
    + '.bhin:focus{border-color:#00d4ff55}'
    + '.bhin[readonly]{color:#8899aa}'
    + '.bhbtn{background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#cdd9e5;padding:6px 12px;cursor:pointer;font-size:13px;white-space:nowrap}'
    + '.bhbtn:hover{background:#1e3a4a}'
    + '.bhbtn.p{background:#00d4ff22;border-color:#00d4ff55;color:#00d4ff}'
    + '.bhbtn.d{background:#ff444422;border-color:#ff444455;color:#ff4444}'
    + '.bhacw{position:relative}'
    + '.bhacl{position:absolute;top:100%;left:0;right:0;background:#162330;border:1px solid #1e3a4a;border-radius:6px;z-index:999999;max-height:180px;overflow-y:auto;margin-top:2px}'
    + '.bhaci{padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:8px}'
    + '.bhaci:hover{background:#1e3a4a}'
    + '.bhacim{width:30px;height:30px;border-radius:4px;object-fit:cover;flex-shrink:0;background:#0f1923}'
    + '.bhacan{font-size:13px;color:#cdd9e5;font-weight:500}'
    + '.bhacap{font-size:11px;color:#8899aa}'
    + '.bhtb{width:100%;border-collapse:collapse;font-size:12px}'
    + '.bhtb th{padding:6px 10px;text-align:left;color:#8899aa;font-weight:700;border-bottom:1px solid #1e3a4a;font-size:11px}'
    + '.bhtb td{padding:7px 10px;border-bottom:1px solid #1e3a4a22;color:#cdd9e5}'
    + '.bhtb tr:last-child td{border-bottom:none}'
    + '.bhtb tr:hover td{background:#162330}'
    + '.bhbadge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700}'
    + '.bhbadge.pen{background:#ffd70022;color:#ffd700}'
    + '.bhbadge.don{background:#00ff8822;color:#00ff88}'
    + '.bhsim{width:26px;height:26px;border-radius:3px;object-fit:cover;vertical-align:middle;margin-right:5px}'
    + '.bhemp{padding:16px;text-align:center;color:#8899aa}'
    + '.bhst{font-size:11px;color:#8899aa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}'
    + '#bh-rsz{position:absolute;bottom:0;right:0;width:16px;height:16px;cursor:se-resize;color:#8899aa;font-size:12px;display:flex;align-items:center;justify-content:center}';

  function bhFmt(n) {
    var sym = document.getElementById('bh-cur') ? document.getElementById('bh-cur').value : '\u20ac';
    return n.toFixed(2).replace('.', ',') + ' ' + sym;
  }
  function bhFmtX(n) { return n.toFixed(1).replace('.', ',') + '\u00d7'; }

  function bhInitTab() {
    var btn = document.getElementById('srn-bh-launch');
    if (btn && !btn._init) { btn._init = true; btn.addEventListener('click', bhOpen); }
  }

  function bhLoadSlots() {
    if (bhSlotsLoaded) return;
    var statusEl = document.getElementById('bh-api-st');
    GM_xmlhttpRequest({
      method: 'GET', url: BH_API + '/api/slots',
      onload: function(res) {
        try {
          var d = JSON.parse(res.responseText);
          if (d.success && d.data) {
            bhSlots = d.data; bhSlotsLoaded = true;
            if (statusEl) { statusEl.textContent = '\u2705 ' + bhSlots.length + ' slots'; statusEl.style.color = '#00ff88'; }
            var ct = document.getElementById('bh-ct'); if (ct) ct.textContent = '(' + bhSlots.length + ')';
          }
        } catch(e) { if (statusEl) { statusEl.textContent = '\u26a0\ufe0f API indisponible'; statusEl.style.color = '#ff4444'; } }
      },
      onerror: function() { if (statusEl) { statusEl.textContent = '\u26a0\ufe0f API indisponible'; statusEl.style.color = '#ff4444'; } }
    });
  }

  function bhBuild() {
    if (bhWinBuilt) return; bhWinBuilt = true;
    var s = document.createElement('style'); s.textContent = BH_STYLES; document.head.appendChild(s);
    var win = document.createElement('div'); win.id = 'bh-win';
    win.innerHTML = '<div id="bh-tb"><div id="bh-tb-title">\uD83C\uDFB0 Bonus Hunt <span id="bh-api-st" style="font-size:11px;color:#8899aa;font-weight:400;margin-left:8px">\u23f3 Chargement\u2026</span></div>'
      + '<div><button class="bh-tbtn" id="bh-min">\u2014</button><button class="bh-tbtn" id="bh-cls">\u2715</button></div></div>'
      + '<div id="bh-cnt">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">'
      + '<span style="font-size:12px;color:#8899aa">Montant de d\u00e9part :</span>'
      + '<input class="bhin" id="bh-start" type="number" value="200" min="0" step="1" style="width:90px" />'
      + '<select class="bhin" id="bh-cur" style="width:65px"><option>\u20ac</option><option>$</option><option>CA$</option><option>\u00a3</option><option>R$</option><option>A$</option></select>'
      + '<button class="bhbtn d" id="bh-rst" style="margin-left:auto;font-size:11px;padding:4px 10px">Remettre \u00e0 z\u00e9ro</button>'
      + '</div>'
      + '<div class="bhsg"><div class="bhsc"><div class="bhsl">D\u00e9part</div><div class="bhsv" id="bh-vs">200,00 \u20ac</div></div>'
      + '<div class="bhsc"><div class="bhsl">Total gagn\u00e9</div><div class="bhsv g" id="bh-vw">0,00 \u20ac</div></div>'
      + '<div class="bhsc"><div class="bhsl">Profit / Pertes</div><div class="bhsv r" id="bh-vp">-200,00 \u20ac</div></div>'
      + '<div class="bhsc"><div class="bhsl">Slots</div><div class="bhsv p" id="bh-vsl">0 <span style="font-size:12px;color:#8899aa">0 att. \u00b7 0 col.</span></div></div></div>'
      + '<div class="bh2c"><div class="bhbx"><div class="bhbt">Break even</div><div class="bhbeg">'
      + '<div class="bhbei"><div class="bhbel">Fixe</div><div class="bhbev" id="bh-bf">0,0\u00d7</div></div>'
      + '<div class="bhbei"><div class="bhbel">\u00c9volutif</div><div class="bhbev" id="bh-be">0,0\u00d7</div></div></div></div>'
      + '<div class="bhbx"><div class="bhbt">\uD83C\uDFC6 Remarquables</div><div id="bh-top" style="font-size:12px;color:#8899aa">Aucun bonus collect\u00e9</div></div></div>'
      + '<div class="bhst">Ajouter un bonus</div>'
      + '<div class="bhfr"><div class="bhacw"><div class="bhlb">Nom du jeu <span id="bh-ct" style="color:#8899aa"></span></div>'
      + '<input class="bhin" id="bh-game" type="text" placeholder="Rechercher\u2026" autocomplete="off" />'
      + '<div class="bhacl" id="bh-acl" style="display:none"></div></div>'
      + '<div><div class="bhlb">Provider</div><input class="bhin" id="bh-prov" type="text" placeholder="Auto" readonly /></div>'
      + '<div><div class="bhlb">Mise</div><input class="bhin" id="bh-bet" type="number" value="1" min="0.01" step="0.01" /></div>'
      + '<div style="display:flex;flex-direction:column;justify-content:flex-end"><button class="bhbtn p" id="bh-add">+ Ajouter</button></div></div>'
      + '<div class="bhst">Tableau des bonus</div>'
      + '<table class="bhtb"><thead><tr><th>#</th><th>Jeu</th><th>Provider</th><th>Mise</th><th>Gain</th><th>Multiplicateur</th><th>Statut</th><th></th></tr></thead>'
      + '<tbody id="bh-tbody"><tr><td colspan="8" class="bhemp">Aucun bonus ajout\u00e9</td></tr></tbody></table>'
      + '</div><div id="bh-rsz">\u25e2</div>';
    document.body.appendChild(win);
    win.style.cssText += ';top:60px;left:' + Math.max(0,(window.innerWidth-700)/2) + 'px';
    bhDrag(win, document.getElementById('bh-tb'));
    bhResize(win, document.getElementById('bh-rsz'));
    document.getElementById('bh-min').addEventListener('click', function() {
      bhMinimized = !bhMinimized;
      document.getElementById('bh-cnt').classList.toggle('bh-mini', bhMinimized);
      document.getElementById('bh-min').textContent = bhMinimized ? '\u25a1' : '\u2014';
    });
    document.getElementById('bh-cls').addEventListener('click', bhClose);
    document.getElementById('bh-rst').addEventListener('click', function() {
      var btn = document.getElementById('bh-rst');
      if (btn.getAttribute('data-confirm') === '1') {
        bhBonuses = []; bhNextId = 1;
        btn.removeAttribute('data-confirm');
        btn.textContent = 'Remettre à zéro';
        btn.style.background = '';
        bhRender();
      } else {
        btn.setAttribute('data-confirm', '1');
        btn.textContent = 'Confirmer ?';
        btn.style.background = '#ff444444';
        setTimeout(function() {
          btn.removeAttribute('data-confirm');
          btn.textContent = 'Remettre à zéro';
          btn.style.background = '';
        }, 3000);
      }
    });
    document.getElementById('bh-start').addEventListener('input', bhRender);
    document.getElementById('bh-cur').addEventListener('change', bhRender);
    var gi = document.getElementById('bh-game');
    gi.addEventListener('input', bhAC);
    gi.addEventListener('focus', bhAC);
    gi.addEventListener('blur', function() { setTimeout(function() { var l=document.getElementById('bh-acl'); if(l) l.style.display='none'; }, 200); });
    document.getElementById('bh-add').addEventListener('click', bhAdd);
    bhRender();
  }

  function bhOpen() { bhBuild(); bhLoadSlots(); document.getElementById('bh-win').classList.add('bh-visible'); }
  function bhClose() { var w=document.getElementById('bh-win'); if(w) w.classList.remove('bh-visible'); }

  function bhDrag(el, handle) {
    var ox,oy,mx,my;
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault(); ox=el.offsetLeft; oy=el.offsetTop; mx=e.clientX; my=e.clientY;
      function move(e) { el.style.left=Math.max(0,ox+e.clientX-mx)+'px'; el.style.top=Math.max(0,oy+e.clientY-my)+'px'; }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', function() { document.removeEventListener('mousemove', move); }, {once:true});
    });
  }

  function bhResize(el, handle) {
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault(); var sw=el.offsetWidth,sh=el.offsetHeight,sx=e.clientX,sy=e.clientY;
      function resize(e) { el.style.width=Math.max(400,sw+e.clientX-sx)+'px'; el.style.height=Math.max(200,sh+e.clientY-sy)+'px'; }
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', function() { document.removeEventListener('mousemove', resize); }, {once:true});
    });
  }

  function bhAC() {
    var q=(document.getElementById('bh-game').value||'').toLowerCase().trim();
    var list=document.getElementById('bh-acl');
    if (!q||!bhSlots.length) { list.style.display='none'; return; }
    var matches=bhSlots.filter(function(s){ return s.name&&s.name.toLowerCase().indexOf(q)>=0; }).slice(0,8);
    if (!matches.length) { list.style.display='none'; return; }
    list.innerHTML = matches.map(function(s) {
      var p=(s.provider&&s.provider.name)||'\u2014';
      var img=s.thumbnailUrl ? '<img class="bhacim" src="'+s.thumbnailUrl+'" alt="" onerror="this.style.display=\'none\'">'
        : '<div class="bhacim" style="display:flex;align-items:center;justify-content:center">\uD83C\uDFB0</div>';
      return '<div class="bhaci" data-n="'+s.name.replace(/"/g,'&quot;')+'" data-p="'+p.replace(/"/g,'&quot;')+'" data-t="'+(s.thumbnailUrl||'').replace(/"/g,'&quot;')+'">'
        +img+'<div><div class="bhacan">'+s.name+'</div><div class="bhacap">'+p+'</div></div></div>';
    }).join('');
    list.querySelectorAll('.bhaci').forEach(function(item) {
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        document.getElementById('bh-game').value=item.getAttribute('data-n');
        document.getElementById('bh-prov').value=item.getAttribute('data-p');
        list.style.display='none';
        bhSelThumb=item.getAttribute('data-t')||'';
      });
    });
    list.style.display='block';
  }

  function bhAdd() {
    var game=document.getElementById('bh-game').value.trim();
    var prov=document.getElementById('bh-prov').value.trim()||'\u2014';
    var bet=parseFloat(document.getElementById('bh-bet').value)||0;
    if (!game) { document.getElementById('bh-game').focus(); return; }
    bhBonuses.push({id:bhNextId++,game:game,provider:prov,bet:bet,gain:null,done:false,thumb:bhSelThumb});
    document.getElementById('bh-game').value='';
    document.getElementById('bh-prov').value='';
    bhSelThumb='';
    bhRender();
  }

  function bhRender() {
    var start=parseFloat(document.getElementById('bh-start')?document.getElementById('bh-start').value:200)||0;
    var col=bhBonuses.filter(function(b){return b.done;}), pen=bhBonuses.filter(function(b){return !b.done;});
    var won=col.reduce(function(s,b){return s+(b.gain||0);},0), profit=won-start, n=bhBonuses.length;
    var tb=bhBonuses.reduce(function(s,b){return s+b.bet;},0), avg=n>0?tb/n:0;
    var el; function g(id){return document.getElementById(id);}
    if(g('bh-vs')) g('bh-vs').textContent=bhFmt(start);
    if(g('bh-vw')){g('bh-vw').textContent=bhFmt(won);g('bh-vw').className='bhsv '+(won>=start?'g':'r');}
    if(g('bh-vp')){g('bh-vp').textContent=(profit>=0?'+':'')+bhFmt(profit);g('bh-vp').className='bhsv '+(profit>=0?'g':'r');}
    if(g('bh-vsl')) g('bh-vsl').innerHTML=n+' <span style="font-size:12px;color:#8899aa">'+pen.length+' att. \u00b7 '+col.length+' col.</span>';
    var bef=avg>0&&n>0?start/(avg*n):0, bee=pen.length>0&&avg>0?(start-won)/(avg*pen.length):bef;
    if(g('bh-bf')) g('bh-bf').textContent=bhFmtX(bef);
    if(g('bh-be')) g('bh-be').textContent=bhFmtX(Math.max(0,bee));
    var top=col.slice().sort(function(a,b){return(b.gain||0)-(a.gain||0);}).slice(0,3);
    if(g('bh-top')) g('bh-top').innerHTML=top.length?top.map(function(b,i){
      var im=b.thumb?'<img src="'+b.thumb+'" style="width:16px;height:16px;border-radius:2px;object-fit:cover;vertical-align:middle;margin-right:4px" alt="">':'';
      return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>'+['\uD83E\uDD47','\uD83E\uDD48','\uD83E\uDD49'][i]+' '+im+b.game+'</span><span style="font-weight:700">'+bhFmtX((b.gain||0)/b.bet)+' \u2192 '+bhFmt(b.gain||0)+'</span></div>';
    }).join(''):'<span style="color:#8899aa">Aucun bonus collect\u00e9</span>';
    var tbody=g('bh-tbody'); if(!tbody) return;
    if(!bhBonuses.length){tbody.innerHTML='<tr><td colspan="8" class="bhemp">Aucun bonus ajout\u00e9</td></tr>';return;}
    tbody.innerHTML=bhBonuses.map(function(b,i){
      var im=b.thumb?'<img class="bhsim" src="'+b.thumb+'" alt="" onerror="this.style.display=\'none\'">':'\uD83C\uDFB0 ';
      var gainTd=b.done
        ?'<span class="bh-gd" data-id="'+b.id+'" style="cursor:pointer;'+(b.gain>b.bet?'color:#00ff88':'color:#ff4444')+'" title="Cliquer pour modifier">'+bhFmt(b.gain)+'</span>'
        :'<input class="bhin bh-gi" data-id="'+b.id+'" type="number" min="0" step="0.01" placeholder="Gain\u2026" style="width:100px;padding:4px 8px;font-size:12px" />';
      var multi=b.done?bhFmtX((b.gain||0)/b.bet):'\u2014';
      var badge=b.done?'<span class="bhbadge don">\u2713 Collect\u00e9</span>':'<span class="bhbadge pen">\u23f3 En attente</span>';
      return '<tr><td style="color:#8899aa">'+(i+1)+'</td><td><span style="font-weight:600">'+im+b.game+'</span></td>'
        +'<td style="color:#8899aa">'+b.provider+'</td><td>'+bhFmt(b.bet)+'</td><td>'+gainTd+'</td>'
        +'<td style="color:#8899aa">'+multi+'</td><td>'+badge+'</td>'
        +'<td><button class="bhbtn d bh-rb" data-id="'+b.id+'" style="padding:3px 8px;font-size:11px">\u2715</button></td></tr>';
    }).join('');
    tbody.querySelectorAll('.bh-gi').forEach(function(inp) {
      function save(){
        if(inp.value==='') return;
        var v=parseFloat(inp.value.replace(',','.'));
        if(isNaN(v)||v<0) return;
        var id=parseInt(inp.getAttribute('data-id'));
        bhBonuses=bhBonuses.map(function(b){return b.id===id?Object.assign({},b,{gain:v,done:true}):b;});
        bhRender();
      }
      inp.addEventListener('keydown',function(e){if(e.key==='Enter')save();});
      inp.addEventListener('blur',save);
    });
    tbody.querySelectorAll('.bh-gd').forEach(function(sp) {
      sp.addEventListener('click',function(){
        var id=parseInt(sp.getAttribute('data-id'));
        bhBonuses=bhBonuses.map(function(b){return b.id===id?Object.assign({},b,{done:false}):b;});
        bhRender();
        setTimeout(function(){var i=tbody.querySelector('.bh-gi[data-id="'+id+'"]');if(i)i.focus();},50);
      });
    });
    tbody.querySelectorAll('.bh-rb').forEach(function(btn) {
      btn.addEventListener('click',function(){
        var id=parseInt(btn.getAttribute('data-id'));
        bhBonuses=bhBonuses.filter(function(b){return b.id!==id;});
        bhRender();
      });
    });
  }
  // ══ FIN BONUS HUNT ═══════════════════════════════════════════════════════════

  function renderRang() {
    var el       = document.getElementById('srn-rang-result');
    var selEl    = document.getElementById('srn-rang-select');
    var pctInput = document.getElementById('srn-rang-pct');
    var slider   = document.getElementById('srn-rang-slider');
    if (!el || !selEl) return;
    // Peupler le select si vide
    if (selEl.options.length === 0) {
      STAKE_RANKS.filter(function(r) { return r.max !== Infinity; }).forEach(function(r, i) {
        var opt = document.createElement('option');
        opt.value = i;
        opt.textContent = r.icon + ' ' + r.name + ' (' + r.min.toLocaleString() + '$ - ' + r.max.toLocaleString() + '$)';
        selEl.appendChild(opt);
      });
      selEl.addEventListener('change', renderRang);
      if (pctInput) pctInput.addEventListener('input', function() {
        if (slider) slider.value = pctInput.value;
        renderRang();
      });
      if (slider) slider.addEventListener('input', function() {
        if (pctInput) pctInput.value = slider.value;
        renderRang();
      });
    }
    var rankIdx = parseInt(selEl.value) || 0;
    var pct     = parseFloat(pctInput ? pctInput.value : 0) || 0;
    var rank    = STAKE_RANKS[rankIdx];
    var next    = STAKE_RANKS[rankIdx + 1] || null;
    if (!rank || !next) { el.innerHTML = '<div class="srn-empty">Rang maximum atteint !</div>'; return; }
    // Calcul du wager actuel et restant
    var rangSize    = next.min - rank.min;
    var wagered     = rank.min + (rangSize * pct / 100);
    var remaining   = next.min - wagered;
    var pctFill     = Math.min(100, Math.round(pct));
    el.innerHTML = [
      '<div class="srn-stat-card" style="border-color:' + rank.color + '44;margin-bottom:10px">',
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">',
          '<div>',
            '<div style="font-size:10px;color:#8899aa">Rang actuel</div>',
            '<div style="font-size:18px;font-weight:800;color:' + rank.color + '">' + rank.icon + ' ' + rank.name + '</div>',
          '</div>',
          '<div style="font-size:28px;font-weight:800;color:' + rank.color + '">' + pctFill + '%</div>',
        '</div>',
        '<div class="srn-progress-bar"><div class="srn-progress-fill" style="width:' + pctFill + '%;background:' + rank.color + '"></div></div>',
        '<div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px">',
          '<div style="background:#0f192388;border-radius:6px;padding:6px 8px">',
            '<div style="color:#8899aa;font-size:10px">Wager actuel estim\u00e9</div>',
            '<div style="color:#fff;font-weight:700;font-size:13px">' + Math.round(wagered).toLocaleString() + '$</div>',
          '</div>',
          '<div style="background:#0f192388;border-radius:6px;padding:6px 8px">',
            '<div style="color:#8899aa;font-size:10px">Reste pour</div>',
            '<div style="color:' + next.color + ';font-weight:700;font-size:13px">' + next.icon + ' ' + next.name + '</div>',
          '</div>',
        '</div>',
        '<div style="margin-top:8px;background:#00d4ff11;border:1px solid #00d4ff33;border-radius:8px;padding:10px;text-align:center">',
          '<div style="color:#8899aa;font-size:11px">Il te reste a wager</div>',
          '<div style="color:#00d4ff;font-size:22px;font-weight:800">' + Math.round(remaining).toLocaleString() + '$</div>',
          '<div style="color:#8899aa;font-size:10px">pour atteindre ' + next.icon + ' ' + next.name + '</div>',
        '</div>',
      '</div>',
    ].join('');
  }
  // Cryptos a suivre : [symbol, coingecko_id]
  var CRYPTO_LIST = [
    ['USDT','tether'],['BTC','bitcoin'],['ETH','ethereum'],['LTC','litecoin'],
    ['SOL','solana'],['DOGE','dogecoin'],['BCH','bitcoin-cash'],['XRP','ripple'],
    ['TRX','tron'],['EOS','eos'],['BNB','binancecoin'],['USDC','usd-coin'],
    ['APE','apecoin'],['BUSD','binance-usd'],['CRO','crypto-com-chain'],
    ['DAI','dai'],['LINK','chainlink'],['SAND','the-sandbox'],
    ['SHIB','shiba-inu'],['UNI','uniswap'],['POL','matic-network'],['TRUMP','maga']
  ];
  var cryptoPrices = {}; var cryptoLastFetch = 0;
  // Devise fiat de l'utilisateur (detectee depuis le DOM de Stake)
  var userFiatCurrency = 'eur'; // par defaut
  var userFiatSymbol = '€';
  var FIAT_SYMBOLS = { 'eur': '€', 'usd': '$', 'cad': 'CA$', 'gbp': '£', 'jpy': '¥', 'aud': 'A$', 'brl': 'R$', 'inr': '₹' };

  function detectFiatCurrency() {
    try {
      var el = document.querySelector('[class*="currency"]');
      if (!el) return;
      var txt = (el.textContent || '').trim();
      if (txt.indexOf('€') >= 0) { userFiatCurrency = 'eur'; userFiatSymbol = '€'; }
      else if (txt.indexOf('CA$') >= 0) { userFiatCurrency = 'cad'; userFiatSymbol = 'CA$'; }
      else if (txt.indexOf('A$') >= 0) { userFiatCurrency = 'aud'; userFiatSymbol = 'A$'; }
      else if (txt.indexOf('$') >= 0) { userFiatCurrency = 'usd'; userFiatSymbol = '$'; }
      else if (txt.indexOf('£') >= 0) { userFiatCurrency = 'gbp'; userFiatSymbol = '£'; }
      else if (txt.indexOf('R$') >= 0) { userFiatCurrency = 'brl'; userFiatSymbol = 'R$'; }
      console.log('[StakePulse] Devise fiat detectee:', userFiatCurrency, userFiatSymbol);
    } catch(e) {}
  }

  function cryptoToFiat(amount, cryptoSymbol) {
    if (!amount) return 0;
    var sym = (cryptoSymbol || '').toLowerCase();
    // USDT/USDC/BUSD/DAI = stable 1:1 USD
    if (['usdt','usdc','busd','dai'].indexOf(sym) >= 0) {
      if (userFiatCurrency === 'usd') return amount;
      // Convertir USD → fiat via taux EUR (approximation)
      if (userFiatCurrency === 'eur' && cryptoPrices['tether']) return amount * (cryptoPrices['tether'].eur || 0.92);
      return amount;
    }
    var cgMap = {
      'btc':'bitcoin','eth':'ethereum','sol':'solana','ltc':'litecoin',
      'doge':'dogecoin','xrp':'ripple','trx':'tron','bnb':'binancecoin',
      'bch':'bitcoin-cash','eos':'eos','ape':'apecoin','link':'chainlink',
      'shib':'shiba-inu','uni':'uniswap','pol':'matic-network','trump':'maga',
      'cro':'crypto-com-chain','sand':'the-sandbox'
    };
    var cgId = cgMap[sym];
    if (!cgId || !cryptoPrices[cgId]) return 0;
    return amount * (cryptoPrices[cgId][userFiatCurrency] || cryptoPrices[cgId]['eur'] || 0);
  }
  function fetchCryptoPrices(callback) {
    var ids = CRYPTO_LIST.map(function(c) { return c[1]; }).join(',');
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd,eur&include_24hr_change=true';
    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      onload: function(res) {
        try {
          cryptoPrices = JSON.parse(res.responseText);
          cryptoLastFetch = Date.now();
          if (callback) callback();
        } catch(e) {
          var st = document.getElementById('srn-crypto-status');
          if (st) st.textContent = 'Erreur de chargement';
        }
      },
      onerror: function() {
        var st = document.getElementById('srn-crypto-status');
        if (st) st.textContent = 'Erreur reseau';
      }
    });
  }
  function updateTicker() {
    var inner = document.getElementById('srn-ticker-inner');
    if (!inner || !Object.keys(cryptoPrices).length) return;
    function fmtPrice(p) {
      if (!p) return '0';
      if (p >= 1000) return p.toLocaleString('fr-FR', {maximumFractionDigits:0});
      if (p >= 1)    return p.toFixed(2);
      if (p >= 0.01) return p.toFixed(4);
      return p.toFixed(8);
    }
    var html = CRYPTO_LIST.map(function(c) {
      var data = cryptoPrices[c[1]] || {};
      var usd  = data.usd || 0;
      var chg  = data.usd_24h_change || 0;
      var chgClass = chg >= 0 ? 'srn-tick-up' : 'srn-tick-down';
      var arrow    = chg >= 0 ? '\u25b2' : '\u25bc';
      return '<span class="srn-tick-item">'
        + '<span class="srn-tick-sym">' + c[0] + '</span>'
        + '<span class="srn-tick-price">$' + fmtPrice(usd) + '</span>'
        + '<span class="' + chgClass + '">' + arrow + ' ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</span>'
        + '</span>';
    }).join('<span style="color:#1e3a4a;margin:0 4px">|</span>');
    inner.innerHTML = html;
  }
  function renderCrypto() {
    var el     = document.getElementById('srn-crypto-list');
    var miniEl = document.getElementById('srn-crypto-mini-list');
    var selEl  = document.getElementById('srn-crypto-select');
    if (!el) return;
    var now = Date.now();
    if (now - cryptoLastFetch > 60000 || !Object.keys(cryptoPrices).length) {
      return;
    }
    // Peupler le select si vide
    if (selEl && selEl.options.length === 0) {
      CRYPTO_LIST.forEach(function(c, i) {
        var opt = document.createElement('option');
        opt.value = i;
        opt.textContent = c[0];
        selEl.appendChild(opt);
      });
      selEl.addEventListener('change', renderCrypto);
    }
    var st = document.getElementById('srn-crypto-status');
    if (st) st.textContent = 'Mis a jour : ' + new Date(cryptoLastFetch).toLocaleTimeString('fr-FR');
    function fmtPrice(p) {
      if (!p) return '0';
      if (p >= 1000) return p.toLocaleString('fr-FR', {maximumFractionDigits:0});
      if (p >= 1)    return p.toFixed(2);
      if (p >= 0.01) return p.toFixed(4);
      return p.toFixed(8);
    }
    // Fiche d\u00e9taill\u00e9e de la crypto s\u00e9lectionn\u00e9e
    var selIdx = selEl ? parseInt(selEl.value) || 0 : 0;
    var selC   = CRYPTO_LIST[selIdx];
    var selData = cryptoPrices[selC[1]] || {};
    var usd  = selData.usd || 0;
    var eur  = selData.eur || 0;
    var chg  = selData.usd_24h_change || 0;
    var chgColor = chg >= 0 ? '#00ff88' : '#ff4444';
    el.innerHTML = [
      '<div class="srn-stat-card" style="border-color:#00d4ff33">',
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">',
          '<div>',
            '<div style="font-size:22px;font-weight:800;color:#fff">' + selC[0] + '</div>',
            '<div style="font-size:11px;color:#8899aa">' + selC[1] + '</div>',
          '</div>',
          '<div style="text-align:right">',
            '<div style="font-size:20px;font-weight:800;color:#00d4ff">$' + fmtPrice(usd) + '</div>',
            '<div style="font-size:12px;color:#8899aa">' + fmtPrice(eur) + '\u20ac</div>',
          '</div>',
        '</div>',
        '<div style="display:flex;align-items:center;gap:8px">',
          '<span style="font-size:12px;color:' + chgColor + ';background:' + chgColor + '22;border-radius:6px;padding:3px 10px;font-weight:700">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% (24h)</span>',
        '</div>',
      '</div>',
    ].join('');
    // Mini liste compacte de toutes les cryptos
    if (miniEl) miniEl.innerHTML = CRYPTO_LIST.map(function(c, idx) {
      var data = cryptoPrices[c[1]] || {};
      var p    = data.usd || 0;
      var ch   = data.usd_24h_change || 0;
      var cc   = ch >= 0 ? '#00ff88' : '#ff4444';
      var isSel = idx === selIdx;
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 6px;border-radius:6px;margin-bottom:3px;cursor:pointer;background:' + (isSel ? '#00d4ff11' : 'transparent') + ';border:1px solid ' + (isSel ? '#00d4ff33' : 'transparent') + '" onclick="document.getElementById(\'srn-crypto-select\').value=' + idx + ';renderCrypto && renderCrypto()">'
        + '<span style="font-weight:700;font-size:11px;color:' + (isSel ? '#00d4ff' : '#cdd9e5') + ';min-width:44px">' + c[0] + '</span>'
        + '<span style="font-size:11px;color:#fff;font-weight:600">$' + fmtPrice(p) + '</span>'
        + '<span style="font-size:10px;color:' + cc + ';min-width:50px;text-align:right">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%</span>'
        + '</div>';
    }).join('');
  }
  // Rafraichissement auto toutes les 60s si l'onglet est ouvert
  setInterval(function() {
    if (curTab === 'crypto' && document.getElementById('tab-crypto') && document.getElementById('tab-crypto').classList.contains('active')) renderCrypto();
  }, 60000);
  // Verification des mises a jour
  var CURRENT_VERSION = '1.1.1'; // Doit correspondre a @version
  var RAW_URL = 'https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js';
  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: 'GET', url: RAW_URL,
      onload: function(res) {
        try {
          var m = res.responseText.match(/\/\/ @version\s+([\d.]+)/);
          if (m && m[1] !== CURRENT_VERSION) showUpdateBanner(m[1]);
        } catch(e) {}
      }, onerror: function() {}
    });
  }
  function showUpdateBanner(newVersion) {
    if (document.getElementById('srn-update-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'srn-update-banner';
    banner.style.cssText = 'background:#162330;border:1px solid #00ff8855;border-radius:8px;padding:8px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px';
    banner.innerHTML = '<div style="display:flex;align-items:center;gap:6px">'
      + '<span style="font-size:16px">&#127381;</span>'
      + '<div><div style="color:#00ff88;font-weight:700">Mise a jour disponible !</div>'
      + '<div style="color:#8899aa">Version ' + newVersion + ' disponible</div></div></div>'
      + '<button id="srn-update-btn" style="background:#00ff8822;border:1px solid #00ff8855;border-radius:6px;color:#00ff88;cursor:pointer;font-size:11px;font-weight:700;padding:4px 10px">Installer puis rafraichir</button>';
    var body = document.getElementById('srn-body');
    if (body) body.insertBefore(banner, body.firstChild);
    document.getElementById('srn-update-btn').addEventListener('click', function() {
      // Ouvre le .user.js — Tampermonkey intercepte et propose l'installation
      window.open(RAW_URL.replace('raw.githubusercontent.com', 'raw.githubusercontent.com'), '_blank');
      setTimeout(function() { location.reload(); }, 3000);
    });
  }
  var STAKE_CURRENCIES = [
    'USD','EUR','CAD','JPY','CNY','RUB','INR','IDR','KRW','PHP',
    'MXN','PLN','TRY','VND','ARS','PEN','CLP','NGN','AED','BHD',
    'CRC','KWD','MAD','MYR','QAR','SAR','SGD','TND','TWD','GHS',
    'KES','BOB','XOF','PKR','NZD','ISK','BAM','TZS','EGP','UGX'
  ];
  var convRates = {}; var convBase = 'EUR'; var convLastFetch = 0;
  function fetchRates(callback) {
    var now = Date.now();
    if (now - convLastFetch < 30*60*1000 && Object.keys(convRates).length > 0) {
      callback(); return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://api.exchangerate-api.com/v4/latest/EUR',
      onload: function(res) {
        try {
          var data = JSON.parse(res.responseText);
          convRates = data.rates;
          convBase = 'EUR';
          convLastFetch = Date.now();
          callback();
        } catch(e) {
          var rateEl = document.getElementById('srn-conv-rate');
          if (rateEl) rateEl.textContent = 'Erreur de chargement des taux';
        }
      },
      onerror: function() {
        var rateEl = document.getElementById('srn-conv-rate');
        if (rateEl) rateEl.textContent = 'Erreur reseau - verifiez votre connexion';
      }
    });
  }
  function convertAmount(amount, from, to) {
    if (!convRates[from] || !convRates[to]) return null;
    var inEur = amount / convRates[from];
    return inEur * convRates[to];
  }
  function renderEmojiStats() {
    var el = document.getElementById('srn-emoji-content');
    if (!el) return;
    var counts = load(SK_EMOJI_COUNT, {});
    var sorted = Object.entries(counts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .filter(function(e) { return e[1] > 0; });
    if (emojiPeriod === 'top') sorted = sorted.slice(0, 10);
    if (!sorted.length) {
      el.innerHTML = '<div class="srn-empty">Aucun emoji detecte pour le moment.</div>';
      return;
    }
    var max = sorted[0][1];
    el.innerHTML = sorted.map(function(e) {
      var name  = e[0], count = e[1];
      var pct   = Math.round((count / max) * 100);
      var imgSrc = 'https://stake.bet/_app/immutable/assets/' + name + '.' + (name === 'blob' || name === 'nyancat' || name === 'coin' || name === 'catbread' ? 'gif' : 'png');
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">'
        + '<img src="' + imgSrc + '" style="width:24px;height:24px;border-radius:4px;flex-shrink:0" onerror="this.style.display=\'none\'"/>'
        + '<span style="font-size:11px;color:#cdd9e5;min-width:70px">:' + name + ':</span>'
        + '<div style="flex:1;background:#1e3a4a;border-radius:999px;height:6px;overflow:hidden">'
        + '<div style="height:100%;border-radius:999px;background:#00d4ff;width:' + pct + '%"></div></div>'
        + '<span style="color:#00d4ff;font-weight:700;font-size:12px;min-width:30px;text-align:right">' + count + '</span>'
        + '</div>';
    }).join('');
  }
  function renderConverter() {
    var fromSel = document.getElementById('srn-conv-from');
    var toSel   = document.getElementById('srn-conv-to');
    if (!fromSel || !toSel) return;
    // Peupler les selects si vides
    if (fromSel.options.length === 0) {
      STAKE_CURRENCIES.forEach(function(c) {
        var o1 = document.createElement('option'); o1.value = c; o1.textContent = c; fromSel.appendChild(o1);
        var o2 = document.createElement('option'); o2.value = c; o2.textContent = c; toSel.appendChild(o2);
      });
      fromSel.value = 'EUR';
      toSel.value   = 'CAD';
      // Auto-convert quand on change les selects
      fromSel.addEventListener('change', function() { window._srn.convertCurrency(); });
      toSel.addEventListener('change',   function() { window._srn.convertCurrency(); });
    var rangInput = document.getElementById('srn-rang-wager');
    if (rangInput) rangInput.addEventListener('input', function() { renderRang(); });
    var rangSel = document.getElementById('srn-rang-select');
    if (rangSel) rangSel.addEventListener('change', renderRang);
    var rangPct = document.getElementById('srn-rang-pct');
    var rangSlider = document.getElementById('srn-rang-slider');
    if (rangPct) rangPct.addEventListener('input', function() { if (rangSlider) rangSlider.value = rangPct.value; renderRang(); });
    if (rangSlider) rangSlider.addEventListener('input', function() { if (rangPct) rangPct.value = rangSlider.value; renderRang(); });
      document.getElementById('srn-conv-amount').addEventListener('input', function() { window._srn.convertCurrency(); });
    }
    fetchRates(function() {
      window._srn.convertCurrency();
      // Conversions rapides depuis la devise selectionnee
      var quick = document.getElementById('srn-conv-quick');
      var from  = fromSel.value;
      var amount = parseFloat(document.getElementById('srn-conv-amount').value) || 1;
      var quickCurrencies = ['USD','EUR','CAD','GBP','JPY','CHF'];
      if (quick) quick.innerHTML = quickCurrencies.filter(function(c){return c!==from;}).map(function(c) {
        var res = convertAmount(amount, from, c);
        var val = res !== null ? res.toFixed(4) : '-';
        return '<div class="srn-stat-card" style="padding:6px 10px">'
          + '<div class="srn-stat-card-title">' + c + '</div>'
          + '<div style="color:#00d4ff;font-weight:700;font-size:14px">' + val + '</div>'
          + '</div>';
      }).join('');
      var rateEl = document.getElementById('srn-conv-rate');
      if (rateEl) rateEl.textContent = 'Taux mis a jour : ' + new Date(convLastFetch).toLocaleTimeString('fr-FR');
    });
  }
  function renderWager() {
    var el = document.getElementById('srn-wager-content');
    if (!el) return;
    var wager = load(SK_WAGER, []);
    var now = Date.now();
    var dayStart = new Date(); dayStart.setHours(0,0,0,0); dayStart = dayStart.getTime();
    var periodStart = {
      day:   dayStart,
      week:  getWeekStart(new Date()).getTime(),
      month: getMonthStart(new Date()).getTime(),
      year:  new Date(new Date().getFullYear(), 0, 1).getTime(),
    }[wagerPeriod] || dayStart;

    // Filtre jeu
    var selectedGame = el.getAttribute('data-game-filter') || 'all';
    var filtered = wager.filter(function(w){ return w.ts >= periodStart; });
    if (selectedGame !== 'all') filtered = filtered.filter(function(w){ return (w.game||'Inconnu') === selectedGame; });

    // Stats
    var totalMise   = filtered.reduce(function(s,w){ return s + (w.amountFiat||0); }, 0);
    var totalProfit = filtered.reduce(function(s,w){ return s + (w.profitFiat||0); }, 0);
    var gains  = filtered.filter(function(w){ return (w.profit||0) > 0; }).length;
    var pertes = filtered.filter(function(w){ return (w.profit||0) <= 0; }).length;
    var count  = filtered.length;
    var periodLabel = { day: "aujourd'hui", week: 'cette semaine', month: 'ce mois', year: 'cette annee' }[wagerPeriod];

    // Liste des jeux disponibles
    var allGames = [];
    wager.filter(function(w){ return w.ts >= periodStart; }).forEach(function(w){
      var g = w.game || 'Inconnu';
      if (allGames.indexOf(g) < 0) allGames.push(g);
    });
    allGames.sort();

    // Menu déroulant jeux
    var gameOptions = '<option value="all">Tous les jeux</option>' +
      allGames.map(function(g){ return '<option value="' + escHtml(g) + '"' + (selectedGame===g?' selected':'') + '>' + escHtml(g) + '</option>'; }).join('');
    var gameSelect = '<select id="srn-game-filter" style="width:100%;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#cdd9e5;padding:5px 8px;font-size:12px;margin-bottom:8px">' + gameOptions + '</select>';

    // Courbe profit SVG
    var svgHtml = '';
    if (filtered.length > 1) {
      var points = [];
      var cumul = 0;
      filtered.forEach(function(w){ cumul += (w.profit||0); points.push(cumul); });
      var minP = Math.min.apply(null, points);
      var maxP = Math.max.apply(null, points);
      var range = maxP - minP || 1;
      var W = 240, H = 80, pad = 8;
      var coords = points.map(function(p, i){
        var x = pad + (i / (points.length-1)) * (W - pad*2);
        var y = pad + (1 - (p - minP) / range) * (H - pad*2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      var lineColor = totalProfit >= 0 ? '#00ff88' : '#ff4444';
      var zeroY = pad + (1 - (0 - minP) / range) * (H - pad*2);
      zeroY = Math.max(pad, Math.min(H - pad, zeroY));
      svgHtml = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;background:#0f1923;border-radius:8px;margin-top:8px">'
        + '<line x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W-pad) + '" y2="' + zeroY.toFixed(1) + '" stroke="#ffffff18" stroke-width="1" stroke-dasharray="3,3"/>'
        + '<polyline points="' + coords.join(' ') + '" fill="none" stroke="' + lineColor + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
        + '</svg>';
    }

    var displayCurrency = userFiatSymbol || '€';
    var profitColor = totalProfit >= 0 ? '#00ff88' : '#ff4444';
    el.innerHTML = [
      gameSelect,
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Profit</div><div class="srn-stat-card-val" style="color:' + profitColor + '">' + (totalProfit>=0?'+':'') + totalProfit.toFixed(2) + displayCurrency + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Mis\u00e9</div><div class="srn-stat-card-val">' + totalMise.toFixed(2) + displayCurrency + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Gains</div><div class="srn-stat-card-val" style="color:#00ff88">' + gains + '</div></div>',
        '<div class="srn-stat-card"><div class="srn-stat-card-title">Pertes</div><div class="srn-stat-card-val" style="color:#ff4444">' + pertes + '</div></div>',
      '</div>',
      svgHtml,
      count === 0 ? '<div class="srn-empty" style="margin-top:8px">Aucun bet d\u00e9tect\u00e9. Joue sur Stake pour voir tes stats !</div>' : '',
    ].join('');

    // Listener menu déroulant
    var sel = document.getElementById('srn-game-filter');
    if (sel) sel.addEventListener('change', function(){
      el.setAttribute('data-game-filter', this.value);
      renderWager();
    });
  }
  function renderMultip() {
    var el = document.getElementById('srn-multip-content');
    if (!el) return;
    var cfg = getMultipConfig();
    var log = load(SK_MULTIP, []);
    var maxMult = log.length ? Math.max.apply(null, log.map(function(e) { return e.multiplier; })) : 0;
    var recentHtml = log.slice(0, 20).map(function(e) {
      var time = new Date(e.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      var color = e.multiplier >= 1000 ? '#ff00ff' : e.multiplier >= 500 ? '#ffd700' : e.multiplier >= 100 ? '#00ff88' : '#00d4ff';
      return '<div class="srn-multip-row srn-multip-hit">'
        + '<span class="srn-multip-val" style="color:' + color + '">x' + e.multiplier.toFixed(2) + '</span>'
        + '<span class="srn-multip-game">' + escHtml(e.game || 'Inconnu') + (e.gameType === 'slot' ? ' <span style="font-size:9px;color:#ff9500">[Slot]</span>' : '') + '</span>'
        + '<span class="srn-multip-time">' + time + '</span>'
        + '</div>';
    }).join('') || '<div class="srn-empty">Aucun multiplicateur detecte.<br><span style="font-size:10px">Joue sur Stake pour voir les multips !</span></div>';
    var gamesHtml = (cfg.games || []).map(function(g, i) {
      return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">'
        + '<span style="flex:1;color:#cdd9e5;font-size:12px">' + escHtml(g.name) + '</span>'
        + '<span style="color:#ffd700;font-size:12px;font-weight:700">x' + g.threshold + '</span>'
        + '<button data-srn="removeMultipGame" data-idx="' + i + '" style="background:none;border:none;color:#ff444488;cursor:pointer;font-size:14px;padding:0 2px">&#x2715;</button>'
        + '</div>';
    }).join('') || '<div style="color:#8899aa;font-size:11px">Aucun seuil specifique.</div>';
    el.innerHTML = [
      // Statut on/off + seuil global
      '<div class="srn-stat-card" style="margin-bottom:8px">',
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">',
          '<span style="font-weight:700;color:#fff">Notifications multiplicateur</span>',
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">',
            '<input type="checkbox" id="srn-multip-enabled" ' + (cfg.enabled ? 'checked' : '') + ' style="accent-color:#00d4ff;width:16px;height:16px" />',
            '<span style="color:#8899aa;font-size:11px">Actif</span>',
          '</label>',
        '</div>',
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">',
          '<label style="color:#8899aa;font-size:11px;white-space:nowrap">Seuil global :</label>',
          '<span style="color:#ffd700;font-weight:800;font-size:14px">x</span>',
          '<input type="number" id="srn-multip-global" value="' + cfg.globalThreshold + '" min="2" max="100000" style="width:80px;background:#0f1923;border:1px solid #1e3a4a;border-radius:6px;color:#ffd700;padding:4px 8px;font-size:13px;font-weight:700" />',
          '<button data-srn="saveMultipConfig" style="padding:4px 12px;border-radius:6px;border:1px solid #00d4ff55;background:#00d4ff11;color:#00d4ff;cursor:pointer;font-size:11px;font-weight:600">Sauver</button>',
        '</div>',
        maxMult > 0 ? '<div style="color:#8899aa;font-size:10px">Record : <span style="color:#ffd700;font-weight:700">x' + maxMult.toFixed(2) + '</span></div>' : '',
      '</div>',
      // Seuils par jeu
      '<div class="srn-sec-title">Seuils par jeu</div>',
      '<div style="display:flex;gap:5px;margin-bottom:8px">',
        '<select id="srn-multip-game-type" style="background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:11px">',
            '<option value="original">Original Stake</option>',
            '<option value="slot">Slot</option>',
          '</select>',
          '<input type="text" id="srn-multip-game-name" placeholder="Nom du jeu (ex: crash)" style="flex:1;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#fff;padding:4px 8px;font-size:11px" />',
        '<input type="number" id="srn-multip-game-thresh" placeholder="x?" min="2" value="50" style="width:60px;background:#162330;border:1px solid #1e3a4a;border-radius:6px;color:#ffd700;padding:4px 8px;font-size:11px;font-weight:700" />',
        '<button data-srn="addMultipGame" style="padding:4px 10px;border-radius:6px;border:1px solid #00d4ff55;background:#00d4ff11;color:#00d4ff;cursor:pointer;font-size:11px;font-weight:600">+ Add</button>',
      '</div>',
      '<div id="srn-multip-games-list" style="margin-bottom:10px">' + gamesHtml + '</div>',
      // Historique
      '<div class="srn-sec-title">Historique (20 derniers)</div>',
      '<div id="srn-multip-log">' + recentHtml + '</div>',
      log.length > 0 ? '<button class="srn-btn d" style="margin-top:8px" data-srn="resetMultip">&#128465; Vider l\'historique</button>' : '',
      '<button class="srn-btn p" style="margin-top:6px" data-srn="testMultip">&#9654; Simuler une notif (test)</button>',
      '<div style="margin-top:10px;padding:8px;background:#0f1923;border:1px solid #1e3a4a33;border-radius:6px">',
    ].join('');
    var cb = document.getElementById('srn-multip-enabled');
    if (cb && !cb._hasListener) {
      cb._hasListener = true;
      cb.addEventListener('change', function() {
        var c = getMultipConfig();
        c.enabled = cb.checked;
        save(SK_MULTIP_CONFIG, c);
      });
    }
  }
  function renderRainers() {
    var el = document.getElementById('srn-rainers-list');
    if (!el) return;
    var log = load(SK_RAINERS, []);
    var startTs = rainPeriod === 'week' ? getWeekStart(new Date()).getTime() : rainPeriod === 'month' ? getMonthStart(new Date()).getTime() : 0;
    var filtered = log.filter(function(e) { return e.ts >= startTs; });
    var senders = {};
    filtered.forEach(function(e) {
      var s = e.sender || 'Inconnu';
      if (!senders[s]) senders[s] = { count: 0, total: 0, currency: e.currency };
      senders[s].count++; senders[s].total += (e.amount || 0);
    });
    var sorted = Object.entries(senders).sort(function(a, b) { return b[1].total - a[1].total || b[1].count - a[1].count; }).slice(0, 10);
    if (!sorted.length) { el.innerHTML = '<div class="srn-empty">Aucune rain pour cette periode.</div>'; return; }
    var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    el.innerHTML = '<ul style="list-style:none;margin:0;padding:0">' + sorted.map(function(e, i) {
      var name = e[0], data = e[1];
      var pos = medals[i] || (i+1) + '.';
      var amt = data.total > 0 ? '<span style="color:#00d4ff;font-weight:700;font-size:11px;background:#00d4ff11;border-radius:6px;padding:2px 6px">' + data.total.toFixed(2) + (data.currency || '') + '</span>' : '';
      return '<li style="display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid #1e3a4a22;font-size:12px">'
        + '<span style="min-width:22px;font-weight:700;font-size:11px">' + pos + '</span>'
        + '<span style="flex:1;color:#cdd9e5;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + '</span>'
        + amt + '<span style="color:#00d4ff;font-weight:700;font-size:11px;background:#00d4ff11;border-radius:6px;padding:2px 7px">' + data.count + ' rain' + (data.count > 1 ? 's' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  window._srn = {
    sendRank: function(p) { sendRankingToTelegram(p); },
    addKeyword: function() {
      var input = document.getElementById('cfg-kw-input');
      var kw = (input.value || '').trim().replace(/^@/, '');
      if (!kw) return;
      if (CONFIG.WATCH_KEYWORDS.indexOf(kw) < 0) { CONFIG.WATCH_KEYWORDS.push(kw); saveKeywords(); }
      input.value = ''; renderKeywords();
    },
    removeKeyword: function(i) { CONFIG.WATCH_KEYWORDS.splice(i, 1); saveKeywords(); renderKeywords(); },
    addCustomWord: function() {
      var id  = (document.getElementById('srn-cw-id').value || '').trim();
      var lbl = (document.getElementById('srn-cw-label').value || '').trim();
      var pat = (document.getElementById('srn-cw-pattern').value || '').trim();
      if (!id || !lbl || !pat) return;
      try {
        var regex = new RegExp(pat, 'i');
        var custom = load(SK_CUSTOMWORDS, []);
        if (!custom.some(function(w) { return w.id === id; })) {
          custom.push({ id: id, label: lbl, pattern: pat });
          save(SK_CUSTOMWORDS, custom);
          WORD_RULES.push({ id: id, label: lbl, pattern: regex, senderFilter: null, custom: true });
        }
        document.getElementById('srn-cw-id').value = '';
        document.getElementById('srn-cw-label').value = '';
        document.getElementById('srn-cw-pattern').value = '';
        renderCustomWordsList(); renderModeration();
      } catch(e) { alert('Pattern invalide'); }
    },
    removeCustomWord: function(id) {
      var custom = load(SK_CUSTOMWORDS, []).filter(function(w) { return w.id !== id; });
      save(SK_CUSTOMWORDS, custom);
      WORD_RULES = WORD_RULES.filter(function(r) { return r.id !== id || !r.custom; });
      renderCustomWordsList(); renderModeration();
    },
    saveConfig: function() {
      var tok = document.getElementById('cfg-tok').value.trim();
      var cid = document.getElementById('cfg-cid').value.trim();
      var usr = document.getElementById('cfg-usr').value.trim();
      var ina = parseInt(document.getElementById('cfg-ina').value, 10) || 10;
      var c = load(SK.USER_CONFIG, {});
      save(SK.USER_CONFIG, Object.assign({}, c, { token: tok, chatid: cid, username: usr, inactivity: ina }));
      if (tok) CONFIG.TELEGRAM_BOT_TOKEN = tok;
      if (cid) CONFIG.TELEGRAM_CHAT_ID   = cid;
      if (usr) {
        CONFIG.YOUR_USERNAME = usr;
        // Ajoute automatiquement le pseudo aux mots-cles surveilles
        if (CONFIG.WATCH_KEYWORDS.indexOf(usr) < 0) {
          CONFIG.WATCH_KEYWORDS.push(usr);
          saveKeywords();
          renderKeywords();
        }
      }
      CONFIG.INACTIVITY_MINUTES = ina;
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Sauvegarde !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 2000); }
    },
    test: function() {
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Envoi...'; st.style.color = '#8899aa'; }
      sendTelegram('Rain Notifier operationnel ! Stake.bet actif.',
        function() { if (st) { st.textContent = 'Succes !'; st.style.color = '#00ff88'; } },
        function(err) { if (st) { st.textContent = 'Erreur: ' + err; st.style.color = '#ff4444'; } }
      );
    },
    testMention: function() {
      var kw = CONFIG.WATCH_KEYWORDS[0] || 'alleluiateam';
      checkAndNotifyMention('Hey @' + kw + ' test mention', 'TestUser');
    },
    reset: function() { var el = document.getElementById('srn-reset-confirm'); if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; },
    replaySetup: function() {
      save(SK_SETUP_DONE, false);
      buildSetup();
    },
    resetConfirm: function() {
      save(SK.RAIN_LOG, []); save(SK.RANKINGS, {}); save(SK_DEDUP, {}); save(SK.MENTIONS, []); save(SK_DELETED, {}); save(SK_WORDCOUNT, []);
      GM_setValue(SK.LAST_MSG_TIME, '0'); seenMessages = new Set(); lastMentionKey = ''; inactivityAlertSent = false;
      var el = document.getElementById('srn-reset-confirm'); if (el) el.style.display = 'none';
      refreshPanel();
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Reinitialise !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 2000); }
    },
    resetCancel: function() { var el = document.getElementById('srn-reset-confirm'); if (el) el.style.display = 'none'; },
    resetEmojis: function() {
      save(SK_EMOJI_COUNT, {});
      seenEmojiKeys = new Set();
      renderEmojiStats();
    },
    resetWords: function() {
      save(SK_WORDCOUNT, []);
      if (curTab === 'moderation') renderModeration();
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Stats mots remises a zero !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 2000); }
    },
    editRanking: function(username, period) {
      var rankings = load(SK.RANKINGS, {});
      var p = rankings[username];
      if (!p || !p[period]) { alert('Joueur non trouve dans le classement.'); return; }
      var currentAmt   = p[period].totalAmount || 0;
      var currentCount = p[period].count || 0;
      var newAmt   = prompt('Montant total pour ' + username + ' (' + period + ') :\nActuel : ' + currentAmt.toFixed(2) + 'EUR\nNouveau montant (ex: 31.50) :', currentAmt.toFixed(2));
      if (newAmt === null) return;
      var newCount = prompt('Nombre de rains pour ' + username + ' (' + period + ') :\nActuel : ' + currentCount + '\nNouveau nombre :', currentCount);
      if (newCount === null) return;
      p[period].totalAmount = parseFloat(newAmt) || 0;
      p[period].count       = parseInt(newCount) || 0;
      save(SK.RANKINGS, rankings);
      renderRanking();
    },
    refreshCrypto: function() {
      cryptoLastFetch = 0;
      renderCrypto();
    },
    calcRang: function() {
      renderRang();
    },
    convertCurrency: function() {
      var amount = parseFloat(document.getElementById('srn-conv-amount').value) || 0;
      var from   = document.getElementById('srn-conv-from').value;
      var to     = document.getElementById('srn-conv-to').value;
      var resEl  = document.getElementById('srn-conv-result');
      if (!resEl) return;
      if (!Object.keys(convRates).length) {
        fetchRates(function() { window._srn.convertCurrency(); }); return;
      }
      var result = convertAmount(amount, from, to);
      resEl.textContent = result !== null ? result.toFixed(4) + ' ' + to : 'Taux indisponible';
    },
    resetWager: function() {
      save(SK_WAGER, []);
      if (curTab === 'wager') renderWager();
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Wager remis a zero !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 2000); }
    },
    resetRains: function() {
      save(SK_RAINERS, []);
      if (curTab === 'rainers') renderRainers();
      var st = document.getElementById('srn-test-status');
      if (st) { st.textContent = 'Stats rains remises a zero !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 2000); }
    },
    saveMultipConfig: function() {
      var c = getMultipConfig();
      var gEl = document.getElementById('srn-multip-global');
      var enEl = document.getElementById('srn-multip-enabled');
      if (gEl) c.globalThreshold = Math.max(2, parseFloat(gEl.value) || 100);
      if (enEl) c.enabled = enEl.checked;
      save(SK_MULTIP_CONFIG, c);
      renderMultip();
    },
    toggleTab: function(el) {
      var id = el.getAttribute('data-tabid');
      if (id === 'dashboard') return; // Stats toujours visible
      var cfg = getTabsConfig();
      cfg[id] = !cfg[id];
      cfg['dashboard'] = true;
      save(SK_TABS_CONFIG, cfg);
      renderTabsToggles();
      applyTabsConfig();
    },
    fbPullNow: function() {
      var st = document.getElementById('srn-fb-status');
      if (st) { st.textContent = 'Recuperation en cours...'; st.style.color = '#8899aa'; }
      fbPull(function() {
        refreshPanel();
        if (st) { st.textContent = 'Stats recuperees !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 3000); }
      });
    },
    fbPushNow: function() {
      var st = document.getElementById('srn-fb-status');
      if (st) { st.textContent = 'Envoi en cours...'; st.style.color = '#8899aa'; }
      lastFbSync = 0;
      fbPush();
      if (st) { st.textContent = 'Stats envoyees !'; st.style.color = '#00ff88'; setTimeout(function(){ st.textContent=''; }, 3000); }
    },
    addMultipGame: function() {
      var nameEl = document.getElementById('srn-multip-game-name');
      var thrEl  = document.getElementById('srn-multip-game-thresh');
      var typeEl = document.getElementById('srn-multip-game-type');
      var name = (nameEl ? nameEl.value.trim() : '');
      var threshold = thrEl ? (parseFloat(thrEl.value) || 50) : 50;
      var gameType = typeEl ? typeEl.value : 'original';
      if (!name) return;
      var c = getMultipConfig();
      if (!c.games) c.games = [];
      if (!c.games.some(function(g) { return g.name.toLowerCase() === name.toLowerCase(); })) {
        c.games.push({ name: name, threshold: threshold, type: gameType });
        save(SK_MULTIP_CONFIG, c);
      }
      if (nameEl) nameEl.value = '';
      renderMultip();
    },
    removeMultipGame: function(idx) {
      var c = getMultipConfig();
      if (!c.games) return;
      c.games.splice(idx, 1);
      save(SK_MULTIP_CONFIG, c);
      renderMultip();
    },
    testMultip: function() {
      // Simule directement un multiplicateur de 50x
      var gameName = 'Gates of Olympus (test)';
      var multiplier = 50;
      var cfg = load(SK_MULTIP_CONFIG, { enabled: true, globalThreshold: 2, games: [] });
      // On ignore le check enabled pour le test
      var threshold = cfg.globalThreshold || 2;
      var gameRule = (cfg.games || []).find(function(g) { return gameName.toLowerCase().indexOf(g.name.toLowerCase()) >= 0; });
      if (gameRule) threshold = gameRule.threshold;
      // Enregistre dans l'historique
      var log = load(SK_MULTIP, []);
      log.unshift({ ts: Date.now(), game: gameName, multiplier: multiplier });
      if (log.length > 20) log = log.slice(0, 20);
      save(SK_MULTIP, log);
      // Animation
      showMultipAnimation(gameName, multiplier);
      // Telegram
      sendTelegram('x' + multiplier.toFixed(2) + ' sur ' + gameName + ' ! (seuil : x' + threshold + ') [TEST]');
      // Refresh onglet
      if (curTab === 'multip') renderMultip();
    },
    resetMultip: function() {
      save(SK_MULTIP, []);
      renderMultip();
    },
    deleteMention: function(id) {
      var mentions = load(SK.MENTIONS, []);
      var toDelete = mentions.filter(function(m) { return m.id === id; })[0];
      if (toDelete) {
        var dm = load(SK_DELETED, {}); dm[toDelete.msgKey || toDelete.text.substring(0, 80)] = Date.now();
        save(SK_DELETED, dm);
      }
      save(SK.MENTIONS, mentions.filter(function(m) { return m.id !== id; }));
      renderMessages(); refreshPanel();
    },
    readMention: function(id) {
      var mentions = load(SK.MENTIONS, []).map(function(m) { if (m.id === id) m.read = true; return m; });
      save(SK.MENTIONS, mentions); renderMessages(); refreshPanel();
    },
    goToMessages: function() {
      var popup = document.getElementById('srn-notif-popup');
      if (popup) popup.classList.remove('open');
      curTab = 'messages';
      panelEl.querySelectorAll('.srn-menu-item').forEach(function(b) { b.classList.remove('active'); });
      var t = panelEl.querySelector('.srn-menu-item[data-tab="messages"]'); if (t) t.classList.add('active');
      var label = document.getElementById('srn-menu-label'); if (label) label.textContent = '\uD83D\uDCCB Messages';
      panelEl.querySelectorAll('.srn-sec').forEach(function(s) { s.classList.remove('active'); });
      var s = document.getElementById('tab-messages'); if (s) s.classList.add('active');
      if (collapsed) { collapsed = false; document.getElementById('srn-body').classList.remove('col'); document.getElementById('srn-tog').textContent = '-'; }
      renderMessages();
    },
    readAllMentions: function() {
      save(SK.MENTIONS, load(SK.MENTIONS, []).map(function(m) { m.read = true; return m; }));
      renderMessages(); refreshPanel();
    },
    deleteReadMentions: function() {
      var mentions = load(SK.MENTIONS, []);
      var dm = load(SK_DELETED, {}); var now = Date.now();
      mentions.filter(function(m) { return m.read; }).forEach(function(m) { dm[m.msgKey || m.text.substring(0, 80)] = now; });
      save(SK_DELETED, dm);
      save(SK.MENTIONS, mentions.filter(function(m) { return !m.read; }));
      renderMessages(); refreshPanel();
    },
    deleteAllMentions: function() {
      var mentions = load(SK.MENTIONS, []);
      var dm = load(SK_DELETED, {}); var now = Date.now();
      mentions.forEach(function(m) { dm[m.msgKey || m.text.substring(0, 80)] = now; });
      save(SK_DELETED, dm); save(SK.MENTIONS, []);
      renderMessages(); refreshPanel();
    },
  };
  function saveKeywords() {
    var c = load(SK.USER_CONFIG, {});
    save(SK.USER_CONFIG, Object.assign({}, c, { keywords: CONFIG.WATCH_KEYWORDS }));
  }
  function makeDraggable(el, handle) {
    var ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', function(e) { dragging = true; ox = e.clientX - el.getBoundingClientRect().left; oy = e.clientY - el.getBoundingClientRect().top; });
    document.addEventListener('mousemove', function(e) { if (!dragging) return; el.style.left = (e.clientX - ox) + 'px'; el.style.top = (e.clientY - oy) + 'px'; el.style.bottom = 'auto'; el.style.right = 'auto'; });
    document.addEventListener('mouseup', function() { dragging = false; });
  }
  function makeResizable(panel, handleBottom) {
    var body = document.getElementById('srn-body');
    var handleLeft = document.getElementById('srn-resize-left');
    var startX, startY, startW, startH, startRight, mode;
    function onDown(m, e) { mode = m; startX = e.clientX; startY = e.clientY; startW = panel.offsetWidth; startH = body ? body.offsetHeight : 300; startRight = window.innerWidth - panel.getBoundingClientRect().right; e.preventDefault(); }
    handleBottom.addEventListener('mousedown', function(e) { onDown('bottom', e); });
    if (handleLeft) handleLeft.addEventListener('mousedown', function(e) { onDown('left', e); });
    document.addEventListener('mousemove', function(e) {
      if (!mode) return;
      if (mode === 'bottom' || mode === 'corner') { if (body) body.style.height = Math.max(150, Math.min(700, startH + (e.clientY - startY))) + 'px'; }
      if (mode === 'left'   || mode === 'corner') { panel.style.width = Math.max(280, Math.min(700, startW + (startX - e.clientX))) + 'px'; panel.style.right = startRight + 'px'; panel.style.left = 'auto'; }
    });
    document.addEventListener('mouseup', function() { mode = null; });
  }
  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function loadSavedConfig() {
    var c = load(SK.USER_CONFIG, {});
    if (c.token)      CONFIG.TELEGRAM_BOT_TOKEN = c.token;
    if (c.chatid)     CONFIG.TELEGRAM_CHAT_ID   = c.chatid;
    if (c.username)   CONFIG.YOUR_USERNAME      = c.username;
    if (c.inactivity) CONFIG.INACTIVITY_MINUTES = c.inactivity;
    if (c.keywords && Array.isArray(c.keywords)) CONFIG.WATCH_KEYWORDS = c.keywords;
  }
  function init() {
    loadSavedConfig();
    loadCustomWords();
    interceptWebSocket();
    var start = function() {
      buildPanel();
      // Afficher le setup si premiere installation
      if (!load(SK_SETUP_DONE, false)) {
        setTimeout(function() { buildSetup(); }, 500);
      }
      // Verification des mises a jour apres chargement du panneau
      setTimeout(checkForUpdate, 8000);
      setInterval(checkForUpdate, 60 * 60 * 1000);
      detectFiatCurrency();
      // Re-detecte la devise toutes les 30s (si l'utilisateur la change dans Stake)
      setInterval(detectFiatCurrency, 30000);
      // Re-detecte aussi sur changement de page (SPA navigation)
      var _lastUrl = location.href;
      setInterval(function() {
        if (location.href !== _lastUrl) { _lastUrl = location.href; setTimeout(detectFiatCurrency, 1000); }
      }, 1000);
      observeChat();
      trackOwnMessages();
      setInterval(checkInactivity, 60000);
      // observeBets() remplace par WebSocket
      setInterval(refreshPanel, 30000);
      if (Notification.permission === 'default') Notification.requestPermission();
      console.log('[StakePulse] Actif sur Stake.bet | Pseudo:', CONFIG.YOUR_USERNAME, '| Mots-cles:', CONFIG.WATCH_KEYWORDS);
      fetchCryptoPrices(updateTicker);
        fbPull(function() { refreshPanel(); console.log('[StakePulse] Donnees Firebase chargees'); });
        setInterval(function() { fbPull(refreshPanel); }, 30000);
      setInterval(fbPush, 15000); // Charge les prix au demarrage
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  }
  init();
})();