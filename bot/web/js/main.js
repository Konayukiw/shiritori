/**
 * しりとり Bot — static web client (GitHub Pages compatible)
 */

import { defaultConfig } from "./config.js";
import { GameState } from "./game.js";
import { loadDictionaries } from "./dict-loader.js";
import { OpponentWordValidator } from "./validator.js";
import { BotWordSelector } from "./selector.js";

const els = {
  logPane: document.getElementById("log-pane"),
  statusBar: document.getElementById("status-bar"),
  wordInput: document.getElementById("word-input"),
  btnSubmit: document.getElementById("btn-submit"),
  btnReset: document.getElementById("btn-reset"),
  btnApply: document.getElementById("btn-apply"),
  setupOverlay: document.getElementById("setup-overlay"),
  setupMsg: document.getElementById("setup-msg"),
  cbBotFirst: document.getElementById("cb-bot-first"),
  cbPerson: document.getElementById("cb-person"),
  cbPlace: document.getElementById("cb-place"),
  cbOrg: document.getElementById("cb-org"),
  cbProper: document.getElementById("cb-proper"),
  cbOther: document.getElementById("cb-other"),
  cbVerb: document.getElementById("cb-verb"),
  cbIgnoreDakuten: document.getElementById("cb-ignore-dakuten"),
  cbAllowAlnum: document.getElementById("cb-allow-alnum"),
};

/** @type {{ config: object, jmdict: import("./validator.js").JmdictIndex, pool: import("./selector.js").VocabPool, validator: OpponentWordValidator, selector: BotWordSelector, game: GameState } | null} */
let app = null;
let setupDone = false;
let busy = false;

function log(sender, message) {
  const div = document.createElement("div");
  const cls = {
    あなた: "user",
    Bot: "bot",
    システム: "system",
    結果: "result",
    エラー: "error",
  }[sender];
  div.className = "log-entry" + (cls ? " " + cls : "");
  div.textContent = `[${sender}] ${message}`;
  els.logPane.appendChild(div);
  els.logPane.scrollTop = els.logPane.scrollHeight;
}

function updateStatus() {
  if (!app) {
    els.statusBar.textContent = "準備中…";
    return;
  }
  const s = app.game.status();
  const parts = [`ターン: ${s.turnCount}`];
  if (s.lastSurface) parts.push(`直前: ${s.lastSurface}`);
  if (s.expectedFirstMora) parts.push(`次: 『${s.expectedFirstMora}』`);
  parts.push(`使用済み: ${s.usedCount} 語`);
  els.statusBar.textContent = parts.join(" | ");
}

function setInputEnabled(enabled) {
  els.wordInput.disabled = !enabled;
  els.btnSubmit.disabled = !enabled;
}

function setSetupMsg(msg) {
  els.setupMsg.textContent = msg;
}

function readConfigFromUi() {
  const cfg = defaultConfig();
  cfg.allowPerson = els.cbPerson.checked;
  cfg.allowPlace = els.cbPlace.checked;
  cfg.allowOrganization = els.cbOrg.checked;
  cfg.allowProper = els.cbProper.checked;
  cfg.allowOther = els.cbOther.checked;
  cfg.allowVerb = els.cbVerb.checked;
  cfg.requireDakutenMatch = !els.cbIgnoreDakuten.checked;
  cfg.allowAlnum = els.cbAllowAlnum.checked;
  return cfg;
}

function applyConfig(cfg) {
  if (!app) return;
  app.config = cfg;
  app.game.config = cfg;
  app.validator = new OpponentWordValidator(app.jmdict, cfg);
  app.selector = new BotWordSelector(app.pool, cfg);
}

function maybeBotFirst() {
  if (!app || !els.cbBotFirst.checked) return;
  const start = app.selector.select("し", new Set());
  if (start == null) {
    app.game.markUsed("しりとり", "しりとり", "bot");
    log("Bot", "しりとり（しりとり）");
  } else {
    app.game.markUsed(start.reading, start.surface, "bot");
    log("Bot", `${start.surface}（${start.reading}）`);
  }
  const next = app.game.expectedFirstMora;
  if (next) log("システム", `→ 次は『${next}』から`);
}

