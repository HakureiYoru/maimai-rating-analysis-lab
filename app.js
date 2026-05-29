const $ = (id) => document.getElementById(id);
const DATASET_SNAPSHOT_KEY = "mmfc-rating-analysis-lab-snapshot-v1";
const DEMO_MODE = true;
const DEMO_CONTROL_DEFAULTS = {
  modelSelect: "affine",
  minWorkRatings: 8,
  minRaterRatings: 8,
  shrinkN: 12,
  maxIterations: 60,
  tolerance: 0.01,
  biasThreshold: 80,
  scoreMin: 100,
  scoreMax: 1000,
  excludeReplies: true,
  useWorksTable: true,
  excludeSelfComments: true,
  excludeDqRatings: false,
  useRegistrationsTable: true,
  useHighWeight: true,
  highWeightMultiplier: 2,
  clampScores: true,
};

const initialUrlParams = new URLSearchParams(window.location.search);
const initialDetailType = ["work", "rater"].includes(initialUrlParams.get("detail"))
  ? initialUrlParams.get("detail")
  : null;

const state = {
  commentRows: [],
  workRows: [],
  registrationRows: [],
  csvTexts: {
    comments: "",
    works: "",
    registrations: "",
  },
  metadata: {
    worksById: new Map(),
    registrationsByOwner: new Map(),
  },
  detailType: initialDetailType,
  detailId: initialUrlParams.get("id") || "",
  useStoredSnapshot: initialUrlParams.get("snapshot") === "local",
  demoAnonymizer: createDemoAnonymizer(),
  workSort: {
    key: "calibratedRank",
    direction: "asc",
  },
  result: null,
  datasetName: "尚未加载数据",
};

const controls = [
  "modelSelect",
  "minWorkRatings",
  "minRaterRatings",
  "shrinkN",
  "maxIterations",
  "tolerance",
  "biasThreshold",
  "scoreMin",
  "scoreMax",
  "excludeReplies",
  "useWorksTable",
  "excludeSelfComments",
  "excludeDqRatings",
  "useRegistrationsTable",
  "useHighWeight",
  "highWeightMultiplier",
  "clampScores",
];

const defaultHeader = {
  title: "MMFC 评分校准展示版",
  lead: "使用已脱敏的数据展示评分者尺度校准、抽样稳定性、排名变化和异常评分者诊断。此工具独立于 Wix 项目运行。",
};

function readControlValue(id) {
  const el = $(id);
  if (!el) return DEMO_CONTROL_DEFAULTS[id];
  return el.type === "checkbox" ? el.checked : el.value;
}

function readBooleanControl(id) {
  const value = readControlValue(id);
  return value === true || value === "true" || value === "1";
}

function isDetailMode() {
  return state.detailType === "work" || state.detailType === "rater";
}

function controlSnapshot() {
  const values = {};
  controls.forEach((id) => {
    const el = $(id);
    if (!el) return;
    values[id] = el.type === "checkbox" ? el.checked : el.value;
  });
  return values;
}

function applyControlSnapshot(values = {}) {
  controls.forEach((id) => {
    const el = $(id);
    if (!el || !(id in values)) return;
    if (el.type === "checkbox") {
      el.checked = Boolean(values[id]);
    } else {
      el.value = values[id];
    }
  });
}

function persistDatasetSnapshot() {
  try {
    localStorage.setItem(DATASET_SNAPSHOT_KEY, JSON.stringify({
      csvTexts: state.csvTexts,
      datasetName: state.datasetName,
      controls: controlSnapshot(),
      savedAt: new Date().toISOString(),
    }));
  } catch (error) {
    console.warn("无法保存详情窗口数据快照", error);
  }
}

function loadStoredDatasetSnapshot() {
  try {
    const raw = localStorage.getItem(DATASET_SNAPSHOT_KEY);
    if (!raw) return false;
    const snapshot = JSON.parse(raw);
    const csvTexts = snapshot?.csvTexts || {};
    if (!csvTexts.comments) return false;

    applyControlSnapshot(snapshot.controls || {});
    resetDemoAnonymizer();
    state.commentRows = sanitizeRowsForDemo("comments", parseCsv(csvTexts.comments || ""));
    state.workRows = sanitizeRowsForDemo("works", csvTexts.works ? parseCsv(csvTexts.works) : []);
    state.registrationRows = sanitizeRowsForDemo("registrations", csvTexts.registrations ? parseCsv(csvTexts.registrations) : []);
    state.csvTexts = {
      comments: serializeCsvRows(state.commentRows),
      works: serializeCsvRows(state.workRows),
      registrations: serializeCsvRows(state.registrationRows),
    };
    rebuildMetadata();
    state.datasetName = snapshot.datasetName || "本地缓存数据集";
    $("datasetName").textContent = `${state.datasetName}（详情窗口快照）`;
    rerun();
    return true;
  } catch (error) {
    console.warn("无法读取详情窗口数据快照", error);
    return false;
  }
}

function detailUrl(type, id) {
  const url = new URL(window.location.href);
  url.searchParams.set("detail", type);
  url.searchParams.set("id", id);
  url.searchParams.set("snapshot", "local");
  return url.toString();
}

