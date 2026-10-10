import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";

// ---------- 定数 ----------
const PATTERNS = {
  1: { name: "パターン1：コメンテーター型", short: "コメンテーター型",
       desc: "出来事に「自分はこう見る」という解釈をつける型。聞き手がいちばん知りたいのは、事実よりあなたの見立てです。",
       lines: ["事実：○○がありました。", "見立て：私は○○だと見ています。", "理由：なぜなら○○だからです。"],
       example: "昨日、同僚が会議の冒頭で結論から話しました。私はあれが会議を15分短くした理由だと見ています。なぜなら、全員が最初から何を判断すればいいか分かっていたからです。" },
  2: { name: "パターン2：So What型", short: "So What型",
       desc: "出来事から「だから自分はどうするか」まで踏み込む型。最後は理由ではなく「〜すべき」という提案で締めます。",
       lines: ["事実：○○がありました。", "意味：これは○○を意味します。", "示唆：だから私は○○すべきだと見ています。"],
       example: "今朝、いつもより30分早く家を出ました。これは、朝に余白があると一日の段取りが変わることを意味します。だから私は、平日は毎日30分早く出るべきだと見ています。" },
  3: { name: "パターン3：ストーリー型", short: "ストーリー型",
       desc: "昔と今を比べて、この先どうなるかを言い切る型。変化の流れを見せると、未来の予測に説得力が出ます。",
       lines: ["過去：かつて○○でした。", "現在：しかし今は○○です。", "未来：このままいけば○○になると見ています。"],
       example: "かつて私は、本を最後まで読み切らないと気が済みませんでした。しかし今は、必要な章だけ読んで次に進んでいます。このままいけば、読んだ量より使った量で読書を測るようになると見ています。" },
};

// 型の説明ブロック（概要・3文の組み立て・例）
function patternGuide(pattern, open) {
  const P = PATTERNS[pattern];
  const box = document.createElement("details");
  box.className = "guide"; box.open = open;
  box.innerHTML = `<summary>${P.short}とは</summary><p class="desc"></p><ol class="template"></ol><p class="example-label">例</p><p class="example"></p>`;
  box.querySelector(".desc").textContent = P.desc;
  box.querySelector(".template").replaceChildren(...P.lines.map((l) => Object.assign(document.createElement("li"), { textContent: l })));
  box.querySelector(".example").textContent = P.example;
  return box;
}
const PREP_SEC = 30;
const REC_SEC = 45;
const PAUSE_MIN = 1.0;      // 秒。これ以上の無音を「間」とする
const FRAME_MS = 50;
const DEFAULT_FOCUS = [
  "So What型は「なぜなら」で終わらせず、「だから〜すべきだと見ています」という自分ごとの提案で締める",
  "「〜の可能性を見ています」のように名詞化せず、「〜になると見ています」で直接言い切る",
  "固有名詞・数字は話す前に一度頭の中で確認する",
].join("\n");

// ---------- 保存 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("sd." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sd." + k, JSON.stringify(v)); } catch { /* 保存できなくても動作は続ける */ } },
};
let settings = store.get("settings", { key: "", model: "claude-opus-5-5", focus: DEFAULT_FOCUS });
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let day = store.get("day", null);
if (!day || day.date !== todayStr()) day = { date: todayStr(), topics: [], results: {} };
const saveDay = () => store.set("day", day);

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const views = ["settings", "home", "record", "result"];
function show(name) { for (const v of views) $("view-" + v).hidden = v !== name; window.scrollTo(0, 0); }
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- Claude ----------
function apiErrorText(e) {
  if (e instanceof Anthropic.AuthenticationError) return "APIキーが正しくありません。設定画面で確認してください。";
  if (e instanceof Anthropic.RateLimitError) return "リクエストが多すぎます。1分ほど待ってからもう一度試してください。";
  if (e instanceof Anthropic.APIConnectionError) return "通信できませんでした。電波の状態を確認してください。";
  if (e instanceof Anthropic.APIError) {
    if (e.status === 402) return "APIのクレジット残高がありません。Anthropicの管理画面でクレジットを追加してください。";
    return `APIエラー（${e.status ?? "不明"}）：${e.message}`;
  }
  return e?.message || String(e);
}