function restartGame() {
  if (!app) return;
  app.game.reset();
  els.logPane.innerHTML = "";
  log("システム", "対局をリセットしました。好きな語から始めてください。");
  maybeBotFirst();
  setInputEnabled(true);
  updateStatus();
  els.wordInput.focus();
}

function submitWord(word) {
  if (!app || !setupDone || busy) return;
  const userInput = word.trim();
  if (!userInput) return;

  busy = true;
  setInputEnabled(false);

  try {
    const result = app.validator.validate(userInput, {
      expectedLastMora: app.game.expectedFirstMora,
      usedReadings: app.game.usedReadings,
    });

    if (!result.ok) {
      log("あなた", `${userInput} → × ${result.reason || ""}`);
      updateStatus();
      setInputEnabled(true);
      busy = false;
      els.wordInput.focus();
      return;
    }

    log(
      "あなた",
      `${result.surface}${result.reading ? `（${result.reading}）` : ""}`
    );
    app.game.markUsed(result.reading, result.surface, "user");

    if (result.lost) {
      log("結果", result.reason);
      log("結果", `今回の対戦は ${app.game.turnCount} ターンで終了しました。`);
      updateStatus();
      busy = false;
      return;
    }

    const botWord = app.selector.select(
      result.effectiveLastMora || "",
      app.game.usedReadings
    );

    if (botWord == null) {
      log("結果", "参りました、私の負けです。");
      log("結果", `今回の対戦は ${app.game.turnCount} ターンで終了しました。`);
      updateStatus();
      busy = false;
      return;
    }

    app.game.markUsed(botWord.reading, botWord.surface, "bot");
    log("Bot", `${botWord.surface}（${botWord.reading}）`);
    log(
      "システム",
      `→ 次は『${app.game.expectedFirstMora || "?"}』から`
    );
    updateStatus();
    setInputEnabled(true);
    els.wordInput.focus();
  } catch (e) {
    log("エラー", e.message || String(e));
    setInputEnabled(true);
  } finally {
    busy = false;
  }
}

async function bootstrap() {
  setSetupMsg("原本辞書を準備しています…");
  try {
    const dicts = await loadDictionaries(setSetupMsg, {
      includeJmnedict: true,
    });
    const config = readConfigFromUi();
    const game = new GameState(config);
    app = {
      config,
      jmdict: dicts.jmdict,
      pool: dicts.pool,
      validator: new OpponentWordValidator(dicts.jmdict, config),
      selector: new BotWordSelector(dicts.pool, config),
      game,
    };
    setupDone = true;
    els.setupOverlay.classList.add("hidden");
    setInputEnabled(true);
    log("システム", "しりとり Bot へようこそ！");
    log(
      "システム",
      dicts.fromCache
        ? "キャッシュ済みの語彙で開始します。"
        : "SudachiDict / JMdict / JMnedict を読み込みました。"
    );
    log("システム", "好きな単語を入力して遊んでください。");
    updateStatus();
    els.wordInput.focus();
  } catch (e) {
    console.error(e);
    setSetupMsg(
      "セットアップに失敗しました。\n\n" +
        (e && e.message ? e.message : String(e)) +
        "\n\nローカル: python -m bot.web.main\n" +
        "GitHub Pages: Actions の pages ワークフローで dicts/ を同梱してください。"
    );
    els.setupOverlay.querySelector(".spinner")?.classList.add("hidden");
  }
}

// Events
els.wordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const word = els.wordInput.value;
    els.wordInput.value = "";
    if (setupDone && word) submitWord(word);
  }
});

els.btnSubmit.addEventListener("click", () => {
  const word = els.wordInput.value;
  els.wordInput.value = "";
  if (setupDone && word) submitWord(word);
});

els.btnReset.addEventListener("click", () => {
  if (!setupDone) return;
  restartGame();
});

els.btnApply.addEventListener("click", () => {
  if (!setupDone || !app) return;
  applyConfig(readConfigFromUi());
  app.game.reset();
  els.logPane.innerHTML = "";
  log("システム", "設定を適用し、対局をリセットしました。");
  maybeBotFirst();
  setInputEnabled(true);
  updateStatus();
  els.wordInput.focus();
});

bootstrap();