function detailAnchor(type, id, label, title = "") {
  const dataAttr = type === "work" ? "data-work" : "data-rater";
  return `<a class="link-button" href="${escapeHtml(detailUrl(type, id))}" target="_blank" rel="noopener" data-detail-type="${escapeHtml(type)}" ${dataAttr}="${escapeHtml(id)}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
}

function wireDetailLinks(root = document) {
  root.querySelectorAll("[data-detail-type]").forEach((link) => {
    link.addEventListener("click", () => persistDatasetSnapshot());
  });
}

function updateDetailHistory(type, id) {
  if (!isDetailMode() || !id) return;
  state.detailType = type;
  state.detailId = id;
  const url = new URL(window.location.href);
  url.searchParams.set("detail", type);
  url.searchParams.set("id", id);
  url.searchParams.set("snapshot", "local");
  window.history.replaceState({}, "", url.toString());
}

function setHeaderText(title, lead) {
  const h1 = document.querySelector("h1");
  const leadEl = document.querySelector(".lead");
  if (h1) h1.textContent = title;
  if (leadEl) leadEl.textContent = lead;
  document.title = title;
}

function applyPageMode() {
  const detail = isDetailMode();
  document.body.classList.toggle("detail-mode", detail);
  document.body.classList.toggle("overview-mode", !detail);

  const targetPanelId = state.detailType === "work" ? "workDetailPanel" : "raterDetailPanel";
  document.querySelectorAll("main > section").forEach((section) => {
    if (detail) {
      section.hidden = !(section.classList.contains("status-panel") || section.id === targetPanelId);
    } else {
      section.hidden = section.id === "workDetailPanel" || section.id === "raterDetailPanel";
    }
  });

  if (!detail) {
    setHeaderText(defaultHeader.title, defaultHeader.lead);
    return;
  }

  if (state.detailType === "work") {
    setHeaderText("单作品评分明细", "当前窗口只显示一个作品的评分构成、校准变化和评分者来源。");
  } else {
    setHeaderText("单评分者详情", "当前窗口只显示一个评分者的给分习惯、校准参数和评论明细。");
  }
}

function getConfig() {
  const min = Number(readControlValue("scoreMin") || 100);
  const max = Number(readControlValue("scoreMax") || 1000);
  return {
    model: readControlValue("modelSelect") || "affine",
    minWorkRatings: Math.max(1, Number(readControlValue("minWorkRatings") || 8)),
    minRaterRatings: Math.max(2, Number(readControlValue("minRaterRatings") || 8)),
    shrinkN: Math.max(1, Number(readControlValue("shrinkN") || 12)),
    maxIterations: Math.max(1, Number(readControlValue("maxIterations") || 60)),
    tolerance: Math.max(0.0001, Number(readControlValue("tolerance") || 0.01)),
    biasThreshold: Math.max(1, Number(readControlValue("biasThreshold") || 80)),
    scoreMin: Math.min(min, max),
    scoreMax: Math.max(min, max),
    excludeReplies: readBooleanControl("excludeReplies"),
    useWorksTable: readBooleanControl("useWorksTable"),
    excludeSelfComments: readBooleanControl("excludeSelfComments"),
    excludeDqRatings: readBooleanControl("excludeDqRatings"),
    useRegistrationsTable: readBooleanControl("useRegistrationsTable"),
    useHighWeight: readBooleanControl("useHighWeight"),
    highWeightMultiplier: Math.max(1, Number(readControlValue("highWeightMultiplier") || 2)),
    clampScores: readBooleanControl("clampScores"),
    slopeMin: 0.55,
    slopeMax: 1.55,
  };
}

function fmt(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return Number(value).toFixed(digits);
}

function fmtInt(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("zh-CN");
}

function signedFmt(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${fmt(value, digits)}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortId(id) {
  const s = String(id || "");
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

function setStatus(message, kind = "") {
  $("statusText").textContent = message;
  $("statusText").className = kind;
}

function setBadges(items) {
  $("dataBadges").innerHTML = items
    .map((item) => `<span class="badge">${escapeHtml(item)}</span>`)
    .join("");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      value += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(value);
      value = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(value);
      value = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      i += ch === "\r" && next === "\n" ? 2 : 1;
      continue;
    }
    value += ch;
    i += 1;
  }

  row.push(value);
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = cells[index] ?? "";
    });
    return obj;
  });
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

function serializeCsvRows(rows) {
  if (!rows.length) return "";
  const headers = [];
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function demoNumber(value, width = 4) {
  return String(value).padStart(width, "0");
}

function createDemoAnonymizer() {
  return {
    userAliases: new Map(),
    userCounter: 0,
    rowAliases: {
      comments: new Map(),
      works: new Map(),
      registrations: new Map(),
      replyRefs: new Map(),
    },
    counters: {
      comments: 0,
      works: 0,
      registrations: 0,
      replyRefs: 0,
    },
  };
}

function demoUserAlias(rawValue, anonymizer) {
  const key = String(rawValue ?? "").trim();
  if (!key) return null;
  const existingDemoId = key.match(/^user-(\d{4,})$/i);
  if (existingDemoId) {
    const number = existingDemoId[1];
    anonymizer.userCounter = Math.max(anonymizer.userCounter, Number(number) || 0);
    return { ownerId: `user-${number}`, displayName: `用户${number}`, designerName: `匿名作者${number}` };
  }
  if (!anonymizer.userAliases.has(key)) {
    anonymizer.userCounter += 1;
    const number = demoNumber(anonymizer.userCounter);
    anonymizer.userAliases.set(key, {
      ownerId: `user-${number}`,
      displayName: `用户${number}`,
      designerName: `匿名作者${number}`,
    });
  }
  return anonymizer.userAliases.get(key);
}

function demoRowAlias(type, rawValue, index, anonymizer) {
  const key = String(rawValue ?? "").trim() || `__row_${index}`;
  if (!anonymizer.rowAliases[type].has(key)) {
    anonymizer.counters[type] += 1;
    const width = type === "comments" ? 6 : 4;
    const prefix = type === "comments" ? "comment" : type === "works" ? "work-row" : "registration";
    anonymizer.rowAliases[type].set(key, `${prefix}-${demoNumber(anonymizer.counters[type], width)}`);
  }
  return anonymizer.rowAliases[type].get(key);
}

function demoReplyAlias(rawValue, anonymizer) {
  const key = String(rawValue ?? "").trim();
  if (!key) return "";
  if (anonymizer.rowAliases.comments.has(key)) return anonymizer.rowAliases.comments.get(key);
  if (!anonymizer.rowAliases.replyRefs.has(key)) {
    anonymizer.counters.replyRefs += 1;
    anonymizer.rowAliases.replyRefs.set(key, `comment-ref-${demoNumber(anonymizer.counters.replyRefs, 6)}`);
  }
  return anonymizer.rowAliases.replyRefs.get(key);
}

function hidePrivateLinks(value) {
  return String(value ?? "")
    .replace(/<img\b[^>]*>/gi, "[图片已隐藏]")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "[图片已隐藏]")
    .replace(/\[[^\]]+]\(https?:\/\/[^)]+\)/gi, "[链接已隐藏]")
    .replace(/https?:\/\/[^\s<>"')]+/gi, "[链接已隐藏]");
}

function anonymizeOwnerFields(row, anonymizer) {
  const ownerAlias = demoUserAlias(firstNonEmpty(row, ["Owner", "_owner", "owner"]), anonymizer);
  ["Owner", "_owner", "owner"].forEach((key) => {
    if (key in row) row[key] = ownerAlias?.ownerId || "";
  });
  return ownerAlias;
}

function sanitizeCommentRows(rows, anonymizer) {
  rows.forEach((row, index) => {
    if ("ID" in row || "_id" in row) demoRowAlias("comments", firstNonEmpty(row, ["ID", "_id"]), index, anonymizer);
  });
  return rows.map((source, index) => {
    const row = { ...source };
    anonymizeOwnerFields(row, anonymizer);
    const rowId = demoRowAlias("comments", firstNonEmpty(row, ["ID", "_id"]), index, anonymizer);
    if ("ID" in row) row.ID = rowId;
    if ("_id" in row) row._id = rowId;
    if ("replyTo" in row) row.replyTo = demoReplyAlias(row.replyTo, anonymizer);
    if ("comment" in row) row.comment = hidePrivateLinks(row.comment);
    return row;
  });
}

function sanitizeWorkRows(rows, anonymizer) {
  return rows.map((source, index) => {
    const row = { ...source };
    const ownerAlias = anonymizeOwnerFields(row, anonymizer);
    const rowId = demoRowAlias("works", firstNonEmpty(row, ["ID", "_id"]), index, anonymizer);
    if ("ID" in row) row.ID = rowId;
    if ("_id" in row) row._id = rowId;
    if ("不要在designer栏位填写自己的真实ID！/ Do not put your real ID in the designer field ！" in row) {
      row["不要在designer栏位填写自己的真实ID！/ Do not put your real ID in the designer field ！"] = ownerAlias?.designerName || "";
    }
    if ("Your account's Bilibili/Twitter/Youtube" in row) row["Your account's Bilibili/Twitter/Youtube"] = "";
    return row;
  });
}

function shouldKeepRegistrationField(key) {
  return [
    "您的ID",
    "registrationName",
    "firstName",
    "isHighQuality",
    "Qualified",
    "Q",
    "ID",
    "_id",
    "Created Date",
    "Updated Date",
    "提交時間",
    "Owner",
    "_owner",
    "owner",
  ].includes(key);
}

function sanitizeRegistrationRows(rows, anonymizer) {
  return rows.map((source, index) => {
    const row = { ...source };
    let ownerAlias = anonymizeOwnerFields(row, anonymizer);
    if (!ownerAlias) {
      ownerAlias = demoUserAlias(firstNonEmpty(row, ["您的ID", "registrationName", "firstName", "ID"]), anonymizer);
    }
    ["您的ID", "registrationName", "firstName"].forEach((key) => {
      if (key in row) row[key] = ownerAlias?.displayName || "";
    });
    const rowId = demoRowAlias("registrations", firstNonEmpty(row, ["ID", "_id"]), index, anonymizer);
    if ("ID" in row) row.ID = rowId;
    if ("_id" in row) row._id = rowId;
    Object.keys(row).forEach((key) => {
      if (!shouldKeepRegistrationField(key)) row[key] = "";
    });
    return row;
  });
}

function sanitizeRowsForDemo(type, rows, anonymizer = state.demoAnonymizer) {
  if (!DEMO_MODE) return rows;
  if (type === "comments") return sanitizeCommentRows(rows, anonymizer);
  if (type === "works") return sanitizeWorkRows(rows, anonymizer);
  if (type === "registrations") return sanitizeRegistrationRows(rows, anonymizer);
  return rows;
}

function resetDemoAnonymizer() {
  state.demoAnonymizer = createDemoAnonymizer();
}

function firstNonEmpty(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function isTruthyValue(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "是", "高", "qualified", "q"].includes(v);
}

function normalizeMediaValue(value) {
  if (!value) return "";
  if (typeof value === "object") {
    const candidates = [value.url, value.src, value.fileUrl];
    for (const candidate of candidates) {
      const normalized = normalizeMediaValue(candidate);
      if (normalized) return normalized;
    }
    return "";
  }
  return typeof value === "string" ? value.trim() : "";
}

function getStaticWixImageBaseUrl(imageRef) {
  const rawValue = normalizeMediaValue(imageRef);
  if (!rawValue) return "";

  if (rawValue.startsWith("wix:image://")) {
    const match = rawValue.match(/^wix:image:\/\/v1\/([^/#]+)(?:\/[^#]*)?(?:#.*)?$/);
    return match ? `https://static.wixstatic.com/media/${match[1]}` : "";
  }

  if (rawValue.startsWith("wix:video://")) {
    const posterMatch = rawValue.match(/[?&#]posterUri=([^&#]+)/i);
    return posterMatch ? `https://static.wixstatic.com/media/${decodeURIComponent(posterMatch[1])}` : "";
  }

  if (rawValue.startsWith("https://static.wixstatic.com/media/")) {
    return rawValue.replace(/\/v1\/(fit|fill|crop)\/.*$/i, "");
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }

  return "";
}

function buildWixThumbnailUrl(imageRef, width = 72, height = 72) {
  const baseUrl = getStaticWixImageBaseUrl(imageRef);
  if (!baseUrl) return "";

  if (baseUrl.startsWith("https://static.wixstatic.com/media/")) {
    return `${baseUrl}/v1/fill/w_${width},h_${height}/file.webp`;
  }

  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}w=${width}&h=${height}&fit=fill`;
}

function pickWorkCover(row) {
  const candidateKeys = [
    "coverImage",
    "cover",
    "thumbnail",
    "封面",
    "track的複本",
    "bg的複本",
    "bg",
    "BG",
    "Video /BGA      (optional)",
  ];

  for (const key of candidateKeys) {
    const thumbUrl = buildWixThumbnailUrl(row[key]);
    if (thumbUrl) return thumbUrl;
  }

  return "";
}

function rebuildMetadata() {
  const worksById = new Map();
  state.workRows.forEach((row) => {
    const sequenceId = firstNonEmpty(row, ["sequenceId", "workNumber", "作品ID", "编号"]);
    if (!sequenceId) return;
    worksById.set(sequenceId, {
      workId: sequenceId,
      ownerId: firstNonEmpty(row, ["Owner", "_owner", "owner"]),
      title: firstNonEmpty(row, ["作品Title/曲名", "firstName", "Title", "作品Title/曲名的複本"]) || `#${sequenceId}`,
      isDQ: isTruthyValue(firstNonEmpty(row, ["isDQ", "isDq", "已淘汰"])),
      coverThumbUrl: pickWorkCover(row),
      raw: row,
    });
  });

  const registrationsByOwner = new Map();
  state.registrationRows.forEach((row) => {
    const ownerId = firstNonEmpty(row, ["Owner", "_owner", "owner"]);
    if (!ownerId) return;
    registrationsByOwner.set(ownerId, {
      ownerId,
      displayName: firstNonEmpty(row, ["您的ID", "registrationName", "firstName", "ID"]) || shortId(ownerId),
      profile: firstNonEmpty(row, ["你的MMFC官网主页链接（右上角PROFILE网址）", "你的MMFC官网链接（请在右上角账号主页PROFILE查看）"]),
      isHighQuality: isTruthyValue(firstNonEmpty(row, ["isHighQuality", "Qualified", "Q"])),
      raw: row,
    });
  });

  state.metadata = { worksById, registrationsByOwner };
}

