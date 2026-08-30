/**
 * ui/layerTree.js
 *
 * Árbol de capas jerárquico basado en Calcite Tree Web Components.
 *
 * ── ESTRUCTURA DEL ÁRBOL ──────────────────────────────────────────────────
 *   bloque_tematico → nivel 1  (SIN checkbox, expandible, negrita)
 *   subtema         → nivel 2  (SIN checkbox, expandible)
 *   title (capa)    → nivel 3  (seleccionable → activa/desactiva la capa)
 *     ├── [WMS con sublayers curadas] → nivel 4 (sublayers ya cargadas, sin fetch)
 *     └── [WFS sin name] → nivel 4  (FeatureTypes descubiertos via Capabilities)
 *                          (solo estos tienen checkbox efectivo)
 *
 * ── WFS CON DESCUBRIMIENTO DINÁMICO ──────────────────────────────────────
 * Cuando el catálogo tiene una entrada WFS sin campo "name", el servicio
 * puede exponer múltiples FeatureTypes. En lugar de hardcodear cada tipo
 * en el catálogo (una entrada por feature type → mantenimiento O(n)),
 * la app consulta el GetCapabilities del servicio al expandir el nodo
 * y construye los hijos dinámicamente.
 *
 * Ventaja académica: la app consume la autodescripción del servicio OGC
 * para construir la UI → se adapta automáticamente si el servidor añade
 * o quita tipos sin tocar el catálogo.
 *
 * Flujo:
 *   1. configEngine devuelve entrada WFS sin name → es un "nodo discovery"
 *   2. layerTree renderiza el nodo con indicador visual de expansión pendiente
 *   3. Usuario expande el nodo → calciteTreeItemExpand se dispara
 *   4. fetchFeatureTypes(url) → array de FeatureTypeInfo
 *   5. Se inyectan nodos hijo en el árbol (uno por FeatureType)
 *   6. Al activar un hijo → aplicarBboxWfs() + addCapa() (lazy)
 *
 * ── WMS CON SUBLAYERS CURADAS (sin discovery automático) ──────────────────
 * A diferencia de WFS, donde cualquier FeatureType expuesto es potencialmente
 * útil, el servidor WMS mezcla geometría real con elementos de renderizado
 * puro (labels). Por eso aquí NO se hace discovery vía GetCapabilities:
 * el catálogo declara explícitamente qué sublayers se exponen y cómo se
 * llaman (config.sublayers: [{id, title, visible}]) — ver 3DECISIONS.md 30.06.26.
 *
 * layerFactory ya instancia la WMSLayer con su array layer.sublayers
 * poblado y con visible correcto (forzado desde catálogo, no heredado del
 * servidor). Por eso el renderizado aquí es síncrono: solo se pinta lo que
 * ya existe, sin esperar ningún fetch.
 *
 * ── POR QUÉ selection-mode="ancestors" y NO calcite-checkbox manual ───────
 * calcite-tree-item intercepta todos los pointer events para su mecanismo
 * de selección nativo. Añadir calcite-checkbox como hijo provoca que el
 * click lo consuma el item antes de llegar al checkbox →
 * calciteCheckboxChange nunca se dispara.
 *
 * La solución correcta: usar el mecanismo nativo de Calcite Tree.
 *   - selection-mode="ancestors" → emite calciteTreeItemSelect en cada cambio
 *   - Un listener único en el árbol raíz (delegación de eventos)
 *   - data-layer-id + data-layer-index identifican qué capa toglear
 *   - Los grupos (nivel 1 y 2) no tienen data-layer-id → el listener los ignora
 *
 * ── REACTIVIDAD ───────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado" o
 * "territorio-cargado" (ambos entregan un conjunto completo desde cero).
 *
 * ── AJUSTE (soporte de ámbito territorial provincia/ccaa) ───────────────────
 * Se añade un segundo modo de actualización, incremental, para el caso
 * ambitoTerritorial "provincia"/"ccaa": al elegir un municipio dentro del
 * territorio, sus capas ("capas-municipio-agregadas") se SUMAN como un
 * grupo propio al final del árbol, sin reconstruir la base territorial ya
 * renderizada. Al limpiar la selección ("capas-municipio-retiradas") ese
 * grupo se retira como bloque único.
 *
 * Por qué un grupo fijo y no fusión dentro de bloque_tematico/subtema:
 * patrón GIS estándar (IDENA/GeoBizkaia) — el árbol de un ámbito territorial
 * no se reestructura al navegar dentro de él; las capas específicas de un
 * municipio se presentan como sección propia y reconocible. Ver 3DECISIONS.md,
 * hilo "ámbito territorial: soporte provincia/ccaa".
 *
 * El resto del árbol (_renderTree, discovery WFS, sublayers WMS, selección)
 * no cambia — el grupo municipal reutiliza las mismas funciones de
 * construcción de nodos (_crearItemCapa, _crearItemWmsConSublayers,
 * _crearItemWfsDiscovery) y el mismo mecanismo de selección por índice
 * global en _layersRef/_configsRef.
 */

import { on, emit }        from "../utils/eventBus.js";
import { clearContainer }  from "../utils/domUtils.js";
import * as mapManager     from "../core/mapManager.js";
import { crearCapaWfsHija } from "../core/layerFactory.js";
import { aplicarBboxWfs }  from "../core/layerInitializer.js"; // ← CAMBIO: importar helper de filtrado
import { fetchFeatureTypes, checkFeaturesInBbox } from "../utils/wfsCapabilitiesParser.js";

// ─── Estado interno del módulo ────────────────────────────────────────────

let _containerEl   = null;
let _layersRef     = [];
let _configsRef    = [];
let _lazyLayerIds  = new Set();

