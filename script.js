/* =========================================================
   SECTION 1: MAP SETUP
   =========================================================
   Same as before -- Leaflet creates the map, we add a tile layer
   (the visual street map images) on top of it.
*/
const map = L.map('map').setView([26.9124, 75.7873], 12);

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
  maxZoom: 19
}).addTo(map);


/* =========================================================
   SECTION 2: ROUTES
   =========================================================
   Instead of one hardcoded route, we now have 5 routes spread
   across different areas of Jaipur (approximate coordinates --
   good enough for a demo, not survey-accurate). 40 buses will
   be split across these 5 routes (8 buses per route).

   Each route is just a list of [lat, lon] points -- a bus
   "walks" through this list step by step, looping back to the
   start when it reaches the end.
*/
const ROUTES = [
  {
    id: 'R1', name: 'Central Loop',
    points: [
      [26.9124, 75.7873], [26.9155, 75.7900], [26.9200, 75.7950],
      [26.9260, 75.8010], [26.9310, 75.8080], [26.9350, 75.8150],
      [26.9200, 75.8200], [26.9100, 75.8100], [26.9050, 75.7980],
      [26.9124, 75.7873]
    ]
  },
  {
    id: 'R2', name: 'Malviya Nagar - Tonk Rd',
    points: [
      [26.8510, 75.8100], [26.8480, 75.8160], [26.8430, 75.8210],
      [26.8370, 75.8250], [26.8320, 75.8200], [26.8380, 75.8140],
      [26.8450, 75.8090], [26.8510, 75.8100]
    ]
  },
  {
    id: 'R3', name: 'Vaishali Nagar - Ajmer Rd',
    points: [
      [26.9130, 75.7400], [26.9080, 75.7460], [26.9020, 75.7520],
      [26.8960, 75.7580], [26.8900, 75.7530], [26.8960, 75.7460],
      [26.9040, 75.7410], [26.9130, 75.7400]
    ]
  },
  {
    id: 'R4', name: 'Jagatpura - Sitapura',
    points: [
      [26.8150, 75.8500], [26.8100, 75.8560], [26.8040, 75.8610],
      [26.7980, 75.8560], [26.8020, 75.8480], [26.8090, 75.8440],
      [26.8150, 75.8500]
    ]
  },
  {
    id: 'R5', name: 'Sanganer - Airport',
    points: [
      [26.8242, 75.8122], [26.8190, 75.8060], [26.8130, 75.8000],
      [26.8070, 75.7950], [26.8130, 75.7890], [26.8200, 75.7940],
      [26.8242, 75.8122]
    ]
  }
];

// Defect types the system is meant to catch (from the PS, not just potholes)
const defectTypes = ['Pothole', 'Missing Zebra Crossing', 'Damaged Traffic Signboard', 'Missing Road Divider', 'Waterlogging'];


/* =========================================================
   SECTION 3: FLEET SETUP -- 40 buses
   =========================================================
   Each bus is a plain JS object (like a struct in C++) holding
   everything we need to know about it: which route it's on,
   where it currently is along that route, whether it's online,
   and its Leaflet marker.
*/
const TOTAL_BUSES = 40;
let buses = [];       // will hold all 40 bus objects
let events = [];      // will hold every detected defect/incident
let simulationRunning = false;
let tickHandle = null;
let heatPoints = [];
let heatLayer = null;
let routeLines = {}; // one Leaflet polyline per route, recolored based on delay

// Draw all 5 routes as lines on the map (called once at startup/reset).
// Colors get updated live in updateRouteLineColors() as delay changes.
function initRouteLines() {
  ROUTES.forEach(r => {
    routeLines[r.id] = L.polyline(r.points, {
      color: '#16a34a', // starts green (low delay)
      weight: 5,
      opacity: 0.7
    }).addTo(map);
  });
}

// Recolors each route line based on its current delay -- same idea as
// Google Maps traffic coloring: green = fine, amber = moderate, red = bad.
function updateRouteLineColors() {
  ROUTES.forEach(r => {
    const delay = routeDelays[r.id] || 0;
    let color = '#16a34a';       // green: low delay
    if (delay > 12) color = '#dc2626';      // red: high delay
    else if (delay > 5) color = '#d97706';  // amber: medium delay
    if (routeLines[r.id]) routeLines[r.id].setStyle({ color });
  });
}