async function fetchCsvIfExists(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) return null;
  return response.text();
}

async function loadBundledCsv() {
  setStatus("正在读取 data 目录中的展示 CSV ...");
  const [commentsText, worksText, registrationsText] = await Promise.all([
    fetchCsvIfExists("./data/comments.csv"),
    fetchCsvIfExists("./data/work-submissions.csv"),
    fetchCsvIfExists("./data/competition-registrations.csv"),
  ]);

  if (!commentsText) throw new Error("无法读取 data/comments.csv");
  resetDemoAnonymizer();
  state.commentRows = sanitizeRowsForDemo("comments", parseCsv(commentsText));
  state.workRows = sanitizeRowsForDemo("works", worksText ? parseCsv(worksText) : []);
  state.registrationRows = sanitizeRowsForDemo("registrations", registrationsText ? parseCsv(registrationsText) : []);
  state.csvTexts = {
    comments: serializeCsvRows(state.commentRows),
    works: serializeCsvRows(state.workRows),
    registrations: serializeCsvRows(state.registrationRows),
  };
  rebuildMetadata();
  state.datasetName = `comments.csv + ${state.workRows.length ? "work-submissions.csv" : "无作品表"} + ${state.registrationRows.length ? "competition-registrations.csv" : "无报名表"}`;
  $("datasetName").textContent = state.datasetName;
  rerun();
}

