"use strict";


const DATA_MODE = "static";
const LIVE_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson";
const STATIC_URL = "data/earthquake_4.5_month.geojson";
const DATA_URL = DATA_MODE === "live" ? LIVE_URL : STATIC_URL;

const COLORS = {
    shallow: getCss("--shallow"),
    intermediate: getCss("--intermediate"),
    deep: getCss("--deep"),
    uniform: getCss("--uniform"),
    accent: getCss("--accent"),
};

const DEPTH = {
    shallow: { label: "Shallow", lo: 0, hi: 70, color: COLORS.shallow },
    intermediate: { label: "Intermediate", lo: 70, hi: 300, color: COLORS.intermediate },
    deep: { label: "Deep", lo: 300, hi: Infinity, color: COLORS.deep },
};

const REGIONS = {
    jpphid: { name: "Japan / Philippines / Indonesia", test: (lon, lat) => lat > -12 && lat < 48 && lon >= 95 && lon <= 156 },
    nzfj: { name: "New Zealand / Fiji", test: (lon, lat) => lat > -42 && lat < -12 && (lon >= 172 || lon <= -168) },
    clpe: { name: "Chile / Peru", test: (lon, lat) => lat > -46 && lat < 4 && lon >= -82 && lon <= -60 },
    mx: { name: "Mexico", test: (lon, lat) => lat > 5 && lat <= 23 && lon >= -108 && lon <= -83 },
    al: { name: "Alaska / Aleutian Islands", test: (lon, lat) => lat >= 48 && lat <= 64 && (lon >= 168 || lon <= -145) },
};
const REGION_ORDER = ["jpphid", "nzfj", "clpe", "mx", "al"];
const REGION_BOUNDS = {
    jpphid: [95, -12, 156, 48],
    nzfj: [172, -42, 190, -12],
    clpe: [-82, -46, -60, 4],
    mx: [-108, 5, -83, 23],
    al: [168, 48, 215, 64],
};

let QUAKES = [];
let WORLD = [];
let svg;
let gZoom;
let gLand;
let gGrat;
let gHot;
let gQuakes;
let gAnno;
let tooltip;
let width = 0;
let height = 0;
let currentK = 1;
let projection;
let path;
let graticule;
let rScale;
let zoom;

initializeChart();
window.addEventListener("resize", debounce(sizeAndDraw, 200));
loadData();

/* PARAMETERS
- selectedDepthCategory: all, shallow, intermediate, deep
- selectedRegion: global, or by region key
- sortBy: time, mag, depth
*/
const state = {
    scene: 1,
    minMagnitude: 4.5,
    selectedDepthCategory: "all",
    selectedRegion: "global",
    showTopEarthquakes: false,
    selectedEarthquakeId: null,
    sortBy: "time",
};