// ← CAMBIO: renombrado de _municipioData a _territorioData. Guarda el
// territorio activo (municipio individual O territorio completo
// provincia/ccaa) para aplicar BBOX a las capas hijas WFS creadas
// on-demand en _crearHijoWfs(). Las hijas no pasan por inicializarCapa()
// porque no tienen entrada en el catálogo; necesitamos el contexto del
// ámbito activo para filtrarlas igual que al padre. El nombre ya no
// asume escala municipal — sigue siendo el mismo mecanismo, agnóstico
// a si el bbox es de un municipio o de un territorio completo.
let _territorioData = null;

/**
 * Conjunto de IDs de nodos WFS "discovery" que ya han sido expandidos.
 * Evita lanzar múltiples peticiones GetCapabilities si el usuario colapsa
 * y vuelve a expandir el mismo nodo.
 * Clave: config.id del padre. Valor: true (ya expandido).
 */
const _wfsDiscoveryExpanded = new Map();

// ── Grupo municipal incremental (Modelo B — ver AJUSTE en cabecera) ───────
// Índice en _layersRef/_configsRef donde empieza el grupo municipal actual,
// o null si no hay ninguno activo. Solo puede existir un grupo municipal
// a la vez (un territorio tiene, como mucho, un municipio "en foco").
let _inicioGrupoMunicipal = null;

// ─── Inicialización ────────────────────────────────────────────────────────

export function initLayerTree(container) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[layerTree] Contenedor no encontrado:", container);
    return;
  }

  // Mensaje inicial — layerTree es dueño único de este contenedor.
  // Se elimina en _renderTree via clearContainer cuando llegue municipio-cargado.
  // const msg = document.createElement("p");
  // msg.className   = "layer-tree-empty";
  // msg.textContent = "Selecciona un municipio para ver las capas disponibles.";
  // _containerEl.appendChild(msg);

  // ← CAMBIO: desestructurar también municipioData del evento
  on("municipio-cargado", ({ layers, configs, lazyLayerIds, municipioData }) => {
    // Limpiar el estado de discovery al cambiar de municipio.
    // Un municipio nuevo puede tener las mismas URLs WFS pero con distinto contexto.
    _wfsDiscoveryExpanded.clear();
    _territorioData = municipioData ?? null; // ← CAMBIO: actualizar contexto (municipio)
    _renderTree(layers, configs, lazyLayerIds ?? new Set());
  });

  // ← NUEVO: carga inicial de la base territorial (Modelo B — ambitoTerritorial
  // "provincia"/"ccaa"). Mismo tratamiento que municipio-cargado: es una
  // carga completa desde cero, no hay nada previo en el árbol que preservar.
  on("territorio-cargado", ({ layers, configs, lazyLayerIds, territorioData }) => {
    _wfsDiscoveryExpanded.clear();
    _territorioData = territorioData ?? null;
    _renderTree(layers, configs, lazyLayerIds ?? new Set());
  });

  // ← NUEVO: capas municipales incrementales (Modelo B). A diferencia de
  // los dos listeners anteriores, estos NO llaman a _renderTree — suman
  // o retiran un grupo propio sin tocar la base territorial ya renderizada.
  on("capas-municipio-agregadas", ({ layers, configs, municipioData }) => {
    _agregarGrupoMunicipal(layers, configs, municipioData);
  });

  on("capas-municipio-retiradas", () => {
    _retirarGrupoMunicipal();
  });
}

// ─── Renderizado principal ─────────────────────────────────────────────────

function _renderTree(layers, configs, lazyLayerIds) {
  // CRÍTICO: limpiar el contenedor antes de renderizar.
  clearContainer(_containerEl);

  _lazyLayerIds = lazyLayerIds;
  _layersRef    = layers;
  _configsRef   = configs;

  // Reconstrucción completa → cualquier grupo municipal previo queda
  // huérfano en el DOM que acabamos de limpiar. Resetear el puntero para
  // que _retirarGrupoMunicipal() no intente operar sobre estado obsoleto.
  _inicioGrupoMunicipal = null;

  if (!configs || configs.length === 0) {
    const msg = document.createElement("p");
    msg.className   = "layer-tree-empty";
    msg.textContent = "Sin capas disponibles para este municipio.";
    _containerEl.appendChild(msg);
    return;
  }

  const grupos = _agrupar(configs, layers);

  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "multiple");
  tree.setAttribute("lines", "");

  // ── Listener de selección (toggle visibilidad) ─────────────────────────
  // Delegación de eventos: un único listener en la raíz captura los eventos
  // de todos los nodos hoja. Los nodos agrupadores y nodos WFS discovery
  // no tienen data-layer-id → el listener los ignora.
  tree.addEventListener("calciteTreeItemSelect", e => {
    _handleLayerSelect(e);
  });

  // ── Listener de expansión (discovery WFS) ─────────────────────────────
  // calciteTreeItemExpand se dispara cuando el usuario abre un nodo.
  // Solo actuamos si el nodo es un "discovery WFS" pendiente de expansión.
  tree.addEventListener("calciteTreeItemExpand", e => {
    const item = e.target;
    if (item.dataset.wfsDiscovery === "true") {
      _handleWfsDiscovery(item);
    }
  });

  grupos.forEach(({ bloque, subtemas }) => {
    const bloqueItem     = _crearItemGrupo(bloque, true);
    const bloqueChildren = document.createElement("calcite-tree");
    bloqueChildren.slot  = "children";

    subtemas.forEach(({ subtema, pares }) => {
      const subtemaItem     = _crearItemGrupo(subtema, false);
      const subtemaChildren = document.createElement("calcite-tree");
      subtemaChildren.slot  = "children";

      pares.forEach(({ config, layer }) => {
        const globalIndex = configs.indexOf(config);

        // ── Nodo WMS con sublayers curadas ──────────────────────────────
        // A diferencia del discovery WFS, las sublayers WMS NO se descubren
        // en runtime vía GetCapabilities: layerFactory ya las instanció con
        // el objeto layer.sublayers poblado (ver layerFactory._buildParams,
        // caso "WMS"). Aquí solo pintamos lo que ya existe — sin fetch,
        // sin estado "expandido" que cachear, sin spinner real.
        //
        // Por qué NO es discovery automático (ver 3DECISIONS.md 30.06.26):
        // a diferencia de WFS donde cualquier FeatureType expuesto es
        // potencialmente útil, el servidor WMS mezcla geometría real con
        // elementos de renderizado puro (labels). El catálogo decide qué
        // sublayers se exponen vía config.sublayers — curación editorial,
        // no automatización del Capabilities.
        if (config.tipo === "WMS" && config.sublayers?.length) {
          subtemaChildren.appendChild(
            _crearItemWmsConSublayers(config, layer, globalIndex)
          );
          return;
        }

        // ── Nodo WFS sin name: discovery mode ─────────────────────────
        // Una entrada WFS sin campo "name" en el catálogo es un servicio
        // con múltiples FeatureTypes. Se renderiza como nodo expandible
        // que cargará sus hijos dinámicamente al abrirse.
        if (config.tipo === "WFS" && !config.name) {
          subtemaChildren.appendChild(
            _crearItemWfsDiscovery(config, globalIndex)
          );
        } else {
          // Nodo hoja estándar (WMS sin sublayers, WMTS, WFS con name, GeoJSON…)
          subtemaChildren.appendChild(
            _crearItemCapa(config, layer, globalIndex)
          );
        }
      });

      subtemaItem.appendChild(subtemaChildren);
      bloqueChildren.appendChild(subtemaItem);
    });

    bloqueItem.appendChild(bloqueChildren);
    tree.appendChild(bloqueItem);
  });

  _containerEl.appendChild(tree);
  console.info(`[layerTree] Árbol renderizado: ${configs.length} capas`);
}