async function askJSON({ system, user, schema, effort }) {
  const client = new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true });
  const base = {
    model: settings.model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let res;
  try {
    res = await client.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  } catch (e) {
    // fallbacks の組み合わせが受け付けられない場合だけ、なしで1回やり直す
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) res = await client.messages.create(base);
    else throw e;
  }
  if (res.stop_reason === "refusal") throw new Error("Claudeがこの内容への回答を見送りました。お題を変えて試してください。");
  if (res.stop_reason === "max_tokens") throw new Error("回答が長すぎて途中で切れました。もう一度試してください。");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

// ---------- お題 ----------
const TOPIC_SCHEMA = {
  type: "object", additionalProperties: false, required: ["topics"],
  properties: { topics: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["pattern", "topic", "hint"],
    properties: { pattern: { type: "integer", enum: [1, 2, 3] }, topic: { type: "string" }, hint: { type: "string" } },
  } } },
};
const TOPIC_SYSTEM = `あなたはスピーチ練習のコーチです。毎日の「3文スピーチ」のお題を作ります。

型：
- パターン1 コメンテーター型：事実→見立て→理由
- パターン2 So What型：事実→意味→だから〜すべき（自分ごとの提案）
- パターン3 ストーリー型：過去→現在→未来

お題のルール：
- ニュースや時事ではなく、話し手自身の日常・体験から30秒で話せること。調べものや専門知識は不要
- 多くは「昨日」「今日」「今朝」「今週」「最近」に結びつけ、同じ切り口でも毎日違う中身になるようにする
- 「何をしたか」の報告で終わらず、見立て・意見を入れやすいこと
- 型に合わせる。パターン2は自分の行動を変える提案につながるもの、パターン3は時間の流れ（昔と今）があるもの
- 曜日や季節を自然に反映してよい
- topic は20字前後の言い切り（例：「昨日、人の話を聞いて『なるほど』と思った瞬間」）
- hint は話し出しのきっかけになる問いを1文（30字以内）
- 過去に出したお題と同じもの・似たものは出さない`;

function dateContext() {
  const d = new Date();
  const wd = "日月火水木金土"[d.getDay()];
  return `今日は${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${wd}曜日）です。`;
}
const history = () => store.get("history", []);
function pushHistory(topics) { store.set("history", [...history(), ...topics.map((t) => t.topic)].slice(-120)); }

async function generateTopics(onlyPattern) {
  const past = history();
  const others = day.topics.filter((t) => t.pattern !== onlyPattern).map((t) => t.topic);
  const ask = onlyPattern
    ? `パターン${onlyPattern}のお題を1つだけ作ってください。今日の他のお題（${others.join("／") || "なし"}）とも重ならないこと。`
    : "パターン1・2・3のお題を1つずつ、この順で計3つ作ってください。";
  const user = `${dateContext()}\n${ask}\n\n過去に出したお題：\n${past.length ? past.map((t) => "- " + t).join("\n") : "（なし）"}`;
  const out = await askJSON({ system: TOPIC_SYSTEM, user, schema: TOPIC_SCHEMA, effort: "low" });
  return out.topics;
}

async function ensureTopics() {
  if (day.topics.length === 3) return renderHome();
  if (!settings.key) { setTopicStatus("右上の「設定」からAPIキーを入れてください。"); return renderHome(); }
  setTopicStatus("今日のお題を作っています…");
  try {
    const t = await generateTopics();
    day.topics = [1, 2, 3].map((p) => t.find((x) => x.pattern === p) || t[p - 1]).map((x, i) => ({ ...x, pattern: i + 1 }));
    pushHistory(day.topics); saveDay(); setTopicStatus("");
  } catch (e) { setTopicStatus(apiErrorText(e)); }
  renderHome();
}

async function regenerate(pattern, btn) {
  btn.disabled = true; btn.textContent = "作成中…";
  try {
    const [t] = await generateTopics(pattern);
    day.topics[pattern - 1] = { ...t, pattern }; delete day.results[pattern];
    pushHistory([t]); saveDay();
  } catch (e) { setTopicStatus(apiErrorText(e)); }
  renderHome();
}