/* SCENES
- Share: map, annotation template, parameters, triggers.
- Each scene highlights different data in the chart.
- Order of data highlights: location and intensity -> depth -> drill in and exploration.
*/
const SCENES = [
    {
        key: "overview",
        kicker: "Location and strength",
        title: "Where earthquakes happen and how strong they are",
        uniformSize: false,
        colorByDepth: false,
        onEnter() {
            Object.assign(state, {
                minMagnitude: 4.5,
                selectedDepthCategory: "all",
                selectedRegion: "global",
                showTopEarthquakes: false,
            });
            resetZoom(false);
        },
        narrative() {
            return `<p>Each point represents one of <b>${QUAKES.length}</b> earthquakes of magnitude <b>4.5</b> or greater recorded during the past 30 days.</p>
            
            <p>Earthquakes cluster in narrow bands along plate boundaries, especially around the Pacific <b>Ring of Fire</b>. Largercircles repsent stronger earthquakes.</p>
                
            <p>Use the magnitude slider to keep only the strongest earthquakes.</p>`;
        },
    },
    {
        key: "depth",
        kicker: "Focal depth",
        title: "Depth changes how earthquakes reach the surface",
        uniformSize: false,
        colorByDepth: true,
        emphasizeShallow: true,
        onEnter() {
            Object.assign(state, {
                minMagnitude: 4.5,
                selectedRegion: "global",
                selectedDepthCategory: "all",
                showTopEarthquakes: false,
            });
            resetZoom(false);
        },
        narrative() {
            const shallow = QUAKES.filter(d => d.depthCat === "shallow").length;
            const pct = QUAKES.length ? Math.round(100 * shallow / QUAKES.length) : 0;
            return `<p>Magnitude tells us how much energy an earthquake release. While <b>Focal depth</b> tells us how far the enegry travels before reaching the surface.</p>
                
            <p>Shallow-focus earthquakes are less than 70 km deep. In this dataset, they account for <b>${pct}%</b> of this month's events and are highlighted.</p>
                
            <p>Use the depth buttons to compare shallow, intermediate, and deep earthquakes.</p>`;
        },
    },
    {
        key: "explore",
        kicker: "Drill in and explore",
        title: "Drill into a hotspot and explore the map",
        uniformSize: false,
        colorByDepth: true,
        onEnter() {
            Object.assign(state, {
                minMagnitude: 4.5,
                selectedDepthCategory: "all",
                showTopEarthquakes: false,
            });
            if (state.selectedRegion === "global") resetZoom(false);
        },
        narrative() {
            return `<p>Please choose a region or click a hotspot box to examine its earthquakes more closely.</p>

            <p>The region panel summarizes the total number of earthquakes, the largest magnitude, average depth, and share of shallow events.</p>
                
            <p>Use the controls to filter by magnitude or depth, sort the points, highlight the ten largest earthquakes, and view details for any selected point.</p>`;
        },
    },
];

/* ANNOTATION
- Consistent annotation templete
- re-anchored without changing the earthquake data or map.
*/
function renderAnnotations(sc) {
    if (!gAnno || !projection) return;

    gAnno.selectAll("*").remove();
    const notes = [];
    sc = sc || SCENES[state.scene - 1];
    const { activeList } = computeActive();

    if (sc.key === "overview") {
        // Distribution + magnitude msg
        notes.push(annoAt(140, 40, -70, 40, "The Ring of Fire",
            "Three-quarters of the world’s earthquakes occur along the Pacific coast."));
        const biggest = d3.greatest(activeList.length ? activeList : QUAKES, d => d.mag);
        if (biggest) {
            notes.push(annoAtQuake(biggest, 60, 55,
                `Largest: M${biggest.mag.toFixed(1)}`, shorten(biggest.place)));
        }
    } else if (sc.key === "depth") {
        const deepest = d3.greatest(QUAKES.filter(d => d.depthCat === "deep"), d => d.depth);
        if (deepest) {
            notes.push(annoAtQuake(deepest, -70, 60,
                `Deep focus: ${Math.round(deepest.depth)} km`,
                "It lies deep beneath the earth's surface and is usually faintly perceptible."));
        }
    } else if (sc.key === "explore") {
        // When drilled into a region: annotate the region's largest quake;
        // When a specific quake is selected: annotate it.
        if (state.selectedEarthquakeId) {
            const selected = byId(state.selectedEarthquakeId);
            if (selected && selected.__active) {
                notes.push(annoAtQuake(selected, 40, -45,
                    `M${selected.mag.toFixed(1)} · ${Math.round(selected.depth)} km`,
                    shorten(selected.place)));
            }
        } else if (state.selectedRegion !== "global") {
            const inRegion = activeList.filter(d => REGIONS[state.selectedRegion].test(d.lon, d.lat));
            const biggest = d3.greatest(inRegion, d => d.mag);
            if (biggest) {
                notes.push(annoAtQuake(biggest, 40, -50,
                    `Region max: M${biggest.mag.toFixed(1)}`, shorten(biggest.place)));
            }
        }
    }

    if (typeof d3.annotation !== "function" || typeof d3.annotationCalloutCircle !== "function" || !notes.length) return;
    const maker = d3.annotation()
        .type(d3.annotationCalloutCircle)
        .annotations(notes);
    gAnno.call(maker);
}


