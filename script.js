(() => {
  "use strict";

  const CITIES = {
    cairo: { name: "Cairo", latitude: 30.0444, longitude: 31.2357 },
    alexandria: { name: "Alexandria", latitude: 31.2001, longitude: 29.9187 },
    sohag: { name: "Sohag", latitude: 26.5591, longitude: 31.6957 },
    aswan: { name: "Aswan", latitude: 24.0889, longitude: 32.8998 },
    luxor: { name: "Luxor", latitude: 25.6872, longitude: 32.6396 }
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CURRENT_YEAR = new Date().getFullYear();
  const LAST_COMPLETE_YEAR = CURRENT_YEAR - 1;
  const API_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point";
  const COLORS = { teal: "#48d3bf", orange: "#ffa45f", muted: "#85a1a4", grid: "rgba(151, 185, 183, 0.12)" };

  const elements = {
    city: document.querySelector("#city-select"),
    start: document.querySelector("#start-year"),
    end: document.querySelector("#end-year"),
    formError: document.querySelector("#form-error"),
    status: document.querySelector("#data-status"),
    content: document.querySelector("#dashboard-content"),
    refresh: document.querySelector("#refresh-button"),
    navToggle: document.querySelector(".menu-toggle"),
    nav: document.querySelector("#primary-nav")
  };

  elements.start.max = String(LAST_COMPLETE_YEAR);
  elements.end.max = String(LAST_COMPLETE_YEAR);

  let activeRequest = null;
  let charts = {};

  function getRequestRange() {
    const startYear = Number(elements.start.value);
    const endYear = Number(elements.end.value);
    if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
      throw new Error("Enter a valid whole-number start and end year.");
    }
    if (startYear < 1981 || endYear > LAST_COMPLETE_YEAR) {
      throw new Error(`NASA POWER monthly data is analyzed here from 1981 through ${LAST_COMPLETE_YEAR}.`);
    }
    if (startYear > endYear) {
      throw new Error("The start year must be earlier than or equal to the end year.");
    }
    if (endYear - startYear + 1 < 2) {
      throw new Error("Choose at least two years to calculate a long-term trend.");
    }
    return { startYear, endYear };
  }

  function buildRequestUrl(city, startYear, endYear) {
    const params = new URLSearchParams({
      parameters: "T2M",
      community: "RE",
      longitude: String(city.longitude),
      latitude: String(city.latitude),
      start: String(startYear),
      end: String(endYear),
      format: "JSON"
    });
    return `${API_URL}?${params.toString()}`;
  }

  function isValidObservation(value) {
    return typeof value === "number" && Number.isFinite(value) && value !== -999 && value >= -90 && value <= 65;
  }

  function parseMonthlyData(payload, startYear, endYear) {
    const values = payload?.properties?.parameter?.T2M;
    if (!values || typeof values !== "object") {
      const apiMessage = Array.isArray(payload?.messages) ? payload.messages.join(" ") : "";
      throw new Error(apiMessage || "NASA POWER returned data in an unexpected format.");
    }

    const records = [];
    for (let year = startYear; year <= endYear; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const key = `${year}${String(month).padStart(2, "0")}`;
        const rawValue = values[key];
        if (typeof rawValue !== "number" || !isValidObservation(rawValue)) continue;
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        records.push({ year, month: month - 1, value: rawValue, days });
      }
    }
    if (records.length === 0) {
      throw new Error("No valid monthly temperature observations were returned for this location and period.");
    }
    return records;
  }

  function calculateStatistics(records, startYear, endYear) {
    const grouped = new Map();
    const monthlyTotals = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
    for (const record of records) {
      if (!grouped.has(record.year)) grouped.set(record.year, []);
      grouped.get(record.year).push(record);
      monthlyTotals[record.month].sum += record.value;
      monthlyTotals[record.month].count += 1;
    }

    const annual = [];
    for (let year = startYear; year <= endYear; year += 1) {
      const yearRecords = grouped.get(year) ?? [];
      if (yearRecords.length === 0) continue;
      const validDays = yearRecords.reduce((sum, record) => sum + record.days, 0);
      const weightedTemperature = yearRecords.reduce((sum, record) => sum + record.value * record.days, 0);
      annual.push({
        year,
        value: weightedTemperature / validDays,
        validMonths: yearRecords.length,
        validDays
      });
    }

    if (annual.length < 2) {
      throw new Error("Fewer than two years have valid monthly data; a long-term trend cannot be calculated.");
    }

    const monthly = monthlyTotals.map((month) => month.count ? month.sum / month.count : null);
    const mean = annual.reduce((sum, year) => sum + year.value, 0) / annual.length;
    const warmest = annual.reduce((selected, year) => year.value > selected.value ? year : selected);
    const coolest = annual.reduce((selected, year) => year.value < selected.value ? year : selected);
    const first = annual[0];
    const last = annual[annual.length - 1];
    const totalChange = last.value - first.value;
    const averageYear = annual.reduce((sum, year) => sum + year.year, 0) / annual.length;
    const averageTemperature = annual.reduce((sum, year) => sum + year.value, 0) / annual.length;
    const numerator = annual.reduce((sum, year) => sum + (year.year - averageYear) * (year.value - averageTemperature), 0);
    const denominator = annual.reduce((sum, year) => sum + (year.year - averageYear) ** 2, 0);
    const slope = denominator ? numerator / denominator : 0;

    return {
      annual, monthly, mean, warmest, coolest, first, last, totalChange, slope,
      validMonths: records.length,
      expectedMonths: (endYear - startYear + 1) * 12,
      trend: slope > 0.01 ? "increasing" : slope < -0.01 ? "decreasing" : "stable"
    };
  }

  function formatTemperature(value, withSign = false) {
    const prefix = withSign && value > 0 ? "+" : "";
    return `${prefix}${value.toFixed(2)}`;
  }

  function setText(selector, text) {
    const target = document.querySelector(selector);
    if (target) target.textContent = text;
  }

  function setStatus(message, isError = false, details = "") {
    elements.status.hidden = false;
    elements.status.classList.toggle("is-error", isError);
    elements.status.replaceChildren();
    const spinner = document.createElement("span");
    spinner.className = "status-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = message;
    elements.status.append(spinner, text);
    if (details) {
      const help = document.createElement("span");
      help.className = "status-help";
      help.textContent = details;
      const retry = document.createElement("button");
      retry.className = "status-retry";
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", loadDashboard, { once: true });
      elements.status.append(help, retry);
    }
  }

  function makeChartOptions(yTitle, beginAtZero = false) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          display: true,
          labels: { color: "#a6bfbd", usePointStyle: true, pointStyle: "line", boxWidth: 18, boxHeight: 5, padding: 16, font: { family: "DM Sans", size: 10 } }
        },
        tooltip: {
          backgroundColor: "#061820",
          borderColor: "rgba(102, 228, 211, .28)",
          borderWidth: 1,
          titleColor: "#eaf4f1",
          bodyColor: "#c5d8d3",
          padding: 11,
          displayColors: true,
          callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)} °C` }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: COLORS.grid },
          ticks: { color: COLORS.muted, maxTicksLimit: 12, maxRotation: 0, font: { family: "DM Sans", size: 9 } }
        },
        y: {
          beginAtZero,
          border: { display: false },
          grid: { color: COLORS.grid },
          title: { display: true, text: yTitle, color: "#78979a", font: { family: "DM Sans", size: 9, weight: "normal" } },
          ticks: { color: COLORS.muted, maxTicksLimit: 6, font: { family: "DM Sans", size: 9 } }
        }
      }
    };
  }

  function destroyCharts() {
    Object.values(charts).forEach((chart) => chart.destroy());
    charts = {};
  }

  function renderCharts(stats) {
    if (typeof Chart === "undefined") {
      throw new Error("The chart library did not load. Check your connection and refresh the page.");
    }
    destroyCharts();
    const years = stats.annual.map((entry) => entry.year);
    const temperatures = stats.annual.map((entry) => entry.value);

    const annualOptions = makeChartOptions("Annual average (°C)");
    annualOptions.plugins.tooltip.afterBody = (items) => {
      const year = stats.annual[items[0]?.dataIndex];
      return year ? `Valid monthly observations: ${year.validMonths}/12` : "";
    };
    charts.annual = new Chart(document.querySelector("#annual-chart"), {
      type: "line",
      data: {
        labels: years,
        datasets: [{
          label: "Annual average",
          data: temperatures,
          borderColor: COLORS.teal,
          backgroundColor: "rgba(40, 198, 179, .11)",
          fill: true,
          borderWidth: 2,
          pointRadius: years.length > 35 ? 0 : 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: COLORS.teal,
          tension: .25
        }]
      },
      options: annualOptions
    });

    charts.monthly = new Chart(document.querySelector("#monthly-chart"), {
      type: "line",
      data: {
        labels: MONTHS,
        datasets: [{
          label: "Monthly average",
          data: stats.monthly,
          spanGaps: false,
          borderColor: COLORS.orange,
          backgroundColor: "rgba(255, 164, 95, .08)",
          fill: true,
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: COLORS.orange,
          tension: .3
        }]
      },
      options: makeChartOptions("Monthly average (°C)")
    });

    const fittedValues = stats.annual.map((entry) => stats.mean + stats.slope * (entry.year - stats.annual.reduce((sum, item) => sum + item.year, 0) / stats.annual.length));
    charts.trend = new Chart(document.querySelector("#trend-chart"), {
      type: "line",
      data: {
        labels: years,
        datasets: [
          {
            label: "Annual average",
            data: temperatures,
            borderColor: COLORS.teal,
            backgroundColor: COLORS.teal,
            borderWidth: 1.8,
            pointRadius: years.length > 35 ? 0 : 2,
            pointHoverRadius: 4,
            tension: .2
          },
          {
            label: "Linear trend",
            data: fittedValues,
            borderColor: COLORS.orange,
            borderDash: [6, 5],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0
          }
        ]
      },
      options: makeChartOptions("Temperature (°C)")
    });
  }

  function renderFindings(stats) {
    const trendText = stats.trend === "increasing"
      ? "An increasing temperature trend is observed in this location's selected dataset."
      : stats.trend === "decreasing"
        ? "A decreasing temperature trend is observed in this location's selected dataset."
        : "The linear trend is broadly stable in this location's selected dataset.";
    setText("#finding-trend", trendText);
    setText("#finding-warmest", `${stats.warmest.year} recorded the highest annual average: ${formatTemperature(stats.warmest.value)} °C.`);
    setText("#finding-coolest", `${stats.coolest.year} recorded the lowest annual average: ${formatTemperature(stats.coolest.value)} °C.`);
    setText("#finding-change", `${formatTemperature(stats.totalChange, true)} °C between ${stats.first.year} and ${stats.last.year}.`);
  }

  function clearFindings(message) {
    setText("#finding-trend", message);
    setText("#finding-warmest", "—");
    setText("#finding-coolest", "—");
    setText("#finding-change", "—");
  }

  function renderDashboard(city, startYear, endYear, records) {
    const stats = calculateStatistics(records, startYear, endYear);
    elements.content.hidden = false;
    setText("#caption-location", `${city.name}, Egypt`);
    setText("#caption-coordinates", `${city.latitude.toFixed(4)}° N, ${city.longitude.toFixed(4)}° E`);
    setText("#period-badge", `${startYear} — ${endYear} · ${stats.annual.length} years`);
    setText("#mean-temp", formatTemperature(stats.mean));
    setText("#warmest-temp", formatTemperature(stats.warmest.value));
    setText("#warmest-year", String(stats.warmest.year));
    setText("#coolest-temp", formatTemperature(stats.coolest.value));
    setText("#coolest-year", String(stats.coolest.year));
    setText("#total-change", formatTemperature(stats.totalChange, true));
    setText("#change-years", `${stats.first.year} → ${stats.last.year}`);
    const trendValue = document.querySelector("#trend-label");
    trendValue.dataset.trend = stats.trend;
    trendValue.querySelector("span:last-child").textContent = stats.trend[0].toUpperCase() + stats.trend.slice(1);
    setText("#trend-rate", `${formatTemperature(stats.slope, true)} °C per year · linear fit`);
    const coverage = stats.validMonths / stats.expectedMonths * 100;
    setText("#coverage-note", `NASA POWER T2M monthly observations: ${stats.validMonths} of ${stats.expectedMonths} expected months (${coverage.toFixed(1)}% coverage). Annual means use available valid months only; years with fewer valid months are identified in chart tooltips.`);
    renderCharts(stats);
    renderFindings(stats);
    document.querySelector("#annual-chart").setAttribute("aria-label", `Annual average temperature for ${city.name} from ${stats.first.year} to ${stats.last.year}`);
    document.querySelector("#monthly-chart").setAttribute("aria-label", `Average monthly temperature for ${city.name} from ${startYear} to ${endYear}`);
    document.querySelector("#trend-chart").setAttribute("aria-label", `Annual temperature and linear regression trend for ${city.name}`);
  }

  async function loadDashboard() {
    let range;
    try {
      range = getRequestRange();
      elements.formError.hidden = true;
      elements.formError.textContent = "";
    } catch (error) {
      if (activeRequest) {
        activeRequest.abort();
        activeRequest = null;
        elements.refresh.classList.remove("is-loading");
        elements.refresh.disabled = false;
      }
      elements.formError.textContent = error.message;
      elements.formError.hidden = false;
      elements.content.hidden = true;
      clearFindings("Choose a valid analysis period to calculate climate insights.");
      setStatus("The selected analysis period is not valid.", true, error.message);
      return;
    }

    if (activeRequest) activeRequest.abort();
    activeRequest = new AbortController();
    const request = activeRequest;
    const city = CITIES[elements.city.value];
    elements.content.hidden = true;
    clearFindings(`Loading ${city.name} observations…`);
    elements.refresh.classList.add("is-loading");
    elements.refresh.disabled = true;
    setStatus(`Loading ${city.name} temperature observations from NASA POWER…`);

    try {
      const response = await fetch(buildRequestUrl(city, range.startYear, range.endYear), {
        signal: request.signal,
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`NASA POWER returned HTTP ${response.status}.`);
      }
      const payload = await response.json();
      const records = parseMonthlyData(payload, range.startYear, range.endYear);
      if (request.signal.aborted) return;
      renderDashboard(city, range.startYear, range.endYear, records);
      elements.status.hidden = true;
    } catch (error) {
      if (error.name === "AbortError") return;
      elements.content.hidden = true;
      clearFindings("No findings are available because the current climate data could not be loaded.");
      setStatus("Climate data could not be loaded.", true, `${error.message} Check your internet connection or try again later. No sample or estimated values are displayed.`);
    } finally {
      if (activeRequest === request) {
        activeRequest = null;
        elements.refresh.classList.remove("is-loading");
        elements.refresh.disabled = false;
      }
    }
  }

  elements.city.addEventListener("change", loadDashboard);
  elements.start.addEventListener("change", loadDashboard);
  elements.end.addEventListener("change", loadDashboard);
  elements.refresh.addEventListener("click", loadDashboard);
  elements.navToggle.addEventListener("click", () => {
    const isOpen = elements.nav.classList.toggle("is-open");
    elements.navToggle.setAttribute("aria-expanded", String(isOpen));
    elements.navToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
  });
  elements.nav.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      elements.nav.classList.remove("is-open");
      elements.navToggle.setAttribute("aria-expanded", "false");
      elements.navToggle.setAttribute("aria-label", "Open navigation");
    }
  });

  loadDashboard();
})();
