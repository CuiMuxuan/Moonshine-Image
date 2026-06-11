import { createDefaultSam3Lexicon } from "src/shared/samLexiconDefaults";

const normalizeEntry = (entry = {}, fallbackCategory = "") => {
  const zh = String(entry.zh || "").trim();
  const en = String(entry.en || "").trim();
  if (!zh || !en) return null;
  const normalized = { zh, en };
  const category = String(entry.category || fallbackCategory || "").trim();
  if (category) normalized.category = category;
  return normalized;
};

export const normalizeSam3Lexicon = (payload = {}) => {
  const defaults = createDefaultSam3Lexicon();
  const colors = Array.isArray(payload.colors)
    ? payload.colors.map((entry) => normalizeEntry(entry)).filter(Boolean)
    : defaults.colors;
  const nouns = Array.isArray(payload.nouns)
    ? payload.nouns.map((entry) => normalizeEntry(entry, "自定义")).filter(Boolean)
    : defaults.nouns;

  return {
    version: Number(payload.version || defaults.version) || defaults.version,
    colors: colors.length ? colors : defaults.colors,
    nouns: nouns.length ? nouns : defaults.nouns,
    path: payload.path || "",
  };
};

export const loadSam3Lexicon = async () => {
  const api = window.electron?.ipcRenderer;
  if (!api?.getSam3Lexicon) {
    return normalizeSam3Lexicon(createDefaultSam3Lexicon());
  }
  const result = await api.getSam3Lexicon();
  if (!result?.success) {
    throw new Error(result?.error || "读取 SAM3 中文词表失败");
  }
  return normalizeSam3Lexicon(result.data);
};

export const saveSam3Lexicon = async (lexicon) => {
  const normalized = normalizeSam3Lexicon(lexicon);
  const api = window.electron?.ipcRenderer;
  if (!api?.saveSam3Lexicon) {
    return normalized;
  }
  const result = await api.saveSam3Lexicon(normalized);
  if (!result?.success) {
    throw new Error(result?.error || "保存 SAM3 中文词表失败");
  }
  return normalizeSam3Lexicon(result.data);
};

export const buildSam3LexiconPrompt = ({ text = "", color = null, noun = null } = {}) => {
  const manualText = String(text || "").trim();
  if (manualText) {
    return {
      text: manualText,
      language: /[\u4e00-\u9fff]/.test(manualText) ? "zh" : "auto",
      source: "manual",
      color: color || null,
      noun: noun || null,
      warning: "",
    };
  }

  const colorText = String(color?.en || "").trim();
  const nounText = String(noun?.en || "").trim();
  if (colorText && nounText) {
    return {
      text: `${colorText} ${nounText}`.trim(),
      language: "en",
      source: "lexicon-composed",
      color,
      noun,
      warning: "",
    };
  }
  if (nounText) {
    return {
      text: nounText,
      language: "en",
      source: "lexicon-noun",
      color: null,
      noun,
      warning: "",
    };
  }
  if (colorText) {
    return {
      text: colorText,
      language: "en",
      source: "lexicon-color",
      color,
      noun: null,
      warning: "仅颜色可能返回不稳定结果",
    };
  }

  return {
    text: "",
    language: "auto",
    source: "empty",
    color: null,
    noun: null,
    warning: "",
  };
};
