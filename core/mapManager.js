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
 * ── UN ÚNICO MAP (decisión 14.05.26) ─────────────────────────────────────
 * MapView y SceneView comparten la misma instancia de Map.
 * Las capas se añaden al Map una sola vez. Ambas vistas las renderizan.
 * No hay duplicación de capas ni sincronización manual entre vistas.
 *
 * ── MÁSCARA MUNICIPAL (recorte visual WMS) ───────────────────────────────
 * WMS es un protocolo de imagen en servidor: el cliente no puede recortar
 * el resultado por un polígono arbitrario sin soporte del servidor.
 * La solución en cliente: superponer un GraphicsLayer con el polígono
 * INVERSO al municipio (mundo - municipio) relleno de gris semitransparente.
 * Resultado visual: solo se ve con nitidez el área del municipio, el resto
 * queda velado. Se preserva contexto geográfico exterior (gris, no blanco).
 * Técnica: geometryEngine.difference(mundo, municipio) → "donut polygon"
 *
 * ── NOTAS CRÍTICAS DE IMPLEMENTACIÓN ────────────────────────────────────
 * - El callback toggle DEBE ser async (usa await para goTo)
 * - Usar viewpoint para sincronizar posición, NO center + zoom
 * - Al pasar a 3D: verificar tilt y añadir 60° si viene en 0 (plano)
 * - Leer la vista como mapEl.view, NO event.detail.view (llega null en v5)
 * - _capasCreadas: guardia que evita doble carga en arcgisViewReadyChange
 */

// Estado del módulo (privado)
let _map       = null;
let _mapView   = null;
let _sceneView = null;
let _vistaActiva = "2D";
let _maskLayer = null;   // GraphicsLayer de máscara municipal
let _mapEl     = null;   // Referencia al <arcgis-map>
let _sceneEl   = null;   // Referencia al <arcgis-scene>

// ─── Inicialización ───────────────────────────────────────────────────────

/**
 * Inicializa el Map único y lo asigna a ambos Web Components.
 * Llama una sola vez desde main.js.
 *
 * @param {Object} opts
 * @param {string} opts.mapContainerId   - id del elemento <arcgis-map>
 * @param {string} opts.sceneContainerId - id del elemento <arcgis-scene>
 * @returns {Promise<void>}
 */
export async function initMap({ mapContainerId, sceneContainerId }) {
  const [Map, GraphicsLayer] = await Promise.all([
    $arcgis.import("esri/Map"),
    $arcgis.import("esri/layers/GraphicsLayer")
  ]);

  // GraphicsLayer de máscara municipal.
  // listMode: "hide" → no aparece en <arcgis-layer-list> ni en layerTree.
  // Es infraestructura visual, no un dato geográfico.
  _maskLayer = new GraphicsLayer({
    id:       "municipio-mask",
    title:    "Máscara municipal",
    listMode: "hide"
  });

  // El Map único. Sin API Key → basemap "osm".
  // La máscara se añade ahora; las capas de datos se añadirán después
  // mediante addCapas(), que siempre reposiciona la máscara al final.
  _map = new Map({
    basemap: "osm",
    layers:  [_maskLayer]
  });

  _mapEl   = document.getElementById(mapContainerId);
  _sceneEl = document.getElementById(sceneContainerId);

  if (!_mapEl || !_sceneEl) {
    throw new Error(
      `[mapManager] Elementos de mapa no encontrados. ` +
      `Busca id="${mapContainerId}" y id="${sceneContainerId}" en el HTML.`
    );
  }

  // Asignar el mismo Map a ambos Web Components.
  // A partir de aquí cada vista mantiene su propio estado de cámara
  // pero comparten exactamente el mismo array de capas.
  _mapEl.map   = _map;
  _sceneEl.map = _map;

  // Capturar referencias a las vistas cuando cada Web Component esté listo.
  // IMPORTANTE: en ArcGIS Maps SDK v5, event.detail.view llega null.
  // Hay que leer la vista como elemento.view, no desde el evento.
  _mapEl.addEventListener("arcgisViewReadyChange",   _onMapViewReady);
  _sceneEl.addEventListener("arcgisViewReadyChange", _onSceneViewReady);

  // La vista 3D arranca oculta
  _sceneEl.classList.add("hidden");

  console.info("[mapManager] Map inicializado. Esperando vistas...");
}

// ─── Handlers de readiness ────────────────────────────────────────────────

function _onMapViewReady() {
  // Guardia: el evento puede dispararse antes de que la vista esté asignada
  if (!_mapEl.view) return;
  _mapView = _mapEl.view;
  console.info("[mapManager] MapView (2D) lista");
}

function _onSceneViewReady() {
  if (!_sceneEl.view) return;
  _sceneView = _sceneEl.view;
  console.info("[mapManager] SceneView (3D) lista");
}

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Alterna entre vista 2D y 3D sincronizando la posición de cámara.
 *
 * Sincronización de viewpoint:
 *   2D → 3D: copiar viewpoint + añadir tilt 60° (el viewpoint 2D llega tilt=0)
 *   3D → 2D: copiar viewpoint directamente (SceneView.goTo acepta Viewpoint)
 *
 * El callback ES async: usa await en goTo() para esperar la animación.
 *
 * @returns {Promise<"2D"|"3D">} nuevo modo activo
 */