function makeIcon(emoji, color, size) {
  return L.divIcon({
    html: `<div class="event-icon" style="background:${color}; width:${size}px; height:${size}px; font-size:${size*0.55}px;">${emoji}</div>`,
    className: '',
    iconSize: [size, size]
  });
}
const busIcon = makeIcon('🚌', '#2563eb', 30);
const defectIcon = makeIcon('⚠️', '#d97706', 34);
const incidentIcon = makeIcon('🚨', '#dc2626', 34);

// Build 40 buses, spread evenly across the 5 routes (8 each)
function initFleet() {
  buses = [];
  for (let i = 0; i < TOTAL_BUSES; i++) {
    const route = ROUTES[i % ROUTES.length];
    // Stagger starting position along the route so buses aren't
    // all bunched at the same point when the simulation starts
    const startIndex = Math.floor((i / ROUTES.length)) % route.points.length;

    buses.push({
      id: `B-${101 + i}`,
      routeId: route.id,
      routeName: route.name,
      routePoints: route.points,
      posIndex: startIndex,
      status: 'Active',       // 'Active' or 'Offline'
      syncStatus: 'Synced',   // 'Synced' or 'Buffered'
      lastPing: null,
      marker: null
    });
  }
}


/* =========================================================
   SECTION 4: ROUTE DELAY TRACKING
   =========================================================
   Each route accumulates its own delay total as defects/incidents
   happen along it -- used by the Dashboard tab's delay report.
*/
let routeDelays = {}; // e.g. { R1: 3.4, R2: 1.2, ... }
function resetDelays() {
  routeDelays = {};
  ROUTES.forEach(r => routeDelays[r.id] = 0);
}

/* =========================================================
   SECTION 5: TRAFFIC DENSITY (simulated vehicle counts per route)
   =========================================================
   Real system would get this from vehicle-detection/counting
   models. Here we simulate a plausible number per route each tick.
*/
let trafficDensity = {}; // e.g. { R1: 42, R2: 15, ... }


/* =========================================================
   SECTION 6: REVERSE GEOCODING (lat/lon -> readable address)
   ========================================================= */
