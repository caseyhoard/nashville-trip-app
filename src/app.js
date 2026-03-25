const els = {
  tripSubtitle: document.querySelector("#trip-subtitle"),
  dataSource: document.querySelector("#data-source"),
  lastUpdated: document.querySelector("#last-updated"),
  dayNav: document.querySelector("#day-nav"),
  dayTitle: document.querySelector("#day-title"),
  daySummary: document.querySelector("#day-summary"),
  currentAgenda: document.querySelector("#current-agenda"),
  tripNotes: document.querySelector("#trip-notes"),
  refreshButton: document.querySelector("#refresh-button"),
  heroStamps: document.querySelector("#hero-stamps"),
  openSwaps: document.querySelector("#open-swaps"),
  openNearby: document.querySelector("#open-nearby"),
  swapsPreview: document.querySelector("#swaps-preview"),
  nearbyPreview: document.querySelector("#nearby-preview"),
  optionSheet: document.querySelector("#option-sheet"),
  sheetBackdrop: document.querySelector("#sheet-backdrop"),
  closeSheet: document.querySelector("#close-sheet"),
  sheetKicker: document.querySelector("#sheet-kicker"),
  sheetTitle: document.querySelector("#sheet-title"),
  sheetDescription: document.querySelector("#sheet-description"),
  sheetList: document.querySelector("#sheet-list")
};

const templates = {
  agenda: document.querySelector("#agenda-card-template"),
  stack: document.querySelector("#stack-item-template"),
  stamp: document.querySelector("#stamp-template")
};

const state = {
  trip: null,
  selectedDayId: null,
  sourceLabel: "Loading...",
  activeSheetMode: null,
  areaFilter: null
};

boot().catch((error) => {
  console.error(error);
  els.dataSource.textContent = "Error";
  els.lastUpdated.textContent = "Could not load trip data";
});

async function boot() {
  registerServiceWorker();
  attachEvents();

  state.trip = await loadTripData();
  state.selectedDayId = state.trip.days[0]?.id ?? null;

  render();
}

function attachEvents() {
  els.refreshButton.addEventListener("click", async () => {
    els.dataSource.textContent = "Refreshing...";
    state.trip = await loadTripData({ bustCache: true });
    render();
  });

  els.openSwaps.addEventListener("click", () => openOptionSheet("swaps"));
  els.openNearby.addEventListener("click", () => openOptionSheet("nearby"));
  els.closeSheet.addEventListener("click", closeOptionSheet);
  els.sheetBackdrop.addEventListener("click", closeOptionSheet);
}

async function loadTripData({ bustCache = false } = {}) {
  const cacheSuffix = bustCache ? `?ts=${Date.now()}` : "";

  try {
    const configResponse = await fetch(`./data/sheet-config.json${cacheSuffix}`, {
      cache: bustCache ? "reload" : "default"
    });

    if (configResponse.ok) {
      const sheetConfig = await configResponse.json();
      if (hasSheetUrls(sheetConfig)) {
        const trip = await buildTripFromSheets(sheetConfig, bustCache);
        state.sourceLabel = "Google Sheets CSV";
        return trip;
      }
    }
  } catch (error) {
    console.info("Sheet config not found yet, using sample data.");
  }

  const sampleResponse = await fetch(`./data/sample-trip.json${cacheSuffix}`, {
    cache: bustCache ? "reload" : "default"
  });
  state.sourceLabel = "Sample JSON";
  return sampleResponse.json();
}