function normalizeRows(rows, config, metadata) {
  const ratings = [];
  const skipped = {
    replies: 0,
    invalidScore: 0,
    missingOwner: 0,
    missingWork: 0,
    selfComments: 0,
    dqWorks: 0,
    unknownWorks: 0,
  };

  rows.forEach((row, index) => {
    const replyTo = String(row.replyTo ?? "").trim();
    if (config.excludeReplies && replyTo) {
      skipped.replies += 1;
      return;
    }

    const score = Number(row.score);
    if (!Number.isFinite(score) || score < config.scoreMin || score > config.scoreMax) {
      skipped.invalidScore += 1;
      return;
    }

    const raterId = firstNonEmpty(row, ["Owner", "_owner", "owner"]);
    if (!raterId) {
      skipped.missingOwner += 1;
      return;
    }

    const workId = firstNonEmpty(row, ["workNumber", "sequenceId"]);
    if (!workId) {
      skipped.missingWork += 1;
      return;
    }

    const workMeta = metadata.worksById.get(workId);
    if (config.useWorksTable && !workMeta) skipped.unknownWorks += 1;

    if (config.useWorksTable && config.excludeDqRatings && workMeta?.isDQ) {
      skipped.dqWorks += 1;
      return;
    }

    if (config.useWorksTable && config.excludeSelfComments && workMeta?.ownerId && workMeta.ownerId === raterId) {
      skipped.selfComments += 1;
      return;
    }

    const raterMeta = metadata.registrationsByOwner.get(raterId);
    const isHighQuality = config.useRegistrationsTable && raterMeta?.isHighQuality === true;
    const weight = config.useHighWeight && isHighQuality ? config.highWeightMultiplier : 1;

    ratings.push({
      id: String(row.ID || row._id || index),
      workId,
      workTitle: workMeta?.title || `#${workId}`,
      workOwnerId: workMeta?.ownerId || "",
      workCoverThumbUrl: workMeta?.coverThumbUrl || "",
      isDQ: workMeta?.isDQ === true,
      raterId,
      raterName: raterMeta?.displayName || shortId(raterId),
      isHighQuality,
      weight,
      score,
      createdDate: row["Created Date"] || row._createdDate || "",
      comment: row.comment || "",
      replyTo,
      sourceIndex: index,
    });
  });

  return { ratings, skipped };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function weightedMean(rows, valueFn) {
  if (!rows.length) return 0;
  const totalWeight = rows.reduce((sum, row) => sum + (row.weight || 1), 0);
  if (totalWeight <= 0) return mean(rows.map(valueFn));
  return rows.reduce((sum, row) => sum + valueFn(row) * (row.weight || 1), 0) / totalWeight;
}

function groupBy(list, keyFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compareWorkId(a, b) {
  const aNumber = Number(a.workId);
  const bNumber = Number(b.workId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return String(a.workId).localeCompare(String(b.workId), "zh");
}

function rankItems(items, scoreKey) {
  const ranked = items
    .filter((item) => Number.isFinite(item[scoreKey]))
    .sort((a, b) => b[scoreKey] - a[scoreKey] || compareWorkId(a, b));
  const map = new Map();
  ranked.forEach((item, index) => map.set(item.workId, index + 1));
  return map;
}

function buildBaseStats(ratings, config) {
  const byWork = groupBy(ratings, (r) => r.workId);
  const byRater = groupBy(ratings, (r) => r.raterId);
  const rawGlobalMean = weightedMean(ratings, (r) => r.score);

  const workStats = [...byWork.entries()].map(([workId, rows]) => {
    const scores = rows.map((r) => r.score);
    const highWeightCount = rows.filter((r) => r.isHighQuality).length;
    return {
      workId,
      title: rows[0]?.workTitle || `#${workId}`,
      isDQ: rows[0]?.isDQ === true,
      coverThumbUrl: rows[0]?.workCoverThumbUrl || "",
      count: rows.length,
      highWeightCount,
      lowWeightCount: rows.length - highWeightCount,
      rawMean: weightedMean(rows, (r) => r.score),
      rawSimpleMean: mean(scores),
      rawMedian: median(scores),
      rawStd: stdev(scores),
      rawCi95: rows.length > 1 ? 1.96 * stdev(scores) / Math.sqrt(rows.length) : null,
      totalWeight: rows.reduce((sum, row) => sum + row.weight, 0),
      rows,
    };
  });

  const rawRankMap = rankItems(workStats, "rawMean");
  workStats.forEach((work) => {
    work.rawRank = rawRankMap.get(work.workId) || null;
  });

  return { byWork, byRater, workStats, rawGlobalMean };
}

function fitRater(rows, qByWork, config) {
  const n = rows.length;
  if (n < config.minRaterRatings) {
    return { a: 1, b: 0, rawA: 1, rawB: 0, lambda: 0, eligible: false, reason: "评分次数不足" };
  }

  const xs = [];
  const ys = [];
  rows.forEach((r) => {
    const q = qByWork.get(r.workId);
    if (Number.isFinite(q)) {
      xs.push(r.score);
      ys.push(q);
    }
  });

  if (xs.length < config.minRaterRatings) {
    return { a: 1, b: 0, rawA: 1, rawB: 0, lambda: 0, eligible: false, reason: "有效重叠不足" };
  }

  const mx = mean(xs);
  const my = mean(ys);
  const varX = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  let rawA = 1;
  let rawB = my - mx;

  if (config.model === "affine" && varX > 1e-9) {
    const cov = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
    rawA = clamp(cov / varX, config.slopeMin, config.slopeMax);
    rawB = my - rawA * mx;
  }

  if (config.model === "bias") {
    rawA = 1;
    rawB = mean(ys.map((y, i) => y - xs[i]));
  }

  const lambda = n / (n + config.shrinkN);
  return {
    a: 1 + lambda * (rawA - 1),
    b: lambda * rawB,
    rawA,
    rawB,
    lambda,
    eligible: true,
    reason: "参与校准",
  };
}

function runCalibration(ratings, config) {
  const base = buildBaseStats(ratings, config);
  let qByWork = new Map(base.workStats.map((work) => [work.workId, work.rawMean]));
  let params = new Map();
  const history = [];

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    params = new Map();
    for (const [raterId, rows] of base.byRater.entries()) {
      params.set(raterId, fitRater(rows, qByWork, config));
    }

    const nextByWork = new Map();
    for (const [workId, rows] of base.byWork.entries()) {
      const proxyRows = rows.map((r) => {
        const p = params.get(r.raterId) || { a: 1, b: 0 };
        const value = p.a * r.score + p.b;
        return {
          ...r,
          normalized: config.clampScores ? clamp(value, config.scoreMin, config.scoreMax) : value,
        };
      });
      nextByWork.set(workId, weightedMean(proxyRows, (r) => r.normalized));
    }

    const recenterRows = [];
    for (const [workId, rows] of base.byWork.entries()) {
      const q = nextByWork.get(workId);
      rows.forEach((row) => recenterRows.push({ weight: row.weight, q }));
    }
    const weightedQMean = weightedMean(recenterRows, (r) => r.q);
    const recenter = base.rawGlobalMean - weightedQMean;
    for (const [workId, q] of nextByWork.entries()) {
      nextByWork.set(workId, config.clampScores ? clamp(q + recenter, config.scoreMin, config.scoreMax) : q + recenter);
    }

    let maxDelta = 0;
    for (const [workId, next] of nextByWork.entries()) {
      const previous = qByWork.get(workId) ?? next;
      maxDelta = Math.max(maxDelta, Math.abs(next - previous));
    }

    history.push({ iteration: iteration + 1, maxDelta });
    qByWork = nextByWork;
    if (maxDelta < config.tolerance) break;
  }

  const normalizedByRating = new Map();
  ratings.forEach((r) => {
    const p = params.get(r.raterId) || { a: 1, b: 0 };
    const value = p.a * r.score + p.b;
    normalizedByRating.set(r.id, config.clampScores ? clamp(value, config.scoreMin, config.scoreMax) : value);
  });

  const workStats = base.workStats.map((work) => {
    const normalizedRows = work.rows.map((r) => ({
      ...r,
      normalized: normalizedByRating.get(r.id) ?? r.score,
    }));
    const normalizedValues = normalizedRows.map((r) => r.normalized);
    return {
      ...work,
      calibratedMean: qByWork.get(work.workId) ?? weightedMean(normalizedRows, (r) => r.normalized),
      calibratedMedian: median(normalizedValues),
      calibratedStd: stdev(normalizedValues),
      calibratedCi95: normalizedValues.length > 1 ? 1.96 * stdev(normalizedValues) / Math.sqrt(normalizedValues.length) : null,
      scoreDelta: (qByWork.get(work.workId) ?? weightedMean(normalizedRows, (r) => r.normalized)) - work.rawMean,
    };
  });

  const calibratedRankMap = rankItems(workStats, "calibratedMean");
  workStats.forEach((work) => {
    work.calibratedRank = calibratedRankMap.get(work.workId) || null;
    work.rankChange = work.rawRank && work.calibratedRank ? work.rawRank - work.calibratedRank : null;
  });

  const otherMeanByRating = new Map();
  base.workStats.forEach((work) => {
    work.rows.forEach((r) => {
      const remainingWeight = work.totalWeight - r.weight;
      if (remainingWeight > 0) {
        otherMeanByRating.set(r.id, (work.rawMean * work.totalWeight - r.score * r.weight) / remainingWeight);
      }
    });
  });

  const raterStats = [...base.byRater.entries()].map(([raterId, rows]) => {
    const scores = rows.map((r) => r.score);
    const deltas = rows
      .map((r) => {
        const other = otherMeanByRating.get(r.id);
        return Number.isFinite(other) ? r.score - other : null;
      })
      .filter((v) => v != null);
    const p = params.get(raterId) || { a: 1, b: 0, lambda: 0, eligible: false, reason: "未校准" };
    const correction600 = p.a * 600 + p.b - 600;
    const correction800 = p.a * 800 + p.b - 800;
    const normalizedDeltaMean = mean(rows.map((r) => (normalizedByRating.get(r.id) ?? r.score) - r.score));
    const highSeen = rows.some((r) => r.isHighQuality);
    return {
      raterId,
      raterName: rows[0]?.raterName || shortId(raterId),
      isHighQuality: highSeen,
      count: rows.length,
      rawMean: mean(scores),
      rawMedian: median(scores),
      rawStd: stdev(scores),
      avgLeaveOneOutDelta: deltas.length ? mean(deltas) : null,
      a: p.a,
      b: p.b,
      rawA: p.rawA,
      rawB: p.rawB,
      lambda: p.lambda,
      eligible: p.eligible,
      calibrationIterations: p.eligible ? history.length : 0,
      reason: p.reason,
      correction600,
      correction800,
      normalizedDeltaMean,
    };
  });

  return {
    config,
    ratings,
    skipped: {},
    base,
    workStats,
    raterStats,
    history,
    normalizedByRating,
    rawGlobalMean: base.rawGlobalMean,
  };
}

function analyzeRows(rows, config) {
  const normalized = normalizeRows(rows, config, state.metadata);
  const result = runCalibration(normalized.ratings, config);
  result.skipped = normalized.skipped;
  return result;
}

function rerun() {
  if (!state.commentRows.length) {
    setStatus("请先加载已脱敏评论表 comments.csv。");
    return;
  }
  const config = getConfig();
  setStatus("正在计算...");
  try {
    state.result = analyzeRows(state.commentRows, config);
    renderAll();
    setStatus(`已完成：${state.result.history.length} 轮迭代，最大变化 ${fmt(state.result.history.at(-1)?.maxDelta, 4)}。`);
  } catch (error) {
    console.error(error);
    setStatus(`计算失败：${error.message}`, "negative");
  }
}

function renderAll() {
  const result = state.result;
  if (!result) return;
  applyPageMode();
  renderBadges(result);
  if (isDetailMode()) {
    if (state.detailType === "work") {
      renderWorkDetailOptions(result);
      if (state.detailId && [...$("workDetailSelect").options].some((option) => option.value === state.detailId)) {
        $("workDetailSelect").value = state.detailId;
      }
      state.detailId = $("workDetailSelect").value || state.detailId;
      renderWorkDetail(result);
    } else {
      renderRaterDetailOptions(result);
      if (state.detailId && [...$("raterDetailSelect").options].some((option) => option.value === state.detailId)) {
        $("raterDetailSelect").value = state.detailId;
      }
      state.detailId = $("raterDetailSelect").value || state.detailId;
      renderRaterDetail(result);
    }
    return;
  }
  renderMetrics(result);
  renderCharts(result);
  renderWarnings(result);
  renderWorkTable(result);
  renderRaterTable(result);
}

function renderBadges(result) {
  const works = new Set(result.ratings.map((r) => r.workId)).size;
  const raters = new Set(result.ratings.map((r) => r.raterId)).size;
  const qRaters = result.raterStats.filter((r) => r.isHighQuality).length;
  setBadges([
    `${fmtInt(state.commentRows.length)} 行评论表`,
    `${fmtInt(state.workRows.length)} 行作品表`,
    `${fmtInt(state.registrationRows.length)} 行报名表`,
    `${fmtInt(result.ratings.length)} 条有效正式评分`,
    `${fmtInt(works)} 个作品`,
    `${fmtInt(raters)} 个评分者`,
    `${fmtInt(qRaters)} 个 Q 评分者`,
    `排除回复 ${fmtInt(result.skipped.replies)}`,
    `排除自评 ${fmtInt(result.skipped.selfComments)}`,
    `排除淘汰 ${fmtInt(result.skipped.dqWorks)}`,
  ]);
}

function renderMetrics(result) {
  const works = result.workStats;
  const raters = result.raterStats;
  const rankedWorks = works.filter((w) => w.rawRank != null && w.calibratedRank != null);
  const stableRankedWorks = rankedWorks.filter((w) => w.count >= result.config.minWorkRatings);
  const density = works.length && raters.length ? result.ratings.length / (works.length * raters.length) : 0;
  const highRiskRaters = raters.filter((r) => r.count >= result.config.minRaterRatings && Math.abs(r.correction600) >= result.config.biasThreshold).length;
  const changedWorks = stableRankedWorks.filter((w) => w.rankChange != null && Math.abs(w.rankChange) >= 10).length;

  const cards = [
    ["有效正式评分", fmtInt(result.ratings.length), `评论表原始行 ${fmtInt(state.commentRows.length)}`],
    ["作品数", fmtInt(works.length), `已写排名 ${fmtInt(rankedWorks.length)}`],
    ["评分者数", fmtInt(raters.length), `参与校准 ${fmtInt(raters.filter((r) => r.eligible).length)}`],
    ["Qualified 评分者", fmtInt(raters.filter((r) => r.isHighQuality).length), `权重 x${result.config.useHighWeight ? result.config.highWeightMultiplier : 1}`],
    ["评分矩阵密度", `${(density * 100).toFixed(2)}%`, "越低越依赖校准与任务覆盖"],
    ["全体加权均分", fmt(result.rawGlobalMean, 2), `中位数 ${fmt(median(result.ratings.map((r) => r.score)), 1)}`],
    ["平均每作品评分", fmt(mean(works.map((w) => w.count)), 2), `最低 ${works.length ? Math.min(...works.map((w) => w.count)) : 0}`],
    ["平均每人评分", fmt(mean(raters.map((r) => r.count)), 2), `最高 ${raters.length ? Math.max(...raters.map((r) => r.count)) : 0}`],
    ["高风险评分者", fmtInt(highRiskRaters), `阈值 ${result.config.biasThreshold} 分`],
    ["排名大幅变化", fmtInt(changedWorks), `评分数 >= ${result.config.minWorkRatings} 的作品中`],
    ["迭代轮数", fmtInt(result.history.length), `收敛 ${fmt(result.history.at(-1)?.maxDelta, 4)}`],
  ];

  $("metricGrid").innerHTML = cards.map(([label, value, sub]) => `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-sub">${escapeHtml(sub)}</div>
    </div>
  `).join("");
}

function histogram(values, bins) {
  return bins.map((bin) => ({
    label: bin.label,
    count: values.filter((v) => v >= bin.min && v <= bin.max).length,
    min: bin.min,
    max: bin.max,
  }));
}

function renderCharts(result) {
  const scoreBins = [];
  for (let start = result.config.scoreMin; start < result.config.scoreMax; start += 100) {
    scoreBins.push({
      min: start,
      max: Math.min(result.config.scoreMax, start + 99),
      label: `${start}-${Math.min(result.config.scoreMax, start + 99)}`,
    });
  }
  renderBarChart("scoreHistogram", histogram(result.ratings.map((r) => r.score), scoreBins), { valueKey: "count", color: "#58c4c7" });

  const workCounts = result.workStats.map((w) => w.count);
  renderBarChart("workCoverageChart", bucketCounts(workCounts, [1, 4, 7, 10, 13, 16, 20, 30, 999], ["1-3", "4-6", "7-9", "10-12", "13-15", "16-19", "20-29", "30+"]), { valueKey: "count", color: "#f1c75b" });

  const raterCounts = result.raterStats.map((r) => r.count);
  renderBarChart("raterCoverageChart", bucketCounts(raterCounts, [1, 2, 5, 8, 12, 20, 35, 60, 999], ["1", "2-4", "5-7", "8-11", "12-19", "20-34", "35-59", "60+"]), { valueKey: "count", color: "#6dd28c" });

  renderRawVsCal("rawVsCalChart", result);
  renderRankChanges("rankChangeChart", result);
  renderRaterBiasScatter("raterBiasChart", result);
}

function bucketCounts(values, edges, labels) {
  return labels.map((label, i) => {
    const min = edges[i];
    const max = edges[i + 1] - 1;
    return { label, count: values.filter((value) => value >= min && value <= max).length };
  });
}

function chartSize(elementId) {
  const el = $(elementId);
  const rect = el.getBoundingClientRect();
  return { width: Math.max(420, Math.round(rect.width || 640)), height: Math.max(240, Math.round(rect.height || 280)) };
}

function gridLines(maxV, pad, plotW, plotH) {
  let out = "";
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + plotH - (plotH / 4) * i;
    const value = Math.round((maxV / 4) * i);
    out += `<line class="grid" x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" opacity="0.45"></line>`;
    out += `<text class="axis-text" x="${pad.left - 8}" y="${y + 4}" text-anchor="end">${value}</text>`;
  }
  return out;
}

function renderBarChart(elementId, data, options = {}) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 18, right: 18, bottom: 54, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxV = Math.max(1, ...data.map((d) => d[options.valueKey || "count"]));
  const slot = plotW / data.length;
  const barW = Math.max(8, slot * 0.62);
  const color = options.color || "#58c4c7";

  const bars = data.map((d, i) => {
    const value = d[options.valueKey || "count"];
    const h = (value / maxV) * plotH;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const y = pad.top + plotH - h;
    const cx = pad.left + i * slot + slot / 2;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(2, h)}" rx="4" fill="${color}">
        <title>${escapeHtml(d.label)}: ${value}</title>
      </rect>
      <text class="chart-label" x="${cx}" y="${Math.max(12, y - 6)}" text-anchor="middle">${value}</text>
      <text class="axis-text" x="${cx}" y="${height - 18}" text-anchor="middle" transform="rotate(-35 ${cx} ${height - 18})">${escapeHtml(d.label)}</text>
    `;
  }).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${gridLines(maxV, pad, plotW, plotH)}
      <line class="axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"></line>
      ${bars}
    </svg>
  `;
}

function renderRaterScoreHistogram(elementId, rows, config) {
  const bins = [];
  for (let start = config.scoreMin; start < config.scoreMax; start += 100) {
    bins.push({
      min: start,
      max: Math.min(config.scoreMax, start + 99),
      label: `${start}-${Math.min(config.scoreMax, start + 99)}`,
    });
  }
  renderBarChart(elementId, histogram(rows.map((row) => row.score), bins), { valueKey: "count", color: "#f1c75b" });
}

function renderRaterAgreementChart(elementId, rows, config) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 20, right: 24, bottom: 44, left: 52 };
  const min = config.scoreMin;
  const max = config.scoreMax;
  const sx = (v) => pad.left + ((v - min) / (max - min)) * (width - pad.left - pad.right);
  const sy = (v) => height - pad.bottom - ((v - min) / (max - min)) * (height - pad.top - pad.bottom);
  const usableRows = rows.filter((row) => row.workRawMean != null);
  const points = usableRows.map((row) => {
    const delta = row.deltaFromOthers ?? (row.score - row.workRawMean);
    const color = delta >= 0 ? "#6dd28c" : "#ff6b6b";
    return `
      <circle cx="${sx(row.score)}" cy="${sy(row.workRawMean)}" r="${row.isHighQuality ? 5 : 3.8}" fill="${color}" opacity="0.78">
        <title>#${escapeHtml(row.workId)} ${escapeHtml(row.workTitle)}: 给分 ${fmt(row.score, 0)}, 作品均分 ${fmt(row.workRawMean)}, 相对其他人 ${delta > 0 ? "+" : ""}${fmt(delta)}</title>
      </circle>
    `;
  }).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line x1="${sx(min)}" y1="${sy(min)}" x2="${sx(max)}" y2="${sy(max)}" stroke="#f1c75b" stroke-dasharray="5 6" opacity="0.85"></line>
      ${points}
      <text class="axis-text" x="${width / 2}" y="${height - 10}" text-anchor="middle">该评分者给分</text>
      <text class="axis-text" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">作品原始均分</text>
    </svg>
  `;
}

function renderWorkScoreHistogram(elementId, rows, config) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 34, right: 18, bottom: 54, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const bins = [];
  for (let start = config.scoreMin; start < config.scoreMax; start += 100) {
    const max = Math.min(config.scoreMax, start + 99);
    bins.push({
      min: start,
      max,
      label: `${start}-${max}`,
      raw: rows.filter((row) => row.score >= start && row.score <= max).length,
      calibrated: rows.filter((row) => row.normalized >= start && row.normalized <= max).length,
    });
  }
  const maxV = Math.max(1, ...bins.flatMap((bin) => [bin.raw, bin.calibrated]));
  const slot = plotW / Math.max(1, bins.length);
  const barW = Math.max(6, slot * 0.28);
  const bars = bins.map((bin, i) => {
    const cx = pad.left + i * slot + slot / 2;
    const rawH = (bin.raw / maxV) * plotH;
    const calH = (bin.calibrated / maxV) * plotH;
    const rawX = cx - barW - 2;
    const calX = cx + 2;
    const rawY = pad.top + plotH - rawH;
    const calY = pad.top + plotH - calH;
    return `
      <rect x="${rawX}" y="${rawY}" width="${barW}" height="${Math.max(2, rawH)}" rx="3" fill="#f1c75b">
        <title>${escapeHtml(bin.label)} 原始 ${bin.raw} 条</title>
      </rect>
      <rect x="${calX}" y="${calY}" width="${barW}" height="${Math.max(2, calH)}" rx="3" fill="#58c4c7">
        <title>${escapeHtml(bin.label)} 校准 ${bin.calibrated} 条</title>
      </rect>
      <text class="axis-text" x="${cx}" y="${height - 18}" text-anchor="middle" transform="rotate(-35 ${cx} ${height - 18})">${escapeHtml(bin.label)}</text>
    `;
  }).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${gridLines(maxV, pad, plotW, plotH)}
      <line class="axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"></line>
      <rect x="${pad.left}" y="12" width="10" height="10" rx="2" fill="#f1c75b"></rect>
      <text class="axis-text" x="${pad.left + 16}" y="21">原始</text>
      <rect x="${pad.left + 58}" y="12" width="10" height="10" rx="2" fill="#58c4c7"></rect>
      <text class="axis-text" x="${pad.left + 74}" y="21">校准</text>
      ${bars}
    </svg>
  `;
}