function reverseGeocode(lat, lon, callback) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=17&addressdetails=1`;
  fetch(url)
    .then(res => res.json())
    .then(data => callback(data.display_name ? data.display_name.split(',').slice(0, 3).join(', ') : 'Address unavailable'))
    .catch(() => callback('Address lookup failed'));
}


/* =========================================================
   SECTION 7: PRIORITY LOGIC
   =========================================================
   Incidents (rash driving etc.) are always High priority --
   they involve an active safety risk. Defects are graded by
   confidence score: higher confidence = more urgent to act on.
*/
function getPriority(category, confidence) {
  if (category === 'incident') return 'High';
  if (confidence >= 85) return 'High';
  if (confidence >= 70) return 'Medium';
  return 'Low';
}
function priorityPillClass(priority) {
  if (priority === 'High') return 'pill pill-high';
  if (priority === 'Medium') return 'pill pill-medium';
  return 'pill pill-low';
}


/* =========================================================
   SECTION 8: ONE SIMULATION "TICK"
   =========================================================
   Every 1.2 seconds, this function runs once and:
   1. Moves every bus one step along its route
   2. Randomly flips a few buses online/offline (simulates lost signal)
   3. Randomly generates defect/incident events
   4. Updates traffic density numbers
   5. Re-renders every table/panel on screen
*/
function tick() {
  // Delay slowly "clears" over time (like traffic easing) -- keeps the
  // number moving in both directions instead of only ever climbing
  ROUTES.forEach(r => {
    routeDelays[r.id] = Math.max(0, (routeDelays[r.id] || 0) - 0.15);
  });

  buses.forEach(bus => {
    // --- 1. Move the bus ---
    bus.posIndex = (bus.posIndex + 1) % bus.routePoints.length;
    const [lat, lng] = bus.routePoints[bus.posIndex];

    // --- 2. Randomly simulate connectivity loss (5% chance per tick) ---
    if (Math.random() < 0.05) {
      bus.status = bus.status === 'Active' ? 'Offline' : 'Active';
    }
    bus.syncStatus = bus.status === 'Active' ? 'Synced' : 'Buffered';
    bus.lastPing = new Date().toLocaleTimeString();

    // --- Draw/move the bus marker (only if online, matches "no live feed when offline") ---
    if (bus.status === 'Active') {
      if (!bus.marker) {
        bus.marker = L.marker([lat, lng], { icon: busIcon }).addTo(map);
        bus.marker.bindPopup(`Bus ${bus.id}<br>Route: ${bus.routeName}`);
      } else {
        bus.marker.setLatLng([lat, lng]);
      }
      heatPoints.push([lat, lng, 0.3]);
    } else if (bus.marker) {
      map.removeLayer(bus.marker);
      bus.marker = null;
    }

    // --- 3. Randomly generate a defect or incident ---
    if (bus.status === 'Active') {
      const roll = Math.random();
      if (roll < 0.08) createEvent(bus, 'defect', lat, lng);
      else if (roll < 0.11) createEvent(bus, 'incident', lat, lng);
    }
  });

  if (heatLayer) heatLayer.setLatLngs(heatPoints);

  // --- 4. Update traffic density per route (simulated) ---
  ROUTES.forEach(r => {
    // Random walk so numbers feel "live" rather than static
    const prev = trafficDensity[r.id] || 20;
    const change = Math.floor(Math.random() * 11) - 5; // -5 to +5
    trafficDensity[r.id] = Math.max(5, Math.min(80, prev + change));
  });

  // --- 5. Re-render everything on screen ---
 // updateRouteLineColors();
  renderDashboard();
  renderFleetTable();
  renderIncidentsTable();
}

// Creates one defect or incident event, adds it to the events list and the map
function createEvent(bus, category, lat, lng) {
  const type = category === 'incident' ? 'Rash Driving' : defectTypes[Math.floor(Math.random() * defectTypes.length)];
  const confidence = +(70 + Math.random() * 25).toFixed(1);
  const priority = getPriority(category, confidence);
  const offsetLat = lat + (Math.random() - 0.5) * 0.0015;
  const offsetLng = lng + (Math.random() - 0.5) * 0.0015;

  const event = {
    id: 'E-' + (events.length + 1),
    type, category, priority, confidence,
    lat: offsetLat, lng: offsetLng,
    busId: bus.id, routeName: bus.routeName,
    time: new Date().toLocaleTimeString(),
    syncStatus: bus.syncStatus,
    address: 'Looking up...'
  };
  events.unshift(event); // newest first

  const icon = category === 'incident' ? incidentIcon : defectIcon;
  const marker = L.marker([offsetLat, offsetLng], { icon }).addTo(map);
  marker.bindPopup(`<b>${type}</b><br>Confidence: ${confidence}%<br>Bus: ${bus.id}<br>Priority: ${priority}`);
  heatPoints.push([lat, lng, category === 'incident' ? 1.2 : 1.0]);

  reverseGeocode(offsetLat, offsetLng, (addr) => { event.address = addr; });

  // Delay grows more for incidents than defects -- capped so it never
  // climbs into unrealistic triple digits over a long-running demo
  const routeId = bus.routeId;
  const increment = category === 'incident' ? (2 + Math.random() * 4) : (1 + Math.random() * 3);
  const MAX_ROUTE_DELAY = 18; // minutes -- realistic ceiling for a single route
  routeDelays[routeId] = Math.min((routeDelays[routeId] || 0) + increment, MAX_ROUTE_DELAY);
}


/* =========================================================
   SECTION 9: DASHBOARD TAB RENDERING
   ========================================================= */
function renderDashboard() {
  const activeCount = buses.filter(b => b.status === 'Active').length;
  const defectCount = events.filter(e => e.category === 'defect').length;
  const incidentCount = events.filter(e => e.category === 'incident').length;
  const totalDelay = Object.values(routeDelays).reduce((a, b) => a + b, 0);
  const avgDelay = (totalDelay / ROUTES.length).toFixed(1);

  document.getElementById('dash-active-buses').textContent = `${activeCount} / ${TOTAL_BUSES}`;
  document.getElementById('dash-defects').textContent = defectCount;
  document.getElementById('dash-incidents').textContent = incidentCount;
  document.getElementById('dash-delay').textContent = avgDelay + ' min';
  document.getElementById('delay-badge-value').textContent = avgDelay + ' min';

  // Traffic density panel (colored bars per route)
  const trafficDiv = document.getElementById('traffic-panel-list');
  trafficDiv.innerHTML = '';
  ROUTES.forEach(r => {
    const density = trafficDensity[r.id] || 20;
    let level = 'Low', color = '#16a34a';
    if (density > 55) { level = 'High'; color = '#dc2626'; }
    else if (density > 30) { level = 'Medium'; color = '#d97706'; }

    trafficDiv.innerHTML += `
      <div class="traffic-row">
        <div class="traffic-route-name">${r.name}</div>
        <div class="traffic-bar-track">
          <div class="traffic-bar-fill" style="width:${density}%; background:${color};"></div>
        </div>
        <div class="traffic-level-label" style="color:${color};">${level}</div>
      </div>`;
  });

  // Route delay report table
  const delayBody = document.getElementById('delay-report-body');
  delayBody.innerHTML = '';
  ROUTES.forEach(r => {
    const busesOnRoute = buses.filter(b => b.routeId === r.id).length;
    const delay = (routeDelays[r.id] || 0).toFixed(1);
    delayBody.innerHTML += `<tr><td>${r.name}</td><td>${busesOnRoute}</td><td>${delay} min</td></tr>`;
  });
}


/* =========================================================
   SECTION 10: FLEET MONITORING TAB RENDERING
   ========================================================= */
function renderFleetTable() {
  const body = document.getElementById('fleet-table-body');
  body.innerHTML = '';
  buses.forEach(bus => {
    const statusPill = bus.status === 'Active' ? 'pill pill-active' : 'pill pill-offline';
    const syncPill = bus.syncStatus === 'Synced' ? 'pill pill-synced' : 'pill pill-buffered';
    body.innerHTML += `
      <tr>
        <td>${bus.id}</td>
        <td>${bus.routeName}</td>
        <td><span class="${statusPill}">${bus.status}</span></td>
        <td><span class="${syncPill}">${bus.syncStatus}</span></td>
        <td>${bus.lastPing || '-'}</td>
      </tr>`;
  });
}


/* =========================================================
   SECTION 11: INCIDENTS TAB RENDERING + DETAIL MODAL
   ========================================================= */
function renderIncidentsTable() {
  const body = document.getElementById('incidents-table-body');
  body.innerHTML = '';
  // Show only the most recent 100 events so the table doesn't get huge
  events.slice(0, 100).forEach(ev => {
    const syncPill = ev.syncStatus === 'Synced' ? 'pill pill-synced' : 'pill pill-buffered';
    body.innerHTML += `
      <tr onclick="openDetailModal('${ev.id}')">
        <td>${ev.type}</td>
        <td><span class="${priorityPillClass(ev.priority)}">${ev.priority}</span></td>
        <td>${ev.confidence}%</td>
        <td>${ev.busId}</td>
        <td>${ev.routeName}</td>
        <td>${ev.time}</td>
        <td><span class="${syncPill}">${ev.syncStatus}</span></td>
      </tr>`;
  });
}

function openDetailModal(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;
  document.getElementById('modal-content').innerHTML = `
    <h3>${ev.type}</h3>
    <span class="${priorityPillClass(ev.priority)}">${ev.priority} priority</span>
    <div class="photo-placeholder">Photo evidence (placeholder)</div>
    <p><b>Confidence:</b> ${ev.confidence}%</p>
    <p><b>Bus:</b> ${ev.busId} &nbsp; <b>Route:</b> ${ev.routeName}</p>
    <p><b>Time:</b> ${ev.time}</p>
    <p><b>Location:</b> ${ev.address}</p>
    <button class="secondary" disabled>View Evidence Clip (placeholder)</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
}
function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('open');
}


