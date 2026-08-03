/**
 * core/mapManager.js
 *
 * Gestiona el ciclo de vida del mapa único de la aplicación:
 *   - Inicialización de un único Map compartido por dos vistas
 *   - Toggle 2D (MapView) ↔ 3D (SceneView) con sincronización de viewpoint
 *   - Gestión de la máscara visual municipal para recorte de capas WMS
 *   - Resaltado visual del municipio en foco dentro de un ámbito territorial
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
 * ── RESALTADO DE MUNICIPIO (ámbito territorial) ─────────────────────────
 * GraphicsLayer independiente de la máscara. Responsabilidad distinta:
 * la máscara OCULTA lo que está fuera del territorio (se calcula una vez
 * al arrancar y no se toca — decisión 03.08.26, 3DECISIONS.md). El
 * resaltado SEÑALA un municipio dentro de un territorio ya visible; su
 * ciclo de vida es corto (aparece/desaparece con cada selección de
 * municipio dentro de ?cliente=provincia/ccaa), por lo que mezclarlo con
 * la máscara acoplaría dos conceptos con vidas útiles distintas (mismo
 * criterio SRP ya aplicado al separar layerFactory de layerInitializer).
 *
 * ── ORDEN DE CAPAS ───────────────────────────────────────────────────────
 * ArcGIS renderiza la primera capa del array abajo y la última arriba.
 * Orden objetivo, de fondo a frente:
 *   [ resaltadoLayer, ...capas de datos (WMS/WFS/...), maskLayer ]
 * El resaltado va justo sobre el basemap (por debajo de los datos) para
 * no competir visualmente con la lectura de capas activas — es una
 * referencia de fondo, no un elemento de primer plano. La máscara sigue
 * reposicionándose siempre al final (por encima de todo).
 */

import * as eventBus from "../utils/eventBus.js";