function renderWorkScoreScatter(elementId, rows, config) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 22, right: 24, bottom: 44, left: 52 };
  const values = rows.flatMap((row) => [row.score, row.normalized]).filter((value) => Number.isFinite(value));
  const min = Math.min(config.scoreMin, ...values);
  const max = Math.max(config.scoreMax, ...values);
  const range = Math.max(1, max - min);
  const sx = (value) => pad.left + ((value - min) / range) * (width - pad.left - pad.right);
  const sy = (value) => height - pad.bottom - ((value - min) / range) * (height - pad.top - pad.bottom);
  const points = rows.map((row) => {
    const correction = row.normalized - row.score;
    const color = row.isHighQuality ? "#f1c75b" : correction >= 0 ? "#6dd28c" : "#ff6b6b";
    return `
      <circle cx="${sx(row.score)}" cy="${sy(row.normalized)}" r="${row.isHighQuality ? 5 : 4}" fill="${color}" opacity="0.82">
        <title>${escapeHtml(row.raterName)}: 原始 ${fmt(row.score, 0)} -> 校准 ${fmt(row.normalized)}, 修正 ${signedFmt(correction, 1)}</title>
      </circle>
    `;
  }).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line x1="${sx(min)}" y1="${sy(min)}" x2="${sx(max)}" y2="${sy(max)}" stroke="#f1c75b" stroke-dasharray="5 6" opacity="0.85"></line>
      ${points}
      <text class="axis-text" x="${width / 2}" y="${height - 10}" text-anchor="middle">原始分</text>
      <text class="axis-text" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">校准分</text>
    </svg>
  `;
}

function compactChartLabel(value, fallback = "-") {
  const text = String(value || fallback).trim() || fallback;
  return text.length > 8 ? `${text.slice(0, 8)}...` : text;
}

function renderWorkCalibrationChart(elementId, rows) {
  const data = [...rows]
    .sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta))
    .slice(0, 24)
    .map((row) => ({
      label: compactChartLabel(row.raterName, shortId(row.raterId)),
      value: row.scoreDelta,
      raterName: row.raterName,
      raw: row.score,
      normalized: row.normalized,
    }));
  renderDivergingBars(elementId, data, {
    digits: 1,
    titleText: (row) => `${row.raterName}: ${fmt(row.raw, 0)} -> ${fmt(row.normalized)}, 修正 ${signedFmt(row.value, 1)}`,
  });
}

function renderWorkDeviationChart(elementId, rows, work) {
  const data = [...rows]
    .map((row) => ({
      ...row,
      deviation: row.normalized - work.calibratedMean,
    }))
    .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
    .slice(0, 24)
    .map((row) => ({
      label: compactChartLabel(row.raterName, shortId(row.raterId)),
      value: row.deviation,
      raterName: row.raterName,
      normalized: row.normalized,
      mean: work.calibratedMean,
    }));
  renderDivergingBars(elementId, data, {
    digits: 1,
    titleText: (row) => `${row.raterName}: 校准分 ${fmt(row.normalized)}, 相对作品均值 ${signedFmt(row.value, 1)}`,
  });
}

function renderRawVsCal(elementId, result) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 20, right: 24, bottom: 44, left: 52 };
  const min = result.config.scoreMin;
  const max = result.config.scoreMax;
  const sx = (v) => pad.left + ((v - min) / (max - min)) * (width - pad.left - pad.right);
  const sy = (v) => height - pad.bottom - ((v - min) / (max - min)) * (height - pad.top - pad.bottom);
  const points = result.workStats.map((w) => `
    <circle cx="${sx(w.rawMean)}" cy="${sy(w.calibratedMean)}" r="${Math.min(7, 2 + Math.sqrt(w.count))}" fill="${w.count >= result.config.minWorkRatings ? "#58c4c7" : "#6c7786"}" opacity="0.72">
      <title>#${escapeHtml(w.workId)} raw ${fmt(w.rawMean)} -> calibrated ${fmt(w.calibratedMean)} (${w.count} ratings)</title>
    </circle>
  `).join("");
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line x1="${sx(min)}" y1="${sy(min)}" x2="${sx(max)}" y2="${sy(max)}" stroke="#f1c75b" stroke-dasharray="5 6" opacity="0.85"></line>
      ${points}
      <text class="axis-text" x="${width / 2}" y="${height - 10}" text-anchor="middle">原始加权均分</text>
      <text class="axis-text" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">校准后分数</text>
    </svg>
  `;
}