export async function toggleVista() {
  if (!_mapView || !_sceneView) {
    console.warn("[mapManager] Las vistas no están listas aún.");
    return _vistaActiva;
  }

  if (_vistaActiva === "2D") {
    // ── 2D → 3D ──
    // Copiar viewpoint 2D a SceneView
    const vp = _mapView.viewpoint.clone();
    await _sceneView.goTo(vp);

    // Si la cámara llegó completamente plana (tilt ≈ 0), inclinar para perspectiva 3D
    if (_sceneView.camera.tilt < 5) {
      await _sceneView.goTo({ tilt: 60 }, { animate: true, duration: 800 });
    }

    _sceneEl.classList.remove("hidden");
    _mapEl.classList.add("hidden");
    _vistaActiva = "3D";

  } else {
    // ── 3D → 2D ──
    const vp = _sceneView.viewpoint.clone();
    await _mapView.goTo(vp);

    _mapEl.classList.remove("hidden");
    _sceneEl.classList.add("hidden");
    _vistaActiva = "2D";
  }

  console.info(`[mapManager] Vista cambiada a ${_vistaActiva}`);
  return _vistaActiva;
}

/**
 * Devuelve la vista activa (MapView en 2D, SceneView en 3D).
 * @returns {MapView|SceneView|null}
 */
export function getVistaActiva() {
  return _vistaActiva === "2D" ? _mapView : _sceneView;
}

/**
 * Devuelve el modo actual.
 * @returns {"2D"|"3D"}
 */
export function getModoActual() {
  return _vistaActiva;
}

/**
 * Añade capas al Map compartido.
 * Elimina las capas de datos previas (mantiene la máscara intacta)
 * y reposiciona la máscara al final para que quede siempre encima.
 *
 * Orden de renderizado en ArcGIS: la primera capa del array se dibuja
 * abajo y la última arriba. La máscara debe ser la última.
 *
 * @param {Layer[]} capas - Array de instancias Esri
 */
export function addCapas(capas) {
  if (!_map) {
    console.error("[mapManager] Map no inicializado. Llama a initMap() primero.");
    return;
  }

  // Retirar solo las capas de datos (nunca la máscara)
  const capasPrevias = _map.layers
    .filter(l => l.id !== "municipio-mask")
    .toArray();
  _map.layers.removeMany(capasPrevias);

  // Añadir las nuevas capas de datos
  if (capas.length > 0) {
    _map.layers.addMany(capas);
  }

  // Reposicionar la máscara al final → siempre por encima de todos los datos
  _map.layers.remove(_maskLayer);
  _map.layers.add(_maskLayer);

  console.info(`[mapManager] ${capas.length} capas añadidas al Map`);
}

/**
 * Actualiza la máscara visual municipal.
 *
 * TÉCNICA:
 *   1. Crear polígono "mundo" que cubre toda la Tierra (WGS84)
 *   2. Restar el polígono del municipio: geometryEngine.difference()
 *   3. El resultado es el área EXTERIOR al municipio
 *   4. Rellenar con gris semitransparente (0.75) → preserva contexto exterior
 *   5. Borde azul delgado como límite municipal
 *
 * @param {Object} polygon - { rings, spatialReference } de municipios.js
 * @returns {Promise<void>}
 */
export async function actualizarMascara(polygon) {
  if (!_maskLayer) return;

  const [Graphic, Polygon, geometryEngine] = await Promise.all([
    $arcgis.import("esri/Graphic"),
    $arcgis.import("esri/geometry/Polygon"),
    $arcgis.import("esri/geometry/geometryEngine")
  ]);

  // Polígono que cubre toda la Tierra en WGS84
  const mundo = new Polygon({
    rings: [[
      [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
    ]],
    spatialReference: { wkid: 4326 }
  });

  // Polígono del municipio desde municipios.js
  const municipioPoly = new Polygon({
    rings:             polygon.rings,
    spatialReference:  polygon.spatialReference ?? { wkid: 4326 }
  });

  // Diferencia: mundo − municipio = área exterior al municipio
  // geometryEngine es síncrono en ArcGIS SDK
  const exterior = geometryEngine.difference(mundo, municipioPoly);

  _maskLayer.removeAll();

  if (exterior) {
    _maskLayer.add(new Graphic({
      geometry: exterior,
      symbol: {
        type:    "simple-fill",
        color:   [210, 210, 210, 0.75],  // Gris semitransparente: contexto visible
        outline: {
          color: [30, 100, 200, 1],      // Borde azul: límite del municipio
          width: 2
        }
      }
    }));
  }

  console.info("[mapManager] Máscara municipal actualizada");
}

/**
 * Elimina la máscara (al inicio o si no hay municipio seleccionado).
 */
export function limpiarMascara() {
  _maskLayer?.removeAll();
}

/**
 * Hace zoom al bounding box del municipio en la vista activa.
 * Añade un 20% de margen para mostrar contexto geográfico inmediato.
 *
 * @param {number[]} bbox - [xmin, ymin, xmax, ymax] WGS84
 * @returns {Promise<void>}
 */
export async function irAlMunicipio(bbox) {
  const view = getVistaActiva();
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

  // expand(1.2) → 20% de margen alrededor del municipio
  await view.goTo(extent.expand(1.2), { animate: true, duration: 1200 });
}

/**
 * Cambia el basemap del mapa activo.
 * @param {string} basemapId - Ej: "osm", "arcgis/satellite", "arcgis/topographic"
 */
export function setBasemap(basemapId) {
  if (!_map) return;
  _map.basemap = basemapId;
  console.info(`[mapManager] Basemap cambiado a: ${basemapId}`);
}