/* TRIGGER
UI events change state parameters and then call render().
*/
function wireTriggers() {
    d3.select("#next-btn").on("click", () => goToScene(state.scene + 1));
    d3.select("#back-btn").on("click", () => goToScene(state.scene - 1));

    d3.select("#mag-slider").on("input", function () {
        state.minMagnitude = Number(this.value);
        d3.select("#mag-val").text(state.minMagnitude.toFixed(1));
        render();
    });

    d3.selectAll(".depth-btn").on("click", function () {
        state.selectedDepthCategory = this.getAttribute("data-depth");
        syncDepthButtons();
        render();
    });

    d3.select("#region-select").on("change", function () {
        if (this.value === "global") resetZoom(true);
        else drillToRegion(this.value);
    });

    d3.select("#sort-select").on("change", function () {
        state.sortBy = this.value;
        render();
    });

    d3.select("#top-10-checkbox").on("change", function () {
        state.showTopEarthquakes = this.checked;
        render();
    });

    d3.select("#reset-btn").on("click", () => {
        Object.assign(state, {
            minMagnitude: 4.5,
            selectedDepthCategory: "all",
            selectedRegion: "global",
            showTopEarthquakes: false,
            selectedEarthquakeId: null,
            sortBy: "time",
        });
        d3.select("#mag-slider").property("value", 4.5);
        d3.select("#sort-select").property("value", "time");
        d3.select("#region-select").property("value", "global");
        d3.select("#top-10-checkbox").property("checked", false);
        syncDepthButtons();
        resetZoom(true);
        render();
    });

    d3.select("#detail-close").on("click", () => {
        state.selectedEarthquakeId = null;
        render();
    });

    // Click on empty ocean to close the details. 
    svg.on("click.clear-selection", () => {
        if (state.selectedEarthquakeId) {
            state.selectedEarthquakeId = null;
            render();
        }
    });
}



/* All other functions */
function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function initializeChart() {
    // Chart setup.
    svg = d3.select("#map");
    gZoom = svg.append("g").attr("class", "zoom-layer");
    gLand = gZoom.append("g").attr("class", "land");
    gGrat = gZoom.append("g").attr("class", "graticule-layer");
    gHot = gZoom.append("g").attr("class", "hotspots");
    gQuakes = gZoom.append("g").attr("class", "quakes");
    gAnno = svg.append("g").attr("class", "annotation-group");
    tooltip = d3.select("#tooltip");

    projection = d3.geoNaturalEarth1().rotate([-160, 0]);
    path = d3.geoPath(projection);
    graticule = d3.geoGraticule10();
    rScale = d3.scalePow().exponent(1.7).domain([4.5, 8]).range([2.6, 20]).clamp(true);
    zoom = d3.zoom()
        .scaleExtent([1, 14])
        .filter(event => state.scene === 3 && !event.button)
        .on("zoom", onZoom);
    svg.call(zoom);
}

function loadData() {
    // Load data. Default: use pre-download static snapshot.
    Promise.all([
        d3.json(DATA_URL).catch(() => DATA_MODE === "live" ? d3.json(STATIC_URL) : null),
        d3.json("data/countries-110m.json"),
    ]).then(([raw, world]) => {
        if (!raw || !Array.isArray(raw.features) || !raw.features.length) {
            throw new Error(`No earthquake features returned from ${DATA_URL}`);
        }
        finishLoad(raw, world);
    }).catch(showLoadError);
}

