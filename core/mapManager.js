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
let _map               = null; // guarda instancia unica de esri/Map
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
  _mapEl   = document.getElementById(mapContainerId); //js, variable que referencia al web component <arcgis-map> de la interfaz
  _sceneEl = document.getElementById(sceneContainerId); //js, variable que referencia al web component <arcgis-scene> de la intefaz

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
   _mapEl.map   = _map; // .map (p) es una propiedad de arcgis-map y _map es una clase Map "An instance of a Map object to display in the view"
  _sceneEl.map = _map; 

    // Espera solo la vista 2D para no bloquear el arranque de la app.
  // no espera 3D porque muy pesado al arrancar
  await _mapEl.viewOnReady(); // (m) <arcgis-map>.viewOnReady() devuelve una promesa
  console.info("[mapManager] MapView (2D) lista");

  // Vista inicial centrada en España
  // <arcgis-map>.view (p) : The MapView instance created and managed by the component.
  // <arcgis-map>.goTo (m) : Sets the view to a given target.
  await _mapEl.view.goTo({ center: [-3.7038, 40.4168], zoom: 6 });

  // SceneView en lazy empieza a prepararse en paralelo mientras usuario usa 2D
  // toggleVista() esperará esta promesa solo la primera vez que se necesite 3D.
  _sceneReadyPromise = _sceneEl.viewOnReady().then(() => { // (m)
    console.info("[mapManager] SceneView (3D) lista (background)");
    _sceneEl.view.viewpoint = _mapEl.view.viewpoint.clone(); //copia de _mapE1 : accede a la vista (p), accede al viewpoint (p) y clona (m) posición, centro, zoom, tilt, escala, orientación y cámara de 2D a 3D.
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
  // Guarda de seguridad. Esperar SceneView solo la primera vez — después no hace falta esperar
  if (_sceneReadyPromise) { //evalua si la variable contiene la promesa o si no hay ninguna tarea pendiente de carga (null)
    await _sceneReadyPromise; // si promesa activa = true -> await
    _sceneReadyPromise = null; // si promesa activa = false, se limpia variable = null -> la próxima vez el if será false por asignarle "null" y salta el paso
  }

  // detectar la vista actual "===" evaluación lógica
  //¿Es el valor actual de _vistaActiva exactamente igual al string "2D"?".
  // Devuelve: true/false
  const is2D = _vistaActiva === "2D"; 

  // Elegir vista origen y destino
  // Si is2D true : sourceView = 2D y targetView = 3D
  // Si is2D false : sourceView = 3D y targetView = 2D
  // operador compacto (if...else)
  const sourceView = is2D ? _mapEl.view : _sceneEl.view; //if is2D true ? (entonces) sourceView = _mapEl.view : (si falso)  sourceView = _sceneEl.view
  const targetView = is2D ? _sceneEl.view : _mapEl.view; //if is2D false ? (entonces) targetView = _sceneEl.view : (si falso) targetView = _mapEl.view 

  // Clonar viewpoint y sincronizar posición antes del cambio visual
  // mueve la otra vista a la misma posición
  const vp = sourceView.viewpoint.clone();
  await targetView.goTo(vp); //goTo (m) devuelve una promesa que se resuelve cuando la animación de transición termina.

  // Cambio visual alternando visibilidad (no destruye)
  // classList: manipula clases css en elementos del DOM
  if (is2D) {
    _sceneEl.classList.add("vista-activa"); //webapis js/element
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

// ─── GETTERS ──────────────────────────────────────────────────────────────
// "ventana" autorizada para que otros módulos consulten variables privadas del módulo "_variable"
// 

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

// ─── GESTION DE CAPAS ─────────────────────────────────────────────────────

/**
 * Añade capas al Map compartido eliminando las anteriores.
 * Mantiene siempre la máscara como última capa (renderiza encima de todo).
 * Ejecturada por municipioSelector.js para cargar capas inmediatas !WFS
 * 
 * @param {Layer[]} capas - Array de instancias Esri ya inicializadas
 */


export function addCapas(capas) {
  if (!_map) { // verifica que el objeto _map exista
    console.error("[mapManager] Map no inicializado. Llama a initMap() primero.");
    return;
  }

  // Limpia todas las capas de datos — excepto la máscara
   const capasPrevias = _map.layers //(p) map
    .filter(l => l.id !== "municipio-mask") //(m) map layers collection 
    .toArray(); //(m) map layers collection 
  _map.layers.removeMany(capasPrevias); // (p) (m) map

  // añade nuevas capas
  if (capas.length > 0) {
    _map.layers.addMany(capas); //(p) (m) map
  }


  // Reposicionar máscara al final → siempre por encima de los datos
  // Arcgis renderiza primera capa abajo, última capa arriba
  _map.layers.remove(_maskLayer); //(p) (m) map
  _map.layers.add(_maskLayer); //(p) (m) map , así la mask siempre queda encima

  console.info(`[mapManager] ${capas.length} capas añadidas al Map`);
}



/**
 * Añade una sola capa al Map (lazy-load on-demand para WFS).
 * La máscara se reposiciona encima.
 * Ejecturada por layerTree.js para cargar WFS cuando el usuario marca el checkbox
 * @param {Layer} capa
 */


export function addCapa(capa) {
  if (!_map) return; //verifica si el objeto _map se ha inicializado
  _map.layers.add(capa); //añade capa por defecto en la parte superior de la pila visual 
  _map.layers.remove(_maskLayer); // elimina mask
  _map.layers.add(_maskLayer); // añade mask para que quede encima
}

// ─── MÁSCARA MUNICIPAL ────────────────────────────────────────────────────

/**
 * Actualiza la máscara visual del municipio seleccionado.
 *
 * TÉCNICA: geometryEngine.difference(mundo, municipio) produce el área
 * exterior al municipio. Se rellena de gris semitransparente para que el
 * contexto geográfico exterior sea visible pero quede en segundo plano.
 *
 * Función ejecutada por municipioSelector.js
 * 
 * @param {Object} polygon - { rings, spatialReference } de municipios.js municipioData.polygon
 * @returns {Promise<void>}
 */

export async function actualizarMascara(polygon) {
  if (!_maskLayer) return; //Verifica si _maskLayer existe. Si no está inicializada, la función se detiene para evitar errores

  // carga y asigna módulos de sdk arcgis v5
  const [Graphic, Polygon, differenceOperator] = await Promise.all([ //importación simultánea
    $arcgis.import("esri/Graphic"),
    $arcgis.import("esri/geometry/Polygon"),
    $arcgis.import("esri/geometry/operators/differenceOperator")
  ]);

  // definición del poligono rectangular "mundo"
  const mundo = new Polygon({
    rings: [[
      [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
    ]],
    spatialReference: { wkid: 4326 }
  });

  // definición del polígono municipal -> municipioData.polygon de municipios.js ejecutado por municipioSelector.js
  const municipioPoly = new Polygon({
    rings:            polygon.rings,
    spatialReference: polygon.spatialReference ?? { wkid: 4326 }
  });

  // mundo − municipio = área exterior → efecto de recorte visual entre polígonos
  const exterior = differenceOperator.execute(mundo, municipioPoly);

  //limpiar cualquier máscara anterior
  _maskLayer.removeAll(); //(m) GraphicsLayer

  if (exterior) { // comprobar si la operación difference devolvió geometría válida, if true añade capa tipo graphic a la _masklayer
    _maskLayer.add(new Graphic({ //(m) GraphicsLayer.add()
      geometry: exterior,
      symbol: {
        type:  "simple-fill",
        // color: [210, 210, 210, 0.75],   // gris semitransparente
        outline: {
          color: [30, 100, 200, 1],      // borde azul: límite municipal
          width: 0.5
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
  _maskLayer?.removeAll(); //(m) GraphicsLayer
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────

/**
 * Hace zoom al bounding box del municipio en la vista activa.
 * expand(1.2) añade 20% de margen para mostrar contexto geográfico inmediato.
 *
 * Ejecutada por municipioSelector.js
 * 
 * @param {number[]} bbox - [xmin, ymin, xmax, ymax] en WGS84
 * @returns {Promise<void>}
 */


export async function irAlMunicipio(bbox) {
  // uso de ?. Evita que la aplicación se detenga con un error si el elemento (_mapEl o _sceneEl) aún no está disponible en el DOM
  const view = _vistaActiva === "2D" ? _mapEl?.view : _sceneEl?.view; //detectar si el modo actual es 2D, si es true selecciona <arcgis-map>, si es false <arcgis-scene>

  if (!view) {
    console.warn("[mapManager] No hay vista activa para hacer zoom");
    return;
  }

  // Definición del área a mostrar
  // se usa [] porque la función Promise.all devuelve un array con todas las promesas dentro
  // devolverá un array de una sola posición [ClaseExtent]
  // const [Extent] pide el primer elemento del array y lo guarda en la variable Extent
  // Extent es la CLASE o molde, no es un objeto geográfico todavía
  const [Extent] = await Promise.all([
    $arcgis.import("esri/geometry/Extent")
  ]);

  // Instancia concreta que usa Extent como molde
  const extent = new Extent({
    xmin: bbox[0], ymin: bbox[1],
    xmax: bbox[2], ymax: bbox[3],
    spatialReference: { wkid: 4326 }
  });

  await view.goTo(extent.expand(1.2), { animate: true, duration: 1200 }); //.goTo(m) de _mapEl o _sceneEl, .expand(m) de extent
}

// ─── BASEMAP ──────────────────────────────────────────────────────────────

/**
 * Cambia el basemap del mapa automáticamente en 2D y 3D
 * 
 * Ejecutada por basemapSelector.js al escuchar el evento de selección
 * 
 * @param {string} basemapId - Ej: "osm", "arcgis/satellite", "arcgis/topographic"
 */

export function setBasemap(basemapId) {
  if (!_map) return; // verifica que el objeto _map este inicializado
  _map.basemap = basemapId; // (p) de _map. Aquí se asigna el id del basemap seleccionado a la instancia _map de esri
  console.info(`[mapManager] Basemap cambiado a: ${basemapId}`);
}



// ─── REFERENCES ──────────────────────────────────────────────────────────────
// arcgis-map https://developers.arcgis.com/javascript/latest/references/map-components/components/arcgis-map/
// (p) : propiedad
// (m): método
// classList https://developer.mozilla.org/en-US/docs/Web/API/Element/classList
// map https://developers.arcgis.com/javascript/latest/references/core/Map/
// map layers collection https://developers.arcgis.com/javascript/latest/references/core/core/Collection
// GraphicLayer https://developers.arcgis.com/javascript/latest/references/core/layers/GraphicsLayer/#methods
// differenceOperator https://developers.arcgis.com/javascript/latest/references/core/geometry/operators/differenceOperator/
// Extent https://developers.arcgis.com/javascript/latest/references/core/geometry/Extent/
// goTo https://developers.arcgis.com/javascript/latest/references/core/views/types/#GoToOptionsBase-duration