// ─── Grupo municipal incremental (Modelo B) ────────────────────────────────

/**
 * Añade un grupo de nodos al final del árbol existente, SIN reconstruir
 * nada de lo ya renderizado (base territorial intacta).
 *
 * ── POR QUÉ UN GRUPO FIJO Y NO FUSIÓN POR bloque_tematico ─────────────────
 * Ver AJUSTE en la cabecera del archivo — patrón GIS estándar, evita que
 * el usuario pierda la referencia de qué es del territorio y qué es
 * específico del municipio elegido.
 *
 * ── POR QUÉ EXTIENDE _layersRef/_configsRef EN VEZ DE UN ARRAY PROPIO ────
 * _handleLayerSelect (el listener ya existente de toggle) localiza capas
 * por índice global en estos dos arrays. Las capas municipales deben vivir
 * en el mismo espacio de índices para reutilizar ese listener sin duplicar
 * lógica de selección — solo se les asigna el índice siguiente al último
 * ocupado por la base territorial.
 *
 * @param {Layer[]} layers
 * @param {Object[]} configs
 * @param {Object} municipioData
 */
function _agregarGrupoMunicipal(layers, configs, municipioData) {
  if (!configs || configs.length === 0) return;

  // Defensivo: si quedó un grupo municipal anterior sin retirar, se retira
  // primero. municipioSelector.agregarCapasMunicipio() ya llama a retirar
  // antes de agregar, pero el árbol no debe asumir que ese orden siempre
  // se respeta desde cualquier punto de llamada futuro.
  _retirarGrupoMunicipal();

  _inicioGrupoMunicipal = _layersRef.length;
  _layersRef  = [..._layersRef, ...layers];
  _configsRef = [..._configsRef, ...configs];

  // Los ids WFS municipales también deben lazy-cargar igual que los
  // territoriales — se suman al mismo Set, no uno nuevo, mismo mecanismo
  // que ya usa _handleLayerSelect para decidir cuándo llamar a addCapa().
  configs
    .filter(c => c.tipo === "WFS")
    .forEach(c => _lazyLayerIds.add(c.id));

  const grupoItem = document.createElement("calcite-tree-item");
  grupoItem.dataset.grupoMunicipal = "true"; // única marca necesaria para localizarlo al retirar
  grupoItem.setAttribute("expanded", "");

  const label = document.createElement("span");
  label.className   = "layer-group-label layer-group-bloque";
  label.textContent = `Capas específicas de ${municipioData.nombre}`;
  grupoItem.appendChild(label);

  const childrenTree = document.createElement("calcite-tree");
  childrenTree.slot  = "children";

  configs.forEach((config, i) => {
    const layer       = layers[i];
    const globalIndex = _inicioGrupoMunicipal + i;

    // Mismas tres ramas de construcción de nodo que _renderTree — se
    // reutilizan tal cual, sin ninguna modificación, porque construyen
    // nodos idénticos sea cual sea el origen de la config.
    if (config.tipo === "WMS" && config.sublayers?.length) {
      childrenTree.appendChild(_crearItemWmsConSublayers(config, layer, globalIndex));
    } else if (config.tipo === "WFS" && !config.name) {
      childrenTree.appendChild(_crearItemWfsDiscovery(config, globalIndex));
    } else {
      childrenTree.appendChild(_crearItemCapa(config, layer, globalIndex));
    }
  });

  grupoItem.appendChild(childrenTree);

  // Se inserta como último hijo del <calcite-tree> raíz ya construido por
  // _renderTree — no se recrea el <calcite-tree>, solo se le añade un hijo.
  const treeRaiz = _containerEl.querySelector("calcite-tree");
  if (treeRaiz) {
    treeRaiz.appendChild(grupoItem);
  } else {
    // Caso límite: no debería ocurrir si territorio-cargado ya renderizó
    // la base antes de que el usuario pueda elegir un municipio, pero se
    // deja el aviso explícito para no fallar en silencio.
    console.warn("[layerTree] No hay <calcite-tree> raíz — ¿se cargó la base territorial?");
  }

  console.info(`[layerTree] + Grupo municipal añadido: ${configs.length} capas`);
}

