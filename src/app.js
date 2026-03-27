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
  openMenu: document.querySelector("#open-menu"),
  openSwaps: document.querySelector("#open-swaps"),
  openNearby: document.querySelector("#open-nearby"),
  swapsPreview: document.querySelector("#swaps-preview"),
  nearbyPreview: document.querySelector("#nearby-preview"),
  weatherWidget: document.querySelector("#weather-widget"),
  optionSheet: document.querySelector("#option-sheet"),
  sheetBackdrop: document.querySelector("#sheet-backdrop"),
  closeSheet: document.querySelector("#close-sheet"),
  sheetKicker: document.querySelector("#sheet-kicker"),
  sheetTitle: document.querySelector("#sheet-title"),
  sheetDescription: document.querySelector("#sheet-description"),
  sheetFilters: document.querySelector("#sheet-filters"),
  sheetList: document.querySelector("#sheet-list"),
  menuDrawer: document.querySelector("#menu-drawer"),
  menuBackdrop: document.querySelector("#menu-backdrop"),
  closeMenu: document.querySelector("#close-menu"),
  categoryList: document.querySelector("#category-list")
};

const templates = {
  agenda: document.querySelector("#agenda-card-template"),
  stack: document.querySelector("#stack-item-template"),
  weatherDay: document.querySelector("#weather-day-template"),
  category: document.querySelector("#category-template"),
  categoryItem: document.querySelector("#category-item-template")
};

const state = {
  trip: null,
  selectedDayId: null,
  sourceLabel: "Loading...",
  activeSheetMode: null,
  areaFilter: null,
  weather: null,
  menuOpen: false
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
  state.weather = await loadWeather();

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
  els.openMenu.addEventListener("click", openMenuDrawer);
  els.closeMenu.addEventListener("click", closeMenuDrawer);
  els.menuBackdrop.addEventListener("click", closeMenuDrawer);
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
  const guideData = matrixRawCsv ? buildTripFromMatrixSheet(config, matrixRawCsv) : null;
  const matrixItems = guideData?.matrixItems || [];
  const matrixLookup = buildMatrixLookup(matrixItems);

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

    const matrixMatch = findMatrixMatch(matrixLookup, second, third, fourth);
    const area = matrixMatch?.area || inferArea([second, third, fourth].join(" "), second);
    const locationQuery = matrixMatch?.address || third || `${second || "Nashville"} ${area}`;

    currentDay.agenda.push({
      time: first || "Anytime",
      title: second || "Untitled stop",
      category: inferCategory(second, third, fourth),
      area,
      placeName: matrixMatch?.title || second || "Nashville",
      notes: [third, fourth].filter(Boolean).join(" • "),
      reviewQuery: matrixMatch?.reviewQuery || `${second || third || "Nashville"} ${area} reviews`,
      directionsQuery: locationQuery
    });
  }

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
    categories: guideData?.categories || [],
    days
  };
}

function buildTripFromMatrixSheet(config, rawCsv) {
  const rows = parseCsv(rawCsv);

  if (rows[0]?.NAME) {
    return buildTripFromStructuredMatrix(config, rows);
  }

  return buildTripFromLegacyMatrix(config, parseCsvRows(rawCsv));
}

