function pad2(value) {
  return String(value).padStart(2, "0");
}

function getWeekOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

function getIsoWeek(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
}

export function expandBranchTemplate(template, date = new Date()) {
  const month = date.getMonth() + 1;
  const day   = date.getDate();
  const values = {
    yyyy: String(date.getFullYear()),
    yy:   String(date.getFullYear()).slice(-2),
    mm:   pad2(month),
    m:    String(month),
    dd:   pad2(day),
    d:    String(day),
    q:    String(Math.floor((month - 1) / 3) + 1),
    w:    String(getWeekOfMonth(date)),
    ww:   pad2(getIsoWeek(date)),
  };
  return template.replace(/\{([a-z]+)\}/gi, (match, token) => values[token] ?? match);
}

export function getSwitchBranchSuggestions(config, date = new Date()) {
  const templates = config.switch?.branchSuggestions;
  if (!Array.isArray(templates)) return [];

  const seen = new Set();

  return templates
    .filter((t) => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ template: t, value: expandBranchTemplate(t, date).trim() }))
    .filter((item) => item.value !== "")
    .filter((item) => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    });
}
