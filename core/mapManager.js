/**
 * core/mapManager.js
 *
 * Gestiona el ciclo de vida del mapa único de la aplicación:
 *   - Inicialización de un único Map compartido por dos vistas
 *   - Toggle 2D (MapView) ↔ 3D (SceneView) con sincronización de viewpoint
 *   - Gestión de la máscara visual municipal para recorte de capas WMS
 *   - Zoom al municipio seleccionado
 *   - Cambio de basemap
 *
 * ── UN ÚNICO MAP ─────────────────────────────────────────────────────────
 * MapView y SceneView comparten la misma instancia de Map.
 * Las capas se añaden una sola vez. Ambas vistas las renderizan.
 *
 * ── PATRÓN viewOnReady() ─────────────────────────────────────────────────
 * SDK v5 usa viewOnReady() en lugar del evento arcgisViewReadyChange.
 * La SceneView se inicializa en background para no bloquear el arranque:
 * _sceneReadyPromise guarda la promesa y toggleVista() la awaita solo
 * la primera vez que el usuario activa 3D.
 *
 * ── MÁSCARA MUNICIPAL ────────────────────────────────────────────────────
 * GraphicsLayer con polígono INVERSO al municipio (mundo − municipio),
 * relleno de gris semitransparente. Preserva contexto geográfico exterior.
 * Técnica: geometryEngine.difference(mundo, municipio) → "donut polygon"
 *
 * ── ORDEN DE CAPAS ───────────────────────────────────────────────────────
 * ArcGIS renderiza la primera capa del array abajo y la última arriba.
 * La máscara siempre se reposiciona al final para quedar sobre los datos.
 */

// ── Estado privado ────────────────────────────────────────────────────────
let _map               = null;
let _mapEl             = null;
let _sceneEl           = null;
let _vistaActiva       = "2D";
let _maskLayer         = null;
let _sceneReadyPromise = null;  // Promesa de inicialización 3D en background

// ─── Inicialización ───────────────────────────────────────────────────────

/**
 * Inicializa el Map único y lo asigna a ambos Web Components.
 * Llama una sola vez desde main.js antes de montar la UI.
 *
 * @param {Object} opts
 * @param {string} opts.mapContainerId   - id del <arcgis-map>
 * @param {string} opts.sceneContainerId - id del <arcgis-scene>
 * @returns {Promise<void>}
 */
export async function initMap({ mapContainerId, sceneContainerId }) {
  const [Map, GraphicsLayer] = await Promise.all([
    $arcgis.import("esri/Map"),
    $arcgis.import("esri/layers/GraphicsLayer")
  ]);

  // listMode:"hide" → la máscara no aparece en el árbol de capas ni leyenda.
  // Es infraestructura visual, no un dato geográfico del municipio.
  _maskLayer = new GraphicsLayer({
    id:       "municipio-mask",
    title:    "Máscara municipal",
    listMode: "hide"
  });

  // Sin API Key activa → basemap "osm".
  // La máscara se añade desde el inicio; las capas de datos vienen via addCapas().
  _map = new Map({
    basemap: "osm",
    layers:  [_maskLayer]
  });

  _mapEl   = document.getElementById(mapContainerId);
  _sceneEl = document.getElementById(sceneContainerId);

  if (!_mapEl || !_sceneEl) {
    throw new Error(
      `[mapManager] Elementos no encontrados: "${mapContainerId}", "${sceneContainerId}". ` +
      `Verifica los id en index.html.`
    );
  }

  // Asignar el mismo Map a ambos Web Components.
  // Desde aquí comparten exactamente el mismo array de capas.
  _mapEl.map   = _map;
  _sceneEl.map = _map;

  // viewOnReady() es el patrón correcto en SDK v5.
  // Esperamos solo la vista 2D para no bloquear el arranque de la app.
  await _mapEl.viewOnReady();
  console.info("[mapManager] MapView (2D) lista");

  // Vista inicial centrada en España
  await _mapEl.view.goTo({ center: [-3.7038, 40.4168], zoom: 6 });

  // SceneView en background: se inicializa en paralelo.
  // toggleVista() awaita esta promesa solo la primera vez que se necesite 3D.
  _sceneReadyPromise = _sceneEl.viewOnReady().then(() => {
    console.info("[mapManager] SceneView (3D) lista (background)");
    _sceneEl.view.viewpoint = _mapEl.view.viewpoint.clone();
  });
}

// ─── Toggle 2D / 3D ──────────────────────────────────────────────────────

/**
 * Alterna entre vista 2D y 3D sincronizando la posición de cámara.
 *
 * Patrón basado en el ejemplo oficial Esri SDK v5:
 * https://developers.arcgis.com/javascript/latest/sample-code/views-switch-2d-3d/
 * Diferencia: usamos un único Map compartido en lugar de dos mapas independientes.
 *
 * @returns {Promise<"2D"|"3D">}
 */
export async function toggleVista() {
  // Esperar SceneView solo la primera vez — después ya está resuelta
  if (_sceneReadyPromise) {
    await _sceneReadyPromise;
    _sceneReadyPromise = null;
  }

  const is2D = _vistaActiva === "2D";

  const sourceView = is2D ? _mapEl.view : _sceneEl.view;
  const targetView = is2D ? _sceneEl.view : _mapEl.view;

  // Clonar viewpoint y sincronizar posición antes del cambio visual
  const vp = sourceView.viewpoint.clone();
  await targetView.goTo(vp);

  if (is2D) {
    _sceneEl.classList.add("vista-activa");
    _mapEl.classList.remove("vista-activa");
    _vistaActiva = "3D";
  } else {
    _mapEl.classList.add("vista-activa");
    _sceneEl.classList.remove("vista-activa");
    _vistaActiva = "2D";
  }

  console.info(`[mapManager] Vista cambiada a ${_vistaActiva}`);
  return _vistaActiva;
}