function finishLoad(raw, world) {
    if (!world || !world.objects || !world.objects.countries) {
        throw new Error("World map data is missing the countries object.");
    }

    WORLD = topojson.feature(world, world.objects.countries).features;
    QUAKES = raw.features.map((feature, index) => {
        const properties = feature.properties || {};
        const coordinates = feature.geometry && feature.geometry.coordinates;
        const lon = Number(coordinates && coordinates[0]);
        const lat = Number(coordinates && coordinates[1]);
        const depthValue = Number(coordinates && coordinates[2]);
        const depth = Number.isFinite(depthValue) ? depthValue : 0;
        const mag = Number(properties.mag);
        return {
            id: feature.id || `quake-${index}`,
            time: Number(properties.time) || 0,
            place: properties.place || "Unknown location",
            lon,
            lat,
            depth,
            mag,
            magType: properties.magType || "",
            url: properties.url || "",
            depthCat: depth < 70 ? "shallow" : depth < 300 ? "intermediate" : "deep",
        };
    }).filter(d => Number.isFinite(d.lon) && Number.isFinite(d.lat) && Number.isFinite(d.mag));

    QUAKES.sort((a, b) => b.mag - a.mag);
    const generated = raw.metadata && raw.metadata.generated;
    const asOf = generated ? new Date(generated) : null;
    const dateText = asOf && !Number.isNaN(asOf.valueOf()) ? ` · as of ${asOf.toLocaleDateString()}` : "";
    const source = DATA_MODE === "live" ? "live USGS feed" : "downloaded snapshot";
    d3.select("#data-source-note").text(`${source} · ${QUAKES.length} events${dateText}`);

    buildProgress();
    buildNavDots();
    wireTriggers();
    sizeAndDraw();
    goToScene(1);
    d3.select("#loading").classed("hidden", true);
}


function sizeAndDraw() {
    // Resize the map, reflect the current parameters.
    const rect = document.getElementById("stage").getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    projection.fitExtent([[5, 5], [width - 5, height - 5]], { type: "Sphere" });
    gLand.selectAll("path.sphere").data([{ type: "Sphere" }]).join("path").attr("class", "sphere").attr("d", path);
    gGrat.selectAll("path.graticule").data([graticule]).join("path").attr("class", "graticule").attr("d", path);
    gLand.selectAll("path.country").data(WORLD).join("path").attr("class", "country").attr("d", path);
    drawQuakes();
    render();
}

function drawQuakes() {
    // Create one SVG circle for every earthquake feature.
    gQuakes.selectAll("circle.quake")
        .data(QUAKES, d => d.id)
        .join("circle")
        .attr("class", "quake")
        .attr("cx", projX)
        .attr("cy", projY)
        .on("mousemove", onHover)
        .on("mouseleave", hideTooltip)
        .on("click", (event, d) => {
            event.stopPropagation();
            selectQuake(d.id);
        });
}

function selectQuake(id) {
    state.selectedEarthquakeId = id;
    render();
}

// Projection helpers.
function projX(quake) {
    const point = projection([quake.lon, quake.lat]);
    return point ? point[0] : -99;
}

function projY(quake) {
    const point = projection([quake.lon, quake.lat]);
    return point ? point[1] : -99;
}


function render() {
    // Use render() to reflect state parameters onto the chart.
    const scene = SCENES[state.scene - 1];
    const { topIds } = computeActive();
    gQuakes.selectAll("circle.quake")
        .each(function (d) { d.__active = isActive(d); })
        .attr("cx", projX)
        .attr("cy", projY)
        .attr("r", d => displayRadius(d, scene, topIds) / currentK)
        .attr("fill", d => fillFor(d, scene))
        .attr("stroke", d => d.id === state.selectedEarthquakeId ? "#1b2430" : "none")
        .attr("stroke-width", d => (d.id === state.selectedEarthquakeId ? 2.4 : 0) / currentK)
        .style("display", d => d.__active ? null : "none")
        .attr("fill-opacity", d => opacityFor(d, scene))
        .classed("spotlight", d => state.showTopEarthquakes && topIds.has(d.id))
        .classed("dim", d => state.showTopEarthquakes && !topIds.has(d.id));

    // Sort controls the SVG paint order, so the last earthquake in the order appears on top.
    gQuakes.selectAll("circle.quake").sort((a, b) => {
        if (state.sortBy === "mag") return a.mag - b.mag;
        if (state.sortBy === "depth") return b.depth - a.depth;
        return a.time - b.time;
    });

    updateControlsVisibility(scene);
    updateSceneCard(scene);
    updateLegend(scene);
    updateProgress();
    updateNavDots();
    updateHotspots(scene);
    updateRegionStats();
    updateDetail();
    renderAnnotations(scene);
}