/**
 * Retira el grupo municipal completo (DOM + estado), sin tocar el resto
 * del árbol. Inverso exacto de _agregarGrupoMunicipal().
 */
function _retirarGrupoMunicipal() {
  if (_inicioGrupoMunicipal === null) return;

  const grupoItem = _containerEl.querySelector('[data-grupo-municipal="true"]');
  grupoItem?.remove();

  // Recortar los arrays globales de vuelta al tamaño previo. Es seguro
  // porque el grupo municipal siempre es lo último que se añadió — nunca
  // hay un segundo grupo incremental después de él (agregarCapasMunicipio
  // siempre retira el anterior antes de sumar el nuevo).
  _layersRef  = _layersRef.slice(0, _inicioGrupoMunicipal);
  _configsRef = _configsRef.slice(0, _inicioGrupoMunicipal);

  _inicioGrupoMunicipal = null;

  console.info("[layerTree] − Grupo municipal retirado");
}

// ─── Handlers de eventos ──────────────────────────────────────────────────

/**
 * Gestiona la activación/desactivación de una capa hoja.
 * Se llama desde el listener de calciteTreeItemSelect.
 */
function _handleLayerSelect(e) {
  const item = e.target.closest("calcite-tree-item[data-layer-id]");
  if (!item) return;

  const layerId    = item.dataset.layerId;
  const layerIndex = item.dataset.layerIndex;

  // Nodo hijo WFS (instancia creada on-demand): no tiene índice global
  // porque no estaba en el array original de configs/layers.
  // Se gestiona en _handleWfsHijoSelect.
  if (item.dataset.wfsHijo === "true") {
    _handleWfsHijoSelect(item, layerId);
    return;
  }

  // Nodo hijo de sublayer WMS: la instancia ya existe desde la carga inicial
  // (no es lazy como WFS). Se gestiona en _handleWmsSublayerSelect.
  if (item.dataset.wmsSublayer === "true") {
    _handleWmsSublayerSelect(item, layerId);
    return;
  }

  const globalIndex = parseInt(layerIndex, 10);
  // Calcite actualiza "selected" antes de emitir el evento.
  const visible = !item.hasAttribute("selected");

  const layer  = _layersRef[globalIndex];
  const config = _configsRef[globalIndex];

  if (!layer) {
    console.warn(`[layerTree] Layer no encontrada para índice ${globalIndex}`);
    return;
  }

  // Lazy-load: la capa entra al mapa solo la primera vez que se activa.
  if (visible && _lazyLayerIds.has(layerId) && !layer.map) {
    mapManager.addCapa(layer);
  }

  layer.visible = visible;



  emit(visible ? "capa-activada" : "capa-desactivada", { layerId, layer, config });
  console.info(`[layerTree] "${layerId}" → visible: ${visible}`);
}

/**
 * Activa/desactiva un FeatureLayer hijo de un nodo WFS discovery.
 *
 * @param {HTMLElement} item   - El calcite-tree-item del hijo
 * @param {string}      hijoId - ID derivado: "{padreId}::{featureType.name}"
 */
function _handleWfsHijoSelect(item, hijoId) {
  const visible = !item.hasAttribute("selected");

  // La instancia de capa se almacena en el propio nodo DOM como referencia.
  // Esto evita un Map externo y mantiene el estado colocado junto al elemento
  // que lo necesita. Se asigna en _crearHijoWfs cuando se crean los hijos.
  const layer = item._layerInstance;

  if (!layer) {
    console.warn(`[layerTree] Capa WFS hija sin instancia: "${hijoId}"`);
    return;
  }

  // TEMPORAL — depuración, capturar solo si es la capa que nos interesa
  if (hijoId.includes("RED_ERGNSS")) {
    window._debugLayer = layer;
    console.log("[DEBUG] Capturada instancia:", hijoId);
  }

  // Lazy: añadir al mapa solo la primera vez que se activa
  if (visible && !layer.map) {
    mapManager.addCapa(layer);

    layer.load()
      .then(() => {
        // POPUP POST-LOAD — timing crítico.
        // WFSLayer.load() reconstruye internamente el popupTemplate y
        // resetea fieldInfos a null, pisando cualquier asignación hecha
        // en construcción (layerFactory._aplicarPopupGenerico).
        // createPopupTemplate() es el método nativo del SDK para este
        // caso: genera el template completo desde layer.fields ya
        // disponibles, sin que tengamos que construirlo a mano.
        layer.popupTemplate = layer.createPopupTemplate();
      })
      .catch(err => {
        console.error(`[layerTree] Error al cargar capa WFS hija "${hijoId}":`, err);
      });
  }

  layer.visible = visible;
  emit(visible ? "capa-activada" : "capa-desactivada", {
    layerId: hijoId,
    layer,
    // Config sintético mínimo para que legendPanel pueda identificar la capa
    config: { id: hijoId, title: layer.title, tipo: "WFS" }
  });
  console.info(`[layerTree] WFS hijo "${hijoId}" → visible: ${visible}`);
}

/**
 * Activa/desactiva una sublayer WMS individual.
 *
 * ── DIFERENCIA CON _handleWfsHijoSelect ──────────────────────────────────
 * No hay lazy-load: la WMSLayer padre ya está en el mapa desde la carga
 * inicial del municipio (las WMS no se excluyen de capasInmediatas como
 * sí ocurre con WFS — ver municipioSelector.js paso 4). Por tanto no hace
 * falta comprobar `!layer.map` ni llamar a mapManager.addCapa(): solo se
 * alterna sublayer.visible.
 *
 * Importante: alternar sublayer.visible no fuerza layer.visible = true en
 * la capa padre. Si el usuario activa una sublayer pero el WMS padre está
 * con visible=false, no se verá nada. Por eso forzamos layer.visible = true
 * al activar una sublayer — mismo patrón de "activar el contenedor cuando
 * se activa el contenido" usado en otros puntos de la app.
 *
 * @param {HTMLElement} item   - El calcite-tree-item de la sublayer
 * @param {string}      hijoId - ID derivado: "{idPadre}::{sublayer.name}"
 */