function setTopicStatus(msg) { $("topic-status").hidden = !msg; $("topic-status").textContent = msg; }

function renderHome() {
  const d = new Date();
  $("today-label").textContent = `${d.getMonth() + 1}月${d.getDate()}日（${"日月火水木金土"[d.getDay()]}）の3題`;
  const list = $("topic-list"); list.replaceChildren();
  for (const pattern of [1, 2, 3]) {
    // お題がまだ無くても、型のカードと説明は出す
    const t = day.topics[pattern - 1] || { pattern, topic: "（お題はAPIキーを設定すると表示されます）", hint: "", empty: true };
    const r = day.results[t.pattern];
    const li = document.createElement("li"); li.className = "topic";
    li.innerHTML = `<div class="pat"><span></span><span class="badge"></span></div><p class="title"></p><p class="hint"></p>
      <div class="row"><button class="primary" data-act="talk">話す</button><button data-act="regen">別のお題</button></div>`;
    li.querySelector(".pat span").textContent = PATTERNS[t.pattern].name;
    const badge = li.querySelector(".badge");
    if (r) { badge.textContent = `${r.score}/3`; badge.classList.add("done"); }
    li.querySelector(".title").textContent = t.topic;
    li.querySelector(".hint").textContent = t.hint;
    li.querySelector(".hint").after(patternGuide(t.pattern, false));
    li.querySelector('[data-act="talk"]').onclick = () => openRecord(t.pattern);
    li.querySelector('[data-act="regen"]').onclick = (ev) => regenerate(t.pattern, ev.currentTarget);
    if (t.empty) {
      li.querySelector(".title").classList.add("placeholder");
      li.querySelector(".hint").hidden = true;
      li.querySelectorAll("button").forEach((b) => (b.disabled = true));
    }
    list.append(li);
  }
  const done = Object.values(day.results);
  $("total-box").hidden = done.length === 0;
  $("total-box").textContent = `今日の合計：${done.reduce((a, r) => a + r.score, 0)} / ${done.length * 3}点（${done.length}/3題）`;
}

// ---------- 録音 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null; // 現在の録音セッション

function openRecord(pattern) {
  const t = day.topics[pattern - 1];
  $("rec-pattern").textContent = PATTERNS[pattern].name;
  $("rec-topic").textContent = t.topic;
  $("rec-guide").replaceChildren(patternGuide(pattern, true));
  $("rec-live").textContent = t.hint;
  // ユーザー操作の中で AudioContext を作っておく（後で自動録音開始するため）
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  rec = { pattern, ctx, phase: "prep", left: PREP_SEC, frames: [], snaps: [], finals: "", interim: "", srErrors: [], srStarts: 0 };
  setPhase("準備", false);
  $("rec-clock").textContent = fmt(PREP_SEC);
  $("btn-rec").textContent = "準備OK、話し始める";
  $("btn-rec").disabled = false;
  show("record");
  rec.prepTimer = setInterval(() => {
    rec.left -= 1; $("rec-clock").textContent = fmt(rec.left);
    if (rec.left <= 0) startRecording();
  }, 1000);
}

function setPhase(text, on) { $("rec-phase").textContent = text; $("rec-phase").classList.toggle("on", on); }
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;

async function startRecording() {
  if (!rec || rec.phase !== "prep") return;
  clearInterval(rec.prepTimer);
  rec.phase = "starting";
  $("btn-rec").disabled = true;
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    setPhase("マイクを使えません", false);
    $("rec-live").textContent = "マイクの使用が許可されていません。Chromeのサイト設定でマイクを許可してから、もう一度開いてください。";
    rec.phase = "error"; return;
  }
  const { ctx } = rec;
  await ctx.resume();
  const src = ctx.createMediaStreamSource(rec.stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  rec.chunks = [];
  try {
    rec.recorder = new MediaRecorder(rec.stream);
    rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.recorder.start();
  } catch { rec.recorder = null; }
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch { /* 画面スリープ防止は任意 */ }

  rec.t0 = performance.now();
  rec.phase = "rec";
  setPhase("録音中", true);
  $("btn-rec").textContent = "話し終えた";
  $("btn-rec").disabled = false;
  $("rec-live").textContent = "";
  rec.meterTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const t = (performance.now() - rec.t0) / 1000;
    rec.frames.push({ t, r: Math.sqrt(s / buf.length) });
    $("rec-clock").textContent = `${fmt(t)} / ${fmt(REC_SEC)}`;
    drawMeter();
    if (t >= REC_SEC) stopRecording();
  }, FRAME_MS);
  startRecognition();
}