// ─── Getters ──────────────────────────────────────────────────────────────

/**
 * Devuelve el modo actual como string.
 * @returns {"2D"|"3D"}
 */
export function getVistaActiva() {
  return _vistaActiva;
}

/**
 * Devuelve el Map compartido.
 * Útil para módulos que necesiten acceso directo (ej: basemapSelector).
 * @returns {Map|null}
 */
export function getMap() {
  return _map;
}

// ─── Gestión de capas ─────────────────────────────────────────────────────

/**
 * Añade capas al Map compartido eliminando las anteriores.
 * Mantiene siempre la máscara como última capa (renderiza encima de todo).
 *
 * @param {Layer[]} capas - Array de instancias Esri ya inicializadas
 */
export function addCapas(capas) {
  if (!_map) {
    console.error("[mapManager] Map no inicializado. Llama a initMap() primero.");
    return;
  }

  // Retirar solo capas de datos — nunca la máscara
  const capasPrevias = _map.layers
    .filter(l => l.id !== "municipio-mask")
    .toArray();
  _map.layers.removeMany(capasPrevias);

  if (capas.length > 0) {
    _map.layers.addMany(capas);
  }

  // Reposicionar máscara al final → siempre por encima de los datos
  _map.layers.remove(_maskLayer);
  _map.layers.add(_maskLayer);

  console.info(`[mapManager] ${capas.length} capas añadidas al Map`);
}

/**
 * Añade una sola capa al Map (lazy-load on-demand para WFS).
 * La máscara se reposiciona encima.
 * @param {Layer} capa
 */
export function addCapa(capa) {
  if (!_map) return;
  _map.layers.add(capa);
  _map.layers.remove(_maskLayer);
  _map.layers.add(_maskLayer);
}

// ─── Máscara municipal ────────────────────────────────────────────────────

/**
 * Actualiza la máscara visual del municipio seleccionado.
 *
 * TÉCNICA: geometryEngine.difference(mundo, municipio) produce el área
 * exterior al municipio. Se rellena de gris semitransparente para que el
 * contexto geográfico exterior sea visible pero quede en segundo plano.
 *
 * @param {Object} polygon - { rings, spatialReference } de municipios.js
 * @returns {Promise<void>}
 */
export async function actualizarMascara(polygon) {
  if (!_maskLayer) return;

  const [Graphic, Polygon, differenceOperator] = await Promise.all([
    $arcgis.import("esri/Graphic"),
    $arcgis.import("esri/geometry/Polygon"),
    $arcgis.import("esri/geometry/operators/differenceOperator")
  ]);

  const mundo = new Polygon({
    rings: [[
      [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
    ]],
    spatialReference: { wkid: 4326 }
  });

  const municipioPoly = new Polygon({
    rings:            polygon.rings,
    spatialReference: polygon.spatialReference ?? { wkid: 4326 }
  });

  // mundo − municipio = área exterior → efecto de recorte visual
  const exterior = differenceOperator.execute(mundo, municipioPoly);

  _maskLayer.removeAll();

  if (exterior) {
    _maskLayer.add(new Graphic({
      geometry: exterior,
      symbol: {
        type:  "simple-fill",
        color: [210, 210, 210, 0.75],   // gris semitransparente
        outline: {
          color: [30, 100, 200, 1],      // borde azul: límite municipal
          width: 2
        }
      }
    }));
  }

  console.info("[mapManager] Máscara municipal actualizada");
}

/**
 * Elimina la máscara (útil al resetear el municipio seleccionado).
 */
export function limpiarMascara() {
  _maskLayer?.removeAll();
}

// ─── Navegación ───────────────────────────────────────────────────────────

/**
 * Hace zoom al bounding box del municipio en la vista activa.
 * expand(1.2) añade 20% de margen para mostrar contexto geográfico inmediato.
 *
 * @param {number[]} bbox - [xmin, ymin, xmax, ymax] en WGS84
 * @returns {Promise<void>}
 */
export async function irAlMunicipio(bbox) {
  const view = _vistaActiva === "2D" ? _mapEl?.view : _sceneEl?.view;

  if (!view) {
    console.warn("[mapManager] No hay vista activa para hacer zoom");
    return;
  }

  const [Extent] = await Promise.all([
    $arcgis.import("esri/geometry/Extent")
  ]);

  const extent = new Extent({
    xmin: bbox[0], ymin: bbox[1],
    xmax: bbox[2], ymax: bbox[3],
    spatialReference: { wkid: 4326 }
  });

  await view.goTo(extent.expand(1.2), { animate: true, duration: 1200 });
}

// ─── Basemap ──────────────────────────────────────────────────────────────

/**
 * Cambia el basemap del mapa.
 * @param {string} basemapId - Ej: "osm", "arcgis/satellite", "arcgis/topographic"
 */
export function setBasemap(basemapId) {
  if (!_map) return;
  _map.basemap = basemapId;
  console.info(`[mapManager] Basemap cambiado a: ${basemapId}`);
}