function _handleWmsSublayerSelect(item, hijoId) {
  const visible   = !item.hasAttribute("selected");
  const layer     = item._parentLayer;
  const sublayer  = item._sublayerInstance;

  if (!layer || !sublayer) {
    console.warn(`[layerTree] Sublayer WMS sin instancia: "${hijoId}"`);
    return;
  }

  // Si se activa una sublayer y el WMS padre está oculto, lo mostramos.
  // Sin esto, sublayer.visible=true sería invisible para el usuario.
  if (visible && !layer.visible) {
    layer.visible = true;
  }

  sublayer.visible = visible;
  emit(visible ? "capa-activada" : "capa-desactivada", {
    layerId: hijoId,
    layer,
    config: { id: hijoId, title: sublayer.title ?? sublayer.name, tipo: "WMS" }
  });
  console.info(`[layerTree] WMS sublayer "${hijoId}" → visible: ${visible}`);
}

/**
 * Gestiona la expansión de un nodo WFS discovery.
 * Se llama la primera vez que el usuario expande el nodo.
 * Las expansiones siguientes no relanza el fetch (caché en _wfsDiscoveryExpanded).
 *
 * @param {HTMLElement} item - El calcite-tree-item del nodo padre WFS
 */
async function _handleWfsDiscovery(item) {
  const configId = item.dataset.configId;

  // Idempotencia: si ya se expandió, no relanzar el fetch.
  if (_wfsDiscoveryExpanded.has(configId)) return;
  _wfsDiscoveryExpanded.set(configId, true);

  const config = _configsRef.find(c => c.id === configId);
  if (!config) {
    console.error(`[layerTree] Config no encontrada para discovery: "${configId}"`);
    return;
  }

  // Obtener el slot de hijos (el calcite-tree anidado dentro del item)
  const childrenTree = item.querySelector("calcite-tree[slot='children']");
  if (!childrenTree) {
    console.error(`[layerTree] No se encontró slot children en nodo "${configId}"`);
    return;
  }

  // Mostrar spinner mientras carga
  _setDiscoveryState(item, childrenTree, "loading");

  try {
    const featureTypes = await fetchFeatureTypes(config.url);

    if (featureTypes.length === 0) {
      _setDiscoveryState(item, childrenTree, "empty");
      return;
    }

    clearContainer(childrenTree);
    _setDiscoveryState(item, childrenTree, "loading"); // para que spinner sea visible hasta que los hijos estén listos

    // ── Verificar disponibilidad espacial en paralelo ─────────────────────
    // Por qué en paralelo: con N FeatureTypes, el tiempo total pasa de
    // O(N × latencia_red) a O(latencia_max). Con 5 tipos y ~300ms/req:
    //   serie → ~1.500ms | paralelo → ~300ms
    //
    // checkFeaturesInBbox nunca rechaza (captura internamente todos los errores),
    // por lo que Promise.all es seguro sin .catch adicional.
    const bbox = _territorioData?.bbox ?? null; // ← CAMBIO: _municipioData → _territorioData

    let availabilityMap; // Map<nombre_featureType, boolean>

    if (bbox) {
      // const checks  = featureTypes.map(ft => checkFeaturesInBbox(config.url, ft.name, bbox));
      // const results = await Promise.all(checks);

        const results = await _checkConPool(featureTypes, config.url, bbox, {
          concurrencia: 4   // mismo valor conservador, sin pausa artificial
        });
        availabilityMap = new Map(featureTypes.map((ft, i) => [ft.name, results[i]]));
    } else {
      // Sin bbox no podemos verificar disponibilidad espacial → degradación segura:
      // asumir todos los FeatureTypes disponibles y dejar que el usuario decida.
      // Si el servidor no tiene datos en esta zona, la capa quedará vacía pero
      // no bloqueará el discovery.
      console.warn("[layerTree] _territorioData.bbox no disponible; omitiendo check BBOX");
      availabilityMap = new Map(featureTypes.map(ft => [ft.name, true]));

      // BUG MARCADO: aquí se usa `results[i]` aunque `results` no existe en esta rama.
      // Si se corrige, esta rama debería mapear a `true` por defecto.q
      // availabilityMap = new Map(featureTypes.map((ft, i) => [ft.name, results[i]]));
    }

    // Crear instancias y nodos DOM en paralelo.
    // _crearHijoWfs recibe el flag de disponibilidad: si es false, renderiza
    // el nodo como deshabilitado con chip informativo y omite la instancia de capa.
    const hijos = await Promise.all(
      featureTypes.map(ft => _crearHijoWfs(ft, config, availabilityMap.get(ft.name) ?? false))
    );

    // Limpiar el spinner antes de añadir los hijos
    clearContainer(childrenTree); // espera los hijos antes de limpiar para evitar parpadeo excesivo si la carga es rápida

    hijos.forEach(({ item: hijoItem }) => {
      if (hijoItem) childrenTree.appendChild(hijoItem);
    });

    console.info(
      `[layerTree] WFS discovery "${configId}": ${featureTypes.length} FeatureTypes`
    );

  } catch (err) {
    console.error(`[layerTree] Error al expandir WFS "${configId}":`, err);
    _setDiscoveryState(item, childrenTree, "error");
  }
}

// ─── Construcción de items ─────────────────────────────────────────────────

/**
 * Crea el nodo Calcite para un agrupador (bloque temático o subtema).
 * Sin data-layer-id → el listener de selección lo ignora.
 */