function startRecognition() {
  if (!SR) { rec.srErrors.push("このブラウザは音声認識に対応していません"); return; }
  const r = new SR();
  r.lang = "ja-JP"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  r.onresult = (e) => {
    let fin = "", interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
    }
    if (fin) rec.finals += fin;
    rec.interim = interim;
    const text = rec.finals + interim;
    rec.snaps.push({ t: (performance.now() - rec.t0) / 1000, len: text.length });
    $("rec-live").textContent = text;
  };
  r.onerror = (e) => { rec.srErrors.push(e.error); if (e.error === "not-allowed" || e.error === "audio-capture") rec.srBroken = true; };
  r.onend = () => {
    if (rec.interim) rec.finals += rec.interim; // 確定前に切れた分を拾う
    rec.interim = "";
    if (rec.phase === "rec" && !rec.srBroken) { try { r.start(); rec.srStarts++; } catch { /* 再開できなければ諦める */ } }
    else rec.srEnded?.();
  };
  rec.sr = r;
  try { r.start(); rec.srStarts++; } catch (e) { rec.srErrors.push(String(e)); }
}

async function stopRecording() {
  if (!rec || rec.phase !== "rec") return;
  rec.phase = "stopping";
  clearInterval(rec.meterTimer);
  $("btn-rec").disabled = true;
  setPhase("処理中", false);
  // 音声認識の最後の確定を待つ（最大2.5秒）
  if (rec.sr) {
    await new Promise((resolve) => { rec.srEnded = resolve; try { rec.sr.stop(); } catch { resolve(); } setTimeout(resolve, 2500); });
  }
  if (rec.recorder && rec.recorder.state !== "inactive") {
    await new Promise((resolve) => { rec.recorder.onstop = resolve; rec.recorder.stop(); });
  }
  rec.stream.getTracks().forEach((t) => t.stop());
  try { await rec.wake?.release(); } catch { /* 無視 */ }
  rec.ctx.close();
  rec.phase = "done";
  showResult(rec);
}

function cancelRecording() {
  if (rec) {
    clearInterval(rec.prepTimer); clearInterval(rec.meterTimer);
    rec.phase = "cancel";
    try { rec.sr?.abort(); } catch { /* 無視 */ }
    rec.stream?.getTracks().forEach((t) => t.stop());
    try { rec.ctx.close(); } catch { /* 無視 */ }
  }
  rec = null; renderHome(); show("home");
}

function drawMeter() {
  const c = $("rec-meter"), g = c.getContext("2d");
  const W = c.width, H = c.height, n = 120, bw = W / n;
  g.clearRect(0, 0, W, H);
  const fr = rec.frames.slice(-n);
  g.fillStyle = css("--accent");
  fr.forEach((f, i) => { const h = Math.min(H, Math.max(2, f.r * H * 8)); g.fillRect(i * bw, (H - h) / 2, bw - 1, h); });
}

