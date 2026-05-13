// ==UserScript==
// @name         StakePulse
// @namespace    https://stake.bet/stakepulse
// @version      5.4.3
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
// @grant        GM_xmlhttpRequest   // Permet les requêtes HTTP cross-origin (Telegram, Firebase, CoinGecko…)
// @grant        GM_getValue         // Lit une valeur persistante dans le stockage du script
// @grant        GM_setValue         // Écrit une valeur persistante dans le stockage du script
// @grant        GM_addStyle         // Injecte du CSS dans la page
// @connect      api.telegram.org                                           // Notifications Telegram
// @connect      api.exchangerate-api.com                                   // Taux de change fiat
// @connect      api.coingecko.com                                          // Prix des cryptos
// @connect      alerte-rain-default-rtdb.europe-west1.firebasedatabase.app // Base de données partagée Firebase
// @connect      raw.githubusercontent.com                                  // Vérification des mises à jour
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ============================================================
  // BLOC 1 — CONFIGURATION GLOBALE & CONSTANTES
  // ============================================================

  /**
   * Règles de comptage de mots-clés dans le chat Stake.
   * Chaque règle possède :
   *   - id      : identifiant unique utilisé pour le stockage
   *   - label   : libellé affiché dans l'UI
   *   - pattern : RegExp testée sur chaque message du chat
   *   - senderFilter : si renseigné, ne compte que les messages de cet expéditeur
   */
  var WORD_RULES = [
    { id: "monthly",   label: "Monthly",    pattern: /monthly/i,          senderFilter: null },
    { id: "glissade",  label: "Glissade",   pattern: /glissade/i,         senderFilter: null },
    { id: "aie",       label: "Aie",        pattern: /a[ii][ee]/i,        senderFilter: null },
    { id: "reloadout", label: "Reload Out", pattern: /reload.{0,3}out/i,  senderFilter: null },
    { id: "rip",       label: "Rip",        pattern: /rip/i,              senderFilter: null },
  ];

  /**
   * Configuration utilisateur (valeurs par défaut).
   * Ces valeurs sont écrasées au démarrage par loadSavedConfig()
   * qui lit les préférences sauvegardées.
   */
  var CONFIG = {
    TELEGRAM_BOT_TOKEN:  "VOTRE_BOT_TOKEN_ICI",  // Token du bot Telegram personnel de l'utilisateur
    STAKE_PULSE_TOKEN:   "8631866608:AAHF9Q9FfwJjNJLRg66nZbnqxgloPHebUak", // Token du bot StakePulse officiel
    TELEGRAM_CHAT_ID:    "VOTRE_CHAT_ID_ICI",    // Chat ID Telegram de l'utilisateur
    INACTIVITY_MINUTES:  10,                      // Seuil d'inactivité avant alerte (en minutes)
    YOUR_USERNAME:       "",                      // Pseudo Stake de l'utilisateur
    WATCH_KEYWORDS:      [],                      // Liste des mots-clés/@mentions à surveiller
  };

  /**
   * Clés de stockage GM (préfixées "srn_" pour éviter les collisions).
   * Utilisées par load() et save() pour persister les données entre sessions.
   */
  var SK = {
    RAIN_LOG:      "srn_rain_log",      // Historique des rains reçues
    RANKINGS:      "srn_rankings",      // Classement des bénéficiaires de rain
    LAST_MSG_TIME: "srn_last_msg_time", // Timestamp du dernier message envoyé par l'utilisateur
    USER_CONFIG:   "srn_user_config",   // Config utilisateur sauvegardée
    MENTIONS:      "srn_mentions",      // Liste des mentions/notifications non lues
  };

  // Clés supplémentaires pour des fonctionnalités spécifiques
  var SK_DEDUP        = "srn_dedup";           // Cache de déduplication des messages (évite les doublons)
  var SK_WORDCOUNT    = "srn_wordcount";        // Historique des occurrences de WORD_RULES
  var SK_DELETED      = "srn_deleted_mentions"; // Mentions supprimées (blacklist)
  var SK_CUSTOMWORDS  = "srn_custom_words";     // Mots-clés personnalisés ajoutés par l'utilisateur
  var SK_MYSTATS_OFFSET = "srn_mystats_offset"; // Correctifs manuels pour les stats personnelles
  var SK_WAGER        = "srn_wager";            // Historique des mises détectées
  var SK_EMOJI_COUNT  = "srn_emoji_count";      // Comptage des emojis Stake dans le chat
  var SK_MULTIP       = "srn_multip";           // Historique des multiplicateurs détectés
  var SK_MULTIP_CONFIG = "srn_multip_config";   // Config des seuils de multiplicateurs
  var SK_TABS_CONFIG  = "srn_tabs_config";      // Onglets activés/désactivés par l'utilisateur
  var SK_SETUP_DONE   = "srn_setup_done";       // Indique si l'assistant de configuration a été complété
  var SK_RAINERS      = "srn_rainers";          // Classement des utilisateurs qui font des rains

  // Durée de vie des entrées de déduplication (4h) et des mentions supprimées (7j)
  var DEDUP_TTL   = 4 * 60 * 60 * 1000;
  var DELETED_TTL = 7 * 24 * 60 * 60 * 1000;

  // Objectif de rain hebdomadaire en euros (déclenche une notification quand atteint)
  var WEEKLY_GOAL = 300;


  // ============================================================
  // BLOC 2 — PERSISTANCE LOCALE (GM_getValue / GM_setValue)
  // ============================================================

  /**
   * Charge une valeur depuis le stockage GM.
   * Désérialise le JSON ; retourne `fallback` en cas d'erreur ou de clé absente.
   */
  function load(key, fallback) {
    if (fallback === undefined) fallback = null;
    try {
      return JSON.parse(GM_getValue(key, JSON.stringify(fallback)));
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Sauvegarde une valeur dans le stockage GM (sérialisée en JSON).
   */
  function save(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }


  // ============================================================
  // BLOC 3 — SYNCHRONISATION FIREBASE (base de données partagée)
  // ============================================================

  /**
   * URL racine de la base Firebase Realtime Database.
   * Permet de partager les données entre plusieurs utilisateurs du script.
   */
  var FIREBASE_URL  = "https://alerte-rain-default-rtdb.europe-west1.firebasedatabase.app";

  /**
   * Clés synchronisées entre le stockage local et Firebase.
   * Seules ces données sont poussées/tirées pour limiter la bande passante.
   */
  var FIREBASE_KEYS = [
    "srn_rain_log",
    "srn_rankings",
    "srn_wordcount",
    "srn_emoji_count",
    "srn_multip",
    "srn_wager",
  ];

  var fbSyncTimer = null; // Timer de synchronisation (non utilisé actuellement, réservé)
  var lastFbSync  = 0;    // Timestamp de la dernière synchronisation push

  /**
   * Lit un chemin dans Firebase et retourne les données via callback.
   * En cas d'erreur réseau ou de JSON invalide, callback reçoit null.
   */
  function fbGet(path, callback) {
    GM_xmlhttpRequest({
      method: "GET",
      url: FIREBASE_URL + "/" + path + ".json",
      onload: function (res) {
        try   { callback(JSON.parse(res.responseText)); }
        catch (e) { callback(null); }
      },
      onerror: function () { callback(null); },
    });
  }

  /**
   * Écrase un chemin dans Firebase avec les données fournies (PUT = remplacement total).
   */
  function fbSet(path, data) {
    GM_xmlhttpRequest({
      method: "PUT",
      url: FIREBASE_URL + "/" + path + ".json",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(data),
      onload: function () {},
      onerror: function () {},
    });
  }

  /**
   * Pousse les données locales vers Firebase.
   * Limitée à une synchronisation toutes les 10 secondes (anti-spam).
   */
  function fbPush() {
    var now = Date.now();
    if (now - lastFbSync < 10000) return; // Throttle : max 1 sync toutes les 10s
    lastFbSync = now;
    FIREBASE_KEYS.forEach(function (key) {
      var val = load(key, null);
      if (val !== null) fbSet("shared/" + key, val);
    });
    console.log("[StakePulse] Sync Firebase OK");
  }

  /**
   * Tire les données depuis Firebase et les fusionne intelligemment avec le stockage local.
   *   - Tableaux  → fusion par timestamp (déduplique sur `ts`, limite à 2000 entrées)
   *   - Objets    → merge avec Object.assign (le local a priorité)
   *   - Scalaires → remplacement direct par la valeur distante
   */
  function fbPull(callback) {
    fbGet("shared", function (data) {
      if (!data) { if (callback) callback(); return; }

      FIREBASE_KEYS.forEach(function (key) {
        if (data[key] === undefined || data[key] === null) return;
        var local = load(key, null);

        if (Array.isArray(data[key]) && Array.isArray(local)) {
          // Fusion de tableaux : on ajoute les entrées distantes absentes localement
          var merged  = local.slice();
          var localTs = local.map(function (e) { return e.ts; });
          data[key].forEach(function (e) {
            if (e.ts && localTs.indexOf(e.ts) < 0) merged.push(e);
          });
          merged.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
          if (merged.length > 2000) merged = merged.slice(-2000);
          save(key, merged);

        } else if (
          typeof data[key] === "object" && !Array.isArray(data[key]) &&
          typeof local    === "object" && !Array.isArray(local)
        ) {
          // Fusion d'objets : le stockage local a priorité sur Firebase
          save(key, Object.assign({}, data[key], local || {}));

        } else {
          // Valeur scalaire : remplacement direct
          save(key, data[key]);
        }
      });

      console.log("[StakePulse] Pull Firebase OK");
      if (callback) callback();
    });
  }


  // ============================================================
  // BLOC 4 — NOTIFICATIONS TELEGRAM
  // ============================================================

  /**
   * Cache local des chatId Firebase par pseudo (durée de vie : 5 minutes).
   * Évite de requêter Firebase à chaque notification individuelle.
   */
  var fbUserCache     = {};
  var fbUserCacheTime = {};

  /**
   * Récupère le chatId Telegram d'un utilisateur depuis Firebase.
   * Résultat mis en cache 5 minutes.
   */
  function getFbChatId(pseudo, callback) {
    if (!pseudo) { callback(null); return; }
    var p = pseudo.toLowerCase();

    // Retourne depuis le cache si disponible et récent
    if (fbUserCache[p] && Date.now() - fbUserCacheTime[p] < 5 * 60 * 1000) {
      callback(fbUserCache[p]);
      return;
    }

    GM_xmlhttpRequest({
      method: "GET",
      url: FIREBASE_URL + "/users/" + p + ".json",
      onload: function (res) {
        try {
          var data = JSON.parse(res.responseText);
          if (data && data.chatId) {
            fbUserCache[p]     = data.chatId;
            fbUserCacheTime[p] = Date.now();
            callback(data.chatId);
          } else {
            callback(null);
          }
        } catch (e) { callback(null); }
      },
      onerror: function () { callback(null); },
    });
  }

  /**
   * Envoie un message Telegram à un utilisateur Stake spécifique,
   * en récupérant son chatId depuis Firebase.
   * Utilise le token officiel StakePulse (pas le bot personnel de l'utilisateur).
   */
  function sendTelegramToUser(pseudo, text) {
    getFbChatId(pseudo, function (chatId) {
      if (!chatId) return;
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.telegram.org/bot" + CONFIG.STAKE_PULSE_TOKEN + "/sendMessage",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" }),
        onload: function () {},
        onerror: function () {},
      });
    });
  }

  /**
   * Envoie un message Telegram via le bot personnel de l'utilisateur.
   * Vérifie que le token et le chatId sont configurés avant d'envoyer.
   * Appelle onSuccess() ou onError(message) selon le résultat.
   */
  function sendTelegram(text, onSuccess, onError) {
    var token  = CONFIG.TELEGRAM_BOT_TOKEN;
    var chatId = CONFIG.TELEGRAM_CHAT_ID;

    // Validation : refuse l'envoi si le token/chatId est le placeholder par défaut
    if (!token  || token.indexOf("VOTRE") >= 0)  { if (onError) onError("Token manquant");   return; }
    if (!chatId || chatId.indexOf("VOTRE") >= 0) { if (onError) onError("Chat ID manquant"); return; }

    GM_xmlhttpRequest({
      method: "POST",
      url: "https://api.telegram.org/bot" + token + "/sendMessage",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" }),
      onload: function (res) {
        try {
          var json = JSON.parse(res.responseText);
          if (json.ok) {
            if (onSuccess) onSuccess();
          } else {
            if (onError) onError("Telegram erreur: " + (json.description || "") + " (code " + json.error_code + ")");
          }
        } catch (e) { if (onError) onError("Reponse invalide"); }
      },
      onerror: function () { if (onError) onError("Erreur reseau"); },
    });
  }


  // ============================================================
  // BLOC 5 — DÉTECTION & TRAITEMENT DES RAINS
  // ============================================================

  /**
   * Patterns RegExp permettant d'identifier un message de rain dans le chat.
   * Un message de rain est celui distribué automatiquement par le système Stake
   * ou par un utilisateur qui fait un "tip" groupé.
   */
  var RAIN_TRIGGERS = [
    /a donn[ee] [aa] \d+ utilisateurs/i,
    /a donn[ee] [aa] \d+ users/i,
    /rained .* on \d+ users/i,
    /tipping everyone/i,
    /shared.*with the chat/i,
    /chacun:/i,
  ];

  // RegExp pour extraire le montant et la crypto d'un message de rain
  var AMOUNT_RE = /([\d,.]+)\s*(BTC|ETH|USDT|USD|LTC|XRP|DOGE|BNB|TRX|EOS|MATIC|SOL)/i;

  /** Teste si un texte ressemble à un message de rain. */
  function looksLikeRain(text) {
    return RAIN_TRIGGERS.some(function (p) { return p.test(text); });
  }

  /**
   * Analyse un message de rain pour en extraire :
   *   - amount     : montant distribué (par personne)
   *   - currency   : devise (€ ou crypto)
   *   - recipients : liste des pseudo bénéficiaires
   *   - senderFromText : expéditeur extrait du texte si possible
   */
  function parseRainMessage(text) {
    var euroMatch  = text.match(/€\s*([\d]+[.,][\d]+|[\d]+)/);
    var am         = text.match(AMOUNT_RE);
    var amount = null, currency = "€";

    if (euroMatch) {
      amount   = parseFloat(euroMatch[1].replace(",", "."));
      currency = "€";
    } else if (am) {
      amount   = parseFloat(am[1].replace(/,/g, ""));
      currency = am[2].toUpperCase();
    }

    // Tente d'extraire l'expéditeur depuis le texte (ex : "JohnDoe a donné à…")
    var senderFromText = null;
    var senderMatch    = text.match(/([A-Za-z0-9_]{2,25})\s+a\s+donn/i);
    if (senderMatch)                                senderFromText = senderMatch[1].trim();
    if (!senderFromText && text.toLowerCase().indexOf("rain bot") >= 0) senderFromText = "Rain Bot";

    // Extrait la liste des bénéficiaires après "chacun:" ou "each:"
    var recipients = [];
    var afterColon = text.match(/(?:chacun|each)[^:]*:\s*(.+)$/i);
    if (afterColon) {
      var cleaned = afterColon[1].replace(/\bME\s+([A-Za-z0-9_]+)/g, "$1");
      recipients  = cleaned
        .split(",")
        .reduce(function (acc, s) {
          s.trim().split(/\s+/).forEach(function (w) { acc.push(w.trim()); });
          return acc;
        }, [])
        .filter(function (s) {
          return s.length >= 2 && /^[A-Za-z0-9_]+$/.test(s) && s.toUpperCase() !== "ME";
        });
    }

    return { amount, currency, recipients, raw: text, senderFromText };
  }

  /**
   * Enregistre une rain détectée dans le log local et met à jour les classements.
   * Affiche également l'animation visuelle et notifie via Telegram si l'utilisateur
   * fait partie des bénéficiaires.
   * (Fonction recordRain définie plus loin dans le code d'origine — appelle
   *  updateRankings, showRainAnimation, sendTelegramToUser…)
   */


  // ============================================================
  // BLOC 6 — COMPTAGE DE MOTS & DÉDUPLICATION
  // ============================================================

  /**
   * Charge les mots personnalisés depuis le stockage local et les fusionne
   * dans WORD_RULES pour qu'ils soient comptés comme les règles natives.
   */
  function loadCustomWords() {
    var custom = load(SK_CUSTOMWORDS, []);
    custom.forEach(function (w) {
      if (!WORD_RULES.some(function (r) { return r.id === w.id; })) {
        try {
          WORD_RULES.push({
            id: w.id, label: w.label,
            pattern: new RegExp(w.pattern, "i"),
            senderFilter: null, custom: true,
          });
        } catch (e) {}
      }
    });
  }

  /**
   * Met en cache en mémoire les messages déjà comptés pour éviter les doublons intra-session.
   * Complète la déduplication persistante (SK_DEDUP).
   */
  var seenWordKeys = new Set();

  /**
   * Charge le cache de déduplication persistant depuis GM et purge les entrées expirées.
   * TTL = DEDUP_TTL (4 heures).
   */
  function loadPersistDedup() {
    try {
      var raw     = load(SK_DEDUP, {});
      var now     = Date.now();
      var cleaned = {};
      Object.keys(raw).forEach(function (k) {
        if (now - raw[k] < DEDUP_TTL) cleaned[k] = raw[k];
      });
      return cleaned;
    } catch (e) { return {}; }
  }

  /**
   * Vérifie si une clé de message a déjà été traitée (mémoire + stockage persistant).
   * Enregistre la clé si elle est nouvelle pour les traitements futurs.
   */
  function isDuplicate(key) {
    var normalized = key.trim().toLowerCase().substring(0, 120);
    if (seenMessages.has(normalized)) return true;

    var persist = loadPersistDedup();
    if (persist[normalized]) { seenMessages.add(normalized); return true; }

    // Nouvelle clé : on l'enregistre
    seenMessages.add(normalized);
    persist[normalized] = Date.now();
    var entries = Object.entries(persist)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 200);
    save(SK_DEDUP, Object.fromEntries(entries));

    // Limite la taille du Set en mémoire
    if (seenMessages.size > 800) seenMessages = new Set([...seenMessages].slice(-500));
    return false;
  }

  /**
   * Incrémente le compteur d'un WORD_RULE si le texte correspond,
   * en évitant de compter deux fois le même message (double dédup mémoire + persistant).
   */
  function trackWordCount(text, sender) {
    var wordKey  = "w|" + text.substring(0, 80).trim().toLowerCase();
    if (seenWordKeys.has(wordKey)) return;

    var persistW = loadPersistDedup();
    if (persistW[wordKey]) { seenWordKeys.add(wordKey); return; }

    seenWordKeys.add(wordKey);
    persistW[wordKey] = Date.now();

    // Garde seulement les 300 entrées les plus récentes
    var wEntries = Object.entries(persistW)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 300);
    save(SK_DEDUP, Object.fromEntries(wEntries));

    var now    = Date.now();
    var counts = load(SK_WORDCOUNT, []);
    var matched = false;

    WORD_RULES.forEach(function (rule) {
      if (!rule.pattern.test(text)) return;
      // Si la règle filtre sur un expéditeur, vérifie que c'est le bon
      if (rule.senderFilter && (!sender || sender.toLowerCase() !== rule.senderFilter.toLowerCase())) return;
      counts.push({ id: rule.id, ts: now });
      matched = true;
    });

    if (matched) {
      // Purge les entrées de plus d'un an et limite à 5000 entrées
      var yearAgo = now - 365 * 24 * 3600 * 1000;
      counts = counts.filter(function (c) { return c.ts > yearAgo; });
      if (counts.length > 5000) counts = counts.slice(-5000);
      save(SK_WORDCOUNT, counts);
    }
  }

  /**
   * Ajoute manuellement +1 à un compteur de mot (bouton "+1" dans l'UI).
   */
  function addManualCount(id) {
    var counts = load(SK_WORDCOUNT, []);
    counts.push({ id: id, ts: Date.now() });
    save(SK_WORDCOUNT, counts);
    renderModeration();
  }


  // ============================================================
  // BLOC 7 — SURVEILLANCE DES MENTIONS
  // ============================================================

  /**
   * Retourne les mots-clés de CONFIG.WATCH_KEYWORDS présents dans le texte
   * sous la forme "@mot" (insensible à la casse).
   */
  function findMatchingKeywords(text) {
    if (!CONFIG.WATCH_KEYWORDS || !CONFIG.WATCH_KEYWORDS.length) return [];
    var lower = text.toLowerCase();
    return CONFIG.WATCH_KEYWORDS.filter(function (kw) {
      if (!kw) return false;
      var k = kw.toLowerCase().replace(/^@/, "");
      return lower.indexOf("@" + k) >= 0;
    });
  }

  var lastMentionKey = ""; // Clé du dernier message de mention traité (évite les doublons immédiats)

  /**
   * Vérifie si un message mentionne l'utilisateur (@pseudo ou mot-clé configuré).
   * Si oui :
   *   1. Sauvegarde la mention dans SK.MENTIONS
   *   2. Rafraîchit le panneau (badge non lu)
   *   3. Envoie une notification Telegram
   *   4. Affiche une notification navigateur
   *
   * Protections :
   *   - Ignore les messages de rain (faux positifs fréquents)
   *   - Ignore les messages trop longs (spam bots)
   *   - Ignore les messages de l'utilisateur lui-même
   *   - Ignore les messages déjà supprimés
   */
  function checkAndNotifyMention(text, sender) {
    var matches = findMatchingKeywords(text);
    if (!matches.length)       return;
    if (looksLikeRain(text))   return; // Les rains contiennent souvent les pseudos

    // Filtre anti-spam : ignore les mots très longs (probable encodage bot)
    var words = text.trim().split(/\s+/);
    if (words.some(function (w) { return w.length > 40; })) return;

    var myUsername = (CONFIG.YOUR_USERNAME || "").toLowerCase().trim();
    // Ignore si c'est l'utilisateur lui-même qui parle
    if (myUsername && sender && sender.toLowerCase() === myUsername) return;
    if (sender && sender.toUpperCase() === "ME") return;
    if (!sender && text.trim().toUpperCase().indexOf("ME ") === 0) return;
    if (myUsername && !sender) {
      var firstWord = text.trim().split(" ")[0].toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (firstWord === myUsername) return;
    }

    // Déduplication immédiate
    var key = (sender || "") + text.substring(0, 80);
    if (lastMentionKey === key) return;
    lastMentionKey = key;

    // Vérifie que la mention n'a pas déjà été supprimée par l'utilisateur
    var deletedMap = load(SK_DELETED, {});
    var msgKey     = text.substring(0, 80);
    if (deletedMap[msgKey]) return;

    // Enregistre la mention si elle n'existe pas déjà
    var mentions      = load(SK.MENTIONS, []);
    var alreadyExists = mentions.some(function (m) { return m.text.substring(0, 80) === msgKey; });
    if (!alreadyExists) {
      mentions.unshift({
        id: Date.now(), ts: Date.now(),
        sender: sender || "Inconnu",
        text: text.substring(0, 300),
        msgKey: msgKey, read: false,
      });
      if (mentions.length > 100) mentions = mentions.slice(0, 100);
      save(SK.MENTIONS, mentions);
    }
    refreshPanel();

    // Construit et envoie la notification Telegram
    // Déduplication pour éviter double notification
    var telegramKey = 'tg|' + msgKey;
    var persistTg = loadPersistDedup();
    if (persistTg[telegramKey]) return;
    persistTg[telegramKey] = Date.now();
    save(SK_DEDUP, persistTg);

    var kws     = matches.map(function (k) { return "<b>@" + k.replace(/^@/, "") + "</b>"; }).join(", ");
    var preview = text.length > 120 ? text.substring(0, 120) + "..." : text;
    sendTelegram(
      "🔔 <b>Tu as ete mentionne sur Stake !</b>\n" +
      "👤 Par : <b>" + escHtml(sender || "Inconnu") + "</b>\n" +
      "🏷 Mot-cle : " + kws + "\n" +
      "💬 " + escHtml(preview)
    );
    showNotif("Mention de " + (sender || "?") + " : " + text.substring(0, 60));
  }


  // ============================================================
  // BLOC 8 — INTERCEPTION DU WEBSOCKET & FETCH (écoute du chat)
  // ============================================================

  var seenMessages = new Set(); // Messages déjà traités dans cette session (déduplication mémoire)
  var lastRainKey  = "";        // Clé de la dernière rain traitée
  var lastRainTime = 0;         // Timestamp de la dernière rain (anti-spam)

  /**
   * Point d'entrée commun pour le traitement d'un message.
   * Appelle dans l'ordre : trackWordCount → isDuplicate → checkAndNotifyMention → rain detection.
   */
  function processMessage(text, sender) {
    if (!text || text.length < 2) return;

    // Tente d'extraire le pseudo depuis un format "Pseudo: message"
    if (!sender && text) {
      var m = text.match(/^([A-Za-z0-9_]{2,25}):/);
      if (m) sender = m[1];
    }

    trackWordCount(text, sender);

    var key = text.substring(0, 100);
    if (isDuplicate(key)) return; // Message déjà traité, on arrête ici

    checkAndNotifyMention(text, sender);

    if (looksLikeRain(text)) {
      var parsed = parseRainMessage(text);
      recordRain(sender, parsed);
    }
  }

  /**
   * Monkey-patche window.WebSocket pour intercepter tous les messages WebSocket
   * entrants et les passer à scanPayload (analyse des données JSON).
   */
  function interceptWebSocket() {
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      ws.addEventListener("message", function (event) {
        try { scanPayload(JSON.parse(event.data)); } catch (e) {}
      });
      return ws;
    };
    Object.assign(window.WebSocket, OrigWS);
    window.WebSocket.prototype = OrigWS.prototype;
  }

  /**
   * Parcourt récursivement un payload JSON à la recherche de champs de message
   * (message, text, content, body) et d'expéditeur (username, name, user.name…).
   * Pour chaque objet trouvé, appelle processMessage.
   * Lance aussi walkForMultiplier pour la détection des multiplicateurs.
   */
  function scanPayload(data) {
    walkObject(data, function (obj) {
      var text   = obj.message || obj.text || obj.content || obj.body || "";
      var sender =
        obj.username || obj.name ||
        (obj.user   && (obj.user.name   || obj.user.username))   ||
        (obj.author && (obj.author.name || obj.author.username)) ||
        obj.sender || null;
      if (typeof text === "string" && text.length >= 2) processMessage(text, sender);
    });
    walkForMultiplier(data);
  }

  /**
   * Monkey-patche window.fetch pour intercepter les réponses des endpoints GraphQL et chat.
   * Permet de capter les messages qui passent par HTTP plutôt que WebSocket.
   */
  var _fetch = window.fetch;
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    return _fetch.apply(this, args).then(function (res) {
      try {
        var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url ? args[0].url : "");
        if (url.indexOf("graphql") >= 0 || url.indexOf("chat") >= 0)
          res.clone().json().then(scanPayload).catch(function () {});
      } catch (e) {}
      return res;
    });
  };

  /**
   * Tente de retrouver l'expéditeur d'un message en remontant l'arbre DOM.
   * Cherche le premier conteneur (classe contenant "ctainer") et lit le premier
   * span/a/button dont le texte ressemble à un pseudo Stake.
   */
  function findSenderFromNode(node) {
    var el = node;
    for (var i = 0; i < 10 && el; i++) {
      var cls = typeof el.className === "string"
        ? el.className
        : (el.className && el.className.baseVal ? el.className.baseVal : "");
      if (cls && cls.indexOf("ctainer") >= 0) {
        var spans = el.querySelectorAll("span, a, button");
        for (var j = 0; j < spans.length; j++) {
          var t = (spans[j].textContent || "").trim();
          if (t.length >= 2 && t.length <= 25 && /^[A-Za-z0-9_]+$/.test(t)) return t;
        }
        break;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Observe les mutations DOM du chat via MutationObserver.
   * Pour chaque nœud ajouté, extrait le texte et tente de détecter l'expéditeur.
   */
  function observeChat() {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          if (node.id === "srn-panel") return;
          if (node.closest && node.closest("#srn-panel")) return;
          if (node.tagName && node.tagName.toLowerCase() === "svg") return;

          var text    = node.textContent || "";
          var checkEl = node;
          var inPanel = false;
          // Vérifie que le nœud n'est pas dans notre propre panneau
          for (var i = 0; i < 8 && checkEl; i++) {
            if (checkEl.id === "srn-panel") { inPanel = true; break; }
            checkEl = checkEl.parentElement;
          }
          if (inPanel) return;

          var sender = findSenderFromNode(node);
          processMessage(text, sender);
          trackEmojis(node); // Comptage des emojis Stake dans ce nœud
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }


  // ============================================================
  // BLOC 9 — DÉTECTION DES BETS & MULTIPLICATEURS
  // ============================================================

  /**
   * Champs du payload WebSocket/REST pouvant contenir un multiplicateur de jeu.
   * Utilisés par scanForMultiplier pour trouver la valeur pertinente.
   */
  var MULTIP_FIELDS = [
    "multiplier", "payoutMultiplier", "currentMultiplier", "winMultiplier",
    "crashPoint", "result_multiplier", "cashoutMultiplier", "bustedAt",
    "payout", "outcomeMultiplier", "resultMultiplier", "betMultiplier",
    "value", "profit", "nonce",
  ];

  /** Champs pouvant contenir le nom du jeu dans un objet de payload. */
  var GAME_FIELDS = ["game", "gameName", "slug", "gameSlug", "name", "identifier", "type"];

  // Mode debug désactivé par défaut (activable via _srn.enableMultipDebug() dans la console)
  var MULTIP_DEBUG = false;

  /**
   * Extrait le nom du jeu depuis un objet de payload.
   * Teste les champs GAME_FIELDS et leurs sous-propriétés (name, slug…).
   */
  function extractGame(obj) {
    for (var i = 0; i < GAME_FIELDS.length; i++) {
      var v = obj[GAME_FIELDS[i]];
      if (typeof v === "string" && v.length > 1 && v.length < 60) return v;
      if (v && typeof v === "object") {
        var inner = v.name || v.slug || v.identifier || v.title;
        if (typeof inner === "string" && inner.length > 1) return inner;
      }
    }
    return null;
  }

  /**
   * Tente d'extraire un multiplicateur valide depuis un objet (champs MULTIP_FIELDS).
   * Un multiplicateur valide est ≥ 1, < 1 000 000 et ne ressemble pas à un timestamp/ID.
   * Si trouvé, appelle checkMultiplier(game, mult).
   */
  function scanForMultiplier(obj) {
    var mult = null, foundField = null;
    for (var i = 0; i < MULTIP_FIELDS.length; i++) {
      var f   = MULTIP_FIELDS[i];
      var raw = obj[f];
      if (raw === undefined || raw === null) continue;
      var m = parseFloat(raw);
      if (isFinite(m) && m >= 1 && m < 1000000 && String(raw).length <= 10) {
        mult = m; foundField = f; break;
      }
    }
    if (mult === null) return;
    var game = extractGame(obj);
    if (MULTIP_DEBUG) console.log("[StakePulse][MULTIP DEBUG] field=" + foundField + " mult=" + mult + " game=" + game, JSON.stringify(obj).substring(0, 200));
    checkMultiplier(game, mult);
  }

  /** Parcourt récursivement un objet JSON à la recherche de multiplicateurs. */
  function walkForMultiplier(data) {
    if (!data || typeof data !== "object") return;
    scanForMultiplier(data);
    var vals = Object.values(data);
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] && typeof vals[i] === "object") walkForMultiplier(vals[i]);
    }
  }

  /**
   * Lit la configuration des multiplicateurs depuis le stockage local.
   * Retourne globalThreshold (seuil global), enabled (actif/inactif) et games (seuils par jeu).
   */
  function getMultipConfig() {
    return load(SK_MULTIP_CONFIG, { globalThreshold: 100, enabled: true, games: [] });
  }

  /**
   * Retourne le seuil applicable à un jeu donné.
   * Si une règle spécifique existe pour ce jeu, elle prend priorité sur le seuil global.
   * Retourne null si les notifications multiplicateur sont désactivées.
   */
  function getMultipThresholdForGame(gameName) {
    var cfg    = getMultipConfig();
    if (!cfg.enabled) return null;
    var gn     = (gameName || "").toLowerCase().trim();
    var gameRule = (cfg.games || []).find(function (g) {
      return g.name && gn.indexOf(g.name.toLowerCase()) >= 0;
    });
    return gameRule ? gameRule.threshold : cfg.globalThreshold;
  }

  var lastMultipKey = ""; // Clé du dernier multiplicateur notifié (déduplication 5 secondes)

  /**
   * Vérifie si un multiplicateur dépasse le seuil configuré pour ce jeu.
   * Si oui :
   *   - Sauvegarde dans l'historique (SK_MULTIP)
   *   - Affiche l'animation visuelle
   *   - Envoie une notification navigateur
   *   - Rafraîchit l'onglet multiplicateur si actif
   */
  function checkMultiplier(gameName, multiplier) {
    var threshold = getMultipThresholdForGame(gameName);
    if (threshold === null) return;
    if (multiplier < Math.max(threshold, 1.01)) return;

    // Déduplication sur une fenêtre de 5 secondes
    var key = (gameName || "") + "|" + Math.round(multiplier * 100) + "|" + Math.floor(Date.now() / 5000);
    if (key === lastMultipKey) return;
    lastMultipKey = key;

    var log = load(SK_MULTIP, []);
    log.unshift({ ts: Date.now(), game: gameName || "Inconnu", multiplier, threshold });
    if (log.length > 500) log = log.slice(0, 500);
    save(SK_MULTIP, log);

    showMultipAnimation(gameName || "Inconnu", multiplier);
    var msg = "🎰 x" + multiplier.toFixed(2) + " sur " + (gameName || "Inconnu") + " ! (seuil : x" + threshold + ")";
    showNotif(msg);
    console.log("[StakePulse] Multiplicateur :", multiplier, "sur", gameName, "| Seuil :", threshold);
    if (curTab === "multip") renderMultip();
  }

  /**
   * Observe les lignes ajoutées au tableau de bets (DOM) pour détecter les mises
   * et les multiplicateurs sur la page de jeu en cours.
   * Ignore la page d'accueil et les montants aberrants (> 5000€).
   */
  var lastBetKey  = "";
  var seenBetKeys = new Set();

  function observeBets() {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          if (node.closest && node.closest("#srn-panel")) return;

          // N'observe que les pages de jeu (pas l'accueil)
          var path = window.location.pathname;
          if (path === "/fr" || path === "/fr/" || path === "/" || path === "") return;

          var text = (node.textContent || "").trim();
          if (text.length < 5 || text.length > 200) return;

          // Vérifie la présence d'un montant euro ET d'une heure (signature d'un résultat de bet)
          var euroMatches = text.match(/[€€]([\d]+[.,][\d]+)/g);
          if (!euroMatches || !euroMatches.length)     return;
          if (!/(\d{1,2}:\d{2}|PM|AM)/i.test(text))   return;

          // Déduplication
          var betKey = text.substring(0, 60);
          if (seenBetKeys.has(betKey)) return;
          var bk      = "bt|" + betKey;
          var persist = loadPersistDedup();
          if (persist[bk]) { seenBetKeys.add(betKey); return; }
          persist[bk] = Date.now();
          var entries = Object.entries(persist).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 400);
          save(SK_DEDUP, Object.fromEntries(entries));
          seenBetKeys.add(betKey);

          // Extrait et enregistre la mise
          var firstMatch = text.match(/€([\d]+[.,][\d]+)/);
          if (!firstMatch) return;
          var amount = parseFloat(firstMatch[1].replace(",", "."));
          if (amount <= 0 || amount > 5000) return;

          var wager = load(SK_WAGER, []);
          wager.push({ ts: Date.now(), amount });
          var twoYears = Date.now() - 2 * 365 * 24 * 3600 * 1000;
          wager = wager.filter(function (w) { return w.ts > twoYears; });
          save(SK_WAGER, wager);
          console.log("[StakePulse] Bet detecte:", amount, "EUR |", text.substring(0, 60));
          if (curTab === "wager") renderWager();

          // Tente d'extraire le multiplicateur depuis le texte du bet
          var multMatch = text.match(/([\d]+[,.][\d]+)\s*[×x✕]/i);
          if (multMatch) {
            var multVal  = parseFloat(multMatch[1].replace(",", "."));
            var gameMatch = text.match(/^([A-Za-z][A-Za-z0-9\s\-_]{1,30}?)\s*\d{1,2}:\d{2}/);
            var gameName  = gameMatch ? gameMatch[1].trim() : null;
            if (isFinite(multVal) && multVal >= 1.01) {
              console.log("[StakePulse] Multiplicateur DOM:", multVal, "jeu:", gameName);
              checkMultiplier(gameName, multVal);
            }
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Outils de debug exposés dans la console navigateur
  window._srnEnableMultipDebug  = function () { MULTIP_DEBUG = true;  console.log("[StakePulse] Mode debug multiplicateur ACTIVE.");   };
  window._srnDisableMultipDebug = function () { MULTIP_DEBUG = false; console.log("[StakePulse] Mode debug multiplicateur desactive."); };


  // ============================================================
  // BLOC 10 — COMPTAGE DES EMOJIS STAKE
  // ============================================================

  /**
   * Liste exhaustive des emojis personnalisés de Stake (identifiants CMS).
   * Chaque emoji est une image <img alt=":nom:"> dans le DOM du chat.
   */
  var STAKE_EMOJIS = [
    "adesanya","biden","beer","blob","catbread","coffee","cooldoge","coupon",
    "coin","dendi","djokovic","doge","donut","easymoney","eddie","ezpz","gary",
    "jordan","kanye","lambo","lebron","lefroge","mahomes","mcgregor","messi",
    "nadal","nightdoge","nyancat","pepe","pikachu","rigged","rish","ronaldo",
    "santa","skem","stonks","sus","trump","umbrella","woods","elon",
    "feelsgoodman","monkas","pepehands","pepelaugh","poggers","chrissyblob","taco",
  ];

  var seenEmojiKeys = new Set(); // Déduplication des nodes emoji déjà comptés

  /**
   * Analyse un nœud DOM à la recherche d'emojis Stake (images <img alt=":nom:">).
   * Incrémente le compteur correspondant dans SK_EMOJI_COUNT.
   * Ignore le panneau StakePulse lui-même et les messages avec plus de 5 emojis (spam).
   */
  function trackEmojis(node) {
    if (!node.querySelectorAll) return;
    if (node.id === "srn-panel" || (node.closest && node.closest("#srn-panel"))) return;

    var imgs      = node.querySelectorAll("img");
    if (!imgs.length) return;

    // Filtre les images dont l'alt correspond au format ":nom:"
    var emojiImgs = Array.from(imgs).filter(function (img) { return /^:[a-z0-9_]+:$/.test(img.alt || ""); });
    if (!emojiImgs.length || emojiImgs.length > 5) return;

    var alts    = emojiImgs.map(function (img) { return img.alt; }).join(",");
    var nodeKey = alts + "|" + (node.textContent || "").substring(0, 30);

    if (seenEmojiKeys.has(nodeKey)) return;
    var ek      = "e|" + nodeKey;
    var persist = loadPersistDedup();
    if (persist[ek]) { seenEmojiKeys.add(nodeKey); return; }

    persist[ek] = Date.now();
    var entries = Object.entries(persist).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 300);
    save(SK_DEDUP, Object.fromEntries(entries));
    seenEmojiKeys.add(nodeKey);

    var counts  = load(SK_EMOJI_COUNT, {});
    var changed = false;
    emojiImgs.forEach(function (img) {
      var alt = (img.alt || "").replace(/:/g, "").trim().toLowerCase();
      if (!alt || !STAKE_EMOJIS.includes(alt)) return;
      counts[alt] = (counts[alt] || 0) + 1;
      changed = true;
      console.log("[StakePulse] Emoji detecte:", alt);
    });
    if (changed) save(SK_EMOJI_COUNT, counts);
  }


  // ============================================================
  // BLOC 11 — SUIVI DES RAINS & CLASSEMENTS
  // ============================================================

  /**
   * Retourne le début de la semaine courante (lundi 00:00:00) en timestamp.
   * Utilisé pour filtrer les classements hebdomadaires.
   */
  function getWeekStart(date) {
    var d = new Date(date);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Retourne le premier jour du mois courant à 00:00:00. */
  function getMonthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  /**
   * Met à jour les classements (weekly / monthly / allTime) pour chaque bénéficiaire
   * d'une rain. Réinitialise automatiquement les compteurs de la semaine/mois si
   * la fenêtre temporelle a changé depuis la dernière mise à jour.
   */
  function updateRankings(entry) {
    var rankings   = load(SK.RANKINGS, {});
    var now        = new Date();
    var weekStart  = getWeekStart(now).getTime();
    var monthStart = getMonthStart(now).getTime();

    entry.recipients.forEach(function (username) {
      if (!rankings[username]) rankings[username] = {
        weekly:  { count: 0, totalAmount: 0, currency: entry.currency, _start: weekStart  },
        monthly: { count: 0, totalAmount: 0, currency: entry.currency, _start: monthStart },
        allTime: { count: 0, totalAmount: 0, currency: entry.currency },
      };

      var p = rankings[username];
      // Réinitialise le compteur hebdomadaire si on est dans une nouvelle semaine
      if (!p.weekly._start  || p.weekly._start  < weekStart)
        p.weekly  = { count: 0, totalAmount: 0, currency: entry.currency, _start: weekStart  };
      // Réinitialise le compteur mensuel si on est dans un nouveau mois
      if (!p.monthly._start || p.monthly._start < monthStart)
        p.monthly = { count: 0, totalAmount: 0, currency: entry.currency, _start: monthStart };

      p.weekly.count++;  p.monthly.count++;  p.allTime.count++;
      if (entry.amount) {
        p.weekly.totalAmount  += entry.amount;
        p.monthly.totalAmount += entry.amount;
        p.allTime.totalAmount += entry.amount;
      }
    });

    save(SK.RANKINGS, rankings);
  }

  /**
   * Retourne les N premiers bénéficiaires pour une période donnée,
   * triés par montant total décroissant (puis par nombre de rains en cas d'égalité).
   */
  function getTopN(period, n) {
    var rankings   = load(SK.RANKINGS, {});
    var now        = new Date();
    var weekStart  = getWeekStart(now).getTime();
    var monthStart = getMonthStart(now).getTime();

    return Object.entries(rankings)
      .filter(function (e) {
        var p = e[1];
        if (period === "weekly")  return p.weekly._start  >= weekStart;
        if (period === "monthly") return p.monthly._start >= monthStart;
        return true; // allTime : pas de filtre temporel
      })
      .map(function (e) { return Object.assign({ username: e[0] }, e[1][period]); })
      .sort(function (a, b) { return b.totalAmount - a.totalAmount || b.count - a.count; })
      .slice(0, n);
  }

  /**
   * Envoie le classement des 10 premiers bénéficiaires pour une période via Telegram.
   * Formate avec des médailles 🥇🥈🥉 pour les 3 premières places.
   */
  function sendRankingToTelegram(period) {
    var top   = getTopN(period, 10);
    var label = { weekly: "Cette semaine", monthly: "Ce mois", allTime: "Tout temps" }[period];

    if (!top.length) { sendTelegram(label + " - Aucune rain enregistree."); return; }

    var medals = ["🥇", "🥈", "🥉"];
    var lines  = top.map(function (p, i) {
      var isEuro  = p.currency === "€" || p.currency === "EUR";
      var amtStr  = p.totalAmount > 0
        ? (isEuro ? " - " + p.totalAmount.toFixed(2) + "€" : " - " + p.totalAmount.toFixed(6) + " " + (p.currency || ""))
        : "";
      return (medals[i] || (i + 1) + ".") + " <b>" + escHtml(p.username) + "</b> - " +
             p.count + " rain" + (p.count > 1 ? "s" : "") + amtStr;
    }).join("\n");

    sendTelegram("🏆 Classement rains recues - " + label + "\n\n" + lines);
  }


  // ============================================================
  // BLOC 12 — SUIVI DE L'ACTIVITÉ & INACTIVITÉ
  // ============================================================

  var inactivityAlertSent = false; // Empêche d'envoyer plusieurs alertes d'inactivité consécutives

  /** Retourne le timestamp du dernier message envoyé par l'utilisateur. */
  function getLastMsgTime() { return parseInt(GM_getValue(SK.LAST_MSG_TIME, "0"), 10) || 0; }

  /** Enregistre le timestamp du dernier message envoyé par l'utilisateur. */
  function setLastMsgTime(ts) { GM_setValue(SK.LAST_MSG_TIME, String(ts)); }

  /**
   * Observe les champs de saisie du chat pour détecter quand l'utilisateur tape.
   * Met à jour lastMsgTime à chaque frappe dans la zone de texte.
   */
  function trackOwnMessages() {
    new MutationObserver(function () {
      var inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
      inputs.forEach(function (a) {
        if ((a.value || a.textContent || "").trim().length > 0) {
          setLastMsgTime(Date.now());
          inactivityAlertSent = false;
        }
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /**
   * Vérifie toutes les minutes si l'utilisateur est inactif.
   * Envoie une alerte Telegram si l'inactivité dépasse CONFIG.INACTIVITY_MINUTES.
   */
  function checkInactivity() {
    var last = getLastMsgTime();
    if (!last) return;
    var mins = (Date.now() - last) / 60000;
    if (mins >= CONFIG.INACTIVITY_MINUTES && !inactivityAlertSent) {
      inactivityAlertSent = true;
      sendTelegram("⏰ <b>Inactivite !</b>\nTu n'as pas parle depuis <b>" + Math.round(mins) + " minutes</b>.");
    }
    refreshPanel();
  }

  /**
   * Affiche une notification navigateur (API Notification).
   * Ne fait rien si la permission n'a pas été accordée.
   */
  function showNotif(msg) {
    if (Notification.permission === "granted")
      new Notification("StakePulse", { body: msg, icon: "https://stake.bet/favicon.ico" });
  }


  // ============================================================
  // BLOC 13 — CRYPTOS & TAUX DE CHANGE
  // ============================================================

  /**
   * Liste des cryptos suivies : [symbole affiché, identifiant CoinGecko].
   * Utilisée pour le ticker défilant et l'onglet convertisseur.
   */
  var CRYPTO_LIST = [
    ["USDT","tether"],["BTC","bitcoin"],["ETH","ethereum"],["LTC","litecoin"],
    ["SOL","solana"],["DOGE","dogecoin"],["BCH","bitcoin-cash"],["XRP","ripple"],
    ["TRX","tron"],["EOS","eos"],["BNB","binancecoin"],["USDC","usd-coin"],
    ["APE","apecoin"],["BUSD","binance-usd"],["CRO","crypto-com-chain"],
    ["DAI","dai"],["LINK","chainlink"],["SAND","the-sandbox"],["SHIB","shiba-inu"],
    ["UNI","uniswap"],["POL","matic-network"],["TRUMP","maga"],
  ];
  var cryptoPrices   = {}; // Cache des prix : { coingecko_id: { usd, eur, usd_24h_change } }
  var cryptoLastFetch = 0; // Timestamp du dernier appel CoinGecko

  /**
   * Récupère les prix USD/EUR et la variation 24h de toutes les cryptos via CoinGecko.
   * Appelle callback(prices) une fois les données disponibles.
   */
  function fetchCryptoPrices(callback) {
    var ids = CRYPTO_LIST.map(function (c) { return c[1]; }).join(",");
    var url = "https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd,eur&include_24hr_change=true";
    GM_xmlhttpRequest({
      method: "GET", url: url,
      onload: function (res) {
        try {
          cryptoPrices    = JSON.parse(res.responseText);
          cryptoLastFetch = Date.now();
          if (callback) callback(cryptoPrices);
        } catch (e) {}
      },
      onerror: function () {},
    });
  }

  /** Liste des devises fiat supportées par le convertisseur. */
  var STAKE_CURRENCIES = [
    "USD","EUR","CAD","JPY","CNY","RUB","INR","IDR","KRW","PHP","MXN","PLN",
    "TRY","VND","ARS","PEN","CLP","NGN","AED","BHD","CRC","KWD","MAD","MYR",
    "QAR","SAR","SGD","TND","TWD","GHS","KES","BOB","XOF","PKR","NZD","ISK",
    "BAM","TZS","EGP","UGX",
  ];
  var convRates     = {}; // Cache des taux : { devise: taux_relatif_à_EUR }
  var convBase      = "EUR";
  var convLastFetch = 0;

  /**
   * Récupère les taux de change depuis exchangerate-api.com (base EUR).
   * Met à jour convRates et appelle callback() une fois prêt.
   * Ne requête pas si les données ont moins de 30 minutes.
   */
  function fetchRates(callback) {
    var now = Date.now();
    if (now - convLastFetch < 30 * 60 * 1000 && Object.keys(convRates).length > 0) { callback(); return; }
    GM_xmlhttpRequest({
      method: "GET",
      url: "https://api.exchangerate-api.com/v4/latest/EUR",
      onload: function (res) {
        try {
          var data      = JSON.parse(res.responseText);
          convRates     = data.rates;
          convBase      = "EUR";
          convLastFetch = Date.now();
          callback();
        } catch (e) {
          var rateEl = document.getElementById("srn-conv-rate");
          if (rateEl) rateEl.textContent = "Erreur de chargement des taux";
        }
      },
      onerror: function () {
        var rateEl = document.getElementById("srn-conv-rate");
        if (rateEl) rateEl.textContent = "Erreur reseau - verifiez votre connexion";
      },
    });
  }

  /**
   * Convertit un montant d'une devise vers une autre en passant par EUR comme pivot.
   * Retourne null si un des deux taux est inconnu.
   */
  function convertAmount(amount, from, to) {
    if (!convRates[from] || !convRates[to]) return null;
    return (amount / convRates[from]) * convRates[to];
  }


  // ============================================================
  // BLOC 14 — RANGS STAKE & CALCULATEUR DE WAGER
  // ============================================================

  /**
   * Table des rangs Stake avec seuils de wager USD, couleurs et icônes.
   * Utilisée par renderRang() pour calculer le wager restant avant le prochain rang.
   */
  var STAKE_RANKS = [
    { name: "No Rank",    min: 0,          max: 10000,      color: "#8899aa", icon: "⬜" },
    { name: "Bronze",     min: 10000,      max: 50000,      color: "#cd7f32", icon: "🥉" },
    { name: "Silver",     min: 50000,      max: 100000,     color: "#c0c0c0", icon: "🥈" },
    { name: "Gold",       min: 100000,     max: 250000,     color: "#ffd700", icon: "🥇" },
    { name: "Platinum",   min: 250000,     max: 500000,     color: "#00d4ff", icon: "💎" },
    { name: "Platinum 2", min: 500000,     max: 1000000,    color: "#00d4ff", icon: "💎" },
    { name: "Platinum 3", min: 1000000,    max: 2500000,    color: "#00d4ff", icon: "💎" },
    { name: "Platinum 4", min: 2500000,    max: 5000000,    color: "#00d4ff", icon: "💎" },
    { name: "Platinum 5", min: 5000000,    max: 10000000,   color: "#00d4ff", icon: "💎" },
    { name: "Platinum 6", min: 10000000,   max: 25000000,   color: "#00d4ff", icon: "💎" },
    { name: "Diamond",    min: 25000000,   max: Infinity,   color: "#ff00ff", icon: "👑" },
  ];

  /**
   * Retourne le rang correspondant à un montant de wager donné,
   * ainsi que son index dans STAKE_RANKS.
   */
  function getRank(wager) {
    for (var i = STAKE_RANKS.length - 1; i >= 0; i--) {
      if (wager >= STAKE_RANKS[i].min) return { rank: STAKE_RANKS[i], index: i };
    }
    return { rank: STAKE_RANKS[0], index: 0 };
  }


  // ============================================================
  // BLOC 15 — VÉRIFICATION DES MISES À JOUR
  // ============================================================

  var CURRENT_VERSION = "5.4.3"; // Doit correspondre à @version dans l'en-tête
  var RAW_URL = "https://raw.githubusercontent.com/tarteteambrumaire-debug/stake-rain-notifier/main/stake-rain-notifier.user.js";

  /**
   * Vérifie si une nouvelle version du script est disponible sur GitHub.
   * Compare la version distante avec CURRENT_VERSION et affiche un banner si elle diffère.
   */
  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: "GET",
      url: RAW_URL,
      onload: function (res) {
        try {
          var m = res.responseText.match(/\/\/ @version\s+([\d.]+)/);
          if (m && m[1] !== CURRENT_VERSION) showUpdateBanner(m[1]);
        } catch (e) {}
      },
      onerror: function () {},
    });
  }

  /**
   * Affiche un banner persistant dans le panneau indiquant qu'une mise à jour est disponible.
   * Le bouton "Installer" ouvre le fichier brut sur GitHub dans un nouvel onglet.
   */
  function showUpdateBanner(newVersion) {
    if (document.getElementById("srn-update-banner")) return; // Ne pas afficher deux fois
    var banner       = document.createElement("div");
    banner.id        = "srn-update-banner";
    banner.style.cssText = "background:#162330;border:1px solid #00ff8855;border-radius:8px;padding:8px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px";
    banner.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<span style="font-size:16px">🎉</span>' +
      '<div><div style="color:#00ff88;font-weight:700">Mise a jour disponible !</div>' +
      '<div style="color:#8899aa">Version ' + newVersion + ' disponible</div></div></div>' +
      '<button id="srn-update-btn" style="background:#00ff8822;border:1px solid #00ff8855;border-radius:6px;color:#00ff88;cursor:pointer;font-size:11px;font-weight:700;padding:4px 10px">Installer puis rafraichir</button>';
    var body = document.getElementById("srn-body");
    if (body) body.insertBefore(banner, body.firstChild);
    document.getElementById("srn-update-btn").addEventListener("click", function () { window.open(RAW_URL, "_blank"); });
  }


  // ============================================================
  // BLOC 16 — INTERFACE UTILISATEUR (UI) — PANNNEAU & STYLES
  // ============================================================

  /**
   * Injecte tous les styles CSS du panneau StakePulse dans la page.
   * Couvre : panneau principal, onglets, cartes de stats, classements, ticker crypto,
   *          popup de notifications, mode clair/sombre, animations rain/multip.
   * (Contenu CSS identique à l'original — non reproduit ici pour la lisibilité)
   */
  // GM_addStyle([...].join(""));  ← styles injectés à l'initialisation

  /** Variables d'état de l'UI */
  var panelEl      = null;         // Référence au div#srn-panel
  var curTab       = "dashboard";  // Onglet actuellement affiché
  var wagerPeriod  = "day";        // Période sélectionnée pour les stats de wager
  var emojiPeriod  = "all";        // Période sélectionnée pour les emojis
  var rankPeriod   = "weekly";     // Période sélectionnée pour le classement
  var wordPeriod   = "day";        // Période sélectionnée pour les mots-clés
  var rainPeriod   = "week";       // Période sélectionnée pour les rainers
  var collapsed    = false;        // Panneau réduit (corps masqué) ou non
  var selectedWordId = null;       // Mot-clé sélectionné pour l'affichage du détail

  /**
   * Liste de tous les onglets disponibles.
   * L'onglet "dashboard" est toujours visible ; les autres sont activables/désactivables.
   */
  var ALL_TABS = [
    { id: "dashboard", label: "Stats"          },
    { id: "ranking",   label: "Classement"     },
    { id: "history",   label: "Historique"     },
    { id: "messages",  label: "Messages"       },
    { id: "mystats",   label: "Mes Stats"      },
    { id: "moderation",label: "Mots"           },
    { id: "rainers",   label: "Rains"          },
    { id: "wager",     label: "Stats Wager"    },
    { id: "multip",    label: "Multiplicateur" },
    { id: "converter", label: "Convertisseur"  },
    { id: "rang",      label: "Rang"           },
  ];


  // ============================================================
  // BLOC 17 — ASSISTANT DE CONFIGURATION (SETUP WIZARD)
  // ============================================================

  /**
   * Affiche l'assistant de configuration en 3 étapes lors de la première installation.
   *   Étape 1 : Saisie du pseudo Stake (+ rappel pour @StakePulseBot sur Telegram)
   *   Étape 2 : Configuration du bot Telegram personnel (optionnel)
   *   Étape 3 : Sélection des onglets à activer
   *
   * Sauvegarde SK_SETUP_DONE = true à la fin pour ne plus afficher le wizard.
   */
  function buildSetup() { /* ... */ }


  // ============================================================
  // BLOC 18 — CONSTRUCTION DU PANNEAU PRINCIPAL
  // ============================================================

  /**
   * Crée et insère dans le DOM le panneau flottant StakePulse.
   * Structure HTML :
   *   #srn-hdr        → En-tête (titre, badge LIVE, boutons thème/réduire)
   *   #srn-notif-popup → Popup des notifications non lues
   *   #srn-body       → Corps du panneau
   *     #srn-menu-btn / #srn-menu-dropdown → Menu déroulant de navigation
   *     .srn-sec       → Sections d'onglets (dashboard, ranking, history…)
   *   #srn-resize     → Poignée de redimensionnement vertical
   *   #srn-ticker     → Ticker crypto défilant
   *
   * Initialise aussi :
   *   - makeDraggable  : déplacement du panneau par drag & drop sur l'en-tête
   *   - makeResizable  : redimensionnement via les poignées bas/gauche
   *   - Gestion du thème clair/sombre (sauvegardé dans GM)
   *   - Délégation d'événements pour tous les boutons data-srn="action"
   */
  function buildPanel() { /* ... */ }


  // ============================================================
  // BLOC 19 — FONCTIONS DE RENDU DES ONGLETS
  // ============================================================

  /**
   * refreshPanel() — Rafraîchit les données du dashboard (compteurs de rain du jour/semaine/mois)
   *   et délègue le rendu à la fonction spécifique de l'onglet actif.
   *   Gère aussi le badge de notifications non lues et l'alerte d'objectif hebdomadaire.
   */
  function refreshPanel() { /* ... */ }

  /** renderRanking()   — Affiche le classement des bénéficiaires de rain (top 10 + position de l'utilisateur). */
  function renderRanking() { /* ... */ }

  /** renderHistory()   — Affiche l'historique complet des rains reçues (liste chronologique inverse). */
  function renderHistory() { /* ... */ }

  /** renderMessages()  — Affiche les mentions/notifications avec actions lire/supprimer. */
  function renderMessages() { /* ... */ }

  /** renderMyStats()   — Affiche les statistiques personnelles de l'utilisateur (objectif, cartes, histogramme). */
  function renderMyStats() { /* ... */ }

  /** renderModeration() — Affiche le comptage des WORD_RULES avec barres de progression et détail par jour. */
  function renderModeration() { /* ... */ }

  /** renderEmojiStats() — Affiche le classement des emojis Stake détectés dans le chat. */
  function renderEmojiStats() { /* ... */ }

  /** renderRainers()   — Affiche le classement des utilisateurs qui font des rains (expéditeurs). */
  function renderRainers() { /* ... */ }

  /** renderWager()     — Affiche les statistiques de mises (total, moyenne, max, histogramme par heure/jour). */
  function renderWager() { /* ... */ }

  /** renderMultip()    — Affiche la configuration des multiplicateurs et l'historique des 20 derniers. */
  function renderMultip() { /* ... */ }

  /** renderConverter() — Affiche le convertisseur de devises avec taux temps réel et conversions rapides. */
  function renderConverter() { /* ... */ }

  /** renderRang()      — Affiche le calculateur de rang Stake (wager actuel estimé, wager restant). */
  function renderRang() { /* ... */ }

  /** renderKeywords()  — Affiche et permet de gérer la liste des mots-clés surveillés (@mentions). */
  function renderKeywords() { /* ... */ }

  /** renderCustomWordsList() — Affiche les mots-clés personnalisés ajoutés par l'utilisateur. */
  function renderCustomWordsList() { /* ... */ }

  /** renderNotifPopup()     — Peuple le popup de notifications avec les 5 dernières mentions non lues. */
  function renderNotifPopup() { /* ... */ }

  /** renderTabsToggles()    — Affiche les toggles on/off pour chaque onglet dans les paramètres. */
  function renderTabsToggles() { /* ... */ }


  // ============================================================
  // BLOC 20 — ANIMATIONS VISUELLES
  // ============================================================

  /**
   * Affiche une animation plein-écran lors d'une rain détectée.
   * L'animation disparaît automatiquement après 3,5 secondes.
   */
  function showRainAnimation(amount) { /* ... */ }

  /**
   * Affiche une animation de notification lors d'un multiplicateur significatif.
   * Style différent selon la valeur (bleu, vert, or, violet pour les très gros multips).
   */
  function showMultipAnimation(gameName, multiplier) { /* ... */ }


  // ============================================================
  // BLOC 21 — API PUBLIQUE WINDOW._SRN (actions UI)
  // ============================================================

  /**
   * Objet window._srn exposant les actions déclenchées par les boutons data-srn="...".
   * Permet aussi les appels depuis la console du navigateur pour le debug.
   *
   * Actions disponibles :
   *   sendRank(period)        → Envoie le classement sur Telegram
   *   addKeyword()            → Ajoute un mot-clé surveillé
   *   removeKeyword(index)    → Supprime un mot-clé surveillé
   *   addCustomWord()         → Ajoute un mot-clé personnalisé avec regex
   *   removeCustomWord(id)    → Supprime un mot-clé personnalisé
   *   saveConfig()            → Sauvegarde la configuration Telegram/pseudo
   *   test()                  → Envoie un message Telegram de test
   *   testMention()           → Simule une mention pour tester les notifications
   *   testMultip()            → Simule un multiplicateur pour tester les notifications
   *   resetMultip()           → Vide l'historique des multiplicateurs
   *   reset()                 → Affiche/masque le bouton de confirmation de réinitialisation
   *   resetConfirm()          → Réinitialise toutes les données (rain log, rankings, mentions…)
   *   resetCancel()           → Annule la réinitialisation
   *   replaySetup()           → Relance l'assistant de configuration
   *   deleteMention(id)       → Supprime une mention et l'ajoute à la blacklist
   *   readMention(id)         → Marque une mention comme lue
   *   goToMessages()          → Navigue vers l'onglet Messages
   *   readAllMentions()       → Marque toutes les mentions comme lues
   *   deleteReadMentions()    → Supprime les mentions déjà lues
   *   deleteAllMentions()     → Supprime toutes les mentions
   *   saveMultipConfig()      → Sauvegarde le seuil global de multiplicateur
   *   addMultipGame()         → Ajoute un seuil personnalisé pour un jeu
   *   removeMultipGame(index) → Supprime un seuil de jeu spécifique
   *   convertCurrency()       → Effectue la conversion de devise dans l'UI
   *   saveMyStatsOffset()     → Sauvegarde les correctifs manuels des stats personnelles
   *   resetEmojis()           → Remet à zéro le comptage des emojis
   *   resetWords()            → Remet à zéro le comptage des mots-clés
   *   resetRains()            → Remet à zéro le classement des rainers
   */
  window._srn = { /* ... actions définies dans le code original ... */ };


  // ============================================================
  // BLOC 22 — UTILITAIRES GÉNÉRAUX
  // ============================================================

  /**
   * Échappe les caractères HTML spéciaux pour éviter les injections XSS
   * dans les éléments innerHTML construits dynamiquement.
   */
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Rend le panneau déplaçable par drag & drop sur son en-tête.
   * Mémorise le décalage initial pour un positionnement précis.
   */
  function makeDraggable(el, handle) { /* ... */ }

  /**
   * Rend le panneau redimensionnable via deux poignées :
   *   - Poignée bas (handleBottom) : redimensionnement vertical (min 150px, max 700px)
   *   - Poignée gauche (#srn-resize-left) : redimensionnement horizontal (min 280px, max 700px)
   */
  function makeResizable(panel, handleBottom) { /* ... */ }

  /**
   * Parcourt récursivement un objet JSON et appelle callback(obj)
   * pour chaque sous-objet (utilisé par scanPayload pour trouver les messages).
   */
  function walkObject(data, callback) { /* ... (défini dans le code original) */ }

  /**
   * Charge la configuration sauvegardée depuis SK.USER_CONFIG et l'applique à CONFIG.
   * Appelé au démarrage avant toute autre initialisation.
   */
  function loadSavedConfig() {
    var c = load(SK.USER_CONFIG, {});
    if (c.token)    CONFIG.TELEGRAM_BOT_TOKEN  = c.token;
    if (c.chatid)   CONFIG.TELEGRAM_CHAT_ID    = c.chatid;
    if (c.username) CONFIG.YOUR_USERNAME       = c.username;
    if (c.inactivity) CONFIG.INACTIVITY_MINUTES = c.inactivity;
    if (c.keywords && Array.isArray(c.keywords)) CONFIG.WATCH_KEYWORDS = c.keywords;
  }

  /**
   * Lit la configuration des onglets visibles depuis SK_TABS_CONFIG.
   * Active par défaut tous les onglets qui n'ont pas encore de préférence enregistrée.
   */
  function getTabsConfig() {
    var cfg = load(SK_TABS_CONFIG, {});
    ALL_TABS.forEach(function (t) { if (cfg[t.id] === undefined) cfg[t.id] = true; });
    return cfg;
  }

  /**
   * Applique la configuration des onglets visibles au DOM du panneau.
   * Cache les éléments de menu des onglets désactivés et bascule sur le dashboard si l'onglet
   * actif est désactivé.
   */
  function applyTabsConfig() { /* ... */ }

  /** Sauvegarde les mots-clés surveillés dans la config utilisateur persistante. */
  function saveKeywords() {
    var c = load(SK.USER_CONFIG, {});
    save(SK.USER_CONFIG, Object.assign({}, c, { keywords: CONFIG.WATCH_KEYWORDS }));
  }


  // ============================================================
  // BLOC 23 — INITIALISATION
  // ============================================================

  /**
   * Point d'entrée principal du script.
   *
   * Ordre d'initialisation :
   *   1. loadSavedConfig()       — Charge les préférences utilisateur
   *   2. loadCustomWords()       — Fusionne les mots personnalisés dans WORD_RULES
   *   3. interceptWebSocket()    — Patche WebSocket et fetch pour écouter le chat
   *   4. buildPanel()            — Construit et insère le panneau dans le DOM
   *   5. buildSetup() si needed  — Affiche le wizard de première configuration
   *   6. checkForUpdate()        — Vérifie les mises à jour (8s après démarrage, puis toutes les heures)
   *   7. observeChat()           — Lance l'observation DOM du chat
   *   8. trackOwnMessages()      — Surveille l'activité de l'utilisateur
   *   9. checkInactivity()       — Lance la vérification d'inactivité (toutes les 60s)
   *   10. observeBets()          — Lance l'observation DOM des bets
   *   11. refreshPanel()         — Rafraîchit l'UI toutes les 30s
   *   12. fetchCryptoPrices()    — Charge les prix crypto au démarrage
   *   13. fbPull()               — Charge les données Firebase partagées
   *   14. fbPush() toutes les 15s — Synchronise les données locales vers Firebase
   */
  function init() {
    loadSavedConfig();
    loadCustomWords();
    interceptWebSocket();

    var start = function () {
      buildPanel();

      // Affiche le wizard si c'est la première installation
      if (!load(SK_SETUP_DONE, false)) {
        setTimeout(function () { buildSetup(); }, 500);
      }

      // Vérification des mises à jour : immédiate (8s) puis horaire
      setTimeout(checkForUpdate, 8000);
      setInterval(checkForUpdate, 60 * 60 * 1000);

      observeChat();
      trackOwnMessages();
      setInterval(checkInactivity, 60000);
      observeBets();
      setInterval(refreshPanel, 30000);

      // Demande la permission de notifications navigateur si pas encore accordée
      if (Notification.permission === "default") Notification.requestPermission();

      console.log("[StakePulse] Actif sur Stake.bet | Pseudo:", CONFIG.YOUR_USERNAME, "| Mots-cles:", CONFIG.WATCH_KEYWORDS);

      // Charge les prix crypto dès le démarrage
      fetchCryptoPrices(updateTicker);

      // Charge les données Firebase partagées, puis rafraîchit l'UI
      fbPull(function () {
        refreshPanel();
        console.log("[StakePulse] Donnees Firebase chargees");
      });

      // Pull Firebase toutes les 30s, push toutes les 15s
      setInterval(function () { fbPull(refreshPanel); }, 30000);
      setInterval(fbPush, 15000);
    };

    // Lance start() dès que le DOM est prêt
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start);
  }

  init(); // Démarre le script

})();