function hasSheetUrls(config) {
  if (typeof config.itineraryCsvUrl === "string" && config.itineraryCsvUrl.trim().length > 0) {
    return true;
  }

  if (typeof config.matrixCsvUrl === "string" && config.matrixCsvUrl.trim().length > 0) {
    return true;
  }

  return [config.agendaCsvUrl, config.swapsCsvUrl, config.nearbyCsvUrl].every(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

async function buildTripFromSheets(config, bustCache) {
  if (typeof config.itineraryCsvUrl === "string" && config.itineraryCsvUrl.trim()) {
    const [itineraryCsv, matrixCsv] = await Promise.all([
      fetchText(config.itineraryCsvUrl, bustCache),
      typeof config.matrixCsvUrl === "string" && config.matrixCsvUrl.trim()
        ? fetchText(config.matrixCsvUrl, bustCache)
        : Promise.resolve("")
    ]);

    return buildTripFromItinerarySheet(config, itineraryCsv, matrixCsv);
  }

  if (typeof config.matrixCsvUrl === "string" && config.matrixCsvUrl.trim()) {
    const matrixCsv = await fetchText(config.matrixCsvUrl, bustCache);
    return buildTripFromMatrixSheet(config, matrixCsv);
  }

  const [agendaCsv, swapsCsv, nearbyCsv] = await Promise.all([
    fetchText(config.agendaCsvUrl, bustCache),
    fetchText(config.swapsCsvUrl, bustCache),
    fetchText(config.nearbyCsvUrl, bustCache)
  ]);

  const agendaRows = parseCsv(agendaCsv);
  const swapRows = parseCsv(swapsCsv);
  const nearbyRows = parseCsv(nearbyCsv);
  const dayMap = new Map();

  for (const row of agendaRows) {
    if (!row.dayId) {
      continue;
    }

    if (!dayMap.has(row.dayId)) {
      dayMap.set(row.dayId, {
        id: row.dayId,
        label: row.label || row.dayId,
        date: row.date || "",
        summary: row.summary || "",
        agenda: [],
        swaps: [],
        nearby: []
      });
    }

    dayMap.get(row.dayId).agenda.push({
      time: row.time || "Anytime",
      title: row.title || "Untitled stop",
      category: row.category || "Agenda",
      area: row.area || "Nashville",
      placeName: row.placeName || row.title || "Nashville",
      notes: row.notes || "",
      reviewQuery: row.reviewQuery || row.placeName || row.title || "",
      directionsQuery: row.directionsQuery || row.placeName || row.title || ""
    });
  }

  addRowsToDayMap(dayMap, swapRows, "swaps");
  addRowsToDayMap(dayMap, nearbyRows, "nearby");

  const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    tripName: config.tripName || "Trip",
    subtitle: config.subtitle || "",
    notes: Array.isArray(config.notes) ? config.notes : [],
    days
  };
}

function buildTripFromItinerarySheet(config, itineraryRawCsv, matrixRawCsv) {
  const itineraryRows = parseCsvRows(itineraryRawCsv);
  const days = [];
  let currentDay = null;

  for (const row of itineraryRows) {
    const first = row[0] || "";
    const second = row[1] || "";
    const third = row[2] || "";
    const fourth = row[3] || "";
    const combined = row.join(" ").trim();

    if (!combined) {
      continue;
    }

    if (/^DAY\s+\d+/i.test(first)) {
      currentDay = {
        id: slugify(first),
        label: compactDayLabel(first),
        date: extractIsoDate(first),
        summary: "",
        agenda: [],
        swaps: [],
        nearby: []
      };
      days.push(currentDay);
      continue;
    }

    if (!currentDay) {
      continue;
    }

    if (!currentDay.summary && !/^TIME$/i.test(first)) {
      currentDay.summary = first;
      continue;
    }

    if (/^TIME$/i.test(first) && /^ACTIVITY$/i.test(second)) {
      continue;
    }

    if (/^[A-Z][A-Z\s\-&']+$/.test(first) && !second && !third && !fourth) {
      continue;
    }

    if (!first && !second && !third && fourth) {
      const previousItem = currentDay.agenda[currentDay.agenda.length - 1];
      if (previousItem) {
        previousItem.notes = [previousItem.notes, fourth].filter(Boolean).join(" • ");
      }
      continue;
    }

    if (!second && (third || fourth)) {
      const previousItem = currentDay.agenda[currentDay.agenda.length - 1];
      if (previousItem) {
        previousItem.notes = [previousItem.notes, first, third, fourth].filter(Boolean).join(" • ");
      }
      continue;
    }

    const area = inferArea([second, third, fourth].join(" "));
    const locationQuery = third || `${second || "Nashville"} ${area}`;

    currentDay.agenda.push({
      time: first || "Anytime",
      title: second || "Untitled stop",
      category: inferCategory(second, third, fourth),
      area,
      placeName: second || "Nashville",
      notes: [third, fourth].filter(Boolean).join(" • "),
      reviewQuery: `${second || third || "Nashville"} ${area} reviews`,
      directionsQuery: locationQuery
    });
  }

  const guideData = matrixRawCsv ? buildTripFromMatrixSheet(config, matrixRawCsv) : null;
  const swapPool = guideData?.days[0]?.swaps || [];
  const nearbyPool = guideData?.days[0]?.nearby || [];

  for (const day of days) {
    day.swaps = selectRelevantOptions(day, swapPool, 6);
    day.nearby = selectRelevantOptions(day, nearbyPool, 6);
  }

  return {
    tripName: config.tripName || itineraryRows[0]?.[0] || "Nashville Trip",
    subtitle: config.subtitle || "Live itinerary synced from Google Sheets.",
    notes: Array.isArray(config.notes) ? config.notes : [],
    days
  };
}

function buildTripFromMatrixSheet(config, rawCsv) {
  const rows = parseCsvRows(rawCsv);
  const thingsToDo = collectMatrixSection(rows, 2, 0, "THINGS TO DO:", "Place", ["Place", "Notes", "Pricing"]);
  const foodAndDrink = collectMatrixSection(rows, 2, 5, "FOOD/DRINK:", "Place", ["Place", "Notes", "GF Stuff?"]);
  const shopping = collectMatrixSection(rows, 22, 0, "SHOPPING:", "Place", ["Place", "Notes"]);
  const stayUrl = rows[23]?.[5] || "";

  return {
    tripName: config.tripName || rows[0]?.[0] || "Nashville Trip",
    subtitle: config.subtitle || "Live planning sheet synced from Google Sheets.",
    notes: [
      ...(Array.isArray(config.notes) ? config.notes : []),
      stayUrl ? `Stay link: ${stayUrl}` : ""
    ].filter(Boolean),
    days: [
      {
        id: "live-guide",
        label: "Guide",
        date: "",
        summary: "Live planning matrix with attractions, food picks, shopping, and stay info.",
        agenda: thingsToDo.map((item) => ({
          time: item.pricing || "Open pick",
          title: item.title,
          category: "Things to do",
          area: guessArea(item),
          placeName: item.title,
          notes: item.notes,
          reviewQuery: `${item.title} Nashville reviews`,
          directionsQuery: `${item.title} Nashville`
        })),
        swaps: foodAndDrink.map((item) => ({
          title: item.title,
          category: item.extra ? "Food + GF" : "Food/drink",
          area: guessArea(item),
          notes: [item.notes, item.extra ? `GF: ${item.extra}` : ""].filter(Boolean).join(" • "),
          reviewQuery: `${item.title} Nashville reviews`,
          directionsQuery: `${item.title} Nashville`
        })),
        nearby: shopping.map((item) => ({
          title: item.title,
          category: "Shopping",
          area: guessArea(item),
          notes: item.notes,
          reviewQuery: `${item.title} Nashville reviews`,
          directionsQuery: `${item.title} Nashville`
        }))
      }
    ]
  };
}

function addRowsToDayMap(dayMap, rows, key) {
  for (const row of rows) {
    if (!row.dayId || !dayMap.has(row.dayId)) {
      continue;
    }

    dayMap.get(row.dayId)[key].push({
      title: row.title || "Untitled option",
      category: row.category || "Option",
      area: row.area || "Nashville",
      notes: row.notes || "",
      reviewQuery: row.reviewQuery || row.title || "",
      directionsQuery: row.directionsQuery || row.title || ""
    });
  }
}

async function fetchText(url, bustCache) {
  const response = await fetch(url + (bustCache ? `${url.includes("?") ? "&" : "?"}ts=${Date.now()}` : ""), {
    cache: bustCache ? "reload" : "default"
  });

  if (!response.ok) {
    throw new Error(`Failed to load ${url}`);
  }

  return response.text();
}

function parseCsv(raw) {
  const rows = parseCsvRows(raw);
  const headers = rows.shift() || [];
  const items = [];

  for (const values of rows) {
    const row = {};

    headers.forEach((header, index) => {
      row[(header || "").trim()] = (values[index] || "").trim();
    });

    items.push(row);
  }

  return items;
}

function parseCsvRows(raw) {
  const rows = [];
  const lines = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "\n" && !quoted) {
      lines.push(current);
      current = "";
      continue;
    }

    if (char !== "\r") {
      current += char;
    }
  }

  if (current) {
    lines.push(current);
  }

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    rows.push(splitCsvLine(line).map((value) => value.trim()));
  }

  return rows;
}

