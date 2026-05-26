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
 * SDK v5 usa viewOnReady() 
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

// ── Variables privadas del módulo ───────────────────────────────────────────────
// Las variables viven mientras la página este cargada
// El exterior solo accede a lo que se exporta explicitamente 
let _map               = null; // se guarda instancia unica de esri/Map
let _mapEl             = null; // guarda el web component <arcgis-map> (contenedor 2d)
let _sceneEl           = null; // guarda el web component <arcgis-scene> (contenedor 3d)
let _vistaActiva       = "2D"; // guarda el estado global, default 2D
let _maskLayer         = null; // GraphicsLayer usada para la máscara municipal
let _sceneReadyPromise = null;  // Guarda la Promesa de inicialización 3D en background


// ─── INICIALIZACIÓN ───────────────────────────────────────────────────────

/**
 * Inicializa el Map único y lo asigna a ambos Web Components.
 * Llama una sola vez desde main.js antes de montar la UI.
 *
 * @param {Object} opts
 * @param {string} opts.mapContainerId   - id del <arcgis-map>
 * @param {string} opts.sceneContainerId - id del <arcgis-scene>
 * @returns {Promise<void>}
 */


export async function initMap({ mapContainerId, sceneContainerId }) { // parametros creados en main.js
  const [Map, GraphicsLayer] = await Promise.all([ //all para que ambos imports se carguen en paralelo

    // importacion dinámica: carga bajo demanda
    $arcgis.import("esri/Map"), 
    $arcgis.import("esri/layers/GraphicsLayer")
  ]);

  // listMode:"hide" → la máscara no aparece en el árbol de capas ni leyenda.
  // Es infraestructura visual, no un dato geográfico del municipio.
  _maskLayer = new GraphicsLayer({
    id:       "municipio-mask", //The unique ID assigned to the layer. If not set by the developer, it is automatically generated when the layer is loaded.
    title:    "Máscara municipal", //The title of the layer used to identify it in places such as the Layer List component.
    listMode: "hide" //Indicates how the layer should display eg: in the Layer List component
  });

  // Sin API Key activa → basemap "osm".
  // La máscara se añade desde el inicio al Map; las capas de datos vendrán via addCapas().
  _map = new Map({
    basemap: "osm",
    layers:  [_maskLayer] 
  });

  //buscar los web components (contenedores)
  _mapEl   = document.getElementById(mapContainerId); //js, variable que contiene el web component <arcgis-map> del DOM
  _sceneEl = document.getElementById(sceneContainerId); //js, variable que contiene el web component <arcgis-scene> del DOM 

  // manejo de error si hay error tipografico entre index y main, ids no coinciden 
  if (!_mapEl || !_sceneEl) {
    throw new Error( //js
      `[mapManager] Elementos no encontrados: "${mapContainerId}", "${sceneContainerId}". ` +
      `Verifica los id en index.html.`
    );
  }

  // Asignar el mismo objeto Map JS a ambos Web Components (contenedores) para dibujar en pantalla
  // Desde aquí comparten exactamente el mismo array de capas.
  // Cualquier capa que se añada a _map se verá automáticamente en la vista 2D/3D.
   _mapEl.map   = _map; //<arcgis-map>.map = Map (.map es una propiedad de arcgis-map y _map es una clase Map "An instance of a Map object to display in the view.")
  _sceneEl.map = _map; //<arcgis-map>.map = Map 

  
  // Espera solo la vista 2D para no bloquear el arranque de la app.
  // no espera 3D porque muy pesado al arrancar
  await _mapEl.viewOnReady(); // (m) viewOnReady() devuelve una promesa
  console.info("[mapManager] MapView (2D) lista");

  // Vista inicial centrada en España
  // view (p) de <arcgis-map>: The MapView instance created and managed by the component.
  // goTo (m) de <arcgis-map>: Sets the view to a given target.
  await _mapEl.view.goTo({ center: [-3.7038, 40.4168], zoom: 6 });

  // SceneView en lazy empieza a prepararse en paralelo mientras usuario usa 2D
  // toggleVista() awaita esta promesa solo la primera vez que se necesite 3D.
  _sceneReadyPromise = _sceneEl.viewOnReady().then(() => {
    console.info("[mapManager] SceneView (3D) lista (background)");
    _sceneEl.view.viewpoint = _mapEl.view.viewpoint.clone(); //asigna vista y clona posición, centro, zoom, tilt, escala, orientación y cámara de 2D a 3D.
  });
}

// ─── TOGGLE 2D / 3D ──────────────────────────────────────────────────────

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
  // Esperar SceneView solo la primera vez — después no hace falta esperar
  if (_sceneReadyPromise) {
    await _sceneReadyPromise;
    _sceneReadyPromise = null;
  }

  // detectar la vista actual "===" evaluación lógica
  //¿Es el valor actual de _vistaActiva exactamente igual al string "2D"?".
  // Devuelve: true/false
  const is2D = _vistaActiva === "2D"; 

  // Elegir vista origen y destino
  // Si is2D true : sourceView = 2D y targetView = 3D
  // Si is2D false : sourceView = 3D y targetView = 2D
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



// ─── REFERENCES ──────────────────────────────────────────────────────────────
// https://developers.arcgis.com/javascript/latest/references/map-components/components/arcgis-map/
// (p) : propiedad
// (m): método