// ── Variables privadas del módulo ───────────────────────────────────────────────
// Las variables viven mientras la página este cargada
// El exterior solo accede a lo que se exporta explicitamente 
let _map               = null; // guarda instancia unica de esri/Map
let _mapEl             = null; // guarda el web component <arcgis-map> (contenedor 2d)
let _sceneEl           = null; // guarda el web component <arcgis-scene> (contenedor 3d)
let _vistaActiva       = "2D"; // guarda el estado global, default 2D
let _maskLayer         = null; // GraphicsLayer usada para la máscara municipal
let _resaltadoLayer    = null; // GraphicsLayer usada para el contorno del municipio en foco (ámbito territorial)
let _sceneReadyPromise = null;  // Guarda la Promesa de inicialización 3D en background
let _municipioViewpoint = null; // Viewpoint del último municipio cargado

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

  // Misma razón que _maskLayer: listMode:"hide" — es infraestructura
  // visual (resaltado del municipio en foco), no una capa de datos que
  // el usuario deba ver ni activar/desactivar desde el árbol de capas.
  _resaltadoLayer = new GraphicsLayer({
    id:       "municipio-resaltado",
    title:    "Resaltado de municipio",
    listMode: "hide"
  });

  // Sin API Key activa → basemap "osm".
  // Orden inicial [resaltado, mask]: el resaltado queda por debajo (fondo,
  // aún sin datos) y la máscara al final (arriba). Las capas de datos
  // vendrán via addCapas(), que respeta y refuerza este orden.
  _map = new Map({
    basemap: "osm",
    layers:  [_resaltadoLayer, _maskLayer] 
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

  // ─── OVERRIDE DEL BOTÓN HOME — MapView (2D) ───────────────────────────────
  // arcgis-home en SDK v5 usa view.initialExtent (extensión al arrancar),
  // no view.homeViewpoint. Como la vista se inicializa antes de seleccionar
  // municipio, initialExtent es siempre el mundo entero.
  // Solución: interceptar el click y redirigir a _municipioViewpoint si existe.
  // Si no hay municipio activo aún, el botón hace su comportamiento por defecto.
  // El listener de MapView se registra aquí porque viewOnReady() ya se completó
  // y el Light DOM de <arcgis-map> está garantizado.
  const homeMap = _mapEl.querySelector("arcgis-home");
  if (homeMap) {
    homeMap.addEventListener("click", (e) => {
      if (!_municipioViewpoint) return; // sin municipio → comportamiento nativo
      e.stopImmediatePropagation();     // cancela el handler interno del componente
      _mapEl.view.goTo(_municipioViewpoint, { animate: true, duration: 800 });
    });
  }

  // ─── SCENEVIEW LAZY ───────────────────────────────────────────────────────
  // Se inicializa en background para no bloquear el arranque.
  // toggleVista() esperará esta promesa solo la primera vez que se active 3D.
  _sceneReadyPromise = _sceneEl.viewOnReady().then(() => {
    console.info("[mapManager] SceneView (3D) lista (background)");
    _sceneEl.view.viewpoint = _mapEl.view.viewpoint.clone();

    // ─── OVERRIDE DEL BOTÓN HOME — SceneView (3D) ─────────────────────────
    // Se registra aquí, no antes, porque la SceneView y su Light DOM
    // solo están garantizados cuando viewOnReady() se resuelve.
    // Registrarlo en initMap() antes de este punto podría devolver null
    // si el componente aún no ha renderizado sus hijos.
    const homeScene = _sceneEl.querySelector("arcgis-home");
    if (homeScene) {
      homeScene.addEventListener("click", (e) => {
        if (!_municipioViewpoint) return;
        e.stopImmediatePropagation();
        _sceneEl.view.goTo(_municipioViewpoint, { animate: true, duration: 800 });
      });
    }
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
  // Si la promesa existe, espera a que la SceneView esté lista antes de alternar la vista. Solo se espera la primera vez.
  if (_sceneReadyPromise) {
    await _sceneReadyPromise;
    _sceneReadyPromise = null;

    // Al inicializar la SceneView por primera vez, si ya hay un municipio activo,
    // aplicar su homeViewpoint. Sin esto, el Home en 3D siempre volvería al mundo
    // porque la SceneView no existía cuando irAlMunicipio() se ejecutó en 2D.
    if (_municipioViewpoint && _sceneEl?.view) {
    _sceneEl.view.homeViewpoint = _municipioViewpoint;
    }
  
  }

  const is2D = _vistaActiva === "2D";
  const sourceView = is2D ? _mapEl.view : _sceneEl.view;
  const targetView = is2D ? _sceneEl.view : _mapEl.view;

  // Capturar viewpoint ANTES de cambiar visibilidad
  const vp = sourceView.viewpoint.clone();

  // 1. Cambiar visibilidad primero — el componente destino debe estar
  //    activo antes de recibir goTo(), si no la SceneView está suspendida
  //    y no procesa la animación.
  if (is2D) {
    _mapEl.hidden   = true;
    _sceneEl.hidden = false;
    _vistaActiva = "3D";
  } else {
    _sceneEl.hidden = true;
    _mapEl.hidden   = false;
    _vistaActiva = "2D";
  }

  // Sincronizar también las clases de estado visual para evitar
  // que una vista siga oculta por CSS cuando el atributo hidden cambia.
  const activeEl = is2D ? _sceneEl : _mapEl;
  const inactiveEl = is2D ? _mapEl : _sceneEl;

  activeEl.classList.add("vista-activa");
  activeEl.classList.remove("vista-inactiva");
  inactiveEl.classList.add("vista-inactiva");
  inactiveEl.classList.remove("vista-activa");

  // 2. Sincronizar posición DESPUÉS de activar el componente
  //console.time("goTo");
    // 2. Sincronizar posición DESPUÉS de activar el componente
  // duration:0 al volver a 2D — evita animar el "aplanado" de cámara (tilt/heading),
  // que no aporta contexto útil y es la causa medida de los ~525ms de loading
  // en el botón toggle (ver 2ARCHITECTURE.md / medición console.time 28.07.26).
  // Al entrar en 3D se conserva la animación por defecto: da contexto espacial
  // de cómo el terreno se eleva desde el plano.
  const opcionesGoTo = is2D ? {} : { duration: 0 };
  await targetView.goTo(vp, opcionesGoTo);

  // console.timeEnd("goTo"); // para verificar demora de animacion al volver de 3d a 2d  

  console.info(`[mapManager] Vista cambiada a ${_vistaActiva}`);
  eventBus.emit("vista-cambiada", { modo: _vistaActiva });

  // Actualizar reference-element del componente de coordenadas al cambiar vista
  document.querySelector("arcgis-coordinate-conversion")
    ?.setAttribute("reference-element", _vistaActiva === "3D" ? "scene-view" : "map-view");


  
  
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
 * Mantiene siempre la máscara y el resaltado como infraestructura visual
 * persistente — no forman parte del ciclo de reemplazo de capas de datos.
 *  
 * @param {Layer[]} capas - Array de instancias Esri ya inicializadas
 */

// Ejecturada por municipioSelector.js para cargar capas inmediatas !WFS
export function addCapas(capas) {
  if (!_map) { // verifica que el objeto _map exista
    console.error("[mapManager] Map no inicializado. Llama a initMap() primero.");
    return;
  }

  // Limpia todas las capas de datos — excepto máscara y resaltado, que
  // son infraestructura visual persistente (ver comentario de cabecera
  // "ORDEN DE CAPAS" y explicación en initMap()).
   const capasPrevias = _map.layers //(p) map
    .filter(l => l.id !== "municipio-mask" && l.id !== "municipio-resaltado") //(m) map layers collection 
    .toArray(); //(m) map layers collection 
  _map.layers.removeMany(capasPrevias); // (p) (m) map

  // añade nuevas capas
  if (capas.length > 0) {
    _map.layers.addMany(capas); //(p) (m) map
  }

  // Reposicionar resaltado al fondo (índice 0 → justo sobre el basemap,
  // por debajo de todas las capas de datos recién añadidas). Se reafirma
  // aquí en cada carga, no solo en initMap(), para que el orden quede
  // garantizado sin depender de que nadie reordene _map.layers por error.
  if (_resaltadoLayer) {
    _map.layers.remove(_resaltadoLayer); //(p) (m) map
    _map.layers.add(_resaltadoLayer, 0); //(p) (m) map
  }

  // Reposicionar máscara al final → siempre por encima de los datos
  // Arcgis renderiza primera capa abajo, última capa arriba
  _map.layers.remove(_maskLayer); //(p) (m) map
  _map.layers.add(_maskLayer); //(p) (m) map , así la mask siempre queda encima

  console.info(`[mapManager] ${capas.length} capas añadidas al Map`);
}



/**
 * Añade una sola capa al Map (lazy-load on-demand para WFS).
 * La máscara se reposiciona encima. El resaltado no se toca aquí: al
 * añadirse una capa individual (siempre al final/arriba por defecto),
 * no puede terminar por debajo del resaltado, así que no hace falta
 * reafirmar su posición en cada llamada.
 *
 * @param {Layer} capa
 */

// Ejecturada por layerTree.js para cargar WFS cuando el usuario marca el checkbox
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
 * @param {Object} polygon - { rings, spatialReference } — campo .polygon
 *   del municipio activo ya resuelto
 * @returns {Promise<void>}
 */

// Ejecutada en municipioSelector.js usando mapManager.actualizarMascara()
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

// definición del polígono municipal -> municipioData.polygon
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

// ─── RESALTADO DE MUNICIPIO (ámbito territorial) ──────────────────────────

/**
 * Dibuja (o actualiza) el contorno del municipio en foco dentro de un
 * ámbito territorial (provincia/ccaa). NO sustituye ni toca la máscara
 * territorial ya existente — son dos capas independientes con
 * responsabilidades distintas (ver comentario de cabecera del módulo).
 *
 * Reutiliza deliberadamente el mismo patrón de construcción de geometría
 * que actualizarMascara() (Polygon + spatialReference con fallback a
 * WGS84) para no introducir una segunda forma de interpretar el campo
 * .polygon del municipio.
 *
 * Z-order: gestionado en addCapas() / initMap(), no aquí — esta función
 * solo dibuja el gráfico; la posición del GraphicsLayer dentro de
 * _map.layers ya está garantizada por debajo de las capas de datos.
 *
 * @param {Object} polygon - { rings, spatialReference } del municipio activo
 * @returns {Promise<void>}
 */

// Ejecutada por municipioSelector.js (agregarCapasMunicipio) con
// mapManager.resaltarMunicipio(municipioData.polygon)
export async function resaltarMunicipio(polygon) {
  if (!_resaltadoLayer || !polygon) return; //sin capa inicializada o sin geometría → no hay nada que dibujar

  const [Graphic, Polygon] = await Promise.all([
    $arcgis.import("esri/Graphic"),
    $arcgis.import("esri/geometry/Polygon")
  ]);

  const municipioPoly = new Polygon({
    rings:            polygon.rings,
    spatialReference: polygon.spatialReference ?? { wkid: 4326 }
  });

  //limpiar cualquier resaltado anterior antes de dibujar el nuevo
  _resaltadoLayer.removeAll(); //(m) GraphicsLayer

  _resaltadoLayer.add(new Graphic({ //(m) GraphicsLayer.add()
    geometry: municipioPoly,
    symbol: {
      type:  "simple-fill",
      color: [0, 122, 194, 0.10],   // relleno muy ligero — foco sutil, no compite con los datos
      outline: {
        color: [0, 122, 194, 1],      // contorno de foco — ajustar al color de acento real de la app
        width: 1.5
      }
    }
  }));

  console.info("[mapManager] Resaltado de municipio actualizado");
}

/**
 * Retira el resaltado del municipio en foco. Se usa al volver de un
 * municipio concreto a la vista territorial completa.
 */

// Ejecutada por municipioSelector.js (retirarCapasMunicipio) con
// mapManager.quitarResaltadoMunicipio() — simétrica a resaltarMunicipio()
export function quitarResaltadoMunicipio() {
  _resaltadoLayer?.removeAll(); //(m) GraphicsLayer
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────

/**
 * Hace zoom al bounding box del municipio en la vista activa.
 * expand(1.2) añade 20% de margen para mostrar contexto geográfico inmediato.
 *
 * 
 * @param {number[]} bbox - [xmin, ymin, xmax, ymax] en WGS84
 * @returns {Promise<void>}
 */

// Ejecutada por municipioSelector.js con mapManager.irAlMunicipio(municipioData.bbox)
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
  const [Extent, Viewpoint] = await Promise.all([
  $arcgis.import("esri/geometry/Extent"),
  $arcgis.import("esri/Viewpoint")
])

  // Instancia concreta que usa Extent como molde
  const extent = new Extent({
    xmin: bbox[0], ymin: bbox[1],
    xmax: bbox[2], ymax: bbox[3],
    spatialReference: { wkid: 4326 }
  });

  await view.goTo(extent.expand(1.2), { animate: true, duration: 1200 }); //.goTo(m) de _mapEl o _sceneEl, .expand(m) de extent

  
  // Guardar viewpoint del municipio para que el botón Home pueda navegar de vuelta.
  // El override del click está en initMap() — aquí solo se actualiza el valor.
  // Se construye desde el Extent (no desde view.viewpoint.clone()) para garantizar
  // targetGeometry de tipo "extent", que el SDK interpreta de forma determinista.
  _municipioViewpoint = new Viewpoint({ targetGeometry: extent.expand(1.2) })

  console.info("[mapManager] Punto de retorno 'Home' actualizado para el municipio");


  
}

// ─── BASEMAP ──────────────────────────────────────────────────────────────

/**
 * Cambia el basemap del mapa automáticamente en 2D y 3D
 * 
 * 
 * @param {string} basemapId - Ej: "osm", "arcgis/satellite", "arcgis/topographic"
 */

// Ejecutada por basemapSelector.js al escuchar el evento de selección → mapManager.setBasemap(basemapId)
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