function collectMatrixSection(rows, headerRowIndex, startColumn, sectionLabel, placeHeader, headers) {
  const items = [];

  for (let index = headerRowIndex + 2; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const currentSection = row[startColumn] || "";

    if (currentSection.endsWith(":") && currentSection !== sectionLabel) {
      break;
    }

    const title = row[startColumn] || "";
    const notes = row[startColumn + 1] || "";
    const third = row[startColumn + 2] || "";

    if (!title) {
      continue;
    }

    if (title === placeHeader || headers.includes(title)) {
      continue;
    }

    items.push({
      title,
      notes,
      pricing: headers.includes("Pricing") ? third : "",
      extra: headers.includes("GF Stuff?") ? third : ""
    });
  }

  return items;
}

function guessArea(item) {
  const text = [item.title, item.notes, item.extra].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("butter milk ranch") || text.includes("bmr") || text.includes("five daughters") || text.includes("jeni")) {
    return "12 South";
  }
  if (text.includes("hattie b") || text.includes("pins") || text.includes("peg leg")) {
    return "The Gulch";
  }
  if (text.includes("biscuit love")) {
    return "12 South";
  }
  if (text.includes("franklin")) {
    return "Franklin";
  }
  if (text.includes("germantown")) {
    return "Germantown";
  }
  if (text.includes("broadway")) {
    return "Broadway";
  }
  if (text.includes("gulch")) {
    return "The Gulch";
  }
  if (text.includes("east nashville")) {
    return "East Nashville";
  }

  return "Nashville";
}