// ---------- 間の分析 ----------
function analyze(frames) {
  if (frames.length < 10) return null;
  const rs = frames.map((f) => f.r).sort((a, b) => a - b);
  const pct = (p) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  const floor = pct(0.1), peak = pct(0.95);
  const thr = Math.max(floor + (peak - floor) * 0.18, floor * 1.8, 0.004);
  const voiced = frames.map((f) => f.r > thr);
  // 150ms未満の短い音（物音）は無音扱いにする
  for (let i = 0; i < voiced.length;) {
    if (!voiced[i]) { i++; continue; }
    let j = i; while (j < voiced.length && voiced[j]) j++;
    if ((j - i) * FRAME_MS < 150) for (let k = i; k < j; k++) voiced[k] = false;
    i = j;
  }
  const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  if (first < 0) return { noVoice: true, thr };
  const pauses = [];
  for (let i = first; i <= last;) {
    if (voiced[i]) { i++; continue; }
    let j = i; while (j <= last && !voiced[j]) j++;
    const s = frames[i].t, e = frames[j].t;
    if (e - s >= PAUSE_MIN) pauses.push({ s, e, d: e - s });
    i = j;
  }
  const span = frames[last].t - frames[first].t;
  const paused = pauses.reduce((a, p) => a + p.d, 0);
  return { thr, voiced, start: frames[first].t, end: frames[last].t, span, net: Math.max(0.1, span - paused), pauses };
}

// 間を文字起こしのどこに入れるか：間の開始時点までに認識されていた文字数で近似する
function placePauses(a, snaps, text) {
  return a.pauses.map((p, i) => {
    let len = 0;
    for (const s of snaps) { if (s.t <= p.s + 0.6) len = s.len; else break; }
    return { ...p, no: i + 1, idx: Math.min(len, text.length), type: null };
  });
}

// ---------- 採点 ----------
const SCORE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["checks", "pauses", "feedback", "improved", "focus_comment"],
  properties: {
    checks: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["item", "result", "comment"],
      properties: {
        item: { type: "string", enum: ["見立てがあるか", "3文以内か", "断言で終わっているか"] },
        result: { type: "string", enum: ["ok", "partial", "ng"] },
        comment: { type: "string" },
      },
    } },
    pauses: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["no", "type"],
      properties: { no: { type: "integer" }, type: { type: "string", enum: ["思考", "効果"] } },
    } },
    feedback: { type: "string" },
    improved: { type: "string" },
    focus_comment: { type: "string" },
  },
};
const SCORE_SYSTEM = `あなたは日本語スピーチの厳しいコーチです。「短く、断言して、自分の見立てを語る力」を伸ばすのが目的です。甘くせず、具体的に指摘してください。

採点項目（各パターン3項目、それぞれ ok / partial / ng）：
1. 見立てがあるか：事実の報告だけでなく、話し手自身の解釈・意見が入っているか
2. 3文以内か：余計な文が増えていないか
3. 断言で終わっているか：見立て文（2文目。ストーリー型は未来の文）が「〜です」「〜と見ています」で言い切れているか。「〜と思います」「〜の可能性を見ています」のような名詞化・ぼかしは partial。理由文の「はず」は減点しない

型ごとの注意：
- コメンテーター型：事実→見立て→理由
- So What型：事実→意味→「だから私は〜すべきだと見ています」という自分ごとの提案。「なぜなら」で終わったら型崩れとして厳しく指摘する
- ストーリー型：過去→現在→未来。未来は断言する

その他：
- 禁止ワード（まあ／なんか／あの／えー／こう）が出ていれば指摘する
- 文字起こしは音声認識の結果なので、明らかな誤変換は話し手の意図を推測して読む（誤変換そのものは減点しない）
- 文字起こし中の［間N 1.4秒］は1秒以上の無音。各間を分類する：
  - 思考：文の途中（助詞・接続助詞の直後、言い直しの前など）で、言葉を探している間
  - 効果：文の切れ目、結論や数字の直前など、聞き手に効かせる間
- feedback：最も直すべき点を2〜3文で。具体的に
- improved：同じ内容で、型どおりに直した3文の改善版
- focus_comment：「今回の重点」が達成できたかを1文で`;

async function scoreTake(take) {
  const t = day.topics[take.pattern - 1];
  const marked = markText(take.text, take.placed, (p) => `［間${p.no} ${p.d.toFixed(1)}秒］`);
  const user = `型：${PATTERNS[take.pattern].name}（${PATTERNS[take.pattern].lines.join(" ")}）
お題：${t.topic}
今回の重点：
${settings.focus || "（なし）"}

発話時間：${take.a ? take.a.span.toFixed(1) : "?"}秒
文字起こし：
${marked}`;
  return askJSON({ system: SCORE_SYSTEM, user, schema: SCORE_SCHEMA, effort: "medium" });
}