function renderRankChanges(elementId, result) {
  const data = result.workStats
    .filter((w) => w.rankChange != null)
    .sort((a, b) => Math.abs(b.rankChange) - Math.abs(a.rankChange))
    .slice(0, 18)
    .map((w) => ({ label: `#${w.workId}`, value: w.rankChange, count: w.count }));
  renderDivergingBars(elementId, data);
}

function renderDivergingBars(elementId, data, options = {}) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 18, right: 24, bottom: 30, left: 70 };
  const plotW = width - pad.left - pad.right;
  const rowH = (height - pad.top - pad.bottom) / Math.max(1, data.length);
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const mid = pad.left + plotW / 2;
  const digits = options.digits ?? 0;
  const valueText = options.valueText || ((d) => signedFmt(d.value, digits));
  const titleText = options.titleText || ((d) => `${d.label} rank change ${d.value > 0 ? "+" : ""}${d.value}, ${d.count} ratings`);
  const rows = data.map((d, i) => {
    const y = pad.top + i * rowH + rowH * 0.2;
    const w = (Math.abs(d.value) / maxAbs) * (plotW / 2);
    const x = d.value >= 0 ? mid : mid - w;
    const color = d.value >= 0 ? "#6dd28c" : "#ff6b6b";
    return `
      <text class="axis-text" x="${pad.left - 8}" y="${y + rowH * 0.45}" text-anchor="end">${escapeHtml(d.label)}</text>
      <rect x="${x}" y="${y}" width="${w}" height="${Math.max(5, rowH * 0.58)}" rx="4" fill="${color}" opacity="0.82">
        <title>${escapeHtml(titleText(d))}</title>
      </rect>
      <text class="chart-label" x="${d.value >= 0 ? x + w + 5 : x - 5}" y="${y + rowH * 0.45}" text-anchor="${d.value >= 0 ? "start" : "end"}">${escapeHtml(valueText(d))}</text>
    `;
  }).join("");
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="axis" x1="${mid}" y1="${pad.top}" x2="${mid}" y2="${height - pad.bottom}"></line>
      ${rows}
    </svg>
  `;
}

function renderRaterBiasScatter(elementId, result) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 20, right: 24, bottom: 42, left: 54 };
  const maxCount = Math.max(1, ...result.raterStats.map((r) => r.count));
  const maxAbs = Math.max(10, ...result.raterStats.map((r) => Math.abs(r.correction600)));
  const sx = (v) => pad.left + (Math.log10(v + 1) / Math.log10(maxCount + 1)) * (width - pad.left - pad.right);
  const sy = (v) => height - pad.bottom - ((v + maxAbs) / (maxAbs * 2)) * (height - pad.top - pad.bottom);
  const zeroY = sy(0);
  const points = result.raterStats.map((r) => {
    const risk = Math.abs(r.correction600) >= result.config.biasThreshold && r.count >= result.config.minRaterRatings;
    return `
      <circle cx="${sx(r.count)}" cy="${sy(r.correction600)}" r="${risk ? 5 : 3.4}" fill="${risk ? "#ff6b6b" : r.isHighQuality ? "#f1c75b" : r.eligible ? "#58c4c7" : "#6c7786"}" opacity="0.78">
        <title>${escapeHtml(r.raterName)} count ${r.count}, correction@600 ${fmt(r.correction600)}</title>
      </circle>
    `;
  }).join("");
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line x1="${pad.left}" y1="${zeroY}" x2="${width - pad.right}" y2="${zeroY}" stroke="#f1c75b" stroke-dasharray="5 6"></line>
      ${points}
      <text class="axis-text" x="${width / 2}" y="${height - 10}" text-anchor="middle">评分次数（对数刻度）</text>
      <text class="axis-text" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">600分处修正</text>
    </svg>
  `;
}

function renderLineChart(elementId, data) {
  const el = $(elementId);
  const { width, height } = chartSize(elementId);
  const pad = { top: 20, right: 24, bottom: 40, left: 58 };
  const maxX = Math.max(1, ...data.map((d) => d.x));
  const maxY = Math.max(1, ...data.map((d) => d.y));
  const sx = (v) => pad.left + (v / maxX) * (width - pad.left - pad.right);
  const sy = (v) => height - pad.bottom - (v / maxY) * (height - pad.top - pad.bottom);
  const points = data.map((d) => `${sx(d.x)},${sy(d.y)}`).join(" ");
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${gridLines(maxY, pad, width - pad.left - pad.right, height - pad.top - pad.bottom)}
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <polyline points="${points}" fill="none" stroke="#58c4c7" stroke-width="3"></polyline>
      ${data.map((d) => `<circle cx="${sx(d.x)}" cy="${sy(d.y)}" r="3" fill="#f1c75b"><title>iteration ${d.x}: ${fmt(d.y, 4)}</title></circle>`).join("")}
      <text class="axis-text" x="${width / 2}" y="${height - 10}" text-anchor="middle">迭代轮数</text>
    </svg>
  `;
}

function renderWarnings(result) {
  const raterWarnings = new Map();
  const workWarnings = [];
  const addRaterWarning = (r, metric, tone) => {
    if (!raterWarnings.has(r.raterId)) {
      raterWarnings.set(r.raterId, {
        targetHtml: detailAnchor("rater", r.raterId, r.raterName, "在新窗口打开评分者详情"),
        sub: shortId(r.raterId),
        metrics: [],
        tone,
      });
    }
    const warning = raterWarnings.get(r.raterId);
    warning.metrics.push({ text: metric, tone });
    if (tone === "warn") warning.tone = tone;
  };

  result.raterStats
    .filter((r) => r.count >= result.config.minRaterRatings)
    .forEach((r) => {
      if (Math.abs(r.correction600) >= result.config.biasThreshold) {
        addRaterWarning(r, `600分修正 ${signedFmt(r.correction600, 1)}`, r.correction600 >= 0 ? "positive" : "negative");
      }
      if (result.config.model === "affine" && (r.a < 0.75 || r.a > 1.25)) {
        addRaterWarning(r, `斜率 a=${fmt(r.a, 3)}`, "warn");
      }
    });

  result.workStats
    .filter((w) => w.count >= result.config.minWorkRatings && w.calibratedCi95 != null)
    .sort((a, b) => b.calibratedCi95 - a.calibratedCi95)
    .slice(0, 8)
    .forEach((w) => {
      if (w.calibratedCi95 >= 70 || Math.abs(w.rankChange || 0) >= 15) {
        workWarnings.push({
          targetHtml: `<a class="warning-work-link" href="${escapeHtml(detailUrl("work", w.workId))}" target="_blank" rel="noopener" data-detail-type="work" data-work="${escapeHtml(w.workId)}" title="${escapeHtml(`#${w.workId} ${w.title}`)}">${renderWorkThumb(w)}</a>`,
          sub: `#${w.workId}`,
          metric: `CI ±${fmt(w.calibratedCi95, 1)} / 排名 ${w.rankChange == null ? "-" : signedFmt(w.rankChange, 0)}`,
          tone: "warn",
        });
      }
    });

  const grid = $("warningsGrid");
  const raterRows = [...raterWarnings.values()];
  grid.innerHTML = raterRows.length || workWarnings.length
    ? `
      <div class="warning-column">
        <div class="warning-column-title">用户风险</div>
        <div class="warning-rater-list">
          ${raterRows.length ? raterRows.map((r) => `
            <article class="warning-card warning-card-rater">
              <div class="warning-rater-line">
                <span class="warning-target">${r.targetHtml}</span>
                <span class="warning-arrow">→</span>
                <span class="warning-sub">${escapeHtml(r.sub)}</span>
                <span class="warning-arrow">→</span>
                <span class="warning-metric-list">
                  ${r.metrics.map((m) => `<span class="warning-metric ${escapeHtml(m.tone)}">${escapeHtml(m.text)}</span>`).join("")}
                </span>
              </div>
            </article>
          `).join("") : `<div class="muted">暂无用户风险。</div>`}
        </div>
      </div>
      <div class="warning-column">
        <div class="warning-column-title">作品风险</div>
        <div class="warning-work-grid">
          ${workWarnings.length ? workWarnings.map((w) => `
            <article class="warning-card warning-card-work">
              <div class="warning-metric ${escapeHtml(w.tone)}">${escapeHtml(w.metric)}</div>
              <div class="warning-target">${w.targetHtml}</div>
              <div class="warning-sub">${escapeHtml(w.sub)}</div>
            </article>
          `).join("") : `<div class="muted">暂无作品风险。</div>`}
        </div>
      </div>
    `
    : `<div class="muted">当前参数下未发现明显风险项。</div>`;
  wireDetailLinks(grid);
}