function inferArea(text) {
  const value = (text || "").toLowerCase();

  if (value.includes("12 south")) {
    return "12 South";
  }
  if (value.includes("germantown")) {
    return "Germantown";
  }
  if (value.includes("franklin")) {
    return "Franklin";
  }
  if (value.includes("the gulch") || value.includes("gulch")) {
    return "The Gulch";
  }
  if (value.includes("downtown") || value.includes("broadway")) {
    return "Downtown";
  }
  if (value.includes("louisville")) {
    return "Louisville";
  }

  return "Nashville";
}

function inferCategory(title = "", details = "", notes = "") {
  const text = `${title} ${details} ${notes}`.toLowerCase();

  if (text.includes("breakfast") || text.includes("lunch") || text.includes("dinner") || text.includes("bbq")) {
    return "Food";
  }
  if (text.includes("brewing") || text.includes("brewery") || text.includes("bar")) {
    return "Drinks";
  }
  if (text.includes("drive") || text.includes("leave") || text.includes("road")) {
    return "Travel";
  }
  if (text.includes("hotel") || text.includes("check into")) {
    return "Stay";
  }
  if (text.includes("game") || text.includes("fireworks")) {
    return "Event";
  }

  return "Explore";
}

function selectRelevantOptions(day, options, limit) {
  const agendaText = day.agenda
    .map((item) => [item.title, item.area, item.notes].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
  const areaCounts = countAreas(day.agenda);
  const scored = options.map((option) => ({
    option,
    score: scoreOption(option, agendaText, areaCounts)
  }));

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.option);
}

function countAreas(agenda) {
  const counts = new Map();

  for (const item of agenda) {
    counts.set(item.area, (counts.get(item.area) || 0) + 1);
  }

  return counts;
}

function scoreOption(option, agendaText, areaCounts) {
  let score = 0;
  const optionText = [option.title, option.area, option.notes].filter(Boolean).join(" ").toLowerCase();

  score += (areaCounts.get(option.area) || 0) * 5;

  if (option.area === "Nashville") {
    score += 1;
  }

  const keywordGroups = {
    Franklin: ["franklin", "leiper's fork", "curio"],
    Germantown: ["germantown", "city house", "marathon", "monday night", "bearded iris"],
    "The Gulch": ["gulch", "pins", "peg leg", "hattie b"],
    "12 South": ["12 south", "gilmore", "five daughters", "jeni", "butter milk ranch", "bmr"],
    Downtown: ["broadway", "downtown", "arcade", "hatch show", "robert's"],
    Louisville: ["louisville", "slugger", "whiskey row"]
  };

  for (const [area, keywords] of Object.entries(keywordGroups)) {
    const agendaMatches = keywords.some((keyword) => agendaText.includes(keyword));
    const optionMatches = keywords.some((keyword) => optionText.includes(keyword));

    if (agendaMatches && optionMatches) {
      score += area === option.area ? 4 : 3;
    }
  }

  if (agendaText.includes("breakfast") && /bakery|biscuit|ranch|coffee/i.test(option.title)) {
    score += 2;
  }
  if (agendaText.includes("dinner") && /bbq|city house|hattie|prince|biscuit/i.test(option.title)) {
    score += 2;
  }
  if (agendaText.includes("brew") || agendaText.includes("bar") || agendaText.includes("beer")) {
    if (/brew|beer|distillery|peabody/i.test(option.title)) {
      score += 2;
    }
  }
  if (agendaText.includes("game") || agendaText.includes("fireworks")) {
    if (/broadway|downtown|arcade/i.test(option.title)) {
      score += 2;
    }
  }

  return score;
}