function _crearItemGrupo(label, negrita) {
  const item = document.createElement("calcite-tree-item");
  // item.setAttribute("expanded", ""); // Opcional: expandir por defecto los grupos (puede ser mucho contenido)

  const span = document.createElement("span");
  span.className   = negrita
    ? "layer-group-label layer-group-bloque"
    : "layer-group-label";
  span.textContent = label;
  item.appendChild(span);

  return item;
}

/**
 * Crea el nodo Calcite para una capa hoja estándar (con data-layer-id).
 *
 * ── SERVICIOS CAÍDOS (config.servicio_disponible === false) ──────────────
 * Marcado por enriquecer-catalogo.py cuando el GetCapabilities del servicio
 * responde con un ServiceExceptionReport en vez del capabilities esperado
 * (ver hallazgo real 30/08/2026, Red Natura 2000/ENP — error interno del
 * backend del proveedor, no un problema de configuración del cliente).
 * La capa se conserva en el catálogo (no se excluye) para que el usuario
 * vea que el dato existe pero no está disponible ahora mismo, en vez de
 * que la capa simplemente desaparezca del árbol sin explicación.
 * Mismo patrón visual que _crearHijoWfs usa para FeatureTypes sin
 * cobertura en el municipio: nodo disabled + tooltip + chip informativo.
 */
function _crearItemCapa(config, layer, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId    = config.id;
  item.dataset.layerIndex = globalIndex;

  if (config.servicio_disponible === false) {
    item.setAttribute("disabled", "");
    item.title = `${config.title} — servicio no disponible actualmente`;

    const span = document.createElement("span");
    span.className   = "layer-label layer-label--error";
    span.textContent = config.title;
    item.appendChild(span);

    const chip = document.createElement("calcite-chip");
    chip.setAttribute("scale", "s");
    chip.setAttribute("kind", "danger");
    chip.setAttribute("icon", "exclamation-mark-triangle");
    chip.textContent = "No disponible";
    item.appendChild(chip);

    return item;
  }

  if (layer.visible) {
    item.setAttribute("selected", "");
  }

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = config.title;
  item.appendChild(span);

  // _añadirBadges(item, config);

  return item;
}

/**
 * Crea el nodo Calcite para un servicio WMS con sublayers curadas en catálogo.
 *
 * ── SUBLAYERS AUXILIARES (config.sublayers[].auxiliar === true) ──────────
 * enriquecer-catalogo.py marca como "auxiliar" las sublayers que son solo
 * elementos de composición cartográfica (etiquetas de texto TXT*, líneas
 * de apoyo EJES/ELEMLIN/LIMITES/TEXTOS) en vez de capas temáticas reales
 * (ver hallazgo real 30/08/2026, Catastro). Se filtran aquí, cruzando cada
 * sublayer Esri ya cargada (layer.sublayers) con su entrada correspondiente
 * en config.sublayers por nombre — el SDK no distingue esto, así que el
 * filtro debe aplicarse en la UI, no en la carga de datos.
 */
function _crearItemWmsConSublayers(config, layer, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId    = config.id;
  item.dataset.layerIndex = globalIndex;

  if (layer.visible) {
    item.setAttribute("selected", "");
  }

  const label = document.createElement("span");
  label.className   = "layer-label layer-label--wms-service";
  label.textContent = config.title;
  item.appendChild(label);

  const badge = document.createElement("calcite-chip");
  badge.setAttribute("scale", "s");
  badge.setAttribute("kind", "neutral");
  badge.setAttribute("icon", "layers");
  badge.textContent = "WMS";
  item.appendChild(badge);

  const childrenTree = document.createElement("calcite-tree");
  childrenTree.slot  = "children";

  // Mapa de consulta rápida: nombre de sublayer → info curada del catálogo
  const infoAuxiliarPorNombre = new Map(
    (config.sublayers ?? []).map(s => [s.id, s.auxiliar === true])
  );

  const sublayersEsri = layer.sublayers?.toArray?.() ?? [];

  sublayersEsri
    .filter(sublayerEsri => !infoAuxiliarPorNombre.get(sublayerEsri.name))
    .forEach(sublayerEsri => {
      childrenTree.appendChild(
        _crearItemWmsSublayer(sublayerEsri, layer, config.id)
      );
    });

  item.appendChild(childrenTree);
  return item;
}

/**
 * Crea el nodo Calcite para una sublayer WMS individual.
 *
 * La instancia de la sublayer (y de su capa padre) se almacena directamente
 * en el nodo DOM —mismo patrón que item._layerInstance en hijos WFS— para
 * acceso O(1) desde el listener de selección sin necesitar un Map externo.
 *
 * @param {Sublayer} sublayerEsri - Objeto Sublayer del SDK, ya con visible correcto
 * @param {WMSLayer} parentLayer  - Instancia WMSLayer padre
 * @param {string} parentId       - config.id del WMS padre
 */
function _crearItemWmsSublayer(sublayerEsri, parentLayer, parentId) {
  const hijoId = `${parentId}::${sublayerEsri.name}`;

  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId     = hijoId;
  item.dataset.wmsSublayer = "true"; // Identificador para _handleLayerSelect
  item._parentLayer        = parentLayer;
  item._sublayerInstance   = sublayerEsri;

  if (sublayerEsri.visible) {
    item.setAttribute("selected", "");
  }

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = sublayerEsri.title || sublayerEsri.name;
  item.appendChild(span);

  return item;
}

/**
 * Crea el nodo Calcite para un servicio WFS en modo discovery.
 *
 * ── DISEÑO DEL NODO DISCOVERY ────────────────────────────────────────────
 * El nodo debe:
 *   a) Ser expandible (para disparar calciteTreeItemExpand)
 *   b) NO ser seleccionable como capa (no tiene data-layer-id)
 *   c) Tener un slot "children" vacío pero presente (Calcite lo necesita
 *      para mostrar el chevron de expansión incluso con hijos vacíos)
 *   d) Mostrar indicador visual de que tiene contenido pendiente de cargar
 *
 * El atributo data-wfs-discovery="true" identifica estos nodos para el
 * listener de calciteTreeItemExpand.
 *
 * @param {Object} config      - Config del catálogo (tipo WFS, sin name)
 * @param {number} globalIndex - Índice en _configsRef (para trazabilidad)
 */