function markText(text, placed, label) {
  let out = "", pos = 0;
  for (const p of [...placed].sort((a, b) => a.idx - b.idx)) { out += text.slice(pos, p.idx) + label(p); pos = p.idx; }
  return out + text.slice(pos);
}

// ---------- 結果表示 ----------
let lastTake = null;

function showResult(r) {
  const t = day.topics[r.pattern - 1];
  const text = (r.finals || "").trim();
  const a = analyze(r.frames);
  const take = { pattern: r.pattern, text, a, placed: a && !a.noVoice ? placePauses(a, r.snaps, text) : [], frames: r.frames };
  lastTake = take;
  $("res-pattern").textContent = PATTERNS[r.pattern].name;
  $("res-topic").textContent = t.topic;
  $("res-body").hidden = true; $("res-manual").hidden = true; $("res-drill").hidden = true;
  $("res-loading").hidden = false;
  const audio = $("res-audio");
  if (r.chunks?.length) { audio.src = URL.createObjectURL(new Blob(r.chunks, { type: r.recorder?.mimeType || "audio/webm" })); audio.hidden = false; }
  else audio.hidden = true;
  $("res-diag").textContent = `診断：音声認識 ${SR ? "あり" : "なし"}／開始${r.srStarts}回／エラー ${r.srErrors.length ? [...new Set(r.srErrors)].join(", ") : "なし"}／録音 ${r.chunks?.length ? "あり" : "なし"}`;
  show("result");

  if (a?.noVoice || !a) { $("res-loading").textContent = "声が検出できませんでした。マイクに近づいて、もう一度試してください。"; return; }
  if (!text) { $("res-loading").hidden = true; $("res-manual").hidden = false; $("in-manual").value = ""; return; }
  runScoring(take);
}

async function runScoring(take) {
  renderAnalysis(take, null);
  $("res-body").hidden = false;
  $("res-loading").hidden = false; $("res-loading").textContent = "採点中…";
  hideScore(true);
  try {
    const s = await scoreTake(take);
    for (const p of s.pauses) { const x = take.placed.find((q) => q.no === p.no); if (x) x.type = p.type; }
    const score = s.checks.filter((c) => c.result === "ok").length;
    day.results[take.pattern] = { score, text: take.text, checks: s.checks, improved: s.improved, feedback: s.feedback, stats: stats(take), at: Date.now() };
    saveDay();
    $("res-loading").hidden = true;
    renderAnalysis(take, s);
  } catch (e) {
    $("res-loading").textContent = apiErrorText(e);
  }
}

function hideScore(h) { for (const id of ["res-score", "res-checks", "res-feedback", "res-focus", "res-improved"]) $(id).hidden = h; }

function stats(take) {
  const { a, text, placed } = take;
  const chars = text.replace(/[\s、。，．,.!?！？「」]/g, "").length;
  const perMin = placed.length / Math.max(a.span / 60, 1 / 60);
  const typed = placed.filter((p) => p.type);
  const think = typed.filter((p) => p.type === "思考").length;
  return {
    count: placed.length,
    perMin,
    thinkRatio: typed.length ? think / typed.length : null,
    cpm: chars / (a.net / 60),
    span: a.span,
  };
}