function slugify(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function compactDayLabel(value) {
  const match = value.match(/^DAY\s+(\d+)/i);
  return match ? `Day ${match[1]}` : value;
}

function extractIsoDate(value) {
  const match = value.match(/(MARCH|APRIL)\s+(\d{1,2})/i);
  if (!match) {
    return "";
  }

  const monthMap = {
    march: "03",
    april: "04"
  };

  return `2026-${monthMap[match[1].toLowerCase()]}-${String(match[2]).padStart(2, "0")}`;
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function render() {
  document.title = state.trip.tripName;
  els.tripSubtitle.textContent = state.trip.subtitle;
  els.dataSource.textContent = state.sourceLabel;
  els.lastUpdated.textContent = new Date().toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

  renderDayNav();

  const day = state.trip.days.find((entry) => entry.id === state.selectedDayId) || state.trip.days[0];
  if (!day) {
    return;
  }

  els.dayTitle.textContent = formatDayHeading(day);
  els.daySummary.textContent = day.summary || "No summary yet.";
  renderAgenda(day.agenda);
  renderStamps(day);
  renderLaunchers(day);
  renderNotes(state.trip.notes);

  if (state.activeSheetMode) {
    renderOptionSheet(day, state.activeSheetMode);
  }
}

function renderDayNav() {
  els.dayNav.innerHTML = "";

  for (const day of state.trip.days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `day-button${day.id === state.selectedDayId ? " is-active" : ""}`;
    button.textContent = `${day.label} ${shortDate(day.date)}`;
    button.addEventListener("click", () => {
      state.selectedDayId = day.id;
      state.areaFilter = null;
      render();
    });
    els.dayNav.append(button);
  }
}

function renderAgenda(items) {
  els.currentAgenda.innerHTML = "";

  if (!items.length) {
    els.currentAgenda.innerHTML = "<p class=\"muted\">No agenda items yet.</p>";
    return;
  }

  for (const item of items) {
    const node = templates.agenda.content.firstElementChild.cloneNode(true);
    node.querySelector(".agenda-time").textContent = item.time || "Anytime";
    node.querySelector("h3").textContent = item.title;
    node.querySelector(".badge").textContent = item.category || "Agenda";
    node.querySelector(".agenda-meta").textContent = [item.area, item.placeName].filter(Boolean).join(" • ");
    node.querySelector(".agenda-notes").textContent = item.notes || "No notes yet.";
    buildActions(node.querySelector(".action-row"), item);
    els.currentAgenda.append(node);
  }
}

function renderLaunchers(day) {
  const neighborhoods = getNeighborhoodFocus(day);
  const primaryArea = state.areaFilter || neighborhoods[0] || "Nashville";
  const secondaryArea = state.areaFilter || neighborhoods[1] || primaryArea;

  els.openSwaps.setAttribute("aria-label", `Open easy pivots for ${primaryArea}`);
  els.openNearby.setAttribute("aria-label", `Open nearby ideas for ${secondaryArea}`);
  els.swapsPreview.textContent = buildLauncherDescription(primaryArea, "pivots", getFilteredOptions(day, "swaps"));
  els.nearbyPreview.textContent = buildLauncherDescription(secondaryArea, "nearby", getFilteredOptions(day, "nearby"));
}

function buildLauncherDescription(area, mode, items) {
  const sample = items.slice(0, 2).map((item) => item.title).join(" • ");

  if (mode === "pivots") {
    return sample || `Open backup food, drinks, and flexible stops around ${area}.`;
  }

  return sample || `Open nearby things to do, shops, and quick stops around ${area}.`;
}

function getNeighborhoodFocus(day) {
  const counts = countAreas(day.agenda);
  const sortedAreas = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([area]) => area)
    .filter((area) => area && area !== "Nashville");

  if (!sortedAreas.length) {
    return ["Nashville"];
  }

  return sortedAreas.slice(0, 2);
}

function buildActions(target, item) {
  target.innerHTML = "";
  const links = [
    {
      label: "Directions",
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.directionsQuery || item.title)}`,
      primary: true
    },
    {
      label: "Map",
      href: `https://www.google.com/maps/search/${encodeURIComponent(item.directionsQuery || item.title)}`
    },
    {
      label: "Reviews",
      href: `https://www.google.com/search?q=${encodeURIComponent(item.reviewQuery || item.title)}`
    }
  ];

  for (const link of links) {
    const anchor = document.createElement("a");
    anchor.className = `link-chip${link.primary ? " primary" : ""}`;
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = link.label;
    target.append(anchor);
  }
}