function _crearItemWfsDiscovery(config, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  // NO añadir data-layer-id: este nodo no activa/desactiva una capa directa.
  // El listener de selección lo ignorará.
  item.dataset.wfsDiscovery = "true";
  item.dataset.configId     = config.id;
  // Opcional Expandido por defecto para descubrir sus hijos al cargar
  // item.setAttribute("expanded", "");

  // Etiqueta con icono de servicio WFS para diferenciarlo visualmente
  const label = document.createElement("span");
  label.className   = "layer-label layer-label--wfs-service";
  label.textContent = config.title;
  item.appendChild(label);

  // Badge que indica que los hijos se cargarán dinámicamente
  const badge = document.createElement("calcite-chip");
  badge.setAttribute("scale", "s");
  badge.setAttribute("kind", "neutral");
  badge.setAttribute("icon", "data-magnifying-glass");
  badge.textContent = "WFS";
  item.appendChild(badge);

  // _añadirBadges(item, config); //opcional: añadir badges de prioridad/INSPIREy

  // Slot de hijos: debe existir vacío para que Calcite muestre el chevron.
  // Se rellena con el spinner o los FeatureTypes en _setDiscoveryState/_handleWfsDiscovery.
  const childrenTree = document.createElement("calcite-tree");
  childrenTree.slot  = "children";

  // Spinner inicial (visible mientras no se haya expandido)
  const spinner = document.createElement("calcite-loader");
  spinner.setAttribute("scale", "s");
  spinner.setAttribute("inline", "");
  spinner.setAttribute("text", "Cargando tipos...");
  childrenTree.appendChild(spinner);

  item.appendChild(childrenTree);

  return item;
}

/**
 * Crea el nodo Calcite para un FeatureType hijo de un nodo WFS discovery,
 * crea la instancia WFSLayer correspondiente, y le aplica el filtro BBOX
 * del territorio activo antes de que entre al mapa.
 *
 * ── POR QUÉ SE APLICA BBOX AQUÍ ──────────────────────────────────────────
 * La hija no tiene entrada en el catálogo → no pasa por inicializarCapa().
 * aplicarBboxWfs() es la función pública de layerInitializer que encapsula
 * la lógica de filtrado servidor OGC. Llamarla aquí respeta el SRP:
 *   - layerFactory  → solo instancia
 *   - layerInitializer → único dueño de la lógica de filtrado (DRY)
 *   - layerTree     → orquesta UI y llama al filtrado con el contexto disponible
 *
 * La instancia se almacena en item._layerInstance para acceso O(1) desde
 * _handleWfsHijoSelect sin necesitar un Map externo.
 *
 * @param {import('../utils/wfsCapabilitiesParser.js').FeatureTypeInfo} featureType
 * @param {Object} configPadre - Config del catálogo del servicio padre
 * @returns {Promise<{item: HTMLElement, layer: WFSLayer|null}>}
 */
async function _crearHijoWfs(featureType, configPadre, disponible = true) {
  const hijoId = `${configPadre.id}::${featureType.name}`;

  // ── Cortocircuito: sin datos en este municipio ────────────────────────
  // No instanciamos la WFSLayer porque no hay nada que añadir al mapa.
  // El nodo se renderiza deshabilitado con un chip informativo para que
  // el usuario sepa que el tipo existe pero no tiene cobertura aquí.
  if (!disponible) {
     const item = document.createElement("calcite-tree-item");
  item.dataset.layerId = hijoId;
  item.dataset.wfsHijo = "true";
  item.setAttribute("disabled", "");

  // Tooltip nativo (visible al hacer hover)
  item.title = `${featureType.name} — sin datos en este municipio`;

  const label = document.createElement("span");
  label.className   = "layer-label";
  label.textContent = featureType.title || featureType.name;
  item.appendChild(label);

  return { item, layer: null };

  }

  // Crear la instancia de capa antes de crear el nodo DOM.
  // Si falla, el nodo mostrará un estado de error en lugar de quedar huérfano.
  const layer = await crearCapaWfsHija(featureType, configPadre);


  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId = hijoId;
  item.dataset.wfsHijo = "true"; // Identificador para _handleLayerSelect

  if (!layer) {
    // La capa no pudo crearse: mostrar el nodo como deshabilitado
    item.setAttribute("disabled", "");
    const span = document.createElement("span");
    span.className   = "layer-label layer-label--error";
    span.textContent = featureType.title;
    item.appendChild(span);

    const errorChip = document.createElement("calcite-chip");
    errorChip.setAttribute("scale", "s");
    errorChip.setAttribute("kind", "danger");
    errorChip.textContent = "Error";
    item.appendChild(errorChip);

    return { item, layer: null };
  }

  // Aplicar BBOX al hijo antes de que entre al mapa.
  // La hija hereda el srsname del configPadre (que sí está en el catálogo).
  // El filtro debe aplicarse ANTES de map.add() para que el primer
  // GetFeature request ya lleve el parámetro BBOX al servidor.
  if (_territorioData) { // ← CAMBIO: _municipioData → _territorioData
    await aplicarBboxWfs(layer, _territorioData, configPadre.srsname ?? "EPSG:4326");
  }

  // Almacenar referencia directa en el nodo DOM para acceso O(1) desde el listener
  item._layerInstance = layer;

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = featureType.title;
  item.appendChild(span);

  // Mostrar el nombre técnico como tooltip para que el usuario pueda
  // identificar el FeatureType exacto en caso de necesitar referenciarlo
  if (featureType.name !== featureType.title) {
    item.title = featureType.name;
  }

  // CRS como indicador informativo si es relevante (no WGS84)
  if (featureType.crs && !featureType.crs.includes("4326") && !featureType.crs.includes("4258")) {
    const crsChip = document.createElement("calcite-chip");
    crsChip.setAttribute("scale", "s");
    crsChip.setAttribute("kind", "neutral");
    crsChip.textContent = featureType.crs.replace(/.*:/, "EPSG:");
    item.appendChild(crsChip);
  }

  return { item, layer };
}