function renderAnalysis(take, s) {
  const st = stats(take);
  const dl = $("res-stats"); dl.replaceChildren();
  const add = (dt, dd, note) => {
    const d = document.createElement("div");
    d.innerHTML = `<dt></dt><dd></dd>`;
    d.querySelector("dt").textContent = dt;
    d.querySelector("dd").textContent = dd;
    if (note) { const sm = document.createElement("small"); sm.textContent = " " + note; d.querySelector("dd").append(sm); }
    dl.append(d);
  };
  add("1秒以上の間", `${st.count}回`, `${st.perMin.toFixed(1)}回/分（目標3以下）`);
  add("思考の間の割合", st.thinkRatio == null ? (s ? "—" : "判定中") : `${Math.round(st.thinkRatio * 100)}%`, "目標30%未満");
  add("発話速度", `${Math.round(st.cpm)}字/分`, "目安250〜350");
  add("発話時間", `${st.span.toFixed(1)}秒`);

  // 文字起こし（間の印つき）
  const tr = $("res-transcript"); tr.replaceChildren();
  let pos = 0;
  for (const p of [...take.placed].sort((a, b) => a.idx - b.idx)) {
    tr.append(take.text.slice(pos, p.idx));
    const sp = document.createElement("span");
    sp.className = "pause " + (p.type === "思考" ? "think" : p.type === "効果" ? "effect" : "unknown");
    sp.textContent = `${p.type ?? "間"} ${p.d.toFixed(1)}s`;
    tr.append(sp); pos = p.idx;
  }
  tr.append(take.text.slice(pos));
  drawTimeline(take);

  if (!s) return;
  hideScore(false);
  const score = s.checks.filter((c) => c.result === "ok").length;
  $("res-score").textContent = `${score}/3`;
  const ul = $("res-checks"); ul.replaceChildren();
  const markOf = { ok: "✓", partial: "△", ng: "✗" };
  for (const c of s.checks) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="mark"></span><span><b></b><small></small></span>`;
    li.querySelector(".mark").textContent = markOf[c.result];
    li.querySelector(".mark").classList.add(c.result);
    li.querySelector("b").textContent = c.item;
    li.querySelector("small").textContent = c.comment;
    ul.append(li);
  }
  $("res-feedback").textContent = s.feedback;
  $("res-focus").textContent = "重点：" + s.focus_comment;
  $("res-improved").textContent = s.improved;
  $("res-drill").hidden = !(st.thinkRatio != null && st.thinkRatio > 0.3);
}

function drawTimeline(take) {
  const c = $("res-timeline"), g = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = (c.width = Math.round(c.clientWidth * dpr)), H = (c.height = Math.round(c.clientHeight * dpr));
  g.clearRect(0, 0, W, H);
  const fr = take.frames; if (!fr.length) return;
  const T = fr[fr.length - 1].t || 1, x = (t) => (t / T) * W;
  const peak = Math.max(...fr.map((f) => f.r), 0.01);
  const top = 18 * dpr, h = H - top - 6 * dpr;
  // 間の帯
  g.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
  g.textBaseline = "top";
  for (const p of take.placed) {
    const col = p.type === "思考" ? css("--think") : p.type === "効果" ? css("--effect") : css("--muted");
    g.globalAlpha = 0.18; g.fillStyle = col; g.fillRect(x(p.s), top, x(p.e) - x(p.s), h);
    g.globalAlpha = 1; g.fillText(`${p.d.toFixed(1)}s`, Math.min(x(p.s), W - 34 * dpr), 3 * dpr);
  }
  // 波形
  g.fillStyle = css("--voice");
  const bw = Math.max(1, W / fr.length);
  for (const f of fr) { const bh = Math.max(1 * dpr, (f.r / peak) * h); g.fillRect(x(f.t), top + (h - bh) / 2, bw, bh); }
}

// ---------- イベント ----------
$("btn-rec").onclick = () => { if (!rec) return; if (rec.phase === "prep") startRecording(); else if (rec.phase === "rec") stopRecording(); };
$("btn-rec-cancel").onclick = cancelRecording;
$("btn-back").onclick = () => { renderHome(); show("home"); };
$("btn-retry").onclick = () => lastTake && openRecord(lastTake.pattern);
$("btn-manual").onclick = () => {
  const v = $("in-manual").value.trim(); if (!v || !lastTake) return;
  lastTake.text = v; lastTake.placed = []; $("res-manual").hidden = true; runScoring(lastTake);
};
$("btn-settings").onclick = () => {
  $("in-key").value = settings.key; $("in-model").value = settings.model; $("in-focus").value = settings.focus;
  show("settings");
};
$("btn-close-settings").onclick = () => show("home");
$("btn-save-settings").onclick = () => {
  settings = { key: $("in-key").value.trim(), model: $("in-model").value, focus: $("in-focus").value.trim() };
  store.set("settings", settings);
  show("home"); ensureTopics();
};

renderHome();
ensureTopics();