function renderNotes(notes) {
  if (!notes.length) {
    els.tripNotes.innerHTML = "<p>No trip notes yet.</p>";
    return;
  }

  const list = document.createElement("ul");
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.append(item);
  }

  els.tripNotes.innerHTML = "";
  els.tripNotes.append(list);
}

function renderStamps(day) {
  const areas = getNeighborhoodFocus(day);
  els.heroStamps.innerHTML = "";

  for (const area of areas) {
    const button = templates.stamp.content.firstElementChild.cloneNode(true);
    button.textContent = area;
    button.className = `stamp${state.areaFilter === area ? " is-active" : ""}`;
    button.addEventListener("click", () => {
      state.areaFilter = state.areaFilter === area ? null : area;
      render();
    });
    els.heroStamps.append(button);
  }
}

function getFilteredOptions(day, key) {
  const items = day[key] || [];
  if (!state.areaFilter) {
    return items;
  }

  const exact = items.filter((item) => item.area === state.areaFilter);
  if (exact.length) {
    return exact;
  }

  return items;
}

function renderStack(items, target) {
  target.innerHTML = "";

  if (!items.length) {
    target.innerHTML = "<p class=\"muted\">No options loaded yet.</p>";
    return;
  }

  for (const item of items) {
    const node = templates.stack.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = item.title;
    node.querySelector(".badge").textContent = item.category || "Option";
    node.querySelector(".stack-meta").textContent = item.area || "Nashville";
    node.querySelector(".stack-notes").textContent = item.notes || "No notes yet.";
    buildActions(node.querySelector(".action-row"), item);
    target.append(node);
  }
}

function openOptionSheet(mode) {
  state.activeSheetMode = mode;
  const day = state.trip.days.find((entry) => entry.id === state.selectedDayId) || state.trip.days[0];
  renderOptionSheet(day, mode);
  els.optionSheet.hidden = false;
  els.optionSheet.setAttribute("aria-hidden", "false");
}

function closeOptionSheet() {
  state.activeSheetMode = null;
  els.optionSheet.hidden = true;
  els.optionSheet.setAttribute("aria-hidden", "true");
}

function renderOptionSheet(day, mode) {
  const focusArea = state.areaFilter || getNeighborhoodFocus(day)[0] || "Nashville";
  const config =
    mode === "swaps"
      ? {
          kicker: "Flexible",
          title: "Easy pivots",
          description: `Matrix-backed backup plays for ${focusArea}.`,
          items: getFilteredOptions(day, "swaps")
        }
      : {
          kicker: "Close by",
          title: "What is close",
          description: `Matrix-backed nearby ideas for ${focusArea}.`,
          items: getFilteredOptions(day, "nearby")
        };

  els.sheetKicker.textContent = config.kicker;
  els.sheetTitle.textContent = config.title;
  els.sheetDescription.textContent = config.description;
  renderStack(config.items, els.sheetList);
}

function shortDate(dateString) {
  if (!dateString) {
    return "";
  }

  return new Date(`${dateString}T12:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric"
  });
}

function formatDayHeading(day) {
  if (!day.date) {
    return day.label || "Trip day";
  }

  return `${day.label} • ${new Date(`${day.date}T12:00:00`).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric"
  })}`;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    });
  }
}