// ─── Estado visual del nodo discovery ────────────────────────────────────

/**
 * Actualiza el contenido del slot de hijos de un nodo WFS discovery
 * según el estado actual de la petición Capabilities.
 *
 * @param {HTMLElement} parentItem   - El calcite-tree-item del padre WFS
 * @param {HTMLElement} childrenTree - El calcite-tree slot="children"
 * @param {"loading"|"empty"|"error"} state
 */
function _setDiscoveryState(parentItem, childrenTree, state) {
  clearContainer(childrenTree);

  const messages = {
    loading: { icon: null,          text: "Cargando tipos de capa...",            chip: null      },
    empty:   { icon: "information", text: "Sin FeatureTypes disponibles",         chip: "neutral" },
    error:   { icon: "exclamation", text: "No se pudo conectar con el servicio",  chip: "danger"  }
  };

  const { icon, text, chip } = messages[state] ?? messages.error;

  if (state === "loading") {
    const spinner = document.createElement("calcite-loader");
    spinner.setAttribute("scale", "s");
    spinner.setAttribute("inline", "");
    spinner.setAttribute("text", text);
    childrenTree.appendChild(spinner);
    return;
  }

  // Para empty y error: un item informativo no seleccionable
  const infoItem = document.createElement("calcite-tree-item");
  infoItem.setAttribute("disabled", "");

  const span = document.createElement("span");
  span.className   = `layer-label layer-label--${state}`;
  span.textContent = text;
  infoItem.appendChild(span);

  if (chip) {
    const chipEl = document.createElement("calcite-chip");
    chipEl.setAttribute("scale", "s");
    chipEl.setAttribute("kind", chip);
    if (icon) chipEl.setAttribute("icon", icon);
    chipEl.textContent = state === "empty" ? "Vacío" : "Error";
    infoItem.appendChild(chipEl);
  }

  childrenTree.appendChild(infoItem);
}

// ─── Agrupación ───────────────────────────────────────────────────────────

function _agrupar(configs, layers) {
  const bloqueMap = new Map();

  configs.forEach((config, i) => {
    const bloque  = config.bloque_tematico ?? "Sin categoría";
    const subtema = config.subtema         ?? "General";

    if (!bloqueMap.has(bloque)) bloqueMap.set(bloque, new Map());
    const subtemaMap = bloqueMap.get(bloque);
    if (!subtemaMap.has(subtema)) subtemaMap.set(subtema, []);
    subtemaMap.get(subtema).push({ config, layer: layers[i] });
  });

  return Array.from(bloqueMap.entries()).map(([bloque, subtemaMap]) => ({
    bloque,
    subtemas: Array.from(subtemaMap.entries()).map(([subtema, pares]) => ({
      subtema,
      pares
    }))
  }));
}

// ─── Helpers privados ─────────────────────────────────────────────────────

/**
 * Pool de concurrencia fija para checkFeaturesInBbox.
 *
 * Por qué pool en vez de lotes con pausa:
 * - Los lotes con pausa fija desperdician tiempo cuando el servidor responde rápido
 *   (INE responde en ~80ms pero el lote espera 500ms igualmente).
 * - El pool mantiene exactamente `concurrencia` peticiones activas en todo momento:
 *   en cuanto una termina, la siguiente arranca sin esperar al resto del lote.
 * - Mismo control de carga para servidores lentos (Fomento/ArcGIS gubernamental),
 *   sin penalizar a los servidores rápidos (INE/GeoServer).
 *
 * @param {FeatureTypeInfo[]} featureTypes
 * @param {string} serviceUrl
 * @param {number[]} bbox
 * @param {object} opciones
 * @param {number} opciones.concurrencia - Máximo de peticiones simultáneas (default: 4)
 * @returns {Promise<boolean[]>} - Array de disponibilidad, mismo orden que featureTypes
 */
async function _checkConPool(featureTypes, serviceUrl, bbox, { concurrencia = 4 } = {}) {
  const resultados = new Array(featureTypes.length);
  let siguiente = 0;

  // Cada "worker" es una cadena de promesas que consume el array de trabajo
  // hasta agotarlo. Se lanzan `concurrencia` workers en paralelo.
  async function worker() {
    while (true) {
      // Reserva atómica del siguiente índice pendiente
      const idx = siguiente++;
      if (idx >= featureTypes.length) break;

      resultados[idx] = await checkFeaturesInBbox(
        serviceUrl,
        featureTypes[idx].name,
        bbox
      );
    }
  }

  // Lanza exactamente `concurrencia` workers concurrentes
  const workers = Array.from({ length: Math.min(concurrencia, featureTypes.length) }, worker);
  await Promise.all(workers);

  return resultados;
}



/**
 * Añade badges visuales (P0, INSPIRE) a un calcite-tree-item.
 * Extraído para reutilizarlo en nodos estándar y nodos discovery.
 */
// function _añadirBadges(item, config) {
//   if (config.prioridad === "P0 - MVP") {
//     const badge = document.createElement("calcite-chip");
//     badge.setAttribute("scale", "s");
//     badge.setAttribute("kind", "brand");
//     badge.textContent = "P0";
//     item.appendChild(badge);
//   }

//   if (config.inspire) {
//     const chip = document.createElement("calcite-chip");
//     chip.setAttribute("scale", "s");
//     chip.setAttribute("kind", "neutral");
//     chip.textContent = "INSPIRE";
//     item.appendChild(chip);
//   }
// }