// Filtering helpers
function isActive(quake, options = {}) {
    const ignoreDepth = options.ignoreDepth === true;
    if (quake.mag < state.minMagnitude) return false;
    if (!ignoreDepth && state.selectedDepthCategory !== "all" && quake.depthCat !== state.selectedDepthCategory) return false;
    if (state.selectedRegion !== "global" && !REGIONS[state.selectedRegion].test(quake.lon, quake.lat)) return false;
    return true;
}

function computeActive() {
    const active = QUAKES.filter(isActive);
    const spotlightPool = state.selectedDepthCategory === "all"
        ? QUAKES.filter(quake => isActive(quake, { ignoreDepth: true }))
        : active;
    return {
        activeList: active,
        topIds: new Set(spotlightPool.slice().sort((a, b) => b.mag - a.mag).slice(0, 10).map(d => d.id)),
    };
}

function updateControlsVisibility(scene) {
    // Only display the controls that belong to the current narrative scene.
    const visible = {
        magnitude: scene.key !== "depth",
        depth: scene.key !== "overview",
        region: scene.key === "explore",
        sort: scene.key === "explore",
        top: scene.key === "explore",
        reset: scene.key === "explore",
    };
    d3.selectAll(".control-group[data-control]").each(function () {
        this.hidden = visible[this.dataset.control] === false;
    });
}

function updateSceneCard(scene) {
    // Update the narrative card and synchronize its controls with the state.
    d3.select("#scene-num").text(state.scene);
    d3.select("#scene-total").text(SCENES.length);
    d3.select("#scene-kicker").text(scene.kicker);
    d3.select("#scene-title").text(scene.title);
    d3.select("#scene-narrative").html(scene.narrative());
    d3.select("#mag-slider").property("value", state.minMagnitude);
    d3.select("#mag-val").text(state.minMagnitude.toFixed(1));
    d3.select("#region-select").property("value", state.selectedRegion);
    d3.select("#sort-select").property("value", state.sortBy);
    d3.select("#top-10-checkbox").property("checked", state.showTopEarthquakes);
    syncDepthButtons();
    d3.select("#back-btn").property("disabled", state.scene === 1);
    d3.select("#next-btn").style("visibility", state.scene === SCENES.length ? "hidden" : "visible");
}

function updateLegend(scene) {
    // The legend changes from magnitude size to focal-depth color.
    const legend = d3.select("#legend");
    if (legend.empty()) return;
    if (scene.colorByDepth) {
        legend.html(`<h4>Magnitude and focal depth</h4>
            <div class="legend-row"><b>Depth color</b></div>
            ${Object.entries(DEPTH).map(([, value]) => `<div class="legend-row"><span class="legend-swatch" style="width:10px;height:10px;background:${value.color}"></span>${value.label} (${value.hi === Infinity ? `${value.lo}+` : `${value.lo}–${value.hi}`} km)</div>`).join("")}
            <div class="legend-row" style="margin-top:10px"><b>Magnitude size</b></div>
            <div class="legend-size-row">${[4.5, 5.5, 6.5].map(mag => `<div class="legend-size"><span class="dot" style="width:${rScale(mag) * 2}px;height:${rScale(mag) * 2}px"></span><span>M${mag}</span></div>`).join("")}</div>`);
    } else {
        legend.html(`<h4>Magnitude</h4><div class="legend-size-row">${[4.5, 5.5, 6.5].map(mag => `<div class="legend-size"><span class="dot" style="width:${rScale(mag) * 2}px;height:${rScale(mag) * 2}px"></span><span>M${mag}</span></div>`).join("")}</div>`);
    }
}