function buildTripFromLegacyMatrix(config, rows) {
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
    categories: [
      { name: "Things to do", items: thingsToDo.map((item) => toCategoryItem(item, "Things to do")) },
      { name: "Food & drink", items: foodAndDrink.map((item) => toCategoryItem(item, item.extra ? "Food + GF" : "Food/drink")) },
      { name: "Shopping", items: shopping.map((item) => toCategoryItem(item, "Shopping")) }
    ],
    matrixItems: [],
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

function buildTripFromStructuredMatrix(config, rows) {
  const matrixItems = rows
    .filter((row) => row.NAME)
    .map((row) => createMatrixItem(row));

  const categories = Array.from(groupMatrixItems(matrixItems, (item) => item.category).entries())
    .map(([name, items]) => ({
      name,
      items: items.sort((left, right) => left.title.localeCompare(right.title))
    }))
    .sort((left, right) => compareCategoryNames(left.name, right.name));

  const swaps = matrixItems.filter((item) => isSwapCandidate(item));
  const nearby = matrixItems.filter((item) => isNearbyCandidate(item));
  const hotel = matrixItems.find((item) => item.category === "Hotel");

  return {
    tripName: config.tripName || "Nashville Trip",
    subtitle: config.subtitle || "Live planning sheet synced from Google Sheets.",
    notes: [
      ...(Array.isArray(config.notes) ? config.notes : []),
      hotel?.address ? `Stay: ${hotel.title} • ${hotel.address}` : ""
    ].filter(Boolean),
    categories,
    matrixItems,
    days: [
      {
        id: "live-guide",
        label: "Guide",
        date: "",
        summary: "Live planning matrix with attractions, food picks, shopping, and stay info.",
        agenda: matrixItems.filter((item) => item.category !== "Hotel"),
        swaps,
        nearby
      }
    ]
  };
}

function toCategoryItem(item, category) {
  return {
    title: item.title,
    category,
    area: guessArea(item),
    notes: [item.notes, item.extra ? `GF: ${item.extra}` : "", item.pricing || ""].filter(Boolean).join(" • "),
    reviewQuery: `${item.title} Nashville reviews`,
    directionsQuery: `${item.title} Nashville`
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

async function loadWeather() {
  try {
    const response = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=36.1627&longitude=-86.7816&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=3",
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error("Weather request failed");
    }

    return response.json();
  } catch (error) {
    console.warn("Weather unavailable", error);
    return null;
  }
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
      current += char;

      if (quoted && next === "\"") {
        current += next;
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

function createMatrixItem(row) {
  const title = (row.NAME || "").trim();
  const address = (row.ADDRESS || "").trim();
  const neighborhood = (row.NEIGHBORHOOD || "").trim();
  const category = (row.CATEGORY || "Activity").trim();
  const subcategory = (row.SUBCATEGORY || "").trim();
  const description = (row.DESCRIPTION || "").trim();
  const hours = (row["HOURS (CHECK BEFORE YOU GO)"] || "").trim();
  const gf = (row["GF FRIENDLY?"] || "").trim();
  const price = (row.PRICE || "").trim();
  const itinerary = (row["ON ITINERARY?"] || "").trim();
  const website = (row["WEBSITE / NOTES"] || "").trim();
  const area = simplifyNeighborhood(neighborhood || address || title);
  const noteParts = [subcategory, description, hours, gf ? `GF: ${gf}` : "", price ? `Price: ${price}` : "", itinerary ? `Plan: ${itinerary}` : ""];

  return {
    title,
    category,
    categoryLabel: subcategory ? `${category} • ${subcategory}` : category,
    area,
    neighborhood,
    address,
    placeName: title,
    notes: noteParts.filter(Boolean).join(" • "),
    reviewQuery: `${title} ${address || area} reviews`,
    directionsQuery: address || `${title} ${area}`,
    website
  };
}

function simplifyNeighborhood(value) {
  const text = (value || "").trim();

  if (!text) {
    return "Nashville";
  }

  const parts = text.split("/").map((part) => part.trim()).filter(Boolean);
  const primary = parts[0] || text;

  return primary
    .replace(/\s*-\s*Whiskey Row/i, "")
    .replace(/\s*\(SE Nashville\)/i, "")
    .replace(/\s*\/\s*Multiple/i, "")
    .trim();
}

function groupMatrixItems(items, getKey) {
  const groups = new Map();

  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  return groups;
}

function compareCategoryNames(left, right) {
  const preferredOrder = ["Activity", "Restaurant", "Brewery", "Distillery", "Bar", "Hotel"];
  const leftIndex = preferredOrder.indexOf(left);
  const rightIndex = preferredOrder.indexOf(right);

  if (leftIndex === -1 && rightIndex === -1) {
    return left.localeCompare(right);
  }
  if (leftIndex === -1) {
    return 1;
  }
  if (rightIndex === -1) {
    return -1;
  }

  return leftIndex - rightIndex;
}

function isSwapCandidate(item) {
  return ["Restaurant", "Brewery", "Distillery", "Bar"].includes(item.category);
}

function isNearbyCandidate(item) {
  return item.category !== "Hotel";
}

function buildMatrixLookup(items) {
  return items.map((item) => ({
    item,
    normalizedTitle: normalizeLookupText(item.title),
    normalizedAddress: normalizeLookupText(item.address),
    normalizedArea: normalizeLookupText(item.area),
    normalizedNeighborhood: normalizeLookupText(item.neighborhood)
  }));
}

function findMatrixMatch(lookup, title = "", details = "", notes = "") {
  const titleText = normalizeLookupText(title);
  const combinedText = normalizeLookupText([title, details, notes].filter(Boolean).join(" "));
  let best = null;

  for (const entry of lookup) {
    let score = 0;

    if (titleText && titleText === entry.normalizedTitle) {
      score += 100;
    }
    if (titleText && titleText.includes(entry.normalizedTitle)) {
      score += 70;
    }
    if (combinedText && combinedText.includes(entry.normalizedTitle)) {
      score += 60;
    }
    if (entry.normalizedAddress && combinedText.includes(entry.normalizedAddress)) {
      score += 80;
    }
    if (entry.normalizedNeighborhood && combinedText.includes(entry.normalizedNeighborhood)) {
      score += 20;
    }
    if (entry.normalizedArea && combinedText.includes(entry.normalizedArea)) {
      score += 10;
    }

    if (!best || score > best.score) {
      best = { score, item: entry.item };
    }
  }

  return best && best.score >= 60 ? best.item : null;
}

function normalizeLookupText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function inferArea(text, title = "") {
  const value = `${text || ""} ${title || ""}`.toLowerCase();

  if (value.includes("12 south")) {
    return "12 South";
  }
  if (value.includes("whiskey row") || value.includes("w main") || value.includes("slugger") || value.includes("louisville")) {
    return "Louisville";
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
  renderLaunchers(day);
  renderWeather();
  renderNotes(state.trip.notes);
  renderCategories();

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
  const primaryArea = neighborhoods[0] || "Nashville";
  const secondaryArea = neighborhoods[1] || primaryArea;

  els.openSwaps.setAttribute("aria-label", `Open easy pivots for ${primaryArea}`);
  els.openNearby.setAttribute("aria-label", `Open nearby ideas for ${secondaryArea}`);
  els.swapsPreview.textContent = buildLauncherDescription(primaryArea, "pivots", day.swaps || []);
  els.nearbyPreview.textContent = buildLauncherDescription(secondaryArea, "nearby", day.nearby || []);
}

function renderWeather() {
  els.weatherWidget.innerHTML = "";

  if (!state.weather?.daily?.time?.length) {
    els.weatherWidget.innerHTML = "<p class=\"weather-loading\">Weather unavailable.</p>";
    return;
  }

  state.weather.daily.time.forEach((date, index) => {
    const node = templates.weatherDay.content.firstElementChild.cloneNode(true);
    node.querySelector(".weather-icon").textContent = weatherCodeToIcon(state.weather.daily.weather_code[index]);
    node.querySelector(".weather-day-label").textContent = new Date(`${date}T12:00:00`).toLocaleDateString([], {
      weekday: "short"
    });
    node.querySelector(".weather-temp").textContent = `${Math.round(state.weather.daily.temperature_2m_max[index])}° / ${Math.round(state.weather.daily.temperature_2m_min[index])}°`;
    els.weatherWidget.append(node);
  });
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

function renderCategories() {
  const categories = state.trip.categories || [];
  els.categoryList.innerHTML = "";

  for (const category of categories) {
    const node = templates.category.content.firstElementChild.cloneNode(true);
    const toggle = node.querySelector(".category-toggle");
    const itemsWrap = node.querySelector(".category-items");
    node.querySelector(".category-name").textContent = category.name;
    node.querySelector(".category-count").textContent = `${category.items.length} places`;

    for (const item of category.items) {
      const itemNode = templates.categoryItem.content.firstElementChild.cloneNode(true);
      itemNode.querySelector(".category-item-title").textContent = item.title;
      itemNode.querySelector(".category-item-area").textContent = item.area;
      itemNode.querySelector(".category-item-address").textContent = item.address || item.neighborhood || "Address not listed";
      itemNode.querySelector(".category-item-notes").textContent = item.notes || "No notes yet.";
      buildActions(itemNode.querySelector(".action-row"), item);
      itemsWrap.append(itemNode);
    }

    toggle.addEventListener("click", () => {
      itemsWrap.hidden = !itemsWrap.hidden;
    });
    itemsWrap.hidden = true;
    els.categoryList.append(node);
  }
}

function getFilteredOptions(day, key, areaFilter = state.areaFilter) {
  const items = day[key] || [];
  if (!areaFilter) {
    return items;
  }

  const exact = items.filter((item) => item.area === areaFilter);
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

function openMenuDrawer() {
  state.menuOpen = true;
  els.menuDrawer.hidden = false;
  els.menuDrawer.setAttribute("aria-hidden", "false");
}

function closeMenuDrawer() {
  state.menuOpen = false;
  els.menuDrawer.hidden = true;
  els.menuDrawer.setAttribute("aria-hidden", "true");
}

function openOptionSheet(mode) {
  state.activeSheetMode = mode;
  state.areaFilter = null;
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
  const availableAreas = getAvailableFilterAreas(day, mode);
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
  renderSheetFilters(availableAreas, day, mode);
  renderStack(config.items, els.sheetList);
}

function getAvailableFilterAreas(day, mode) {
  const key = mode === "swaps" ? "swaps" : "nearby";
  const listAreas = Array.from(new Set((day[key] || []).map((item) => item.area).filter(Boolean)));
  const focusAreas = getNeighborhoodFocus(day);

  return Array.from(new Set([...focusAreas, ...listAreas])).filter((area) => area && area !== "Nashville");
}

function renderSheetFilters(areas, day, mode) {
  els.sheetFilters.innerHTML = "";
  els.sheetFilters.hidden = areas.length === 0;

  if (!areas.length) {
    return;
  }

  for (const area of areas) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stamp${state.areaFilter === area ? " is-active" : ""}`;
    button.textContent = area;
    button.addEventListener("click", () => {
      state.areaFilter = state.areaFilter === area ? null : area;
      renderOptionSheet(day, mode);
    });
    els.sheetFilters.append(button);
  }
}

function weatherCodeToIcon(code) {
  const weatherCode = Number(code);

  if ([0].includes(weatherCode)) {
    return "☀️";
  }
  if ([1, 2].includes(weatherCode)) {
    return "⛅";
  }
  if ([3].includes(weatherCode)) {
    return "☁️";
  }
  if ([45, 48].includes(weatherCode)) {
    return "🌫️";
  }
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(weatherCode)) {
    return "🌧️";
  }
  if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) {
    return "❄️";
  }
  if ([95, 96, 99].includes(weatherCode)) {
    return "⛈️";
  }

  return "🌤️";
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
      navigator.serviceWorker
        .register("./sw.js")
        .then((registration) => registration.update())
        .catch((error) => {
          console.warn("Service worker registration failed", error);
        });
    });
  }
}