/* =========================================================
   SECTION 12: TAB SWITCHING
   ========================================================= */
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('tabbtn-' + name).classList.add('active');

  // Leaflet needs a nudge to redraw correctly if the map div was hidden
  if (name === 'map') setTimeout(() => map.invalidateSize(), 100);
}


/* =========================================================
   SECTION 13: SIMULATION CONTROLS
   ========================================================= */
function startSimulation() {
  if (simulationRunning) return;
  simulationRunning = true;
  tickHandle = setInterval(tick, 1200);
}

function resetSimulation() {
  simulationRunning = false;
  clearInterval(tickHandle);

  // Remove all markers from the map
  map.eachLayer(layer => { if (layer instanceof L.Marker) map.removeLayer(layer); });
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  heatPoints = [];

  events = [];
  resetDelays();
  trafficDensity = {};
  initFleet();
 // updateRouteLineColors(); // reset all route lines back to green

  renderDashboard();
  renderFleetTable();
  renderIncidentsTable();
}

function toggleHeatmap() {
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  } else {
    heatLayer = L.heatLayer(heatPoints, { radius: 30, blur: 20, maxZoom: 15 }).addTo(map);
  }
}


/* =========================================================
   SECTION 14: INITIAL PAGE LOAD
   ========================================================= */
initFleet();
resetDelays();
//initRouteLines();
renderDashboard();
renderFleetTable();
renderIncidentsTable();