function updateProgress() {
    d3.selectAll(".prog-seg")
        .classed("done", (d, i) => i < state.scene - 1)
        .classed("active", (d, i) => i === state.scene - 1);
}

function buildProgress() {
    d3.select("#scene-progress").html(SCENES.map((_, i) => `<span class="prog-seg" aria-label="Scene ${i + 1}"></span>`).join(""));
}

function buildNavDots() {
    d3.select("#nav-dots").html(SCENES.map((_, i) => `<button class="nav-dot" data-scene="${i + 1}" aria-label="Go to scene ${i + 1}"></button>`).join(""));
    d3.selectAll(".nav-dot").on("click", function () {
        goToScene(Number(this.dataset.scene));
    });
}

function updateNavDots() {
    d3.selectAll(".nav-dot").classed("active", function () {
        return Number(this.dataset.scene) === state.scene;
    });
}

function updateHotspots(scene) {
    const showBoxes = scene.key === "explore" && state.selectedRegion === "global";
    const data = showBoxes ? REGION_ORDER.map(key => ({ key, ...REGIONS[key] })) : [];
    const boxes = gHot.selectAll("g.hot").data(data, d => d.key);
    boxes.exit().remove();
    const enter = boxes.enter().append("g").attr("class", "hot").style("cursor", "pointer");
    enter.on("click", (event, d) => {
        event.stopPropagation();
        drillToRegion(d.key);
    });
    enter.append("rect").attr("class", "hotspot");
    enter.append("text").attr("class", "hotspot-label");

    gHot.selectAll("g.hot").each(function (d) {
        const box = regionPixelBox(d.key, 8);
        d3.select(this).select("rect")
            .attr("x", box.x0)
            .attr("y", box.y0)
            .attr("width", Math.max(0, box.x1 - box.x0))
            .attr("height", Math.max(0, box.y1 - box.y0));
        d3.select(this).select("text")
            .attr("x", box.x0 + 6)
            .attr("y", box.y0 - 6)
            .text(d.name);
    });
}

function drillToRegion(key) {
    if (!REGIONS[key]) return;
    state.selectedRegion = key;
    d3.select("#region-select").property("value", key);
    const box = regionPixelBox(key, 20);
    const regionWidth = Math.max(1, box.x1 - box.x0);
    const regionHeight = Math.max(1, box.y1 - box.y0);
    const scale = Math.max(1, Math.min(12, 0.85 / Math.max(regionWidth / width, regionHeight / height)));
    const centerX = (box.x0 + box.x1) / 2;
    const centerY = (box.y0 + box.y1) / 2;
    const transform = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-centerX, -centerY);
    svg.interrupt().call(zoom.transform, transform);
    render();
}