function renderWorkTable(result) {
  const query = $("workSearch").value.trim().toLowerCase();
  const rows = result.workStats
    .filter((w) => !query || String(w.workId).toLowerCase().includes(query) || String(w.title).toLowerCase().includes(query))
    .sort(compareWorks)
    .slice(0, 260);

  $("worksTable").innerHTML = rows.map((w) => `
    <tr>
      <td>${renderWorkThumb(w)}</td>
      <td>${detailAnchor("work", w.workId, `#${w.workId}`, "在新窗口打开作品明细")}</td>
      <td>${escapeHtml(w.title)} ${w.isDQ ? '<span class="tag">DQ</span>' : ''}</td>
      <td>${w.count}</td>
      <td>${w.highWeightCount}/${w.lowWeightCount}</td>
      <td class="score-pair-from">${fmt(w.rawMean)}</td>
      <td class="score-pair-to"><strong>${fmt(w.calibratedMean)}</strong></td>
      <td class="${w.scoreDelta >= 0 ? "positive" : "negative"}">${w.scoreDelta >= 0 ? "+" : ""}${fmt(w.scoreDelta)}</td>
      <td>${w.rawRank ?? "-"}</td>
      <td>${w.calibratedRank ?? "-"}</td>
      <td class="${(w.rankChange || 0) >= 0 ? "positive" : "negative"}">${w.rankChange == null ? "-" : `${w.rankChange > 0 ? "+" : ""}${w.rankChange}`}</td>
      <td>${fmt(w.calibratedStd)}</td>
      <td>${w.calibratedCi95 == null ? "-" : `±${fmt(w.calibratedCi95)}`}</td>
    </tr>
  `).join("");

  wireDetailLinks($("worksTable"));

  updateWorkSortHeaders();
}

function renderWorkThumb(work) {
  const label = `#${work.workId}`;
  if (!work.coverThumbUrl) {
    return `<div class="work-thumb placeholder" title="未找到封面">${escapeHtml(label)}</div>`;
  }

  return `
    <div class="work-thumb" title="${escapeHtml(work.title || label)}">
      <img src="${escapeHtml(work.coverThumbUrl)}" alt="${escapeHtml(work.title || label)}" decoding="async" referrerpolicy="no-referrer"
        onerror="this.parentElement.classList.add('placeholder'); this.parentElement.textContent='${escapeHtml(label)}';">
    </div>
  `;
}

function workSortValue(work, key) {
  if (key === "workId") return Number(work.workId) || String(work.workId);
  if (key === "title") return String(work.title || "");
  if (key === "rankChange") return work.rankChange == null ? null : work.rankChange;
  return work[key] ?? null;
}

function compareNullable(a, b, direction, nullsLast = true) {
  const aNull = a == null || (typeof a === "number" && Number.isNaN(a));
  const bNull = b == null || (typeof b === "number" && Number.isNaN(b));
  if (aNull && bNull) return 0;
  if (aNull) return nullsLast ? 1 : -1;
  if (bNull) return nullsLast ? -1 : 1;

  let result = 0;
  if (typeof a === "string" || typeof b === "string") {
    result = String(a).localeCompare(String(b), "zh");
  } else {
    result = a - b;
  }
  return direction === "asc" ? result : -result;
}

function compareWorks(a, b) {
  const { key, direction } = state.workSort;
  const primary = compareNullable(workSortValue(a, key), workSortValue(b, key), direction);
  if (primary !== 0) return primary;

  const rankFallback = compareNullable(a.calibratedRank, b.calibratedRank, "asc");
  if (rankFallback !== 0) return rankFallback;
  return compareNullable(workSortValue(a, "workId"), workSortValue(b, "workId"), "asc");
}

function updateWorkSortHeaders() {
  document.querySelectorAll("[data-work-sort]").forEach((button) => {
    button.classList.toggle("sorted-asc", button.dataset.workSort === state.workSort.key && state.workSort.direction === "asc");
    button.classList.toggle("sorted-desc", button.dataset.workSort === state.workSort.key && state.workSort.direction === "desc");
  });
}

function setWorkSort(key) {
  const defaultDirections = {
    workId: "asc",
    title: "asc",
    count: "desc",
    highWeightCount: "desc",
    rawMean: "desc",
    calibratedMean: "desc",
    scoreDelta: "desc",
    rawRank: "asc",
    calibratedRank: "asc",
    rankChange: "desc",
    calibratedStd: "desc",
    calibratedCi95: "desc",
  };

  if (state.workSort.key === key) {
    state.workSort.direction = state.workSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.workSort.key = key;
    state.workSort.direction = defaultDirections[key] || "asc";
  }

  if (state.result) renderWorkTable(state.result);
}

function raterStatus(r, config) {
  if (!r.eligible) return `<span class="tag">${escapeHtml(r.reason)}</span>`;
  if (Math.abs(r.correction600) >= config.biasThreshold) return `<span class="tag warn">偏差较大</span>`;
  return `<span class="tag good">稳定</span>`;
}

function renderRaterTable(result) {
  const query = $("raterSearch").value.trim().toLowerCase();
  const rows = result.raterStats
    .filter((r) => !query || r.raterId.toLowerCase().includes(query) || r.raterName.toLowerCase().includes(query))
    .sort((a, b) => Math.abs(b.correction600) - Math.abs(a.correction600) || b.count - a.count)
    .slice(0, 260);

  $("ratersTable").innerHTML = rows.map((r) => `
    <tr>
      <td title="${escapeHtml(r.raterId)}">${detailAnchor("rater", r.raterId, shortId(r.raterId), "在新窗口打开评分者详情")}</td>
      <td>${escapeHtml(r.raterName)}</td>
      <td>${r.isHighQuality ? '<span class="tag warn">Q</span>' : '<span class="tag">普通</span>'}</td>
      <td>${r.count}</td>
      <td>${fmt(r.rawMean)}</td>
      <td class="${(r.avgLeaveOneOutDelta || 0) >= 0 ? "positive" : "negative"}">${r.avgLeaveOneOutDelta == null ? "-" : `${r.avgLeaveOneOutDelta > 0 ? "+" : ""}${fmt(r.avgLeaveOneOutDelta)}`}</td>
      <td>${fmt(r.a, 3)}</td>
      <td>${fmt(r.b, 2)}</td>
      <td class="${r.correction600 >= 0 ? "positive" : "negative"}">${r.correction600 >= 0 ? "+" : ""}${fmt(r.correction600)}</td>
      <td class="${r.correction800 >= 0 ? "positive" : "negative"}">${r.correction800 >= 0 ? "+" : ""}${fmt(r.correction800)}</td>
      <td>${fmt(r.rawStd)}</td>
      <td>${r.calibrationIterations ? `${r.calibrationIterations}轮` : "0轮"}</td>
      <td>${raterStatus(r, result.config)}</td>
    </tr>
  `).join("");

  wireDetailLinks($("ratersTable"));
}

function renderRaterDetailOptions(result) {
  const select = $("raterDetailSelect");
  const current = select.value;
  const options = [...result.raterStats]
    .sort((a, b) => Math.abs(b.correction600) - Math.abs(a.correction600) || b.count - a.count)
    .map((r) => {
      const correction = `${r.correction600 >= 0 ? "+" : ""}${fmt(r.correction600, 1)}`;
      return `<option value="${escapeHtml(r.raterId)}">${escapeHtml(r.raterName)} (${r.count}评, 600修正 ${correction})</option>`;
    })
    .join("");
  select.innerHTML = options;
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function getRaterDetailRows(result, raterId) {
  const workMap = new Map(result.workStats.map((w) => [w.workId, w]));
  return result.ratings
    .filter((r) => r.raterId === raterId)
    .map((rating) => {
      const work = workMap.get(rating.workId);
      const normalized = result.normalizedByRating.get(rating.id) ?? rating.score;
      let otherMean = null;
      if (work && work.totalWeight - rating.weight > 0) {
        otherMean = (work.rawMean * work.totalWeight - rating.score * rating.weight) / (work.totalWeight - rating.weight);
      }
      return {
        ...rating,
        normalized,
        scoreDelta: normalized - rating.score,
        workRawMean: work?.rawMean ?? null,
        workCalibratedMean: work?.calibratedMean ?? null,
        workCalibratedRank: work?.calibratedRank ?? null,
        otherMean,
        deltaFromOthers: otherMean == null ? null : rating.score - otherMean,
        workCount: work?.count ?? 0,
        workIsDQ: work?.isDQ === true,
      };
    });
}

function renderRaterDetail(result) {
  const selected = $("raterDetailSelect").value || result.raterStats[0]?.raterId;
  const rater = result.raterStats.find((r) => r.raterId === selected);
  if (!rater) {
    $("raterProfile").innerHTML = "";
    $("raterDetailTable").innerHTML = `<tr><td colspan="9" class="muted">请选择评分者。</td></tr>`;
    $("raterScoreHistogram").innerHTML = "";
    $("raterAgreementChart").innerHTML = "";
    $("raterCorrectionChart").innerHTML = "";
    return;
  }

  const rows = getRaterDetailRows(result, rater.raterId)
    .sort((a, b) => Math.abs(b.deltaFromOthers ?? 0) - Math.abs(a.deltaFromOthers ?? 0));

  const profileCards = [
    ["评分者", `${rater.raterName}`, shortId(rater.raterId)],
    ["身份", rater.isHighQuality ? "Qualified" : "普通", rater.isHighQuality ? "评分权重更高" : "普通权重"],
    ["评分次数", fmtInt(rater.count), `参与校准：${rater.eligible ? "是" : "否"}`],
    ["校准轮数", rater.calibrationIterations ? `${rater.calibrationIterations}轮` : "0轮", `全局收敛 ${result.history.length} 轮`],
    ["原始均分", fmt(rater.rawMean), `标准差 ${fmt(rater.rawStd)}`],
    ["均值偏移", rater.avgLeaveOneOutDelta == null ? "-" : `${rater.avgLeaveOneOutDelta > 0 ? "+" : ""}${fmt(rater.avgLeaveOneOutDelta)}`, "相对作品其他评分者"],
    ["a / b", `${fmt(rater.a, 3)} / ${fmt(rater.b, 1)}`, "校准公式 x' = a*x + b"],
    ["600分修正", `${rater.correction600 >= 0 ? "+" : ""}${fmt(rater.correction600)}`, rater.correction600 >= 0 ? "偏严方向，分数会被抬高" : "偏松方向，分数会被压低"],
    ["800分修正", `${rater.correction800 >= 0 ? "+" : ""}${fmt(rater.correction800)}`, "高分段的修正幅度"],
  ];

  $("raterProfile").innerHTML = profileCards.map(([label, value, sub]) => `
    <div class="profile-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="metric-sub">${escapeHtml(sub)}</div>
    </div>
  `).join("");

  renderRaterScoreHistogram("raterScoreHistogram", rows, result.config);
  renderRaterAgreementChart("raterAgreementChart", rows, result.config);
  renderDivergingBars("raterCorrectionChart", rows
    .sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta))
    .slice(0, 22)
    .map((row) => ({
      label: `#${row.workId}`,
      value: row.scoreDelta,
      count: row.workCount,
    })), {
      digits: 1,
      titleText: (row) => `${row.label} 评分校准变化 ${signedFmt(row.value, 1)}, 作品评分数 ${row.count}`,
    });

  $("raterDetailTable").innerHTML = rows.map((row) => `
    <tr>
      <td>${detailAnchor("work", row.workId, `#${row.workId}`, "在新窗口打开作品明细")}${row.workIsDQ ? ' <span class="tag">DQ</span>' : ''}</td>
      <td>${escapeHtml(row.workTitle)}</td>
      <td class="score-pair-from">${fmt(row.score, 0)}</td>
      <td class="score-pair-to"><strong>${fmt(row.normalized)}</strong></td>
      <td class="${row.scoreDelta >= 0 ? "positive" : "negative"}">${row.scoreDelta >= 0 ? "+" : ""}${fmt(row.scoreDelta)}</td>
      <td>${row.workRawMean == null ? "-" : fmt(row.workRawMean)}</td>
      <td class="${(row.deltaFromOthers || 0) >= 0 ? "positive" : "negative"}">${row.deltaFromOthers == null ? "-" : `${row.deltaFromOthers > 0 ? "+" : ""}${fmt(row.deltaFromOthers)}`}</td>
      <td>${row.workCalibratedRank ?? "-"}</td>
      <td><div class="comment-excerpt" title="${escapeHtml(row.comment)}">${escapeHtml(row.comment || "-")}</div></td>
    </tr>
  `).join("");

  wireDetailLinks($("raterDetailTable"));
}

function renderWorkDetailOptions(result) {
  const select = $("workDetailSelect");
  const current = select.value;
  const options = result.workStats
    .sort((a, b) => Number(a.workId) - Number(b.workId))
    .map((w) => `<option value="${escapeHtml(w.workId)}">#${escapeHtml(w.workId)} ${escapeHtml(w.title)} (${w.count}评, 校准 ${fmt(w.calibratedMean)})</option>`)
    .join("");
  select.innerHTML = options;
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
}

function getWorkDetailRows(result, work) {
  const paramsByRater = new Map(result.raterStats.map((r) => [r.raterId, r]));
  return work.rows
    .map((rating) => {
      const rater = paramsByRater.get(rating.raterId);
      const normalized = result.normalizedByRating.get(rating.id) ?? rating.score;
      return {
        ...rating,
        normalized,
        scoreDelta: normalized - rating.score,
        calibratedDeviation: normalized - work.calibratedMean,
        rater,
      };
    })
    .sort((a, b) => b.normalized - a.normalized);
}

function renderWorkDetail(result) {
  const selected = $("workDetailSelect").value || result.workStats[0]?.workId;
  const work = result.workStats.find((w) => w.workId === selected);
  if (!work) {
    $("workProfile").innerHTML = "";
    $("workScoreHistogram").innerHTML = "";
    $("workScoreScatter").innerHTML = "";
    $("workCalibrationChart").innerHTML = "";
    $("workDeviationChart").innerHTML = "";
    $("workDetailTable").innerHTML = `<tr><td colspan="12" class="muted">请选择作品。</td></tr>`;
    return;
  }

  const rows = getWorkDetailRows(result, work);
  const qWeight = result.config.useHighWeight ? result.config.highWeightMultiplier : 1;
  const profileCards = [
    ["原始均分", fmt(work.rawMean), `原始排名 ${work.rawRank ?? "-"}`],
    ["校准分", fmt(work.calibratedMean), `校准排名 ${work.calibratedRank ?? "-"}`],
    ["排名变化", work.rankChange == null ? "-" : signedFmt(work.rankChange, 0), "正数表示校准后上升"],
    ["评分数", fmtInt(work.count), `Q/普通 ${work.highWeightCount}/${work.lowWeightCount}`],
    ["标准差", fmt(work.calibratedStd), `95% CI ${work.calibratedCi95 == null ? "-" : `±${fmt(work.calibratedCi95)}`}`],
    ["权重口径", result.config.useHighWeight ? `Q x${qWeight}` : "未加权", work.isDQ ? "作品表标记 DQ" : "正常作品"],
  ];

  $("workProfile").innerHTML = `
    <div class="profile-card work-cover-card">
      ${renderWorkThumb(work)}
      <div>
        <div class="label">封面缩略图</div>
        <div class="value">#${escapeHtml(work.workId)}</div>
        <div class="metric-sub">${escapeHtml(work.title)}${work.isDQ ? " · DQ" : ""}</div>
      </div>
    </div>
    ${profileCards.map(([label, value, sub]) => `
      <div class="profile-card">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value">${escapeHtml(value)}</div>
        <div class="metric-sub">${escapeHtml(sub)}</div>
      </div>
    `).join("")}
  `;

  renderWorkScoreHistogram("workScoreHistogram", rows, result.config);
  renderWorkScoreScatter("workScoreScatter", rows, result.config);
  renderWorkCalibrationChart("workCalibrationChart", rows);
  renderWorkDeviationChart("workDeviationChart", rows, work);

  $("workDetailTable").innerHTML = rows.map((r) => `
    <tr>
      <td title="${escapeHtml(r.raterId)}">${detailAnchor("rater", r.raterId, r.raterName, "在新窗口打开评分者详情")}<br><span class="muted">${escapeHtml(shortId(r.raterId))}</span></td>
      <td>${r.isHighQuality ? '<span class="tag warn">Q</span>' : '<span class="tag">普通</span>'}</td>
      <td>x${fmt(r.weight || 1, 1)}</td>
      <td class="score-pair-from">${fmt(r.score, 0)}</td>
      <td class="score-pair-to"><strong>${fmt(r.normalized)}</strong></td>
      <td class="${r.scoreDelta >= 0 ? "positive" : "negative"}">${signedFmt(r.scoreDelta)}</td>
      <td class="${r.calibratedDeviation >= 0 ? "positive" : "negative"}">${signedFmt(r.calibratedDeviation)}</td>
      <td>${r.rater ? fmt(r.rater.rawMean) : "-"}</td>
      <td>${r.rater ? `${fmt(r.rater.a, 3)} / ${fmt(r.rater.b, 1)}` : "-"}</td>
      <td>${r.rater ? `${r.rater.correction600 >= 0 ? "+" : ""}${fmt(r.rater.correction600)}` : "-"}</td>
      <td>${escapeHtml(formatDateTime(r.createdDate))}</td>
      <td><div class="comment-excerpt" title="${escapeHtml(r.comment)}">${escapeHtml(r.comment || "-")}</div></td>
    </tr>
  `).join("");

  wireDetailLinks($("workDetailTable"));
}

function wireEvents() {
  document.querySelectorAll("[data-work-sort]").forEach((button) => {
    button.addEventListener("click", () => setWorkSort(button.dataset.workSort));
  });

  controls.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", rerun);
    if (el.type === "number") el.addEventListener("input", debounce(rerun, 250));
  });

  $("workSearch").addEventListener("input", debounce(() => state.result && renderWorkTable(state.result), 180));
  $("raterSearch").addEventListener("input", debounce(() => state.result && renderRaterTable(state.result), 180));
  $("raterDetailSelect").addEventListener("change", () => {
    if (!state.result) return;
    if (state.detailType === "rater") updateDetailHistory("rater", $("raterDetailSelect").value);
    renderRaterDetail(state.result);
  });
  $("workDetailSelect").addEventListener("change", () => {
    if (!state.result) return;
    if (state.detailType === "work") updateDetailHistory("work", $("workDetailSelect").value);
    renderWorkDetail(state.result);
  });
  window.addEventListener("resize", debounce(() => {
    if (!state.result) return;
    if (isDetailMode()) {
      if (state.detailType === "work") renderWorkDetail(state.result);
      if (state.detailType === "rater") renderRaterDetail(state.result);
      return;
    }
    renderCharts(state.result);
  }, 150));
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function loadInitialDataset() {
  applyPageMode();
  if (state.useStoredSnapshot && loadStoredDatasetSnapshot()) return;
  await loadBundledCsv();
}

wireEvents();
loadInitialDataset().catch((error) => {
  setStatus(`${error.message}。如果是直接双击 HTML 打开的，请用本地服务器访问。`, "warn");
});