function regionPixelBox(key, pad) {
    const bounds = REGION_BOUNDS[key];
    const coordinates = bounds
        ? [[bounds[0], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[1]], [bounds[2], bounds[3]]]
        : QUAKES.filter(d => REGIONS[key].test(d.lon, d.lat)).map(d => [d.lon, d.lat]);
    const points = coordinates
        .map(point => projection(point))
        .filter(point => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (!points.length) return { x0: 0, y0: 0, x1: width, y1: height };
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    return {
        x0: Math.min(...xs) - pad,
        y0: Math.min(...ys) - pad,
        x1: Math.max(...xs) + pad,
        y1: Math.max(...ys) + pad,
    };
}

// Region statistics summarize all earthquakes in the selected geographic box.
function updateRegionStats() {
    const panel = document.getElementById("region-stats");
    const show = SCENES[state.scene - 1].key === "explore" && state.selectedRegion !== "global";
    panel.hidden = !show;
    if (!show) return;

    const region = REGIONS[state.selectedRegion];
    const events = QUAKES.filter(d => region.test(d.lon, d.lat));
    d3.select("#region-stats-title").text(region.name);
    if (!events.length) {
        d3.select("#rs-count").text("0");
        d3.select("#rs-max").text("–");
        d3.select("#rs-depth").text("–");
        d3.select("#rs-shallow").text("–");
        return;
    }
    const shallow = events.filter(d => d.depthCat === "shallow").length;
    d3.select("#rs-count").text(events.length);
    d3.select("#rs-max").text(`M${d3.max(events, d => d.mag).toFixed(1)}`);
    d3.select("#rs-depth").text(`${Math.round(d3.mean(events, d => d.depth))} km`);
    d3.select("#rs-shallow").text(`${Math.round(100 * shallow / events.length)}%`);
}

function updateDetail() {
    const panel = d3.select("#detail");
    const quake = QUAKES.find(d => d.id === state.selectedEarthquakeId);
    if (!quake) {
        panel.property("hidden", true);
        return;
    }
    panel.property("hidden", false);
    d3.select("#detail-body").html(`<span class="big">M${quake.mag.toFixed(1)} · ${escapeHtml(quake.place)}</span><div class="row"><b>Depth:</b> ${quake.depth.toFixed(1)} km</div><div class="row"><b>Time:</b> ${new Date(quake.time).toLocaleString()}</div><div class="row"><b>Type:</b> ${escapeHtml(quake.magType || "Unknown")}</div>${quake.url ? `<div class="row"><a href="${escapeAttribute(quake.url)}" target="_blank" rel="noopener">Open USGS event</a></div>` : ""}`);
}

function escapeAttribute(value) {
    return escapeHtml(value);
}

function annoAt(lon, lat, dx, dy, title, label) {
    // Annotation at the latitude & longitude.
    const p = projection([lon, lat]);
    const [x, y] = applyK(p);
    const offset = keepAnnotationInside(x, y, dx, dy);
    return {
        note: { title, label, wrap: 180, align: "dynamic", padding: 5 },
        x, y, dx: offset.dx, dy: offset.dy,
        subject: { radius: 20, radiusPadding: 2 },
        className: "callout-circle",
    };
}

function annoAtQuake(d, dx, dy, title, label) {
    const [x, y] = applyK([projX(d), projY(d)]);
    const offset = keepAnnotationInside(x, y, dx, dy);
    return {
        note: { title, label, wrap: 180, align: "dynamic", padding: 5 },
        x, y, dx: offset.dx, dy: offset.dy,
        subject: { radius: Math.max(12, rScale(d.mag) + 6), radiusPadding: 2 },
        className: "callout-circle",
    };
}

function applyK(point) {
    if (!point) return [0, 0];
    const transform = svg && svg.node() ? d3.zoomTransform(svg.node()) : d3.zoomIdentity;
    return [transform.applyX(point[0]), transform.applyY(point[1])];
}

function keepAnnotationInside(x, y, dx, dy) {
    const margin = 12;
    const noteWidth = 210;
    const noteHeight = 78;
    const minX = margin + noteWidth / 2;
    const maxX = Math.max(minX, width - margin - noteWidth / 2);
    const minY = margin + noteHeight / 2;
    const maxY = Math.max(minY, height - margin - noteHeight / 2);
    const targetX = Math.max(minX, Math.min(maxX, x + dx));
    const targetY = Math.max(minY, Math.min(maxY, y + dy));
    return { dx: targetX - x, dy: targetY - y };
}


function goToScene(number) {
    // Scene navigation.
    state.scene = Math.max(1, Math.min(SCENES.length, number));
    state.selectedEarthquakeId = null;
    if (gAnno) gAnno.selectAll("*").remove();
    SCENES[state.scene - 1].onEnter();
    render();
}

function resetZoom(animate) {
    state.selectedRegion = "global";
    d3.select("#region-select").property("value", "global");
    if (animate) {
        svg.transition().duration(800).call(zoom.transform, d3.zoomIdentity).on("end", render);
    } else {
        svg.call(zoom.transform, d3.zoomIdentity);
    }
}

function onZoom(event) {
    currentK = event.transform.k;
    gZoom.attr("transform", event.transform);
    gLand.selectAll("path.country").attr("stroke-width", 0.5 / currentK);
    gGrat.selectAll("path.graticule").attr("stroke-width", 0.4 / currentK);
    gHot.selectAll("rect.hotspot")
        .attr("stroke-width", 1.2 / currentK)
        .attr("stroke-dasharray", `${5 / currentK} ${4 / currentK}`);
    gHot.selectAll("text.hotspot-label").attr("font-size", 11 / currentK);

    // rescale quakes so they keep a constant screen size
    const scene = SCENES[state.scene - 1];
    const topIds = computeActive().topIds;
    gQuakes.selectAll("circle.quake")
        .attr("r", d => displayRadius(d, scene, topIds) / currentK)
        .attr("stroke-width", d => (d.id === state.selectedEarthquakeId ? 2.4 : 0) / currentK);
    render();
}

function baseRadius(quake, scene) {
    return scene.uniformSize ? 3.1 : rScale(quake.mag);
}

function displayRadius(quake, scene, topIds) {
    const radius = baseRadius(quake, scene);
    return state.showTopEarthquakes && topIds.has(quake.id) ? radius * 1.45 : radius;
}

function opacityFor(quake, scene) {
    if (scene.emphasizeShallow && state.selectedDepthCategory === "all") {
        return quake.depthCat === "shallow" ? 0.92 : 0.28;
    }
    return scene.uniformSize ? 0.72 : 0.82;
}

function fillFor(quake, scene) {
    return scene.colorByDepth ? DEPTH[quake.depthCat].color : COLORS.uniform;
}

function syncDepthButtons() {
    d3.selectAll(".depth-btn").classed("is-active", function () {
        return this.getAttribute("data-depth") === state.selectedDepthCategory;
    });
}

// Tooltip helpers
function onHover(event, quake) {
    const category = DEPTH[quake.depthCat];
    const stage = document.getElementById("stage").getBoundingClientRect();
    tooltip.property("hidden", false).html(`
        <div class="tt-mag">M ${quake.mag.toFixed(1)} <span style="font-size:11px;color:var(--ink-faint)">${escapeHtml(quake.magType || "")}</span></div>
        <div class="tt-place">${escapeHtml(quake.place)}</div>
        <div class="tt-meta"><span class="tt-chip" style="background:${category.color}"></span>${category.label} ${Math.round(quake.depth)} km deep<br>${fmtTime(quake.time)}</div>
    `);
    const tooltipNode = tooltip.node();
    const x = Math.min(event.clientX - stage.left + 15, stage.width - tooltipNode.offsetWidth - 8);
    const y = Math.min(event.clientY - stage.top + 15, stage.height - tooltipNode.offsetHeight - 8);
    tooltip.style("left", `${Math.max(8, x)}px`).style("top", `${Math.max(8, y)}px`);
}

function hideTooltip() {
    tooltip.property("hidden", true);
}



function byId(id) {
    return id == null ? null : QUAKES.find(d => d.id === id);
}

function debounce(callback, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => callback(...args), delay);
    };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[character]));
}

function fmtTime(milliseconds) {
    const date = new Date(milliseconds);
    return `Local time: ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function magEnergyRatio(magnitude, reference) {
    return Math.round(Math.pow(10, 1.5 * (magnitude - reference)));
}

function shorten(value) {
    return value.length > 40 ? `${value.slice(0, 40)}...` : value;
}

function showLoadError(error) {
    console.error("Unable to load earthquake visualization data:", error);
    d3.select("#loading").text("Could not load earthquake data. Check the browser console.");
}
